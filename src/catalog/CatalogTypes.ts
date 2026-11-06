import { MemberKind, Placement, ValueType } from './ValueType.js';

/** Per-concept placement metadata for DefineConcept (seam 3, ruling F5). */
export interface IConceptOptions
{
    /** Default Partitioned. */
    readonly Placement?: Placement;
    /** The concept whose instances this concept's instances are co-located with (and conflict-partitioned by). */
    readonly AggregateRoot?: string;
}

export interface MemberInput
{
    readonly Name: string;
    readonly Kind: MemberKind;
    readonly Type?: ValueType;
    readonly Nullable?: boolean;
    readonly Targets?: readonly string[];
    readonly Many?: boolean;
    readonly Ordered?: boolean;
    readonly EdgeProperties?: readonly MemberInput[];
}

export interface MemberDef
{
    readonly Id: number;
    readonly Name: string;
    readonly Kind: MemberKind;
    readonly Type?: ValueType;
    readonly Nullable: boolean;
    readonly Targets?: readonly string[];
    readonly Many?: boolean;
    readonly Ordered?: boolean;
    readonly EdgeProperties?: readonly MemberDef[];
    readonly DeclaredBy: string;
}

/** A recorded concept or aspect with its assigned stable ids. Aspects = carried aspects (concept) or included aspects (aspect). */
export interface TypeDefinition
{
    readonly Name: string;
    readonly IsAspect: boolean;
    readonly TypeId: number;
    readonly Parent: string | null;
    readonly Aspects: readonly string[];
    readonly Members: readonly MemberDef[];
    /** Concepts only (always present on a concept; absent on aspects). */
    readonly Placement?: Placement;
    /** Concepts only, optional: names a concept. */
    readonly AggregateRoot?: string;
}
