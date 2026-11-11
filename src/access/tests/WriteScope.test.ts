import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemberInput } from '../../catalog/CatalogTypes.js';
import { MemberKind, ValueType } from '../../catalog/ValueType.js';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';
import { EdgeDirection } from '../../format/FormatKeys.js';
import { GraphStore } from '../../GraphStore.js';
import type { GraphTransaction } from '../../GraphTransaction.js';
import { And, Compare, CompareOp, FalsePredicate, Not, OwnerIs, type Predicate, Reachable, Related, Seeded, TruePredicate } from '../../predicate/Predicate.js';
import type { ISchemaDescription } from '../../schema/SchemaDescription.js';
import type { ICommitApplied } from '../../txn/LogEntry.js';
import { CommitError } from '../../txn/CommitError.js';
import { ConflictError } from '../../txn/ConflictError.js';
import { AccessError, AccessErrorCode } from '../AccessError.js';
import { AccessDefault, AccessScope, type IWriteRules } from '../AccessScope.js';

/**
 * Schema and helpers for the write-scope tests. Aspect Secret { level }; Person (carries Secret)
 * { name, status, email, manages -> Person* }; Team { name, member -> Person* ordered }; Ticket { status,
 * title, about -> Person }. Seed: one Team 'seedTeam'.
 */
class WriteFx
{
    private static readonly DirPrefix = 'pragmatic-graph-write-scope-';
    private static readonly Dirs: string[] = [];
    public static readonly Secret = 'Secret';
    public static readonly Person = 'Person';
    public static readonly Ok = 'ok';
    public static readonly Team = 'Team';
    public static readonly Ticket = 'Ticket';
    public static readonly Level = 'level';
    public static readonly Name = 'name';
    public static readonly Status = 'status';
    public static readonly Title = 'title';
    public static readonly Email = 'email';
    public static readonly Manages = 'manages';
    public static readonly Member = 'member';
    public static readonly About = 'about';
    public static readonly Open = 'open';
    public static readonly Closed = 'closed';
    public static readonly Secretive = 'secret';
    public static readonly SeedTeam = 'seedTeam';

