import { CatalogError, CatalogErrorCode } from './CatalogError.js';
import { CatalogSnapshot } from './CatalogSnapshot.js';
import { MemberDef, MemberInput, TypeDefinition } from './CatalogTypes.js';
import { MemberKind } from './ValueType.js';

export type { MemberDef, MemberInput, TypeDefinition } from './CatalogTypes.js';

type MutableMemberDef = { -readonly [K in keyof MemberDef]: MemberDef[K] };

/**
 * Mutable catalog under construction. Define* only records; Seal() validates and yields an immutable snapshot.
 * A failed Seal() leaves version and id counters untouched, but the offending definitions stay recorded:
 * discard a model whose Seal() threw and rebuild from the last good snapshot via FromSnapshot.
 */
export class CatalogModel
{
    private static readonly DuplicateTypeMessage = 'Type already defined: ';
    private static readonly ConflictingParentMessage = 'Concept redefined with a different parent: ';
    private static readonly DuplicateMemberMessage = 'Duplicate member name in one declaration: ';
    private static readonly PropertyNeedsTypeMessage = 'Property member requires a Type: ';
    private static readonly RelationshipNeedsTargetsMessage = 'Relationship member requires Targets: ';
    private static readonly EdgePropertyMustBePropertyMessage = 'Edge properties must be properties: ';

    private readonly definitions = new Map<string, TypeDefinition>();
    private nextTypeId = 1;
    private nextMemberId = 1;
    private version = 0;

    public static FromSnapshot(snapshot: CatalogSnapshot): CatalogModel
    {
        const model = new CatalogModel();
        model.version = snapshot.Version;
        model.nextTypeId = Math.max(1, snapshot.NextTypeId);
        model.nextMemberId = Math.max(1, snapshot.NextMemberId);
        for (const def of snapshot.Definitions())
        {
            model.definitions.set(def.Name, def);
            model.nextTypeId = Math.max(model.nextTypeId, def.TypeId + 1);
            for (const m of def.Members)
            {
                model.nextMemberId = Math.max(model.nextMemberId, CatalogModel.MaxId(m) + 1);
            }
        }
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

    public DefineConcept(name: string, parent: string | null, aspects: readonly string[], members: readonly MemberInput[]): void
    {
        const existing = this.definitions.get(name);
        if (existing !== undefined && !existing.IsAspect && existing.Parent !== parent)
        {
            throw new CatalogError(CatalogErrorCode.MultipleParents, CatalogModel.ConflictingParentMessage + name);
        }
        this.EnsureNew(name);
        this.Record(name, false, parent, aspects, members);
    }

    public DefineAspect(name: string, includes: readonly string[], members: readonly MemberInput[]): void
    {
        this.EnsureNew(name);
        this.Record(name, true, null, includes, members);
    }

    public Seal(): CatalogSnapshot
    {
        const snapshot = CatalogSnapshot.Build(this.version + 1, [...this.definitions.values()], this.nextTypeId, this.nextMemberId);
        this.version += 1;
        return snapshot;
    }

    private EnsureNew(name: string): void
    {
        if (this.definitions.has(name))
        {
            throw new CatalogError(CatalogErrorCode.DuplicateType, CatalogModel.DuplicateTypeMessage + name);
        }
    }

    private Record(name: string, isAspect: boolean, parent: string | null, aspects: readonly string[], members: readonly MemberInput[]): void
    {
        const defs = this.ConvertMembers(name, name, members, false);
        const typeId = this.nextTypeId;
        this.nextTypeId += 1;
        this.definitions.set(name, Object.freeze({
            Name: name,
            IsAspect: isAspect,
            TypeId: typeId,
            Parent: parent,
            Aspects: Object.freeze([...aspects]),
            Members: Object.freeze(defs),
        }));
    }

    private ConvertMembers(owner: string, path: string, inputs: readonly MemberInput[], edge: boolean): MemberDef[]
    {
        const seen = new Set<string>();
        const result: MemberDef[] = [];
        for (const input of inputs)
        {
            const where = path + '.' + input.Name;
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
