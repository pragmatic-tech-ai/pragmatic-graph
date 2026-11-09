import type { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import type { IndexDef, MemberDef } from '../catalog/CatalogTypes.js';
import type { CellValue } from '../columns/CellValue.js';
import type { ILinkView, IReadProbe } from '../GraphReader.js';
import type { RelDirection } from './CypherEnums.js';
import type { CypherNode } from './CypherNode.js';
import type { ICypherSource, IExpandRow } from './CypherSource.js';
import { LabelResolver } from './LabelResolver.js';

/**
 * The plan-time half of an ICypherSource, answered from one catalog snapshot and the scope's hidden member names alone:
 * label resolution, relationship names, IsA and index choice. Nothing here reads a node. ReaderSource adds the
 * reads over a scoped reader; PlanSource (Explain) refuses them.
 */
export abstract class CatalogSource implements ICypherSource
{
    private static readonly IndexKeySeparator = '\u0000';

    protected readonly labels: LabelResolver;
    private readonly relationships: ReadonlySet<string>;
    private readonly indexCache = new Map<string, IndexDef | undefined>();

    /** `hidden`: every member name the scope hides on any concept (AccessScope.HiddenNames: Hidden and HiddenExact). */
    protected constructor(protected readonly catalog: CatalogSnapshot, private readonly hidden: ReadonlySet<string>)
    {
        this.labels = new LabelResolver(catalog);
        this.relationships = new Set(catalog.Relationships());
    }

    public ResolveLabel(label: string): string
    {
        return this.labels.Resolve(label);
    }

    public HasRelationship(name: string): boolean
    {
        return this.relationships.has(name);
    }

    public IsA(node: CypherNode, label: string): boolean
    {
        return this.catalog.IsA(node.Concept, this.labels.Resolve(label));
    }

    public IndexFor(label: string, member: string): string | undefined
    {
        return this.FindIndex(this.labels.Resolve(label), member)?.Name;
    }

    public abstract ScanLabel(label: string, probe?: IReadProbe): AsyncIterable<CypherNode>;
    public abstract ScanAll(probe?: IReadProbe): AsyncIterable<CypherNode>;
    public abstract Node(publicId: string): Promise<CypherNode | undefined>;
    public abstract Expand(publicId: string, relationship: string | undefined, direction: RelDirection, probe?: IReadProbe): AsyncIterable<IExpandRow>;
    public abstract OutLinks(publicId: string): Promise<readonly ILinkView[]>;
    public abstract SeekEqual(label: string, member: string, value: CellValue, probe?: IReadProbe): AsyncIterable<CypherNode> | undefined;

    protected FindIndex(label: string, member: string): IndexDef | undefined
    {
        const cacheKey = label + CatalogSource.IndexKeySeparator + member;
        if (!this.indexCache.has(cacheKey))
        {
            const catalog = this.catalog;
            const candidates = catalog.IsAspect(label) ? catalog.Indexes().filter(i => i.On === label) : catalog.IndexesOn(label);
            this.indexCache.set(cacheKey, candidates.find(i => i.Where === undefined && catalog.IndexMembers(i)[0]?.Name === member && !this.HidesAny(catalog.IndexMembers(i))));
        }
        return this.indexCache.get(cacheKey);
    }

    // SeekIndex skips a node when the scope hides ANY member of the index, so such an index would drop rows the scan
    // returns. Conservative: a member name hidden on any type (by Hidden or HiddenExact) disqualifies the index.
    private HidesAny(members: readonly MemberDef[]): boolean
    {
        return members.some(m => this.hidden.has(m.Name));
    }
}
