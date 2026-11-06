import type { AccessScope } from './access/AccessScope.js';
import { ScopeValidator } from './access/ScopeValidator.js';
import type { CatalogSnapshot } from './catalog/CatalogSnapshot.js';
import { CatalogStore } from './catalog/CatalogStore.js';
import { ColumnStore } from './columns/ColumnStore.js';
import { EdgeStore } from './edges/EdgeStore.js';
import { PublicIdIndex } from './identity/PublicIdIndex.js';
import { RowIndex } from './identity/RowIndex.js';
import { IndexStore } from './indexes/IndexStore.js';
import type { IKeyValueStore, IReadTransaction } from './kv/KeyValue.js';
import { CatalogIndex } from './txn/CatalogIndex.js';
import { CommitLog } from './txn/CommitLog.js';
import type { Committer } from './txn/Committer.js';
import type { ISnapshotHandle } from './txn/ConflictHistory.js';

/** Something the GraphStore must end when it is disposed (open readers and transactions). */
export interface IGraphDisposable
{
    dispose(): void;
}

/**
 * One reader's consistent view: the KV read transaction, the last commit stored in that KV snapshot and
 * the catalog that snapshot holds. A transaction's view also holds a committer snapshot registration,
 * taken before the KV snapshot (rulings R30, F3); a plain reader's view has none, so long-lived readers
 * never pin conflict history. dispose() releases the KV transaction and any registration; idempotent.
 */
export class ReadSnapshot
{
    private disposed = false;

    public constructor(
        public readonly Txn: IReadTransaction,
        public readonly Handle: ISnapshotHandle | undefined,
        public readonly Commit: bigint,
        public readonly Index: CatalogIndex,
    )
    {
    }

    public dispose(): void
    {
        if (this.disposed)
        {
            return;
        }
        this.disposed = true;
        this.Txn.dispose();
        this.Handle?.dispose();
    }
}

/**
 * Internal state shared by a GraphStore and its readers: the KV store, the committer, read-side
 * building blocks (stateless across transactions; their caches are keyed by transaction), the current
 * catalog and the set of open readers. Not part of the public API.
 */
export class GraphContext
{
    public readonly Columns = new ColumnStore();
    public readonly Edges = new EdgeStore();
    public readonly Rows = new RowIndex();
    public readonly Ids = new PublicIdIndex();
    public readonly Indexes = new IndexStore(this.Columns, this.Ids);

    private readonly open = new Set<IGraphDisposable>();
    /** Per scope, the catalog version it was last validated against (ruling R63). */
    private readonly validated = new WeakMap<AccessScope, number>();
    private index: CatalogIndex;

    public constructor(public readonly Store: IKeyValueStore, public readonly Committer: Committer, catalog: CatalogSnapshot)
    {
        this.index = new CatalogIndex(catalog);
    }

    /** Version of the newest catalog the store has saved through this context. */
    public get CatalogVersion(): number
    {
        return this.index.Catalog.Version;
    }

    /** Makes a newly committed catalog current for later readers (the committer already applies it). Older versions are ignored. */
    public SetCatalog(snapshot: CatalogSnapshot): void
    {
        if (snapshot.Version <= this.index.Catalog.Version)
        {
            return;
        }
        this.index = new CatalogIndex(snapshot);
    }

    /**
     * Opens a view. `register` (transactions only, ruling F3): register with the committer FIRST, then
     * open the KV snapshot and read its last commit (ruling R30). Readers open the KV snapshot only.
     */
    public async OpenSnapshot(register: boolean): Promise<ReadSnapshot>
    {
        const handle = register ? this.Committer.RegisterSnapshot() : undefined;
        let txn: IReadTransaction | undefined;
        try
        {
            txn = await this.Store.BeginRead();
            const commit = await CommitLog.ReadLastCommit(txn);
            const index = await this.IndexFor(txn);
            return new ReadSnapshot(txn, handle, commit, index);
        }
        catch (error)
        {
            txn?.dispose();
            handle?.dispose();
            throw error;
        }
    }

    /** Validates the scope's names against `index` once per (scope, catalog version); see ScopeValidator. */
    public ValidateScope(scope: AccessScope, index: CatalogIndex): void
    {
        if (this.validated.get(scope) === index.Catalog.Version)
        {
            return;
        }
        ScopeValidator.Validate(scope, index);
        this.validated.set(scope, index.Catalog.Version);
    }

    public Track(reader: IGraphDisposable): void
    {
        this.open.add(reader);
    }

    public Forget(reader: IGraphDisposable): void
    {
        this.open.delete(reader);
    }

    public DisposeReaders(): void
    {
        for (const reader of [...this.open])
        {
            reader.dispose();
        }
    }

    /** The catalog stored in the transaction's snapshot: the current one, or loaded when the snapshot predates it. */
    private async IndexFor(txn: IReadTransaction): Promise<CatalogIndex>
    {
        const current = this.index;
        if ((await CatalogStore.StoredVersion(txn)) === current.Catalog.Version)
        {
            return current;
        }
        return new CatalogIndex(await CatalogStore.Load(txn));
    }
}
