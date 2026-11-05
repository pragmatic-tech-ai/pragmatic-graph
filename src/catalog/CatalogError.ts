export enum CatalogErrorCode
{
    UnknownType,
    MultipleParents,
    AspectAsParent,
    ConceptInAspectList,
    InheritanceCycle,
    MemberRedeclared,
    MemberCollision,
    AspectNotInstantiable,
    DuplicateType,
    UnknownMember,
    InvalidMember,
}

export class CatalogError extends Error
{
    public readonly Code: CatalogErrorCode;

    public constructor(code: CatalogErrorCode, message: string)
    {
        super(message);
        this.name = 'CatalogError';
        this.Code = code;
    }
}
