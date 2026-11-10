import type { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import { MemberKind } from '../catalog/ValueType.js';
import { ValueCodec } from '../columns/ValueCodec.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import type { IReadProbe } from '../GraphReader.js';
import { Predicate } from '../predicate/Predicate.js';
import { BatchApplier } from '../txn/BatchApplier.js';
import { ConnectorError, ConnectorPhase } from './ConnectorError.js';
import type { BindingTable } from './BindingTable.js';
import type { IExternalConnector, IFetchPage, IFetchRequest, IFetchTarget, IFetchedRow } from './FetchContract.js';

/** What the session remembers about one public id: the row (undefined for a miss), its model and the members it was fetched with. */
interface IMemoEntry
{
    readonly Row: IFetchedRow;
    readonly Model: string;
    readonly Members: ReadonlySet<string>;
}

/**
 * The reader of external connectors for one query (rulings R98, R99). One session serves one Cypher read or one
 * GraphTransaction: key lookups and fetched rows are memoised by public id, so a query sees one value per external
 * node, and nothing outlives the session. Resume tokens are used only to drain one fetch page by page.
 *
 * Every connector throw is wrapped as ConnectorError (Phase Fetch). A fetched row is validated: one owned by a more
 * specific binding is dropped silently; a row with an undefined, aspect or unrelated concept, a non-property or
 * mistyped value or an invalid public id fails the fetch (cause GraphError SchemaViolation). A target naming a
 * connector the session was not given throws GraphError InvalidArgument: that is a setup error, not a connector failure.
 *
 * A memo entry records the members it was fetched with. Lookup needs every property and refetches when the entry does
 * not cover them; a Scan yields the session's entry when it covers the scan's members, else replaces it.
 */
export class FetchSession
{
    private static readonly ErrConcept = 'Fetched row has an unusable concept: ';
    private static readonly ErrMember = 'Fetched row has a value for a non-property member: ';
    private static readonly ErrValue = 'Fetched row has a mistyped value for member: ';
    private static readonly ErrPublicId = 'Fetched row has an invalid public id';
    private static readonly ErrUnknownConnector = 'No connector named ';
    private static readonly Separator = ' / ';
    private static readonly KeySeparator = '\u0000';

    private readonly memo = new Map<string, IMemoEntry>();
    private readonly misses = new Set<string>();

    public constructor(
        private readonly connectors: ReadonlyMap<string, IExternalConnector>,
        private readonly bindings: BindingTable,
        private readonly catalog: CatalogSnapshot,
    )
    {
    }

    /** Every row of the target matching the predicate, draining resume tokens; ticks the probe per page and per row examined. */
    public async *Scan(target: IFetchTarget, predicate: Predicate, members: readonly string[], probe?: IReadProbe): AsyncIterable<IFetchedRow>
    {
        const request: IFetchRequest = { Model: target.Model, Concept: target.Concept, Predicate: predicate, Members: members };
        yield* this.Drain(target, request, probe, undefined);
    }

    /** The row of `publicId` from the first candidate that has it (hits, and misses per candidate, are memoised). */
    public async Lookup(publicId: string, candidates: readonly IFetchTarget[]): Promise<IFetchedRow | undefined>
    {
        for (const target of candidates)
        {
            const required = this.PropertyNames(target.Concept);
            const entry = this.memo.get(publicId);
            const missKey = this.MissKey(publicId, target);
            if (entry !== undefined)
            {
                if (entry.Model !== target.Model || !this.catalog.IsA(entry.Row.Concept, target.Concept))
                {
                    continue;
                }
                if (required.every(name => entry.Members.has(name)))
                {
                    return entry.Row;
                }
            }
            if (this.misses.has(missKey))
            {
                continue;
            }
            const request: IFetchRequest = {
                Model: target.Model,
                Concept: target.Concept,
                Predicate: Predicate.True,
                Members: required,
                Keys: [publicId],
            };
            for await (const row of this.Drain(target, request, undefined, publicId))
            {
                this.memo.set(publicId, { Row: row, Model: target.Model, Members: new Set(required) });
                return row;
            }
            this.misses.add(missKey);
        }
        return undefined;
    }

    /** Rows of the target that link to `targetId` by `relationship`; nothing when the connector cannot look up in reverse. */
    public async *Reverse(target: IFetchTarget, relationship: string, targetId: string): AsyncIterable<IFetchedRow>
    {
        if (!this.Connector(target).Capabilities.ReverseLookup)
        {
            return;
        }
        yield* this.Drain(target, {
            Model: target.Model,
            Concept: target.Concept,
            Predicate: Predicate.True,
            Members: this.PropertyNames(target.Concept),
            Reverse: { Relationship: relationship, Target: targetId },
        }, undefined, undefined);
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
            for (const row of page.Rows)
            {
                if (onlyId !== undefined && row.PublicId !== onlyId)
                {
                    continue;
                }
                probe?.Tick();
                if (!this.Admit(target, row))
                {
                    continue;
                }
                yield onlyId === undefined ? this.Remember(target, request, row) : row;
            }
            resume = page.Resume;
        }
        while (resume !== undefined);
    }

    /**
     * Records the row unless the session already holds one covering the request's members; returns the row to use.
     * The newer fetch replaces a non-covering entry whole: merging two fetches' values would mix moments within one
     * entry (D3). A stored row clears the recorded misses of its id.
     */
    private Remember(target: IFetchTarget, request: IFetchRequest, row: IFetchedRow): IFetchedRow
    {
        const entry = this.memo.get(row.PublicId);
        if (entry !== undefined && request.Members.every(name => entry.Members.has(name)))
        {
            return entry.Row;
        }
        this.ClearMisses(row.PublicId);
        this.memo.set(row.PublicId, { Row: row, Model: target.Model, Members: new Set(request.Members) });
        return row;
    }

    /** False for a row another binding owns; throws ConnectorError for an invalid row. */
    private Admit(target: IFetchTarget, row: IFetchedRow): boolean
    {
        try
        {
            this.RequireValid(target, row);
        }
        catch (cause)
        {
            throw new ConnectorError(target.Connector, ConnectorPhase.Fetch, cause);
        }
        return this.bindings.Resolve(target.Model, row.Concept, this.catalog) === target.Connector;
    }

    private RequireValid(target: IFetchTarget, row: IFetchedRow): void
    {
        try
        {
            BatchApplier.RequirePublicId(row.PublicId);
        }
        catch (cause)
        {
            throw new GraphError(GraphErrorCode.SchemaViolation, FetchSession.ErrPublicId, cause);
        }
        const catalog = this.catalog;
        if (!catalog.Has(row.Concept) || catalog.IsAspect(row.Concept) || !catalog.IsA(row.Concept, target.Concept))
        {
            throw new GraphError(GraphErrorCode.SchemaViolation, FetchSession.ErrConcept + row.Concept + FetchSession.Separator + target.Concept);
        }
        const members = catalog.EffectiveMembers(row.Concept);
        for (const [name, value] of row.Values)
        {
            const member = members.find(m => m.Name === name);
            if (member === undefined || member.Kind !== MemberKind.Property || member.Type === undefined)
            {
                throw new GraphError(GraphErrorCode.SchemaViolation, FetchSession.ErrMember + name);
            }
            if (value === null)
            {
                continue;
            }
            try
            {
                ValueCodec.Check(member.Type, value);
            }
            catch (cause)
            {
                throw new GraphError(GraphErrorCode.SchemaViolation, FetchSession.ErrValue + name, cause);
            }
        }
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

    private PropertyNames(concept: string): readonly string[]
    {
        return this.catalog.EffectiveMembers(concept).filter(m => m.Kind === MemberKind.Property).map(m => m.Name);
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
