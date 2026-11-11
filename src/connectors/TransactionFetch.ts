import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import type { FederatedReads, IStubIdentity } from '../FederatedReads.js';
import type { GraphTransaction, IFetchKey, IFetchedView } from '../GraphTransaction.js';
import type { Predicate } from '../predicate/Predicate.js';
import { ConnectorError, ConnectorPhase } from './ConnectorError.js';
import type { IFetchTarget, IFetchedRow } from './FetchContract.js';
import type { IFetchScope } from './FetchSession.js';

/** The ids of one Fetch that share a candidate list, fetched by one FetchSession.LookupMany. */
class FetchGroup
{
    public readonly Ids: string[] = [];

    public constructor(public readonly Candidates: readonly IFetchTarget[])
    {
    }
}

/**
 * GraphTransaction.Fetch's resolution (ruling R121 F1), kept out of the transaction so no FetchedNode or session object is
 * reachable from the public API (ruling P12). Keys are first checked against each other: identical keys (same PublicId,
 * Concept and Owner) collapse to one, and two different keys for one public id are GraphError InvalidArgument. Then per
 * key, with one locate of its id (FederatedReads.StoredNode):
 * 1. a stored engine node that is not a stub is served as ReadNode serves it (scoped, reads recorded, External false);
 *    it owns its id (design ruling D2), so no connector is asked for it;
 * 2. a stored stub resolves through its identity: the ExternalTargets of its concept fetched for its owner model;
 * 3. an id with no stored node needs the key's Concept: the ExternalTargets of it, only the Owner's when given. Without
 *    a Concept (or with one the catalog does not define) the key is absent and nothing is fetched: TODL ids are opaque.
 * Ids sharing a candidate list are fetched together through the transaction's FetchSession (LookupMany, memoised for
 * the session) under the transaction's scope, and every row is admitted through GraphReader.AdmitFetched: a row the
 * scope does not admit is absent, its hidden members are stripped, and its Version is the session memo's. The rows stay
 * in the session memo, which is never exposed, so the commit still decides writes against them (ruling R103).
 *
 * A fetched row that fails schema validation fails the Fetch, whatever the scope would make of it, as ConnectorError
 * Fetch whose cause is a GraphError SchemaViolation naming neither the id nor the row: the failure must not reveal what
 * the connector holds for an id the scope may not admit.
 */
export class TransactionFetch implements IFetchScope
{
    private static readonly Separator = '\u0000';
    private static readonly ErrCollision = 'Fetch was given two different keys for one public id';
    private static readonly ErrInvalidRow = 'A fetched row failed validation';

    public constructor(private readonly reader: GraphTransaction, private readonly channel: FederatedReads)
    {
    }

    /** IFetchScope: the transaction's scope row predicate for a fetch of the concept (pushed down by a key-less lookup). */
    public RowPredicate(concept: string): Predicate
    {
        return this.reader.FetchPredicate(concept);
    }

    /** The view of every key this transaction may see, keyed by public id in key order; absent keys are missing. */
    public async Resolve(keys: readonly IFetchKey[]): Promise<ReadonlyMap<string, IFetchedView>>
    {
        const unique = TransactionFetch.Unique(keys);
        const views = new Map<string, IFetchedView>();
        const groups = new Map<string, FetchGroup>();
        for (const key of unique)
        {
            const stored = await this.channel.StoredNode(key.PublicId);
            if (stored !== undefined && stored.Stub === undefined)
            {
                const node = await this.reader.ReadLocated(stored.Node);
                if (node !== undefined)
                {
                    views.set(key.PublicId, { ...node, External: false });
                }
                continue;
            }
            const candidates = this.Candidates(key, stored?.Stub);
            if (candidates.length === 0)
            {
                continue;
            }
            const signature = candidates.map(t => [t.Model, t.Concept, t.Connector].join(TransactionFetch.Separator)).join(TransactionFetch.Separator);
            let group = groups.get(signature);
            if (group === undefined)
            {
                group = new FetchGroup(candidates);
                groups.set(signature, group);
            }
            group.Ids.push(key.PublicId);
        }
        const session = this.channel.Session;
        if (session !== undefined)
        {
            for (const group of groups.values())
            {
                const first = group.Candidates[0]!.Connector;
                const entries = await TransactionFetch.Guarded(first, () => session.LookupMany(group.Ids, group.Candidates, undefined, this));
                for (const [publicId, entry] of entries)
                {
                    const connector = group.Candidates.find(t => t.Model === entry.Model)?.Connector ?? first;
                    const view = await this.View(entry.Row, entry.Model, connector);
                    if (view !== undefined)
                    {
                        views.set(publicId, view);
                    }
                }
            }
        }
        const out = new Map<string, IFetchedView>();
        for (const key of unique)
        {
            const view = views.get(key.PublicId);
            if (view !== undefined)
            {
                out.set(key.PublicId, view);
            }
        }
        return out;
    }

