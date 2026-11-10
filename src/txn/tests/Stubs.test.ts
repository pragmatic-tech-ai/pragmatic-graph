import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessScope } from '../../access/AccessScope.js';
import { MemberKind, ValueType } from '../../catalog/ValueType.js';
import { AccessDefault, AccessScope as Scope } from '../../access/AccessScope.js';
import { AccessError, AccessErrorCode } from '../../access/AccessError.js';
import { FalsePredicate } from '../../predicate/Predicate.js';
import type { ISchemaDescription } from '../../schema/SchemaDescription.js';
import { BindingTable } from '../../connectors/BindingTable.js';
import { ConnectorResidency, type IExternalConnector } from '../../connectors/FetchContract.js';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';
import { EdgeDirection } from '../../format/FormatKeys.js';
import { FederatedReads } from '../../FederatedReads.js';
import { GraphStore } from '../../GraphStore.js';
import type { GraphTransaction } from '../../GraphTransaction.js';
import { Keyspace } from '../../kv/Keyspace.js';
import { EngineInternals } from '../../tests/EngineInternals.js';
import { CommitError, CommitErrorCode } from '../CommitError.js';
import { CommitKind } from '../LogEntry.js';
import { WriteBatch } from '../WriteBatch.js';
import { FakeConnector } from '../../connectors/tests/FakeConnector.js';

/**
 * Schema: team { assigned -> ticket (many) }, ticket, person. jira models hold tickets in the external
 * connector 'ext'; the engine holds teams and people. Teams a and b exist.
 */
class StubFx
{
    private static readonly DirPrefix = 'pragmatic-graph-stubs-';
    private static readonly Dirs: string[] = [];

    public static readonly Team = 'team';
    public static readonly Ticket = 'ticket';
    public static readonly Person = 'person';
    public static readonly Assigned = 'assigned';
    public static readonly Jira = 'jira';
    public static readonly Other = 'other';
    public static readonly Ref = 'ref';
    public static readonly Req = 'req';
    public static readonly ByRef = 'byRef';
    public static readonly UniqRef = 'uniqRef';
    public static readonly Ext = 'ext';
    public static readonly X = 'x';
    public static readonly Y = 'y';
    public static readonly A = 'a';
    public static readonly B = 'b';
    public static readonly Local = 'local';
    public static readonly Z = 'z';
    public static readonly R1 = 'r1';
    public static readonly R2 = 'r2';
    public static readonly V1 = 'v1';
    public static readonly V2 = 'v2';
    public static readonly Jira2 = 'jira2';
    public static readonly Parent = 'parent';
    private static readonly NoExternal = 'no external connector';

    public static readonly Target = Object.freeze({ Concept: StubFx.Ticket, Owner: StubFx.Jira });

