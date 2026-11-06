import { CatalogError, CatalogErrorCode } from './CatalogError.js';
import { IndexDef, MemberDef, TypeDefinition } from './CatalogTypes.js';
import { Predicate } from '../predicate/Predicate.js';
import { MemberKind, ValueType } from './ValueType.js';

/** Immutable, validated catalog. Type ids and member ids are stable; pre-order intervals are recomputed per snapshot. */
export class CatalogSnapshot
{
    public static readonly NodeIdMember: MemberDef = Object.freeze({
        Id: 0,
        Name: '$id',
        Kind: MemberKind.Property,
        Type: ValueType.Int64,
        Nullable: false,
        DeclaredBy: '',
    });

    private static readonly UnknownTypeMessage = 'Unknown type: ';
    private static readonly UnknownConceptMessage = 'Unknown concept: ';
    private static readonly UnknownMemberMessage = 'Unknown member: ';
    private static readonly AspectAsParentMessage = 'Aspect used as parent: ';
    private static readonly ConceptInAspectListMessage = 'Concept used in an aspect list: ';
    private static readonly CycleMessage = 'Inheritance cycle through: ';
    private static readonly RedeclaredMessage = 'Member redeclared: ';
    private static readonly CollisionMessage = 'Member collision: ';
    private static readonly NotInstantiableMessage = 'Aspect is not instantiable: ';
    private static readonly AggregateRootMessage = 'AggregateRoot must name a concept: ';
    private static readonly DuplicateIndexMessage = 'Duplicate index name: ';
    private static readonly IndexNeedsMembersMessage = 'Index needs at least one member: ';
    private static readonly IndexMemberNotPropertyMessage = 'Index member is not a property of the indexed type: ';
    private static readonly IndexDuplicateMemberMessage = 'Index lists a member twice: ';
    private static readonly IndexCounterMessage = 'NextIndexId must exceed every index id: ';
    private static readonly UnknownIndexMessage = 'Unknown index: ';
    private static readonly IndexWhereMessage = 'Index Where must be node-local: ';
    private static readonly IndexDurationMessage = 'A Duration member is not indexable: ';
    private static readonly IndexWhereMemberMessage = 'Index Where reads a member that is not a property of the indexed type: ';
    private static readonly MemberSeparator = '.';

    public readonly Version: number;
    /** Next unassigned type id and member id; persisted so ids are never reused. */
    public readonly NextTypeId: number;
    public readonly NextMemberId: number;
    /** Next unassigned index id (a separate counter from 1). */
    public readonly NextIndexId: number;

    private readonly defs: readonly TypeDefinition[];
    private readonly byName: ReadonlyMap<string, TypeDefinition>;
    private readonly effective: ReadonlyMap<string, readonly MemberDef[]>;
    private readonly memberByName: ReadonlyMap<string, ReadonlyMap<string, MemberDef>>;
    private readonly isaSets: ReadonlyMap<string, ReadonlySet<string>>;
    private readonly intervals: ReadonlyMap<string, readonly [number, number]>;
    private readonly matching: ReadonlyMap<string, readonly number[]>;
    private readonly indexList: readonly IndexDef[];
    private readonly indexesByType: ReadonlyMap<string, readonly IndexDef[]>;
    private readonly indexByName: ReadonlyMap<string, IndexDef>;
    private readonly indexMembers: ReadonlyMap<number, readonly MemberDef[]>;

    private constructor(
        version: number,
        defs: readonly TypeDefinition[],
        effective: Map<string, readonly MemberDef[]>,
        isaSets: Map<string, ReadonlySet<string>>,
        nextTypeId: number,
        nextMemberId: number,
        indexes: readonly IndexDef[],
        nextIndexId: number)
    {
        this.Version = version;
        this.NextTypeId = nextTypeId;
        this.NextMemberId = nextMemberId;
        this.NextIndexId = nextIndexId;
        this.indexList = Object.freeze([...indexes]);
        this.defs = Object.freeze([...defs]);
        this.byName = new Map(defs.map(d => [d.Name, d]));
        this.effective = effective;
        this.isaSets = isaSets;
        const lookup = new Map<string, ReadonlyMap<string, MemberDef>>();
        for (const [c, ms] of effective)
        {
            lookup.set(c, new Map(ms.map(m => [m.Name, m])));
        }
        this.memberByName = lookup;
        this.intervals = CatalogSnapshot.ComputeIntervals(defs);
        this.matching = CatalogSnapshot.ComputeMatching(defs, isaSets);
        this.indexesByType = CatalogSnapshot.ComputeIndexesByType(indexes, isaSets);
        this.indexByName = new Map(indexes.map(i => [i.Name, i]));
        const members = new Map<number, readonly MemberDef[]>();
        for (const i of indexes)
        {
            const available = CatalogSnapshot.PropertiesOf(i.On, this.byName);
            members.set(i.Id, Object.freeze(i.Members.map(id => available.get(id)!)));
        }
        this.indexMembers = members;
    }

