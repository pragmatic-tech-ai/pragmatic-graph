import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessDefault, AccessScope } from '../../access/AccessScope.js';
import { AccessError, AccessErrorCode } from '../../access/AccessError.js';
import type { CellValue } from '../../columns/CellValue.js';
import { CypherWriteError, CypherWriteErrorCode } from '../../cypher/CypherError.js';
import { CypherEngine } from '../../cypher/CypherEngine.js';
import type { CypherResult } from '../../cypher/CypherResult.js';
import { ScalarValue } from '../../cypher/CypherValue.js';
import type { INodePlace, INodePlacement } from '../../cypher/write/NodePlacement.js';
import { CypherFixture } from '../../cypher/tests/CypherFixture.js';
import { GraphErrorCode } from '../../errors/GraphError.js';
import { EdgeDirection } from '../../format/FormatKeys.js';
import { FederatedReads } from '../../FederatedReads.js';
import { GraphEngine, type IEngineStorage, StorageKind } from '../../GraphEngine.js';
import type { GraphTransaction } from '../../GraphTransaction.js';
import { Compare, CompareOp, type Predicate } from '../../predicate/Predicate.js';
import { CommitError, CommitErrorCode } from '../../txn/CommitError.js';
import type { ICommitApplied } from '../../txn/LogEntry.js';
import { type BatchOp, WriteOp } from '../../txn/WriteBatch.js';
import type { ConnectorChange } from '../ConnectorChangeSet.js';
import { ConnectorError, ConnectorPhase } from '../ConnectorError.js';
import type { IFetchedRow } from '../FetchContract.js';
import type { IConnectorTransaction } from '../GraphConnector.js';
import { FakeConnector, FakeStep } from './FakeConnector.js';
import { FakeExternalConnector } from './FakeExternalConnector.js';

/** An External connector that also takes writes: fetches as FakeExternalConnector, writes through a recording FakeConnector. */
class TicketSystem extends FakeExternalConnector
{
    public readonly Log: string[] = [];
    public readonly Writes: FakeConnector;

    public constructor(name: string, rows: readonly IFetchedRow[])
    {
        super(name, [rows]);
        this.Writes = new FakeConnector(name, this.Log);
    }

    public override Begin(): Promise<IConnectorTransaction>
    {
        return this.Writes.Begin();
    }

    /** Every change the connector was asked to apply, flattened. */
    public Changes(): readonly ConnectorChange[]
    {
        return this.Writes.Applied.flatMap(set => set.Changes);
    }
}

/** Places every created node with a fixed id and owner. */
class FixedPlacement implements INodePlacement
{
    public constructor(private readonly id: string, private readonly owner: string)
    {
    }

    public Place(): INodePlace
    {
        return { PublicId: this.id, Owner: this.owner };
    }
}

/**
 * Team { name, assigned -> Ticket* } held by the engine; Ticket { id, state, title, team -> Team* } with model jira's
 * Tickets bound to the External connector ext. Engine Teams a (core) and b (other) and an engine-held Ticket local
 * (closed, owner ''). The connector holds x (open, team a), l (locked) and c (closed).
 */
class ExtFx
{
    private static readonly DirPrefix = 'pragmatic-graph-external-writes-';
    private static readonly Dirs: string[] = [];
    private static readonly Version = 'external-writes-v1';
    public static readonly Team = 'Team';
    public static readonly Ticket = 'Ticket';
    public static readonly Jira = 'jira';
    public static readonly Ext = 'ext';
    public static readonly Assigned = 'assigned';
    public static readonly TeamRel = 'team';
    public static readonly Name = 'name';
    public static readonly Id = 'id';
    public static readonly State = 'state';
    public static readonly Title = 'title';
    public static readonly Core = 'core';
    public static readonly Other = 'other';
    public static readonly A = 'a';
    public static readonly B = 'b';
    public static readonly C2 = 'c2';
    public static readonly Local = 'local';
    public static readonly X = 'x';
    public static readonly Locked = 'l';
    public static readonly Closed = 'c';
    public static readonly Nope = 'nope';
    public static readonly New = 'n1';
    public static readonly OpenState = 'open';
    public static readonly LockedState = 'locked';
    public static readonly ClosedState = 'closed';
    public static readonly NewState = 'new';
    public static readonly DoneState = 'done';
    public static readonly ExtBegin = 'ext.Begin';
    public static readonly ExtRevert = 'ext.Revert';
    public static readonly Target = Object.freeze({ Concept: ExtFx.Ticket, Owner: ExtFx.Jira });
    private static readonly Space = ' ';
    private static readonly Dot = '.';

