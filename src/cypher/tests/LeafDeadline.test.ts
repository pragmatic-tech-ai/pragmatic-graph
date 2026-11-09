import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AccessDefault, AccessScope, TruePredicate, type CellValue, type ISeedNode } from '../../index.js';
import { Binding } from '../Binding.js';
import { CypherEngine } from '../CypherEngine.js';
import { RelDirection } from '../CypherEnums.js';
import { CypherTimeout } from '../CypherError.js';
import type { CypherNode } from '../CypherNode.js';
import { NodeValue } from '../CypherValue.js';
import type { ICancellation } from '../ExecutionLimits.js';
import { Literal } from '../Expression.js';
import { AllNodesScan } from '../operators/AllNodesScan.js';
import { BindingRows } from '../operators/BindingRows.js';
import { Expand } from '../operators/Expand.js';
import { ExpandInto } from '../operators/ExpandInto.js';
import { IndexSeek } from '../operators/IndexSeek.js';
import type { IOperator } from '../operators/IOperator.js';
import { LabelScan } from '../operators/LabelScan.js';
import { ReaderSource } from '../ReaderSource.js';
import type { GraphReader } from '../../GraphReader.js';
import { CypherFixture } from './CypherFixture.js';

/** Counts Expired() calls; expires once more than `budget` checks have passed. */
class CountingCancellation implements ICancellation
{
    public Calls = 0;

    constructor(private readonly budget: number = Number.POSITIVE_INFINITY)
    {
    }

    public Expired(): boolean
    {
        this.Calls++;
        return this.Calls > this.budget;
    }
}

/** A source whose index answers are withdrawn at run time (IndexSeek's fallback scan). */
class NoSeekSource extends ReaderSource
{
    public override SeekEqual(_label: string, _member: string, _value: CellValue): undefined
    {
        return undefined;
    }
}

/** 1500 Service nodes all named 'x' (index by_name), hub -calls-> each of them. */
class WideFixture
{
    public static readonly Count = 1500;

    public static Open(): Promise<CypherFixture>
    {
        const F = CypherFixture;
        const seed: ISeedNode[] = [];
        const links: [string, string][] = [];
        for (let i = 0; i < WideFixture.Count; i++)
        {
            seed.push(F.Node(`n${i}`, 'Service', { name: 'x' }));
            links.push(['calls', `n${i}`]);
        }
        seed.push(F.Node('hub', 'Hub', {}, links));
        return CypherFixture.Open(
            [F.Concept('Service', [F.Text('name')]), F.Concept('Hub', [F.Rel('calls', ['Service'])])],
            seed,
            [{ Name: 'by_name', On: 'Service', Members: ['name'] }]);
    }

    /** Drains the operator without keeping a row (as a Filter rejecting everything would). */
    public static async Drain(op: IOperator): Promise<void>
    {
        for await (const _ of op.Rows())
        {
            // discard
        }
    }

    public static async Bound(source: ReaderSource, ...ids: string[]): Promise<BindingRows>
    {
        let row = new Binding();
        for (const id of ids)
        {
            row = row.With(id, new NodeValue((await source.Node(id)) as CypherNode));
        }
        return new BindingRows([row]);
    }
}

