import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    AccessScope,
    BindingTable,
    ConnectorResidency,
    GraphEngine,
    GraphError,
    GraphErrorCode,
    MemberKind,
    StorageKind,
    ValueType,
    type IBindingDescription,
    type IDefinitionDescription,
    type IExternalConnector,
    type IGraphConnector,
    type ISchemaDescription,
} from '../../index.js';
import { EngineDescriptions } from '../../tests/EngineDescriptions.js';
import { FakeConnector } from './FakeConnector.js';

/** Fixtures: Asset { Server, Laptop }, with external bindings in several models. */
class FetchFx
{
    public static readonly Ext = 'ext';
    public static readonly Other = 'other';
    public static readonly Crm = 'crm';
    public static readonly Sys = 'sys';
    public static readonly Asset = 'Asset';
    public static readonly Server = 'Server';
    public static readonly Laptop = 'Laptop';
    public static readonly M1 = 'm1';
    public static readonly M2 = 'm2';
    public static readonly M3 = 'm3';
    public static readonly M4 = 'm4';
    public static readonly V1 = 'f1';
    public static readonly V2 = 'f2';
    public static readonly NodeId = 'n1';
    private static readonly Label = 'label';
    public static readonly BeginRefused = 'read-only connector: Begin refused';

    public static Concept(name: string, parent: string | null): IDefinitionDescription
    {
        return { Name: name, IsAspect: false, Parent: parent, Aspects: [], Members: parent === null ? [{ Name: FetchFx.Label, Kind: MemberKind.Property, Type: ValueType.String, Nullable: true }] : [] };
    }

    public static Description(bindings: readonly IBindingDescription[], defaultConnector?: string, version: string = FetchFx.V1): ISchemaDescription
    {
        return {
            Version: version,
            Definitions: [FetchFx.Concept(FetchFx.Asset, null), FetchFx.Concept(FetchFx.Server, FetchFx.Asset), FetchFx.Concept(FetchFx.Laptop, FetchFx.Asset)],
            Indexes: [],
            Seed: [],
            Bindings: bindings,
            ...(defaultConnector === undefined ? {} : { DefaultConnector: defaultConnector }),
        };
    }

    public static External(name: string): IExternalConnector
    {
        return {
            Name: name,
            Residency: ConnectorResidency.External,
            Capabilities: { KeyLookup: false, ReverseLookup: false, PushDown: new Set() },
            Begin: () => Promise.reject(new Error(FetchFx.BeginRefused)),
            Fetch: () => Promise.resolve({ Rows: [] }),
        };
    }

    public static IsInvalidArgument(e: unknown): boolean
    {
        return e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument;
    }

    public static Open(description: ISchemaDescription, connectors: readonly IGraphConnector[]): Promise<GraphEngine>
    {
        return GraphEngine.Open({ Description: description, Storage: { Kind: StorageKind.Memory }, Connectors: connectors });
    }

    /** Creates an item owned by `sys` in an engine opened from the EngineDescriptions schema. */
    public static async CreateItem(engine: GraphEngine): Promise<void>
    {
        const tx = await engine.Begin(AccessScope.System);
        tx.CreateNode(FetchFx.NodeId, EngineDescriptions.Item, { Owner: FetchFx.Sys });
        await tx.Commit();
    }
}

