import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AccessDefault, AccessScope, FalsePredicate } from '../../index.js';
import { CypherFixture } from './CypherFixture.js';

/**
 * Concept Employee { name, salary, nationalId }; Contractor : Employee; Project { name }; Task { name, about -> Project }.
 * Index EmployeeSalary on Employee(salary). Store A carries salaries, store B is the same seed with none.
 */
class HiddenFx
{
    public static readonly Employee = 'Employee';
    public static readonly Contractor = 'Contractor';
    public static readonly Project = 'Project';
    public static readonly Task = 'Task';
    public static readonly Salary = 'salary';
    public static readonly About = 'about';
    public static readonly Links = 'links';

    public static readonly Queries: readonly string[] = [
        'MATCH (n:Employee) WHERE n.salary > 100000 RETURN n.name AS x ORDER BY x',
        'MATCH (n:Employee) WHERE n.salary IS NULL RETURN n.name AS x ORDER BY x',
        'MATCH (n:Employee) WHERE n.salary IS NOT NULL RETURN n.name AS x ORDER BY x',
        'MATCH (n:Employee) WHERE NOT (n.salary = 200000) RETURN n.name AS x ORDER BY x',
        'MATCH (n:Employee) WHERE n.salary IN [200000, 50000] RETURN n.name AS x ORDER BY x',
        'MATCH (n:Employee) WHERE n.salary = 200000 RETURN n.name AS x',
        'MATCH (n:Employee {salary: 200000}) RETURN n.name AS x',
        'MATCH (n:Employee) RETURN n, n.name AS x ORDER BY n.salary DESC, x',
        'MATCH (n:Employee) RETURN count(n.salary) AS c, sum(n.salary) AS s, min(n.salary) AS lo, max(n.salary) AS hi, avg(n.salary) AS a, collect(n.salary) AS l',
        'MATCH (n:Employee) RETURN coalesce(n.salary, -1) AS v, n.name AS x ORDER BY x',
        'MATCH (n:Employee) WITH n.salary AS s RETURN s, count(*) AS c',
    ];

    public static Open(withSalary: boolean): Promise<CypherFixture>
    {
        const F = CypherFixture;
        const X = HiddenFx;
        const pay = (n: bigint): Record<string, bigint> => (withSalary ? { salary: n } : {});
        return F.Open(
            [
                F.Concept(X.Employee, [F.Text('name'), F.Int(X.Salary), F.Text('nationalId')]),
                F.Concept(X.Contractor, [], X.Employee),
                F.Concept(X.Project, [F.Text('name')]),
                F.Concept(X.Task, [F.Text('name'), F.Rel(X.About, [X.Project])]),
            ],
            [
                F.Node('e1', X.Employee, { name: 'a', ...pay(200000n) }),
                F.Node('e2', X.Employee, { name: 'b' }),
                F.Node('e3', X.Employee, { name: 'c', ...pay(50000n) }),
                F.Node('c1', X.Contractor, { name: 'd', ...pay(70000n) }),
                F.Node('p1', X.Project),
                F.Node('t3', X.Task, {}, [[X.About, 'p1']]),
            ],
            [{ Name: 'EmployeeSalary', On: X.Employee, Members: [X.Salary] }]);
    }

    public static Hiding(exact: boolean): AccessScope
    {
        const hidden = new Map([[exact ? HiddenFx.Contractor : HiddenFx.Employee, new Set([HiddenFx.Salary])]]);
        return AccessScope.Build(exact
            ? { Default: AccessDefault.Allow, HiddenExact: hidden }
            : { Default: AccessDefault.Allow, Hidden: hidden });
    }

    public static Without(concept: string): AccessScope
    {
        return AccessScope.Build({ Default: AccessDefault.Allow, Rows: new Map([[concept, FalsePredicate.Instance]]) });
    }
}

describe('hidden members and records read as absent in Cypher', () =>
{
    let a: CypherFixture;
    let b: CypherFixture;
    before(async () =>
    {
        a = await HiddenFx.Open(true);
        b = await HiddenFx.Open(false);
    });
    after(async () =>
    {
        await a.dispose();
        await b.dispose();
    });

    test('a hidden member answers every query exactly as an absent one', async () =>
    {
        for (const q of HiddenFx.Queries)
        {
            assert.deepEqual(await a.Rows(q, HiddenFx.Hiding(false)), await b.Rows(q, AccessScope.System), q);
        }
    });

    test('HiddenExact hides on the exact concept only', async () =>
    {
        const q = 'MATCH (n:Employee) WHERE n.salary > 60000 RETURN n.name AS x ORDER BY x';
        assert.deepEqual(await a.Column(q, 'x', HiddenFx.Hiding(true)), ['a']);
        assert.deepEqual(await a.Column(q, 'x'), ['a', 'd']);
    });

    test('an incoming edge from an invisible source is neither walked nor counted', async () =>
    {
        const noTasks = HiddenFx.Without(HiddenFx.Task);
        assert.deepEqual(await a.Column('MATCH (p:Project)<-[r]-(t) RETURN count(r) AS c', 'c', noTasks), [0n]);
        assert.deepEqual(await a.Column('MATCH (p:Project)-[r]-(t) RETURN count(t) AS c', 'c', noTasks), [0n]);
        assert.deepEqual(await a.Column('MATCH (p:Project)<-[:about*1..2]-(x) RETURN x', 'x', noTasks), []);

        const noProjects = HiddenFx.Without(HiddenFx.Project);
        assert.deepEqual(await a.Column('MATCH (t:Task) RETURN t', 't', noProjects), ['t3']);
        assert.deepEqual(await a.Read(source => source.OutLinks('t3'), noProjects), []);
        assert.deepEqual(await a.Column('MATCH (t:Task)-[:about]->(p) RETURN p', 'p', noProjects), []);
    });
});
