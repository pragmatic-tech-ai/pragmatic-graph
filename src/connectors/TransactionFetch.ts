import type { CellValue } from '../columns/CellValue.js';
import { MemberKind } from '../catalog/ValueType.js';
import type { FederatedReads } from '../FederatedReads.js';
import type { GraphTransaction, IFetchKey, IFetchedView } from '../GraphTransaction.js';
import type { Predicate } from '../predicate/Predicate.js';
import type { IFetchTarget } from './FetchContract.js';
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
 * reachable from the public API (ruling P12). Per key:
 * 1. a stored engine node that is not a stub is served as ReadNode serves it (scoped, reads recorded, External false);
 *    it owns its id (design ruling D2), so no connector is asked for it;
 * 2. a stored stub resolves through its identity: the ExternalTargets of its concept fetched for its owner model;
 * 3. an id with no stored node needs the key's Concept: the ExternalTargets of it, only the Owner's when given. Without
 *    a Concept (or with one the catalog does not define) the key is absent and nothing is fetched: TODL ids are opaque.
 * Ids sharing a candidate list are fetched together through the transaction's FetchSession (LookupMany, memoised for
 * the session) under the transaction's scope, and every row is admitted through GraphReader.AdmitFetched: a row the
 * scope does not admit is absent, its hidden members are stripped, and its Version is the session memo's. The rows stay
 * in the session memo, which is never exposed, so the commit still decides writes against them (ruling R103).
 */
export class TransactionFetch implements IFetchScope
{
    private static readonly Separator = '\u0000';

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
        const views = new Map<string, IFetchedView>();
        const groups = new Map<string, FetchGroup>();
        const order = new Set<string>();
        for (const key of keys)
        {
            if (order.has(key.PublicId))
            {
                continue;
            }
            order.add(key.PublicId);
            if (await this.channel.StoredNonStub(key.PublicId))
            {
                const node = await this.reader.ReadNode(key.PublicId);
                if (node !== undefined)
                {
                    views.set(key.PublicId, { ...node, External: false });
                }
                continue;
            }
            const candidates = await this.Candidates(key);
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
                for (const [publicId, entry] of await session.LookupMany(group.Ids, group.Candidates, undefined, this))
                {
                    const admitted = await this.reader.AdmitFetched(entry.Row, entry.Model);
                    if (admitted !== undefined)
                    {
                        views.set(publicId, {
                            PublicId: admitted.PublicId,
                            Concept: admitted.Concept,
                            Owner: entry.Model,
                            Properties: this.Properties(admitted.Concept, admitted.Values),
                            External: true,
                            ...(entry.Row.Version === undefined ? {} : { Version: entry.Row.Version }),
                        });
                    }
                }
            }
        }
        const out = new Map<string, IFetchedView>();
        for (const publicId of order)
        {
            const view = views.get(publicId);
            if (view !== undefined)
            {
                out.set(publicId, view);
            }
        }
        return out;
    }

    /** The fetch targets of a key that is not a stored engine node (see the class comment); none when it cannot be fetched. */
    private async Candidates(key: IFetchKey): Promise<readonly IFetchTarget[]>
    {
        const setup = this.channel.Setup;
        if (setup === undefined)
        {
            return [];
        }
        const catalog = this.reader.Catalog;
        const stub = await this.channel.StubIdentity(key.PublicId);
        const concept = stub?.Concept ?? key.Concept;
        const owner = stub?.Owner ?? key.Owner;
        if (concept === undefined || !catalog.Has(concept))
        {
            return [];
        }
        const targets = setup.Bindings.ExternalTargets(concept, catalog, setup.External);
        return owner === undefined ? targets : targets.filter(t => t.Model === owner);
    }

    /** Every effective property of the concept the scope does not hide, in effective member order (null when unset), as ReadNode reports them. */
    private Properties(concept: string, values: ReadonlyMap<string, CellValue>): ReadonlyMap<string, CellValue>
    {
        const hidden = this.reader.HiddenMembers(concept);
        const properties = new Map<string, CellValue>();
        for (const def of this.reader.Catalog.EffectiveMembers(concept))
        {
            if (def.Kind === MemberKind.Property && !hidden.has(def.Name))
            {
                properties.set(def.Name, values.get(def.Name) ?? null);
            }
        }
        return properties;
    }
}
