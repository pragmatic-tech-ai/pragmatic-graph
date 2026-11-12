import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AccessScope } from '../../access/AccessScope.js';
import type { CellValue } from '../../columns/CellValue.js';
import { ConnectorContext } from '../../connectors/ConnectorContext.js';
import { ConnectorOutcome, type IConnectorApplied } from '../../connectors/ConnectorApplied.js';
import type { ConnectorChangeSet } from '../../connectors/ConnectorChangeSet.js';
import {
    ConnectorResidency, type IConnectorCapabilities, type IExternalConnector, type IFetchPage, type IFetchRequest, type IFetchedRow,
} from '../../connectors/FetchContract.js';
import type { IAssignedCreate, IAssignedOutcome, IConnectorApplyResult, IConnectorTransaction } from '../../connectors/GraphConnector.js';
import { MemberKind, ValueType } from '../../catalog/ValueType.js';
import type { MemberInput } from '../../index.js';
import { GraphEngine, StorageKind } from '../../GraphEngine.js';
import { CypherEngine } from '../CypherEngine.js';
import { CypherWriteError, CypherWriteErrorCode } from '../CypherError.js';
import type { CypherResult } from '../CypherResult.js';
import { NodeValue, ScalarValue } from '../CypherValue.js';
import type { INodePlace, INodePlacement } from '../write/NodePlacement.js';
import { CypherFixture } from './CypherFixture.js';

/**
 * An External connector that assigns serial keys to source-keyed creates and executes every write step at once. It
 * counts its `Create` and `Apply` calls, holds the created rows in a table (so a later MATCH reads them), records the
 * context of every `Begin`, and compensates by removing exactly the rows a failed step had applied (ruling R140 E10).
 * `FailRequestAt` makes one request of every Create call an Error outcome (the others still apply, SQL Sequential);
 * `FailContext` does the same only for the transaction with that context key.
 */
class SerialConnector implements IExternalConnector
{
    public readonly Residency = ConnectorResidency.External as const;
    public readonly Capabilities: IConnectorCapabilities = { KeyLookup: true, ReverseLookup: true, PushDown: new Set() };
    public readonly CreateCalls: IAssignedCreate[][] = [];
    public readonly Applied: ConnectorChangeSet[] = [];
    public readonly Removed: string[] = [];
    public readonly BeginContexts: string[] = [];
    public readonly CreatedByContext = new Map<string, string[]>();
    public FailRequestAt: number | undefined;
    public FailContext: string | undefined;

    private serial = 0;
    private readonly table = new Map<string, IFetchedRow>();

    public constructor(public readonly Name: string, private readonly tables: ReadonlyMap<string, string>, seed: readonly IFetchedRow[] = [])
    {
        for (const row of seed) this.table.set(row.PublicId, row);
    }

    public Begin(context: ConnectorContext): Promise<IConnectorTransaction>
    {
        this.BeginContexts.push(context.Key);
        return Promise.resolve(new SerialTransaction(this, context.Key));
    }

    public Fetch(request: IFetchRequest): Promise<IFetchPage>
    {
        const rows = [...this.table.values()].filter(row => row.Concept === request.Concept);
        const keys = request.Keys;
        return Promise.resolve({ Rows: keys === undefined ? rows : rows.filter(row => keys.includes(row.PublicId)) });
    }

    /** @internal Assigns a serial key per applied request, holds it for Undo, and reports one outcome per request. */
    public RunCreate(requests: readonly IAssignedCreate[], context: string, step: string[]): Promise<readonly IAssignedOutcome[]>
    {
        this.CreateCalls.push([...requests]);
        const failAt = this.FailRequestAt ?? (context === this.FailContext ? 0 : undefined);
        const created = this.CreatedByContext.get(context) ?? [];
        this.CreatedByContext.set(context, created);
        const outcomes = requests.map<IAssignedOutcome>((request, index) =>
        {
            if (index === failAt) return { Error: new Error(SerialConnector.Boom) };
            const n = ++this.serial;
            const table = this.tables.get(request.Concept) ?? request.Concept.toLowerCase();
            const publicId = `${request.Concept}#${this.Name}.${table}#${n}`;
            const values = new Map<string, CellValue>(request.Properties);
            values.set(SerialConnector.Id, BigInt(n));
            this.table.set(publicId, { PublicId: publicId, Concept: request.Concept, Values: values, Links: new Map(), Version: 1 });
            step.push(publicId);
            created.push(publicId);
            return { Row: { PublicId: publicId, Concept: request.Concept, Values: values, Links: new Map(), Version: 1 } };
        });
        return Promise.resolve(outcomes);
    }