    /** Validates the definitions and builds a snapshot; throws CatalogError on any type-model violation. */
    public static Build(
        version: number,
        defs: readonly TypeDefinition[],
        nextTypeId: number,
        nextMemberId: number,
        indexes: readonly IndexDef[],
        nextIndexId: number): CatalogSnapshot
    {
        const byName = new Map(defs.map(d => [d.Name, d]));
        CatalogSnapshot.CheckReferences(defs, byName);
        CatalogSnapshot.CheckCycles(defs, byName);
        const effective = new Map<string, readonly MemberDef[]>();
        const carried = new Map<string, Set<string>>();
        for (const d of defs)
        {
            if (d.IsAspect)
            {
                CatalogSnapshot.AspectMembers(d, byName);
            }
            else
            {
                CatalogSnapshot.ConceptMembers(d, byName, effective, carried);
            }
        }
        const isaSets = new Map<string, ReadonlySet<string>>();
        for (const [c, set] of carried)
        {
            isaSets.set(c, set);
        }
        let minType = 1;
        let minMember = 1;
        for (const d of defs)
        {
            minType = Math.max(minType, d.TypeId + 1);
            for (const m of d.Members)
            {
                minMember = Math.max(minMember, CatalogSnapshot.MaxMemberId(m) + 1);
            }
        }
        CatalogSnapshot.ValidateIndexes(indexes, byName);
        let minIndex = 1;
        for (const i of indexes)
        {
            minIndex = Math.max(minIndex, i.Id + 1);
        }
        return new CatalogSnapshot(version, defs, effective, isaSets, Math.max(nextTypeId, minType), Math.max(nextMemberId, minMember), indexes, Math.max(nextIndexId, minIndex));
    }

    private static MaxMemberId(member: MemberDef): number
    {
        let max = member.Id;
        for (const e of member.EdgeProperties ?? [])
        {
            max = Math.max(max, CatalogSnapshot.MaxMemberId(e));
        }
        return max;
    }

    /**
     * The one seam for index validation. Checks: names unique, `On` names a known concept or aspect, at
     * least one member, every member id a distinct property effective on `On` and not a Duration (no
     * total order), and `Where` node-local (evaluated against the node's own values; ruling R-a) and
     * reading only properties effective on `On` (UnknownMember otherwise).
     */
    private static ValidateIndexes(indexes: readonly IndexDef[], byName: ReadonlyMap<string, TypeDefinition>): void
    {
        const names = new Set<string>();
        for (const index of indexes)
        {
            if (names.has(index.Name))
            {
                throw new CatalogError(CatalogErrorCode.DuplicateType, CatalogSnapshot.DuplicateIndexMessage + index.Name);
            }
            names.add(index.Name);
            if (!byName.has(index.On))
            {
                throw new CatalogError(CatalogErrorCode.UnknownType, CatalogSnapshot.UnknownTypeMessage + index.On);
            }
            if (index.Members.length === 0)
            {
                throw new CatalogError(CatalogErrorCode.InvalidMember, CatalogSnapshot.IndexNeedsMembersMessage + index.Name);
            }
            if (index.Where !== undefined && !index.Where.IsNodeLocal)
            {
                throw new CatalogError(CatalogErrorCode.InvalidMember, CatalogSnapshot.IndexWhereMessage + index.Name);
            }
            const available = CatalogSnapshot.PropertiesOf(index.On, byName);
            if (index.Where !== undefined)
            {
                const names = new Set([...available.values()].map(m => m.Name));
                for (const name of Predicate.MemberNames(index.Where))
                {
                    if (!names.has(name))
                    {
                        throw new CatalogError(CatalogErrorCode.UnknownMember, CatalogSnapshot.IndexWhereMemberMessage + index.Name + CatalogSnapshot.MemberSeparator + name);
                    }
                }
            }
            const seen = new Set<number>();
            for (const id of index.Members)
            {
                if (seen.has(id))
                {
                    throw new CatalogError(CatalogErrorCode.InvalidMember, CatalogSnapshot.IndexDuplicateMemberMessage + index.Name);
                }
                seen.add(id);
                const member = available.get(id);
                if (member === undefined)
                {
                    throw new CatalogError(CatalogErrorCode.UnknownMember, CatalogSnapshot.IndexMemberNotPropertyMessage + index.Name + CatalogSnapshot.MemberSeparator + id);
                }
                if (member.Type === ValueType.Duration)
                {
                    throw new CatalogError(CatalogErrorCode.InvalidMember, CatalogSnapshot.IndexDurationMessage + index.Name + CatalogSnapshot.MemberSeparator + member.Name);
                }
            }
        }
    }

