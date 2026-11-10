import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    BindingTable,
    ConnectorError,
    ConnectorPhase,
    GraphEngine,
    GraphError,
    GraphErrorCode,
    MemberKind,
    Predicate,
    StorageKind,
    ValueType,
    type CatalogSnapshot,
    type CellValue,
    type IFetchTarget,
    type IFetchedRow,
    type ISchemaDescription,
} from '../../index.js';
import { FetchSession } from '../FetchSession.js';
import { FakeExternalConnector } from './FakeExternalConnector.js';

/** Fixtures: Asset { label, next } with Server and Laptop; Gadget is an unrelated concept; Tagged is an aspect. */
class SessionFx
{
    public static readonly Ext = 'ext';
    public static readonly Own = 'own';
    public static readonly M1 = 'm1';
    public static readonly Asset = 'Asset';
    public static readonly Server = 'Server';
    public static readonly Laptop = 'Laptop';
    public static readonly Gadget = 'Gadget';
    public static readonly Tagged = 'Tagged';
    public static readonly Label = 'label';
    public static readonly Next = 'next';
    private static readonly Version = 'f1';

    public static Description(): ISchemaDescription
    {
        const asset = { Name: SessionFx.Asset, IsAspect: false, Parent: null, Aspects: [], Members: [
            { Name: SessionFx.Label, Kind: MemberKind.Property, Type: ValueType.String, Nullable: true },
            { Name: SessionFx.Next, Kind: MemberKind.Relationship, Targets: [SessionFx.Asset], Many: true },
        ] };
        const sub = (name: string) => ({ Name: name, IsAspect: false, Parent: SessionFx.Asset, Aspects: [], Members: [] });
        return {
            Version: SessionFx.Version,
            Definitions: [
                asset,
                sub(SessionFx.Server),
                sub(SessionFx.Laptop),
                { Name: SessionFx.Gadget, IsAspect: false, Parent: null, Aspects: [], Members: [] },
                { Name: SessionFx.Tagged, IsAspect: true, Parent: null, Aspects: [], Members: [] },
            ],
            Indexes: [],
            Seed: [],
            Bindings: [
                { Model: SessionFx.M1, Concept: SessionFx.Asset, Connector: SessionFx.Ext },
                { Model: SessionFx.M1, Concept: SessionFx.Laptop, Connector: SessionFx.Own },
            ],
        };
    }

    public static Row(id: string, concept: string = SessionFx.Server, values: [string, CellValue][] = [[SessionFx.Label, id]]): IFetchedRow
    {
        return { PublicId: id, Concept: concept, Values: new Map(values), Links: new Map() };
    }

    public static Target(concept: string = SessionFx.Asset): IFetchTarget
    {
        return { Model: SessionFx.M1, Concept: concept, Connector: SessionFx.Ext };
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
        await assert.rejects(SessionFx.Drain(session.Scan(SessionFx.Target(), Predicate.True, [SessionFx.Label])), SessionFx.IsFetchViolation);
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
        assert.equal(a?.PublicId, 'x');
        assert.equal(a, b);
        assert.equal(ext.Requests.length, 1);
        assert.deepEqual(ext.Requests[0]!.Keys, ['x']);
        assert.equal(await session.Lookup('nope', [SessionFx.Target()]), undefined);
        assert.equal(await session.Lookup('nope', [SessionFx.Target()]), undefined);
        assert.equal(ext.Requests.length, 2);
    });

    it('lookup asks a connector without KeyLookup and ignores other ids', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, [], { KeyLookup: false, ReverseLookup: false, PushDown: new Set() });
        ext.Override = () => ({ Rows: [SessionFx.Row('other')] });
        const session = await SessionFx.Session(ext);
        assert.equal(await session.Lookup('y', [SessionFx.Target()]), undefined);
        assert.equal(ext.Requests.length, 1);
    });

    it('rows from a scan populate the lookup memo', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('a')]]);
        const session = await SessionFx.Session(ext);
        await SessionFx.Drain(session.Scan(SessionFx.Target(), Predicate.True, [SessionFx.Label]));
        assert.equal((await session.Lookup('a', [SessionFx.Target()]))?.PublicId, 'a');
        assert.equal(ext.Requests.length, 1);
    });

    it('two sessions each fetch', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('a')]]);
        for (let i = 0; i < 2; i++)
        {
            const session = await SessionFx.Session(ext);
            await SessionFx.Drain(session.Scan(SessionFx.Target(), Predicate.True, [SessionFx.Label]));
        }
        assert.equal(ext.Requests.length, 2);
    });

    it('scan drains resume tokens', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('a'), SessionFx.Row('b')], [SessionFx.Row('c')], [SessionFx.Row('d')]]);
        const session = await SessionFx.Session(ext);
        let ticks = 0;
        const ids = await SessionFx.Drain(session.Scan(SessionFx.Target(), Predicate.True, [SessionFx.Label], { Tick: () => { ticks++; } }));
        assert.deepEqual(ids, ['a', 'b', 'c', 'd']);
        assert.equal(ticks, 4);
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

    it('row owned by a more specific binding is dropped', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('a'), SessionFx.Row('l', SessionFx.Laptop), SessionFx.Row('b')]]);
        const session = await SessionFx.Session(ext);
        assert.deepEqual(await SessionFx.Drain(session.Scan(SessionFx.Target(), Predicate.True, [SessionFx.Label])), ['a', 'b']);
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
            for await (const row of session.Scan(SessionFx.Target(), Predicate.True, [SessionFx.Label]))
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

    it('reverse without capability yields nothing', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('a')]], { KeyLookup: true, ReverseLookup: false, PushDown: new Set() });
        const session = await SessionFx.Session(ext);
        assert.deepEqual(await SessionFx.Drain(session.Reverse(SessionFx.Target(), SessionFx.Next, 't')), []);
        assert.equal(ext.Requests.length, 0);
    });

    it('reverse with capability fetches and memoises', async () =>
    {
        const ext = new FakeExternalConnector(SessionFx.Ext, [[SessionFx.Row('a')]]);
        const session = await SessionFx.Session(ext);
        assert.deepEqual(await SessionFx.Drain(session.Reverse(SessionFx.Target(), SessionFx.Next, 't')), ['a']);
        assert.deepEqual(ext.Requests[0]!.Reverse, { Relationship: SessionFx.Next, Target: 't' });
        await session.Lookup('a', [SessionFx.Target()]);
        assert.equal(ext.Requests.length, 1);
    });
});