    public static Dir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), WriteFx.DirPrefix));
        WriteFx.Dirs.push(dir);
        return dir;
    }

    public static RemoveDirs(): void
    {
        for (const d of WriteFx.Dirs)
        {
            rmSync(d, { recursive: true, force: true });
        }
    }

    public static Prop(name: string, type: ValueType): MemberInput
    {
        return { Name: name, Kind: MemberKind.Property, Type: type, Nullable: true };
    }

    public static Rel(name: string, target: string, many: boolean, ordered = false): MemberInput
    {
        return { Name: name, Kind: MemberKind.Relationship, Targets: [target], Many: many, Ordered: ordered };
    }

    public static Description(): ISchemaDescription
    {
        return {
            Version: 'v1',
            Definitions: [
                { Name: WriteFx.Secret, IsAspect: true, Parent: null, Aspects: [], Members: [WriteFx.Prop(WriteFx.Level, ValueType.Int64)] },
                {
                    Name: WriteFx.Person, IsAspect: false, Parent: null, Aspects: [WriteFx.Secret], Members: [
                        WriteFx.Prop(WriteFx.Name, ValueType.String),
                        WriteFx.Prop(WriteFx.Status, ValueType.String),
                        WriteFx.Prop(WriteFx.Email, ValueType.String),
                        WriteFx.Rel(WriteFx.Manages, WriteFx.Person, true),
                    ],
                },
                { Name: WriteFx.Team, IsAspect: false, Parent: null, Aspects: [], Members: [WriteFx.Prop(WriteFx.Name, ValueType.String), WriteFx.Rel(WriteFx.Member, WriteFx.Person, true, true)] },
                {
                    Name: WriteFx.Ticket, IsAspect: false, Parent: null, Aspects: [], Members: [
                        WriteFx.Prop(WriteFx.Status, ValueType.String),
                        WriteFx.Prop(WriteFx.Title, ValueType.String),
                        WriteFx.Rel(WriteFx.About, WriteFx.Person, false),
                    ],
                },
            ],
            Indexes: [],
            Seed: [{ PublicId: WriteFx.SeedTeam, Concept: WriteFx.Team, Owner: '', Properties: {}, Links: [] }],
            Bindings: [],
        };
    }

    public static async Ready(open: () => Promise<GraphStore>): Promise<GraphStore>
    {
        const g = await open();
        await g.Upgrade(WriteFx.Description());
        return g;
    }

    /** Person 'p'; tickets 'open' and 'closed' (unlinked) and 'linked' (closed, about 'p'). */
    public static SeedLinkFixture(t: GraphTransaction): void
    {
        t.CreateNode('p', WriteFx.Person);
        for (const [id, status] of [['open', WriteFx.Open], ['closed', WriteFx.Closed], ['linked', WriteFx.Closed]] as const)
        {
            t.CreateNode(id, WriteFx.Ticket);
            t.SetProperty(id, WriteFx.Status, status);
        }
        t.Link('linked', WriteFx.About, 'p');
    }

    /** A System commit (the setup path; never gated). */
    public static async Setup(g: GraphStore, build: (t: GraphTransaction) => void): Promise<bigint>
    {
        return WriteFx.Commit(g, AccessScope.System, build);
    }

    public static async Commit(g: GraphStore, scope: AccessScope, build: (t: GraphTransaction) => void): Promise<bigint>
    {
        const t = await g.Begin(scope);
        build(t);
        return t.Commit();
    }

    /** The commit's error (or its commit number when it succeeds). */
    public static async Try(g: GraphStore, scope: AccessScope, build: (t: GraphTransaction) => void): Promise<unknown>
    {
        try
        {
            return await WriteFx.Commit(g, scope, build);
        }
        catch (error)
        {
            return error;
        }
    }

    public static Writes(entries: ReadonlyArray<readonly [string, IWriteRules]>, fallback = AccessDefault.Allow): AccessScope
    {
        return AccessScope.Build({ Default: fallback, Writes: new Map(entries) });
    }

    /** Asserts `result` is an AccessError with `code` whose message names every one of `parts`. */
    public static Denied(result: unknown, code: AccessErrorCode, ...parts: string[]): void
    {
        assert.ok(result instanceof AccessError, 'expected an AccessError, got ' + String(result));
        assert.ok(result instanceof GraphError);
        assert.equal(result.GraphCode, GraphErrorCode.AccessDenied);
        assert.equal(result.Code, code, result.message);
        for (const part of parts)
        {
            assert.ok(result.message.includes(part), 'message "' + result.message + '" names ' + part);
        }
    }

    public static Allowed(result: unknown): void
    {
        assert.equal(typeof result, 'bigint', 'expected a commit, got ' + String(result));
    }

    /** Rows that hide every Person named 'secret' (and any Person with no name: Ne on null is Unknown). */
    public static HideSecret(writes?: ReadonlyMap<string, IWriteRules>): AccessScope
    {
        return AccessScope.Build({ Default: AccessDefault.Allow, Rows: new Map<string, Predicate>([[WriteFx.Person, new Compare(WriteFx.Name, CompareOp.Ne, WriteFx.Secretive)]]), Writes: writes ?? new Map() });
    }

    public static async Value(g: GraphStore, id: string, member: string): Promise<unknown>
    {
        const r = await g.BeginRead(AccessScope.System);
        try
        {
            return await r.GetProperty(id, member);
        }
        finally
        {
            r.dispose();
        }
    }

    public static Register(name: string, open: () => Promise<GraphStore>): void
    {
        describe('write scope on ' + name, () =>
        {
            it('System scope writes everything', async () =>
            {
                const g = await WriteFx.Ready(open);
                WriteFx.Allowed(await WriteFx.Try(g, AccessScope.System, t =>
                {
                    t.CreateNode('p', WriteFx.Person);
                    t.SetProperty('p', WriteFx.Email, 'e');
                    t.SetProperty(WriteFx.SeedTeam, WriteFx.Name, 'n');
                    t.Link(WriteFx.SeedTeam, WriteFx.Member, 'p');
                }));
                assert.equal(AccessScope.System.WritesUnrestricted, true);
                assert.equal(WriteFx.Writes([[WriteFx.Ticket, {}]]).WritesUnrestricted, false);
                await g.dispose();
            });

            it('Create predicates hold on end-of-batch values', async () =>
            {
                const g = await WriteFx.Ready(open);
                const scope = WriteFx.Writes([[WriteFx.Ticket, { Create: new Compare(WriteFx.Status, CompareOp.Eq, WriteFx.Open) }]]);
                WriteFx.Allowed(await WriteFx.Try(g, scope, t =>
                {
                    t.CreateNode('t1', WriteFx.Ticket);
                    t.SetProperty('t1', WriteFx.Status, WriteFx.Closed);
                    t.SetProperty('t1', WriteFx.Status, WriteFx.Open);
                }));
                const closed = await WriteFx.Try(g, scope, t =>
                {
                    t.CreateNode('p', WriteFx.Person);
                    t.CreateNode('t2', WriteFx.Ticket);
                    t.SetProperty('t2', WriteFx.Status, WriteFx.Closed);
                });
                WriteFx.Denied(closed, AccessErrorCode.CreateDenied, 'op 1', 't2', WriteFx.Ticket);
                // Unset is null: the comparison is Unknown, which does not hold.
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.CreateNode('t3', WriteFx.Ticket)), AccessErrorCode.CreateDenied, 'op 0', 't3');
                assert.equal(await WriteFx.Value(g, 'p', WriteFx.Name), undefined, 'the denied batch left nothing');
                await g.dispose();
            });

            it('Create rules on an aspect apply to its carriers', async () =>
            {
                const g = await WriteFx.Ready(open);
                const scope = WriteFx.Writes([[WriteFx.Secret, { Create: new Compare(WriteFx.Level, CompareOp.Le, 1n) }]]);
                WriteFx.Allowed(await WriteFx.Try(g, scope, t =>
                {
                    t.CreateNode('low', WriteFx.Person);
                    t.SetProperty('low', WriteFx.Level, 1n);
                    t.CreateNode('ticket', WriteFx.Ticket);
                }));
                WriteFx.Denied(await WriteFx.Try(g, scope, t =>
                {
                    t.CreateNode('high', WriteFx.Person);
                    t.SetProperty('high', WriteFx.Level, 2n);
                }), AccessErrorCode.CreateDenied, 'high', WriteFx.Person);
                await g.dispose();
            });

            it('a Create predicate that is not node-local denies the create', async () =>
            {
                const g = await WriteFx.Ready(open);
                const scope = WriteFx.Writes([[WriteFx.Ticket, { Create: new Related(WriteFx.About, EdgeDirection.Out, TruePredicate.Instance) }]]);
                WriteFx.Denied(await WriteFx.Try(g, scope, t =>
                {
                    t.CreateNode('p', WriteFx.Person);
                    t.CreateNode('t', WriteFx.Ticket);
                    t.Link('t', WriteFx.About, 'p');
                }), AccessErrorCode.CreateDenied, 'not node-local', 'op 1', 't', WriteFx.Ticket);
                // Only the create is affected: other ticket writes are allowed under Default Allow.
                await WriteFx.Setup(g, t => t.CreateNode('old', WriteFx.Ticket));
                WriteFx.Allowed(await WriteFx.Try(g, scope, t => t.SetProperty('old', WriteFx.Title, 'x')));
                await g.dispose();
            });

            it('Update predicates hold on pre-batch values', async () =>
            {
                const g = await WriteFx.Ready(open);
                await WriteFx.Setup(g, t =>
                {
                    t.CreateNode('p', WriteFx.Person);
                    for (const [id, status] of [['open', WriteFx.Open], ['closed', WriteFx.Closed], ['linked', WriteFx.Closed]] as const)
                    {
                        t.CreateNode(id, WriteFx.Ticket);
                        t.SetProperty(id, WriteFx.Status, status);
                    }
                    t.Link('linked', WriteFx.About, 'p');
                });
                const scope = WriteFx.Writes([[WriteFx.Ticket, { Update: new Compare(WriteFx.Status, CompareOp.Eq, WriteFx.Open) }]]);
                // Closing an open ticket is allowed: the rule reads the snapshot, not the batch (R30).
                WriteFx.Allowed(await WriteFx.Try(g, scope, t =>
                {
                    t.SetProperty('open', WriteFx.Status, WriteFx.Closed);
                    t.SetProperty('open', WriteFx.Title, 'done');
                }));
                assert.equal(await WriteFx.Value(g, 'open', WriteFx.Status), WriteFx.Closed);
                // Reopening a closed one is not.
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.SetProperty('closed', WriteFx.Status, WriteFx.Open)), AccessErrorCode.UpdateDenied, 'op 0', 'closed', WriteFx.Ticket);
                // A link TO a ticket would update its source only; a node created in the batch is exempt.
                WriteFx.Allowed(await WriteFx.Try(g, scope, t =>
                {
                    t.CreateNode('fresh', WriteFx.Ticket);
                    t.SetProperty('fresh', WriteFx.Status, WriteFx.Closed);
                    t.SetProperty('fresh', WriteFx.Title, 'x');
                    t.Link('fresh', WriteFx.About, 'p');
                }));
                await g.dispose();
            });

            it('writes need a visible node and a visible link target', async () =>
            {
                const g = await WriteFx.Ready(open);
                await WriteFx.Setup(g, t =>
                {
                    t.CreateNode('shown', WriteFx.Person);
                    t.SetProperty('shown', WriteFx.Name, 'visible');
                    t.CreateNode('hidden', WriteFx.Person);
                    t.SetProperty('hidden', WriteFx.Name, WriteFx.Secretive);
                    t.CreateNode('t', WriteFx.Ticket);
                    t.CreateNode('u', WriteFx.Ticket);
                    t.Link('u', WriteFx.About, 'hidden');
                });
                const scope = AccessScope.Build({ Default: AccessDefault.Allow, Rows: new Map<string, Predicate>([[WriteFx.Person, new Compare(WriteFx.Name, CompareOp.Ne, WriteFx.Secretive)]]) });
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.Link('t', WriteFx.About, 'hidden')), AccessErrorCode.InvisibleNode, 'op 0', 'hidden');
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.Unlink('u', WriteFx.About, 'hidden')), AccessErrorCode.InvisibleNode, 'hidden');
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.SetProperty('hidden', WriteFx.Status, WriteFx.Open)), AccessErrorCode.InvisibleNode, 'hidden');
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.Link('hidden', WriteFx.Manages, 'shown')), AccessErrorCode.InvisibleNode, 'hidden');
                // A missing node is reported exactly as an invisible one: the gate does not reveal which.
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.SetProperty('nobody', WriteFx.Status, WriteFx.Open)), AccessErrorCode.InvisibleNode, 'nobody');
                WriteFx.Allowed(await WriteFx.Try(g, scope, t =>
                {
                    t.Link('t', WriteFx.About, 'shown');
                    t.CreateNode('new', WriteFx.Person);
                    t.Link('new', WriteFx.Manages, 'shown');
                    t.Link('shown', WriteFx.Manages, 'new');
                }));
                // Under System a missing node stays the committer's UnknownNode.
                assert.ok((await WriteFx.Try(g, AccessScope.System, t => t.SetProperty('nobody', WriteFx.Status, WriteFx.Open))) instanceof CommitError);
                await g.dispose();
            });

            it('Delete needs a visible node and its Delete predicates on pre-batch values', async () =>
            {
                const g = await WriteFx.Ready(open);
                await WriteFx.Setup(g, t =>
                {
                    for (const [id, status] of [['open', WriteFx.Open], ['closed', WriteFx.Closed]] as const)
                    {
                        t.CreateNode(id, WriteFx.Ticket);
                        t.SetProperty(id, WriteFx.Status, status);
                    }
                    t.CreateNode('hidden', WriteFx.Person);
                    t.SetProperty('hidden', WriteFx.Name, WriteFx.Secretive);
                });
                const scope = AccessScope.Build({
                    Default: AccessDefault.Allow,
                    Rows: new Map<string, Predicate>([[WriteFx.Person, new Compare(WriteFx.Name, CompareOp.Ne, WriteFx.Secretive)]]),
                    Writes: new Map([[WriteFx.Ticket, { Delete: new Compare(WriteFx.Status, CompareOp.Eq, WriteFx.Closed) }]]),
                });
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.DeleteNode('open')), AccessErrorCode.DeleteDenied, 'op 0', 'open', WriteFx.Ticket);
                // Closing in the same batch does not help: the rule reads the snapshot.
                WriteFx.Denied(await WriteFx.Try(g, scope, t =>
                {
                    t.SetProperty('open', WriteFx.Status, WriteFx.Closed);
                    t.DeleteNode('open');
                }), AccessErrorCode.DeleteDenied, 'op 1', 'open');
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.DeleteNode('hidden')), AccessErrorCode.InvisibleNode, 'hidden');
                WriteFx.Allowed(await WriteFx.Try(g, scope, t =>
                {
                    t.DeleteNode('closed');
                    t.CreateNode('temp', WriteFx.Ticket);
                    t.DeleteNode('temp');
                }));
                assert.equal(await WriteFx.Value(g, 'closed', WriteFx.Status), undefined);
                await g.dispose();
            });

            it('writing a hidden member is denied', async () =>
            {
                const g = await WriteFx.Ready(open);
                await WriteFx.Setup(g, t =>
                {
                    t.CreateNode('p', WriteFx.Person);
                    t.CreateNode('q', WriteFx.Person);
                });
                const scope = AccessScope.Build({ Default: AccessDefault.Allow, Hidden: new Map([[WriteFx.Secret, new Set([WriteFx.Level])], [WriteFx.Person, new Set([WriteFx.Email, WriteFx.Manages])]]) });
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.SetProperty('p', WriteFx.Email, 'e')), AccessErrorCode.HiddenMember, 'op 0', 'p', WriteFx.Person, WriteFx.Email);
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.SetProperty('p', WriteFx.Level, 1n)), AccessErrorCode.HiddenMember, WriteFx.Level);
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.Link('p', WriteFx.Manages, 'q')), AccessErrorCode.HiddenMember, WriteFx.Manages);
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.Unlink('p', WriteFx.Manages, 'q')), AccessErrorCode.HiddenMember, WriteFx.Manages);
                WriteFx.Denied(await WriteFx.Try(g, scope, t =>
                {
                    t.CreateNode('n', WriteFx.Person);
                    t.SetProperty('n', WriteFx.Email, 'e');
                }), AccessErrorCode.HiddenMember, 'op 1', 'n');
                WriteFx.Allowed(await WriteFx.Try(g, scope, t => t.SetProperty('p', WriteFx.Name, 'x')));
                await g.dispose();
            });

            it('missing write rules allow only under Default Allow', async () =>
            {
                const g = await WriteFx.Ready(open);
                await WriteFx.Setup(g, t => t.CreateNode('t', WriteFx.Ticket));
                const rows = new Map<string, Predicate>([[WriteFx.Ticket, TruePredicate.Instance]]);
                const deny = AccessScope.Build({ Default: AccessDefault.Deny, Rows: rows });
                WriteFx.Denied(await WriteFx.Try(g, deny, t => t.CreateNode('n', WriteFx.Ticket)), AccessErrorCode.CreateDenied, 'n');
                WriteFx.Denied(await WriteFx.Try(g, deny, t => t.SetProperty('t', WriteFx.Title, 'x')), AccessErrorCode.UpdateDenied, 't');
                WriteFx.Denied(await WriteFx.Try(g, deny, t => t.DeleteNode('t')), AccessErrorCode.DeleteDenied, 't');
                // Rules are per operation: an Update rule grants updates only.
                const updates = AccessScope.Build({ Default: AccessDefault.Deny, Rows: rows, Writes: new Map([[WriteFx.Ticket, { Update: TruePredicate.Instance }]]) });
                WriteFx.Allowed(await WriteFx.Try(g, updates, t => t.SetProperty('t', WriteFx.Title, 'x')));
                WriteFx.Denied(await WriteFx.Try(g, updates, t => t.DeleteNode('t')), AccessErrorCode.DeleteDenied, 't');
                // Default Allow with no rules: everything visible is writable.
                WriteFx.Allowed(await WriteFx.Try(g, AccessScope.Build({ Default: AccessDefault.Allow, Rows: rows }), t =>
                {
                    t.CreateNode('n', WriteFx.Ticket);
                    t.DeleteNode('t');
                }));
                await g.dispose();
            });

            it('an Update rule alone no longer governs links', async () =>
            {
                const g = await WriteFx.Ready(open);
                await WriteFx.Setup(g, t => WriteFx.SeedLinkFixture(t));
                const scope = WriteFx.Writes([[WriteFx.Ticket, { Update: new Compare(WriteFx.Status, CompareOp.Eq, WriteFx.Open) }]]);
                WriteFx.Allowed(await WriteFx.Try(g, scope, t => t.Link('closed', WriteFx.About, 'p')));
                WriteFx.Allowed(await WriteFx.Try(g, scope, t => t.Unlink('linked', WriteFx.About, 'p')));
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.SetProperty('closed', WriteFx.Status, WriteFx.Open)), AccessErrorCode.UpdateDenied, 'closed');
                await g.dispose();
            });

            it('Link and Unlink are governed by the source Append rule', async () =>
            {
                const g = await WriteFx.Ready(open);
                await WriteFx.Setup(g, t => WriteFx.SeedLinkFixture(t));
                const scope = WriteFx.Writes([[WriteFx.Ticket, { Append: new Compare(WriteFx.Status, CompareOp.Eq, WriteFx.Open) }]]);
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.Link('closed', WriteFx.About, 'p')), AccessErrorCode.AppendDenied, 'closed', WriteFx.Ticket);
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.Unlink('linked', WriteFx.About, 'p')), AccessErrorCode.AppendDenied, 'linked', WriteFx.Ticket);
                WriteFx.Allowed(await WriteFx.Try(g, scope, t => t.Link('open', WriteFx.About, 'p')));
                await g.dispose();
            });

            it('Link and Unlink need the target AppendTo rule', async () =>
            {
                const g = await WriteFx.Ready(open);
                await WriteFx.Setup(g, t =>
                {
                    WriteFx.SeedLinkFixture(t);
                    t.CreateNode('good', WriteFx.Person);
                    t.SetProperty('good', WriteFx.Name, WriteFx.Ok);
                    t.CreateNode('t', WriteFx.Ticket);
                });
                const scope = WriteFx.Writes([[WriteFx.Person, { AppendTo: new Compare(WriteFx.Name, CompareOp.Eq, WriteFx.Ok) }]]);
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.Link('t', WriteFx.About, 'p')), AccessErrorCode.AppendToDenied, 'op 0', 't');
                WriteFx.Allowed(await WriteFx.Try(g, scope, t => t.Link('t', WriteFx.About, 'good')));
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.Unlink('linked', WriteFx.About, 'p')), AccessErrorCode.AppendToDenied, 'linked');
                // Visibility is reported first: an invisible sibling beats a target failing AppendTo.
                await WriteFx.Setup(g, t =>
                {
                    t.SetProperty('p', WriteFx.Name, 'x');
                    t.CreateNode('hidden', WriteFx.Person);
                    t.SetProperty('hidden', WriteFx.Name, WriteFx.Secretive);
                    t.CreateNode('team', WriteFx.Team);
                });
                const hiding = WriteFx.HideSecret(new Map([[WriteFx.Person, { AppendTo: new Compare(WriteFx.Name, CompareOp.Eq, WriteFx.Ok) }]]));
                WriteFx.Denied(await WriteFx.Try(g, hiding, t => t.Link('team', WriteFx.Member, 'p', { AfterSibling: 'hidden' })), AccessErrorCode.InvisibleNode, 'hidden');
                await g.dispose();
            });

            it('a node the batch created is exempt from Append and AppendTo', async () =>
            {
                const g = await WriteFx.Ready(open);
                const rules = { Create: TruePredicate.Instance, Append: FalsePredicate.Instance, AppendTo: FalsePredicate.Instance };
                const rows = new Map<string, Predicate>([[WriteFx.Ticket, TruePredicate.Instance], [WriteFx.Person, TruePredicate.Instance]]);
                const scope = AccessScope.Build({ Default: AccessDefault.Deny, Rows: rows, Writes: new Map([[WriteFx.Ticket, rules], [WriteFx.Person, rules]]) });
                WriteFx.Allowed(await WriteFx.Try(g, scope, t =>
                {
                    t.CreateNode('p', WriteFx.Person);
                    t.CreateNode('t', WriteFx.Ticket);
                    t.Link('t', WriteFx.About, 'p');
                }));
                await g.dispose();
            });

            it('delete-implied unlinks ignore Append and AppendTo', async () =>
            {
                const g = await WriteFx.Ready(open);
                await WriteFx.Setup(g, t => WriteFx.SeedLinkFixture(t));
                const scope = WriteFx.Writes([[WriteFx.Ticket, { Append: FalsePredicate.Instance }], [WriteFx.Person, { AppendTo: FalsePredicate.Instance, Delete: TruePredicate.Instance }]]);
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.Unlink('linked', WriteFx.About, 'p')), AccessErrorCode.AppendDenied, 'linked');
                WriteFx.Allowed(await WriteFx.Try(g, scope, t =>
                {
                    t.DetachUnlink('linked', WriteFx.About, 'p');
                    t.DeleteNode('p');
                }));
                await g.dispose();
            });

            it('Append and AppendTo predicates are validated at Begin', async () =>
            {
                const g = await WriteFx.Ready(open);
                const bad = new Compare('nosuch', CompareOp.Eq, 'x');
                for (const rules of [{ Append: bad }, { AppendTo: bad }])
                {
                    await assert.rejects(g.Begin(WriteFx.Writes([[WriteFx.Ticket, rules]])), (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument && e.message.includes('Ticket.nosuch'));
                }
                await g.dispose();
            });

            it('Append and AppendTo decisions are reads (stale permission conflicts)', async () =>
            {
                const g = await WriteFx.Ready(open);
                await WriteFx.Setup(g, t =>
                {
                    t.CreateNode('p', WriteFx.Person);
                    t.SetProperty('p', WriteFx.Name, WriteFx.Ok);
                    t.CreateNode('t', WriteFx.Ticket);
                });
                const scope = WriteFx.Writes([[WriteFx.Person, { AppendTo: new Compare(WriteFx.Name, CompareOp.Eq, WriteFx.Ok) }]]);
                const t1 = await g.Begin(scope);
                t1.Link('t', WriteFx.About, 'p');
                await WriteFx.Setup(g, t => t.SetProperty('p', WriteFx.Name, 'other'));
                await assert.rejects(t1.Commit(), (e: unknown) => e instanceof ConflictError);
                await g.dispose();
            });

            it('seeded nodes read-only via Not(Seeded())', async () =>
            {
                const g = await WriteFx.Ready(open);
                await WriteFx.Setup(g, t =>
                {
                    t.CreateNode('runtime', WriteFx.Team);
                    t.CreateNode('p', WriteFx.Person);
                });
                const readOnlySeed = new Not(new Seeded());
                const scope = WriteFx.Writes([[WriteFx.Team, { Update: readOnlySeed, Append: readOnlySeed, Delete: readOnlySeed }]]);
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.SetProperty(WriteFx.SeedTeam, WriteFx.Name, 'x')), AccessErrorCode.UpdateDenied, WriteFx.SeedTeam, WriteFx.Team);
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.Link(WriteFx.SeedTeam, WriteFx.Member, 'p')), AccessErrorCode.AppendDenied, WriteFx.SeedTeam);
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.DeleteNode(WriteFx.SeedTeam)), AccessErrorCode.DeleteDenied, WriteFx.SeedTeam);
                WriteFx.Allowed(await WriteFx.Try(g, scope, t =>
                {
                    t.SetProperty('runtime', WriteFx.Name, 'x');
                    t.Link('runtime', WriteFx.Member, 'p');
                }));
                WriteFx.Allowed(await WriteFx.Try(g, scope, t => t.DeleteNode('runtime')));
                await g.dispose();
            });

            it('the gate reads are recorded (stale permission conflicts)', async () =>
            {
                const g = await WriteFx.Ready(open);
                await WriteFx.Setup(g, t =>
                {
                    t.CreateNode('t', WriteFx.Ticket);
                    t.SetProperty('t', WriteFx.Status, WriteFx.Open);
                });
                const scope = WriteFx.Writes([[WriteFx.Ticket, { Update: new Compare(WriteFx.Status, CompareOp.Eq, WriteFx.Open) }]]);
                const t1 = await g.Begin(scope);
                t1.SetProperty('t', WriteFx.Title, 'x');
                // The ticket is closed after t1's snapshot: t1's permission was granted on a stale value.
                await WriteFx.Setup(g, t => t.SetProperty('t', WriteFx.Status, WriteFx.Closed));
                await assert.rejects(t1.Commit(), (e: unknown) => e instanceof ConflictError);
                // Control: the same flow under System reads no status cell and commits.
                await WriteFx.Setup(g, t => t.SetProperty('t', WriteFx.Status, WriteFx.Open));
                const t2 = await g.Begin(AccessScope.System);
                t2.SetProperty('t', WriteFx.Title, 'y');
                await WriteFx.Setup(g, t => t.SetProperty('t', WriteFx.Status, WriteFx.Closed));
                assert.equal(typeof (await t2.Commit()), 'bigint');
                await g.dispose();
            });

            it('denied commit leaves graph unchanged and raises no CommitApplied', async () =>
            {
                const g = await WriteFx.Ready(open);
                const before = await WriteFx.Setup(g, t => t.CreateNode('t', WriteFx.Ticket));
                const seen: ICommitApplied[] = [];
                g.CommitApplied.Subscribe(c => seen.push(c));
                const scope = WriteFx.Writes([[WriteFx.Ticket, { Update: new Compare(WriteFx.Status, CompareOp.Eq, WriteFx.Open) }]]);
                const t1 = await g.Begin(scope);
                t1.CreateNode('p', WriteFx.Person);
                t1.SetProperty('p', WriteFx.Name, 'n');
                t1.SetProperty('t', WriteFx.Title, 'x');
                const denied = await t1.Commit().then(() => undefined, (e: unknown) => e);
                WriteFx.Denied(denied, AccessErrorCode.UpdateDenied, 'op 2', 't', WriteFx.Ticket);
                assert.deepEqual(seen, []);
                assert.equal(await WriteFx.Value(g, 'p', WriteFx.Name), undefined);
                assert.equal(await WriteFx.Value(g, 't', WriteFx.Title), null);
                // The transaction ended; the next commit takes the very next number.
                await assert.rejects(t1.Commit(), (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.Disposed);
                assert.equal(await WriteFx.Setup(g, t => t.CreateNode('q', WriteFx.Person)), before + 1n);
                assert.equal(seen.length, 1);
                await g.dispose();
            });

            it('Link siblings must be visible', async () =>
            {
                const g = await WriteFx.Ready(open);
                await WriteFx.Setup(g, t =>
                {
                    t.CreateNode('team', WriteFx.Team);
                    for (const [id, name] of [['shown', 'visible'], ['hidden', WriteFx.Secretive], ['outsider', WriteFx.Secretive]] as const)
                    {
                        t.CreateNode(id, WriteFx.Person);
                        t.SetProperty(id, WriteFx.Name, name);
                    }
                    t.Link('team', WriteFx.Member, 'shown');
                    t.Link('team', WriteFx.Member, 'hidden');
                    t.CreateNode('extra', WriteFx.Person);
                    t.SetProperty('extra', WriteFx.Name, 'visible');
                });
                const scope = WriteFx.HideSecret();
                // An invisible sibling that is a target, and one that is not: both read as invisible.
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.Link('team', WriteFx.Member, 'extra', { AfterSibling: 'hidden' })), AccessErrorCode.InvisibleNode, 'op 0', 'team', WriteFx.Team, 'hidden');
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.Link('team', WriteFx.Member, 'extra', { BeforeSibling: 'outsider' })), AccessErrorCode.InvisibleNode, 'outsider');
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.Link('team', WriteFx.Member, 'extra', { BeforeSibling: 'nobody' })), AccessErrorCode.InvisibleNode, 'nobody');
                // Under System the committer still tells them apart.
                assert.ok((await WriteFx.Try(g, AccessScope.System, t => t.Link('team', WriteFx.Member, 'extra', { BeforeSibling: 'outsider' }))) instanceof CommitError);
                WriteFx.Allowed(await WriteFx.Try(g, scope, t =>
                {
                    t.Link('team', WriteFx.Member, 'extra', { BeforeSibling: 'shown' });
                    t.CreateNode('fresh', WriteFx.Person);
                    t.Link('team', WriteFx.Member, 'fresh');
                    t.CreateNode('fresher', WriteFx.Person);
                    t.Link('team', WriteFx.Member, 'fresher', { AfterSibling: 'fresh' });
                }));
                await g.dispose();
            });

            it('Create rules see the op owner and Seeded as false', async () =>
            {
                const g = await WriteFx.Ready(open);
                const owned = WriteFx.Writes([[WriteFx.Team, { Create: new OwnerIs(new Set(['m1'])) }]]);
                WriteFx.Allowed(await WriteFx.Try(g, owned, t => t.CreateNode('mine', WriteFx.Team, { Owner: 'm1' })));
                WriteFx.Denied(await WriteFx.Try(g, owned, t => t.CreateNode('theirs', WriteFx.Team, { Owner: 'm2' })), AccessErrorCode.CreateDenied, 'theirs', WriteFx.Team);
                WriteFx.Denied(await WriteFx.Try(g, owned, t => t.CreateNode('none', WriteFx.Team)), AccessErrorCode.CreateDenied, 'none');
                const unowned = WriteFx.Writes([[WriteFx.Team, { Create: new OwnerIs(new Set([''])) }]]);
                WriteFx.Allowed(await WriteFx.Try(g, unowned, t => t.CreateNode('none', WriteFx.Team)));
                WriteFx.Denied(await WriteFx.Try(g, WriteFx.Writes([[WriteFx.Team, { Create: new Seeded() }]]), t => t.CreateNode('s1', WriteFx.Team)), AccessErrorCode.CreateDenied, 's1');
                WriteFx.Allowed(await WriteFx.Try(g, WriteFx.Writes([[WriteFx.Team, { Create: new And([new Not(new Seeded()), new OwnerIs(new Set(['m1']))]) }]]), t => t.CreateNode('s2', WriteFx.Team, { Owner: 'm1' })));
                // Reachable (like Related) needs the graph: not node-local.
                const reach = WriteFx.Writes([[WriteFx.Team, { Create: new Not(new Reachable(new Set(['x']), [{ Relationship: WriteFx.Member, Direction: EdgeDirection.Out }], 1)) }]]);
                WriteFx.Denied(await WriteFx.Try(g, reach, t => t.CreateNode('r', WriteFx.Team)), AccessErrorCode.CreateDenied, 'not node-local');
                await g.dispose();
            });

            it('Update and Delete rules keyed on an aspect apply to carriers', async () =>
            {
                const g = await WriteFx.Ready(open);
                await WriteFx.Setup(g, t =>
                {
                    for (const [id, level] of [['low', 1n], ['high', 2n]] as const)
                    {
                        t.CreateNode(id, WriteFx.Person);
                        t.SetProperty(id, WriteFx.Level, level);
                    }
                });
                const rule = new Compare(WriteFx.Level, CompareOp.Le, 1n);
                const scope = WriteFx.Writes([[WriteFx.Secret, { Update: rule, Delete: rule }]]);
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.SetProperty('high', WriteFx.Name, 'x')), AccessErrorCode.UpdateDenied, 'high', WriteFx.Person);
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.DeleteNode('high')), AccessErrorCode.DeleteDenied, 'high');
                WriteFx.Allowed(await WriteFx.Try(g, scope, t => t.SetProperty('low', WriteFx.Name, 'x')));
                WriteFx.Allowed(await WriteFx.Try(g, scope, t => t.DeleteNode('low')));
                await g.dispose();
            });

            it('concept and aspect rules must both hold', async () =>
            {
                const g = await WriteFx.Ready(open);
                await WriteFx.Setup(g, t =>
                {
                    for (const [id, name, level] of [['both', 'ok', 1n], ['aspectFails', 'ok', 2n], ['conceptFails', 'no', 1n]] as const)
                    {
                        t.CreateNode(id, WriteFx.Person);
                        t.SetProperty(id, WriteFx.Name, name);
                        t.SetProperty(id, WriteFx.Level, level);
                    }
                });
                const scope = WriteFx.Writes([
                    [WriteFx.Person, { Update: new Compare(WriteFx.Name, CompareOp.Eq, 'ok') }],
                    [WriteFx.Secret, { Update: new Compare(WriteFx.Level, CompareOp.Le, 1n) }],
                ]);
                WriteFx.Allowed(await WriteFx.Try(g, scope, t => t.SetProperty('both', WriteFx.Status, WriteFx.Open)));
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.SetProperty('aspectFails', WriteFx.Status, WriteFx.Open)), AccessErrorCode.UpdateDenied, 'aspectFails');
                WriteFx.Denied(await WriteFx.Try(g, scope, t => t.SetProperty('conceptFails', WriteFx.Status, WriteFx.Open)), AccessErrorCode.UpdateDenied, 'conceptFails');
                await g.dispose();
            });

            it('stale visibility conflicts in both directions', async () =>
            {
                const g = await WriteFx.Ready(open);
                await WriteFx.Setup(g, t =>
                {
                    t.CreateNode('shown', WriteFx.Person);
                    t.SetProperty('shown', WriteFx.Name, 'visible');
                    t.CreateNode('hidden', WriteFx.Person);
                    t.SetProperty('hidden', WriteFx.Name, WriteFx.Secretive);
                });
                const scope = WriteFx.HideSecret();
                // Visible at the snapshot, hidden by a later commit: the gate allowed it, Submit conflicts.
                const t1 = await g.Begin(scope);
                t1.SetProperty('shown', WriteFx.Status, WriteFx.Open);
                await WriteFx.Setup(g, t => t.SetProperty('shown', WriteFx.Name, WriteFx.Secretive));
                await assert.rejects(t1.Commit(), (e: unknown) => e instanceof ConflictError);
                // Hidden at the snapshot, shown by a later commit: the denial was stale, so it is a conflict.
                const t2 = await g.Begin(scope);
                t2.SetProperty('hidden', WriteFx.Status, WriteFx.Open);
                await WriteFx.Setup(g, t => t.SetProperty('hidden', WriteFx.Name, 'visible'));
                await assert.rejects(t2.Commit(), (e: unknown) => e instanceof ConflictError);
                // Unchanged reads keep the denial.
                const t3 = await g.Begin(scope);
                t3.SetProperty('shown', WriteFx.Status, WriteFx.Open);
                await WriteFx.Setup(g, t => t.CreateNode('unrelated', WriteFx.Ticket));
                WriteFx.Denied(await t3.Commit().then(() => undefined, (e: unknown) => e), AccessErrorCode.InvisibleNode, 'shown');
                await g.dispose();
            });

            it('a missing id that appears concurrently conflicts', async () =>
            {
                const g = await WriteFx.Ready(open);
                const scope = WriteFx.HideSecret();
                const t1 = await g.Begin(scope);
                t1.SetProperty('ghost', WriteFx.Status, WriteFx.Open);
                await WriteFx.Setup(g, t =>
                {
                    t.CreateNode('ghost', WriteFx.Person);
                    t.SetProperty('ghost', WriteFx.Name, 'visible');
                });
                await assert.rejects(t1.Commit(), (e: unknown) => e instanceof ConflictError);
                await g.dispose();
            });

            it('delete-then-recreate and create-delete-reuse orderings', async () =>
            {
                const g = await WriteFx.Ready(open);
                await WriteFx.Setup(g, t =>
                {
                    t.CreateNode('x', WriteFx.Ticket);
                    t.SetProperty('x', WriteFx.Status, WriteFx.Closed);
                });
                const isOpen = new Compare(WriteFx.Status, CompareOp.Eq, WriteFx.Open);
                const scope = WriteFx.Writes([[WriteFx.Ticket, { Create: isOpen, Update: isOpen, Delete: TruePredicate.Instance }]]);
                // Re-created after its delete: the new node is exempt from Update and judged by Create.
                WriteFx.Denied(await WriteFx.Try(g, scope, t =>
                {
                    t.DeleteNode('x');
                    t.CreateNode('x', WriteFx.Ticket);
                    t.SetProperty('x', WriteFx.Status, WriteFx.Closed);
                }), AccessErrorCode.CreateDenied, 'op 1', 'x');
                WriteFx.Allowed(await WriteFx.Try(g, scope, t =>
                {
                    t.DeleteNode('x');
                    t.CreateNode('x', WriteFx.Ticket);
                    t.SetProperty('x', WriteFx.Status, WriteFx.Open);
                    t.SetProperty('x', WriteFx.Title, 'again');
                }));
                assert.equal(await WriteFx.Value(g, 'x', WriteFx.Title), 'again');
                // Each creation of a reused id is judged on its own values only.
                WriteFx.Denied(await WriteFx.Try(g, scope, t =>
                {
                    t.CreateNode('y', WriteFx.Ticket);
                    t.SetProperty('y', WriteFx.Status, WriteFx.Open);
                    t.DeleteNode('y');
                    t.CreateNode('y', WriteFx.Ticket);
                }), AccessErrorCode.CreateDenied, 'op 3', 'y');
                WriteFx.Denied(await WriteFx.Try(g, scope, t =>
                {
                    t.CreateNode('y', WriteFx.Ticket);
                    t.SetProperty('y', WriteFx.Status, WriteFx.Closed);
                    t.DeleteNode('y');
                    t.CreateNode('y', WriteFx.Ticket);
                    t.SetProperty('y', WriteFx.Status, WriteFx.Open);
                }), AccessErrorCode.CreateDenied, 'op 0', 'y');
                await g.dispose();
            });

            it('CreateNode of an unknown concept is left to the committer', async () =>
            {
                const g = await WriteFx.Ready(open);
                const scope = AccessScope.Build({ Default: AccessDefault.Deny, Writes: new Map([[WriteFx.Ticket, { Create: FalsePredicate.Instance }]]) });
                const unknown = await WriteFx.Try(g, scope, t =>
                {
                    t.CreateNode('u', 'Nonexistent');
                    t.SetProperty('u', WriteFx.Name, 'x');
                });
                assert.ok(unknown instanceof CommitError, 'expected a CommitError, got ' + String(unknown));
                assert.ok((await WriteFx.Try(g, scope, t => t.CreateNode('a', WriteFx.Secret))) instanceof CommitError);
                await g.dispose();
            });
        });
    }
}

describe('AccessError', () =>
{
    it('carries AccessDenied and its own code', () =>
    {
        const e = new AccessError(AccessErrorCode.HiddenMember, 'm');
        assert.equal(GraphErrorCode.AccessDenied, 12);
        assert.equal(e.GraphCode, GraphErrorCode.AccessDenied);
        assert.equal(e.Code, AccessErrorCode.HiddenMember);
        assert.equal(AccessErrorCode.CreateDenied, 1);
        assert.equal(AccessErrorCode.InvisibleNode, 5);
        assert.equal(e.name, 'AccessError');
    });
});

WriteFx.Register('memory', () => GraphStore.OpenMemory());
WriteFx.Register('lmdb', () => GraphStore.OpenLmdb(WriteFx.Dir()));

after(() => WriteFx.RemoveDirs());