    public static Dir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), StubFx.DirPrefix));
        StubFx.Dirs.push(dir);
        return dir;
    }

    public static RemoveDirs(): void
    {
        for (const d of StubFx.Dirs)
        {
            rmSync(d, { recursive: true, force: true });
        }
    }

    public static External(): IExternalConnector
    {
        return {
            Name: StubFx.Ext,
            Residency: ConnectorResidency.External,
            Capabilities: { KeyLookup: false, ReverseLookup: false, PushDown: new Set() },
            Begin: () => Promise.reject(new Error(StubFx.NoExternal)),
            Fetch: () => Promise.resolve({ Rows: [] }),
        };
    }

    /** A store with the schema, teams a and b, an engine-held ticket 'local' (owner ''), and the external binding installed. */
    public static async Ready(open: () => Promise<GraphStore>): Promise<GraphStore>
    {
        const g = await open();
        await g.Upgrade(StubFx.Residency(StubFx.V1, false), [StubFx.External()]);
        await StubFx.Commit(g, t =>
        {
            t.CreateNode(StubFx.A, StubFx.Team);
            t.CreateNode(StubFx.B, StubFx.Team);
            t.CreateNode(StubFx.Local, StubFx.Ticket);
        });
        // A residency change goes through an upgrade (ruling P19).
        await g.Upgrade(StubFx.Residency(StubFx.V1, true), [StubFx.External()]);
        return g;
    }

    public static async Commit(g: GraphStore, build: (t: GraphTransaction) => void): Promise<bigint>
    {
        const t = await g.Begin(AccessScope.System);
        try
        {
            build(t);
            return await t.Commit();
        }
        finally
        {
            t.dispose();
        }
    }

    /** Links `from` to a stub target, e.g. (a, x). */
    public static LinkStub(g: GraphStore, from: string, to: string): Promise<bigint>
    {
        return StubFx.Commit(g, t => t.Link(from, StubFx.Assigned, to, { ExternalTarget: StubFx.Target }));
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
        return assert.fail('expected a rejection');
    }

    public static async ConceptOwner(g: GraphStore, id: string): Promise<[string | undefined, string | undefined]>
    {
        const r = await g.BeginRead(AccessScope.System);
        try
        {
            return [await r.ConceptOf(id), await r.OwnerOf(id)];
        }
        finally
        {
            r.dispose();
        }
    }

    public static async Exists(g: GraphStore, id: string): Promise<boolean>
    {
        return (await StubFx.ConceptOwner(g, id))[0] !== undefined;
    }

    /** The node's assigned edges as stored, stub far ends included (the internal channel: the public reader omits them). */
    public static async OutLinks(g: GraphStore, id: string): Promise<string[]>
    {
        const r = await g.BeginRead(AccessScope.System);
        try
        {
            return (await FederatedReads.Of(r).Links(id, EdgeDirection.Out, StubFx.Assigned)).map(l => l.PublicId);
        }
        finally
        {
            r.dispose();
        }
    }

    public static async Scanned(g: GraphStore, concept: string): Promise<string[]>
    {
        const r = await g.BeginRead(AccessScope.System);
        try
        {
            const ids: string[] = [];
            for await (const id of r.ScanNodes(concept))
            {
                ids.push(id);
            }
            return ids;
        }
        finally
        {
            r.dispose();
        }
    }

    /** How many raw entries the cell keyspaces (Columns, Deltas) hold. */
    public static async CellEntries(g: GraphStore): Promise<number>
    {
        const txn = await EngineInternals.Context(g).Store.BeginRead();
        try
        {
            let n = 0;
            for (const space of [Keyspace.Columns, Keyspace.Deltas])
            {
                for await (const _ of txn.Scan(space, { Start: Uint8Array.of(0), End: Uint8Array.of(255, 255, 255, 255) }))
                {
                    n++;
                }
            }
            return n;
        }
        finally
        {
            txn.dispose();
        }
    }

    /** How many entries the secondary-index keyspace holds. */
    public static async IndexEntries(g: GraphStore): Promise<number>
    {
        const txn = await EngineInternals.Context(g).Store.BeginRead();
        try
        {
            let n = 0;
            for await (const _ of txn.Scan(Keyspace.Index, { Start: Uint8Array.of(0), End: Uint8Array.of(255, 255, 255, 255) }))
            {
                n++;
            }
            return n;
        }
        finally
        {
            txn.dispose();
        }
    }

    /** A schema over the same names: ticket (bound to ext under jira), team, and optionally team.assigned. */
    public static Description(version: string, withTicket: boolean, withAssigned: boolean, required: boolean = false): ISchemaDescription
    {
        const assigned = { Name: StubFx.Assigned, Kind: MemberKind.Relationship as const, Targets: [StubFx.Ticket], Many: true };
        return {
            Version: version,
            Definitions: [
                ...(withTicket ? [{ Name: StubFx.Ticket, IsAspect: false, Parent: null, Aspects: [], Members: required ? [{ Name: StubFx.Req, Kind: MemberKind.Property as const, Type: ValueType.String, Nullable: false }] : [] }] : []),
                { Name: StubFx.Team, IsAspect: false, Parent: null, Aspects: [], Members: withAssigned ? [assigned] : [] },
            ],
            Indexes: [],
            Seed: [],
            Bindings: withTicket ? [{ Model: StubFx.Jira, Concept: StubFx.Ticket, Connector: StubFx.Ext }] : [],
        };
    }

    /**
     * ticket { ref } indexed by byRef and uniqRef, team { assigned -> ticket }; jira's tickets bound to ext when
     * `external`, else engine-held. No seed.
     */
    public static Residency(version: string, external: boolean, options: { readonly Assigned?: boolean; readonly Jira2?: boolean } = {}): ISchemaDescription
    {
        const bindings = external ? [{ Model: StubFx.Jira, Concept: StubFx.Ticket, Connector: StubFx.Ext }] : [];
        if (options.Jira2 === true)
        {
            bindings.push({ Model: StubFx.Jira2, Concept: StubFx.Ticket, Connector: StubFx.Ext });
        }
        const assigned = options.Assigned === false ? [] : [{ Name: StubFx.Assigned, Kind: MemberKind.Relationship as const, Targets: [StubFx.Ticket], Many: true }];
        return {
            Version: version,
            Definitions: [
                { Name: StubFx.Ticket, IsAspect: false, Parent: null, Aspects: [], Members: [
                    { Name: StubFx.Ref, Kind: MemberKind.Property, Type: ValueType.String, Nullable: true },
                    { Name: StubFx.Parent, Kind: MemberKind.Relationship, Targets: [StubFx.Ticket], Many: true },
                ] },
                { Name: StubFx.Person, IsAspect: false, Parent: null, Aspects: [], Members: [] },
                { Name: StubFx.Team, IsAspect: false, Parent: null, Aspects: [], Members: assigned },
            ],
            Indexes: [
                { Name: StubFx.ByRef, On: StubFx.Ticket, Members: [StubFx.Ref], Unique: false },
                { Name: StubFx.UniqRef, On: StubFx.Ticket, Members: [StubFx.Ref], Unique: true },
            ],
            Seed: [],
            Bindings: bindings,
        };
    }

    /** The store's last commit number. */
    public static Last(g: GraphStore): bigint
    {
        return EngineInternals.Context(g).Committer.LastCommit();
    }

    /** How many commits the changefeed holds after `after`. */
    public static async CommitsAfter(g: GraphStore, after: bigint): Promise<number>
    {
        let n = 0;
        for await (const _ of g.ReadChanges(after))
        {
            n++;
        }
        return n;
    }

    /** The raw stored cell of the node's ref (engine storage, bypassing every reader rule); undefined when the node is gone. */
    public static async RawRef(g: GraphStore, publicId: string): Promise<unknown>
    {
        const context = EngineInternals.Context(g);
        const txn = await context.Store.BeginRead();
        try
        {
            const id = await context.Ids.Resolve(txn, publicId);
            const location = id === undefined ? undefined : await context.Rows.Locate(txn, id);
            return location === undefined ? undefined : await context.Columns.ReadCell(txn, location, context.Committer.Catalog.Member(StubFx.Ticket, StubFx.Ref));
        }
        finally
        {
            txn.dispose();
        }
    }

    /** A store upgraded to the full description, teams a and b, and stubs x (from a) and y (from b). */
    public static async Purgeable(open: () => Promise<GraphStore>): Promise<GraphStore>
    {
        const g = await open();
        await g.Upgrade(StubFx.Description('v1', true, true), [StubFx.External()]);
        await StubFx.Commit(g, t =>
        {
            t.CreateNode(StubFx.A, StubFx.Team);
            t.CreateNode(StubFx.B, StubFx.Team);
        });
        await StubFx.LinkStub(g, StubFx.A, StubFx.X);
        await StubFx.LinkStub(g, StubFx.B, StubFx.Y);
        return g;
    }

    public static IsCode(e: unknown, code: CommitErrorCode): boolean
    {
        return e instanceof CommitError && e.Code === code;
    }

    public static Register(name: string, open: () => Promise<GraphStore>): void
    {
        describe('stubs on ' + name, () =>
        {
            it('link to external creates stub', async () =>
            {
                const g = await StubFx.Ready(open);
                const before = await StubFx.CellEntries(g);
                await StubFx.LinkStub(g, StubFx.A, StubFx.X);
                assert.deepEqual(await StubFx.ConceptOwner(g, StubFx.X), [StubFx.Ticket, StubFx.Jira]);
                assert.deepEqual(await StubFx.OutLinks(g, StubFx.A), [StubFx.X]);
                assert.equal(await StubFx.CellEntries(g), before, 'the stub wrote no cell');
                assert.deepEqual(await StubFx.Scanned(g, StubFx.Ticket), [StubFx.Local], 'a stub is not engine data');
                await StubFx.Commit(g, t => t.Unlink(StubFx.A, StubFx.Assigned, StubFx.X));
                assert.equal(await StubFx.CellEntries(g), before, 'deleting the stub wrote no cell either');
                await g.dispose();
            });

            it('the scoped reader serves no stub data and omits stub far ends, but keeps its identity', async () =>
            {
                const g = await StubFx.Ready(open);
                await StubFx.LinkStub(g, StubFx.A, StubFx.X);
                await StubFx.Commit(g, t => t.Link(StubFx.A, StubFx.Assigned, StubFx.Local));
                const allow = Scope.Build({ Default: AccessDefault.Allow });
                for (const scope of [AccessScope.System, allow])
                {
                    const r = await g.BeginRead(scope);
                    try
                    {
                        assert.equal(await r.GetProperty(StubFx.X, StubFx.Ref), undefined);
                        assert.equal(await r.ReadNode(StubFx.X), undefined);
                        assert.deepEqual((await r.Links(StubFx.A, EdgeDirection.Out)).map(l => l.PublicId), [StubFx.Local]);
                        assert.deepEqual((await r.Links(StubFx.A, EdgeDirection.Out, StubFx.Assigned)).map(l => l.PublicId), [StubFx.Local]);
                        assert.deepEqual(await r.Neighbors(StubFx.A, StubFx.Assigned, EdgeDirection.Out), [StubFx.Local]);
                        // Identity stays readable (ruling D2): the stub exists, owned by its model, unseeded.
                        assert.equal(await r.ConceptOf(StubFx.X), StubFx.Ticket);
                        assert.equal(await r.OwnerOf(StubFx.X), StubFx.Jira);
                        assert.equal(await r.IsSeeded(StubFx.X), false);
                        // Engine nodes are unaffected.
                        assert.equal((await r.ReadNode(StubFx.Local))?.Concept, StubFx.Ticket);
                        assert.equal(await r.GetProperty(StubFx.Local, StubFx.Ref), null);
                    }
                    finally
                    {
                        r.dispose();
                    }
                }
                await g.dispose();
            });

            it('stub removed with last edge', async () =>
            {
                const g = await StubFx.Ready(open);
                await StubFx.LinkStub(g, StubFx.A, StubFx.X);
                await StubFx.Commit(g, t => t.Unlink(StubFx.A, StubFx.Assigned, StubFx.X));
                assert.equal(await StubFx.Exists(g, StubFx.X), false);
                await g.dispose();
            });

            it('stub kept while another edge remains', async () =>
            {
                const g = await StubFx.Ready(open);
                await StubFx.LinkStub(g, StubFx.A, StubFx.X);
                await StubFx.LinkStub(g, StubFx.B, StubFx.X);
                await StubFx.Commit(g, t => t.Unlink(StubFx.A, StubFx.Assigned, StubFx.X));
                assert.deepEqual(await StubFx.ConceptOwner(g, StubFx.X), [StubFx.Ticket, StubFx.Jira]);
                await StubFx.Commit(g, t => t.Unlink(StubFx.B, StubFx.Assigned, StubFx.X));
                assert.equal(await StubFx.Exists(g, StubFx.X), false);
                await g.dispose();
            });

            it('stub for an engine-bound concept is rejected', async () =>
            {
                const g = await StubFx.Ready(open);
                const error = await StubFx.Rejection(StubFx.Commit(g, t => t.Link(StubFx.A, StubFx.Assigned, StubFx.X, { ExternalTarget: { Concept: StubFx.Ticket, Owner: '' } })));
                assert.ok(StubFx.IsCode(error, CommitErrorCode.InvalidEdge), String(error));
                assert.equal(await StubFx.Exists(g, StubFx.X), false);
                await g.dispose();
            });

            it('existing stub with different concept is TargetTypeMismatch', async () =>
            {
                const g = await StubFx.Ready(open);
                await StubFx.LinkStub(g, StubFx.A, StubFx.X);
                const error = await StubFx.Rejection(StubFx.Commit(g, t => t.Link(StubFx.B, StubFx.Assigned, StubFx.X, { ExternalTarget: { Concept: StubFx.Person, Owner: StubFx.Jira } })));
                assert.ok(StubFx.IsCode(error, CommitErrorCode.TargetTypeMismatch), String(error));
                await g.dispose();
            });

            it('DeleteNode of the stub\'s last linked source removes the stub', async () =>
            {
                const g = await StubFx.Ready(open);
                await StubFx.LinkStub(g, StubFx.A, StubFx.X);
                await StubFx.LinkStub(g, StubFx.A, StubFx.Y);
                await StubFx.LinkStub(g, StubFx.B, StubFx.Y);
                await StubFx.Commit(g, t => t.DeleteNode(StubFx.A));
                assert.equal(await StubFx.Exists(g, StubFx.X), false);
                assert.equal(await StubFx.Exists(g, StubFx.Y), true, 'b still links y');
                await StubFx.Commit(g, t => t.DeleteNode(StubFx.B));
                assert.equal(await StubFx.Exists(g, StubFx.Y), false);
                await g.dispose();
            });

            it('stub of an indexed concept has no index entries (non-unique and unique)', async () =>
            {
                const g = await StubFx.Ready(open);
                const before = await StubFx.IndexEntries(g);
                await StubFx.LinkStub(g, StubFx.A, StubFx.X);
                await StubFx.LinkStub(g, StubFx.A, StubFx.Y);
                assert.equal(await StubFx.IndexEntries(g), before, 'neither index holds an entry for either stub');
                await StubFx.Commit(g, t => t.Unlink(StubFx.A, StubFx.Assigned, StubFx.Y));
                assert.equal(await StubFx.IndexEntries(g), before);
                await g.dispose();
            });

            it('existing engine node or stub of another owner is TargetTypeMismatch', async () =>
            {
                const g = await StubFx.Ready(open);
                const onLocal = await StubFx.Rejection(StubFx.Commit(g, t => t.Link(StubFx.A, StubFx.Assigned, StubFx.Local, { ExternalTarget: StubFx.Target })));
                assert.ok(StubFx.IsCode(onLocal, CommitErrorCode.TargetTypeMismatch), String(onLocal));
                await StubFx.LinkStub(g, StubFx.A, StubFx.X);
                const otherOwner = await StubFx.Rejection(StubFx.Commit(g, t => t.Link(StubFx.B, StubFx.Assigned, StubFx.X, { ExternalTarget: { Concept: StubFx.Ticket, Owner: StubFx.Other } })));
                assert.ok(StubFx.IsCode(otherOwner, CommitErrorCode.TargetTypeMismatch), String(otherOwner));
                await g.dispose();
            });

            it('a scoped stub link to a row the transaction never fetched is InvisibleNode, as an invisible stored target is (R103)', async () =>
            {
                const g = await StubFx.Ready(open);
                const scope = Scope.Build({ Default: AccessDefault.Allow, Rows: new Map([[StubFx.Ticket, FalsePredicate.Instance]]) });
                const link = async (to: string, concept: string): Promise<bigint> =>
                {
                    const t = await g.Begin(scope);
                    try
                    {
                        t.Link(StubFx.A, StubFx.Assigned, to, { ExternalTarget: { Concept: concept, Owner: StubFx.Jira } });
                        return await t.Commit();
                    }
                    finally
                    {
                        t.dispose();
                    }
                };
                // The positive case (a fetched, visible row) is pinned in connectors/tests/ExternalWrites.test.ts.
                const unfetched = await StubFx.Rejection(link(StubFx.X, StubFx.Ticket));
                assert.ok(unfetched instanceof AccessError && unfetched.Code === AccessErrorCode.InvisibleNode, String(unfetched));
                assert.equal(await StubFx.Exists(g, StubFx.X), false);
                await StubFx.LinkStub(g, StubFx.B, StubFx.X);
                const stub = await StubFx.Rejection(link(StubFx.X, StubFx.Person));
                assert.ok(stub instanceof AccessError && stub.Code === AccessErrorCode.InvisibleNode, String(stub));
                const stored = await StubFx.Rejection(link(StubFx.Local, StubFx.Ticket));
                assert.ok(stored instanceof AccessError && stored.Code === AccessErrorCode.InvisibleNode, String(stored));
                assert.equal((unfetched as Error).message.replace(StubFx.X, StubFx.Local), (stored as Error).message);
                await g.dispose();
            });

            it('concept removal purges its stubs', async () =>
            {
                const g = await StubFx.Purgeable(open);
                await g.Upgrade(StubFx.Description('v2', false, false), [StubFx.External()]);
                assert.equal(await StubFx.Exists(g, StubFx.X), false);
                assert.equal(await StubFx.Exists(g, StubFx.Y), false);
                const r = await g.BeginRead(AccessScope.System);
                try
                {
                    assert.equal(await r.OwnerOf(StubFx.X), undefined);
                }
                finally
                {
                    r.dispose();
                }
                assert.equal(await StubFx.Exists(g, StubFx.A), true);
                await g.dispose();
            });

            it("required property added to a stub's concept keeps its stubs", async () =>
            {
                const g = await StubFx.Purgeable(open);
                await g.Upgrade(StubFx.Description('v2', true, true, true), [StubFx.External()]);
                assert.deepEqual(await StubFx.ConceptOwner(g, StubFx.X), [StubFx.Ticket, StubFx.Jira]);
                assert.deepEqual(await StubFx.OutLinks(g, StubFx.A), [StubFx.X]);
                assert.deepEqual(await StubFx.OutLinks(g, StubFx.B), [StubFx.Y]);
                await g.dispose();
            });

            it('relationship removal deletes orphaned stubs', async () =>
            {
                const g = await StubFx.Purgeable(open);
                await g.Upgrade(StubFx.Description('v2', true, false), [StubFx.External()]);
                assert.equal(await StubFx.Exists(g, StubFx.X), false);
                assert.equal(await StubFx.Exists(g, StubFx.Y), false);
                assert.equal(await StubFx.Exists(g, StubFx.A), true);
                await g.dispose();
            });

            it('upgrade flipping a binding to External strips engine data to a stub', async () =>
            {
                const g = await open();
                await g.Upgrade(StubFx.Residency(StubFx.V1, false), [StubFx.External()]);
                await StubFx.Commit(g, t =>
                {
                    t.CreateNode(StubFx.A, StubFx.Team);
                    t.CreateNode(StubFx.Local, StubFx.Ticket);
                });
                // The entries the engine-held ticket keeps.
                const empty = await StubFx.IndexEntries(g);
                const data = await StubFx.Commit(g, t =>
                {
                    t.CreateNode(StubFx.X, StubFx.Ticket, { Owner: StubFx.Jira });
                    t.SetProperty(StubFx.X, StubFx.Ref, StubFx.R1);
                    t.CreateNode(StubFx.Z, StubFx.Ticket, { Owner: StubFx.Jira });
                    t.SetProperty(StubFx.Z, StubFx.Ref, StubFx.R2);
                    t.Link(StubFx.A, StubFx.Assigned, StubFx.X);
                });
                assert.equal(await StubFx.RawRef(g, StubFx.X), StubFx.R1);
                assert.ok((await StubFx.IndexEntries(g)) > empty);
                // The same version: only the residency changes.
                const upgrade = await g.Upgrade(StubFx.Residency(StubFx.V1, true), [StubFx.External()]);
                assert.equal(upgrade.Changed, false);
                // An Upgrade commit of its own, logged and replayable from the changefeed.
                assert.equal(upgrade.Commit, data + 1n);
                const logged: CommitKind[] = [];
                for await (const entry of g.ReadChanges(data)) logged.push(entry.Kind);
                assert.deepEqual(logged, [CommitKind.Upgrade]);
                // x keeps its identity, owner and incoming edge; its cells and index entries are gone.
                assert.deepEqual(await StubFx.ConceptOwner(g, StubFx.X), [StubFx.Ticket, StubFx.Jira]);
                assert.deepEqual(await StubFx.OutLinks(g, StubFx.A), [StubFx.X]);
                assert.equal(await StubFx.RawRef(g, StubFx.X), null);
                assert.deepEqual(await StubFx.Scanned(g, StubFx.Ticket), [StubFx.Local]);
                assert.equal(await StubFx.IndexEntries(g), empty);
                // z, left without an edge, does not survive as a stub (ruling R102).
                assert.equal(await StubFx.Exists(g, StubFx.Z), false);
                // The engine-held ticket stays engine data.
                assert.deepEqual(await StubFx.ConceptOwner(g, StubFx.Local), [StubFx.Ticket, '']);
                // The stub behaves as one: unlinking its last edge removes it.
                await StubFx.Commit(g, t => t.Unlink(StubFx.A, StubFx.Assigned, StubFx.X));
                assert.equal(await StubFx.Exists(g, StubFx.X), false);
                await g.dispose();
            });

            it('upgrade flipping a binding off External deletes its stubs and their edges', async () =>
            {
                for (const connectors of [[StubFx.External()], [new FakeConnector(StubFx.Ext, [])]])
                {
                    const g = await open();
                    await g.Upgrade(StubFx.Residency(StubFx.V1, true), [StubFx.External()]);
                    await StubFx.Commit(g, t =>
                    {
                        t.CreateNode(StubFx.A, StubFx.Team);
                        t.CreateNode(StubFx.B, StubFx.Team);
                    });
                    await StubFx.LinkStub(g, StubFx.A, StubFx.X);
                    await StubFx.LinkStub(g, StubFx.B, StubFx.X);
                    await StubFx.LinkStub(g, StubFx.A, StubFx.Y);
                    // Engine-held again (no binding), or bound to a connector that is no longer External.
                    const bound = connectors[0] instanceof FakeConnector;
                    await g.Upgrade(StubFx.Residency(StubFx.V1, bound), connectors);
                    assert.equal(await StubFx.Exists(g, StubFx.X), false);
                    assert.equal(await StubFx.Exists(g, StubFx.Y), false);
                    assert.deepEqual(await StubFx.OutLinks(g, StubFx.A), []);
                    assert.deepEqual(await StubFx.OutLinks(g, StubFx.B), []);
                    assert.equal(await StubFx.Exists(g, StubFx.A), true);
                    // The id is free for an engine node now.
                    await StubFx.Commit(g, t => t.CreateNode(StubFx.X, StubFx.Ticket, { Owner: StubFx.Jira }));
                    assert.deepEqual(await StubFx.Scanned(g, StubFx.Ticket), [StubFx.X]);
                    await g.dispose();
                }
            });

            it('catalog change and residency flip in one upgrade remove an orphaned new stub as engine data', async () =>
            {
                const g = await open();
                await g.Upgrade(StubFx.Residency(StubFx.V1, false), [StubFx.External()]);
                await StubFx.Commit(g, t =>
                {
                    t.CreateNode(StubFx.A, StubFx.Team);
                    t.CreateNode(StubFx.Local, StubFx.Ticket);
                });
                const baseline = await StubFx.IndexEntries(g);
                await StubFx.Commit(g, t =>
                {
                    t.CreateNode(StubFx.X, StubFx.Ticket, { Owner: StubFx.Jira });
                    t.SetProperty(StubFx.X, StubFx.Ref, StubFx.R1);
                    t.Link(StubFx.A, StubFx.Assigned, StubFx.X);
                });
                // v2 drops team.assigned (x's only edge) and binds jira's tickets to ext in the same upgrade.
                await g.Upgrade(StubFx.Residency(StubFx.V2, true, { Assigned: false }), [StubFx.External()]);
                assert.equal(await StubFx.Exists(g, StubFx.X), false);
                assert.deepEqual(await StubFx.Scanned(g, StubFx.Ticket), [StubFx.Local]);
                assert.equal(await StubFx.IndexEntries(g), baseline, 'no stale index entry of x');
                await g.dispose();
            });

            it('stripping a node removes a stub its dropped out-edge orphaned', async () =>
            {
                const g = await open();
                await g.Upgrade(StubFx.Residency(StubFx.V1, false, { Jira2: true }), [StubFx.External()]);
                await StubFx.Commit(g, t =>
                {
                    t.CreateNode(StubFx.A, StubFx.Team);
                    t.CreateNode(StubFx.X, StubFx.Ticket, { Owner: StubFx.Jira });
                    t.Link(StubFx.A, StubFx.Assigned, StubFx.X);
                    // y: a stub of jira2 (external in both versions), linked only from x.
                    t.Link(StubFx.X, StubFx.Parent, StubFx.Y, { ExternalTarget: { Concept: StubFx.Ticket, Owner: StubFx.Jira2 } });
                });
                assert.deepEqual(await StubFx.ConceptOwner(g, StubFx.Y), [StubFx.Ticket, StubFx.Jira2]);
                await g.Upgrade(StubFx.Residency(StubFx.V1, true, { Jira2: true }), [StubFx.External()]);
                assert.deepEqual(await StubFx.ConceptOwner(g, StubFx.X), [StubFx.Ticket, StubFx.Jira], 'x is a stub, still linked from a');
                assert.equal(await StubFx.Exists(g, StubFx.Y), false, 'y lost its last edge');
                await g.dispose();
            });

            it('SetConnectors refuses a residency change', async () =>
            {
                const g = await open();
                await g.Upgrade(StubFx.Residency(StubFx.V1, false), [StubFx.External()]);
                const external = new BindingTable(StubFx.Residency(StubFx.V1, true).Bindings ?? []);
                const invalid = (e: unknown): boolean => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument;
                assert.throws(() => g.SetConnectors(external, [StubFx.External()]), invalid);
                // A setup making the same nodes stubs (none) is accepted, as is reinstalling the same External rule.
                g.SetConnectors(new BindingTable([]), [StubFx.External()]);
                await g.Upgrade(StubFx.Residency(StubFx.V1, true), [StubFx.External()]);
                g.SetConnectors(external, [StubFx.External()]);
                assert.throws(() => g.SetConnectors(new BindingTable([]), [StubFx.External()]), invalid);
                await g.dispose();
            });

            it('stub linked and unlinked in one batch leaves no stub', async () =>
            {
                const g = await StubFx.Ready(open);
                await StubFx.Commit(g, t =>
                {
                    t.Link(StubFx.A, StubFx.Assigned, StubFx.X, { ExternalTarget: StubFx.Target });
                    t.Unlink(StubFx.A, StubFx.Assigned, StubFx.X);
                });
                assert.equal(await StubFx.Exists(g, StubFx.X), false);
                await g.dispose();
            });
        });
    }
}

