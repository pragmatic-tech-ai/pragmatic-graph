import { randomUUID } from 'node:crypto';
import type { CellValue } from '../../columns/CellValue.js';

/** Where a node created by a Cypher write goes: its public id and its owner ('' for none). */
export interface INodePlace
{
    readonly PublicId: string;
    readonly Owner: string;
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
