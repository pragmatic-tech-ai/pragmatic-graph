import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Root from '../index.js';
import { ConnectorError, ConnectorPhase, ConnectorResidency, FetchSession, Cypher, GraphStore } from '../index.js';
import type { IConnectorApplied, IConnectorCapabilities, IExternalConnector, IFetchedEntry, IFetchedRow, IFetchedView, IFetchKey, IFetchPage, IFetchRequest, IFetchScope, IFetchTarget, RowVersion } from '../index.js';

/** The external-bindings read contract a host needs, and the internals that must stay out of the package entry (ruling P12). */
class Surface
{
    public static readonly Values = ['BindingTable', 'ConnectorPhase', 'ConnectorResidency', 'FetchSession', 'GraphEngine', 'Cypher'];
    public static readonly Hidden = ['FederatedReads', 'FederatedSource', 'FetchedNode', 'FetchHint', 'ConnectorSetup', 'GraphContext'];
    /** GraphStore members that would leak the unexported ConnectorSetup (final review m6): behind the internal channel. */
    public static readonly StoreHidden = ['Connectors'];
}

// Compile-time: the type-only contract exports exist.
export type ContractTypes = [IConnectorApplied, IConnectorCapabilities, IExternalConnector, IFetchedEntry, IFetchedRow, IFetchedView, IFetchKey, IFetchPage, IFetchRequest, IFetchScope, IFetchTarget, RowVersion];

describe('public surface: external bindings', () =>
{
    test('public surface exports the read contract', () =>
    {
        for (const name of Surface.Values)
        {
            assert.ok(name in Root, name);
        }
        assert.equal(ConnectorResidency.External, 2);
        assert.equal(ConnectorPhase.Fetch, 'Fetch');
        assert.equal(typeof FetchSession, 'function');
        assert.equal(typeof Cypher.CypherCursor, 'function');
    });

    test('public surface exports wave 1', () =>
    {
        const version: RowVersion = 1n;
        const key: IFetchKey = { PublicId: 'a' };
        const view: Pick<IFetchedView, 'External' | 'Version'> = { External: true, Version: version };
        assert.equal(key.PublicId, 'a');
        assert.equal(view.External, true);
        assert.equal(Object.getOwnPropertyDescriptor(ConnectorError.prototype, 'IsConflict')?.get !== undefined, true);
    });

    test('the federated read channel stays out of the package entry', () =>
    {
        for (const name of Surface.Hidden)
        {
            assert.equal(name in Root, false, name);
            assert.equal(name in Cypher, false, name);
        }
    });

    test('a store exposes no connector setup', async () =>
    {
        const store = await GraphStore.OpenMemory();
        try
        {
            for (const name of Surface.StoreHidden)
            {
                assert.equal(name in store, false, name);
            }
            // @ts-expect-error not on GraphStore's public type
            void store.Connectors;
        }
        finally
        {
            await store.dispose();
        }
    });
});