    /** @internal Executes one Apply step; records it, holds no rows (a SET/REMOVE touches rows the table already has). */
    public RunApply(changes: ConnectorChangeSet): Promise<IConnectorApplyResult | void>
    {
        this.Applied.push(changes);
        return Promise.resolve();
    }

    /** @internal Compensates a step: removes exactly the rows it applied. */
    public RunUndo(ids: readonly string[]): Promise<void>
    {
        for (const id of ids)
        {
            this.table.delete(id);
            this.Removed.push(id);
        }
        return Promise.resolve();
    }

    public TableSize(concept: string): number
    {
        return [...this.table.values()].filter(row => row.Concept === concept).length;
    }

    private static readonly Boom = 'the source refused the create';
    private static readonly Id = 'id';
}

/** The connector transaction a SerialConnector hands back: it owns its own step stack, so compensation stays per caller. */
class SerialTransaction implements IConnectorTransaction
{
    private readonly steps: string[][] = [];

    public constructor(private readonly owner: SerialConnector, private readonly context: string)
    {
    }

    public Apply(changes: ConnectorChangeSet): Promise<IConnectorApplyResult | void>
    {
        this.steps.push([]);
        return this.owner.RunApply(changes);
    }

    public Create(requests: readonly IAssignedCreate[]): Promise<readonly IAssignedOutcome[]>
    {
        const step: string[] = [];
        this.steps.push(step);
        return this.owner.RunCreate(requests, this.context, step);
    }

    public Undo(): Promise<void>
    {
        return this.owner.RunUndo(this.steps.pop() ?? []);
    }

    public Commit(): Promise<void>
    {
        return Promise.resolve();
    }

    public async Revert(): Promise<void>
    {
        while (this.steps.length > 0) await this.owner.RunUndo(this.steps.pop() ?? []);
    }
}

/** Source-keyed (KeyAssigned) for Order and Customer, engine for Account. */
class SerialPlacement implements INodePlacement
{
    public constructor(private readonly models: ReadonlyMap<string, string>, private readonly assigned: ReadonlySet<string>)
    {
    }

    public Place(concept: string): INodePlace
    {
        const owner = this.models.get(concept);
        if (owner === undefined) return { PublicId: randomUUID(), Owner: SerialPlacement.NoOwner };
        if (this.assigned.has(concept)) return { PublicId: SerialPlacement.NoOwner, Owner: owner, KeyAssigned: true };
        return { PublicId: `${concept.toLowerCase()}-${randomUUID()}`, Owner: owner };
    }

    private static readonly NoOwner = '';
}

/**
 * Order { id, total, note, customer -> Customer } and Customer { id, name, flag } are external, source-keyed on the
 * fake connector `ext`; Account { k, places -> Order } is engine (seed a1, k = 1).
 */
class BatchFx
{
    private static readonly DirPrefix = 'pragmatic-graph-cypher-batch-';
    private static readonly Dirs: string[] = [];

    public static readonly Model = 'shop';
    public static readonly Order = 'Order';
    public static readonly Customer = 'Customer';
    public static readonly Account = 'Account';
    public static readonly Connector = 'ext';

    private constructor(public readonly Engine: GraphEngine, public readonly Connector: SerialConnector, public readonly Cypher: CypherEngine, public readonly Applied: IConnectorApplied[])
    {
    }

