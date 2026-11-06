import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemberInput } from '../../catalog/CatalogTypes.js';
import { MemberKind, ValueType } from '../../catalog/ValueType.js';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';
import { EdgeDirection } from '../../format/FormatKeys.js';
import type { GraphReader } from '../../GraphReader.js';
import { GraphStore } from '../../GraphStore.js';
import type { GraphTransaction } from '../../GraphTransaction.js';
import { And, Compare, CompareOp, FalsePredicate, IdIn, In, IsNull, Not, Or, OwnerIs, type Predicate, Reachable, Related, Seeded, TruePredicate } from '../../predicate/Predicate.js';
import type { ISchemaDescription } from '../../schema/SchemaDescription.js';
import { ConflictError } from '../../txn/ConflictError.js';
import { AccessDefault, AccessScope } from '../AccessScope.js';
import { ScopeEvaluator } from '../ScopeEvaluator.js';

/**
 * Schema and helpers for the read-scope tests. Aspect Secret { level }; Person (carries Secret)
 * { name, status, email, manages -> Person* }; Manager extends Person; Team { name, member -> Person* };
 * Ticket { status, title, about -> Person }. Indexes: ticketByStatus on Ticket(status), personByEmail
 * on Person(email). Seed: one Team 'seedTeam'.
 */
class ScopeFx
{
    private static readonly DirPrefix = 'pragmatic-graph-scope-';
    private static readonly Dirs: string[] = [];
    public static readonly Secret = 'Secret';
    public static readonly Person = 'Person';
    public static readonly Manager = 'Manager';
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
    public static readonly TicketByStatus = 'ticketByStatus';
    public static readonly PersonByEmail = 'personByEmail';
    public static readonly SeedTeam = 'seedTeam';