    /** The keys with identical ones collapsed, in first-occurrence order; GraphError InvalidArgument for two different keys of one id. */
    private static Unique(keys: readonly IFetchKey[]): readonly IFetchKey[]
    {
        const byId = new Map<string, IFetchKey>();
        for (const key of keys)
        {
            const seen = byId.get(key.PublicId);
            if (seen === undefined)
            {
                byId.set(key.PublicId, key);
            }
            else if (seen.Concept !== key.Concept || seen.Owner !== key.Owner)
            {
                throw new GraphError(GraphErrorCode.InvalidArgument, TransactionFetch.ErrCollision);
            }
        }
        return [...byId.values()];
    }

    /**
     * Runs a step that validates fetched rows from `connector`, replacing a schema-validation failure (a GraphError SchemaViolation, bare
     * or as a ConnectorError Fetch's cause) by a ConnectorError Fetch that names neither the id nor the row. Every other
     * failure passes unchanged.
     */
    private static async Guarded<T>(connector: string, step: () => Promise<T>): Promise<T>
    {
        try
        {
            return await step();
        }
        catch (error)
        {
            const fetch = error instanceof ConnectorError && error.Phase === ConnectorPhase.Fetch;
            const cause: unknown = fetch ? error.cause : error;
            if (cause instanceof GraphError && cause.GraphCode === GraphErrorCode.SchemaViolation)
            {
                throw new ConnectorError(fetch ? error.Connector : connector, ConnectorPhase.Fetch, new GraphError(GraphErrorCode.SchemaViolation, TransactionFetch.ErrInvalidRow));
            }
            throw error;
        }
    }

    /** The admitted row as a view (see the class comment); undefined when the scope does not admit it. */
    private async View(row: IFetchedRow, model: string, connector: string): Promise<IFetchedView | undefined>
    {
        const admitted = await TransactionFetch.Guarded(connector, () => this.reader.AdmitFetched(row, model));
        if (admitted === undefined)
        {
            return undefined;
        }
        return {
            PublicId: admitted.PublicId,
            Concept: admitted.Concept,
            Owner: model,
            Properties: await this.reader.ScopedProperties(admitted.Concept, def => admitted.Values.get(def.Name)),
            External: true,
            ...(row.Version === undefined ? {} : { Version: row.Version }),
        };
    }

    /** The fetch targets of a key that is not a stored engine node (see the class comment); none when it cannot be fetched. */
    private Candidates(key: IFetchKey, stub: IStubIdentity | undefined): readonly IFetchTarget[]
    {
        const setup = this.channel.Setup;
        if (setup === undefined)
        {
            return [];
        }
        const catalog = this.reader.Catalog;
        const concept = stub?.Concept ?? key.Concept;
        const owner = stub?.Owner ?? key.Owner;
        if (concept === undefined || !catalog.Has(concept))
        {
            return [];
        }
        const targets = setup.Bindings.ExternalTargets(concept, catalog, setup.External);
        return owner === undefined ? targets : targets.filter(t => t.Model === owner);
    }
}