describe('stubs across a reopen (lmdb)', () =>
{
    /** A closed LMDB store whose jira tickets are external, with teams a (with a stub x) and an engine ticket local. */
    const Seeded = async (): Promise<string> =>
    {
        const dir = StubFx.Dir();
        const g = await GraphStore.OpenLmdb(dir);
        await g.Upgrade(StubFx.Residency(StubFx.V1, true), [StubFx.External()]);
        await StubFx.Commit(g, t =>
        {
            t.CreateNode(StubFx.A, StubFx.Team);
            t.CreateNode(StubFx.Local, StubFx.Ticket);
            t.SetProperty(StubFx.Local, StubFx.Ref, StubFx.R1);
        });
        await StubFx.LinkStub(g, StubFx.A, StubFx.X);
        await g.dispose();
        return dir;
    };

    it('reopen with unchanged bindings writes no commit and keeps stubs and engine data', async () =>
    {
        const dir = await Seeded();
        const g = await GraphStore.OpenLmdb(dir);
        const last = StubFx.Last(g);
        const upgrade = await g.Upgrade(StubFx.Residency(StubFx.V1, true), [StubFx.External()]);
        assert.equal(upgrade.Commit, last);
        assert.equal(await StubFx.CommitsAfter(g, last), 0);
        assert.deepEqual(await StubFx.ConceptOwner(g, StubFx.X), [StubFx.Ticket, StubFx.Jira]);
        assert.deepEqual(await StubFx.OutLinks(g, StubFx.A), [StubFx.X]);
        assert.equal(await StubFx.RawRef(g, StubFx.Local), StubFx.R1);
        await g.dispose();
    });

    it('reopen flipping the binding off External deletes its stubs and their edges', async () =>
    {
        const dir = await Seeded();
        const g = await GraphStore.OpenLmdb(dir);
        await g.Upgrade(StubFx.Residency(StubFx.V1, false), [StubFx.External()]);
        assert.equal(await StubFx.Exists(g, StubFx.X), false);
        assert.deepEqual(await StubFx.OutLinks(g, StubFx.A), []);
        assert.equal(await StubFx.RawRef(g, StubFx.Local), StubFx.R1);
        await g.dispose();
    });

    it('reopen flipping the binding on External strips engine data once', async () =>
    {
        const dir = StubFx.Dir();
        const first = await GraphStore.OpenLmdb(dir);
        await first.Upgrade(StubFx.Residency(StubFx.V1, false), [StubFx.External()]);
        await StubFx.Commit(first, t =>
        {
            t.CreateNode(StubFx.A, StubFx.Team);
            t.CreateNode(StubFx.X, StubFx.Ticket, { Owner: StubFx.Jira });
            t.SetProperty(StubFx.X, StubFx.Ref, StubFx.R1);
            t.Link(StubFx.A, StubFx.Assigned, StubFx.X);
        });
        await first.dispose();
        const g = await GraphStore.OpenLmdb(dir);
        const last = StubFx.Last(g);
        await g.Upgrade(StubFx.Residency(StubFx.V1, true), [StubFx.External()]);
        assert.equal(await StubFx.CommitsAfter(g, last), 1);
        assert.equal(await StubFx.RawRef(g, StubFx.X), null);
        assert.deepEqual(await StubFx.OutLinks(g, StubFx.A), [StubFx.X]);
        await g.dispose();
        // Reopening again with the same bindings finds nothing to do.
        const again = await GraphStore.OpenLmdb(dir);
        const after = StubFx.Last(again);
        await again.Upgrade(StubFx.Residency(StubFx.V1, true), [StubFx.External()]);
        assert.equal(await StubFx.CommitsAfter(again, after), 0);
        await again.dispose();
    });
});

describe('stub link serialization', () =>
{
    it('ExternalTarget round-trips through the log format', () =>
    {
        const b = new WriteBatch();
        b.Link('a', 'assigned', 'x', { ExternalTarget: StubFx.Target });
        b.Link('a', 'assigned', 'y', { AfterSibling: 'x', ExternalTarget: { Concept: 'ticket', Owner: '' } });
        const back = WriteBatch.Deserialize(b.Serialize());
        assert.deepEqual(back.Ops(), b.Ops());
    });
});

StubFx.Register('memory', () => GraphStore.OpenMemory());
StubFx.Register('lmdb', () => GraphStore.OpenLmdb(StubFx.Dir()));

after(() => StubFx.RemoveDirs());
