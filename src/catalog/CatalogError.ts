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
    VersionConflict,
    CorruptCatalog,
}

export class CatalogError extends Error
{
    private static readonly ErrorName = 'CatalogError';

    public readonly Code: CatalogErrorCode;

    public constructor(code: CatalogErrorCode, message: string)
    {
        super(message);
        this.name = CatalogError.ErrorName;
        this.Code = code;
    }
}
