import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AccessScope } from '../../access/AccessScope.js';
import type { CellValue } from '../../columns/CellValue.js';
import { ConnectorOutcome, type IConnectorApplied } from '../../connectors/ConnectorApplied.js';
import type { ConnectorChangeSet } from '../../connectors/ConnectorChangeSet.js';
import {
    ConnectorResidency, type IConnectorCapabilities, type IExternalConnector, type IFetchPage, type IFetchRequest, type IFetchedRow,
} from '../../connectors/FetchContract.js';
import type { IAssignedCreate, IAssignedOutcome, IConnectorApplyResult, IConnectorTransaction } from '../../connectors/GraphConnector.js';
import { ConflictError } from '../../txn/ConflictError.js';
import { EdgeDirection } from '../../format/FormatKeys.js';
import { FederatedReads } from '../../FederatedReads.js';
import { GraphEngine, StorageKind } from '../../GraphEngine.js';
import { CypherEngine } from '../CypherEngine.js';
import { CypherWriteError, CypherWriteErrorCode } from '../CypherError.js';
import type { CypherResult } from '../CypherResult.js';
import { NodeValue, ScalarValue } from '../CypherValue.js';
import type { INodePlace, INodePlacement } from '../write/NodePlacement.js';
import { CypherFixture } from './CypherFixture.js';

/**
 * An External connector that assigns serial keys to source-keyed creates (ruling R136 E4) and executes every write
 * step at once (ruling R135 E1). `Create` mints `${Concept}#${name}.${table}#${serial}` and sets the `id` member to
 * the serial; `CreateCalls` logs each call, `Removed` the ids a step's Undo removed. `Apply` records each executed
 * step; with `StaleConflict` a guarded change (one carrying an ExpectedVersion) throws `ConflictError`, as a source
 * whose row changed under the reader would. `ThrowCreateAtCall` (1-based) makes that Create call throw.
 */
class SerialConnector implements IExternalConnector
{
    public readonly Residency = ConnectorResidency.External as const;
    public readonly Capabilities: IConnectorCapabilities = { KeyLookup: true, ReverseLookup: true, PushDown: new Set() };
    public readonly CreateCalls: IAssignedCreate[][] = [];
    public readonly Applied: ConnectorChangeSet[] = [];
    public readonly Removed: string[] = [];
    public ThrowCreateAtCall: number | undefined;
    public StaleConflict = false;
    public CommitCalls = 0;

    private serial = 0;
    private createCall = 0;
    private readonly steps: string[][] = [];
    private readonly rows = new Map<string, IFetchedRow>();

    public constructor(public readonly Name: string, private readonly tables: ReadonlyMap<string, string>, seed: readonly IFetchedRow[] = [])
    {
        for (const row of seed) this.rows.set(row.PublicId, row);
    }

    public Begin(): Promise<IConnectorTransaction>
    {
        return Promise.resolve(new SerialTransaction(this));
    }

    public Fetch(request: IFetchRequest): Promise<IFetchPage>
    {
        const all = [...this.rows.values()];
        const keys = request.Keys;
        return Promise.resolve({ Rows: keys === undefined ? all : all.filter(row => keys.includes(row.PublicId)) });
    }

    /** @internal Assigns a serial key per request, logs the step for Undo, then returns the created rows (or throws). */
    public RunCreate(requests: readonly IAssignedCreate[]): Promise<readonly IAssignedOutcome[]>
    {
        this.createCall++;
        this.CreateCalls.push([...requests]);
        if (this.ThrowCreateAtCall === this.createCall)
        {
            return Promise.reject(new Error(SerialConnector.Boom));
        }
        const created: string[] = [];
        const outcomes = requests.map<IAssignedOutcome>(request =>
        {
            const n = ++this.serial;
            const table = this.tables.get(request.Concept) ?? request.Concept.toLowerCase();
            const publicId = `${request.Concept}#${this.Name}.${table}#${n}`;
            const values = new Map<string, CellValue>(request.Properties);
            values.set(SerialConnector.Id, BigInt(n));
            created.push(publicId);
            return { Row: { PublicId: publicId, Concept: request.Concept, Values: values, Links: new Map(), Version: 1 } };
        });
        this.steps.push(created);
        return Promise.resolve(outcomes);
    }

