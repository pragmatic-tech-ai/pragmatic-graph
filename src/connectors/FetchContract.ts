import type { CellValue } from '../columns/CellValue.js';
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

/** What an external connector can do natively; advisory (the engine re-checks every fetched row). */
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
    Fetch(request: IFetchRequest): Promise<IFetchPage>;
}

/** A (model, concept) an external connector is asked to fetch for a requested concept. */
export interface IFetchTarget
{
    readonly Model: string;
    readonly Concept: string;
    readonly Connector: string;
}
