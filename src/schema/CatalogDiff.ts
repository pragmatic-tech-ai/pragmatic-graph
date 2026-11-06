import type { IndexDef, MemberDef, TypeDefinition } from '../catalog/CatalogTypes.js';

/** A member that no longer exists on a (still existing) concept; `Member` is the old definition. */
export interface IRemovedMember
{
    readonly Type: string;
    readonly Member: MemberDef;
}

/** What a catalog plan changes relative to the stored catalog. Read-only. */
export class CatalogDiff
{
    /** Types in the new catalog whose TypeId the stored catalog did not have. */
    public readonly AddedTypes: readonly TypeDefinition[];
    /** Stored (old) definitions whose TypeId the new catalog no longer has. */
    public readonly RemovedTypes: readonly TypeDefinition[];
    /** Old member definitions, per still-existing concept they were effective on and no longer are. */
    public readonly RemovedMembers: readonly IRemovedMember[];
    /** Kept concepts whose parent or aspect list changed. */
    public readonly ChangedHierarchy: readonly string[];
    public readonly AddedIndexes: readonly IndexDef[];
    public readonly RemovedIndexes: readonly IndexDef[];

    public constructor(parts: {
        AddedTypes: TypeDefinition[];
        RemovedTypes: TypeDefinition[];
        RemovedMembers: IRemovedMember[];
        ChangedHierarchy: string[];
        AddedIndexes: IndexDef[];
        RemovedIndexes: IndexDef[];
    })
    {
        this.AddedTypes = Object.freeze([...parts.AddedTypes]);
        this.RemovedTypes = Object.freeze([...parts.RemovedTypes]);
        this.RemovedMembers = Object.freeze([...parts.RemovedMembers]);
        this.ChangedHierarchy = Object.freeze([...parts.ChangedHierarchy]);
        this.AddedIndexes = Object.freeze([...parts.AddedIndexes]);
        this.RemovedIndexes = Object.freeze([...parts.RemovedIndexes]);
        Object.freeze(this);
    }

    public get IsEmpty(): boolean
    {
        return this.AddedTypes.length === 0
            && this.RemovedTypes.length === 0
            && this.RemovedMembers.length === 0
            && this.ChangedHierarchy.length === 0
            && this.AddedIndexes.length === 0
            && this.RemovedIndexes.length === 0;
    }
}