    /** The property members, by id, of a concept (own, ancestors' and carried aspects') or of an aspect (own and included). */
    private static PropertiesOf(name: string, byName: ReadonlyMap<string, TypeDefinition>): ReadonlyMap<number, MemberDef>
    {
        const ids = new Map<number, MemberDef>();
        const roots: string[] = [];
        if (byName.get(name)!.IsAspect)
        {
            roots.push(name);
        }
        else
        {
            let cursor: string | null = name;
            while (cursor !== null)
            {
                const def: TypeDefinition = byName.get(cursor)!;
                roots.push(...def.Aspects);
                CatalogSnapshot.AddProperties(def.Members, ids);
                cursor = def.Parent;
            }
        }
        const closure = new Set<string>();
        CatalogSnapshot.Closure(roots, byName, closure);
        for (const a of closure)
        {
            CatalogSnapshot.AddProperties(byName.get(a)!.Members, ids);
        }
        return ids;
    }

    private static AddProperties(members: readonly MemberDef[], into: Map<number, MemberDef>): void
    {
        for (const m of members)
        {
            if (m.Kind === MemberKind.Property)
            {
                into.set(m.Id, m);
            }
        }
    }

    private static ComputeIndexesByType(indexes: readonly IndexDef[], isaSets: ReadonlyMap<string, ReadonlySet<string>>): ReadonlyMap<string, readonly IndexDef[]>
    {
        const result = new Map<string, readonly IndexDef[]>();
        for (const [concept, isa] of isaSets)
        {
            result.set(concept, Object.freeze(indexes.filter(i => isa.has(i.On))));
        }
        return result;
    }

    /** Every declared index, in definition order. */
    public Indexes(): readonly IndexDef[]
    {
        return this.indexList;
    }

    /** The declared index of that name, or undefined. */
    public Index(name: string): IndexDef | undefined
    {
        return this.indexByName.get(name);
    }

    /** The member definitions of a declared index, in key order (as effective on its `On`). */
    public IndexMembers(index: IndexDef): readonly MemberDef[]
    {
        const members = this.indexMembers.get(index.Id);
        if (members === undefined)
        {
            throw new CatalogError(CatalogErrorCode.UnknownMember, CatalogSnapshot.UnknownIndexMessage + index.Name);
        }
        return members;
    }

    /** The indexes that apply to instances of a concept: declared on it, on an ancestor, or on an aspect it carries. */
    public IndexesOn(concept: string): readonly IndexDef[]
    {
        this.RequireConcept(concept);
        return this.indexesByType.get(concept)!;
    }

    public Definitions(): readonly TypeDefinition[]
    {
        return this.defs;
    }

    public TypeId(name: string): number
    {
        return this.Require(name).TypeId;
    }

    public IsAspect(name: string): boolean
    {
        return this.Require(name).IsAspect;
    }

    public RequireInstantiable(name: string): number
    {
        const def = this.Require(name);
        if (def.IsAspect)
        {
            throw new CatalogError(CatalogErrorCode.AspectNotInstantiable, CatalogSnapshot.NotInstantiableMessage + name);
        }
        return def.TypeId;
    }

    public EffectiveMembers(concept: string): readonly MemberDef[]
    {
        this.RequireConcept(concept);
        return this.effective.get(concept)!;
    }

    public Member(concept: string, name: string): MemberDef
    {
        this.RequireConcept(concept);
        const m = this.memberByName.get(concept)!.get(name);
        if (m === undefined)
        {
            throw new CatalogError(CatalogErrorCode.UnknownMember, CatalogSnapshot.UnknownMemberMessage + concept + CatalogSnapshot.MemberSeparator + name);
        }
        return m;
    }

    /**
     * A member of a concept (its effective members, as Member) or of an aspect (its own members and
     * those of the aspects it includes), whether or not any concept carries the aspect. Throws
     * UnknownType for an unknown name and UnknownMember for a member it does not have.
     */
    public MemberOf(conceptOrAspect: string, name: string): MemberDef
    {
        const def = this.Require(conceptOrAspect);
        if (!def.IsAspect)
        {
            return this.Member(conceptOrAspect, name);
        }
        const closure = new Set<string>();
        CatalogSnapshot.Closure([conceptOrAspect], this.byName, closure);
        for (const aspect of closure)
        {
            const m = this.byName.get(aspect)!.Members.find(x => x.Name === name);
            if (m !== undefined)
            {
                return m;
            }
        }
        throw new CatalogError(CatalogErrorCode.UnknownMember, CatalogSnapshot.UnknownMemberMessage + conceptOrAspect + CatalogSnapshot.MemberSeparator + name);
    }

