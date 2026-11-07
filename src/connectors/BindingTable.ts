import type { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import type { IBindingDescription } from '../schema/SchemaDescription.js';

/**
 * Which connector holds a node's data, by (model, concept) (spec §5.1). Built from the description's
 * bindings and default connector; immutable.
 *
 * Resolve: most specific wins. First a binding for (owner, concept) where the concept is the node's own
 * concept or one it inherits or carries, nearest first: the node's concept, then its ancestors from the
 * parent up to the root, then the aspects carried, taking each concept of that chain in the same order
 * and its declared aspects in declared order, each aspect followed by the aspects it includes (depth
 * first, each name once). Then the owner's model-wide binding (no Concept), then DefaultConnector, else
 * undefined. A concept the catalog does not define matches only its own name. A result equal to
 * EngineStorage, or undefined, means engine-only: no connector takes part.
 */
export class BindingTable
{
    /** The connector name meaning "stored by the engine itself" (no connector participates). */
    public static readonly EngineStorage = 'engine';

    private static readonly ErrDuplicate = 'Duplicate connector binding for model ';
    private static readonly ErrBinding = 'A binding needs a non-empty Model and Connector: ';
    private static readonly ConceptSeparator = ', concept ';
    private static readonly ModelWide = '';

    /** Per model: concept name (ModelWide for the model-wide binding) → connector. */
    private readonly models = new Map<string, Map<string, string>>();
    /** Per catalog, per concept: its specificity chain (see Resolve). */
    private readonly chains = new WeakMap<CatalogSnapshot, Map<string, readonly string[]>>();

    public constructor(bindings: readonly IBindingDescription[], public readonly DefaultConnector?: string)
    {
        for (const b of bindings)
        {
            if (b.Model.length === 0 || b.Connector.length === 0 || b.Concept === BindingTable.ModelWide)
            {
                throw new GraphError(GraphErrorCode.InvalidArgument, BindingTable.ErrBinding + b.Model + BindingTable.ConceptSeparator + (b.Concept ?? BindingTable.ModelWide));
            }
            let byConcept = this.models.get(b.Model);
            if (byConcept === undefined)
            {
                byConcept = new Map();
                this.models.set(b.Model, byConcept);
            }
            const key = b.Concept ?? BindingTable.ModelWide;
            if (byConcept.has(key))
            {
                throw new GraphError(GraphErrorCode.InvalidArgument, BindingTable.ErrDuplicate + b.Model + BindingTable.ConceptSeparator + key);
            }
            byConcept.set(key, b.Connector);
        }
    }

    /** Every connector name the table can resolve to (DefaultConnector included), EngineStorage among them when used. */
    public ConnectorNames(): ReadonlySet<string>
    {
        const names = new Set<string>();
        for (const byConcept of this.models.values())
        {
            for (const name of byConcept.values())
            {
                names.add(name);
            }
        }
        if (this.DefaultConnector !== undefined)
        {
            names.add(this.DefaultConnector);
        }
        return names;
    }

    /** The connector for a node of `concept` held by model `owner` under `catalog` (see the class comment). */
    public Resolve(owner: string, concept: string, catalog: CatalogSnapshot): string | undefined
    {
        const byConcept = this.models.get(owner);
        if (byConcept === undefined)
        {
            return this.DefaultConnector;
        }
        for (const name of this.Chain(concept, catalog))
        {
            const connector = byConcept.get(name);
            if (connector !== undefined)
            {
                return connector;
            }
        }
        return byConcept.get(BindingTable.ModelWide) ?? this.DefaultConnector;
    }

    /** True when `connector` (a Resolve result) means engine-only. */
    public static IsEngineOnly(connector: string | undefined): boolean
    {
        return connector === undefined || connector === BindingTable.EngineStorage;
    }

    private Chain(concept: string, catalog: CatalogSnapshot): readonly string[]
    {
        let perCatalog = this.chains.get(catalog);
        if (perCatalog === undefined)
        {
            perCatalog = new Map();
            this.chains.set(catalog, perCatalog);
        }
        let chain = perCatalog.get(concept);
        if (chain === undefined)
        {
            chain = BindingTable.BuildChain(concept, catalog);
            perCatalog.set(concept, chain);
        }
        return chain;
    }

    private static BuildChain(concept: string, catalog: CatalogSnapshot): readonly string[]
    {
        const lineage: string[] = [];
        let cursor = catalog.Definition(concept);
        if (cursor === undefined)
        {
            return Object.freeze([concept]);
        }
        while (cursor !== undefined)
        {
            lineage.push(cursor.Name);
            cursor = cursor.Parent === null ? undefined : catalog.Definition(cursor.Parent);
        }
        const chain = new Set<string>(lineage);
        for (const name of lineage)
        {
            BindingTable.AddAspects(catalog.Definition(name)!.Aspects, catalog, chain);
        }
        return Object.freeze([...chain]);
    }

    private static AddAspects(aspects: readonly string[], catalog: CatalogSnapshot, into: Set<string>): void
    {
        for (const aspect of aspects)
        {
            if (into.has(aspect))
            {
                continue;
            }
            into.add(aspect);
            const def = catalog.Definition(aspect);
            if (def !== undefined)
            {
                BindingTable.AddAspects(def.Aspects, catalog, into);
            }
        }
    }
}