    public static Dir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), ScopeFx.DirPrefix));
        ScopeFx.Dirs.push(dir);
        return dir;
    }

    public static RemoveDirs(): void
    {
        for (const d of ScopeFx.Dirs)
        {
            rmSync(d, { recursive: true, force: true });
        }
    }

    public static Prop(name: string, type: ValueType): MemberInput
    {
        return { Name: name, Kind: MemberKind.Property, Type: type, Nullable: true };
    }

    public static Rel(name: string, target: string, many: boolean): MemberInput
    {
        return { Name: name, Kind: MemberKind.Relationship, Targets: [target], Many: many };
    }

    public static Description(): ISchemaDescription
    {
        return {
            Version: 'v1',
            Definitions: [
                { Name: ScopeFx.Secret, IsAspect: true, Parent: null, Aspects: [], Members: [ScopeFx.Prop(ScopeFx.Level, ValueType.Int64)] },
                {
                    Name: ScopeFx.Person, IsAspect: false, Parent: null, Aspects: [ScopeFx.Secret], Members: [
                        ScopeFx.Prop(ScopeFx.Name, ValueType.String),
                        ScopeFx.Prop(ScopeFx.Status, ValueType.String),
                        ScopeFx.Prop(ScopeFx.Email, ValueType.String),
                        ScopeFx.Rel(ScopeFx.Manages, ScopeFx.Person, true),
                    ],
                },
                { Name: ScopeFx.Manager, IsAspect: false, Parent: ScopeFx.Person, Aspects: [], Members: [] },
                { Name: ScopeFx.Team, IsAspect: false, Parent: null, Aspects: [], Members: [ScopeFx.Prop(ScopeFx.Name, ValueType.String), ScopeFx.Rel(ScopeFx.Member, ScopeFx.Person, true)] },
                {
                    Name: ScopeFx.Ticket, IsAspect: false, Parent: null, Aspects: [], Members: [
                        ScopeFx.Prop(ScopeFx.Status, ValueType.String),
                        ScopeFx.Prop(ScopeFx.Title, ValueType.String),
                        ScopeFx.Rel(ScopeFx.About, ScopeFx.Person, false),
                    ],
                },
            ],
            Indexes: [
                { Name: ScopeFx.TicketByStatus, On: ScopeFx.Ticket, Members: [ScopeFx.Status] },
                { Name: ScopeFx.PersonByEmail, On: ScopeFx.Person, Members: [ScopeFx.Email] },
            ],
            Seed: [{ PublicId: ScopeFx.SeedTeam, Concept: ScopeFx.Team, Owner: '', Properties: {}, Links: [] }],
            Bindings: [],
        };
    }

    public static async Ready(open: () => Promise<GraphStore>): Promise<GraphStore>
    {
        const g = await open();
        await g.Upgrade(ScopeFx.Description());
        return g;
    }

    public static async Commit(g: GraphStore, build: (t: GraphTransaction) => void): Promise<bigint>
    {
        const t = await g.Begin(AccessScope.System);
        build(t);
        return t.Commit();
    }

    public static async Read<T>(g: GraphStore, scope: AccessScope, work: (r: GraphReader) => Promise<T>): Promise<T>
    {
        const r = await g.BeginRead(scope);
        try
        {
            return await work(r);
        }
        finally
        {
            r.dispose();
        }
    }

    public static async Collect<T>(rows: AsyncIterable<T>): Promise<T[]>
    {
        const out: T[] = [];
        for await (const row of rows)
        {
            out.push(row);
        }
        return out;
    }

    public static async Ids(r: GraphReader, name: string): Promise<string[]>
    {
        return (await ScopeFx.Collect(r.ScanNodes(name))).sort();
    }

    public static async ScanIds(r: GraphReader, name: string, member: string): Promise<string[]>
    {
        return (await ScopeFx.Collect(r.ScanConcept(name, member))).map(row => row.PublicId).sort();
    }

    public static async Visible(r: GraphReader, ids: readonly string[]): Promise<string[]>
    {
        const out: string[] = [];
        for (const id of ids)
        {
            if ((await r.ConceptOf(id)) !== undefined)
            {
                out.push(id);
            }
        }
        return out;
    }

    public static Rows(entries: ReadonlyArray<readonly [string, Predicate]>, fallback = AccessDefault.Allow): AccessScope
    {
        return AccessScope.Build({ Default: fallback, Rows: new Map(entries) });
    }

    public static async Settle(work: Promise<unknown>): Promise<unknown>
    {
        try
        {
            return await work;
        }
        catch (error)
        {
            return error;
        }
    }

    public static Register(name: string, open: () => Promise<GraphStore>): void
    {
        describe('read scope on ' + name, () =>
        {
            it('System sees everything', async () =>
            {
                const g = await ScopeFx.Ready(open);
                await ScopeFx.Commit(g, t =>
                {
                    t.CreateNode('p1', ScopeFx.Person);
                    t.SetProperty('p1', ScopeFx.Level, 9n);
                    t.CreateNode('t1', ScopeFx.Ticket);
                    t.Link('t1', ScopeFx.About, 'p1');
                });
                await ScopeFx.Read(g, AccessScope.System, async r =>
                {
                    assert.equal(r.Scope, AccessScope.System);
                    assert.equal(await r.GetProperty('p1', ScopeFx.Level), 9n);
                    assert.deepEqual(await r.Neighbors('p1', ScopeFx.About, EdgeDirection.In), ['t1']);
                    assert.equal(await r.IsSeeded(ScopeFx.SeedTeam), true);
                });
                assert.equal(AccessScope.System.Default, AccessDefault.Allow);
                await g.dispose();
            });

            it('Deny default hides unlisted concepts', async () =>
            {
                const g = await ScopeFx.Ready(open);
                await ScopeFx.Commit(g, t =>
                {
                    t.CreateNode('p1', ScopeFx.Person);
                    t.CreateNode('m1', ScopeFx.Manager);
                    t.CreateNode('t1', ScopeFx.Ticket);
                });
                const scope = ScopeFx.Rows([[ScopeFx.Person, TruePredicate.Instance]], AccessDefault.Deny);
                assert.equal(scope.Default, AccessDefault.Deny);
                await ScopeFx.Read(g, scope, async r =>
                {
                    assert.deepEqual(await ScopeFx.Visible(r, ['p1', 'm1', 't1', ScopeFx.SeedTeam]), ['p1', 'm1'], 'an entry on an ancestor applies');
                    assert.deepEqual(await ScopeFx.Ids(r, ScopeFx.Ticket), []);
                    assert.equal(await r.EstimateCount(ScopeFx.Ticket), 1, 'EstimateCount stays an unscoped upper bound');
                });
                await g.dispose();
            });

            it('row predicate on aspect applies to carriers', async () =>
            {
                const g = await ScopeFx.Ready(open);
                await ScopeFx.Commit(g, t =>
                {
                    t.CreateNode('low', ScopeFx.Person);
                    t.SetProperty('low', ScopeFx.Level, 1n);
                    t.CreateNode('high', ScopeFx.Manager);
                    t.SetProperty('high', ScopeFx.Level, 2n);
                    t.CreateNode('unset', ScopeFx.Person);
                    t.CreateNode('team', ScopeFx.Team);
                });
                const scope = ScopeFx.Rows([[ScopeFx.Secret, new Compare(ScopeFx.Level, CompareOp.Le, 1n)]]);
                await ScopeFx.Read(g, scope, async r =>
                {
                    assert.deepEqual(await ScopeFx.Visible(r, ['low', 'high', 'unset', 'team']), ['low', 'team'], 'a null level is Unknown, so not visible');
                    assert.deepEqual(await ScopeFx.Ids(r, ScopeFx.Secret), ['low']);
                });
                await g.dispose();
            });

            it('concept and aspect predicates AND together', async () =>
            {
                const g = await ScopeFx.Ready(open);
                await ScopeFx.Commit(g, t =>
                {
                    for (const [id, status, level] of [['a', ScopeFx.Open, 1n], ['b', ScopeFx.Open, 2n], ['c', ScopeFx.Closed, 1n]] as const)
                    {
                        t.CreateNode(id, ScopeFx.Person);
                        t.SetProperty(id, ScopeFx.Status, status);
                        t.SetProperty(id, ScopeFx.Level, level);
                    }
                });
                const scope = ScopeFx.Rows([
                    [ScopeFx.Person, new Compare(ScopeFx.Status, CompareOp.Eq, ScopeFx.Open)],
                    [ScopeFx.Secret, new Compare(ScopeFx.Level, CompareOp.Le, 1n)],
                ]);
                await ScopeFx.Read(g, scope, async r => assert.deepEqual(await ScopeFx.Ids(r, ScopeFx.Person), ['a']));
                await g.dispose();
            });

            it('invisible node looks missing everywhere', async () =>
            {
                const g = await ScopeFx.Ready(open);
                await ScopeFx.Commit(g, t =>
                {
                    t.CreateNode('p1', ScopeFx.Person);
                    t.CreateNode('open1', ScopeFx.Ticket, { Owner: 'm' });
                    t.SetProperty('open1', ScopeFx.Status, ScopeFx.Open);
                    t.Link('open1', ScopeFx.About, 'p1');
                    t.CreateNode('closed1', ScopeFx.Ticket, { Owner: 'm' });
                    t.SetProperty('closed1', ScopeFx.Status, ScopeFx.Closed);
                    t.Link('closed1', ScopeFx.About, 'p1');
                });
                const scope = ScopeFx.Rows([[ScopeFx.Ticket, new Compare(ScopeFx.Status, CompareOp.Eq, ScopeFx.Open)]]);
                await ScopeFx.Read(g, scope, async r =>
                {
                    assert.equal(await r.GetProperty('closed1', ScopeFx.Status), undefined);
                    assert.equal(await r.GetProperty('closed1', 'noSuchMember'), undefined, 'no schema check on a missing node');
                    assert.equal(await r.ConceptOf('closed1'), undefined);
                    assert.equal(await r.OwnerOf('closed1'), undefined);
                    assert.equal(await r.OwnerOf('open1'), 'm');
                    assert.equal(await r.IsSeeded('closed1'), false);
                    assert.deepEqual(await r.Neighbors('closed1', ScopeFx.About, EdgeDirection.Out), []);
                    assert.deepEqual(await r.Neighbors('p1', ScopeFx.About, EdgeDirection.In), ['open1']);
                    assert.deepEqual(await ScopeFx.Ids(r, ScopeFx.Ticket), ['open1']);
                    assert.deepEqual(await ScopeFx.ScanIds(r, ScopeFx.Ticket, ScopeFx.Status), ['open1']);
                    assert.deepEqual(await ScopeFx.ScanIds(r, ScopeFx.Ticket, ScopeFx.About), ['open1']);
                    assert.deepEqual(await ScopeFx.Collect(r.SeekIndex(ScopeFx.TicketByStatus, { Prefix: [] })), ['open1']);
                    assert.deepEqual(await ScopeFx.Collect(r.SeekIndex(ScopeFx.TicketByStatus, { Prefix: [], Limit: 1 })), ['open1'], 'Limit counts visible nodes');
                });
                const hidePeople = ScopeFx.Rows([[ScopeFx.Person, FalsePredicate.Instance]]);
                await ScopeFx.Read(g, hidePeople, async r =>
                {
                    assert.deepEqual(await r.Neighbors('open1', ScopeFx.About, EdgeDirection.Out), [], 'an invisible target is filtered out');
                    assert.deepEqual(await ScopeFx.ScanIds(r, ScopeFx.Ticket, ScopeFx.About), [], 'a relationship row to an invisible target is skipped');
                });
                await g.dispose();
            });

            it('hidden member reads null and is absent from scans', async () =>
            {
                const g = await ScopeFx.Ready(open);
                await ScopeFx.Commit(g, t =>
                {
                    t.CreateNode('p1', ScopeFx.Person);
                    t.SetProperty('p1', ScopeFx.Level, 3n);
                    t.SetProperty('p1', ScopeFx.Email, 'p1@x');
                    t.SetProperty('p1', ScopeFx.Name, 'Pat');
                    t.CreateNode('team', ScopeFx.Team);
                    t.Link('team', ScopeFx.Member, 'p1');
                });
                const scope = AccessScope.Build({
                    Default: AccessDefault.Allow,
                    Hidden: new Map([[ScopeFx.Secret, new Set([ScopeFx.Level])], [ScopeFx.Person, new Set([ScopeFx.Email])], [ScopeFx.Team, new Set([ScopeFx.Member])]]),
                });
                await ScopeFx.Read(g, scope, async r =>
                {
                    assert.equal(await r.GetProperty('p1', ScopeFx.Level), null);
                    assert.equal(await r.GetProperty('p1', ScopeFx.Email), null);
                    assert.equal(await r.GetProperty('p1', ScopeFx.Name), 'Pat');
                    assert.deepEqual(await ScopeFx.ScanIds(r, ScopeFx.Person, ScopeFx.Level), []);
                    assert.deepEqual(await ScopeFx.ScanIds(r, ScopeFx.Secret, ScopeFx.Level), []);
                    assert.deepEqual(await ScopeFx.ScanIds(r, ScopeFx.Person, ScopeFx.Name), ['p1']);
                    assert.deepEqual(await ScopeFx.Collect(r.SeekIndex(ScopeFx.PersonByEmail, { Prefix: [] })), [], 'an index over a hidden member skips the node');
                    assert.deepEqual(await r.Neighbors('team', ScopeFx.Member, EdgeDirection.Out), []);
                    assert.deepEqual(await r.Neighbors('p1', ScopeFx.Member, EdgeDirection.In), [], 'hidden on the source concept');
                    assert.deepEqual(await ScopeFx.ScanIds(r, ScopeFx.Team, ScopeFx.Member), []);
                });
                await g.dispose();
            });

            it('Reachable within hops', async () =>
            {
                const g = await ScopeFx.Ready(open);
                await ScopeFx.Commit(g, t =>
                {
                    t.CreateNode('T', ScopeFx.Team);
                    for (const p of ['P1', 'P2', 'P3', 'P4'])
                    {
                        t.CreateNode(p, ScopeFx.Person);
                    }
                    t.Link('T', ScopeFx.Member, 'P1');
                    t.Link('P1', ScopeFx.Manages, 'P2');
                    t.Link('P2', ScopeFx.Manages, 'P3');
                });
                const reach = new Reachable(new Set(['T']), [{ Relationship: ScopeFx.Member, Direction: EdgeDirection.Out }, { Relationship: ScopeFx.Manages, Direction: EdgeDirection.Out }], 2);
                const scope = ScopeFx.Rows([[ScopeFx.Person, reach]]);
                await ScopeFx.Read(g, scope, async r =>
                {
                    assert.deepEqual(await ScopeFx.Ids(r, ScopeFx.Person), ['P1', 'P2']);
                    assert.equal(await r.ConceptOf('P3'), undefined);
                    assert.equal(await r.ConceptOf('T'), ScopeFx.Team);
                });
                await g.dispose();
            });

            it('Related ignores invisible neighbors', async () =>
            {
                const g = await ScopeFx.Ready(open);
                await ScopeFx.Commit(g, t =>
                {
                    t.CreateNode('pOpen', ScopeFx.Person);
                    t.SetProperty('pOpen', ScopeFx.Status, ScopeFx.Open);
                    t.SetProperty('pOpen', ScopeFx.Name, 'x');
                    t.CreateNode('pClosed', ScopeFx.Person);
                    t.SetProperty('pClosed', ScopeFx.Status, ScopeFx.Closed);
                    t.SetProperty('pClosed', ScopeFx.Name, 'x');
                    t.CreateNode('tA', ScopeFx.Ticket);
                    t.Link('tA', ScopeFx.About, 'pOpen');
                    t.CreateNode('tB', ScopeFx.Ticket);
                    t.Link('tB', ScopeFx.About, 'pClosed');
                });
                const scope = ScopeFx.Rows([
                    [ScopeFx.Ticket, new Related(ScopeFx.About, EdgeDirection.Out, new Compare(ScopeFx.Name, CompareOp.Eq, 'x'))],
                    [ScopeFx.Person, new Compare(ScopeFx.Status, CompareOp.Eq, ScopeFx.Open)],
                ]);
                await ScopeFx.Read(g, scope, async r => assert.deepEqual(await ScopeFx.Ids(r, ScopeFx.Ticket), ['tA']));
                await g.dispose();
            });

            it('Related over a cycle terminates', async () =>
            {
                const g = await ScopeFx.Ready(open);
                await ScopeFx.Commit(g, t =>
                {
                    for (const p of ['root', 'a', 'c1', 'c2'])
                    {
                        t.CreateNode(p, ScopeFx.Person);
                    }
                    t.Link('root', ScopeFx.Manages, 'a');
                    t.Link('c1', ScopeFx.Manages, 'c2');
                    t.Link('c2', ScopeFx.Manages, 'c1');
                });
                // Visible: root, or managed by a visible person.
                const scope = ScopeFx.Rows([[ScopeFx.Person, new Or([new IdIn(new Set(['root'])), new Related(ScopeFx.Manages, EdgeDirection.In, TruePredicate.Instance)])]]);
                await ScopeFx.Read(g, scope, async r => assert.deepEqual(await ScopeFx.Ids(r, ScopeFx.Person), ['a', 'root']));
                await g.dispose();
            });

            it('Seeded, OwnerIs and three-valued Not', async () =>
            {
                const g = await ScopeFx.Ready(open);
                await ScopeFx.Commit(g, t =>
                {
                    t.CreateNode('mine', ScopeFx.Team, { Owner: 'm1' });
                    t.CreateNode('theirs', ScopeFx.Team, { Owner: 'm2' });
                    t.CreateNode('unset', ScopeFx.Person);
                    t.CreateNode('other', ScopeFx.Person);
                    t.SetProperty('other', ScopeFx.Status, ScopeFx.Closed);
                });
                const scope = ScopeFx.Rows([
                    [ScopeFx.Team, new Or([new Seeded(), new OwnerIs(new Set(['m1']))])],
                    // Not(Unknown) stays Unknown even beside a graph predicate: 'unset' is not visible.
                    [ScopeFx.Person, new Not(new And([new Compare(ScopeFx.Status, CompareOp.Eq, ScopeFx.Open), new Not(new Seeded())]))],
                ]);
                await ScopeFx.Read(g, scope, async r =>
                {
                    assert.deepEqual(await ScopeFx.Ids(r, ScopeFx.Team), ['mine', ScopeFx.SeedTeam]);
                    assert.deepEqual(await ScopeFx.Ids(r, ScopeFx.Person), ['other']);
                });
                await g.dispose();
            });

            it('visibility read is recorded', async () =>
            {
                const g = await ScopeFx.Ready(open);
                await ScopeFx.Commit(g, t =>
                {
                    t.CreateNode('n', ScopeFx.Ticket);
                    t.SetProperty('n', ScopeFx.Status, ScopeFx.Open);
                });
                const scope = ScopeFx.Rows([[ScopeFx.Ticket, new Compare(ScopeFx.Status, CompareOp.Eq, ScopeFx.Open)]]);
                const t1 = await g.Begin(scope);
                assert.equal(t1.Scope, scope);
                assert.equal(await t1.GetProperty('n', ScopeFx.Title), null);
                await ScopeFx.Commit(g, t => t.SetProperty('n', ScopeFx.Status, ScopeFx.Closed));
                t1.CreateNode('x', ScopeFx.Team);
                assert.ok((await ScopeFx.Settle(t1.Commit())) instanceof ConflictError);

                // Control: the same flow under System reads no status cell, so it commits.
                const t2 = await g.Begin(AccessScope.System);
                assert.equal(await t2.GetProperty('n', ScopeFx.Title), null);
                await ScopeFx.Commit(g, t => t.SetProperty('n', ScopeFx.Status, ScopeFx.Open));
                t2.CreateNode('y', ScopeFx.Team);
                assert.equal(typeof (await t2.Commit()), 'bigint');
                await g.dispose();
            });

            it('Reachable reads are recorded', async () =>
            {
                const g = await ScopeFx.Ready(open);
                await ScopeFx.Commit(g, t =>
                {
                    t.CreateNode('T', ScopeFx.Team);
                    t.CreateNode('P1', ScopeFx.Person);
                });
                const reach = new Reachable(new Set(['T']), [{ Relationship: ScopeFx.Member, Direction: EdgeDirection.Out }], 1);
                const t1 = await g.Begin(ScopeFx.Rows([[ScopeFx.Person, reach]]));
                assert.equal(await t1.ConceptOf('P1'), undefined);
                await ScopeFx.Commit(g, t => t.Link('T', ScopeFx.Member, 'P1'));
                t1.CreateNode('x', ScopeFx.Team);
                assert.ok((await ScopeFx.Settle(t1.Commit())) instanceof ConflictError);
                await g.dispose();
            });

            it('concurrent reads on one reader decide independently', async () =>
            {
                const g = await ScopeFx.Ready(open);
                await ScopeFx.Commit(g, t =>
                {
                    t.CreateNode('n', ScopeFx.Ticket);
                    t.SetProperty('n', ScopeFx.Status, ScopeFx.Open);
                    t.CreateNode('b', ScopeFx.Person);
                    t.SetProperty('b', ScopeFx.Status, ScopeFx.Open);
                    t.CreateNode('t', ScopeFx.Ticket);
                    t.Link('t', ScopeFx.About, 'b');
                });
                const open1 = ScopeFx.Rows([[ScopeFx.Ticket, new Compare(ScopeFx.Status, CompareOp.Eq, ScopeFx.Open)]]);
                await ScopeFx.Read(g, open1, async r =>
                {
                    const all = await Promise.all([r.ConceptOf('n'), r.ConceptOf('n'), r.ConceptOf('n')]);
                    assert.deepEqual(all, [ScopeFx.Ticket, ScopeFx.Ticket, ScopeFx.Ticket]);
                });
                // b (slow to decide) is visible, so t (visible iff no visible `about` target) is not.
                const slow = new And(Array.from({ length: 8 }, () => new Compare(ScopeFx.Status, CompareOp.Eq, ScopeFx.Open)));
                const leak = ScopeFx.Rows([
                    [ScopeFx.Person, slow],
                    [ScopeFx.Ticket, new Not(new Related(ScopeFx.About, EdgeDirection.Out, TruePredicate.Instance))],
                ]);
                await ScopeFx.Read(g, leak, async r =>
                {
                    assert.deepEqual(await Promise.all([r.ConceptOf('b'), r.ConceptOf('t')]), [ScopeFx.Person, undefined]);
                });
                await g.dispose();
            });

            it('Not(Related) over a cycle is invisible', async () =>
            {
                const g = await ScopeFx.Ready(open);
                await ScopeFx.Commit(g, t =>
                {
                    for (const p of ['c1', 'c2', 'd1', 'd2', 'd3', 'boss', 'leaf'])
                    {
                        t.CreateNode(p, ScopeFx.Person);
                    }
                    t.Link('c1', ScopeFx.Manages, 'c2');
                    t.Link('c2', ScopeFx.Manages, 'c1');
                    t.Link('d1', ScopeFx.Manages, 'd2');
                    t.Link('d2', ScopeFx.Manages, 'd3');
                    t.Link('d3', ScopeFx.Manages, 'd1');
                    t.Link('boss', ScopeFx.Manages, 'leaf');
                });
                // Visible iff it manages no visible person: undecidable on a cycle (odd or even), so its members stay hidden.
                const scope = ScopeFx.Rows([[ScopeFx.Person, new Not(new Related(ScopeFx.Manages, EdgeDirection.Out, TruePredicate.Instance))]]);
                await ScopeFx.Read(g, scope, async r =>
                {
                    assert.deepEqual(await ScopeFx.Ids(r, ScopeFx.Person), ['leaf']);
                    assert.equal(await r.ConceptOf('c1'), undefined);
                    assert.deepEqual(await ScopeFx.Visible(r, ['d1', 'd2', 'd3']), [], 'decided first, d1 must not be granted through the cycle');
                });
                await g.dispose();
            });

            it('SeekIndex with Limit records the range up to the last examined entry', async () =>
            {
                const g = await ScopeFx.Ready(open);
                await ScopeFx.Commit(g, t =>
                {
                    t.CreateNode('c', ScopeFx.Ticket);
                    t.SetProperty('c', ScopeFx.Status, ScopeFx.Closed);
                    t.CreateNode('o', ScopeFx.Ticket);
                    t.SetProperty('o', ScopeFx.Status, ScopeFx.Open);
                });
                const scope = ScopeFx.Rows([[ScopeFx.Ticket, new Compare(ScopeFx.Status, CompareOp.Eq, ScopeFx.Open)]]);
                const range = { Prefix: [], Limit: 1 };
                // An entry after the last examined one ('open' < 'zz') is outside the recorded range.
                const t1 = await g.Begin(scope);
                assert.deepEqual(await ScopeFx.Collect(t1.SeekIndex(ScopeFx.TicketByStatus, range)), ['o']);
                await ScopeFx.Commit(g, t =>
                {
                    t.CreateNode('late', ScopeFx.Ticket);
                    t.SetProperty('late', ScopeFx.Status, 'zz');
                });
                t1.CreateNode('x1', ScopeFx.Team);
                assert.equal(typeof (await t1.Commit()), 'bigint');
                // An entry between the invisible leading entry and the yielded one is inside it.
                const t2 = await g.Begin(scope);
                assert.deepEqual(await ScopeFx.Collect(t2.SeekIndex(ScopeFx.TicketByStatus, range)), ['o']);
                await ScopeFx.Commit(g, t =>
                {
                    t.CreateNode('mid', ScopeFx.Ticket);
                    t.SetProperty('mid', ScopeFx.Status, 'm');
                });
                t2.CreateNode('x2', ScopeFx.Team);
                assert.ok((await ScopeFx.Settle(t2.Commit())) instanceof ConflictError);
                await g.dispose();
            });

            it('unknown names in a scope are rejected', async () =>
            {
                const g = await ScopeFx.Ready(open);
                const invalid = (e: unknown): boolean => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument && e.message.includes('Persn');
                const typo = ScopeFx.Rows([['Persn', TruePredicate.Instance]]);
                await assert.rejects(g.BeginRead(typo), invalid);
                await assert.rejects(g.Begin(typo), invalid);
                await assert.rejects(g.BeginRead(AccessScope.Build({ Default: AccessDefault.Allow, Writes: new Map([['Persn', {}]]) })), invalid);
                await assert.rejects(g.BeginRead(AccessScope.Build({ Default: AccessDefault.Allow, Hidden: new Map([['Persn', new Set<string>()]]) })), invalid);
                const badMember = AccessScope.Build({ Default: AccessDefault.Allow, Hidden: new Map([[ScopeFx.Person, new Set(['nmae'])]]) });
                await assert.rejects(g.BeginRead(badMember), (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument && e.message.includes('Person.nmae'));
                // A member effective through a carried aspect is known on the concept.
                const viaAspect = AccessScope.Build({ Default: AccessDefault.Allow, Hidden: new Map([[ScopeFx.Person, new Set([ScopeFx.Level])]]) });
                await ScopeFx.Read(g, viaAspect, async r => assert.equal(await r.ConceptOf('nobody'), undefined));
                await g.dispose();
            });

            it('the visibility cache holds only the nodes decided', async () =>
            {
                const g = await ScopeFx.Ready(open);
                await ScopeFx.Commit(g, t =>
                {
                    for (let i = 0; i < 10; i++)
                    {
                        t.CreateNode('k' + i, ScopeFx.Ticket);
                    }
                });
                const scope = ScopeFx.Rows([[ScopeFx.Ticket, TruePredicate.Instance]]);
                await ScopeFx.Read(g, scope, async r =>
                {
                    await r.ConceptOf('k0');
                    await r.ConceptOf('k1');
                    await r.ConceptOf(ScopeFx.SeedTeam);
                    const cache = (r as unknown as { evaluator: { visible: Map<bigint, boolean> } }).evaluator.visible;
                    assert.equal(cache.size, 2, 'a node with no applicable entry is not cached');
                });
                await g.dispose();
            });

            it('Not(Related) over a complete graph finishes and fails closed', async () =>
            {
                const g = await ScopeFx.Ready(open);
                const ids = Array.from({ length: 12 }, (_, i) => 'k' + i);
                await ScopeFx.Commit(g, t =>
                {
                    for (const id of ids)
                    {
                        t.CreateNode(id, ScopeFx.Person);
                    }
                    for (const a of ids)
                    {
                        for (const b of ids)
                        {
                            if (a !== b)
                            {
                                t.Link(a, ScopeFx.Manages, b);
                            }
                        }
                    }
                });
                const scope = ScopeFx.Rows([[ScopeFx.Person, new Not(new Related(ScopeFx.Manages, EdgeDirection.Out, TruePredicate.Instance))]]);
                const started = Date.now();
                await ScopeFx.Read(g, scope, async r => assert.deepEqual(await ScopeFx.Ids(r, ScopeFx.Person), []));
                assert.ok(Date.now() - started < 10_000, 'decided in ' + (Date.now() - started) + ' ms');
                await g.dispose();
            });

            it('the decision budget fails closed', async () =>
            {
                const g = await ScopeFx.Ready(open);
                const chain = Array.from({ length: 6 }, (_, i) => 'c' + i);
                await ScopeFx.Commit(g, t =>
                {
                    for (const id of chain)
                    {
                        t.CreateNode(id, ScopeFx.Person);
                    }
                    for (let i = 0; i + 1 < chain.length; i++)
                    {
                        t.Link('c' + i, ScopeFx.Manages, 'c' + (i + 1));
                    }
                });
                // Visible iff it is the chain's end or manages a visible person: c0 needs six decisions.
                const scope = ScopeFx.Rows([[ScopeFx.Person, new Or([new IdIn(new Set(['c5'])), new Related(ScopeFx.Manages, EdgeDirection.Out, TruePredicate.Instance)])]]);
                const budget = ScopeEvaluator as unknown as { MaxDecisions: number };
                const saved = budget.MaxDecisions;
                budget.MaxDecisions = 3;
                try
                {
                    await ScopeFx.Read(g, scope, async r => assert.equal(await r.ConceptOf('c0'), undefined));
                }
                finally
                {
                    budget.MaxDecisions = saved;
                }
                await ScopeFx.Read(g, scope, async r => assert.equal(await r.ConceptOf('c0'), ScopeFx.Person));
                await g.dispose();
            });

            it('names a scope predicate reads are validated', async () =>
            {
                const g = await ScopeFx.Ready(open);
                const rejects = async (scope: AccessScope, name: string): Promise<void> =>
                {
                    await assert.rejects(g.BeginRead(scope), (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument && e.message.includes(name), name);
                };
                await rejects(ScopeFx.Rows([[ScopeFx.Person, new Compare('stauts', CompareOp.Eq, ScopeFx.Open)]]), 'Person.stauts');
                await rejects(ScopeFx.Rows([[ScopeFx.Person, new Compare(ScopeFx.Manages, CompareOp.Eq, ScopeFx.Open)]]), 'Person.manages');
                await rejects(ScopeFx.Rows([[ScopeFx.Secret, new IsNull(ScopeFx.Name)]]), 'Secret.name');
                await rejects(ScopeFx.Rows([[ScopeFx.Ticket, new Related('abuot', EdgeDirection.Out, TruePredicate.Instance)]]), 'Ticket.abuot');
                await rejects(ScopeFx.Rows([[ScopeFx.Ticket, new Related(ScopeFx.Status, EdgeDirection.Out, TruePredicate.Instance)]]), 'Ticket.status');
                await rejects(ScopeFx.Rows([[ScopeFx.Ticket, new Related(ScopeFx.About, EdgeDirection.Out, new Compare(ScopeFx.Title, CompareOp.Eq, 'x'))]]), 'Ticket.about.title');
                await rejects(ScopeFx.Rows([[ScopeFx.Ticket, new Related(ScopeFx.About, EdgeDirection.In, TruePredicate.Instance)]]), 'Ticket.about');
                await rejects(ScopeFx.Rows([[ScopeFx.Person, new Reachable(new Set(['T']), [{ Relationship: 'membr', Direction: EdgeDirection.Out }], 1)]]), 'Person.membr');
                await rejects(AccessScope.Build({ Default: AccessDefault.Allow, Writes: new Map([[ScopeFx.Ticket, { Update: new In('titel', ['x']) }]]) }), 'Ticket.titel');
                // Valid: an aspect property on a carrier, a nested In step, and a Target property of the reached concept.
                const valid = ScopeFx.Rows([
                    [ScopeFx.Person, new And([new Compare(ScopeFx.Level, CompareOp.Le, 1n), new Related(ScopeFx.About, EdgeDirection.In, new Compare(ScopeFx.Status, CompareOp.Eq, ScopeFx.Open))])],
                    [ScopeFx.Ticket, new Related(ScopeFx.About, EdgeDirection.Out, new Related(ScopeFx.Member, EdgeDirection.In, new Compare(ScopeFx.Name, CompareOp.Eq, 'x')))],
                ]);
                await ScopeFx.Read(g, valid, async r => assert.equal(await r.ConceptOf('nobody'), undefined));
                await g.dispose();
            });
        });
    }
}

describe('AccessScope', () =>
{
    it('Build rejects an unknown Default', () =>
    {
        assert.throws(() => AccessScope.Build({ Default: 7 as AccessDefault }), (e: unknown) => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument);
    });

    it('Build copies its maps', () =>
    {
        const rows = new Map<string, Predicate>([[ScopeFx.Person, TruePredicate.Instance]]);
        const scope = AccessScope.Build({ Default: AccessDefault.Deny, Rows: rows });
        rows.clear();
        assert.equal(scope.Rows.size, 1);
    });
});

ScopeFx.Register('memory', () => GraphStore.OpenMemory());
ScopeFx.Register('lmdb', () => GraphStore.OpenLmdb(ScopeFx.Dir()));

after(() => ScopeFx.RemoveDirs());
