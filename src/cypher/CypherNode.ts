import type { CellValue } from '../columns/CellValue.js';
import type { ILinkView, INodeView } from '../GraphReader.js';
import { CypherError } from './CypherError.js';

/**
 * A node as the query layer sees it: a detached copy of the node's identity and effective properties (null for
 * unset). Immutable except for Links, which the result codec fills at most once.
 */
export class CypherNode
{
    private static readonly LinksAlreadyFilled = 'node links were already filled: ';

    private links: readonly ILinkView[] | undefined;

    constructor(
        public readonly PublicId: string,
        public readonly Concept: string,
        public readonly Owner: string,
        public readonly Properties: ReadonlyMap<string, CellValue>,
    )
    {
    }

    public static FromView(view: INodeView): CypherNode
    {
        return new CypherNode(view.PublicId, view.Concept, view.Owner, view.Properties);
    }

    public get Links(): readonly ILinkView[] | undefined
    {
        return this.links;
    }

    public FillLinks(links: readonly ILinkView[]): void
    {
        if (this.links !== undefined)
        {
            throw new CypherError(CypherNode.LinksAlreadyFilled + this.PublicId);
        }
        this.links = links;
    }
}