    public static Dir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), BatchFx.DirPrefix));
        BatchFx.Dirs.push(dir);
        return dir;
    }

    public static RemoveDirs(): void
    {
        for (const d of BatchFx.Dirs) rmSync(d, { recursive: true, force: true });
    }

    private static Bool(name: string): MemberInput
    {
        return { Name: name, Kind: MemberKind.Property, Type: ValueType.Boolean, Nullable: true };
    }

    public static async Open(kind: StorageKind, seed: readonly IFetchedRow[] = []): Promise<BatchFx>
    {
        const tables = new Map<string, string>([[BatchFx.Order, 'orders'], [BatchFx.Customer, 'customers']]);
        const connector = new SerialConnector(BatchFx.Connector, tables, seed);
        const engine = await GraphEngine.Open({
            Description: {
                Version: 'cypher-batch-v1',
                Definitions: [
                    CypherFixture.Concept(BatchFx.Order, [CypherFixture.Int('id'), CypherFixture.Int('total'), CypherFixture.Int('note'), CypherFixture.Rel('customer', [BatchFx.Customer])]),
                    CypherFixture.Concept(BatchFx.Customer, [CypherFixture.Int('id'), CypherFixture.Text('name'), BatchFx.Bool('flag')]),
                    CypherFixture.Concept(BatchFx.Account, [CypherFixture.Int('k'), CypherFixture.Rel('places', [BatchFx.Order])]),
                ],
                Indexes: [],
                Seed: [CypherFixture.Node('a1', BatchFx.Account, { k: 1n })],
                Bindings: [
                    { Model: BatchFx.Model, Concept: BatchFx.Order, Connector: BatchFx.Connector },
                    { Model: BatchFx.Model, Concept: BatchFx.Customer, Connector: BatchFx.Connector },
                ],
            },
            Storage: kind === StorageKind.Lmdb ? { Kind: StorageKind.Lmdb, Path: BatchFx.Dir() } : { Kind: StorageKind.Memory },
            Connectors: [connector],
        });
        const applied: IConnectorApplied[] = [];
        engine.ConnectorApplied.Subscribe(c => applied.push(c));
        return new BatchFx(engine, connector, new CypherEngine(engine), applied);
    }

    public Placement(): INodePlacement
    {
        return new SerialPlacement(
            new Map<string, string>([[BatchFx.Order, BatchFx.Model], [BatchFx.Customer, BatchFx.Model]]),
            new Set<string>([BatchFx.Order, BatchFx.Customer]),
        );
    }

    public Run(text: string, context?: ConnectorContext): Promise<CypherResult>
    {
        const options = context === undefined ? { Placement: this.Placement() } : { Placement: this.Placement(), Connector: context };
        return this.Cypher.Execute(AccessScope.System, text, options);
    }

    public Explain(text: string): string
    {
        return this.Cypher.Explain(text);
    }

    public async Links(from: string, relationship: string): Promise<string[]>
    {
        const result = await this.Cypher.Execute(AccessScope.System, `MATCH (a:${BatchFx.Account})-[:${relationship}]->(o) WHERE elementId(a) = $id RETURN o.id AS k ORDER BY o.id`, { Parameters: new Map([['id', from]]) });
        return result.Rows.map(r => String((r[0] as ScalarValue).Value));
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

after(() => BatchFx.RemoveDirs());

function customerSeed(count: number): IFetchedRow[]
{
    const rows: IFetchedRow[] = [];
    for (let i = 1; i <= count; i++)
    {
        rows.push({ PublicId: `c${i}`, Concept: BatchFx.Customer, Values: new Map<string, CellValue>([['id', BigInt(i)], ['name', `n${i}`]]), Links: new Map(), Version: `cv${i}` });
    }
    return rows;
}

for (const kind of [StorageKind.Memory, StorageKind.Lmdb])
{
    describe(`Cypher write batching (${StorageKind[kind]})`, () =>
    {
        it('independent multi-row CREATE is one batched step', async () =>
        {
            const fx = await BatchFx.Open(kind);
            try
            {
                assert.match(fx.Explain('UNWIND [1,2,3,4,5] AS i CREATE (:Order {total: 1})'), /Batched/);
                await fx.Run('UNWIND [1,2,3,4,5] AS i CREATE (:Order {total: 1})');
                assert.equal(fx.Connector.CreateCalls.length, 1);
                assert.equal(fx.Connector.CreateCalls[0]!.length, 5);
                assert.equal(fx.Connector.TableSize(BatchFx.Order), 5);
            }
            finally
            {
                await fx.dispose();
            }
        });

        it('batched rows get their real keys', async () =>
        {
            const fx = await BatchFx.Open(kind);
            try
            {
                const result = await fx.Run('UNWIND [1,2,3] AS i CREATE (o:Order {total: 1}) RETURN count(*)');
                assert.equal((result.Rows[0]![0] as ScalarValue).Value, 3n);
                assert.equal(fx.Connector.CreateCalls.length, 1);
                const read = await fx.Cypher.Execute(AccessScope.System, 'MATCH (o:Order) RETURN o.id ORDER BY o.id');
                assert.deepEqual(read.Rows.map(r => (r[0] as ScalarValue).Value), [1n, 2n, 3n]);
            }
            finally
            {
                await fx.dispose();
            }
        });

        it('batched SET is one step', async () =>
        {
            const fx = await BatchFx.Open(kind, customerSeed(2));
            try
            {
                await fx.Run('MATCH (c:Customer) SET c.flag = true');
                assert.equal(fx.Connector.Applied.length, 1);
                const changes = fx.Connector.Applied[0]!.Changes;
                assert.equal(changes.length, 2);
                assert.ok(changes.every(c => c.ExpectedVersion !== undefined));
            }
            finally
            {
                await fx.dispose();
            }
        });

        it('dependent clause forces per-row', async () =>
        {
            const dependent = [
                'UNWIND [1,2] AS i CREATE (o:Order {total: 1}) RETURN o.id',
                'UNWIND [1,2] AS i CREATE (o:Order) WITH o MATCH (a:Account {k: 1}) CREATE (a)-[:places]->(o)',
                'UNWIND [1,2] AS i CREATE (o:Order) SET o.note = 1',
                'UNWIND [1,2] AS i CREATE (o:Order) WITH o MATCH (x:Order) RETURN count(x)',
            ];
            for (const query of dependent)
            {
                const fx = await BatchFx.Open(kind);
                try
                {
                    // The CREATE under test is per-row; its node Create call fires once per input row (2), so each
                    // later clause saw a real key. (A trailing SET with no dependent of its own may itself batch.)
                    assert.match(fx.Explain(query), /CreateOperator\n\s*PerRow/, query);
                    await fx.Run(query);
                    assert.equal(fx.Connector.CreateCalls.length, 2, query);
                }
                finally
                {
                    await fx.dispose();
                }
            }
        });

        it('dependent clause sees the real keys', async () =>
        {
            const fx = await BatchFx.Open(kind);
            try
            {
                const result = await fx.Run('UNWIND [1,2] AS i CREATE (o:Order {total: 1}) RETURN o.id ORDER BY o.id');
                assert.deepEqual(result.Rows.map(r => (r[0] as ScalarValue).Value), [1n, 2n]);
                await fx.Run('UNWIND [1,2] AS i CREATE (o:Order) WITH o MATCH (a:Account {k: 1}) CREATE (a)-[:places]->(o)');
                assert.deepEqual(await fx.Links('a1', 'places'), ['3', '4']);
            }
            finally
            {
                await fx.dispose();
            }
        });

        it('alias closure is followed', async () =>
        {
            const fx = await BatchFx.Open(kind);
            try
            {
                const plan = fx.Explain('UNWIND [1,2] AS i CREATE (o:Order) WITH collect(o) AS os RETURN size(os)');
                assert.match(plan, /PerRow/);
                assert.doesNotMatch(plan, /Batched/);
            }
            finally
            {
                await fx.dispose();
            }
        });

        it('later MERGE over the written label forces per-row', async () =>
        {
            const fx = await BatchFx.Open(kind);
            try
            {
                // E10 rule 3: the later MERGE's match part reads Order by label, overlapping the created Order.
                assert.match(fx.Explain('UNWIND [1,2] AS i CREATE (:Order {total: 1}) MERGE (o:Order {total: 1})'), /CreateOperator\n\s*PerRow/);
            }
            finally
            {
                await fx.dispose();
            }
        });

        it('unrelated later clause keeps batching', async () =>
        {
            const fx = await BatchFx.Open(kind);
            try
            {
                assert.match(fx.Explain('UNWIND [1,2] AS i CREATE (:Order {total: 1}) WITH 1 AS one MATCH (a:Account) RETURN a.k'), /Batched/);
            }
            finally
            {
                await fx.dispose();
            }
        });

        it('pattern stages batch targets first', async () =>
        {
            const fx = await BatchFx.Open(kind);
            try
            {
                await fx.Run('UNWIND [1,2] AS i CREATE (o:Order {total: 1})-[:customer]->(c:Customer {name: \'n\'})');
                assert.equal(fx.Connector.CreateCalls.length, 2);
                assert.ok(fx.Connector.CreateCalls[0]!.every(r => r.Concept === BatchFx.Customer));
                assert.equal(fx.Connector.CreateCalls[0]!.length, 2);
                assert.ok(fx.Connector.CreateCalls[1]!.every(r => r.Concept === BatchFx.Order));
                assert.equal(fx.Connector.CreateCalls[1]!.length, 2);
                assert.deepEqual(fx.Connector.CreateCalls[1]![0]!.Links, [{ Relationship: 'customer', To: 'Customer#ext.customers#1' }]);
                assert.deepEqual(fx.Connector.CreateCalls[1]![1]!.Links, [{ Relationship: 'customer', To: 'Customer#ext.customers#2' }]);
            }
            finally
            {
                await fx.dispose();
            }
        });

        it('partial batch failure compensates exactly the applied rows', async () =>
        {
            const fx = await BatchFx.Open(kind);
            fx.Connector.FailRequestAt = 1;
            try
            {
                const error = await BatchFx.Rejection(fx.Run('UNWIND [1,2,3] AS i CREATE (:Order {total: 1})'));
                assert.ok(error instanceof CypherWriteError && error.WriteCode === CypherWriteErrorCode.ConnectorFailed, String(error));
                assert.deepEqual(fx.Connector.Removed, ['Order#ext.orders#1', 'Order#ext.orders#2']);
                assert.equal(fx.Connector.TableSize(BatchFx.Order), 0);
                assert.equal(fx.Applied[fx.Applied.length - 1]!.Outcome, ConnectorOutcome.Compensated);
            }
            finally
            {
                await fx.dispose();
            }
        });

        it('concurrent batched creates keep their contexts', async () =>
        {
            const fx = await BatchFx.Open(kind);
            fx.Connector.FailContext = 'bob';
            try
            {
                const alice = fx.Run('UNWIND [1,2] AS i CREATE (:Order {total: 1})', ConnectorContext.For('alice'));
                const bob = BatchFx.Rejection(fx.Run('UNWIND [1,2] AS i CREATE (:Order {total: 1})', ConnectorContext.For('bob')));
                await alice;
                const error = await bob;
                assert.ok(error instanceof CypherWriteError && error.WriteCode === CypherWriteErrorCode.ConnectorFailed, String(error));
                assert.deepEqual([...new Set(fx.Connector.BeginContexts)].sort(), ['alice', 'bob']);
                // bob's step compensated only bob's rows; alice's two orders remain committed.
                const bobRows = fx.Connector.CreatedByContext.get('bob') ?? [];
                const aliceRows = fx.Connector.CreatedByContext.get('alice') ?? [];
                assert.ok(fx.Connector.Removed.every(id => bobRows.includes(id) && !aliceRows.includes(id)));
                assert.equal(fx.Connector.TableSize(BatchFx.Order), 2);
            }
            finally
            {
                await fx.dispose();
            }
        });
    });
}
