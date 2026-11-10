import type { ScopeEvaluator } from './access/ScopeEvaluator.js';
import { MemberKind } from './catalog/ValueType.js';
import { FetchSession } from './connectors/FetchSession.js';
import type { ConnectorSetup } from './connectors/WriteCoordinator.js';
import { GraphError, GraphErrorCode } from './errors/GraphError.js';
import { EdgeDirection } from './format/FormatKeys.js';
import type { GraphReader, ILinkView, IReadProbe } from './GraphReader.js';
import type { RecordedReads } from './RecordedReads.js';
import type { CatalogIndex } from './txn/CatalogIndex.js';

/** A stub's identity: the concept and owner model it was created with (ruling R102). */
export interface IStubIdentity
{
    readonly Concept: string;
    readonly Owner: string;
}

/** One edge as a federated read sees it: Stub is set when the far node is a stub (FederatedReads.Links). */
export interface IFederatedLink extends ILinkView
{
    readonly Stub?: IStubIdentity;
}

/**
 * The reads a federated Cypher read needs beyond GraphReader's scoped surface (ruling R101): a stub's identity, links
 * that report stub far nodes instead of deciding them, the connector setup the reader opened with, and whether a public
 * id names a stored engine node. They are not scoped the way GraphReader's public methods are (a stub is reported
 * whatever the scope makes of it; the caller resolves it through its connector and admits the fetched row), so they
 * are not part of GraphReader's API: every reader creates its channel and registers it here, and engine code that
 * imports this module (CypherEngine, FederatedSource) obtains it with Of(reader). The isolation is at the type and
 * package-entry level: no exported type, member or symbol gives an unscoped read (this module is not exported from the
 * package entry and the package's `exports` map exposes nothing else). The engine is an in-process library, not a
 * sandbox: in-process code that bypasses TypeScript privacy (e.g. reading a TS-private field) is out of the threat
 * model, as for every other private member. Every read is recorded as the reader's reads are. Closed with its reader:
 * every call then throws GraphError Disposed.
 */
export class FederatedReads
{
    private static readonly ErrDisposed = 'Reader has been disposed';
    private static readonly ErrDirection = 'Unknown edge direction: ';
    private static readonly ErrNoChannel = 'The reader has no federated read channel';
    private static readonly ErrTwice = 'The reader already has a federated read channel';
    private static readonly Channels = new WeakMap<GraphReader, FederatedReads>();

    private open = true;
    private session: FetchSession | undefined;

    /** Created by the GraphReader constructor (with its own recorded reads and evaluator), registered for `reader`. */
    public constructor(reader: GraphReader, private readonly recorded: RecordedReads, private readonly evaluator: ScopeEvaluator | undefined, private readonly index: CatalogIndex)
    {
        if (FederatedReads.Channels.has(reader))
        {
            throw new GraphError(GraphErrorCode.Internal, FederatedReads.ErrTwice);
        }
        FederatedReads.Channels.set(reader, this);
    }

    /** The channel of `reader` (every GraphReader and GraphTransaction has one). */
    public static Of(reader: GraphReader): FederatedReads
    {
        const channel = FederatedReads.Channels.get(reader);
        if (channel === undefined)
        {
            throw new GraphError(GraphErrorCode.Internal, FederatedReads.ErrNoChannel);
        }
        return channel;
    }

    /** The bindings and connectors installed when the reader opened (fixed for its life); undefined when none. */
    public get Setup(): ConnectorSetup | undefined
    {
        this.RequireOpen();
        return this.recorded.Setup;
    }

    /**
     * The reader's own FetchSession (design ruling D3: one per GraphTransaction), created on first use; undefined when
     * the setup has no External connector. A write query reads through it (FederatedSource) and the transaction's commit
     * decides its writes against what it fetched (ruling R103), so both see one value per external node.
     */
    public get Session(): FetchSession | undefined
    {
        this.RequireOpen();
        const setup = this.recorded.Setup;
        if (this.session === undefined && setup !== undefined && setup.External.size > 0)
        {
            this.session = new FetchSession(setup.ExternalConnectors(), setup.Bindings, this.index.Catalog);
        }
        return this.session;
    }

