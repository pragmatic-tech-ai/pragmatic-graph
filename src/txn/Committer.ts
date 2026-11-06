import { CatalogModel } from '../catalog/CatalogModel.js';
import { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import { CatalogStore } from '../catalog/CatalogStore.js';
import { ColumnStore } from '../columns/ColumnStore.js';
import { Compactor } from '../columns/Compactor.js';
import { EdgeStore } from '../edges/EdgeStore.js';
import { IdAllocator } from '../identity/IdAllocator.js';
import { PublicIdIndex } from '../identity/PublicIdIndex.js';
import { RowIndex } from '../identity/RowIndex.js';
import type { IKeyValueStore, IWriteTransaction } from '../kv/KeyValue.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import { FormatMeta } from '../format/FormatMeta.js';
import { CatalogPlanner } from '../schema/CatalogPlanner.js';
import { DataPurger } from '../schema/DataPurger.js';
import type { ISchemaDescription } from '../schema/SchemaDescription.js';
import { BatchApplier } from './BatchApplier.js';
import { CatalogIndex } from './CatalogIndex.js';
import { CommitError } from './CommitError.js';
import { CommitLog } from './CommitLog.js';
import { ConflictError } from './ConflictError.js';
import { ConflictHistory, type ISnapshotHandle } from './ConflictHistory.js';
import { CommitKind, type ICommitApplied, LogEntry } from './LogEntry.js';
import type { ReadSet } from './ReadSet.js';
import { Signal } from './Signal.js';
import { WriteBatch } from './WriteBatch.js';
import { WriteKeySet } from './WriteKeySet.js';

export { CommitKind, type ICommitApplied } from './LogEntry.js';

/** A committed schema change: its commit number and the resulting catalog. */
export interface ISchemaCommit
{
    readonly Commit: bigint;
    readonly Catalog: CatalogSnapshot;
}

/** The outcome of an upgrade (SubmitUpgrade). */
export interface IUpgradeCommit
{
    /** The Upgrade entry's commit number; LastCommit() at the upgrade's turn when nothing changed. */
    readonly Commit: bigint;
    /** The catalog in force after the upgrade (the unchanged one when Changed is false). */
    readonly Catalog: CatalogSnapshot;
    /** True iff a new catalog was saved and logged (ICatalogPlan.Changed). */
    readonly Changed: boolean;
}

export interface ICommitterOptions
{
    /** The store's current last commit (Meta("commit")); Committer.Open reads it. Default 0. */
    readonly LastCommit?: bigint;
    /** Id allocator over the same store; opened on first use when absent. */
    readonly Allocator?: IdAllocator;
}

/** One submitted batch waiting for (or inside) a group. */
class PendingCommit
{
    /** Internal ids for the batch's CreateNode ops, allocated once and reused across group re-runs. */
    public Ids: bigint[] | undefined;

    /** Resolve/Reject settle once; later calls are no-ops, so a failing group can reject whatever is left. */
    private settled = false;

    /**
     * `CatalogVersion`: the version the submitter's transaction began with; checked inside the group
     * against the group's catalog (ruling F4). Undefined: no check.
     */
    public constructor(
        public readonly Bytes: Uint8Array,
        public readonly Batch: WriteBatch,
        public readonly Reads: ReadSet,
        public readonly Snapshot: bigint,
        private readonly resolve: (commit: bigint) => void,
        private readonly reject: (error: unknown) => void,
        public readonly CatalogVersion?: number,
    )
    {
    }

    public Resolve(commit: bigint): void
    {
        if (!this.settled)
        {
            this.settled = true;
            this.resolve(commit);
        }
    }

    public Reject(error: unknown): void
    {
        if (!this.settled)
        {
            this.settled = true;
            this.reject(error);
        }
    }
}

/** Queued work that runs alone in its own group (a schema change or an upgrade). */
interface IExclusiveCommit
{
    /** Runs the work and settles with its result or error. */
    Run(): Promise<void>;
    Reject(error: unknown): void;
}

/**
 * Work that runs alone in its own group when its turn comes, i.e. after every commit submitted before it
 * has been applied. Settles once with the work's result or error.
 */
class ExclusiveCommit<T> implements IExclusiveCommit
{
    private settled = false;

    public constructor(
        private readonly work: () => Promise<T>,
        private readonly resolve: (value: T) => void,
        private readonly reject: (error: unknown) => void,
    )
    {
    }

    public async Run(): Promise<void>
    {
        let result: T;
        try
        {
            result = await this.work();
        }
        catch (error)
        {
            this.Reject(error);
            return;
        }
        if (!this.settled)
        {
            this.settled = true;
            this.resolve(result);
        }
    }

    public Reject(error: unknown): void
    {
        if (!this.settled)
        {
            this.settled = true;
            this.reject(error);
        }
    }
}

/** A batch that failed semantically while its group was applying; aborts the group's store.Write. */
class BatchFailure extends Error
{
    public constructor(public readonly Pending: PendingCommit, public readonly Failure: CommitError)
    {
        super(Failure.message);
    }
}

/** A batch accepted by one group attempt, with its logical write set. */
interface IAccepted
{
    readonly Pending: PendingCommit;
    readonly Keys: WriteKeySet;
}

/** What one group store.Write decided; promises settle only after the Write resolved. */
interface IGroupOutcome
{
    readonly Accepted: readonly IAccepted[];
    readonly Conflicts: ReadonlyArray<readonly [PendingCommit, Error]>;
    /** The catalog version the group was validated and applied against. */
    readonly CatalogVersion: number;
}

/**
 * The only writer of graph data: optimistic, serializable commits of WriteBatches.
 *
 * Every Submit waiting at the same time forms one group (group commit). For a group the committer
 * (1) validates each batch's ReadSet against the write sets committed after its snapshot (ruling R24),
 * (2) allocates internal ids for every CreateNode BEFORE entering the store's write (ruling R16), then
 * (3) in ONE store.Write applies the batches in submission order, validating each against the write sets
 * of the batches accepted before it in the same group, compacts deltas over CompactThreshold, flushes
 * the column store and the row index (each dirty chunk delta and row block written once), appends each accepted batch to the log and sets Meta("commit") (ruling R25).
 * A batch that is semantically invalid (CommitError) aborts that store.Write; only it is rejected and
 * the rest of the group re-runs in a fresh Write, so its partial writes leave no trace. Any other error
 * rejects the whole group. Commit numbers follow submission order. CommitApplied is raised once per
 * commit, in order, after the store.Write resolved; a throwing subscriber does not affect the commit.
 *
 * Snapshots: a transaction (never a plain reader, ruling F3) calls RegisterSnapshot() and only THEN
 * opens its store read transaction, so the
 * data it reads is at least as new as the registered commit (validation is then conservative, never
 * lax). Dispose the handle when the transaction ends.
 */
export class Committer
{
    /** A chunk delta holding more entries than this after a group is folded into its chunk in the same Write. */
    public static readonly CompactThreshold = 512;

    private static readonly ErrSnapshot = 'Snapshot commit is after the last commit: ';
    private static readonly ErrStale = 'Stored last commit does not match the committer (another writer, or not opened with Committer.Open): stored ';
    private static readonly ErrExpected = ', expected ';
    private static readonly ErrDisposed = 'Committer has been disposed';
    private static readonly ErrInGroup = 'Read set conflicts with an earlier batch of the same commit group';
    private static readonly ErrCompactMember = 'Delta for a member the catalog does not know: ';
    private static readonly ErrSchema = 'The schema changed after the transaction began: catalog version ';
    private static readonly ErrSchemaNow = ', now ';
    private static readonly ErrSchemaVersion = 'Schema version must be well-formed UTF-16 (no lone surrogates)';
    private static readonly EmptyBatch = new WriteBatch().Seal();
    private static readonly Encoder = new TextEncoder();
    private static readonly Decoder = new TextDecoder();

    public readonly CommitApplied = new Signal<ICommitApplied>();

    private readonly columns = new ColumnStore();
    private readonly compactor = new Compactor(this.columns);
    private readonly edges = new EdgeStore();
    private readonly rows = new RowIndex();
    private readonly ids = new PublicIdIndex();
    private readonly log = new CommitLog();
    private readonly history: ConflictHistory;
    private readonly purger = new DataPurger(this.columns, this.edges, this.rows, this.ids);
    private readonly queue: Array<PendingCommit | IExclusiveCommit> = [];
    private index: CatalogIndex;
    private allocator: Promise<IdAllocator> | undefined;
    /** The running Pump (undefined when idle); dispose() awaits it. */
    private pump: Promise<void> | undefined;
    private disposed = false;

    public constructor(private readonly store: IKeyValueStore, catalog: CatalogSnapshot, options?: ICommitterOptions)
    {
        this.index = new CatalogIndex(catalog);
        this.history = new ConflictHistory(options?.LastCommit ?? 0n);
        this.allocator = options?.Allocator === undefined ? undefined : Promise.resolve(options.Allocator);
    }

    /** Opens a committer that continues from the store's stored last commit. */
    public static async Open(store: IKeyValueStore, catalog: CatalogSnapshot): Promise<Committer>
    {
        const txn = await store.BeginRead();
        let last: bigint;
        try
        {
            last = await CommitLog.ReadLastCommit(txn);
        }
        finally
        {
            txn.dispose();
        }
        return new Committer(store, catalog, { LastCommit: last, Allocator: await IdAllocator.Open(store) });
    }

    public LastCommit(): bigint
    {
        return this.history.Last;
    }

    /** Diagnostics: commits after this one still have their write sets retained for validation. */
    public get HistoryFloor(): bigint
    {
        return this.history.Floor;
    }

    /** Pins conflict history back to the current last commit until the handle is disposed (ruling R24). */
    public RegisterSnapshot(): ISnapshotHandle
    {
        return this.history.Register();
    }

    /** The catalog later groups validate and apply against. */
    public get Catalog(): CatalogSnapshot
    {
        return this.index.Catalog;
    }

    /**
     * Low-level: later groups apply batches against this catalog (a group already running keeps its
     * catalog). Bypasses the log; GraphStore changes the schema through SubmitSchema instead.
     */
    public UpdateCatalog(snapshot: CatalogSnapshot): void
    {
        this.index = new CatalogIndex(snapshot);
    }

    /**
     * Commits the batch if nothing it read (readSet, taken at snapshotCommit) was written by a later
     * commit; resolves with its commit number. Rejects with ConflictError on a read conflict (or a
     * snapshot older than the retained window), CommitError when the batch is semantically invalid, and
     * GraphError InvalidArgument when snapshotCommit is after LastCommit(). The batch and read set are captured now.
     */
    public Submit(batch: WriteBatch, readSet: ReadSet, snapshotCommit: bigint, catalogVersion?: number): Promise<bigint>
    {
        if (this.disposed)
        {
            return Promise.reject(new GraphError(GraphErrorCode.Disposed, Committer.ErrDisposed));
        }
        if (snapshotCommit > this.history.Last || snapshotCommit < 0n)
        {
            return Promise.reject(new GraphError(GraphErrorCode.InvalidArgument, Committer.ErrSnapshot + snapshotCommit));
        }
        let bytes: Uint8Array;
        try
        {
            bytes = batch.Serialize();
        }
        catch (error)
        {
            return Promise.reject(error);
        }
        return new Promise<bigint>((resolve, reject) =>
        {
            this.queue.push(new PendingCommit(bytes, WriteBatch.Deserialize(bytes).Seal(), readSet.Clone(), snapshotCommit, resolve, reject, catalogVersion));
            this.pump ??= this.Pump();
        });
    }

    /**
     * Commits a schema change (ruling F4): `define` extends a model of the catalog current when the
     * change's turn comes (every commit submitted before it has been applied), the sealed result is
     * saved, logged as a SchemaChange entry with its own commit number and raised on CommitApplied. A
     * schema change runs alone in its group. Batches of transactions that began on an older catalog
     * fail with ConflictError. A definition error (CatalogError) rejects only this change.
     */
    public SubmitSchema(define: (model: CatalogModel) => void): Promise<ISchemaCommit>
    {
        if (this.disposed)
        {
            return Promise.reject(new GraphError(GraphErrorCode.Disposed, Committer.ErrDisposed));
        }
        return this.Enqueue(() => this.RunSchema(define));
    }

    /**
     * Upgrades the schema to a description (spec 4.3): when its turn comes (alone in its group, like
     * SubmitSchema) the description is planned against the committer's current catalog. When the plan
     * changes the catalog, ONE store.Write purges the data that no longer fits (DataPurger), saves the
     * catalog, writes Meta("schemaVersion"), appends an Upgrade log entry and raises CommitApplied; the
     * purge's write keys conflict open transactions, which also fail on the catalog version. When the
     * catalog is unchanged only a differing Meta("schemaVersion") is rewritten: no commit, no entry, no
     * signal (ruling R48). A planning error (CatalogError) rejects only this upgrade and changes nothing;
     * a version that is not well-formed UTF-16 is GraphError InvalidArgument.
     */
    public SubmitUpgrade(description: ISchemaDescription): Promise<IUpgradeCommit>
    {
        if (this.disposed)
        {
            return Promise.reject(new GraphError(GraphErrorCode.Disposed, Committer.ErrDisposed));
        }
        if (Committer.Decoder.decode(Committer.Encoder.encode(description.Version)) !== description.Version)
        {
            return Promise.reject(new GraphError(GraphErrorCode.InvalidArgument, Committer.ErrSchemaVersion));
        }
        return this.Enqueue(() => this.RunUpgrade(description));
    }

    /**
     * Stops accepting work: every queued Submit not yet in a group and every later Submit rejects;
     * CommitApplied subscribers are dropped. A group already writing finishes (its commits are durable
     * and its promises settle) but raises no signal; no new group starts. Resolves once that group has
     * settled, so the store can then be closed. Idempotent: every call resolves at the same point.
     */
    public async dispose(): Promise<void>
    {
        if (this.disposed)
        {
            await this.pump;
            return;
        }
        this.disposed = true;
        const error = new GraphError(GraphErrorCode.Disposed, Committer.ErrDisposed);
        for (const p of this.queue.splice(0, this.queue.length))
        {
            p.Reject(error);
        }
        this.CommitApplied.dispose();
        await this.pump;
    }

    /** Opens the id allocator; a failed open is not cached, so the next group retries it. */
    protected OpenAllocator(): Promise<IdAllocator>
    {
        return IdAllocator.Open(this.store);
    }

    /**
     * Runs groups until the queue is empty. Submits made in the same tick share the first group. A group
     * that fails unexpectedly rejects its still-pending batches; the queue keeps running.
     */
    private async Pump(): Promise<void>
    {
        try
        {
            await Promise.resolve();
            while (this.queue.length > 0)
            {
                const group = this.queue.splice(0, Committer.GroupLength(this.queue));
                try
                {
                    const head = group[0];
                    if (head instanceof PendingCommit)
                    {
                        await this.RunGroup(group as PendingCommit[]);
                    }
                    else
                    {
                        await (head as IExclusiveCommit).Run();
                    }
                }
                catch (error)
                {
                    group.forEach(p => p.Reject(error));
                }
            }
        }
        finally
        {
            this.pump = undefined;
        }
    }

    /** Queues work that runs alone in its own group. */
    private Enqueue<T>(work: () => Promise<T>): Promise<T>
    {
        return new Promise<T>((resolve, reject) =>
        {
            this.queue.push(new ExclusiveCommit(work, resolve, reject));
            this.pump ??= this.Pump();
        });
    }

    /** Exclusive work forms a group alone; otherwise the leading run of batches up to the next exclusive work. */
    private static GroupLength(queue: ReadonlyArray<PendingCommit | IExclusiveCommit>): number
    {
        if (!(queue[0] instanceof PendingCommit))
        {
            return 1;
        }
        const exclusive = queue.findIndex(p => !(p instanceof PendingCommit));
        return exclusive < 0 ? queue.length : exclusive;
    }

    /** Seals the change against the current catalog, then saves and logs it in one Write. */
    private async RunSchema(define: (model: CatalogModel) => void): Promise<ISchemaCommit>
    {
        const model = CatalogModel.FromSnapshot(this.index.Catalog);
        define(model);
        const sealed = model.Seal();
        const commit = this.history.Last + 1n;
        await this.store.Write(async txn =>
        {
            await this.RequireCurrent(txn);
            await CatalogStore.Save(txn, sealed);
            this.log.Append(txn, commit, LogEntry.EncodeSchema(sealed));
            this.log.WriteLastCommit(txn, commit);
        });
        this.history.Record(commit, new WriteKeySet());
        this.history.Prune();
        this.index = new CatalogIndex(sealed);
        this.RaiseApplied({ Commit: commit, Kind: CommitKind.SchemaChange, CatalogVersion: sealed.Version, Batch: Committer.EmptyBatch, CreatedIds: Object.freeze([]), Catalog: sealed });
        return { Commit: commit, Catalog: sealed };
    }

    /** Plans against the current catalog; purges, saves and logs in one Write when the catalog changes. */
    private async RunUpgrade(description: ISchemaDescription): Promise<IUpgradeCommit>
    {
        const old = this.index;
        const plan = CatalogPlanner.Plan(old.Catalog, description);
        if (!plan.Changed)
        {
            // The committer is the only writer and this work runs alone: a read decides, so an unchanged
            // upgrade (every load of an unchanged schema) costs no write transaction.
            if ((await this.StoredSchemaVersion()) !== description.Version)
            {
                await this.store.Write(async txn =>
                {
                    await this.RequireCurrent(txn);
                    FormatMeta.WriteSchemaVersion(txn, description.Version);
                });
            }
            return { Commit: this.history.Last, Catalog: old.Catalog, Changed: false };
        }
        const next = new CatalogIndex(plan.Catalog);
        const commit = this.history.Last + 1n;
        const keys = new WriteKeySet();
        await this.store.Write(async txn =>
        {
            await this.RequireCurrent(txn);
            await this.purger.Purge(txn, old, next, plan.Diff, keys);
            await this.Compact(txn, next);
            this.Flush(txn);
            await CatalogStore.Save(txn, plan.Catalog);
            FormatMeta.WriteSchemaVersion(txn, description.Version);
            this.log.Append(txn, commit, LogEntry.EncodeUpgrade(plan.Catalog, description.Version));
            this.log.WriteLastCommit(txn, commit);
        });
        this.history.Record(commit, keys);
        this.history.Prune();
        this.index = next;
        this.RaiseApplied({
            Commit: commit,
            Kind: CommitKind.Upgrade,
            CatalogVersion: plan.Catalog.Version,
            Batch: Committer.EmptyBatch,
            CreatedIds: Object.freeze([]),
            Catalog: plan.Catalog,
            SchemaVersion: description.Version,
        });
        return { Commit: commit, Catalog: plan.Catalog, Changed: true };
    }

    private async StoredSchemaVersion(): Promise<string | undefined>
    {
        const txn = await this.store.BeginRead();
        try
        {
            return await FormatMeta.ReadSchemaVersion(txn);
        }
        finally
        {
            txn.dispose();
        }
    }

    /** Persists the column store's dirty deltas and the row index's dirty blocks, each once (rulings R20, F6). */
    private Flush(txn: IWriteTransaction): void
    {
        this.columns.Flush(txn);
        this.columns.AssertFlushed(txn);
        this.rows.Flush(txn);
        this.rows.AssertFlushed(txn);
    }

    private async RequireCurrent(txn: IWriteTransaction): Promise<void>
    {
        const stored = await CommitLog.ReadLastCommit(txn);
        if (stored !== this.history.Last)
        {
            throw new GraphError(GraphErrorCode.Internal, Committer.ErrStale + stored + Committer.ErrExpected + this.history.Last);
        }
    }

    private RaiseApplied(applied: ICommitApplied): void
    {
        try
        {
            this.CommitApplied.Raise(Object.freeze(applied));
        }
        catch
        {
            // Subscriber failures cannot undo a durable commit; Signal already ran every handler.
        }
    }

    private async RunGroup(group: PendingCommit[]): Promise<void>
    {
        const index = this.index;
        let candidates: PendingCommit[] = [];
        for (const p of group)
        {
            const conflict = this.history.Check(p.Reads, p.Snapshot);
            if (conflict === undefined)
            {
                candidates.push(p);
            }
            else
            {
                p.Reject(conflict);
            }
        }
        try
        {
            await this.AllocateIds(candidates);
        }
        catch (error)
        {
            candidates.forEach(p => p.Reject(error));
            return;
        }
        while (candidates.length > 0)
        {
            let outcome: IGroupOutcome;
            try
            {
                outcome = await this.store.Write(txn => this.ApplyGroup(txn, index, candidates));
            }
            catch (error)
            {
                if (error instanceof BatchFailure)
                {
                    error.Pending.Reject(error.Failure);
                    candidates = candidates.filter(p => p !== error.Pending);
                    continue;
                }
                candidates.forEach(p => p.Reject(error));
                return;
            }
            this.Publish(outcome);
            return;
        }
    }

    /** Ids for every CreateNode, outside any store.Write (the allocator takes its own Write). */
    private async AllocateIds(candidates: readonly PendingCommit[]): Promise<void>
    {
        for (const p of candidates)
        {
            if (p.Ids !== undefined)
            {
                continue;
            }
            const hints = BatchApplier.CreateHints(p.Batch);
            if (hints.length === 0)
            {
                p.Ids = [];
                continue;
            }
            const allocator = await this.Allocator();
            const ids: bigint[] = [];
            for (const hint of hints)
            {
                ids.push(await allocator.Next(hint));
            }
            p.Ids = ids;
        }
    }

    private Allocator(): Promise<IdAllocator>
    {
        if (this.allocator === undefined)
        {
            const opening = this.OpenAllocator();
            this.allocator = opening;
            opening.catch(() =>
            {
                if (this.allocator === opening)
                {
                    this.allocator = undefined;
                }
            });
        }
        return this.allocator;
    }

    private async ApplyGroup(txn: IWriteTransaction, index: CatalogIndex, candidates: readonly PendingCommit[]): Promise<IGroupOutcome>
    {
        await this.RequireCurrent(txn);
        const applier = new BatchApplier(index, this.columns, this.edges, this.rows, this.ids);
        const groupKeys = new WriteKeySet();
        const accepted: IAccepted[] = [];
        const conflicts: Array<readonly [PendingCommit, Error]> = [];
        const version = index.Catalog.Version;
        for (const p of candidates)
        {
            if (p.CatalogVersion !== undefined && p.CatalogVersion !== version)
            {
                conflicts.push([p, new ConflictError(Committer.ErrSchema + p.CatalogVersion + Committer.ErrSchemaNow + version)]);
                continue;
            }
            if (groupKeys.Intersects(p.Reads))
            {
                conflicts.push([p, new ConflictError(Committer.ErrInGroup)]);
                continue;
            }
            let keys: WriteKeySet;
            try
            {
                keys = await applier.Apply(txn, p.Batch, p.Ids ?? []);
            }
            catch (error)
            {
                if (error instanceof CommitError)
                {
                    throw new BatchFailure(p, error);
                }
                throw error;
            }
            groupKeys.AddAll(keys);
            accepted.push({ Pending: p, Keys: keys });
        }
        await this.Compact(txn, index);
        this.Flush(txn);
        let commit = this.history.Last;
        for (const a of accepted)
        {
            commit += 1n;
            this.log.Append(txn, commit, LogEntry.EncodeBatch(version, a.Pending.Ids ?? [], a.Pending.Bytes));
        }
        if (accepted.length > 0)
        {
            this.log.WriteLastCommit(txn, commit);
        }
        return { Accepted: accepted, Conflicts: conflicts, CatalogVersion: version };
    }

    /** Folds every touched chunk delta over CompactThreshold entries into its chunk (ruling R28). */
    private async Compact(txn: IWriteTransaction, index: CatalogIndex): Promise<void>
    {
        for (const d of this.columns.TouchedDeltas(txn))
        {
            if (d.Entries <= Committer.CompactThreshold)
            {
                continue;
            }
            const member = index.PropertyById(d.MemberId);
            if (member === undefined)
            {
                throw new GraphError(GraphErrorCode.Corrupt, Committer.ErrCompactMember + d.MemberId);
            }
            await this.compactor.CompactChunk(txn, d.Partition, d.TypeId, member, d.Chunk);
        }
    }

    /** After the group's Write resolved: record history, raise CommitApplied in order, settle promises. */
    private Publish(outcome: IGroupOutcome): void
    {
        let commit = this.history.Last;
        const commits: bigint[] = [];
        for (const a of outcome.Accepted)
        {
            commit += 1n;
            this.history.Record(commit, a.Keys);
            commits.push(commit);
        }
        this.history.Prune();
        for (const [p, conflict] of outcome.Conflicts)
        {
            p.Reject(conflict);
        }
        outcome.Accepted.forEach((a, i) =>
        {
            const n = commits[i] as bigint;
            // One sealed, frozen batch: no subscriber can change what the others (or the submitter's copy) see.
            this.RaiseApplied({ Commit: n, Kind: CommitKind.Batch, CatalogVersion: outcome.CatalogVersion, Batch: a.Pending.Batch, CreatedIds: Object.freeze([...(a.Pending.Ids ?? [])]) });
            a.Pending.Resolve(n);
        });
    }
}
