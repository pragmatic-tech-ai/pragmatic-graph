import type { CellValue } from '../columns/CellValue.js';
import type { IConceptOptions, MemberInput } from '../catalog/CatalogTypes.js';
import type { Predicate } from '../predicate/Predicate.js';

/**
 * The engine's neutral schema input (spec 4.1): what a producer (a compiler, a hand-written model, a
 * test) hands the engine. The engine knows nothing about where it came from.
 */
export interface ISchemaDescription
{
    /** Opaque content version from the producer (a hash); the engine only stores and compares it. */
    readonly Version: string;
    readonly Definitions: readonly IDefinitionDescription[];
    readonly Indexes: readonly IIndexDescription[];
    /**
     * Nodes created with the schema: applied by every upgrade that changes the version or the catalog (spec 4.3, seed
     * wins for seeded nodes; ruling R53).
     */
    readonly Seed: readonly ISeedNode[];
    /**
     * Connector bindings: which connector stores each (model, concept); installed by the upgrade that applies the
     * description (rulings R72, R77).
     */
    readonly Bindings: readonly IBindingDescription[];
    /** The connector for nodes no binding matches; absent means engine storage. */
    readonly DefaultConnector?: string;
}

export interface IDefinitionDescription
{
    readonly Name: string;
    readonly IsAspect: boolean;
    readonly Parent: string | null;
    readonly Aspects: readonly string[];
    readonly Members: readonly MemberInput[];
    readonly Options?: IConceptOptions;
}

export interface IIndexDescription
{
    readonly Name: string;
    /** A concept or aspect name. */
    readonly On: string;
    /** Property member names, in key order. */
    readonly Members: readonly string[];
    readonly Unique?: boolean;
    readonly Where?: Predicate;
}

export interface ISeedNode
{
    readonly PublicId: string;
    readonly Concept: string;
    readonly Owner: string;
    readonly Properties: Readonly<Record<string, CellValue>>;
    readonly Links: readonly ISeedLink[];
}

export interface ISeedLink
{
    readonly Relationship: string;
    readonly To: string;
    readonly Properties?: Readonly<Record<string, CellValue>>;
}

export interface IBindingDescription
{
    readonly Model: string;
    readonly Concept?: string;
    readonly Connector: string;
}
