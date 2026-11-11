import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    And,
    BindingTable,
    Compare,
    CompareOp,
    ConnectorError,
    ConnectorPhase,
    GraphEngine,
    GraphError,
    GraphErrorCode,
    IdIn,
    MemberKind,
    Predicate,
    PredicateKind,
    StorageKind,
    ValueType,
    type CatalogSnapshot,
    type CellValue,
    type IFetchTarget,
    type IFetchedRow,
    type ISchemaDescription,
    type RowVersion,
} from '../../index.js';
import { FetchSession } from '../FetchSession.js';
import { FakeExternalConnector } from './FakeExternalConnector.js';

/**
 * Fixtures: Asset { label, weight: Float64, next } with Server { size } and Laptop { ram }; Gadget is an unrelated
 * concept; Tagged is an aspect. Model m1's Assets are bound to ext (its Laptops to own), model m2's Assets to ext.
 */
class SessionFx
{
    public static readonly Ext = 'ext';
    public static readonly Own = 'own';
    public static readonly M1 = 'm1';
    public static readonly M2 = 'm2';
    public static readonly Asset = 'Asset';
    public static readonly Server = 'Server';
    public static readonly Laptop = 'Laptop';
    public static readonly Gadget = 'Gadget';
    public static readonly Tagged = 'Tagged';
    public static readonly Label = 'label';
    public static readonly Next = 'next';
    public static readonly Weight = 'weight';
    public static readonly Size = 'size';
    public static readonly Ram = 'ram';
    private static readonly Version = 'f1';

    public static Description(): ISchemaDescription
    {
        const asset = { Name: SessionFx.Asset, IsAspect: false, Parent: null, Aspects: [], Members: [
            { Name: SessionFx.Label, Kind: MemberKind.Property, Type: ValueType.String, Nullable: true },
            { Name: SessionFx.Weight, Kind: MemberKind.Property, Type: ValueType.Float64, Nullable: true },
            { Name: SessionFx.Next, Kind: MemberKind.Relationship, Targets: [SessionFx.Asset], Many: true },
        ] };
        const sub = (name: string, member: string) => ({ Name: name, IsAspect: false, Parent: SessionFx.Asset, Aspects: [], Members: [
            { Name: member, Kind: MemberKind.Property, Type: ValueType.String, Nullable: true },
        ] });
        return {
            Version: SessionFx.Version,
            Definitions: [
                asset,
                sub(SessionFx.Server, SessionFx.Size),
                sub(SessionFx.Laptop, SessionFx.Ram),
                { Name: SessionFx.Gadget, IsAspect: false, Parent: null, Aspects: [], Members: [] },
                { Name: SessionFx.Tagged, IsAspect: true, Parent: null, Aspects: [], Members: [] },
            ],
            Indexes: [],
            Seed: [],
            Bindings: [
                { Model: SessionFx.M1, Concept: SessionFx.Asset, Connector: SessionFx.Ext },
                { Model: SessionFx.M1, Concept: SessionFx.Laptop, Connector: SessionFx.Own },
                { Model: SessionFx.M2, Concept: SessionFx.Asset, Connector: SessionFx.Ext },
            ],
        };
    }

    public static Row(id: string, concept: string = SessionFx.Server, values: [string, CellValue][] = [[SessionFx.Label, id]]): IFetchedRow
    {
        return { PublicId: id, Concept: concept, Values: new Map(values), Links: new Map() };
    }

    public static Target(concept: string = SessionFx.Asset, model: string = SessionFx.M1): IFetchTarget
    {
        return { Model: model, Concept: concept, Connector: SessionFx.Ext };
    }

    public static Linked(id: string, links: [string, string[]][]): IFetchedRow
    {
        return { ...SessionFx.Row(id), Links: new Map(links) };
    }

    public static async Rows(rows: AsyncIterable<IFetchedRow>): Promise<IFetchedRow[]>
    {
        const out: IFetchedRow[] = [];
        for await (const row of rows)
        {
            out.push(row);
        }
        return out;
    }

