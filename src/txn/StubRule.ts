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
     * A canonical text of the rule: Inactive without an External connector, else the binding table's fingerprint and the
     * sorted External connector names. Two rules make the same nodes stubs under any one catalog exactly when their
     * fingerprints are equal. Stored as Meta("stubRule"): the rule the stored data conforms to (final review residual).
     */
    public get Fingerprint(): string
    {
        if (!this.IsActive)
        {
            return StubRule.Inactive;
        }
        const setup = this.setup as ConnectorSetup;
        return JSON.stringify([setup.Bindings.Fingerprint(), [...setup.External].sort()]);
    }

    /** True when this rule and `other` make the same nodes stubs under any one catalog (equal fingerprints). */
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
