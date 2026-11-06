import { GraphError, GraphErrorCode } from '../errors/GraphError.js';

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

export class CatalogError extends GraphError
{
    private static readonly ErrorName = 'CatalogError';

    public readonly Code: CatalogErrorCode;

    public constructor(code: CatalogErrorCode, message: string)
    {
        super(CatalogError.Category(code), message);
        this.name = CatalogError.ErrorName;
        this.Code = code;
    }

    public static Category(code: CatalogErrorCode): GraphErrorCode
    {
        switch (code)
        {
            case CatalogErrorCode.VersionConflict:
                return GraphErrorCode.Conflict;
            case CatalogErrorCode.CorruptCatalog:
                return GraphErrorCode.Corrupt;
            default:
                return GraphErrorCode.SchemaViolation;
        }
    }
}
