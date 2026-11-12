import { FetchedNode } from '../access/FetchedNode.js';
import type { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import type { ConnectorContext } from './ConnectorContext.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import type { IReadProbe } from '../GraphReader.js';
import { And, IdIn, Predicate } from '../predicate/Predicate.js';
import { ConnectorError, ConnectorPhase } from './ConnectorError.js';
import type { BindingTable } from './BindingTable.js';
import type { IExternalConnector, IFetchPage, IFetchRequest, IFetchTarget, IFetchedRow, RowVersion } from './FetchContract.js';

/** A row a session fetched and the model it was fetched for (FetchSession.Known, FetchSession.Lookup). */
export interface IFetchedEntry
{
    readonly Row: IFetchedRow;
    readonly Model: string;
}

/**
 * The scope's row predicate for a fetch of a concept (GraphReader.FetchPredicate, Or'ed over the family by
 * FederatedSource): what a fallback scan pushes down when a connector cannot look up by key or in reverse (D4, advisory).
 */
export interface IFetchScope
{
    RowPredicate(concept: string): Predicate;
}

/** The scope of a caller that gives none: every row may match (the engine still decides every fetched row). */
class UnscopedFetch implements IFetchScope
{
    public RowPredicate(): Predicate
    {
        return Predicate.True;
    }
}

/**
 * The reader of external connectors for one query (rulings R98, R99). One session serves one Cypher read or one
 * GraphTransaction, and so one ConnectorContext (spec section 6, ruling R132): every fetch it makes, continuations
 * included, carries that context, and the engine never shares a session, its memo or its fetches between contexts.
 * Key lookups and fetched rows are memoised by public id, so a query sees one value per external node, and nothing
 * outlives the session. Resume tokens are used only to drain one fetch page by page.
 *
 * Members (final review C1): every fetch kind (Scan, Lookup, Reverse) asks for BindingTable.FamilyProperties of its
 * target concept, the properties of the whole family hidden ones included. A fetched row's concept IsA the target
 * concept, so every row carries every property of its own concept whichever fetch returned it: a memo entry always
 * covers what any later fetch of that id would ask for, and is never refetched or replaced.
 *
 * Memo (final review I4): an entry serves a fetch of a target only when it was fetched for the target's model and its
 * concept IsA the target's concept. Otherwise a Lookup skips that candidate, and a Scan or Reverse yields its own row
 * without replacing the entry: the first admitted (model, row) of an id is the one Known and Lookup return.
 *
 * Every connector throw is wrapped as ConnectorError (Phase Fetch). Every fetched row passes the one validator
 * FetchedNode.Validated (public id and link target ids, concept, members, values with exact Int64 → Float64 widening;
 * final review I5) and must have a concept that IsA the target's; any failure fails the fetch as ConnectorError Fetch
 * whose cause is the GraphError SchemaViolation. A valid row owned by a more specific binding is dropped silently. A
 * target naming a connector the session was not given throws GraphError InvalidArgument: that is a setup error, not a
 * connector failure.
 *
 * Capabilities (final review I7, m4): a connector without KeyLookup is asked for a key by a scan of the candidate with
 * the predicate And(scope, IdIn{id}); one without ReverseLookup is asked for the rows linking to an id by a scan of the
 * target with the scope predicate, keeping rows whose Links hold the id. Correct, only slower. PushDown is informational.
 */
export class FetchSession
{
    private static readonly ErrConcept = 'Fetched row has a concept that is not the fetched concept: ';
    private static readonly ErrUnknownConnector = 'No connector named ';
    private static readonly Separator = ' / ';
    private static readonly KeySeparator = '\u0000';
    private static readonly Unscoped: IFetchScope = new UnscopedFetch();

    private readonly memo = new Map<string, IFetchedEntry>();
    private readonly misses = new Set<string>();
    private readonly names: ReadonlySet<string>;

    public constructor(
        private readonly connectors: ReadonlyMap<string, IExternalConnector>,
        private readonly bindings: BindingTable,
        private readonly catalog: CatalogSnapshot,
        private readonly context: ConnectorContext,
    )
    {
        this.names = new Set(connectors.keys());
    }

    /** The names of the connectors this session fetches from (the External connectors it was given). */
    public get ConnectorNames(): ReadonlySet<string>
    {
        return this.names;
    }

    /**
     * The row this session holds for the public id (the first admitted by any Scan, Lookup or Reverse) and the model it
     * was fetched for; undefined when it fetched none. Fetches nothing: how a transaction's commit decides writes
     * against what the transaction itself read (ruling R103). The row is validated but not yet decided by any scope.
     */
    public Known(publicId: string): IFetchedEntry | undefined
    {
        return this.memo.get(publicId);
    }

    /** Every row of the target matching the predicate, draining resume tokens; ticks the probe per page and per row examined. */
    public async *Scan(target: IFetchTarget, predicate: Predicate, probe?: IReadProbe): AsyncIterable<IFetchedRow>
    {
        yield* this.Drain(target, this.Request(target, predicate), probe, undefined);
    }

    /**
     * The row of `publicId` from the first candidate that has it, with the candidate's model (hits, and misses per
     * candidate, are memoised); ticks the probe per page and per row returned, as Scan. A memo entry another candidate
     * does not satisfy (see the class comment) makes Lookup skip that candidate. `scope` gives the predicate a fallback
     * scan pushes down for a connector without KeyLookup. LookupMany of the one id.
     */
    public async Lookup(publicId: string, candidates: readonly IFetchTarget[], probe?: IReadProbe, scope: IFetchScope = FetchSession.Unscoped): Promise<IFetchedEntry | undefined>
    {
        return (await this.LookupMany([publicId], candidates, probe, scope)).get(publicId);
    }

    /**
     * Lookup of every id at once (ruling R121 F1): per candidate, in order, one request for the ids no earlier candidate
     * answered and none has a memoised miss of: a keyed request (Keys, in the ids' order) when the connector declares
     * KeyLookup, else one scan with And(scope, IdIn{ids}). Rows of other ids are ignored outright. Hits and misses are
     * memoised as Lookup memoises them, and an id with a memo entry is answered from it alone (the first candidate the
     * entry serves), never fetched. The result holds the ids found, absent ones are missing.
     */
    public async LookupMany(publicIds: readonly string[], candidates: readonly IFetchTarget[], probe?: IReadProbe, scope: IFetchScope = FetchSession.Unscoped): Promise<ReadonlyMap<string, IFetchedEntry>>
    {
        const found = new Map<string, IFetchedEntry>();
        const unknown: string[] = [];
        for (const publicId of new Set(publicIds))
        {
            const entry = this.memo.get(publicId);
            if (entry === undefined)
            {
                unknown.push(publicId);
            }
            else if (candidates.some(target => this.Serves(entry, target)))
            {
                found.set(publicId, entry);
            }
        }
        for (const target of candidates)
        {
            const pending = new Set(unknown.filter(id => !found.has(id) && !this.misses.has(this.MissKey(id, target))));
            if (pending.size === 0)
            {
                continue;
            }
            const ids = [...pending];
            const request = this.Connector(target).Capabilities.KeyLookup
                ? { ...this.Request(target, Predicate.True), Keys: ids }
                : this.Request(target, new And([scope.RowPredicate(target.Concept), new IdIn(new Set(ids))]));
            for await (const row of this.Drain(target, request, probe, pending))
            {
                if (pending.delete(row.PublicId))
                {
                    const hit = { Row: row, Model: target.Model };
                    this.memo.set(row.PublicId, hit);
                    found.set(row.PublicId, hit);
                    if (pending.size === 0)
                    {
                        break;
                    }
                }
            }
            for (const id of pending)
            {
                this.misses.add(this.MissKey(id, target));
            }
        }
        return found;
    }

    /**
     * Rows of the target that link to `targetId` by `relationship`, as the session holds them; ticks the probe per page
     * and per row, as Scan. Through the connector's reverse lookup when it declares ReverseLookup, else through a scan of
     * the target with `predicate` (the scope's), keeping the rows whose Links[relationship] holds the id.
     */
    public async *Reverse(target: IFetchTarget, relationship: string, targetId: string, predicate: Predicate, probe?: IReadProbe): AsyncIterable<IFetchedRow>
    {
        if (this.Connector(target).Capabilities.ReverseLookup)
        {
            yield* this.Drain(target, { ...this.Request(target, predicate), Reverse: { Relationship: relationship, Target: targetId } }, probe, undefined);
            return;
        }
        for await (const row of this.Drain(target, this.Request(target, predicate), probe, undefined))
        {
            if ((row.Links.get(relationship) ?? []).includes(targetId))
            {
                yield row;
            }
        }
    }

    /** A fetch of the target's whole family's properties (see the class comment). */
    private Request(target: IFetchTarget, predicate: Predicate): IFetchRequest
    {
        return { Model: target.Model, Concept: target.Concept, Predicate: predicate, Members: this.bindings.FamilyProperties(target.Concept, this.catalog), Context: this.context };
    }

    /**
     * Pages through the fetch. With `onlyIds` (a key lookup) rows of other ids are ignored outright and nothing is
     * memoised here; otherwise each admitted row goes through Remember and the session's row is yielded.
     */
    private async *Drain(target: IFetchTarget, request: IFetchRequest, probe: IReadProbe | undefined, onlyIds: ReadonlySet<string> | undefined): AsyncGenerator<IFetchedRow>
    {
        const connector = this.Connector(target);
        let resume: string | undefined;
        do
        {
            let page: IFetchPage;
            try
            {
                page = await connector.Fetch(resume === undefined ? request : { ...request, Resume: resume });
            }
            catch (cause)
            {
                throw new ConnectorError(target.Connector, ConnectorPhase.Fetch, cause);
            }
            probe?.Tick();
            for (const fetched of page.Rows)
            {
                probe?.Tick();
                if (onlyIds !== undefined && !onlyIds.has(fetched.PublicId))
                {
                    continue;
                }
                const row = this.Admit(target, fetched);
                if (row === undefined)
                {
                    continue;
                }
                yield onlyIds === undefined ? this.Keep(target, row) : row;
            }
            resume = page.Resume;
        }
        while (resume !== undefined);
    }

    /**
     * Records a row the transaction created at the source (ruling R136 E4), so its commit decides later ops on that id
     * against it (R103) and `Fetch` returns it (R30). First-wins, as a fetched row: a created id has no prior memo entry.
     */
    public Remember(row: IFetchedRow, model: string): void
    {
        if (!this.memo.has(row.PublicId))
        {
            this.ClearMisses(row.PublicId);
            this.memo.set(row.PublicId, { Row: row, Model: model });
        }
    }

    /**
     * The row to use for a scanned row: the session's entry when it serves the target, else the scanned row itself. The
     * first row of an id is recorded (clearing the id's recorded misses); a later one never replaces it (D3).
     */
    private Keep(target: IFetchTarget, row: IFetchedRow): IFetchedRow
    {
        const entry = this.memo.get(row.PublicId);
        if (entry !== undefined)
        {
            return this.Serves(entry, target) ? entry.Row : row;
        }
        this.ClearMisses(row.PublicId);
        this.memo.set(row.PublicId, { Row: row, Model: target.Model });
        return row;
    }

    /** True when the entry may stand for a row of the target: fetched for its model, of a concept that IsA its concept. */
    private Serves(entry: IFetchedEntry, target: IFetchTarget): boolean
    {
        return entry.Model === target.Model && this.catalog.IsA(entry.Row.Concept, target.Concept);
    }

    /** The validated row, or undefined for a row another binding owns; ConnectorError Fetch for an invalid row. */
    private Admit(target: IFetchTarget, fetched: IFetchedRow): IFetchedRow | undefined
    {
        let row: IFetchedRow;
        try
        {
            row = FetchedNode.Validated(this.catalog, fetched);
            if (!this.catalog.IsA(row.Concept, target.Concept))
            {
                throw new GraphError(GraphErrorCode.SchemaViolation, FetchSession.ErrConcept + row.Concept + FetchSession.Separator + target.Concept);
            }
        }
        catch (cause)
        {
            throw new ConnectorError(target.Connector, ConnectorPhase.Fetch, cause);
        }
        return this.bindings.Resolve(target.Model, row.Concept, this.catalog) === target.Connector ? row : undefined;
    }

    private ClearMisses(publicId: string): void
    {
        const prefix = publicId + FetchSession.KeySeparator;
        for (const key of [...this.misses])
        {
            if (key.startsWith(prefix))
            {
                this.misses.delete(key);
            }
        }
    }

    private MissKey(publicId: string, target: IFetchTarget): string
    {
        return [publicId, target.Model, target.Concept, target.Connector].join(FetchSession.KeySeparator);
    }

    private Connector(target: IFetchTarget): IExternalConnector
    {
        const connector = this.connectors.get(target.Connector);
        if (connector === undefined)
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, FetchSession.ErrUnknownConnector + target.Connector);
        }
        return connector;
    }
}

