import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Root from '../index.js';
import { ConnectorPhase, ConnectorResidency, FetchSession, Cypher } from '../index.js';
import type { IConnectorApplied, IConnectorCapabilities, IExternalConnector, IFetchedRow, IFetchPage, IFetchRequest, IFetchTarget } from '../index.js';

/** The external-bindings read contract a host needs, and the internals that must stay out of the package entry (ruling P12). */
class Surface
{
    public static readonly Values = ['BindingTable', 'ConnectorPhase', 'ConnectorResidency', 'FetchSession', 'GraphEngine', 'Cypher'];
    public static readonly Hidden = ['FederatedReads', 'FederatedSource', 'FetchedNode', 'FetchHint'];
}

// Compile-time: the type-only contract exports exist.
export type ContractTypes = [IConnectorApplied, IConnectorCapabilities, IExternalConnector, IFetchedRow, IFetchPage, IFetchRequest, IFetchTarget];

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

    test('the federated read channel stays out of the package entry', () =>
    {
        for (const name of Surface.Hidden)
        {
            assert.equal(name in Root, false, name);
            assert.equal(name in Cypher, false, name);
        }
    });
});
