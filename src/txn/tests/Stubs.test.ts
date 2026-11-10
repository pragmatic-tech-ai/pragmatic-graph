import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessScope } from '../../access/AccessScope.js';
import { CatalogModel } from '../../catalog/CatalogModel.js';
import { MemberKind, ValueType } from '../../catalog/ValueType.js';
import { AccessDefault, AccessScope as Scope } from '../../access/AccessScope.js';
import { AccessError, AccessErrorCode } from '../../access/AccessError.js';
import { FalsePredicate } from '../../predicate/Predicate.js';
import type { ISchemaDescription } from '../../schema/SchemaDescription.js';
import { BindingTable } from '../../connectors/BindingTable.js';
import { ConnectorResidency, type IExternalConnector } from '../../connectors/FetchContract.js';
import { EdgeDirection } from '../../format/FormatKeys.js';
import { GraphStore } from '../../GraphStore.js';
import type { GraphTransaction } from '../../GraphTransaction.js';
import { Keyspace } from '../../kv/Keyspace.js';
import { EngineInternals } from '../../tests/EngineInternals.js';
import { CommitError, CommitErrorCode } from '../CommitError.js';
import { WriteBatch } from '../WriteBatch.js';

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
        await g.DefineSchema(m => StubFx.Define(m));
        await StubFx.Commit(g, t =>
        {
            t.CreateNode(StubFx.A, StubFx.Team);
            t.CreateNode(StubFx.B, StubFx.Team);
            t.CreateNode(StubFx.Local, StubFx.Ticket);
        });
        g.SetConnectors(new BindingTable([{ Model: StubFx.Jira, Concept: StubFx.Ticket, Connector: StubFx.Ext }]), [StubFx.External()]);
        return g;
    }

    public static Define(m: CatalogModel): void
    {
        m.DefineConcept(StubFx.Ticket, null, [], [{ Name: StubFx.Ref, Kind: MemberKind.Property, Type: ValueType.String, Nullable: true }]);
        m.DefineIndex(StubFx.ByRef, StubFx.Ticket, [StubFx.Ref], false);
        m.DefineIndex(StubFx.UniqRef, StubFx.Ticket, [StubFx.Ref], true);
        m.DefineConcept(StubFx.Person, null, [], []);
        m.DefineConcept(StubFx.Team, null, [], [{ Name: StubFx.Assigned, Kind: MemberKind.Relationship, Targets: [StubFx.Ticket], Many: true }]);
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

    public static async OutLinks(g: GraphStore, id: string): Promise<string[]>
    {
        const r = await g.BeginRead(AccessScope.System);
        try
        {
            return (await r.Links(id, EdgeDirection.Out, StubFx.Assigned)).map(l => l.PublicId);
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
