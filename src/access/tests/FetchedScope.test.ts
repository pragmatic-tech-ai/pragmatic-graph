import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemberInput } from '../../catalog/CatalogTypes.js';
import { MemberKind, ValueType } from '../../catalog/ValueType.js';
import type { CellValue } from '../../columns/CellValue.js';
import { ConnectorResidency, type IExternalConnector, type IFetchedRow } from '../../connectors/FetchContract.js';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';
import { EdgeDirection } from '../../format/FormatKeys.js';
import type { GraphReader } from '../../GraphReader.js';
import { GraphStore } from '../../GraphStore.js';
import type { GraphTransaction } from '../../GraphTransaction.js';
import { And, Compare, CompareOp, ConceptIs, FalsePredicate, IdIn, IsNull, Not, OwnerIs, type Predicate, Reachable, Related, Seeded, TruePredicate } from '../../predicate/Predicate.js';
import type { IBindingDescription, ISchemaDescription } from '../../schema/SchemaDescription.js';
import { ConflictError } from '../../txn/ConflictError.js';
import { AccessDefault, AccessScope } from '../AccessScope.js';

/**
 * Fixture for scoping fetched rows (ruling R100). Aspect Tagged { tag }; Server (carries Tagged) { cpu, secret,
 * team -> Team, peer -> Server* }; Team { name, assigned -> Server* }. Server rows of model Ext are bound to the
 * External connector ExtC; Teams are engine nodes. Stubs are ordinary property-less Server nodes owned by Ext, created
 * before the connectors are installed (exactly what a stub is in storage).
 */
class FetchedFx
{
    private static readonly DirPrefix = 'pragmatic-graph-fetched-';
    private static readonly Dirs: string[] = [];
    private static readonly ReadOnly = 'read-only';
    public static readonly Tagged = 'Tagged';
    public static readonly Server = 'Server';
    public static readonly Team = 'Team';
    public static readonly Tag = 'tag';
    public static readonly Cpu = 'cpu';
    public static readonly Secret = 'secret';
    public static readonly Load = 'load';
    public static readonly Linked = 'Linked';
    public static readonly Asset = 'Asset';
    public static readonly Link = 'link';
    public static readonly Nope = 'Nope';
    public static readonly TeamRel = 'team';
    public static readonly Peer = 'peer';
    public static readonly Name = 'name';
    public static readonly Assigned = 'assigned';
    public static readonly Ext = 'ext';
    public static readonly Other = 'other';
    public static readonly ExtC = 'extc';
    public static readonly Core = 'core';
    public static readonly T = 't';
    public static readonly U = 'u';
    public static readonly X = 'x';
    public static readonly Y = 'y';