    public static async Catalog(): Promise<CatalogSnapshot>
    {
        const connectors = [new FakeExternalConnector(SessionFx.Ext, []), new FakeExternalConnector(SessionFx.Own, [])];
        const engine = await GraphEngine.Open({ Description: SessionFx.Description(), Storage: { Kind: StorageKind.Memory }, Connectors: connectors });
        const catalog = engine.Catalog;
        await engine.dispose();
        return catalog;
    }

    public static async Session(connector: FakeExternalConnector): Promise<FetchSession>
    {
        const catalog = await SessionFx.Catalog();
        const table = new BindingTable(SessionFx.Description().Bindings ?? []);
        return new FetchSession(new Map([[connector.Name, connector]]), table, catalog);
    }

    public static async Drain(rows: AsyncIterable<IFetchedRow>): Promise<string[]>
    {
        const out: string[] = [];
        for await (const row of rows)
        {
            out.push(row.PublicId);
        }
        return out;
    }

    public static IsFetchViolation(e: unknown): boolean
    {
        return e instanceof ConnectorError && e.Phase === ConnectorPhase.Fetch
            && e.cause instanceof GraphError && e.cause.GraphCode === GraphErrorCode.SchemaViolation;
    }

    public static async Rejects(connector: FakeExternalConnector): Promise<void>
    {
        const session = await SessionFx.Session(connector);
        await assert.rejects(SessionFx.Drain(session.Scan(SessionFx.Target(), Predicate.True)), SessionFx.IsFetchViolation);
    }
}

