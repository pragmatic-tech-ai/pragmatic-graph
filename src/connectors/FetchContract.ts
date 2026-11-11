import type { CellValue } from '../columns/CellValue.js';
import type { ConnectorContext } from './ConnectorContext.js';
import type { Predicate, PredicateKind } from '../predicate/Predicate.js';
import type { IGraphConnector } from './GraphConnector.js';

/**
 * Where a connector's data lives relative to the engine (ruling R96). Mirrored (the default): the engine holds
 * the nodes and the connector receives write-through. External: the connector is the source of truth and the
 * engine only fetches rows from it on demand.
 */
export enum ConnectorResidency
{
    Mirrored = 1,
    External = 2,
}

/**
 * What an external connector can do natively (the engine re-checks every fetched row whatever it declares; final review
 * m4). KeyLookup false: a key lookup never relies on IFetchRequest.Keys, it fetches the candidate concept with the
 * predicate And(scope, IdIn{id}) and keeps the row of that id. ReverseLookup false: the rows linking to an id are found by
 * fetching the declaring concept under the scope and keeping those whose Links hold the id. PushDown is informational
 * only: the engine pushes the same advisory predicate whatever it lists, and never relies on the connector applying it.
 */
export interface IConnectorCapabilities
{
    readonly KeyLookup: boolean;
    readonly ReverseLookup: boolean;
    readonly PushDown: ReadonlySet<PredicateKind>;
}

/** One fetch of rows of a concept from an external connector. */
export interface IFetchRequest
{
    readonly Model: string;
    readonly Concept: string;
    readonly Predicate: Predicate;
    readonly Members: readonly string[];
    readonly Keys?: readonly string[];
    readonly Reverse?: { readonly Relationship: string; readonly Target: string };
    readonly Limit?: number;
    readonly Resume?: string;
    /** On whose behalf this fetch runs: its reader's or transaction's context, on every request including continuations. */
    readonly Context: ConnectorContext;
}

export interface IFetchedRow
{
    readonly PublicId: string;
    readonly Concept: string;
    readonly Values: ReadonlyMap<string, CellValue>;
    /** Relationship → target public ids, in declaration order. */
    readonly Links: ReadonlyMap<string, readonly string[]>;
}

export interface IFetchPage
{
    readonly Rows: readonly IFetchedRow[];
    readonly Resume?: string;
}

export interface IExternalConnector extends IGraphConnector
{
    readonly Residency: ConnectorResidency.External;
    readonly Capabilities: IConnectorCapabilities;
    /**
     * One page of rows. `request.Context` is the context of the one reader or transaction asking (spec section 6): serve the
     * fetch with that caller's connection or token only. The engine never caches, pools or batches fetches across
     * contexts, and never reuses one caller's rows for another; the connector must not either.
     */
    Fetch(request: IFetchRequest): Promise<IFetchPage>;
}

/** A (model, concept) an external connector is asked to fetch for a requested concept. */
export interface IFetchTarget
{
    readonly Model: string;
    readonly Concept: string;
    readonly Connector: string;
}