    /** @internal Executes one step; a guarded change conflicts when StaleConflict is set, else records the step. */
    public RunApply(changes: ConnectorChangeSet): Promise<IConnectorApplyResult | void>
    {
        if (this.StaleConflict && changes.Changes.some(change => change.ExpectedVersion !== undefined))
        {
            return Promise.reject(new ConflictError(SerialConnector.Stale));
        }
        this.Applied.push(changes);
        this.steps.push([]);
        return Promise.resolve();
    }

    /** @internal Compensates the latest executed step, removing the rows it created. */
    public RunUndo(): Promise<void>
    {
        const ids = this.steps.pop();
        if (ids !== undefined) this.Removed.push(...ids);
        return Promise.resolve();
    }

    private static readonly Boom = 'the source refused the create';
    private static readonly Stale = 'the row changed under the reader';
    private static readonly Id = 'id';
}

/** The connector transaction a SerialConnector hands back: every step executes at once. */
class SerialTransaction implements IConnectorTransaction
{
    public constructor(private readonly owner: SerialConnector)
    {
    }

    public Apply(changes: ConnectorChangeSet): Promise<IConnectorApplyResult | void>
    {
        return this.owner.RunApply(changes);
    }

    public Create(requests: readonly IAssignedCreate[]): Promise<readonly IAssignedOutcome[]>
    {
        return this.owner.RunCreate(requests);
    }

    public Undo(): Promise<void>
    {
        return this.owner.RunUndo();
    }

    public Commit(): Promise<void>
    {
        this.owner.CommitCalls++;
        return Promise.resolve();
    }

    public Revert(): Promise<void>
    {
        return this.owner.RunUndo();
    }
}

/** A placement that is source-keyed (KeyAssigned) for `assigned` concepts, client-keyed for other external ones, engine otherwise. */
class SerialPlacement implements INodePlacement
{
    private client = 0;

    public constructor(private readonly models: ReadonlyMap<string, string>, private readonly assigned: ReadonlySet<string>)
    {
    }

    public Place(concept: string): INodePlace
    {
        const owner = this.models.get(concept);
        if (owner === undefined) return { PublicId: randomUUID(), Owner: SerialPlacement.NoOwner };
        if (this.assigned.has(concept)) return { PublicId: SerialPlacement.NoOwner, Owner: owner, KeyAssigned: true };
        return { PublicId: `${concept.toLowerCase()}-${++this.client}`, Owner: owner };
    }

    private static readonly NoOwner = '';
}

/**
 * Order { id, total, customer -> Customer } and Customer { id, name } are external, source-keyed (keys assigned by the
 * connector `ext`); Ext { id, k } is external but client-keyed; Account { k, places -> Order } is engine (seed a1, k = 1).
 */
class ImmediateFx
{
    private static readonly DirPrefix = 'pragmatic-graph-cypher-immediate-';
    private static readonly Dirs: string[] = [];

    public static readonly Model = 'shop';
    public static readonly Order = 'Order';
    public static readonly Customer = 'Customer';
    public static readonly Ext = 'Ext';
    public static readonly Account = 'Account';
    public static readonly Connector = 'ext';

    private constructor(public readonly Engine: GraphEngine, public readonly Connector: SerialConnector, public readonly Cypher: CypherEngine, public readonly Applied: IConnectorApplied[])
    {
    }