describe('leaf operators honour the deadline per node read', () =>
{
    let fx: CypherFixture;
    before(async () => { fx = await WideFixture.Open(); });
    after(() => fx.dispose());

    const cases: [string, (s: ReaderSource, c: ICancellation) => Promise<IOperator>][] = [
        ['LabelScan', async (s, c) => new LabelScan(s, 'a', 'Service', c)],
        ['AllNodesScan', async (s, c) => new AllNodesScan(s, 'a', c)],
        ['IndexSeek', async (s, c) => new IndexSeek(s, 'a', 'Service', 'name', 'by_name', new Literal('x'), new Map(), c)],
        ['Expand', async (s, c) => new Expand(await WideFixture.Bound(s, 'hub'), s, 'hub', 'b', 'calls', RelDirection.Outgoing, undefined, undefined, c)],
        ['ExpandInto', async (s, c) => new ExpandInto(await WideFixture.Bound(s, 'hub', `n${WideFixture.Count - 1}`), s, 'hub', `n${WideFixture.Count - 1}`, 'calls', RelDirection.Outgoing, undefined, c)],
    ];
    for (const [name, build] of cases)
    {
        test(`${name}: an expired token aborts before the first read; a token expiring mid-read aborts the read`, async () =>
        {
            await fx.Read(async (s) =>
            {
                await assert.rejects(WideFixture.Drain(await build(s as ReaderSource, new CountingCancellation(0))), CypherTimeout);
                const counting = new CountingCancellation();
                await WideFixture.Drain(await build(s as ReaderSource, counting));
                assert.ok(counting.Calls >= 2, `${name} checked ${counting.Calls} times`);
                await assert.rejects(WideFixture.Drain(await build(s as ReaderSource, new CountingCancellation(1))), CypherTimeout);
            });
        });
    }

    // Only the hub is visible: every Service slot, index entry and edge is examined and filtered out inside the
    // reader, so no row ever reaches the operator; the deadline must still fire.
    for (const [name, build] of cases)
    {
        test(`${name}: a token expiring mid-read aborts even when the scope hides every row`, async () =>
        {
            const scope = AccessScope.Build({ Default: AccessDefault.Deny, Rows: new Map([['Hub', TruePredicate.Instance]]) });
            const reader = await fx.Engine.BeginRead(scope);
            try
            {
                const source = new ReaderSource(reader);
                const counting = new CountingCancellation();
                await WideFixture.Drain(await build(source, counting));
                assert.ok(counting.Calls >= 2, `${name} checked ${counting.Calls} times`);
                await assert.rejects(WideFixture.Drain(await build(source, new CountingCancellation(1))), CypherTimeout);
            }
            finally
            {
                reader.dispose();
            }
        });
    }

    test('IndexSeek fallback scan ticks per node read', async () =>
    {
        const reader = await fx.Engine.BeginRead(AccessScope.System);
        try
        {
            const source = new NoSeekSource(reader);
            const seek = (c: ICancellation): IndexSeek => new IndexSeek(source, 'a', 'Service', 'name', 'by_name', new Literal('none'), new Map(), c);
            const counting = new CountingCancellation();
            await WideFixture.Drain(seek(counting));
            assert.ok(counting.Calls >= 2);
            await assert.rejects(WideFixture.Drain(seek(new CountingCancellation(1))), CypherTimeout);
        }
        finally
        {
            reader.dispose();
        }
    });

    test('a filtered full scan through CypherEngine times out and disposes the reader', async () =>
    {
        const engine = fx.Engine;
        const readers: GraphReader[] = [];
        const begin = engine.BeginRead.bind(engine);
        engine.BeginRead = async (scope: AccessScope) =>
        {
            const r = await begin(scope);
            readers.push(r);
            return r;
        };
        try
        {
            const cypher = new CypherEngine(engine);
            const q = "MATCH (a:Service) WHERE a.name <> 'x' RETURN a.name";
            const calibrate = new CountingCancellation();
            assert.equal((await cypher.Execute(AccessScope.System, q, { Limits: { Cancel: calibrate } })).Rows.length, 0);
            // Collect.Begin and the scan's Begin, then the scan's own tick at the 1000th node (no row reaches Collect).
            assert.ok(calibrate.Calls >= 3, `checked ${calibrate.Calls} times`);
            await assert.rejects(cypher.Execute(AccessScope.System, q, { Limits: { Cancel: new CountingCancellation(2) } }), CypherTimeout);
            for (const reader of readers)
            {
                await assert.rejects(reader.ReadNode('n0'), /disposed/);
            }
        }
        finally
        {
            engine.BeginRead = begin;
        }
    });
});
