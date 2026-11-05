import { CatalogError, CatalogErrorCode } from './CatalogError.js';
import { MemberDef, TypeDefinition } from './CatalogTypes.js';
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

    public readonly Version: number;

    private readonly defs: readonly TypeDefinition[];
    private readonly byName: ReadonlyMap<string, TypeDefinition>;
    private readonly effective: ReadonlyMap<string, readonly MemberDef[]>;
    private readonly memberByName: ReadonlyMap<string, ReadonlyMap<string, MemberDef>>;
    private readonly isaSets: ReadonlyMap<string, ReadonlySet<string>>;
    private readonly intervals: ReadonlyMap<string, readonly [number, number]>;
    private readonly matching: ReadonlyMap<string, readonly number[]>;

    private constructor(
        version: number,
        defs: readonly TypeDefinition[],
        effective: Map<string, readonly MemberDef[]>,
        isaSets: Map<string, ReadonlySet<string>>)
    {
        this.Version = version;
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
    }

    /** Validates the definitions and builds a snapshot; throws CatalogError on any type-model violation. */
    public static Build(version: number, defs: readonly TypeDefinition[]): CatalogSnapshot
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
        return new CatalogSnapshot(version, defs, effective, isaSets);
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
            throw new CatalogError(CatalogErrorCode.UnknownMember, CatalogSnapshot.UnknownMemberMessage + concept + '.' + name);
        }
        return m;
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
                    ? new CatalogError(CatalogErrorCode.MemberRedeclared, CatalogSnapshot.RedeclaredMessage + m.DeclaredBy + '.' + m.Name)
                    : new CatalogError(CatalogErrorCode.MemberCollision, CatalogSnapshot.CollisionMessage + m.DeclaredBy + '.' + m.Name);
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
