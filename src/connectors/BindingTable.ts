import type { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import { MemberKind } from '../catalog/ValueType.js';
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
    private static readonly NoStubs = '';

    /** Per model: concept name (ModelWide for the model-wide binding) → connector. */
    private readonly models = new Map<string, Map<string, string>>();
    /** Per catalog, per concept: its specificity chain (see Resolve). */
    private readonly chains = new WeakMap<CatalogSnapshot, Map<string, readonly string[]>>();
    /** Per catalog, per concept or aspect: the non-aspect concepts that IsA it (see Family). */
    private readonly families = new WeakMap<CatalogSnapshot, Map<string, readonly string[]>>();
    /** Per catalog, per concept or aspect: every property of its family (see FamilyProperties). */
    private readonly familyProperties = new WeakMap<CatalogSnapshot, Map<string, readonly string[]>>();

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
     * The fetches an external read of `label` (a concept or an aspect) needs (ruling R96, amended by R100 for aspects).
     * Its members are every concept of the catalog that is not an aspect and IsA `label`: the concept itself and its
     * subtypes, or for an aspect every concept carrying it and their subtypes (a name the catalog does not define
     * stands for itself). For every model the table names, each member that Resolve (most specific binding winning)
     * sends to a connector in `external` is a candidate (model, member, connector); so bindings keyed by the member, an
     * ancestor, a carried aspect (also another aspect than `label`) or model-wide all count, and a member a more
     * specific binding sends elsewhere is not fetched. Within one (model, connector) a candidate whose concept IsA
     * another candidate's concept is dropped: one fetch of the most general concept covers it (rows of subtypes bound
     * elsewhere are dropped by the session's re-resolution, D6). A fetch never names an aspect: an aspect read fetches
     * its carriers. Ordered by model, then concept.
     */
    public ExternalTargets(label: string, catalog: CatalogSnapshot, external: ReadonlySet<string>): readonly IFetchTarget[]
    {
        const targets: IFetchTarget[] = [];
        if (external.size === 0)
        {
            return targets;
        }
        const members = this.Family(label, catalog);
        for (const model of this.models.keys())
        {
            const candidates: IFetchTarget[] = [];
            for (const concept of members)
            {
                const connector = this.Resolve(model, concept, catalog);
                if (connector !== undefined && external.has(connector))
                {
                    candidates.push({ Model: model, Concept: concept, Connector: connector });
                }
            }
            for (const c of candidates)
            {
                if (!candidates.some(o => o !== c && o.Connector === c.Connector && BindingTable.Covers(o.Concept, c.Concept, catalog)))
                {
                    targets.push(c);
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

    /**
     * True when some node that is, inherits from or carries `conceptOrAspect` could resolve to a connector in `external`:
     * exactly when ExternalTargets of it is not empty, but stopping at the first member (see ExternalTargets) some model
     * resolves to an external connector. Owners the table does not name resolve to DefaultConnector, never external
     * (ConnectorSetup refuses an External default), so they never count.
     */
    public MayResolveExternal(conceptOrAspect: string, catalog: CatalogSnapshot, external: ReadonlySet<string>): boolean
    {
        if (external.size === 0)
        {
            return false;
        }
        const members = this.Family(conceptOrAspect, catalog);
        for (const model of this.models.keys())
        {
            for (const concept of members)
            {
                const connector = this.Resolve(model, concept, catalog);
                if (connector !== undefined && external.has(connector))
                {
                    return true;
                }
            }
        }
        return false;
    }

    /** True when `general` and `specific` differ and a fetch of `general` covers nodes of `specific` (IsA). */
    private static Covers(general: string, specific: string, catalog: CatalogSnapshot): boolean
    {
        return general !== specific && catalog.Has(general) && catalog.Has(specific) && catalog.IsA(specific, general);
    }

    /**
     * The family of `label` (a concept or an aspect): every concept of the catalog that is not an aspect and IsA it, in
     * definition order; [label] for a name the catalog does not define. What a fetch of `label` returns rows of (cached
     * per catalog).
     */
    public Family(label: string, catalog: CatalogSnapshot): readonly string[]
    {
        return BindingTable.Cached(this.families, catalog, label, () => catalog.Has(label)
            ? catalog.Definitions().filter(d => !d.IsAspect && catalog.IsA(d.Name, label)).map(d => d.Name)
            : [label]);
    }

    /**
     * Every property of every concept of Family(label), hidden ones included, in first-seen order (cached per catalog):
     * the members every fetch of `label` asks for (ruling R99, final review C1), so a row of any concept of the family
     * carries all its properties whichever fetch returned it. Empty for a name the catalog does not define.
     */
    public FamilyProperties(label: string, catalog: CatalogSnapshot): readonly string[]
    {
        return BindingTable.Cached(this.familyProperties, catalog, label, () =>
        {
            const names = new Set<string>();
            for (const concept of this.Family(label, catalog))
            {
                if (!catalog.Has(concept))
                {
                    continue;
                }
                for (const def of catalog.EffectiveMembers(concept))
                {
                    if (def.Kind === MemberKind.Property)
                    {
                        names.add(def.Name);
                    }
                }
            }
            return [...names];
        });
    }

    private static Cached(cache: WeakMap<CatalogSnapshot, Map<string, readonly string[]>>, catalog: CatalogSnapshot, key: string, build: () => string[]): readonly string[]
    {
        let perCatalog = cache.get(catalog);
        if (perCatalog === undefined)
        {
            perCatalog = new Map();
            cache.set(catalog, perCatalog);
        }
        let found = perCatalog.get(key);
        if (found === undefined)
        {
            found = Object.freeze(build());
            perCatalog.set(key, found);
        }
        return found;
    }

    private static Compare(a: string, b: string): number
    {
        return a < b ? -1 : a > b ? 1 : 0;
    }

    /**
     * A canonical text of exactly what decides which nodes resolve to a connector in `external` (the stub rule, final
     * review): '' when no binding names one. Otherwise, sorted, every binding (model, concept or '' for model-wide,
     * External or not) of each model that has a binding to an External connector; which connector a binding names
     * is left out, only whether it is External (a non-External binding of such a model can shadow an External one in
     * some catalog, so it counts; models without an External binding never resolve External, because the
     * DefaultConnector is never External, ConnectorSetup). Two tables have the same stub fingerprint exactly when
     * they assign External or not to the same (model, concept) keys in models binding External, so under every catalog
     * they make the same nodes stubs; re-pointing a binding between connectors of the same residency, adding an
     * unbound connector or changing a model without External bindings keeps it.
     */
    public StubFingerprint(external: ReadonlySet<string>): string
    {
        const rows: string[] = [];
        for (const [model, byConcept] of this.models)
        {
            if (![...byConcept.values()].some(c => external.has(c)))
            {
                continue;
            }
            for (const [concept, connector] of byConcept)
            {
                rows.push(JSON.stringify([model, concept, external.has(connector)]));
            }
        }
        return rows.length === 0 ? BindingTable.NoStubs : JSON.stringify(rows.sort(BindingTable.Compare));
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
