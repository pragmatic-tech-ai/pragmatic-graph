import { randomUUID } from 'node:crypto';
import type { CellValue } from '../../columns/CellValue.js';

/**
 * Where a node created by a Cypher write goes: its public id, its owner ('' for none) and the property values
 * a CREATE / MERGE sets when the query did not set them (ruling R91). Defaults are written before the scope's
 * Create rules are judged, so they count for them, and are exempt from the scope's ReadOnly members.
 */
export interface INodePlace
{
    readonly PublicId: string;
    readonly Owner: string;
    readonly Defaults?: ReadonlyMap<string, CellValue>;
    /**
     * True when the source assigns the key: the place carries `PublicId: ''` and CREATE goes through
     * GraphTransaction.CreateAssigned, so the created node holds the source-minted id (ruling R136 E4).
     */
    readonly KeyAssigned?: true;
}

/**
 * Chooses the identity of every node a Cypher CREATE / MERGE creates, from its concept and initial properties.
 * The host decides (a TODL host maps the owner to the holding model); the engine's built-in is GuidPlacement.
 */
export interface INodePlacement
{
    Place(concept: string, properties: ReadonlyMap<string, CellValue>): INodePlace;
}

/** The engine's default placement: a random UUID and no owner. */
export class GuidPlacement implements INodePlacement
{
    private static readonly NoOwner = '';

    public Place(): INodePlace
    {
        return { PublicId: randomUUID(), Owner: GuidPlacement.NoOwner };
    }
}
