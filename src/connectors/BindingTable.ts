import type { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import type { IBindingDescription } from '../schema/SchemaDescription.js';
import type { IFetchTarget } from './FetchContract.js';

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
 *
 * Engine storage as the default (ruling R97, D9): a runtime description sets `DefaultConnector:
 * BindingTable.EngineStorage` to say unbound nodes are stored by the engine itself. There is no connector class for
 * it; EngineStorage is this binding, and it behaves exactly like no default (no connector takes part).
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

    /**
     * Every connector name the table can resolve to (DefaultConnector included), EngineStorage among them when used.
     */
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

    /**
     * The fetches an external read of `concept` needs (rulings R96, D6). Per model: (a) one target for `concept`
     * itself when the connector Resolve would pick for it (the nearest binding in the specificity chain, else the
     * model-wide one) is in `external`, so a binding on an ancestor or carried aspect, or a model-wide one,
     * fetches as `concept`, the nearest in the catalog's ancestor order then declared aspects order winning;
     * (b) one target per external binding on a strict subtype of `concept`, fetched as that subtype. Within one
     * (model, connector) a target whose concept IS-A another target's concept is dropped, because the broader
     * fetch already covers it (no row is fetched twice); targets on different connectors are all kept, the
     * fetch session dropping rows the more specific binding owns. Ordered by model, then concept.
     */
    public ExternalTargets(concept: string, catalog: CatalogSnapshot, external: ReadonlySet<string>): readonly IFetchTarget[]
    {
        const targets: IFetchTarget[] = [];
        for (const [model, byConcept] of this.models)
        {
            const found = new Map<string, IFetchTarget>();
            const own = BindingTable.NearestBinding(this.Chain(concept, catalog), byConcept);
            if (own !== undefined && external.has(own))
            {
                found.set(concept, { Model: model, Concept: concept, Connector: own });
            }
            for (const [bound, connector] of byConcept)
            {
                if (external.has(connector) && bound !== BindingTable.ModelWide && bound !== concept
                    && catalog.Has(bound) && catalog.Has(concept) && !catalog.IsAspect(bound) && catalog.IsA(bound, concept))
                {
                    found.set(bound, { Model: model, Concept: bound, Connector: connector });
                }
            }
            const all = [...found.values()];
            for (const t of all)
            {
                const covered = all.some(o => o !== t && o.Connector === t.Connector && catalog.Has(t.Concept) && !catalog.IsAspect(t.Concept) && catalog.Has(o.Concept) && catalog.IsA(t.Concept, o.Concept));
                if (!covered)
                {
                    targets.push(t);
                }
            }
        }
        return targets.sort((a, b) => BindingTable.Compare(a.Model, b.Model) || BindingTable.Compare(a.Concept, b.Concept));
    }

    /** True when a node of `concept` held by `owner` resolves to an external connector (it is a stub, not engine data). */
    public IsStub(owner: string, concept: string, catalog: CatalogSnapshot, external: ReadonlySet<string>): boolean
    {
        const connector = this.Resolve(owner, concept, catalog);
        return connector !== undefined && external.has(connector);
    }

    /** The connector Resolve would pick within one model: the first chain name with a binding, else model-wide. */
    private static NearestBinding(chain: readonly string[], byConcept: ReadonlyMap<string, string>): string | undefined
    {
        for (const name of chain)
        {
            const connector = byConcept.get(name);
            if (connector !== undefined)
            {
                return connector;
            }
        }
        return byConcept.get(BindingTable.ModelWide);
    }

    private static Compare(a: string, b: string): number
    {
        return a < b ? -1 : a > b ? 1 : 0;
    }

    /** True when `other` holds the same bindings (by model and concept) and the same DefaultConnector. */
    public SameAs(other: BindingTable): boolean
    {
        if (this.DefaultConnector !== other.DefaultConnector || this.models.size !== other.models.size)
        {
            return false;
        }
        for (const [model, byConcept] of this.models)
        {
            const theirs = other.models.get(model);
            if (theirs === undefined || theirs.size !== byConcept.size)
            {
                return false;
            }
            for (const [concept, connector] of byConcept)
            {
                if (theirs.get(concept) !== connector)
                {
                    return false;
                }
            }
        }
        return true;
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
