import type { IFetchedRow } from '../connectors/FetchContract.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import type { IReadNode } from '../RecordedReads.js';

/**
 * Internal: a row fetched from an External connector, as the ScopeEvaluator decides it (ruling R100): the row, the
 * model that holds it (the fetch target's model) and, when one is stored, its stub (ruling D2: the identity-only node
 * an engine node's link created). The reader attaches the stub (GraphReader.AdmitFetched) before evaluation.
 */
export class FetchedNode
{
    private static readonly ErrStub = 'A stub belongs to the fetched row of the same public id: ';

    private stub: IReadNode | undefined;

    public constructor(public readonly Row: IFetchedRow, public readonly Owner: string)
    {
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
