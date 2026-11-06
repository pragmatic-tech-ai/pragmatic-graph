import type { MemberDef } from '../catalog/CatalogTypes.js';
import { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import { MemberKind } from '../catalog/ValueType.js';
import { ConceptIndex } from '../indexes/IndexStore.js';

/** Lookups the committer needs that CatalogSnapshot does not index: by type id and by member id. */
export class CatalogIndex
{
    private readonly conceptByTypeId = new Map<number, string>();
    private readonly propertyById = new Map<number, MemberDef>();
    private readonly relationships: MemberDef[] = [];
    private readonly incoming = new Map<string, readonly MemberDef[]>();
    private readonly indexes = new Map<string, readonly ConceptIndex[]>();

    public constructor(public readonly Catalog: CatalogSnapshot)
    {
        this.propertyById.set(CatalogSnapshot.NodeIdMember.Id, CatalogSnapshot.NodeIdMember);
        const relationshipIds = new Set<number>();
        for (const def of Catalog.Definitions())
        {
            if (def.IsAspect)
            {
                continue;
            }
            this.conceptByTypeId.set(def.TypeId, def.Name);
            for (const m of Catalog.EffectiveMembers(def.Name))
            {
                if (m.Kind === MemberKind.Property)
                {
                    this.propertyById.set(m.Id, m);
                }
                else if (!relationshipIds.has(m.Id))
                {
                    relationshipIds.add(m.Id);
                    this.relationships.push(m);
                }
            }
        }
    }

    /** The concept name of a stored type id; undefined if the catalog does not know it. */
    public ConceptOf(typeId: number): string | undefined
    {
        return this.conceptByTypeId.get(typeId);
    }

    /** A property member (or member 0) by its catalog-global id. */
    public PropertyById(memberId: number): MemberDef | undefined
    {
        return this.propertyById.get(memberId);
    }

    /** True when a node of `concept` may be the target of `relationship`. */
    public Accepts(relationship: MemberDef, concept: string): boolean
    {
        return (relationship.Targets ?? []).some(t => this.Catalog.IsA(concept, t));
    }

    /** The secondary indexes that apply to nodes of `concept`, resolved against its members (cached). */
    public IndexesFor(concept: string): readonly ConceptIndex[]
    {
        let found = this.indexes.get(concept);
        if (found === undefined)
        {
            found = ConceptIndex.For(this.Catalog, concept);
            this.indexes.set(concept, found);
        }
        return found;
    }

    /** Every relationship (each once, by id) whose targets admit nodes of `concept`. */
    public IncomingRelationships(concept: string): readonly MemberDef[]
    {
        let found = this.incoming.get(concept);
        if (found === undefined)
        {
            found = this.relationships.filter(r => this.Accepts(r, concept));
            this.incoming.set(concept, found);
        }
        return found;
    }
}