    /** True iff a concept or aspect of that name is defined. */
    public Has(name: string): boolean
    {
        return this.byName.has(name);
    }

    public IsA(concept: string, conceptOrAspect: string): boolean
    {
        this.RequireConcept(concept);
        this.Require(conceptOrAspect);
        return this.isaSets.get(concept)!.has(conceptOrAspect);
    }

    public ConceptsMatching(conceptOrAspect: string): readonly number[]
    {
        this.Require(conceptOrAspect);
        return this.matching.get(conceptOrAspect) ?? Object.freeze([]);
    }

    public PreOrderInterval(concept: string): readonly [number, number]
    {
        this.RequireConcept(concept);
        return this.intervals.get(concept)!;
    }

    private Require(name: string): TypeDefinition
    {
        const def = this.byName.get(name);
        if (def === undefined)
        {
            throw new CatalogError(CatalogErrorCode.UnknownType, CatalogSnapshot.UnknownTypeMessage + name);
        }
        return def;
    }

    private RequireConcept(name: string): void
    {
        const def = this.Require(name);
        if (def.IsAspect)
        {
            throw new CatalogError(CatalogErrorCode.UnknownType, CatalogSnapshot.UnknownConceptMessage + name);
        }
    }

    private static CheckReferences(defs: readonly TypeDefinition[], byName: ReadonlyMap<string, TypeDefinition>): void
    {
        for (const d of defs)
        {
            if (d.Parent !== null)
            {
                const p = byName.get(d.Parent);
                if (p === undefined)
                {
                    throw new CatalogError(CatalogErrorCode.UnknownType, CatalogSnapshot.UnknownTypeMessage + d.Parent);
                }
                if (p.IsAspect)
                {
                    throw new CatalogError(CatalogErrorCode.AspectAsParent, CatalogSnapshot.AspectAsParentMessage + d.Parent);
                }
            }
            for (const a of d.Aspects)
            {
                const t = byName.get(a);
                if (t === undefined)
                {
                    throw new CatalogError(CatalogErrorCode.UnknownType, CatalogSnapshot.UnknownTypeMessage + a);
                }
                if (!t.IsAspect)
                {
                    throw new CatalogError(CatalogErrorCode.ConceptInAspectList, CatalogSnapshot.ConceptInAspectListMessage + a);
                }
            }
            for (const m of d.Members)
            {
                CatalogSnapshot.CheckTargets(m, byName);
            }
            if (d.AggregateRoot !== undefined && byName.get(d.AggregateRoot)?.IsAspect !== false)
            {
                throw new CatalogError(CatalogErrorCode.InvalidAggregateRoot, CatalogSnapshot.AggregateRootMessage + d.Name + CatalogSnapshot.MemberSeparator + d.AggregateRoot);
            }
        }
    }

    private static CheckTargets(member: MemberDef, byName: ReadonlyMap<string, TypeDefinition>): void
    {
        for (const t of member.Targets ?? [])
        {
            if (!byName.has(t))
            {
                throw new CatalogError(CatalogErrorCode.UnknownType, CatalogSnapshot.UnknownTypeMessage + t);
            }
        }
        for (const e of member.EdgeProperties ?? [])
        {
            CatalogSnapshot.CheckTargets(e, byName);
        }
    }

    private static CheckCycles(defs: readonly TypeDefinition[], byName: ReadonlyMap<string, TypeDefinition>): void
    {
        for (const d of defs)
        {
            if (d.IsAspect)
            {
                continue;
            }
            const seen = new Set<string>([d.Name]);
            let p = d.Parent;
            while (p !== null)
            {
                if (seen.has(p))
                {
                    throw new CatalogError(CatalogErrorCode.InheritanceCycle, CatalogSnapshot.CycleMessage + p);
                }
                seen.add(p);
                p = byName.get(p)!.Parent;
            }
        }
        const done = new Set<string>();
        for (const d of defs)
        {
            if (d.IsAspect)
            {
                CatalogSnapshot.VisitAspect(d.Name, byName, done, new Set<string>());
            }
        }
    }

