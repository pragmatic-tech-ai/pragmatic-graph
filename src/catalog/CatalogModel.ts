import { CatalogError, CatalogErrorCode } from './CatalogError.js';
import { CatalogSnapshot } from './CatalogSnapshot.js';
import type { Predicate } from '../predicate/Predicate.js';
import { IConceptOptions, IndexDef, MemberDef, MemberInput, TypeDefinition } from './CatalogTypes.js';
import { MemberKind, Placement } from './ValueType.js';

export type { IConceptOptions, IndexDef, MemberDef, MemberInput, TypeDefinition } from './CatalogTypes.js';

type MutableTypeDefinition = { -readonly [K in keyof TypeDefinition]: TypeDefinition[K] };

/** An index recorded by DefineIndex (member names, resolved at Seal) or restored with its member ids. */
interface IPendingIndex
{
    readonly Id: number;
    readonly Name: string;
    readonly On: string;
    readonly MemberNames?: readonly string[];
    readonly MemberIds?: readonly number[];
    readonly Unique: boolean;
    readonly Where?: Predicate;
}

type MutableMemberDef = { -readonly [K in keyof MemberDef]: MemberDef[K] };

/**
 * Mutable catalog under construction. Define* only records; Seal() validates and yields an immutable snapshot.
 * A failed Seal() leaves version and id counters untouched, but the offending definitions stay recorded:
 * discard a model whose Seal() threw and rebuild from the last good snapshot via FromSnapshot.
 */
export class CatalogModel
{
    private static readonly DuplicateTypeMessage = 'Type already defined: ';
    private static readonly MemberSeparator = '.';
    private static readonly ConflictingParentMessage = 'Concept redefined with a different parent: ';
    private static readonly DuplicateMemberMessage = 'Duplicate member name in one declaration: ';
    private static readonly PropertyNeedsTypeMessage = 'Property member requires a Type: ';
    private static readonly RelationshipNeedsTargetsMessage = 'Relationship member requires Targets: ';
    private static readonly EdgePropertyMustBePropertyMessage = 'Edge properties must be properties: ';

    private readonly definitions = new Map<string, TypeDefinition>();
    private nextTypeId = 1;
    private nextMemberId = 1;
    private nextIndexId = 1;
    private readonly indexes: IPendingIndex[] = [];
    private version = 0;

    public static FromSnapshot(snapshot: CatalogSnapshot): CatalogModel
    {
        const model = new CatalogModel();
        model.version = snapshot.Version;
        model.nextTypeId = Math.max(1, snapshot.NextTypeId);
        model.nextMemberId = Math.max(1, snapshot.NextMemberId);
        model.nextIndexId = Math.max(1, snapshot.NextIndexId);
        for (const def of snapshot.Definitions())
        {
            model.definitions.set(def.Name, def);
            model.nextTypeId = Math.max(model.nextTypeId, def.TypeId + 1);
            for (const m of def.Members)
            {
                model.nextMemberId = Math.max(model.nextMemberId, CatalogModel.MaxId(m) + 1);
            }
        }
        for (const index of snapshot.Indexes())
        {
            model.RestoreIndex(index);
        }
        return model;
    }

    /** A model with no definitions or indexes whose version and id counters continue from `snapshot` (for CatalogPlanner). */
    public static EmptyFrom(snapshot: CatalogSnapshot): CatalogModel
    {
        const model = new CatalogModel();
        model.version = snapshot.Version;
        model.nextTypeId = Math.max(1, snapshot.NextTypeId);
        model.nextMemberId = Math.max(1, snapshot.NextMemberId);
        model.nextIndexId = Math.max(1, snapshot.NextIndexId);
        return model;
    }

    private static MaxId(member: MemberDef): number
    {
        let max = member.Id;
        for (const e of member.EdgeProperties ?? [])
        {
            max = Math.max(max, e.Id);
        }
        return max;
    }

    /** Records a concept; `options` sets its Placement (default Partitioned) and AggregateRoot (ruling F5). */
    public DefineConcept(name: string, parent: string | null, aspects: readonly string[], members: readonly MemberInput[], options?: IConceptOptions): void
    {
        const existing = this.definitions.get(name);
        if (existing !== undefined && !existing.IsAspect && existing.Parent !== parent)
        {
            throw new CatalogError(CatalogErrorCode.MultipleParents, CatalogModel.ConflictingParentMessage + name);
        }
        this.EnsureNew(name);
        this.Record(name, false, parent, aspects, members, options);
    }

    public DefineAspect(name: string, includes: readonly string[], members: readonly MemberInput[]): void
    {
        this.EnsureNew(name);
        this.Record(name, true, null, includes, members);
    }

    /** Records an index over property member names of a concept or aspect; names resolve to member ids at Seal. */
    public DefineIndex(name: string, on: string, members: readonly string[], unique: boolean, where?: Predicate): void
    {
        const id = this.nextIndexId;
        this.nextIndexId += 1;
        this.indexes.push({ Id: id, Name: name, On: on, MemberNames: Object.freeze([...members]), Unique: unique, ...(where === undefined ? {} : { Where: where }) });
    }

