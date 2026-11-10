import type { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import type { MemberDef } from '../catalog/CatalogTypes.js';
import { MemberKind } from '../catalog/ValueType.js';
import type { CellValue } from '../columns/CellValue.js';
import type { IFetchedRow } from '../connectors/FetchContract.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import type { IReadNode } from '../RecordedReads.js';
import { HypotheticalNode } from './HypotheticalNode.js';

/**
 * Internal: a row fetched from an External connector, as the ScopeEvaluator decides it (ruling R100): the row, the
 * model that holds it (the fetch target's model) and, when one is stored, its stub (ruling D2: the identity-only node
 * an engine node's link created). The reader attaches the stub (GraphReader.AdmitFetched) before evaluation.
 */
export class FetchedNode
{
    private static readonly ErrStub = 'A stub belongs to the fetched row of the same public id: ';
    private static readonly ErrConcept = 'Fetched row concept is not an instantiable concept: ';
    private static readonly ErrValue = 'Fetched row carries a value for a member that is not a property: ';
    private static readonly ErrLink = 'Fetched row carries links for a member that is not a relationship: ';
    private static readonly Dot = '.';

    private stub: IReadNode | undefined;

    public constructor(public readonly Row: IFetchedRow, public readonly Owner: string)
    {
    }

    /**
     * The row checked against `catalog` as HypotheticalNode.Build checks a hypothetical node (ruling R95): its concept
     * must be defined and not an aspect, every Values key an effective property of it and every Links key an effective
     * relationship of it, else GraphError SchemaViolation (the same code FetchSession's D6 checks use). A null or
     * undefined value reads as absent and is dropped; any other value must fit its member as a write would
     * (HypotheticalNode.Checked: an Int64 widens into a Float64 member when exact), else SchemaViolation naming
     * `Concept.member`. Returns a new row (link lists copied); the caller's is never changed.
     */
    public static Validated(catalog: CatalogSnapshot, row: IFetchedRow): IFetchedRow
    {
        if (!catalog.Has(row.Concept) || catalog.IsAspect(row.Concept))
        {
            throw new GraphError(GraphErrorCode.SchemaViolation, FetchedNode.ErrConcept + row.Concept);
        }
        const members = new Map<string, MemberDef>();
        for (const def of catalog.EffectiveMembers(row.Concept))
        {
            members.set(def.Name, def);
        }
        const values = new Map<string, CellValue>();
        for (const [name, value] of row.Values)
        {
            const def = members.get(name);
            if (def === undefined || def.Kind !== MemberKind.Property)
            {
                throw new GraphError(GraphErrorCode.SchemaViolation, FetchedNode.ErrValue + row.Concept + FetchedNode.Dot + name);
            }
            if (value !== undefined && value !== null)
            {
                values.set(name, HypotheticalNode.Checked(row.Concept, def, value));
            }
        }
        const links = new Map<string, readonly string[]>();
        for (const [name, targets] of row.Links)
        {
            if (members.get(name)?.Kind !== MemberKind.Relationship)
            {
                throw new GraphError(GraphErrorCode.SchemaViolation, FetchedNode.ErrLink + row.Concept + FetchedNode.Dot + name);
            }
            links.set(name, Object.freeze([...targets]));
        }
        return { PublicId: row.PublicId, Concept: row.Concept, Values: values, Links: links };
    }

    public get PublicId(): string
    {
        return this.Row.PublicId;
    }

    public get Concept(): string
    {
        return this.Row.Concept;
    }

    /** The internal id of the stub stored for this row, or undefined when there is none. */
    public get Stub(): bigint | undefined
    {
        return this.stub?.Id;
    }

    /** @internal The stored stub node, for decisions made through its engine edges. */
    public get StubNode(): IReadNode | undefined
    {
        return this.stub;
    }

    /** @internal Attaches the stub found for the row's public id; GraphError Internal for a node of another public id. */
    public AttachStub(stub: IReadNode): void
    {
        if (stub.PublicId !== this.Row.PublicId)
        {
            throw new GraphError(GraphErrorCode.Internal, FetchedNode.ErrStub + stub.PublicId);
        }
        this.stub = stub;
    }
}