    /** The reader's FetchSession when one was created (Session), without creating it. */
    public get OpenSession(): FetchSession | undefined
    {
        this.RequireOpen();
        return this.session;
    }

    /** Called by GraphReader.dispose. */
    public Close(): void
    {
        this.open = false;
    }

    /**
     * The identity of the stored stub with this public id, decided by nothing, or undefined when the id is not stored or
     * is not a stub. Records the id's binding (also when missing).
     */
    public async StubIdentity(publicId: string): Promise<IStubIdentity | undefined>
    {
        this.RequireOpen();
        const node = await this.recorded.Locate(publicId);
        if (node === undefined || !(await this.recorded.IsStub(node)))
        {
            return undefined;
        }
        return { Concept: node.Concept, Owner: await this.recorded.Owner(node) };
    }

    /**
     * True when a stored node that is not a stub has this public id, visible or not: the engine-resident node owns the id
     * (design ruling D2), so a fetched row of that id is dropped. Records the id's binding (also when missing), so a
     * transaction conflicts with a commit that creates or removes such a node.
     */
    public async StoredNonStub(publicId: string): Promise<boolean>
    {
        this.RequireOpen();
        const node = await this.recorded.Locate(publicId);
        return node !== undefined && !(await this.recorded.IsStub(node));
    }

    /**
     * The node's edges as GraphReader.Links reports them, except that a far node that is a stub is reported with its
     * identity (IFederatedLink.Stub) without being decided: the engine cannot decide a stub (ruling R100), so the caller
     * resolves it through its connector and admits the fetched row before using it. Without `stubOwner` the node is
     * located as the reader locates it (a node the scope does not let it see has no edges). With `stubOwner` the node is
     * the stub, owned by that model, of a fetched row the caller has admitted: it is located without deciding its
     * visibility, and has no edges when there is no such stub. Records what Links records, plus each far node's binding.
     */
    public async Links(publicId: string, direction: EdgeDirection, relationship?: string, probe?: IReadProbe, stubOwner?: string): Promise<readonly IFederatedLink[]>
    {
        this.RequireOpen();
        if (direction !== EdgeDirection.Out && direction !== EdgeDirection.In)
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, FederatedReads.ErrDirection + String(direction));
        }
        const evaluator = this.evaluator;
        let node = stubOwner === undefined ? await this.recorded.Locate(publicId) : await this.recorded.StubOf(publicId, stubOwner);
        if (node !== undefined && stubOwner === undefined && evaluator !== undefined && !(await evaluator.IsVisible(node)))
        {
            node = undefined;
        }
        const out: IFederatedLink[] = [];
        if (node === undefined)
        {
            return out;
        }
        const rels = relationship !== undefined
            ? this.recorded.RelationshipsOrNone(node.Concept, relationship, direction)
            : direction === EdgeDirection.Out
                ? this.index.Catalog.EffectiveMembers(node.Concept).filter(m => m.Kind === MemberKind.Relationship)
                : this.index.IncomingRelationships(node.Concept);
        const hidden = direction === EdgeDirection.Out ? evaluator?.HiddenMembers(node.Concept) : undefined;
        for (const rel of rels)
        {
            if (hidden?.has(rel.Name) === true)
            {
                continue;
            }
            for await (const id of this.recorded.Adjacent(rel, node.Id, direction))
            {
                this.RequireOpen();
                probe?.Tick();
                const far = await this.recorded.NodeById(id);
                // In: the edge is a member of the far node (its source), so the far node's Hidden decides.
                if (direction === EdgeDirection.In && evaluator?.HiddenMembers(far.Concept).has(rel.Name) === true)
                {
                    continue;
                }
                if (await this.recorded.IsStub(far))
                {
                    out.push({ Relationship: rel.Name, PublicId: far.PublicId, Stub: { Concept: far.Concept, Owner: await this.recorded.Owner(far) } });
                }
                else if (evaluator === undefined || (await evaluator.IsVisible(far)))
                {
                    out.push({ Relationship: rel.Name, PublicId: far.PublicId });
                }
            }
        }
        return out;
    }

    private RequireOpen(): void
    {
        if (!this.open)
        {
            throw new GraphError(GraphErrorCode.Disposed, FederatedReads.ErrDisposed);
        }
    }
}