    /** Records a definition exactly as given, ids included. Internal: used only by CatalogPlanner. */
    public Restore(def: TypeDefinition): void
    {
        this.EnsureNew(def.Name);
        this.definitions.set(def.Name, def);
        this.nextTypeId = Math.max(this.nextTypeId, def.TypeId + 1);
        for (const m of def.Members)
        {
            this.nextMemberId = Math.max(this.nextMemberId, CatalogModel.MaxId(m) + 1);
        }
    }

    /** Records an index exactly as given, id included. Internal: used only by CatalogPlanner. */
    public RestoreIndex(def: IndexDef): void
    {
        this.nextIndexId = Math.max(this.nextIndexId, def.Id + 1);
        this.indexes.push({ Id: def.Id, Name: def.Name, On: def.On, MemberIds: def.Members, Unique: def.Unique, ...(def.Where === undefined ? {} : { Where: def.Where }) });
    }

    public Seal(): CatalogSnapshot
    {
        const version = this.version + 1;
        const defs = [...this.definitions.values()];
        let snapshot: CatalogSnapshot;
        if (this.indexes.length === 0)
        {
            snapshot = CatalogSnapshot.Build(version, defs, this.nextTypeId, this.nextMemberId, [], this.nextIndexId);
        }
        else
        {
            const types = CatalogSnapshot.Build(version, defs, this.nextTypeId, this.nextMemberId, [], this.nextIndexId);
            const resolved = this.indexes.map(i => CatalogModel.Resolve(types, i));
            snapshot = CatalogSnapshot.Build(version, defs, this.nextTypeId, this.nextMemberId, resolved, this.nextIndexId);
        }
        this.version = version;
        return snapshot;
    }

    private static Resolve(types: CatalogSnapshot, index: IPendingIndex): IndexDef
    {
        const members = index.MemberIds ?? (index.MemberNames ?? []).map(n => types.MemberOf(index.On, n).Id);
        return Object.freeze({
            Id: index.Id,
            Name: index.Name,
            On: index.On,
            Members: Object.freeze([...members]),
            Unique: index.Unique,
            ...(index.Where === undefined ? {} : { Where: index.Where }),
        });
    }

    private EnsureNew(name: string): void
    {
        if (this.definitions.has(name))
        {
            throw new CatalogError(CatalogErrorCode.DuplicateType, CatalogModel.DuplicateTypeMessage + name);
        }
    }

    private Record(name: string, isAspect: boolean, parent: string | null, aspects: readonly string[], members: readonly MemberInput[], options?: IConceptOptions): void
    {
        const defs = this.ConvertMembers(name, name, members, false);
        const typeId = this.nextTypeId;
        this.nextTypeId += 1;
        const def: MutableTypeDefinition = {
            Name: name,
            IsAspect: isAspect,
            TypeId: typeId,
            Parent: parent,
            Aspects: Object.freeze([...aspects]),
            Members: Object.freeze(defs),
        };
        if (!isAspect)
        {
            def.Placement = options?.Placement ?? Placement.Partitioned;
            if (options?.AggregateRoot !== undefined)
            {
                def.AggregateRoot = options.AggregateRoot;
            }
        }
        this.definitions.set(name, Object.freeze(def));
    }

    private ConvertMembers(owner: string, path: string, inputs: readonly MemberInput[], edge: boolean): MemberDef[]
    {
        const seen = new Set<string>();
        const result: MemberDef[] = [];
        for (const input of inputs)
        {
            const where = path + CatalogModel.MemberSeparator + input.Name;
            if (seen.has(input.Name))
            {
                throw new CatalogError(CatalogErrorCode.InvalidMember, CatalogModel.DuplicateMemberMessage + where);
            }
            seen.add(input.Name);
            result.push(this.ConvertMember(owner, where, input, edge));
        }
        return result;
    }

    private ConvertMember(owner: string, where: string, input: MemberInput, edge: boolean): MemberDef
    {
        if (edge && input.Kind !== MemberKind.Property)
        {
            throw new CatalogError(CatalogErrorCode.InvalidMember, CatalogModel.EdgePropertyMustBePropertyMessage + where);
        }
        if (input.Kind === MemberKind.Property && input.Type === undefined)
        {
            throw new CatalogError(CatalogErrorCode.InvalidMember, CatalogModel.PropertyNeedsTypeMessage + where);
        }
        if (input.Kind === MemberKind.Relationship && (input.Targets === undefined || input.Targets.length === 0))
        {
            throw new CatalogError(CatalogErrorCode.InvalidMember, CatalogModel.RelationshipNeedsTargetsMessage + where);
        }
        const id = this.nextMemberId;
        this.nextMemberId += 1;
        const def: MutableMemberDef = {
            Id: id,
            Name: input.Name,
            Kind: input.Kind,
            Nullable: input.Nullable ?? false,
            DeclaredBy: owner,
        };
        if (input.Type !== undefined) { def.Type = input.Type; }
        if (input.Targets !== undefined) { def.Targets = Object.freeze([...input.Targets]); }
        if (input.Many !== undefined) { def.Many = input.Many; }
        if (input.Ordered !== undefined) { def.Ordered = input.Ordered; }
        if (input.EdgeProperties !== undefined)
        {
            def.EdgeProperties = Object.freeze(this.ConvertMembers(owner, where, input.EdgeProperties, true));
        }
        return Object.freeze(def);
    }
}
