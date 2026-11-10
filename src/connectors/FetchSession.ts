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

/**
 * The reader of external connectors for one query (rulings R98, R99). One session serves one Cypher read or one
 * GraphTransaction: key lookups and fetched rows are memoised by public id, so a query sees one value per external
 * node, and nothing outlives the session. Resume tokens are used only to drain one fetch page by page.
 *
 * Every connector throw is wrapped as ConnectorError (Phase Fetch). A fetched row is validated: one owned by a more
 * specific binding is dropped silently; a row with an undefined, aspect or unrelated concept, a non-property or
 * mistyped value or an invalid public id fails the fetch (cause GraphError SchemaViolation).
 */
export class FetchSession
{
    private static readonly ErrConcept = 'Fetched row has an unusable concept: ';
    private static readonly ErrMember = 'Fetched row has a value for a non-property member: ';
    private static readonly ErrValue = 'Fetched row has a mistyped value for member: ';
    private static readonly ErrPublicId = 'Fetched row has an invalid public id';
    private static readonly ErrUnknownConnector = 'No connector named ';
    private static readonly Separator = ' / ';

    private readonly memo = new Map<string, IFetchedRow | undefined>();

    public constructor(
        private readonly connectors: ReadonlyMap<string, IExternalConnector>,
        private readonly bindings: BindingTable,
        private readonly catalog: CatalogSnapshot,
    )
    {
    }

    /** Every row of the target matching the predicate, draining resume tokens; ticks the probe once per row. */
    public async *Scan(target: IFetchTarget, predicate: Predicate, members: readonly string[], probe?: IReadProbe): AsyncIterable<IFetchedRow>
    {
        yield* this.Drain(target, { Model: target.Model, Concept: target.Concept, Predicate: predicate, Members: members }, probe);
    }

    /** The row of `publicId` from the first candidate that has it (hits and misses are memoised). */
    public async Lookup(publicId: string, candidates: readonly IFetchTarget[]): Promise<IFetchedRow | undefined>
    {
        if (this.memo.has(publicId))
        {
            return this.memo.get(publicId);
        }
        for (const target of candidates)
        {
            const request: IFetchRequest = {
                Model: target.Model,
                Concept: target.Concept,
                Predicate: Predicate.True,
                Members: this.PropertyNames(target.Concept),
                Keys: [publicId],
            };
            for await (const row of this.Drain(target, request, undefined))
            {
                if (row.PublicId === publicId)
                {
                    this.memo.set(publicId, row);
                    return row;
                }
            }
        }
        this.memo.set(publicId, undefined);
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
        }, undefined);
    }

    private async *Drain(target: IFetchTarget, request: IFetchRequest, probe: IReadProbe | undefined): AsyncGenerator<IFetchedRow>
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
            for (const row of page.Rows)
            {
                if (!this.Admit(target, row))
                {
                    continue;
                }
                if (!this.memo.has(row.PublicId))
                {
                    this.memo.set(row.PublicId, row);
                }
                probe?.Tick();
                yield row;
            }
            resume = page.Resume;
        }
        while (resume !== undefined);
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
