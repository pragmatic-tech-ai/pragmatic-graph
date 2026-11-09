import type { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import { CypherSemanticError } from './CypherError.js';

/**
 * Maps a Cypher label to a catalog name (concept or aspect): an exact name wins; otherwise the label must equal
 * the segment after the last '.' of exactly one name. Unknown and ambiguous labels raise CypherSemanticError with
 * TODL's GraphQueryAdapter messages. Results are cached per resolver (one catalog snapshot).
 */
export class LabelResolver
{
    private static readonly UnknownLabel = 'unknown label';
    private static readonly AmbiguousLabel = 'ambiguous label';
    private static readonly NameSeparator = ', ';
    private static readonly Dot = '.';

    private readonly resolved = new Map<string, string>();

    constructor(private readonly catalog: CatalogSnapshot)
    {
    }

    public Resolve(label: string): string
    {
        const cached = this.resolved.get(label);
        if (cached !== undefined)
        {
            return cached;
        }
        const name = this.Lookup(label);
        this.resolved.set(label, name);
        return name;
    }

    private Lookup(label: string): string
    {
        if (this.catalog.Has(label))
        {
            return label;
        }
        const matches = this.catalog.Names().filter(n => n.substring(n.lastIndexOf(LabelResolver.Dot) + 1) === label);
        if (matches.length > 1)
        {
            throw new CypherSemanticError(`${LabelResolver.AmbiguousLabel} "${label}": ${matches.join(LabelResolver.NameSeparator)}`);
        }
        if (matches.length === 0)
        {
            throw new CypherSemanticError(`${LabelResolver.UnknownLabel} "${label}"`);
        }
        return matches[0]!;
    }
}
