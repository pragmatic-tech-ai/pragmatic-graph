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
    public static readonly Name = 'name';
    public static readonly NationalId = 'nationalId';
    public static readonly SalaryIndex = 'EmployeeSalary';
    public static readonly NameA = 'a';
    public static readonly NameB = 'b';
    public static readonly NameC = 'c';
    public static readonly NameD = 'd';
    public static readonly E1 = 'e1';
    public static readonly E2 = 'e2';
    public static readonly E3 = 'e3';
    public static readonly C1 = 'c1';
    public static readonly P1 = 'p1';
    public static readonly T3 = 't3';
    public static readonly X = 'x';
    public static readonly C = 'c';
    public static readonly T = 't';
    public static readonly P = 'p';

    public static readonly AboveSixty = 'MATCH (n:Employee) WHERE n.salary > 60000 RETURN n.name AS x ORDER BY x';
    public static readonly IncomingCount = 'MATCH (p:Project)<-[r]-(t) RETURN count(r) AS c';
    public static readonly EitherCount = 'MATCH (p:Project)-[r]-(t) RETURN count(t) AS c';
    public static readonly VarLength = 'MATCH (p:Project)<-[:about*1..2]-(x) RETURN x';
    public static readonly AllTasks = 'MATCH (t:Task) RETURN t';
    public static readonly TaskProjects = 'MATCH (t:Task)-[:about]->(p) RETURN p';

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
        return F.Open(
            [
                F.Concept(X.Employee, [F.Text(X.Name), F.Int(X.Salary), F.Text(X.NationalId)]),
                F.Concept(X.Contractor, [], X.Employee),
                F.Concept(X.Project, [F.Text(X.Name)]),
                F.Concept(X.Task, [F.Text(X.Name), F.Rel(X.About, [X.Project])]),
            ],
            [
                F.Node(X.E1, X.Employee, { name: X.NameA, ...X.Pay(withSalary, 200000n) }),
                F.Node(X.E2, X.Employee, { name: X.NameB }),
                F.Node(X.E3, X.Employee, { name: X.NameC, ...X.Pay(withSalary, 50000n) }),
                F.Node(X.C1, X.Contractor, { name: X.NameD, ...X.Pay(withSalary, 70000n) }),
                F.Node(X.P1, X.Project),
                F.Node(X.T3, X.Task, {}, [[X.About, X.P1]]),
            ],
            [{ Name: X.SalaryIndex, On: X.Employee, Members: [X.Salary] }]);
    }

    private static Pay(withSalary: boolean, amount: bigint): Record<string, bigint>
    {
        return withSalary ? { [HiddenFx.Salary]: amount } : {};
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
        const X = HiddenFx;
        assert.deepEqual(await a.Column(X.AboveSixty, X.X, X.Hiding(true)), [X.NameA]);
        assert.deepEqual(await a.Column(X.AboveSixty, X.X), [X.NameA, X.NameD]);
    });

    test('an incoming edge from an invisible source is neither walked nor counted', async () =>
    {
        const X = HiddenFx;
        const noTasks = X.Without(X.Task);
        assert.deepEqual(await a.Column(X.IncomingCount, X.C, noTasks), [0n]);
        assert.deepEqual(await a.Column(X.EitherCount, X.C, noTasks), [0n]);
        assert.deepEqual(await a.Column(X.VarLength, X.X, noTasks), []);

        const noProjects = X.Without(X.Project);
        assert.deepEqual(await a.Column(X.AllTasks, X.T, noProjects), [X.T3]);
        assert.deepEqual(await a.Read(source => source.OutLinks(X.T3), noProjects), []);
        assert.deepEqual(await a.Column(X.TaskProjects, X.P, noProjects), []);
    });
});