    public static Dir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), ImmediateFx.DirPrefix));
        ImmediateFx.Dirs.push(dir);
        return dir;
    }

    public static RemoveDirs(): void
    {
        for (const d of ImmediateFx.Dirs) rmSync(d, { recursive: true, force: true });
    }

    public static async Open(kind: StorageKind, seed: readonly IFetchedRow[] = []): Promise<ImmediateFx>
    {
        const tables = new Map<string, string>([[ImmediateFx.Order, 'orders'], [ImmediateFx.Customer, 'customers'], [ImmediateFx.Ext, 'ext']]);
        const connector = new SerialConnector(ImmediateFx.Connector, tables, seed);
        const engine = await GraphEngine.Open({
            Description: {
                Version: 'cypher-immediate-v1',
                Definitions: [
                    CypherFixture.Concept(ImmediateFx.Order, [CypherFixture.Int('id'), CypherFixture.Int('total'), CypherFixture.Rel('customer', [ImmediateFx.Customer])]),
                    CypherFixture.Concept(ImmediateFx.Customer, [CypherFixture.Int('id'), CypherFixture.Text('name')]),
                    CypherFixture.Concept(ImmediateFx.Ext, [CypherFixture.Int('id'), CypherFixture.Int('k')]),
                    CypherFixture.Concept(ImmediateFx.Account, [CypherFixture.Int('k'), CypherFixture.Rel('places', [ImmediateFx.Order])]),
                ],
                Indexes: [],
                Seed: [CypherFixture.Node('a1', ImmediateFx.Account, { k: 1n })],
                Bindings: [
                    { Model: ImmediateFx.Model, Concept: ImmediateFx.Order, Connector: ImmediateFx.Connector },
                    { Model: ImmediateFx.Model, Concept: ImmediateFx.Customer, Connector: ImmediateFx.Connector },
                    { Model: ImmediateFx.Model, Concept: ImmediateFx.Ext, Connector: ImmediateFx.Connector },
                ],
            },
            Storage: kind === StorageKind.Lmdb ? { Kind: StorageKind.Lmdb, Path: ImmediateFx.Dir() } : { Kind: StorageKind.Memory },
            Connectors: [connector],
        });
        const applied: IConnectorApplied[] = [];
        engine.ConnectorApplied.Subscribe(c => applied.push(c));
        return new ImmediateFx(engine, connector, new CypherEngine(engine), applied);
    }

    public Placement(): INodePlacement
    {
        return new SerialPlacement(
            new Map<string, string>([[ImmediateFx.Order, ImmediateFx.Model], [ImmediateFx.Customer, ImmediateFx.Model], [ImmediateFx.Ext, ImmediateFx.Model]]),
            new Set<string>([ImmediateFx.Order, ImmediateFx.Customer]),
        );
    }

    public Run(text: string): Promise<CypherResult>
    {
        return this.Cypher.Execute(AccessScope.System, text, { Placement: this.Placement() });
    }

    public async Links(from: string, relationship: string): Promise<string[]>
    {
        const reader = await this.Engine.BeginRead(AccessScope.System);
        try
        {
            return (await FederatedReads.Of(reader).Links(from, EdgeDirection.Out, relationship)).map(l => l.PublicId);
        }
        finally
        {
            reader.dispose();
        }
    }

    public static async Rejection(work: Promise<unknown>): Promise<unknown>
    {
        try
        {
            await work;
        }
        catch (error)
        {
            return error;
        }
        assert.fail('expected a rejection');
    }

    public dispose(): Promise<void>
    {
        return this.Engine.dispose();
    }
}

after(() => ImmediateFx.RemoveDirs());

