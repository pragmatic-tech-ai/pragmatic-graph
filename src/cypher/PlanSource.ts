import type { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import type { ILinkView } from '../GraphReader.js';
import { CatalogSource } from './CatalogSource.js';
import { CypherError } from './CypherError.js';
import type { CypherNode } from './CypherNode.js';
import type { IExpandRow } from './CypherSource.js';

/**
 * The source CypherEngine.Explain plans over: the engine's current catalog with nothing hidden (Explain shows the
 * unscoped plan). Planning only resolves labels, relationships and indexes; every read refuses, so an explained
 * plan can never be run by mistake.
 */
export class PlanSource extends CatalogSource
{
    private static readonly NoReads = 'an explained plan reads nothing';
    private static readonly NoHidden: ReadonlyMap<string, ReadonlySet<string>> = new Map();

    constructor(catalog: CatalogSnapshot)
    {
        super(catalog, PlanSource.NoHidden);
    }

    public ScanLabel(): AsyncIterable<CypherNode>
    {
        return PlanSource.Refuse();
    }

    public ScanAll(): AsyncIterable<CypherNode>
    {
        return PlanSource.Refuse();
    }

    public Node(): Promise<CypherNode | undefined>
    {
        return Promise.reject(new CypherError(PlanSource.NoReads));
    }

    public Expand(): AsyncIterable<IExpandRow>
    {
        return PlanSource.Refuse();
    }

    public OutLinks(): Promise<readonly ILinkView[]>
    {
        return Promise.reject(new CypherError(PlanSource.NoReads));
    }

    /** Undefined exactly when there is no index, as ReaderSource; the value is never sought. */
    public SeekEqual(label: string, member: string): AsyncIterable<CypherNode> | undefined
    {
        return this.FindIndex(this.labels.Resolve(label), member) === undefined ? undefined : PlanSource.Refuse();
    }

    private static async *Refuse<T>(): AsyncIterable<T>
    {
        throw new CypherError(PlanSource.NoReads);
    }
}
