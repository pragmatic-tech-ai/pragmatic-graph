import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemberInput } from '../../catalog/CatalogTypes.js';
import { MemberKind, ValueType } from '../../catalog/ValueType.js';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';
import { GraphStore } from '../../GraphStore.js';
import type { GraphTransaction } from '../../GraphTransaction.js';
import { Compare, CompareOp, FalsePredicate, IdIn, type Predicate, TruePredicate } from '../../predicate/Predicate.js';
import type { ISchemaDescription } from '../../schema/SchemaDescription.js';
import { AccessError, AccessErrorCode } from '../AccessError.js';
import { AccessDefault, AccessScope, type IEndpointMembers, type IWriteRules } from '../AccessScope.js';

/**
 * Project { name }; Person { name }; edge concept Assignment { role, from -> Person, to -> Project (single-valued), cc -> Person* };
 * Contract : Assignment. Seed: alice, p-shown, p-hidden, p-two, a1 (alice -> p-shown), a2 (alice -> p-hidden).
 */
class EndpointFx
{
    private static readonly DirPrefix = 'pragmatic-graph-endpoint-scope-';
    private static readonly Dirs: string[] = [];
    public static readonly Project = 'Project';
    public static readonly Person = 'Person';
    public static readonly Assignment = 'Assignment';
    public static readonly Contract = 'Contract';
    public static readonly Name = 'name';
    public static readonly Role = 'role';
    public static readonly From = 'from';
    public static readonly To = 'to';
    public static readonly Cc = 'cc';
    public static readonly Ok = 'ok';
    public static readonly No = 'no';
    public static readonly Lead = 'lead';
    public static readonly Alice = 'alice';
    public static readonly Shown = 'p-shown';
    public static readonly Hidden = 'p-hidden';
    public static readonly Two = 'p-two';
    public static readonly A1 = 'a1';
    public static readonly A2 = 'a2';
    public static readonly A3 = 'a3';
    public static readonly Bob = 'bob';
    public static readonly NoSuch = 'nosuch';
    public static readonly EndpointsLabel = 'Endpoints';
    public static readonly Members: IEndpointMembers = { From: EndpointFx.From, To: EndpointFx.To };

