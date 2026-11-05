import { MemberKind, ValueType } from './ValueType.js';

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
}
