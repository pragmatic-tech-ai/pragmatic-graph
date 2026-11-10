import type { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import { ConnectorResidency } from '../connectors/FetchContract.js';
import type { ConnectorSetup } from '../connectors/WriteCoordinator.js';

/**
 * Which stored nodes are stubs (ruling R102): identity-only nodes whose binding resolves to an External connector
 * of the installed setup. Inactive (no node is a stub) without a setup or without an External connector.
 */
export class StubRule
{
    private readonly external: ReadonlySet<string>;

    public constructor(private readonly setup?: ConnectorSetup)
    {
        this.external = new Set([...(setup?.Connectors.values() ?? [])].filter(c => c.Residency === ConnectorResidency.External).map(c => c.Name));
    }

    /** True when at least one External connector is installed. */
    public get IsActive(): boolean
    {
        return this.external.size > 0;
    }

    /** True when a node of `concept` held by `owner` resolves to an External connector. */
    public IsStub(owner: string, concept: string, catalog: CatalogSnapshot): boolean
    {
        return this.setup !== undefined && this.setup.Bindings.IsStub(owner, concept, catalog, this.external);
    }
}