    public static Dir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), FetchedFx.DirPrefix));
        FetchedFx.Dirs.push(dir);
        return dir;
    }

    public static RemoveDirs(): void
    {
        for (const d of FetchedFx.Dirs)
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
                { Name: FetchedFx.Tagged, IsAspect: true, Parent: null, Aspects: [], Members: [FetchedFx.Prop(FetchedFx.Tag, ValueType.String)] },
                { Name: FetchedFx.Linked, IsAspect: true, Parent: null, Aspects: [], Members: [FetchedFx.Rel(FetchedFx.Link, FetchedFx.Server, true)] },
                { Name: FetchedFx.Asset, IsAspect: false, Parent: null, Aspects: [], Members: [] },
                {
                    Name: FetchedFx.Server, IsAspect: false, Parent: FetchedFx.Asset, Aspects: [FetchedFx.Tagged, FetchedFx.Linked], Members: [
                        FetchedFx.Prop(FetchedFx.Cpu, ValueType.Int64),
                        FetchedFx.Prop(FetchedFx.Secret, ValueType.String),
                        FetchedFx.Prop(FetchedFx.Load, ValueType.Float64),
                        FetchedFx.Rel(FetchedFx.TeamRel, FetchedFx.Team, false),
                        FetchedFx.Rel(FetchedFx.Peer, FetchedFx.Server, true),
                    ],
                },
                { Name: FetchedFx.Team, IsAspect: false, Parent: null, Aspects: [], Members: [FetchedFx.Prop(FetchedFx.Name, ValueType.String), FetchedFx.Rel(FetchedFx.Assigned, FetchedFx.Server, true)] },
            ],
            Indexes: [],
            Seed: [],
            Bindings: [],
        };
    }

    /** Ext's Servers bound to ExtC (the default fixture binding). */
    public static readonly ServerBinding: readonly IBindingDescription[] = [{ Model: FetchedFx.Ext, Concept: FetchedFx.Server, Connector: FetchedFx.ExtC }];
    /** Ext's nodes carrying Tagged bound to ExtC: keyed by an aspect, not by the concept that carries it. */
    public static readonly TaggedBinding: readonly IBindingDescription[] = [{ Model: FetchedFx.Ext, Concept: FetchedFx.Tagged, Connector: FetchedFx.ExtC }];
    /** Ext's Assets (so its Servers) bound to ExtC: keyed by an ancestor of the carrying concept. */
    public static readonly AncestorBinding: readonly IBindingDescription[] = [{ Model: FetchedFx.Ext, Concept: FetchedFx.Asset, Connector: FetchedFx.ExtC }];
    /** Everything Ext holds bound to ExtC, model-wide. */
    public static readonly ModelWideBinding: readonly IBindingDescription[] = [{ Model: FetchedFx.Ext, Connector: FetchedFx.ExtC }];

    public static External(): IExternalConnector
    {
        return {
            Name: FetchedFx.ExtC,
            Residency: ConnectorResidency.External,
            Capabilities: { KeyLookup: true, ReverseLookup: false, PushDown: new Set() },
            Begin: () => Promise.reject(new Error(FetchedFx.ReadOnly)),
            Fetch: () => Promise.resolve({ Rows: [] }),
        };
    }

    /**
     * A store with engine Teams t (name core, assigned -> stub x) and u (name other); `stub` false leaves x out (no
     * stub, no edge). Then the Ext/Server binding to ExtC is installed.
     */
    public static async Ready(open: () => Promise<GraphStore>, stub = true, bindings: readonly IBindingDescription[] = FetchedFx.ServerBinding): Promise<GraphStore>
    {
        const g = await open();
        await g.Upgrade(FetchedFx.Description());
        await FetchedFx.Commit(g, t =>
        {
            t.CreateNode(FetchedFx.T, FetchedFx.Team);
            t.SetProperty(FetchedFx.T, FetchedFx.Name, FetchedFx.Core);
            t.CreateNode(FetchedFx.U, FetchedFx.Team);
            t.SetProperty(FetchedFx.U, FetchedFx.Name, FetchedFx.Other);
            if (stub)
            {
                t.CreateNode(FetchedFx.X, FetchedFx.Server, { Owner: FetchedFx.Ext });
                t.Link(FetchedFx.T, FetchedFx.Assigned, FetchedFx.X);
            }
        });
        // A residency change goes through an upgrade (ruling P19): it strips x to a stub.
        await g.Upgrade({ ...FetchedFx.Description(), Bindings: bindings }, [FetchedFx.External()]);
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

    public static Row(publicId: string, values: ReadonlyArray<readonly [string, CellValue]> = [], links: ReadonlyArray<readonly [string, readonly string[]]> = []): IFetchedRow
    {
        return { PublicId: publicId, Concept: FetchedFx.Server, Values: new Map(values), Links: new Map(links) };
    }

    public static Rows(entries: ReadonlyArray<readonly [string, Predicate]>, fallback = AccessDefault.Allow): AccessScope
    {
        return AccessScope.Build({ Default: fallback, Rows: new Map(entries) });
    }

    /** Whether each row is admitted (owner Ext unless given) under `scope`. */
    public static async Admitted(g: GraphStore, scope: AccessScope, rows: readonly IFetchedRow[], owner: string = FetchedFx.Ext): Promise<boolean[]>
    {
        return FetchedFx.Read(g, scope, async r =>
        {
            const out: boolean[] = [];
            for (const row of rows)
            {
                out.push((await r.AdmitFetched(row, owner)) !== undefined);
            }
            return out;
        });
    }

    public static IsSchemaViolation(e: unknown): boolean
    {
        return e instanceof GraphError && e.GraphCode === GraphErrorCode.SchemaViolation;
    }

    public static ServerScope(p: Predicate): AccessScope
    {
        return FetchedFx.Rows([[FetchedFx.Server, p]]);
    }

    public static Register(name: string, open: () => Promise<GraphStore>): void
    {
        describe('fetched row scope on ' + name, () =>
        {
            it('property predicate on fetched row', async () =>
            {
                const g = await FetchedFx.Ready(open);
                const scope = FetchedFx.ServerScope(new Compare(FetchedFx.Cpu, CompareOp.Gt, 4n));
                const rows = [FetchedFx.Row('a', [[FetchedFx.Cpu, 8n]]), FetchedFx.Row('b', [[FetchedFx.Cpu, 2n]]), FetchedFx.Row('c')];
                assert.deepEqual(await FetchedFx.Admitted(g, scope, rows), [true, false, false]);
                g.dispose();
            });

            it('hidden member is removed', async () =>
            {
                const g = await FetchedFx.Ready(open);
                const scope = AccessScope.Build({ Default: AccessDefault.Allow, Hidden: new Map([[FetchedFx.Server, new Set([FetchedFx.Secret, FetchedFx.TeamRel])]]) });
                const row = FetchedFx.Row('a', [[FetchedFx.Cpu, 8n], [FetchedFx.Secret, 's']], [[FetchedFx.TeamRel, [FetchedFx.T]], [FetchedFx.Peer, ['b']]]);
                const admitted = await FetchedFx.Read(g, scope, r => r.AdmitFetched(row, FetchedFx.Ext));
                assert.ok(admitted !== undefined);
                assert.deepEqual([...admitted.Values], [[FetchedFx.Cpu, 8n]]);
                assert.deepEqual([...admitted.Links], [[FetchedFx.Peer, ['b']]]);
                assert.equal(admitted.PublicId, 'a');
                assert.equal(admitted.Concept, FetchedFx.Server);
                // The caller's row is untouched.
                assert.equal(row.Values.get(FetchedFx.Secret), 's');
                const all = await FetchedFx.Read(g, AccessScope.System, r => r.AdmitFetched(row, FetchedFx.Ext));
                assert.equal(all?.Values.get(FetchedFx.Secret), 's');
                g.dispose();
            });

            it('OwnerIs and IdIn decide', async () =>
            {
                const g = await FetchedFx.Ready(open);
                const owner = FetchedFx.ServerScope(new OwnerIs(new Set([FetchedFx.Ext])));
                assert.deepEqual(await FetchedFx.Admitted(g, owner, [FetchedFx.Row('a')]), [true]);
                assert.deepEqual(await FetchedFx.Admitted(g, owner, [FetchedFx.Row('a')], FetchedFx.Other), [false]);
                const ids = FetchedFx.ServerScope(new IdIn(new Set(['a'])));
                assert.deepEqual(await FetchedFx.Admitted(g, ids, [FetchedFx.Row('a'), FetchedFx.Row('b')]), [true, false]);
                const concept = FetchedFx.ServerScope(new ConceptIs(FetchedFx.Server));
                assert.deepEqual(await FetchedFx.Admitted(g, concept, [FetchedFx.Row('a')]), [true]);
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(new Not(new ConceptIs(FetchedFx.Server))), [FetchedFx.Row('a')]), [false]);
                g.dispose();
            });

            it('Seeded is false', async () =>
            {
                const g = await FetchedFx.Ready(open);
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(new Seeded()), [FetchedFx.Row('a')]), [false]);
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(new Not(new Seeded())), [FetchedFx.Row('a')]), [true]);
                g.dispose();
            });

            it('Related out to an engine node decides normally', async () =>
            {
                const g = await FetchedFx.Ready(open);
                const core = new Related(FetchedFx.TeamRel, EdgeDirection.Out, new Compare(FetchedFx.Name, CompareOp.Eq, FetchedFx.Core));
                const rows = [FetchedFx.Row('a', [], [[FetchedFx.TeamRel, [FetchedFx.T]]]), FetchedFx.Row('b', [], [[FetchedFx.TeamRel, [FetchedFx.U]]]), FetchedFx.Row('c')];
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(core), rows), [true, false, false]);
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(new Not(core)), rows), [false, true, true]);
                // The engine target's own visibility counts: Team t hidden by the scope admits nothing through it.
                const hiddenTeam = FetchedFx.Rows([[FetchedFx.Server, core], [FetchedFx.Team, new Compare(FetchedFx.Name, CompareOp.Ne, FetchedFx.Core)]]);
                assert.deepEqual(await FetchedFx.Admitted(g, hiddenTeam, rows), [false, false, false]);
                g.dispose();
            });

            it('Related out to an external target is Unknown, also when Target is True', async () =>
            {
                const g = await FetchedFx.Ready(open);
                // Peer 'x' is a stub (external), 'zz' is not stored at all: both are external targets.
                const rows = [FetchedFx.Row('a', [], [[FetchedFx.Peer, [FetchedFx.X]]]), FetchedFx.Row('b', [], [[FetchedFx.Peer, ['zz']]]), FetchedFx.Row('c')];
                const any = new Related(FetchedFx.Peer, EdgeDirection.Out, TruePredicate.Instance);
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(any), rows), [false, false, false]);
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(new Not(any)), rows), [false, false, true]);
                const big = new Related(FetchedFx.Peer, EdgeDirection.Out, new Compare(FetchedFx.Cpu, CompareOp.Gt, 4n));
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(big), rows), [false, false, false]);
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(new Not(big)), rows), [false, false, true]);
                g.dispose();
            });

            it('Related in through a stub decides', async () =>
            {
                const g = await FetchedFx.Ready(open);
                const fromT = new Related(FetchedFx.Assigned, EdgeDirection.In, new IdIn(new Set([FetchedFx.T])));
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(fromT), [FetchedFx.Row(FetchedFx.X), FetchedFx.Row(FetchedFx.Y)]), [true, false]);
                const fromU = new Related(FetchedFx.Assigned, EdgeDirection.In, new IdIn(new Set([FetchedFx.U])));
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(fromU), [FetchedFx.Row(FetchedFx.X)]), [false]);
                // A stub owned by another model is not this row's stub.
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(fromT), [FetchedFx.Row(FetchedFx.X)], FetchedFx.Other), [false]);
                g.dispose();
            });

            it('a cyclic rule through the stub fails closed', async () =>
            {
                const g = await FetchedFx.Ready(open);
                // x needs a visible Team assigning it; the Team needs a visible Server it assigns: the stub x again.
                const scope = FetchedFx.Rows([
                    [FetchedFx.Server, new Related(FetchedFx.Assigned, EdgeDirection.In, TruePredicate.Instance)],
                    [FetchedFx.Team, new Related(FetchedFx.Assigned, EdgeDirection.Out, TruePredicate.Instance)],
                ]);
                assert.deepEqual(await FetchedFx.Admitted(g, scope, [FetchedFx.Row(FetchedFx.X)]), [false]);
                g.dispose();
            });

            it('Not(Related In) with a stub present is not visible', async () =>
            {
                // Stub x exists (Team t assigns it), but an external Server may link to x by peer: no engine edge says so.
                const g = await FetchedFx.Ready(open);
                const peerIn = new Related(FetchedFx.Peer, EdgeDirection.In, TruePredicate.Instance);
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(peerIn), [FetchedFx.Row(FetchedFx.X)]), [false]);
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(new Not(peerIn)), [FetchedFx.Row(FetchedFx.X)]), [false]);
                // An engine-only source still decides through the stub, both ways.
                const assignedIn = new Related(FetchedFx.Assigned, EdgeDirection.In, new IdIn(new Set([FetchedFx.U])));
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(new Not(assignedIn)), [FetchedFx.Row(FetchedFx.X)]), [true]);
                g.dispose();
            });

            it('Not(Reachable) with a stub present and an externally held step source is not visible', async () =>
            {
                const g = await FetchedFx.Ready(open);
                // From u nothing is reached in the engine, but a peer step could pass through external Servers.
                const steps = [{ Relationship: FetchedFx.Assigned, Direction: EdgeDirection.Out }, { Relationship: FetchedFx.Peer, Direction: EdgeDirection.Out }];
                const fromU = new Reachable(new Set([FetchedFx.U]), steps, 2);
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(fromU), [FetchedFx.Row(FetchedFx.X)]), [false]);
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(new Not(fromU)), [FetchedFx.Row(FetchedFx.X)]), [false]);
                // Reached through the stub is True whatever the steps.
                const fromT = new Reachable(new Set([FetchedFx.T]), steps, 2);
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(fromT), [FetchedFx.Row(FetchedFx.X)]), [true]);
                g.dispose();
            });

            it('an engine rule over a stub is Unknown, never decided from its empty cells', async () =>
            {
                const g = await FetchedFx.Ready(open);
                const empty = new Related(FetchedFx.Assigned, EdgeDirection.Out, new IsNull(FetchedFx.Cpu));
                await FetchedFx.Read(g, FetchedFx.Rows([[FetchedFx.Team, empty]]), async r =>
                {
                    assert.equal(await r.ConceptOf(FetchedFx.T), undefined);
                    assert.equal(await r.ConceptOf(FetchedFx.U), undefined);
                });
                await FetchedFx.Read(g, FetchedFx.Rows([[FetchedFx.Team, new Not(empty)]]), async r =>
                {
                    assert.equal(await r.ConceptOf(FetchedFx.T), undefined);
                    assert.equal(await r.ConceptOf(FetchedFx.U), FetchedFx.Team);
                });
                // The stub itself: a Rows entry on its concept cannot be decided from storage; Default decides without one.
                await FetchedFx.Read(g, FetchedFx.ServerScope(new IsNull(FetchedFx.Cpu)), async r =>
                {
                    assert.equal(await r.ConceptOf(FetchedFx.X), undefined);
                    assert.equal(await r.ConceptOf(FetchedFx.T), FetchedFx.Team);
                });
                await FetchedFx.Read(g, FetchedFx.Rows([[FetchedFx.Team, TruePredicate.Instance]]), async r =>
                {
                    assert.equal(await r.ConceptOf(FetchedFx.X), FetchedFx.Server);
                });
                g.dispose();
            });

            it('fetched rows are checked against the catalog', async () =>
            {
                const g = await FetchedFx.Ready(open);
                for (const scope of [AccessScope.System, FetchedFx.ServerScope(TruePredicate.Instance)])
                {
                    await FetchedFx.Read(g, scope, async r =>
                    {
                        const bad: IFetchedRow[] = [
                            FetchedFx.Row('a', [[FetchedFx.Cpu, 'eight']]),
                            { ...FetchedFx.Row('a'), Concept: FetchedFx.Nope },
                            { ...FetchedFx.Row('a'), Concept: FetchedFx.Tagged },
                            FetchedFx.Row('a', [['unknown', 1n]]),
                            FetchedFx.Row('a', [[FetchedFx.TeamRel, FetchedFx.T]]),
                            FetchedFx.Row('a', [], [[FetchedFx.Cpu, [FetchedFx.T]]]),
                            FetchedFx.Row('a', [], [['unknown', [FetchedFx.T]]]),
                        ];
                        for (const row of bad)
                        {
                            await assert.rejects(r.AdmitFetched(row, FetchedFx.Ext), FetchedFx.IsSchemaViolation);
                        }
                        const ok = await r.AdmitFetched(FetchedFx.Row('a', [[FetchedFx.Load, 2n], [FetchedFx.Secret, null]]), FetchedFx.Ext);
                        assert.ok(ok !== undefined);
                        assert.deepEqual([...ok.Values], [[FetchedFx.Load, 2]]);
                    });
                }
                g.dispose();
            });

            it('Related In over an aspect-declared relationship carried by an external concept is Unknown', async () =>
            {
                // link is declared on aspect Linked, carried by Server; Ext's Servers are external through a Tagged binding
                // (so the stub x exists, but no engine edge says whether an external Server links to it).
                const g = await FetchedFx.Ready(open, true, FetchedFx.TaggedBinding);
                const linkIn = new Related(FetchedFx.Link, EdgeDirection.In, TruePredicate.Instance);
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(linkIn), [FetchedFx.Row(FetchedFx.X)]), [false]);
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(new Not(linkIn)), [FetchedFx.Row(FetchedFx.X)]), [false]);
                // Reachable over that relationship cannot be settled False through the stub either.
                const fromU = new Reachable(new Set([FetchedFx.U]), [{ Relationship: FetchedFx.Link, Direction: EdgeDirection.Out }], 1);
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(new Not(fromU)), [FetchedFx.Row(FetchedFx.X)]), [false]);
                g.dispose();
            });

            for (const [label, bindings] of [['an ancestor', FetchedFx.AncestorBinding], ['a model-wide binding', FetchedFx.ModelWideBinding]] as const)
            {
                it('Related In over an aspect-declared relationship carried by a concept external via ' + label + ' is Unknown', async () =>
                {
                    const g = await FetchedFx.Ready(open, true, bindings);
                    const linkIn = new Related(FetchedFx.Link, EdgeDirection.In, TruePredicate.Instance);
                    assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(linkIn), [FetchedFx.Row(FetchedFx.X)]), [false]);
                    assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(new Not(linkIn)), [FetchedFx.Row(FetchedFx.X)]), [false]);
                    // An engine edge into the stub still makes Related In True (t assigns x), which no external source
                    // can undo; under the model-wide binding assigned's source (Team) may be external too, so only True is
                    // pinned here, not a False.
                    const assignedIn = new Related(FetchedFx.Assigned, EdgeDirection.In, new IdIn(new Set([FetchedFx.T])));
                    assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(assignedIn), [FetchedFx.Row(FetchedFx.X)]), [true]);
                    g.dispose();
                });
            }

            it('Related in over external source is Unknown', async () =>
            {
                const g = await FetchedFx.Ready(open, false);
                const peerIn = new Related(FetchedFx.Peer, EdgeDirection.In, TruePredicate.Instance);
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(peerIn), [FetchedFx.Row(FetchedFx.X)]), [false]);
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(new Not(peerIn)), [FetchedFx.Row(FetchedFx.X)]), [false]);
                g.dispose();
            });

            it('Related in with no possible source is False', async () =>
            {
                const g = await FetchedFx.Ready(open, false);
                const assignedIn = new Related(FetchedFx.Assigned, EdgeDirection.In, TruePredicate.Instance);
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(assignedIn), [FetchedFx.Row(FetchedFx.X)]), [false]);
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(new Not(assignedIn)), [FetchedFx.Row(FetchedFx.X)]), [true]);
                g.dispose();
            });

            it('Reachable without stub is Unknown', async () =>
            {
                const g = await FetchedFx.Ready(open);
                const fromT = new Reachable(new Set([FetchedFx.T]), [{ Relationship: FetchedFx.Assigned, Direction: EdgeDirection.Out }], 1);
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(fromT), [FetchedFx.Row(FetchedFx.Y)]), [false]);
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(new Not(fromT)), [FetchedFx.Row(FetchedFx.Y)]), [false]);
                // Through the stub the engine BFS decides.
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(fromT), [FetchedFx.Row(FetchedFx.X)]), [true]);
                const fromU = new Reachable(new Set([FetchedFx.U]), [{ Relationship: FetchedFx.Assigned, Direction: EdgeDirection.Out }], 1);
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(new Not(fromU)), [FetchedFx.Row(FetchedFx.X)]), [true]);
                g.dispose();
            });

            it('Reachable with id in From', async () =>
            {
                const g = await FetchedFx.Ready(open, false);
                const self = new Reachable(new Set(['a']), [{ Relationship: FetchedFx.Peer, Direction: EdgeDirection.Out }], 2);
                assert.deepEqual(await FetchedFx.Admitted(g, FetchedFx.ServerScope(self), [FetchedFx.Row('a')]), [true]);
                g.dispose();
            });

            it('Default decides when no Rows entry applies', async () =>
            {
                const g = await FetchedFx.Ready(open);
                const deny = FetchedFx.Rows([[FetchedFx.Team, TruePredicate.Instance]], AccessDefault.Deny);
                assert.deepEqual(await FetchedFx.Admitted(g, deny, [FetchedFx.Row('a')]), [false]);
                const allow = FetchedFx.Rows([[FetchedFx.Team, FalsePredicate.Instance]], AccessDefault.Allow);
                assert.deepEqual(await FetchedFx.Admitted(g, allow, [FetchedFx.Row('a')]), [true]);
                g.dispose();
            });

            it('FetchPredicate ands applicable rows', async () =>
            {
                const g = await FetchedFx.Ready(open);
                const cpu = new Compare(FetchedFx.Cpu, CompareOp.Gt, 4n);
                const tag = new Compare(FetchedFx.Tag, CompareOp.Eq, FetchedFx.Core);
                const team = new Compare(FetchedFx.Name, CompareOp.Eq, FetchedFx.Core);
                const scope = FetchedFx.Rows([[FetchedFx.Server, cpu], [FetchedFx.Tagged, tag]]);
                await FetchedFx.Read(g, scope, async r =>
                {
                    const p = r.FetchPredicate(FetchedFx.Server);
                    assert.ok(p instanceof And);
                    assert.deepEqual([...p.Terms], [cpu, tag]);
                    assert.equal(r.FetchPredicate(FetchedFx.Team), TruePredicate.Instance);
                });
                await FetchedFx.Read(g, FetchedFx.Rows([[FetchedFx.Server, cpu], [FetchedFx.Team, team]], AccessDefault.Deny), async r =>
                {
                    assert.equal(r.FetchPredicate(FetchedFx.Server), cpu);
                });
                await FetchedFx.Read(g, FetchedFx.Rows([[FetchedFx.Team, team]], AccessDefault.Deny), async r =>
                {
                    assert.equal(r.FetchPredicate(FetchedFx.Server), FalsePredicate.Instance);
                });
                await FetchedFx.Read(g, AccessScope.System, async r =>
                {
                    assert.equal(r.FetchPredicate(FetchedFx.Server), TruePredicate.Instance);
                });
                g.dispose();
            });

            it('AdmitFetched records the stub binding', async () =>
            {
                const g = await FetchedFx.Ready(open, false);
                const t1 = await g.Begin(AccessScope.System);
                assert.ok((await t1.AdmitFetched(FetchedFx.Row(FetchedFx.X), FetchedFx.Ext)) !== undefined);
                // A concurrent commit creates a node under x's public id (a stub would be one).
                await FetchedFx.Commit(g, t => t.CreateNode(FetchedFx.X, FetchedFx.Team));
                t1.CreateNode('n', FetchedFx.Team);
                await assert.rejects(t1.Commit(), ConflictError);
                g.dispose();
            });
        });
    }
}

after(() => FetchedFx.RemoveDirs());

FetchedFx.Register('memory', () => GraphStore.OpenMemory());
FetchedFx.Register('lmdb', () => GraphStore.OpenLmdb(FetchedFx.Dir()));
