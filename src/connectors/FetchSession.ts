import { FetchedNode } from '../access/FetchedNode.js';
import type { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import type { ConnectorContext } from './ConnectorContext.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import type { IReadProbe } from '../GraphReader.js';
import { And, IdIn, Predicate } from '../predicate/Predicate.js';
import { ConnectorError, ConnectorPhase } from './ConnectorError.js';
import type { BindingTable } from './BindingTable.js';
import type { IExternalConnector, IFetchPage, IFetchRequest, IFetchTarget, IFetchedRow } from './FetchContract.js';

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
     * scan pushes down for a connector without KeyLookup.
     */
    public async Lookup(publicId: string, candidates: readonly IFetchTarget[], probe?: IReadProbe, scope: IFetchScope = FetchSession.Unscoped): Promise<IFetchedEntry | undefined>
    {
        for (const target of candidates)
        {
            const entry = this.memo.get(publicId);
            if (entry !== undefined)
            {
                if (this.Serves(entry, target))
                {
                    return entry;
                }
                continue;
            }
            const missKey = this.MissKey(publicId, target);
            if (this.misses.has(missKey))
            {
                continue;
            }
            const request = this.Connector(target).Capabilities.KeyLookup
                ? { ...this.Request(target, Predicate.True), Keys: [publicId] }
                : this.Request(target, new And([scope.RowPredicate(target.Concept), new IdIn(new Set([publicId]))]));
            for await (const row of this.Drain(target, request, probe, publicId))
            {
                const found = { Row: row, Model: target.Model };
                this.memo.set(publicId, found);
                return found;
            }
            this.misses.add(missKey);
        }
        return undefined;
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
     * Pages through the fetch. With `onlyId` (a key lookup) rows of other ids are ignored outright and nothing is
     * memoised here; otherwise each admitted row goes through Remember and the session's row is yielded.
     */
    private async *Drain(target: IFetchTarget, request: IFetchRequest, probe: IReadProbe | undefined, onlyId: string | undefined): AsyncGenerator<IFetchedRow>
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
                if (onlyId !== undefined && fetched.PublicId !== onlyId)
                {
                    continue;
                }
                const row = this.Admit(target, fetched);
                if (row === undefined)
                {
                    continue;
                }
                yield onlyId === undefined ? this.Remember(target, row) : row;
            }
            resume = page.Resume;
        }
        while (resume !== undefined);
    }

    /**
     * The row to use for a scanned row: the session's entry when it serves the target, else the scanned row itself. The
     * first row of an id is recorded (clearing the id's recorded misses); a later one never replaces it (D3).
     */
    private Remember(target: IFetchTarget, row: IFetchedRow): IFetchedRow
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
