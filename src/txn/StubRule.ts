import type { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import type { ConnectorSetup } from '../connectors/WriteCoordinator.js';

/**
 * Which stored nodes are stubs (ruling R102): identity-only nodes whose binding resolves to an External connector
 * of the installed setup (ConnectorSetup.IsStub). Inactive (no node is a stub) without a setup or without an External
 * connector.
 */
export class StubRule
{
    public constructor(private readonly setup?: ConnectorSetup)
    {
    }

    /** True when at least one External connector is installed. */
    public get IsActive(): boolean
    {
        return this.setup !== undefined && this.setup.External.size > 0;
    }

    /** The fingerprint of a rule that makes no node a stub (no External connector installed). */
    public static readonly Inactive = '';

    /**
     * A canonical text of the rule (BindingTable.StubFingerprint over the installed External connectors): Inactive when
     * no binding names an External connector. Conservative, not exact: equal fingerprints imply the same nodes are
     * stubs under every catalog; the converse fails only for redundant bindings, where the cost is a refused
     * SetConnectors and an Upgrade that finds no transition and writes no commit. Mirrored or engine re-pointing and
     * unused External connectors do not change it. Stored as Meta("stubRule"): the rule the stored data conforms to
     * (final review residual rounds).
     */
    public get Fingerprint(): string
    {
        return this.IsActive ? (this.setup as ConnectorSetup).Bindings.StubFingerprint((this.setup as ConnectorSetup).External) : StubRule.Inactive;
    }

    /** True when the fingerprints are equal, which implies both rules make the same nodes stubs under every catalog (conservative). */
    public SameAs(other: StubRule): boolean
    {
        return this.Fingerprint === other.Fingerprint;
    }

    /** True when a node of `concept` held by `owner` resolves to an External connector. */
    public IsStub(owner: string, concept: string, catalog: CatalogSnapshot): boolean
    {
        return this.setup !== undefined && this.setup.IsStub(owner, concept, catalog);
    }
}