for (const kind of [StorageKind.Memory, StorageKind.Lmdb])
{
    describe(`Cypher immediate writes (${StorageKind[kind]})`, () =>
    {
        it('CREATE returns the real id and key', async () =>
        {
            const fx = await ImmediateFx.Open(kind);
            try
            {
                const result = await fx.Run('CREATE (o:Order {total: 5}) RETURN o, o.id, elementId(o)');
                const node = result.Rows[0]![0] as NodeValue;
                assert.equal(node.Id, 'Order#ext.orders#1');
                assert.equal((result.Rows[0]![1] as ScalarValue).Value, 1n);
                assert.equal((result.Rows[0]![2] as ScalarValue).Value, 'Order#ext.orders#1');
            }
            finally
            {
                await fx.dispose();
            }
        });

        it('one step per row per clause', async () =>
        {
            const fx = await ImmediateFx.Open(kind);
            try
            {
                const result = await fx.Run('UNWIND [1,2,3] AS x CREATE (n:Ext {k: 7}) RETURN n');
                assert.equal(result.Rows.length, 3);
                // The query is dependent (RETURN n), so it is per-row: one flushed step per row.
                assert.equal(fx.Connector.Applied.length, 3);
                assert.ok(fx.Connector.Applied.every(set => set.Changes.some(c => c.Concept === ImmediateFx.Ext)));
            }
            finally
            {
                await fx.dispose();
            }
        });

        it('pattern creates targets first', async () =>
        {
            const fx = await ImmediateFx.Open(kind);
            try
            {
                await fx.Run('CREATE (o:Order {total: 5})-[:customer]->(c:Customer {name: \'a\'})');
                assert.equal(fx.Connector.CreateCalls.length, 2);
                assert.equal(fx.Connector.CreateCalls[0]![0]!.Concept, ImmediateFx.Customer);
                assert.equal(fx.Connector.CreateCalls[1]![0]!.Concept, ImmediateFx.Order);
                assert.deepEqual(fx.Connector.CreateCalls[1]![0]!.Links, [{ Relationship: 'customer', To: 'Customer#ext.customers#1' }]);
            }
            finally
            {
                await fx.dispose();
            }
        });

        it('a later clause sees the assigned key', async () =>
        {
            const fx = await ImmediateFx.Open(kind);
            try
            {
                await fx.Run('CREATE (o:Order {total: 5}) WITH o MATCH (a:Account {k: 1}) CREATE (a)-[:places]->(o)');
                assert.deepEqual(await fx.Links('a1', 'places'), ['Order#ext.orders#1']);
            }
            finally
            {
                await fx.dispose();
            }
        });

        it('failed statement compensates its steps', async () =>
        {
            const fx = await ImmediateFx.Open(kind);
            fx.Connector.ThrowCreateAtCall = 2;
            try
            {
                const error = await ImmediateFx.Rejection(fx.Run('UNWIND [1,2] AS x CREATE (o:Order {total: 5}) RETURN o.id'));
                assert.ok(error instanceof CypherWriteError && error.WriteCode === CypherWriteErrorCode.ConnectorFailed, String(error));
                assert.deepEqual(fx.Connector.Removed, ['Order#ext.orders#1']);
                assert.equal(fx.Applied[fx.Applied.length - 1]!.Outcome, ConnectorOutcome.Compensated);
            }
            finally
            {
                await fx.dispose();
            }
        });

        it('stale SET mid-statement is a Conflict and compensates', async () =>
        {
            const seed: IFetchedRow[] = [{ PublicId: 'o1', Concept: ImmediateFx.Order, Values: new Map<string, CellValue>([['id', 1n]]), Links: new Map(), Version: 'v1' }];
            const fx = await ImmediateFx.Open(kind, seed);
            fx.Connector.StaleConflict = true;
            try
            {
                const error = await ImmediateFx.Rejection(fx.Run('MATCH (o:Order) WHERE o.id = 1 SET o.total = 9'));
                assert.ok(error instanceof CypherWriteError && error.WriteCode === CypherWriteErrorCode.Conflict, String(error));
                assert.equal(fx.Applied[fx.Applied.length - 1]!.Outcome, ConnectorOutcome.Compensated);
            }
            finally
            {
                await fx.dispose();
            }
        });

        it('engine-only query is unchanged', async () =>
        {
            const fx = await ImmediateFx.Open(kind);
            try
            {
                await fx.Run('MATCH (a:Account {k: 1}) SET a.k = 2');
                const read = await fx.Cypher.Execute(AccessScope.System, 'MATCH (a:Account) RETURN a.k');
                assert.equal((read.Rows[0]![0] as ScalarValue).Value, 2n);
                // No external connector took part in a purely engine write.
                assert.equal(fx.Connector.Applied.length, 0);
                assert.equal(fx.Connector.CreateCalls.length, 0);
            }
            finally
            {
                await fx.dispose();
            }
        });
    });
}