describe('Connector read contract', () =>
{
    it('open rejects an external default connector', async () =>
    {
        await assert.rejects(FetchFx.Open(FetchFx.Description([], FetchFx.Ext), [FetchFx.External(FetchFx.Ext)]), FetchFx.IsInvalidArgument);
    });

    it('open rejects external residency without Fetch', async () =>
    {
        const bad = { Name: FetchFx.Ext, Residency: ConnectorResidency.External, Begin: () => Promise.reject(new Error(FetchFx.BeginRefused)) } as IGraphConnector;
        const description = FetchFx.Description([{ Model: FetchFx.M1, Concept: FetchFx.Server, Connector: FetchFx.Ext }]);
        await assert.rejects(FetchFx.Open(description, [bad]), FetchFx.IsInvalidArgument);
    });

    it('hot upgrade rejects an external default connector', async () =>
    {
        const bindings = [{ Model: FetchFx.M1, Concept: FetchFx.Server, Connector: FetchFx.Ext }];
        const engine = await FetchFx.Open(FetchFx.Description(bindings), [FetchFx.External(FetchFx.Ext)]);
        try
        {
            await assert.rejects(engine.Upgrade(FetchFx.Description(bindings, FetchFx.Ext, FetchFx.V2)), FetchFx.IsInvalidArgument);
            assert.equal(engine.SchemaVersion, FetchFx.V1);
        }
        finally
        {
            await engine.dispose();
        }
    });

    it('mirrored is the default residency', async () =>
    {
        const log: string[] = [];
        const crm = new FakeConnector(FetchFx.Crm, log);
        assert.equal((crm as IGraphConnector).Residency, undefined);
        const engine = await FetchFx.Open(EngineDescriptions.Desc(FetchFx.V1, true, [{ Model: FetchFx.Sys, Connector: FetchFx.Crm }]), [crm]);
        try
        {
            await FetchFx.CreateItem(engine);
            assert.deepEqual(log, ['crm.Begin', 'crm.Apply', 'crm.Commit']);
        }
        finally
        {
            await engine.dispose();
        }
    });

    it('ExternalTargets covers subtypes, ancestors and model-wide', async () =>
    {
        const bindings: IBindingDescription[] = [
            { Model: FetchFx.M1, Concept: FetchFx.Server, Connector: FetchFx.Ext },
            { Model: FetchFx.M2, Concept: FetchFx.Asset, Connector: FetchFx.Ext },
            { Model: FetchFx.M3, Connector: FetchFx.Ext },
            { Model: FetchFx.M4, Concept: FetchFx.Server, Connector: FetchFx.Other },
        ];
        const engine = await FetchFx.Open(FetchFx.Description(bindings), [FetchFx.External(FetchFx.Ext), new FakeConnector(FetchFx.Other, [])]);
        try
        {
            const table = new BindingTable(bindings);
            const external = new Set([FetchFx.Ext]);
            const target = (model: string, concept: string): object => ({ Model: model, Concept: concept, Connector: FetchFx.Ext });
            assert.deepEqual(table.ExternalTargets(FetchFx.Server, engine.Catalog, external), [
                target(FetchFx.M1, FetchFx.Server), target(FetchFx.M2, FetchFx.Server), target(FetchFx.M3, FetchFx.Server),
            ]);
            assert.deepEqual(table.ExternalTargets(FetchFx.Laptop, engine.Catalog, external), [
                target(FetchFx.M2, FetchFx.Laptop), target(FetchFx.M3, FetchFx.Laptop),
            ]);
            assert.deepEqual(table.ExternalTargets(FetchFx.Asset, engine.Catalog, external), [
                target(FetchFx.M1, FetchFx.Server), target(FetchFx.M2, FetchFx.Asset), target(FetchFx.M3, FetchFx.Asset),
            ]);
            assert.equal(table.IsStub(FetchFx.M1, FetchFx.Server, engine.Catalog, external), true);
            assert.equal(table.IsStub(FetchFx.M1, FetchFx.Laptop, engine.Catalog, external), false);
            assert.equal(table.IsStub(FetchFx.M4, FetchFx.Server, engine.Catalog, external), false);
        }
        finally
        {
            await engine.dispose();
        }
    });

    it('overlapping targets on one connector collapse', async () =>
    {
        const bindings: IBindingDescription[] = [
            { Model: FetchFx.M1, Concept: FetchFx.Server, Connector: FetchFx.Ext },
            { Model: FetchFx.M1, Concept: FetchFx.Asset, Connector: FetchFx.Ext },
        ];
        const engine = await FetchFx.Open(FetchFx.Description(bindings), [FetchFx.External(FetchFx.Ext)]);
        try
        {
            const table = new BindingTable(bindings);
            const targets = table.ExternalTargets(FetchFx.Asset, engine.Catalog, new Set([FetchFx.Ext]));
            assert.deepEqual(targets, [{ Model: FetchFx.M1, Concept: FetchFx.Asset, Connector: FetchFx.Ext }]);
        }
        finally
        {
            await engine.dispose();
        }
    });

    it('different connectors keep both', async () =>
    {
        const bindings: IBindingDescription[] = [
            { Model: FetchFx.M1, Concept: FetchFx.Server, Connector: FetchFx.Other },
            { Model: FetchFx.M1, Concept: FetchFx.Asset, Connector: FetchFx.Ext },
        ];
        const engine = await FetchFx.Open(FetchFx.Description(bindings), [FetchFx.External(FetchFx.Ext), FetchFx.External(FetchFx.Other)]);
        try
        {
            const table = new BindingTable(bindings);
            const targets = table.ExternalTargets(FetchFx.Asset, engine.Catalog, new Set([FetchFx.Ext, FetchFx.Other]));
            assert.deepEqual(targets.map(t => `${t.Concept}:${t.Connector}`), [`${FetchFx.Asset}:${FetchFx.Ext}`, `${FetchFx.Server}:${FetchFx.Other}`]);
        }
        finally
        {
            await engine.dispose();
        }
    });

    it('the nearest ancestor binding wins', async () =>
    {
        const description = {
            ...FetchFx.Description([]),
            Definitions: [FetchFx.Concept(FetchFx.Asset, null), FetchFx.Concept(FetchFx.Server, FetchFx.Asset), FetchFx.Concept(FetchFx.Laptop, FetchFx.Server)],
        };
        const engine = await FetchFx.Open(description, []);
        try
        {
            const order = [
                { Model: FetchFx.M1, Concept: FetchFx.Asset, Connector: FetchFx.Other },
                { Model: FetchFx.M1, Concept: FetchFx.Server, Connector: FetchFx.Ext },
            ];
            const external = new Set([FetchFx.Ext, FetchFx.Other]);
            for (const bindings of [order, [...order].reverse()])
            {
                const targets = new BindingTable(bindings).ExternalTargets(FetchFx.Laptop, engine.Catalog, external);
                assert.deepEqual(targets, [{ Model: FetchFx.M1, Concept: FetchFx.Laptop, Connector: FetchFx.Ext }]);
            }
        }
        finally
        {
            await engine.dispose();
        }
    });

    it('engine storage as default', async () =>
    {
        const log: string[] = [];
        const crm = new FakeConnector(FetchFx.Crm, log);
        const engine = await FetchFx.Open(EngineDescriptions.Desc(FetchFx.V1, true, [], BindingTable.EngineStorage), [crm]);
        try
        {
            await FetchFx.CreateItem(engine);
            assert.deepEqual(log, []);
        }
        finally
        {
            await engine.dispose();
        }
    });
});
