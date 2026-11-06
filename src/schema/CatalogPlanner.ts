import { CatalogModel } from '../catalog/CatalogModel.js';
import type { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import { CatalogStore } from '../catalog/CatalogStore.js';
import type { IndexDef, MemberDef, TypeDefinition } from '../catalog/CatalogTypes.js';
import { PredicateCodec } from '../predicate/PredicateCodec.js';
import { CatalogDiff, type IRemovedMember } from './CatalogDiff.js';
import type { IDefinitionDescription, IIndexDescription, ISchemaDescription } from './SchemaDescription.js';

type MutableMember = { -readonly [K in keyof MemberDef]: MemberDef[K] };

interface IPlannedIndex
{
    /** The stored index when this one is unchanged. */
    readonly Kept?: IndexDef;
    readonly Description: IIndexDescription;
}

export interface ICatalogPlan
{
    /** Version = stored.Version + 1, or the stored snapshot itself when nothing changed. */
    readonly Catalog: CatalogSnapshot;
    readonly Diff: CatalogDiff;
    /**
     * True iff `Catalog !== stored`, i.e. the plan must be persisted. Key off this, not `Diff.IsEmpty`:
     * the diff only lists structural removals, additions and hierarchy changes, so a change such as
     * Nullable false to true or a concept's options yields Changed with an empty diff (ruling R45).
     */
    readonly Changed: boolean;
}

/**
 * Rebuilds the catalog from a schema description, keeping the ids of unchanged definitions (ruling R2:
 * ids are catalog-global and stable). Pure: no I/O; validation errors surface as CatalogError and the
 * stored snapshot is never touched.
 *
 * Identity is by name. A kept type keeps its TypeId. A member keeps its id iff Name, Kind, Type, Many,
 * Ordered, Targets (as a set) and EdgeProperties are equal and Nullable did not go from true to false;
 * members are matched by (Name, a concept they are effective on), so moving a member between declaring
 * types keeps its id. An index is kept iff Name, On, resolved member ids, Unique and Where are equal.
 */
export class CatalogPlanner
{
    public static Plan(stored: CatalogSnapshot, desired: ISchemaDescription): ICatalogPlan
    {
        const scratch = CatalogPlanner.BuildScratch(desired.Definitions);
        const planner = new CatalogPlanner(stored, scratch);
        const defs = planner.AssignIds();
        const indexes = planner.PlanIndexes(defs, desired.Indexes);
        const catalog = planner.Assemble(defs, indexes);
        // Compare the whole catalog (options, nullability, declaring types included), not just the diff
        // lists: a change the diff does not describe still needs a new version.
        const result = CatalogPlanner.Canonical(catalog) === CatalogPlanner.Canonical(stored) ? stored : catalog;
        return { Catalog: result, Diff: CatalogPlanner.ComputeDiff(stored, result), Changed: result !== stored };
    }

    private readonly storedDefs: ReadonlyMap<string, TypeDefinition>;
    private readonly storedEffective = new Map<string, ReadonlyMap<string, MemberDef>>();
    private readonly effectiveOn = new Map<number, string[]>();
    private readonly memberIds = new Map<number, number>();
    private readonly usedOld = new Set<number>();
    private nextTypeId: number;
    private nextMemberId: number;

    private constructor(private readonly stored: CatalogSnapshot, private readonly scratch: CatalogSnapshot)
    {
        this.storedDefs = new Map(stored.Definitions().map(d => [d.Name, d]));
        this.nextTypeId = stored.NextTypeId;
        this.nextMemberId = stored.NextMemberId;
        for (const d of stored.Definitions())
        {
            if (!d.IsAspect)
            {
                this.storedEffective.set(d.Name, new Map(stored.EffectiveMembers(d.Name).map(m => [m.Name, m])));
            }
        }
        for (const d of scratch.Definitions())
        {
            if (!d.IsAspect)
            {
                for (const m of scratch.EffectiveMembers(d.Name))
                {
                    const list = this.effectiveOn.get(m.Id) ?? [];
                    list.push(d.Name);
                    this.effectiveOn.set(m.Id, list);
                }
            }
        }
    }

    /** Validates the description and converts it to definitions with throwaway ids (1..). */
    private static BuildScratch(definitions: readonly IDefinitionDescription[]): CatalogSnapshot
    {
        const model = new CatalogModel();
        for (const d of definitions)
        {
            if (d.IsAspect)
            {
                model.DefineAspect(d.Name, d.Aspects, d.Members);
            }
            else
            {
                model.DefineConcept(d.Name, d.Parent, d.Aspects, d.Members, d.Options);
            }
        }
        return model.Seal();
    }

    private AssignIds(): TypeDefinition[]
    {
        const result: TypeDefinition[] = [];
        for (const d of this.scratch.Definitions())
        {
            const old = this.storedDefs.get(d.Name);
            let typeId: number;
            if (old !== undefined && old.IsAspect === d.IsAspect)
            {
                typeId = old.TypeId;
            }
            else
            {
                typeId = this.nextTypeId;
                this.nextTypeId += 1;
            }
            for (const m of d.Members)
            {
                this.AssignMember(m, d, old);
            }
            result.push(Object.freeze({
                ...d,
                TypeId: typeId,
                Members: Object.freeze(d.Members.map(m => this.Remap(m))),
            }));
        }
        return result;
    }

    private AssignMember(member: MemberDef, declaring: TypeDefinition, oldDeclaring: TypeDefinition | undefined): void
    {
        const old = this.FindOld(member, declaring, oldDeclaring);
        if (old !== undefined)
        {
            this.usedOld.add(old.Id);
            this.MapKept(member, old);
            return;
        }
        this.MapNew(member);
    }

    private FindOld(member: MemberDef, declaring: TypeDefinition, oldDeclaring: TypeDefinition | undefined): MemberDef | undefined
    {
        // Try every concept the member is effective on and keep the first old member that is still compatible
        // (a member hoisted from two siblings to a parent can keep only one of the two old ids).
        for (const concept of this.effectiveOn.get(member.Id) ?? [])
        {
            const old = this.storedEffective.get(concept)?.get(member.Name);
            if (old !== undefined && !this.usedOld.has(old.Id) && CatalogPlanner.Compatible(old, member))
            {
                return old;
            }
        }
        // Effective on no concept (an aspect nobody carries): fall back to the same declaring type.
        const same = oldDeclaring?.Members.find(m => m.Name === member.Name);
        return same !== undefined && !this.usedOld.has(same.Id) && declaring.Name === oldDeclaring?.Name && CatalogPlanner.Compatible(same, member) ? same : undefined;
    }

    private MapKept(member: MemberDef, old: MemberDef): void
    {
        this.memberIds.set(member.Id, old.Id);
        for (const e of member.EdgeProperties ?? [])
        {
            this.memberIds.set(e.Id, old.EdgeProperties!.find(x => x.Name === e.Name)!.Id);
        }
    }

    private MapNew(member: MemberDef): void
    {
        this.memberIds.set(member.Id, this.nextMemberId);
        this.nextMemberId += 1;
        for (const e of member.EdgeProperties ?? [])
        {
            this.MapNew(e);
        }
    }

    private Remap(member: MemberDef): MemberDef
    {
        const copy: MutableMember = { ...member, Id: this.memberIds.get(member.Id)! };
        if (member.EdgeProperties !== undefined)
        {
            copy.EdgeProperties = Object.freeze(member.EdgeProperties.map(e => this.Remap(e)));
        }
        return Object.freeze(copy);
    }

    /** The kept-member rule: structural equality, except Nullable may loosen (false to true keeps the id). */
    private static Compatible(old: MemberDef, next: MemberDef): boolean
    {
        return !(old.Nullable && !next.Nullable) && CatalogPlanner.SameShape(old, next, false);
    }

    private static SameShape(a: MemberDef, b: MemberDef, nullableToo: boolean): boolean
    {
        if (a.Name !== b.Name || a.Kind !== b.Kind || a.Type !== b.Type
            || (a.Many ?? false) !== (b.Many ?? false) || (a.Ordered ?? false) !== (b.Ordered ?? false)
            || (nullableToo && a.Nullable !== b.Nullable)
            || !CatalogPlanner.SameSet(a.Targets ?? [], b.Targets ?? []))
        {
            return false;
        }
        const ae = a.EdgeProperties ?? [];
        const be = b.EdgeProperties ?? [];
        return ae.length === be.length && ae.every(x =>
        {
            const y = be.find(z => z.Name === x.Name);
            return y !== undefined && CatalogPlanner.SameShape(x, y, true);
        });
    }

    private static SameSet(a: readonly string[], b: readonly string[]): boolean
    {
        const sa = new Set(a);
        const sb = new Set(b);
        return sa.size === sb.size && [...sa].every(x => sb.has(x));
    }

    private PlanIndexes(defs: TypeDefinition[], descriptions: readonly IIndexDescription[]): IPlannedIndex[]
    {
        // Resolve member names against the new type catalog (this also validates On and the names).
        const types = this.ModelOf(defs).Seal();
        const storedByName = new Map(this.stored.Indexes().map(i => [i.Name, i]));
        return descriptions.map(description =>
        {
            const ids = description.Members.map(n => types.MemberOf(description.On, n).Id);
            const old = storedByName.get(description.Name);
            const same = old !== undefined
                && old.On === description.On
                && old.Unique === (description.Unique ?? false)
                && old.Members.length === ids.length && old.Members.every((id, i) => id === ids[i])
                && CatalogPlanner.WhereKey(old.Where) === CatalogPlanner.WhereKey(description.Where);
            return same ? { Kept: old, Description: description } : { Description: description };
        });
    }

    private static WhereKey(where: IndexDef['Where']): string
    {
        return where === undefined ? '' : JSON.stringify(PredicateCodec.ToJson(where));
    }

    private ModelOf(defs: readonly TypeDefinition[]): CatalogModel
    {
        const model = CatalogModel.EmptyFrom(this.stored);
        for (const d of defs)
        {
            model.Restore(d);
        }
        return model;
    }

    private Assemble(defs: TypeDefinition[], indexes: IPlannedIndex[]): CatalogSnapshot
    {
        const model = this.ModelOf(defs);
        for (const i of indexes)
        {
            if (i.Kept !== undefined)
            {
                model.RestoreIndex(i.Kept);
            }
            else
            {
                model.DefineIndex(i.Description.Name, i.Description.On, i.Description.Members, i.Description.Unique ?? false, i.Description.Where);
            }
        }
        return model.Seal();
    }

    /** Version-independent canonical form for "did anything change": the serialized catalog with sorted keys. */
    private static Canonical(snapshot: CatalogSnapshot): string
    {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(CatalogStore.Serialize(snapshot)));
        return JSON.stringify(parsed, (_key, value: unknown) =>
        {
            if (typeof value === 'object' && value !== null && !Array.isArray(value))
            {
                const sorted: Record<string, unknown> = {};
                for (const k of Object.keys(value).sort())
                {
                    sorted[k] = (value as Record<string, unknown>)[k];
                }
                return sorted;
            }
            return value;
        });
    }

    /**
     * Members of a kept aspect that no concept carried disappear from no concept's effective list, so they
     * are reported against the aspect itself. A carried aspect's members are reported per concept instead.
     */
    private static AddRemovedAspectMembers(stored: CatalogSnapshot, old: TypeDefinition, next: TypeDefinition, into: IRemovedMember[]): void
    {
        if (stored.ConceptsMatching(old.Name).length > 0)
        {
            return;
        }
        const kept = new Set(next.Members.map(m => m.Id));
        for (const m of old.Members)
        {
            if (!kept.has(m.Id))
            {
                into.push({ Type: old.Name, Member: m });
            }
        }
    }

    private static ComputeDiff(stored: CatalogSnapshot, next: CatalogSnapshot): CatalogDiff
    {
        const oldTypeIds = new Set(stored.Definitions().map(d => d.TypeId));
        const newTypeIds = new Set(next.Definitions().map(d => d.TypeId));
        const oldById = new Map(stored.Definitions().map(d => [d.TypeId, d]));
        const removedMembers: IRemovedMember[] = [];
        const changedHierarchy: string[] = [];
        for (const d of next.Definitions())
        {
            const old = oldById.get(d.TypeId);
            if (old === undefined)
            {
                continue;
            }
            if (d.IsAspect)
            {
                CatalogPlanner.AddRemovedAspectMembers(stored, old, d, removedMembers);
                continue;
            }
            const kept = new Set(next.EffectiveMembers(d.Name).map(m => m.Id));
            for (const m of stored.EffectiveMembers(old.Name))
            {
                if (!kept.has(m.Id))
                {
                    removedMembers.push({ Type: d.Name, Member: m });
                }
            }
            if (old.Parent !== d.Parent || !CatalogPlanner.SameSet(old.Aspects, d.Aspects))
            {
                changedHierarchy.push(d.Name);
            }
        }
        const oldIndexIds = new Set(stored.Indexes().map(i => i.Id));
        const newIndexIds = new Set(next.Indexes().map(i => i.Id));
        return new CatalogDiff({
            AddedTypes: next.Definitions().filter(d => !oldTypeIds.has(d.TypeId)),
            RemovedTypes: stored.Definitions().filter(d => !newTypeIds.has(d.TypeId)),
            RemovedMembers: removedMembers,
            ChangedHierarchy: changedHierarchy,
            AddedIndexes: next.Indexes().filter(i => !oldIndexIds.has(i.Id)),
            RemovedIndexes: stored.Indexes().filter(i => !newIndexIds.has(i.Id)),
        });
    }
}
