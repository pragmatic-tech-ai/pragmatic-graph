import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AccessDefault, AccessScope, IdIn, MemberKind, type MemberInput } from '../../index.js';
import { CypherFixture } from './CypherFixture.js';

/**
 * Person { name }; Project { name }; edge concept Assignment { role, from -> Person, to -> Project } (single-valued),
 * index AssignmentRole on Assignment(role). Seed alice, p-shown, p-hidden, a1 (alice -> p-shown) and, in the full
 * store only, a2 (alice -> p-hidden).
 */
class EndpointVisFx
{
    public static readonly Person = 'Person';
    public static readonly Project = 'Project';
    public static readonly Assignment = 'Assignment';
    public static readonly Name = 'name';
    public static readonly Role = 'role';
    public static readonly From = 'from';
    public static readonly To = 'to';
    public static readonly Alice = 'alice';
    public static readonly Shown = 'p-shown';
    public static readonly Hidden = 'p-hidden';
    public static readonly A1 = 'a1';
    public static readonly A2 = 'a2';
    public static readonly RoleIndex = 'AssignmentRole';

    public static readonly Queries: readonly string[] = [
        'MATCH (a:Assignment) RETURN a.role AS r ORDER BY r',
        'MATCH (a:Assignment) RETURN count(a) AS c',
        'MATCH (p:Person {name: \'alice\'})<-[:from]-(a) RETURN count(a) AS c',
        'MATCH (a:Assignment)-[:to]->(p) RETURN p.name AS n',
        'MATCH (a:Assignment) WHERE a.role = \'a2\' RETURN a.role AS r',
    ];

    private static Single(name: string, target: string): MemberInput
    {
        return { Name: name, Kind: MemberKind.Relationship, Targets: [target], Many: false, Ordered: false };
    }

    public static Open(withA2: boolean): Promise<CypherFixture>
    {
        const F = CypherFixture;
        const X = EndpointVisFx;
        const edges = [F.Node(X.A1, X.Assignment, { role: X.A1 }, [[X.From, X.Alice], [X.To, X.Shown]])];
        if (withA2)
        {
            edges.push(F.Node(X.A2, X.Assignment, { role: X.A2 }, [[X.From, X.Alice], [X.To, X.Hidden]]));
        }
        return F.Open(
            [
                F.Concept(X.Person, [F.Text(X.Name)]),
                F.Concept(X.Project, [F.Text(X.Name)]),
                F.Concept(X.Assignment, [F.Text(X.Role), X.Single(X.From, X.Person), X.Single(X.To, X.Project)]),
            ],
            [F.Node(X.Alice, X.Person, { name: X.Alice }), F.Node(X.Shown, X.Project, { name: X.Shown }), F.Node(X.Hidden, X.Project, { name: X.Hidden }), ...edges],
            [{ Name: X.RoleIndex, On: X.Assignment, Members: [X.Role] }]);
    }

    public static Edges(): AccessScope
    {
        return AccessScope.Build({
            Default: AccessDefault.Allow,
            Rows: new Map([[EndpointVisFx.Project, new IdIn(new Set([EndpointVisFx.Shown]))]]),
            Endpoints: new Map([[EndpointVisFx.Assignment, { From: EndpointVisFx.From, To: EndpointVisFx.To }]]),
        });
    }
}

describe('a reified edge node with a hidden endpoint reads as absent in Cypher', () =>
{
    let full: CypherFixture;
    let without: CypherFixture;
    before(async () =>
    {
        full = await EndpointVisFx.Open(true);
        without = await EndpointVisFx.Open(false);
    });
    after(async () =>
    {
        await full.dispose();
        await without.dispose();
    });

    test('every query answers as on a store without the edge node', async () =>
    {
        for (const q of EndpointVisFx.Queries)
        {
            assert.deepEqual(await full.Rows(q, EndpointVisFx.Edges()), await without.Rows(q, AccessScope.System), q);
        }
    });
});