    private readonly applied: ICommitApplied[] = [];

    private constructor(public readonly Engine: GraphEngine, public readonly Connector: TicketSystem, public readonly Cypher: CypherEngine)
    {
        Engine.CommitApplied.Subscribe(c => this.applied.push(c));
    }

    public static Dir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), ExtFx.DirPrefix));
        ExtFx.Dirs.push(dir);
        return dir;
    }

    public static RemoveDirs(): void
    {
        for (const d of ExtFx.Dirs)
        {
            rmSync(d, { recursive: true, force: true });
        }
    }

    public static Row(id: string, state: string, links: Readonly<Record<string, readonly string[]>> = {}): IFetchedRow
    {
        return { PublicId: id, Concept: ExtFx.Ticket, Values: new Map<string, CellValue>([[ExtFx.Id, id], [ExtFx.State, state]]), Links: new Map(Object.entries(links)) };
    }

    public static async Open(storage: IEngineStorage): Promise<ExtFx>
    {
        const connector = new TicketSystem(ExtFx.Ext, [
            ExtFx.Row(ExtFx.X, ExtFx.OpenState, { team: [ExtFx.A] }),
            ExtFx.Row(ExtFx.Locked, ExtFx.LockedState),
            ExtFx.Row(ExtFx.Closed, ExtFx.ClosedState),
        ]);
        const engine = await GraphEngine.Open({
            Description: {
                Version: ExtFx.Version,
                Definitions: [
                    CypherFixture.Concept(ExtFx.Team, [CypherFixture.Text(ExtFx.Name), CypherFixture.Rel(ExtFx.Assigned, [ExtFx.Ticket])]),
                    CypherFixture.Concept(ExtFx.Ticket, [
                        CypherFixture.Text(ExtFx.Id), CypherFixture.Text(ExtFx.State), CypherFixture.Text(ExtFx.Title), CypherFixture.Rel(ExtFx.TeamRel, [ExtFx.Team]),
                    ]),
                ],
                Indexes: [],
                Seed: [
                    CypherFixture.Node(ExtFx.A, ExtFx.Team, { name: ExtFx.Core }),
                    CypherFixture.Node(ExtFx.B, ExtFx.Team, { name: ExtFx.Other }),
                    CypherFixture.Node(ExtFx.Local, ExtFx.Ticket, { id: ExtFx.Local, state: ExtFx.ClosedState }),
                ],
                Bindings: [{ Model: ExtFx.Jira, Concept: ExtFx.Ticket, Connector: ExtFx.Ext }],
            },
            Storage: storage,
            Connectors: [connector],
        });
        return new ExtFx(engine, connector, new CypherEngine(engine));
    }

    /** The engine batches committed since the fixture opened (its seed included). */
    public get Applied(): readonly ICommitApplied[]
    {
        return this.applied;
    }

    public Run(text: string, scope: AccessScope = AccessScope.System, placement?: INodePlacement): Promise<CypherResult>
    {
        return this.Cypher.Execute(scope, text, placement === undefined ? {} : { Placement: placement });
    }

    /** Runs `work` on a transaction under `scope` and commits it. */
    public async Commit(scope: AccessScope, work: (t: GraphTransaction) => Promise<void>): Promise<bigint>
    {
        const t = await this.Engine.Begin(scope);
        try
        {
            await work(t);
            return await t.Commit();
        }
        finally
        {
            t.dispose();
        }
    }

    /** Fetches the Ticket into the transaction's own FetchSession (a key lookup), as a Cypher MATCH would. */
    public static async Fetch(t: GraphTransaction, publicId: string): Promise<void>
    {
        const channel = FederatedReads.Of(t);
        const setup = channel.Setup!;
        const row = await channel.Session!.Lookup(publicId, setup.Bindings.ExternalTargets(ExtFx.Ticket, t.Catalog, setup.External));
        assert.ok(row !== undefined, publicId);
    }

    /** Links engine Team `from` to the external Ticket `to` (creating its stub). */
    public LinkStub(from: string, to: string): Promise<bigint>
    {
        return this.Commit(AccessScope.System, async t => t.Link(from, ExtFx.Assigned, to, { ExternalTarget: ExtFx.Target }));
    }

    /** The stored owner of the id ('' for none), undefined when no node (stub or not) is stored. */
    public async StoredOwner(publicId: string): Promise<string | undefined>
    {
        const r = await this.Engine.BeginRead(AccessScope.System);
        try
        {
            return await r.OwnerOf(publicId);
        }
        finally
        {
            r.dispose();
        }
    }

    /** Raw engine ids of every stored node of the concept. */
    public async Stored(concept: string): Promise<string[]>
    {
        const r = await this.Engine.BeginRead(AccessScope.System);
        try
        {
            const out: string[] = [];
            for await (const id of r.ScanNodes(concept)) out.push(id);
            return out;
        }
        finally
        {
            r.dispose();
        }
    }

    public async LinksOf(publicId: string): Promise<readonly string[]>
    {
        const r = await this.Engine.BeginRead(AccessScope.System);
        try
        {
            return (await r.Links(publicId, EdgeDirection.Out)).map(l => l.PublicId);
        }
        finally
        {
            r.dispose();
        }
    }

    public async LastCommit(): Promise<bigint>
    {
        const r = await this.Engine.BeginRead(AccessScope.System);
        try
        {
            return r.SnapshotCommit;
        }
        finally
        {
            r.dispose();
        }
    }

    /** Op kind and the ids it names, for compact assertions. */
    public static Shape(op: BatchOp): string
    {
        switch (op.Op)
        {
            case WriteOp.CreateNode:
            case WriteOp.DeleteNode:
            case WriteOp.SetOwner:
                return WriteOp[op.Op] + ExtFx.Space + op.PublicId;
            case WriteOp.SetProperty:
                return WriteOp[op.Op] + ExtFx.Space + op.PublicId + ExtFx.Dot + op.Member;
            case WriteOp.Link:
            case WriteOp.Unlink:
                return WriteOp[op.Op] + ExtFx.Space + op.From + ExtFx.Space + op.Relationship + ExtFx.Space + op.To;
        }
        return String(op);
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

type StorageFactory = () => IEngineStorage;

class ExternalWritesSuite
{
    private static readonly NotLocked = AccessScope.Build({
        Default: AccessDefault.Allow,
        Writes: new Map([[ExtFx.Ticket, { Update: new Compare(ExtFx.State, CompareOp.Ne, ExtFx.LockedState) }]]),
    });

    /** Only open Tickets (engine or external) and the core Team are visible. */
    private static readonly OpenOnly = AccessScope.Build({
        Default: AccessDefault.Allow,
        Rows: new Map<string, Predicate>([
            [ExtFx.Ticket, new Compare(ExtFx.State, CompareOp.Eq, ExtFx.OpenState)],
            [ExtFx.Team, new Compare(ExtFx.Name, CompareOp.Eq, ExtFx.Core)],
        ]),
    });

    private static readonly NoDeleteOpen = AccessScope.Build({
        Default: AccessDefault.Allow,
        Writes: new Map([[ExtFx.Ticket, { Delete: new Compare(ExtFx.State, CompareOp.Ne, ExtFx.OpenState) }]]),
    });

    public static IsAccess(error: unknown, code: AccessErrorCode): boolean
    {
        const cause = error instanceof CypherWriteError ? error.cause : error;
        return cause instanceof AccessError && cause.GraphCode === GraphErrorCode.AccessDenied && cause.Code === code;
    }

    public static Register(name: string, storage: StorageFactory): void
    {
        describe(`Writes to external nodes (${name})`, () =>
        {
            it('create external node goes to connector only', async () =>
            {
                const fx = await ExtFx.Open(storage());
                try
                {
                    const before = fx.Applied.length;
                    await fx.Run('CREATE (t:Ticket {state: \'new\'}) RETURN t', AccessScope.System, new FixedPlacement(ExtFx.New, ExtFx.Jira));
                    assert.deepEqual(fx.Connector.Changes().map(c => ExtFx.Shape(c)), ['CreateNode n1', 'SetProperty n1.state']);
                    const created = fx.Connector.Changes()[0]!;
                    assert.equal(created.Owner, ExtFx.Jira);
                    assert.equal(created.Concept, ExtFx.Ticket);
                    assert.equal(await fx.StoredOwner(ExtFx.New), undefined);
                    assert.deepEqual(await fx.Stored(ExtFx.Ticket), [ExtFx.Local]);
                    // Nothing external reached the engine batch.
                    for (const c of fx.Applied.slice(before)) assert.equal(c.Batch.Count, 0);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('set on fetched node', async () =>
            {
                const fx = await ExtFx.Open(storage());
                try
                {
                    await fx.Run('MATCH (t:Ticket {id: \'x\'}) SET t.state = \'done\'');
                    const changes = fx.Connector.Changes();
                    assert.deepEqual(changes.map(c => ExtFx.Shape(c)), ['SetProperty x.state']);
                    assert.equal((changes[0] as ConnectorChange & { Value: CellValue }).Value, ExtFx.DoneState);
                    assert.equal(changes[0]!.Owner, ExtFx.Jira);
                    assert.equal(await fx.StoredOwner(ExtFx.X), undefined);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('update rule evaluated on fetched row', async () =>
            {
                const fx = await ExtFx.Open(storage());
                try
                {
                    const error = await ExtFx.Rejection(fx.Run('MATCH (t:Ticket {id: \'l\'}) SET t.state = \'done\'', ExternalWritesSuite.NotLocked));
                    assert.ok(error instanceof CypherWriteError && error.WriteCode === CypherWriteErrorCode.Denied, String(error));
                    assert.ok(ExternalWritesSuite.IsAccess(error, AccessErrorCode.UpdateDenied), String(error));
                    assert.equal(fx.Connector.Log.includes(ExtFx.ExtBegin), false);
                    // The same rule allows an unlocked ticket.
                    await fx.Run('MATCH (t:Ticket {id: \'x\'}) SET t.state = \'done\'', ExternalWritesSuite.NotLocked);
                    assert.deepEqual(fx.Connector.Changes().map(c => ExtFx.Shape(c)), ['SetProperty x.state']);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('invisible external row cannot be updated', async () =>
            {
                const fx = await ExtFx.Open(storage());
                try
                {
                    const fetched = await ExtFx.Rejection(fx.Commit(ExternalWritesSuite.OpenOnly, async t =>
                    {
                        await ExtFx.Fetch(t, ExtFx.Closed);
                        t.SetProperty(ExtFx.Closed, ExtFx.State, ExtFx.DoneState);
                    }));
                    assert.ok(ExternalWritesSuite.IsAccess(fetched, AccessErrorCode.InvisibleNode), String(fetched));
                    // Never fetched in the transaction: the same code, the gate never asks the connector.
                    const unfetched = await ExtFx.Rejection(fx.Commit(ExternalWritesSuite.OpenOnly, async t => t.SetProperty(ExtFx.X, ExtFx.State, ExtFx.DoneState)));
                    assert.ok(ExternalWritesSuite.IsAccess(unfetched, AccessErrorCode.InvisibleNode), String(unfetched));
                    // A Delete of an invisible row too.
                    const deleted = await ExtFx.Rejection(fx.Commit(ExternalWritesSuite.OpenOnly, async t =>
                    {
                        await ExtFx.Fetch(t, ExtFx.Closed);
                        t.DeleteNode(ExtFx.Closed);
                    }));
                    assert.ok(ExternalWritesSuite.IsAccess(deleted, AccessErrorCode.InvisibleNode), String(deleted));
                    assert.equal(fx.Connector.Log.includes(ExtFx.ExtBegin), false);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('delete rule evaluated on fetched row', async () =>
            {
                const fx = await ExtFx.Open(storage());
                try
                {
                    const error = await ExtFx.Rejection(fx.Run('MATCH (t:Ticket {id: \'x\'}) DETACH DELETE t', ExternalWritesSuite.NoDeleteOpen));
                    assert.ok(ExternalWritesSuite.IsAccess(error, AccessErrorCode.DeleteDenied), String(error));
                    await fx.Run('MATCH (t:Ticket {id: \'c\'}) DETACH DELETE t', ExternalWritesSuite.NoDeleteOpen);
                    assert.deepEqual(fx.Connector.Changes().map(c => ExtFx.Shape(c)), ['DeleteNode c']);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('delete external node unlinks engine edges and removes stub', async () =>
            {
                const fx = await ExtFx.Open(storage());
                try
                {
                    await fx.LinkStub(ExtFx.A, ExtFx.X);
                    assert.equal(await fx.StoredOwner(ExtFx.X), ExtFx.Jira);
                    const before = fx.Applied.length;
                    await fx.Run('MATCH (t:Ticket {id: \'x\'}) DETACH DELETE t');
                    const engine = fx.Applied.slice(before).flatMap(c => c.Batch.Ops().map(op => ExtFx.Shape(op)));
                    assert.deepEqual(engine, ['Unlink a assigned x']);
                    // The row's own link (x -team-> a) is external data: the connector's, with the delete.
                    assert.deepEqual(fx.Connector.Changes().map(c => ExtFx.Shape(c)), ['Unlink x team a', 'DeleteNode x']);
                    assert.equal(await fx.StoredOwner(ExtFx.X), undefined);
                    assert.deepEqual(await fx.LinksOf(ExtFx.A), []);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('a plain DeleteNode of an external node unlinks every engine edge into its stub (R89)', async () =>
            {
                const fx = await ExtFx.Open(storage());
                try
                {
                    await fx.LinkStub(ExtFx.A, ExtFx.X);
                    await fx.LinkStub(ExtFx.B, ExtFx.X);
                    const before = fx.Applied.length;
                    await fx.Commit(AccessScope.System, async t =>
                    {
                        await ExtFx.Fetch(t, ExtFx.X);
                        t.DeleteNode(ExtFx.X);
                    });
                    const engine = fx.Applied.slice(before).flatMap(c => c.Batch.Ops().map(op => ExtFx.Shape(op)));
                    assert.deepEqual(engine, ['Unlink a assigned x', 'Unlink b assigned x']);
                    assert.deepEqual(fx.Connector.Changes().map(c => ExtFx.Shape(c)), ['DeleteNode x']);
                    assert.equal(await fx.StoredOwner(ExtFx.X), undefined);
                    // Strict: an engine edge into the stub fails the commit before any connector begins.
                    await fx.LinkStub(ExtFx.A, ExtFx.Closed);
                    const strict = await ExtFx.Rejection(fx.Commit(AccessScope.System, async t =>
                    {
                        await ExtFx.Fetch(t, ExtFx.Closed);
                        t.DeleteNode(ExtFx.Closed, { Strict: true });
                    }));
                    assert.ok(strict instanceof CommitError && strict.Code === CommitErrorCode.NodeHasEdges, String(strict));
                    assert.equal(await fx.StoredOwner(ExtFx.Closed), ExtFx.Jira);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('a link whose source is external goes to the connector only', async () =>
            {
                const fx = await ExtFx.Open(storage());
                try
                {
                    const before = fx.Applied.length;
                    await fx.Run('MATCH (t:Ticket {id: \'c\'}), (b:Team {name: \'other\'}) CREATE (t)-[:team]->(b)');
                    assert.deepEqual(fx.Connector.Changes().map(c => ExtFx.Shape(c)), ['Link c team b']);
                    for (const c of fx.Applied.slice(before)) assert.equal(c.Batch.Count, 0);
                    assert.equal(await fx.StoredOwner(ExtFx.Closed), undefined);
                    // A write that does not fit the schema is rejected before any connector begins.
                    const bad = await ExtFx.Rejection(fx.Commit(AccessScope.System, async t =>
                    {
                        await ExtFx.Fetch(t, ExtFx.X);
                        t.SetProperty(ExtFx.X, ExtFx.State, 1n);
                    }));
                    assert.ok(bad instanceof CommitError && bad.Code === CommitErrorCode.InvalidValue, String(bad));
                    const mismatch = await ExtFx.Rejection(fx.Commit(AccessScope.System, async t =>
                    {
                        await ExtFx.Fetch(t, ExtFx.X);
                        t.Link(ExtFx.X, ExtFx.TeamRel, ExtFx.Local);
                    }));
                    assert.ok(mismatch instanceof CommitError && mismatch.Code === CommitErrorCode.TargetTypeMismatch, String(mismatch));
                    const clash = await ExtFx.Rejection(fx.Commit(AccessScope.System, async t => t.CreateNode(ExtFx.A, ExtFx.Ticket, { Owner: ExtFx.Jira })));
                    assert.ok(clash instanceof CommitError && clash.Code === CommitErrorCode.DuplicatePublicId, String(clash));
                    assert.equal(fx.Connector.Log.filter(e => e === ExtFx.ExtBegin).length, 1);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('cypher CREATE of a relationship to a fetched node creates the stub', async () =>
            {
                const fx = await ExtFx.Open(storage());
                try
                {
                    await fx.Run('MATCH (a:Team {name: \'core\'}), (t:Ticket {id: \'x\'}) CREATE (a)-[:assigned]->(t)');
                    assert.equal(await fx.StoredOwner(ExtFx.X), ExtFx.Jira);
                    assert.deepEqual(await fx.LinksOf(ExtFx.A), [ExtFx.X]);
                    // Engine-held link: no connector took part.
                    assert.equal(fx.Connector.Log.includes(ExtFx.ExtBegin), false);
                    const back = await fx.Run('MATCH (a:Team)-[:assigned]->(t:Ticket) RETURN t.state');
                    assert.deepEqual(back.Rows.map(r => (r[0] as ScalarValue).Value), [ExtFx.OpenState]);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('link to an invisible external row is denied', async () =>
            {
                const fx = await ExtFx.Open(storage());
                try
                {
                    const error = await ExtFx.Rejection(fx.Commit(ExternalWritesSuite.OpenOnly, async t =>
                    {
                        await ExtFx.Fetch(t, ExtFx.Closed);
                        t.Link(ExtFx.A, ExtFx.Assigned, ExtFx.Closed, { ExternalTarget: ExtFx.Target });
                    }));
                    assert.ok(ExternalWritesSuite.IsAccess(error, AccessErrorCode.InvisibleNode), String(error));
                    assert.equal(await fx.StoredOwner(ExtFx.Closed), undefined);
                    // A visible fetched row may be linked under the same scope.
                    await fx.Commit(ExternalWritesSuite.OpenOnly, async t =>
                    {
                        await ExtFx.Fetch(t, ExtFx.X);
                        t.Link(ExtFx.A, ExtFx.Assigned, ExtFx.X, { ExternalTarget: ExtFx.Target });
                    });
                    assert.deepEqual(await fx.LinksOf(ExtFx.A), [ExtFx.X]);
                    // Once its stub exists, a further link is still decided by the fetched row.
                    const again = await ExtFx.Rejection(fx.Commit(ExternalWritesSuite.OpenOnly, async t => t.Link(ExtFx.A, ExtFx.Assigned, ExtFx.X, { ExternalTarget: ExtFx.Target })));
                    assert.ok(ExternalWritesSuite.IsAccess(again, AccessErrorCode.InvisibleNode), String(again));
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('link to an external id never fetched in the transaction is denied', async () =>
            {
                const fx = await ExtFx.Open(storage());
                try
                {
                    const external = await ExtFx.Rejection(fx.Commit(ExternalWritesSuite.OpenOnly, async t => t.Link(ExtFx.A, ExtFx.Assigned, ExtFx.Nope, { ExternalTarget: ExtFx.Target })));
                    const engine = await ExtFx.Rejection(fx.Commit(ExternalWritesSuite.OpenOnly, async t => t.Link(ExtFx.A, ExtFx.Assigned, ExtFx.Local, { ExternalTarget: ExtFx.Target })));
                    assert.ok(ExternalWritesSuite.IsAccess(external, AccessErrorCode.InvisibleNode), String(external));
                    assert.ok(ExternalWritesSuite.IsAccess(engine, AccessErrorCode.InvisibleNode), String(engine));
                    // Indistinguishable: the same code and the same message shape, naming only the requested id.
                    assert.equal((external as Error).message.replace(ExtFx.Nope, ExtFx.Local), (engine as Error).message);
                    assert.equal(await fx.StoredOwner(ExtFx.Nope), undefined);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('connector failure reverts and leaves KV unchanged', async () =>
            {
                const fx = await ExtFx.Open(storage());
                try
                {
                    fx.Connector.Writes.FailAt = FakeStep.Apply;
                    const commit = await fx.LastCommit();
                    const error = await ExtFx.Rejection(fx.Run('MATCH (a:Team {name: \'core\'}), (t:Ticket {id: \'x\'}) SET t.state = \'done\' CREATE (a)-[:assigned]->(t)'));
                    assert.ok(error instanceof CypherWriteError && error.WriteCode === CypherWriteErrorCode.ConnectorFailed, String(error));
                    const cause = error.cause;
                    assert.ok(cause instanceof ConnectorError && cause.Connector === ExtFx.Ext && cause.Phase === ConnectorPhase.Apply, String(cause));
                    assert.ok(fx.Connector.Log.includes(ExtFx.ExtRevert));
                    assert.equal(await fx.LastCommit(), commit);
                    assert.equal(await fx.StoredOwner(ExtFx.X), undefined);
                    assert.deepEqual(await fx.LinksOf(ExtFx.A), []);
                }
                finally
                {
                    await fx.dispose();
                }
            });

            it('a mixed batch whose external connector fails persists neither engine rows nor stubs', async () =>
            {
                const fx = await ExtFx.Open(storage());
                try
                {
                    fx.Connector.Writes.FailAt = FakeStep.Commit;
                    const commit = await fx.LastCommit();
                    const error = await ExtFx.Rejection(fx.Commit(AccessScope.System, async t =>
                    {
                        await ExtFx.Fetch(t, ExtFx.X);
                        t.CreateNode(ExtFx.C2, ExtFx.Team);
                        t.SetProperty(ExtFx.C2, ExtFx.Name, ExtFx.Core);
                        t.Link(ExtFx.C2, ExtFx.Assigned, ExtFx.X, { ExternalTarget: ExtFx.Target });
                        t.SetProperty(ExtFx.X, ExtFx.State, ExtFx.DoneState);
                        t.SetProperty(ExtFx.B, ExtFx.Name, ExtFx.Core);
                    }));
                    assert.ok(error instanceof ConnectorError && error.Phase === ConnectorPhase.Commit, String(error));
                    assert.ok(fx.Connector.Log.includes(ExtFx.ExtRevert));
                    assert.equal(await fx.LastCommit(), commit);
                    assert.equal(await fx.StoredOwner(ExtFx.C2), undefined);
                    assert.equal(await fx.StoredOwner(ExtFx.X), undefined);
                    const r = await fx.Engine.BeginRead(AccessScope.System);
                    try
                    {
                        assert.equal(await r.GetProperty(ExtFx.B, ExtFx.Name), ExtFx.Other);
                    }
                    finally
                    {
                        r.dispose();
                    }
                }
                finally
                {
                    await fx.dispose();
                }
            });
        });
    }
}

after(() => ExtFx.RemoveDirs());
ExternalWritesSuite.Register('Memory', () => ({ Kind: StorageKind.Memory }));
ExternalWritesSuite.Register('LMDB', () => ({ Kind: StorageKind.Lmdb, Path: ExtFx.Dir() }));