    private static VisitAspect(name: string, byName: ReadonlyMap<string, TypeDefinition>, done: Set<string>, path: Set<string>): void
    {
        if (done.has(name))
        {
            return;
        }
        if (path.has(name))
        {
            throw new CatalogError(CatalogErrorCode.InheritanceCycle, CatalogSnapshot.CycleMessage + name);
        }
        path.add(name);
        for (const inc of byName.get(name)!.Aspects)
        {
            CatalogSnapshot.VisitAspect(inc, byName, done, path);
        }
        path.delete(name);
        done.add(name);
    }

    /** Aspect closure in dependency order (includes first), each aspect once. */
    private static Closure(roots: readonly string[], byName: ReadonlyMap<string, TypeDefinition>, into: Set<string>): void
    {
        for (const r of roots)
        {
            if (!into.has(r))
            {
                CatalogSnapshot.Closure(byName.get(r)!.Aspects, byName, into);
                into.add(r);
            }
        }
    }

    private static Merge(provided: Map<string, MemberDef>, members: readonly MemberDef[], own: boolean): void
    {
        for (const m of members)
        {
            if (provided.has(m.Name))
            {
                throw own
                    ? new CatalogError(CatalogErrorCode.MemberRedeclared, CatalogSnapshot.RedeclaredMessage + m.DeclaredBy + CatalogSnapshot.MemberSeparator + m.Name)
                    : new CatalogError(CatalogErrorCode.MemberCollision, CatalogSnapshot.CollisionMessage + m.DeclaredBy + CatalogSnapshot.MemberSeparator + m.Name);
            }
            provided.set(m.Name, m);
        }
    }

    private static AspectMembers(aspect: TypeDefinition, byName: ReadonlyMap<string, TypeDefinition>): void
    {
        const closure = new Set<string>();
        CatalogSnapshot.Closure([aspect.Name], byName, closure);
        const provided = new Map<string, MemberDef>();
        for (const n of closure)
        {
            CatalogSnapshot.Merge(provided, byName.get(n)!.Members, n === aspect.Name);
        }
    }

    private static ConceptMembers(
        concept: TypeDefinition,
        byName: ReadonlyMap<string, TypeDefinition>,
        effective: Map<string, readonly MemberDef[]>,
        carried: Map<string, Set<string>>): void
    {
        if (effective.has(concept.Name))
        {
            return;
        }
        const provided = new Map<string, MemberDef>();
        const isa = new Set<string>([concept.Name]);
        if (concept.Parent !== null)
        {
            const parent = byName.get(concept.Parent)!;
            CatalogSnapshot.ConceptMembers(parent, byName, effective, carried);
            for (const m of effective.get(parent.Name)!)
            {
                provided.set(m.Name, m);
            }
            for (const n of carried.get(parent.Name)!)
            {
                isa.add(n);
            }
        }
        const closure = new Set<string>();
        CatalogSnapshot.Closure(concept.Aspects, byName, closure);
        for (const n of closure)
        {
            if (!isa.has(n))
            {
                isa.add(n);
                CatalogSnapshot.Merge(provided, byName.get(n)!.Members, false);
            }
        }
        CatalogSnapshot.Merge(provided, concept.Members, true);
        effective.set(concept.Name, Object.freeze([...provided.values()]));
        carried.set(concept.Name, isa);
    }

    private static ComputeIntervals(defs: readonly TypeDefinition[]): ReadonlyMap<string, readonly [number, number]>
    {
        const children = new Map<string | null, TypeDefinition[]>();
        for (const d of defs)
        {
            if (!d.IsAspect)
            {
                const list = children.get(d.Parent) ?? [];
                list.push(d);
                children.set(d.Parent, list);
            }
        }
        const result = new Map<string, readonly [number, number]>();
        let counter = 0;
        const visit = (d: TypeDefinition): void =>
        {
            const low = counter;
            counter += 1;
            for (const c of children.get(d.Name) ?? [])
            {
                visit(c);
            }
            result.set(d.Name, Object.freeze([low, counter - 1]) as readonly [number, number]);
        };
        for (const root of children.get(null) ?? [])
        {
            visit(root);
        }
        return result;
    }

    private static ComputeMatching(defs: readonly TypeDefinition[], isaSets: ReadonlyMap<string, ReadonlySet<string>>): ReadonlyMap<string, readonly number[]>
    {
        const ids = new Map(defs.map(d => [d.Name, d.TypeId]));
        const acc = new Map<string, number[]>();
        for (const [concept, set] of isaSets)
        {
            for (const n of set)
            {
                const list = acc.get(n) ?? [];
                list.push(ids.get(concept)!);
                acc.set(n, list);
            }
        }
        const result = new Map<string, readonly number[]>();
        for (const [n, list] of acc)
        {
            result.set(n, Object.freeze(list.sort((a, b) => a - b)));
        }
        return result;
    }
}