    public static Dir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), EndpointFx.DirPrefix));
        EndpointFx.Dirs.push(dir);
        return dir;
    }

    public static RemoveDirs(): void
    {
        for (const d of EndpointFx.Dirs)
        {
            rmSync(d, { recursive: true, force: true });
        }
    }

    private static Prop(name: string): MemberInput
    {
        return { Name: name, Kind: MemberKind.Property, Type: ValueType.String, Nullable: true };
    }

    private static Rel(name: string, target: string, many = false): MemberInput
    {
        return { Name: name, Kind: MemberKind.Relationship, Targets: [target], Many: many, Ordered: false };
    }

    public static Description(): ISchemaDescription
    {
        const X = EndpointFx;
        const node = (id: string, concept: string, links: [string, string][] = []) =>
            ({ PublicId: id, Concept: concept, Owner: '', Properties: { [concept === X.Assignment ? X.Role : X.Name]: id }, Links: links.map(([r, to]) => ({ Relationship: r, To: to })) });
        return {
            Version: 'v1',
            Definitions: [
                { Name: X.Project, IsAspect: false, Parent: null, Aspects: [], Members: [X.Prop(X.Name)] },
                { Name: X.Person, IsAspect: false, Parent: null, Aspects: [], Members: [X.Prop(X.Name)] },
                { Name: X.Assignment, IsAspect: false, Parent: null, Aspects: [], Members: [X.Prop(X.Role), X.Rel(X.From, X.Person), X.Rel(X.To, X.Project), X.Rel(X.Cc, X.Person, true)] },
                { Name: X.Contract, IsAspect: false, Parent: X.Assignment, Aspects: [], Members: [] },
            ],
            Indexes: [],
            Seed: [
                node(X.Alice, X.Person), node(X.Shown, X.Project), node(X.Hidden, X.Project), node(X.Two, X.Project),
                node(X.A1, X.Assignment, [[X.From, X.Alice], [X.To, X.Shown]]),
                node(X.A2, X.Assignment, [[X.From, X.Alice], [X.To, X.Hidden]]),
            ],
            Bindings: [],
        };
    }

    /** Default Allow; Rows show only `projects`; Assignment follows its endpoints. */
    public static Edges(writes: ReadonlyArray<readonly [string, IWriteRules]> = [], projects: readonly string[] = [EndpointFx.Shown]): AccessScope
    {
        return AccessScope.Build({
            Default: AccessDefault.Allow,
            Rows: new Map<string, Predicate>([[EndpointFx.Project, new IdIn(new Set(projects))]]),
            Endpoints: new Map([[EndpointFx.Assignment, EndpointFx.Members]]),
            Writes: new Map(writes),
        });
    }

    /** Append on Person and AppendTo on Project hold iff the node is named 'ok'. */
    public static OkRules(): ReadonlyArray<readonly [string, IWriteRules]>
    {
        const ok = new Compare(EndpointFx.Name, CompareOp.Eq, EndpointFx.Ok);
        return [[EndpointFx.Person, { Append: ok }], [EndpointFx.Project, { AppendTo: ok }]];
    }

    public static async Try(g: GraphStore, scope: AccessScope, build: (t: GraphTransaction) => void): Promise<unknown>
    {
        try
        {
            const t = await g.Begin(scope);
            build(t);
            return await t.Commit();
        }
        catch (error)
        {
            return error;
        }
    }

    public static async Rename(g: GraphStore, id: string, name: string): Promise<void>
    {
        EndpointFx.Allowed(await EndpointFx.Try(g, AccessScope.System, t => t.SetProperty(id, EndpointFx.Name, name)));
    }

    public static Denied(result: unknown, code: AccessErrorCode, ...parts: string[]): void
    {
        assert.ok(result instanceof AccessError, 'expected an AccessError, got ' + String(result));
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

    public static Register(name: string, open: () => Promise<GraphStore>): void
    {
        const X = EndpointFx;
        const ready = async (): Promise<GraphStore> =>
        {
            const g = await open();
            await g.Upgrade(X.Description());
            return g;
        };
        const create = (t: GraphTransaction): void =>
        {
            t.CreateNode(X.A3, X.Assignment);
            t.Link(X.A3, X.From, X.Alice);
            t.Link(X.A3, X.To, X.Shown);
        };
        const relink = (t: GraphTransaction): void =>
        {
            t.Unlink(X.A1, X.To, X.Shown);
            t.Link(X.A1, X.To, X.Two);
        };
        describe('endpoint scope on ' + name, () =>
        {
            it('a reified edge node with a hidden endpoint does not exist', async () =>
            {
                const g = await ready();
                const scope = X.Edges();
                assert.equal(scope.ReadsUnrestricted, false);
                const r = await g.BeginRead(scope);
                try
                {
                    assert.equal(await r.ConceptOf(X.A2), undefined);
                    assert.equal(await r.ConceptOf(X.A1), X.Assignment);
                    await assert.rejects(r.EstimateCount(X.Assignment), e => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument);
                }
                finally
                {
                    r.dispose();
                }
                await g.dispose();
            });

            it('endpoint rules govern create, delete and relink', async () =>
            {
                const g = await ready();
                const scope = X.Edges(X.OkRules());
                const relinkScope = X.Edges(X.OkRules(), [X.Shown, X.Two]);
                X.Denied(await X.Try(g, scope, create), AccessErrorCode.AppendDenied, 'op 1', X.Alice);
                X.Denied(await X.Try(g, scope, t => t.DeleteNode(X.A1)), AccessErrorCode.AppendDenied, X.Alice);
                await X.Rename(g, X.Alice, X.Ok);
                X.Denied(await X.Try(g, scope, create), AccessErrorCode.AppendToDenied, 'op 2', X.Shown);
                X.Denied(await X.Try(g, scope, t => t.DeleteNode(X.A1)), AccessErrorCode.AppendToDenied, X.Shown);
                await X.Rename(g, X.Shown, X.Ok);
                X.Allowed(await X.Try(g, scope, create));
                // Relink a1.to: the Unlink needs AppendTo on the old target, the Link on the new one.
                X.Denied(await X.Try(g, relinkScope, relink), AccessErrorCode.AppendToDenied, 'op 1', X.Two);
                await X.Rename(g, X.Shown, X.No);
                await X.Rename(g, X.Two, X.Ok);
                X.Denied(await X.Try(g, relinkScope, relink), AccessErrorCode.AppendToDenied, 'op 0', X.Shown);
                await X.Rename(g, X.Shown, X.Ok);
                X.Allowed(await X.Try(g, relinkScope, relink));
                X.Allowed(await X.Try(g, relinkScope, t => t.DeleteNode(X.A1)));
                await g.dispose();
            });

            it('an attribute update needs Append on From', async () =>
            {
                const g = await ready();
                const scope = X.Edges(X.OkRules());
                const update = (t: GraphTransaction): void => t.SetProperty(X.A1, X.Role, X.Lead);
                X.Denied(await X.Try(g, scope, update), AccessErrorCode.AppendDenied, X.Alice);
                await X.Rename(g, X.Alice, X.Ok);
                // p-shown fails AppendTo: the To node is not consulted.
                X.Allowed(await X.Try(g, scope, update));
                await g.dispose();
            });

            it('a created endpoint is exempt', async () =>
            {
                const g = await ready();
                await X.Rename(g, X.Shown, X.Ok);
                X.Allowed(await X.Try(g, X.Edges([[X.Person, { Append: FalsePredicate.Instance }], [X.Project, { AppendTo: new Compare(X.Name, CompareOp.Eq, X.Ok) }]]), t =>
                {
                    t.CreateNode(X.Bob, X.Person);
                    t.CreateNode(X.A3, X.Assignment);
                    t.Link(X.A3, X.From, X.Bob);
                    t.Link(X.A3, X.To, X.Shown);
                }));
                await g.dispose();
            });

            it('deleting an endpoint detaches its edge nodes under the Delete rule alone', async () =>
            {
                const g = await ready();
                const scope = X.Edges([[X.Person, { Append: FalsePredicate.Instance, Delete: TruePredicate.Instance }]]);
                X.Allowed(await X.Try(g, scope, t =>
                {
                    t.DetachUnlink(X.A1, X.From, X.Alice);
                    t.DeleteNode(X.Alice);
                }));
                await g.dispose();
            });

            it('Endpoints entries are validated at Begin', async () =>
            {
                const g = await ready();
                const invalid = (e: unknown): boolean => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument && e.message.includes(X.EndpointsLabel);
                const bad: ReadonlyArray<ReadonlyArray<readonly [string, IEndpointMembers]>> = [
                    [[X.Assignment, { From: X.NoSuch, To: X.To }]],
                    [[X.Assignment, { From: X.To, To: X.To }]],
                    [[X.Assignment, { From: X.Cc, To: X.To }]],
                    [[X.Assignment, X.Members], [X.Contract, { From: X.To, To: X.From }]],
                ];
                for (const entries of bad)
                {
                    await assert.rejects(g.Begin(AccessScope.Build({ Default: AccessDefault.Allow, Endpoints: new Map(entries) })), invalid);
                }
                await g.dispose();
            });
        });
    }
}

EndpointFx.Register('memory', () => GraphStore.OpenMemory());
EndpointFx.Register('lmdb', () => GraphStore.OpenLmdb(EndpointFx.Dir()));

after(() => EndpointFx.RemoveDirs());