describe('FetchSession', () =>
{
    it('session memoises key lookups', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('x')]]);
        const session = await SessionFx.Session(ext);
        const a = await session.Lookup('x', [SessionFx.Target()]);
        const b = await session.Lookup('x', [SessionFx.Target()]);
        assert.equal(a?.Row.PublicId, 'x');
        assert.equal(a, b);
        assert.equal(ext.Requests.length, 1);
        assert.deepEqual(ext.Requests[0]!.Keys, ['x']);
        assert.equal(await session.Lookup('nope', [SessionFx.Target()]), undefined);
        assert.equal(await session.Lookup('nope', [SessionFx.Target()]), undefined);
        assert.equal(ext.Requests.length, 2);
    });

    it('lookup on a connector without KeyLookup scans the candidate under scope and IdIn, and ignores other ids', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, [], { KeyLookup: false, ReverseLookup: false, PushDown: new Set() });
        // The fake ignores Keys and the predicate: every request is answered with every row.
        ext.Override = () => ({ Rows: [SessionFx.Row('other'), SessionFx.Row('y')] });
        const session = await SessionFx.Session(ext);
        const scope = { RowPredicate: (concept: string) => new Compare(SessionFx.Label, CompareOp.Eq, concept) };
        const found = await session.Lookup('y', [SessionFx.Target()], undefined, scope);
        assert.equal(found?.Row.PublicId, 'y');
        assert.equal(found?.Model, SessionFx.M1);
        assert.equal(ext.Requests.length, 1);
        const request = ext.Requests[0]!;
        assert.equal(request.Keys, undefined);
        assert.equal(request.Predicate.Kind, PredicateKind.And);
        const [scoped, ids] = (request.Predicate as And).Terms;
        assert.ok(scoped instanceof Compare && scoped.Value === SessionFx.Asset);
        assert.ok(ids instanceof IdIn && [...ids.Ids].join() === 'y');
        // The other id was ignored, not memoised: its own lookup fetches.
        ext.Override = () => ({ Rows: [] });
        assert.equal(await session.Lookup('other', [SessionFx.Target()]), undefined);
        assert.equal(ext.Requests.length, 2);
    });

    it('rows from a scan populate the lookup memo', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('a')]]);
        const session = await SessionFx.Session(ext);
        await SessionFx.Drain(session.Scan(SessionFx.Target(), Predicate.True));
        assert.equal((await session.Lookup('a', [SessionFx.Target()]))?.Row.PublicId, 'a');
        assert.equal(ext.Requests.length, 1);
    });

    it('two sessions each fetch', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('a')]]);
        for (let i = 0; i < 2; i++)
        {
            const session = await SessionFx.Session(ext);
            await SessionFx.Drain(session.Scan(SessionFx.Target(), Predicate.True));
        }
        assert.equal(ext.Requests.length, 2);
    });

    it('scan drains resume tokens', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('a'), SessionFx.Row('b')], [SessionFx.Row('c')], [SessionFx.Row('d')]]);
        const session = await SessionFx.Session(ext);
        let ticks = 0;
        const ids = await SessionFx.Drain(session.Scan(SessionFx.Target(), Predicate.True, { Tick: () => { ticks++; } }));
        assert.deepEqual(ids, ['a', 'b', 'c', 'd']);
        assert.equal(ticks, 3 + 4);
        assert.deepEqual(ext.Requests.map(r => r.Resume), [undefined, '1', '2']);
    });

    it('wrong concept fails the query', async () =>
    {
        await SessionFx.Rejects(new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('a', SessionFx.Gadget, [])]]));
        await SessionFx.Rejects(new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('a', SessionFx.Tagged, [])]]));
        await SessionFx.Rejects(new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('a', 'Undefined', [])]]));
    });

    it('mistyped value fails the query', async () =>
    {
        await SessionFx.Rejects(new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('a', SessionFx.Server, [[SessionFx.Label, 5n]])]]));
        await SessionFx.Rejects(new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('a', SessionFx.Server, [[SessionFx.Next, 'x']])]]));
        await SessionFx.Rejects(new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('a', SessionFx.Server, [['unknown', 'x']])]]));
    });

    it('invalid public id fails the query', async () =>
    {
        await SessionFx.Rejects(new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('')]]));
        await SessionFx.Rejects(new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('x'.repeat(401))]]));
    });

    it('a Links key that is not a relationship fails the fetch as a ConnectorError', async () =>
    {
        await SessionFx.Rejects(new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Linked('a', [[SessionFx.Label, ['b']]])]]));
        await SessionFx.Rejects(new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Linked('a', [['unknown', ['b']]])]]));
    });

    it('an invalid link target id fails the fetch as a ConnectorError', async () =>
    {
        await SessionFx.Rejects(new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Linked('a', [[SessionFx.Next, ['x'.repeat(401)]]])]]));
        await SessionFx.Rejects(new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Linked('a', [[SessionFx.Next, ['']]])]]));
    });

    it('an exact Int64 widens into a Float64 member; an inexact one fails the fetch', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('a', SessionFx.Server, [[SessionFx.Weight, 3n]])]]);
        const session = await SessionFx.Session(ext);
        const rows = await SessionFx.Rows(session.Scan(SessionFx.Target(), Predicate.True));
        assert.equal(rows[0]!.Values.get(SessionFx.Weight), 3);
        await SessionFx.Rejects(new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('a', SessionFx.Server, [[SessionFx.Weight, 2n ** 60n + 1n]])]]));
    });

    it('a memo entry serves a scan only for its own model and a concept that IsA the scan\'s', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, []);
        ext.Override = request => ({ Rows: [SessionFx.Row('a', request.Concept === SessionFx.Laptop ? SessionFx.Laptop : SessionFx.Server, [[SessionFx.Label, request.Model + request.Concept]])] });
        const session = await SessionFx.Session(ext);
        assert.equal((await session.Lookup('a', [SessionFx.Target()]))?.Row.Values.get(SessionFx.Label), SessionFx.M1 + SessionFx.Asset);
        // Another model: the scan's own row, the entry kept.
        const other = await SessionFx.Rows(session.Scan(SessionFx.Target(SessionFx.Asset, SessionFx.M2), Predicate.True));
        assert.equal(other[0]!.Values.get(SessionFx.Label), SessionFx.M2 + SessionFx.Asset);
        // The first admitted (model, row) stays the session's.
        assert.equal(session.Known('a')?.Model, SessionFx.M1);
        assert.equal(session.Known('a')?.Row.Values.get(SessionFx.Label), SessionFx.M1 + SessionFx.Asset);
        // A scan the entry serves yields it.
        const same = await SessionFx.Rows(session.Scan(SessionFx.Target(SessionFx.Server), Predicate.True));
        assert.equal(same[0], session.Known('a')?.Row);
        // The entry's model, but its concept (Server) is not a Laptop: the scan's own row (Laptops of m2 are bound to ext).
        const fresh = await SessionFx.Session(ext);
        await SessionFx.Drain(fresh.Scan(SessionFx.Target(SessionFx.Server, SessionFx.M2), Predicate.True));
        const laptops = await SessionFx.Rows(fresh.Scan(SessionFx.Target(SessionFx.Laptop, SessionFx.M2), Predicate.True));
        assert.equal(laptops[0]!.Concept, SessionFx.Laptop);
        assert.equal(fresh.Known('a')?.Row.Concept, SessionFx.Server);
    });

    it('row owned by a more specific binding is dropped', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('a'), SessionFx.Row('l', SessionFx.Laptop), SessionFx.Row('b')]]);
        const session = await SessionFx.Session(ext);
        assert.deepEqual(await SessionFx.Drain(session.Scan(SessionFx.Target(), Predicate.True)), ['a', 'b']);
        assert.equal(await session.Lookup('l', [SessionFx.Target()]), undefined);
    });

    it('fetch failure mid-iteration fails the query', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('a')], [SessionFx.Row('b')]]);
        ext.ThrowAtCall = 2;
        const session = await SessionFx.Session(ext);
        const seen: string[] = [];
        await assert.rejects(async () =>
        {
            for await (const row of session.Scan(SessionFx.Target(), Predicate.True))
            {
                seen.push(row.PublicId);
            }
        }, (e: unknown) => e instanceof ConnectorError && e.Phase === ConnectorPhase.Fetch && e.Connector === SessionFx.Ext && e.cause === ext.Failure);
        assert.deepEqual(seen, ['a']);
    });

    it('lookup wraps a connector failure', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, []);
        ext.ThrowAtCall = 1;
        const session = await SessionFx.Session(ext);
        await assert.rejects(session.Lookup('x', [SessionFx.Target()]), (e: unknown) => e instanceof ConnectorError && e.Phase === ConnectorPhase.Fetch);
    });

    it('reverse without capability scans the target under the predicate and keeps rows linking to the id', async () =>
    {
        const linked = { ...SessionFx.Row('a'), Links: new Map([[SessionFx.Next, ['t']]]) };
        const ext = new FakeExternalConnector(SessionFx.Ext, [[linked, SessionFx.Row('b')]], { KeyLookup: true, ReverseLookup: false, PushDown: new Set() });
        const session = await SessionFx.Session(ext);
        const scope = new Compare(SessionFx.Label, CompareOp.Eq, 'a');
        assert.deepEqual(await SessionFx.Drain(session.Reverse(SessionFx.Target(), SessionFx.Next, 't', scope)), ['a']);
        assert.equal(ext.Requests.length, 1);
        assert.equal(ext.Requests[0]!.Reverse, undefined);
        assert.equal(ext.Requests[0]!.Predicate, scope);
        // Every scanned row was remembered.
        assert.equal(session.Known('b')?.Row.PublicId, 'b');
    });

    it('dropped rows and empty pages tick the probe', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('l', SessionFx.Laptop)], [], [SessionFx.Row('a'), SessionFx.Row('l2', SessionFx.Laptop)]]);
        const session = await SessionFx.Session(ext);
        let ticks = 0;
        const ids = await SessionFx.Drain(session.Scan(SessionFx.Target(), Predicate.True, { Tick: () => { ticks++; } }));
        assert.deepEqual(ids, ['a']);
        assert.equal(ticks, 3 + 3);
    });

    it('lookup and reverse tick the probe per page and per row', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('a'), SessionFx.Row('b')]]);
        const session = await SessionFx.Session(ext);
        let ticks = 0;
        const probe = { Tick: () => { ticks++; } };
        assert.equal((await session.Lookup('a', [SessionFx.Target()], probe))?.Row.PublicId, 'a');
        assert.equal(ticks, 1 + 1);
        ticks = 0;
        assert.deepEqual(await SessionFx.Drain(session.Reverse(SessionFx.Target(), SessionFx.Next, 't', Predicate.True, probe)), ['a', 'b']);
        assert.equal(ticks, 1 + 2);
    });

    it('every fetch kind asks for every property of the target concept family', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('a')]]);
        const session = await SessionFx.Session(ext);
        await SessionFx.Drain(session.Scan(SessionFx.Target(SessionFx.Server), Predicate.True));
        await session.Lookup('b', [SessionFx.Target()]);
        await SessionFx.Drain(session.Reverse(SessionFx.Target(), SessionFx.Next, 't', Predicate.True));
        assert.deepEqual(ext.Requests.map(r => r.Members), [[SessionFx.Label, SessionFx.Weight, SessionFx.Size], [SessionFx.Label, SessionFx.Weight, SessionFx.Size, SessionFx.Ram], [SessionFx.Label, SessionFx.Weight, SessionFx.Size, SessionFx.Ram]]);
    });

    it('a scan after a lookup yields the session row, and a lookup after a scan fetches nothing', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, []);
        ext.Override = request => ({ Rows: [SessionFx.Row('a', SessionFx.Server, [[SessionFx.Label, request.Keys === undefined ? 'scan' : 'key']])] });
        const session = await SessionFx.Session(ext);
        const full = await session.Lookup('a', [SessionFx.Target()]);
        const rows: IFetchedRow[] = [];
        for await (const row of session.Scan(SessionFx.Target(), Predicate.True))
        {
            rows.push(row);
        }
        assert.equal(rows[0], full?.Row);
        assert.equal(rows[0]!.Values.get(SessionFx.Label), 'key');
        assert.equal(await session.Lookup('a', [SessionFx.Target()]), full);
        assert.equal(ext.Requests.length, 2);
    });

    it('lookup ignores rows of other ids without validating or memoising them', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, []);
        ext.Override = () => ({ Rows: [SessionFx.Row('foreign', SessionFx.Gadget, []), SessionFx.Row('a')] });
        const session = await SessionFx.Session(ext);
        assert.equal((await session.Lookup('a', [SessionFx.Target()]))?.Row.PublicId, 'a');
        ext.Override = () => ({ Rows: [] });
        assert.equal(await session.Lookup('foreign', [SessionFx.Target()]), undefined);
        assert.equal(ext.Requests.length, 2);
    });

    it('a scan replaces a memoised miss', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, []);
        ext.Override = request => ({ Rows: request.Keys === undefined ? [SessionFx.Row('z')] : [] });
        const session = await SessionFx.Session(ext);
        assert.equal(await session.Lookup('z', [SessionFx.Target()]), undefined);
        await SessionFx.Drain(session.Scan(SessionFx.Target(), Predicate.True));
        assert.equal((await session.Lookup('z', [SessionFx.Target()]))?.Row.PublicId, 'z');
        assert.equal(ext.Requests.length, 2);
    });

    it('a memo hit that does not satisfy the candidates is not found and not evicted', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('a')]]);
        const session = await SessionFx.Session(ext);
        await SessionFx.Drain(session.Scan(SessionFx.Target(), Predicate.True));
        ext.Override = () => ({ Rows: [] });
        assert.equal(await session.Lookup('a', [SessionFx.Target(SessionFx.Laptop)]), undefined);
        const other: IFetchTarget = { Model: SessionFx.M2, Concept: SessionFx.Asset, Connector: SessionFx.Ext };
        assert.equal(await session.Lookup('a', [other]), undefined);
        assert.equal((await session.Lookup('a', [SessionFx.Target()]))?.Row.PublicId, 'a');
    });

    it('a miss on one candidate does not hide the id from another', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('a')]]);
        const session = await SessionFx.Session(ext);
        const other: IFetchTarget = { Model: SessionFx.M2, Concept: SessionFx.Asset, Connector: SessionFx.Ext };
        ext.Override = request => ({ Rows: request.Model === SessionFx.M1 ? [SessionFx.Row('a')] : [] });
        assert.equal(await session.Lookup('a', [other]), undefined);
        assert.equal(await session.Lookup('a', [other]), undefined);
        assert.equal(ext.Requests.length, 1);
        assert.equal((await session.Lookup('a', [other, SessionFx.Target()]))?.Row.PublicId, 'a');
        assert.equal(ext.Requests.length, 2);
    });

    it('fetched row keeps its version', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, [[{ ...SessionFx.Row('x'), Version: 7n }, { ...SessionFx.Row('n'), Version: null as unknown as RowVersion }]]);
        const session = await SessionFx.Session(ext);
        assert.equal((await session.Lookup('x', [SessionFx.Target()]))?.Row.Version, 7n);
        // A null version reads as absent: the validated row carries no Version key.
        assert.equal('Version' in (await session.Lookup('n', [SessionFx.Target()]))!.Row, false);
    });

    it('invalid version fails the fetch', async () =>
    {
        for (const version of [NaN, Infinity, true, {}] as unknown as RowVersion[])
        {
            const ext = new FakeExternalConnector(SessionFx.Ext, [[{ ...SessionFx.Row('x'), Version: version }]]);
            const session = await SessionFx.Session(ext);
            await assert.rejects(session.Lookup('x', [SessionFx.Target()]), SessionFx.IsFetchViolation);
        }
    });

    it('first fetched version wins', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, [[{ ...SessionFx.Row('x'), Version: 'a' }]]);
        const session = await SessionFx.Session(ext);
        await SessionFx.Drain(session.Scan(SessionFx.Target(), Predicate.True));
        ext.Pages = [[{ ...SessionFx.Row('x'), Version: 'b' }]];
        assert.equal((await session.Lookup('x', [SessionFx.Target()]))?.Row.Version, 'a');
        assert.equal(session.Known('x')?.Row.Version, 'a');
        assert.equal(ext.Requests.length, 1);
    });

    it('reverse with capability fetches and memoises', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('a')]]);
        const session = await SessionFx.Session(ext);
        assert.deepEqual(await SessionFx.Drain(session.Reverse(SessionFx.Target(), SessionFx.Next, 't', Predicate.True)), ['a']);
        assert.deepEqual(ext.Requests[0]!.Reverse, { Relationship: SessionFx.Next, Target: 't' });
        await session.Lookup('a', [SessionFx.Target()]);
        assert.equal(ext.Requests.length, 1);
    });

    it('LookupMany memoises hits and misses', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('a'), SessionFx.Row('b')]]);
        const session = await SessionFx.Session(ext);
        const first = await session.LookupMany(['a', 'nope', 'b'], [SessionFx.Target()]);
        assert.deepEqual([...first.keys()].sort(), ['a', 'b']);
        assert.equal(ext.Requests.length, 1);
        assert.deepEqual(ext.Requests[0]!.Keys, ['a', 'nope', 'b']);
        const again = await session.LookupMany(['b', 'nope', 'a'], [SessionFx.Target()]);
        assert.equal(again.get('a'), first.get('a'));
        assert.equal(again.size, 2);
        assert.equal(ext.Requests.length, 1);
        assert.equal(session.Known('b'), first.get('b'));
    });

    it('LookupMany falls back to one scan without KeyLookup', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, [], { KeyLookup: false, ReverseLookup: false, PushDown: new Set() });
        ext.Override = () => ({ Rows: [SessionFx.Row('other'), SessionFx.Row('y'), SessionFx.Row('z')] });
        const session = await SessionFx.Session(ext);
        const scope = { RowPredicate: (concept: string) => new Compare(SessionFx.Label, CompareOp.Eq, concept) };
        const found = await session.LookupMany(['y', 'z'], [SessionFx.Target()], undefined, scope);
        assert.deepEqual([...found.keys()], ['y', 'z']);
        assert.equal(ext.Requests.length, 1);
        const request = ext.Requests[0]!;
        assert.equal(request.Keys, undefined);
        const [scoped, ids] = (request.Predicate as And).Terms;
        assert.ok(scoped instanceof Compare && scoped.Value === SessionFx.Asset);
        assert.ok(ids instanceof IdIn && [...ids.Ids].join() === 'y,z');
        assert.equal(session.Known('other'), undefined);
    });
});