/**
 * The expected version of the next change to each external id, for one GraphTransaction (ruling R137 E5). It keeps the
 * versions this transaction's own steps reported (IConnectorApplyResult.Versions, or a source-assigned create's row
 * Version) apart from the read memo's fetched versions (R119 V1). The expected version of a change is: the one this
 * transaction's own latest step reported for the id; else the fetched one; else none. A reported version supersedes
 * V2's "created by this transaction carries none" rule (a node created at step 1 and updated at step 3 is guarded with
 * step 1's reported version). One ledger belongs to one transaction and never guards another's write (ruling R138 E11).
 */
export class VersionLedger
{
    private readonly reported = new Map<string, RowVersion>();

    /** Records the version a step reported for the id; the next change to it is guarded with this. */
    public Reported(publicId: string, version: RowVersion): void
    {
        this.reported.set(publicId, version);
    }

    /** A copy of every version reported so far, keyed by public id; never the live map. */
    public Committed(): ReadonlyMap<string, RowVersion>
    {
        return new Map(this.reported);
    }

    /**
     * The expected version of the next change to `publicId`: the latest reported one; else the fetched one (R119 V1)
     * unless the transaction created the id and the source has reported no version for it yet (R119 V2); else none.
     */
    public Expected(publicId: string, fetched: RowVersion | undefined, createdHere: boolean): RowVersion | undefined
    {
        const reported = this.reported.get(publicId);
        if (reported !== undefined)
        {
            return reported;
        }
        return createdHere ? undefined : fetched;
    }
}
