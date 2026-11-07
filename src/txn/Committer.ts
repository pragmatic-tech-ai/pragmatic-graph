import { CatalogModel } from '../catalog/CatalogModel.js';
import { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import { CatalogStore } from '../catalog/CatalogStore.js';
import { ColumnStore } from '../columns/ColumnStore.js';
import { Compactor } from '../columns/Compactor.js';
import type { ConnectorSetup } from '../connectors/WriteCoordinator.js';
import { EdgeStore } from '../edges/EdgeStore.js';
import { IdAllocator } from '../identity/IdAllocator.js';
import { PublicIdIndex } from '../identity/PublicIdIndex.js';
import { RowIndex } from '../identity/RowIndex.js';
import { IndexStore } from '../indexes/IndexStore.js';
import type { IKeyValueStore, IWriteTransaction } from '../kv/KeyValue.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import { FormatMeta } from '../format/FormatMeta.js';
import { CatalogPlanner, type ICatalogPlan } from '../schema/CatalogPlanner.js';
import { DataPurger } from '../schema/DataPurger.js';
import type { ISchemaDescription, ISeedNode } from '../schema/SchemaDescription.js';
import { SeedMarkers } from '../schema/SeedMarkers.js';
import { type ISeedCatalogChange, SeedSynchronizer, TransactionSeedView } from '../schema/SeedSynchronizer.js';
import { BatchApplier } from './BatchApplier.js';
import { CatalogIndex } from './CatalogIndex.js';
import { CommitError } from './CommitError.js';
import { CommitLog } from './CommitLog.js';
import { ConflictError } from './ConflictError.js';
import { ConflictHistory, type ISnapshotHandle } from './ConflictHistory.js';
import { ConflictKeys } from './ConflictKeys.js';
import { CommitKind, type ICommitApplied, LogEntry } from './LogEntry.js';
import { PreparedCommit } from './PreparedCommit.js';
import { ReadSet } from './ReadSet.js';
import { Reservation, ReservationState, Reservations } from './Reservations.js';
import { Signal } from './Signal.js';
import { WriteBatch, WriteOp } from './WriteBatch.js';
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
    /** The Upgrade entry's commit number; when the catalog is unchanged, LastCommit() at the upgrade's turn (before any seed commit). */
    readonly Commit: bigint;
    /** The catalog in force after the upgrade (the unchanged one when Changed is false). */
    readonly Catalog: CatalogSnapshot;
    /** True iff a new catalog was saved and logged (ICatalogPlan.Changed). */
    readonly Changed: boolean;
    /** The seed's Batch entry commit number, when the seed changed anything (ruling R53). */
    readonly SeedCommit?: bigint;
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
     * against the group's catalog (ruling F4). Undefined: no check. `Finalizes`: the reservation of the
     * prepared commit this batch finalizes (ruling R71), owned by `owner`; settling the batch ends it.
     * `BindingGeneration`: the connector-setup generation the submitter routed with; checked inside the
     * group against the committer's like the catalog version (ruling R77). Undefined: no check.
     */
    public constructor(
        public readonly Bytes: Uint8Array,
        public readonly Batch: WriteBatch,
        public readonly Reads: ReadSet,
        public readonly Snapshot: bigint,
        private readonly resolve: (commit: bigint) => void,
        private readonly reject: (error: unknown) => void,
        public readonly CatalogVersion?: number,
        public readonly Finalizes?: Reservation,
        private readonly owner?: Reservations,
        public readonly BindingGeneration?: number,
    )
    {
    }

    public Resolve(commit: bigint): void
    {
        if (this.Settle())
        {
            this.EndReservation(ReservationState.Finalized);
            this.resolve(commit);
        }
    }

    public Reject(error: unknown): void
    {
        if (this.Settle())
        {
            this.EndReservation(ReservationState.Failed);
            this.reject(error);
        }
    }

    private EndReservation(state: ReservationState): void
    {
        if (this.Finalizes !== undefined && this.owner !== undefined)
        {
            this.owner.End(this.Finalizes, state);
        }
    }

    /** True the first time only. */
    protected Settle(): boolean
    {
        if (this.settled)
        {
            return false;
        }
        this.settled = true;
        return true;
    }
}

/** A Prepare waiting for its group: validated and dry-run after the group's commits, never applied. */
class PendingPrepare extends PendingCommit
{
    public constructor(
        bytes: Uint8Array,
        batch: WriteBatch,
        reads: ReadSet,
        snapshot: bigint,
        private readonly prepared: (prepared: PreparedCommit) => void,
        reject: (error: unknown) => void,
        catalogVersion: number | undefined,
        public readonly TimeoutMs: number,
        bindingGeneration: number | undefined,
    )
    {
        super(bytes, batch, reads, snapshot, PendingPrepare.Unused, reject, catalogVersion, undefined, undefined, bindingGeneration);
    }

    public ResolvePrepared(prepared: PreparedCommit): void
    {
        if (this.Settle())
        {
            this.prepared(prepared);
        }
    }

    /** A prepare resolves with a PreparedCommit (ResolvePrepared), never with a commit number. */
    private static Unused(): void
    {
    }
}

/**
 * The internal sentinel that ends a prepare's dry-run: thrown from inside its store.Write so the Write is
 * aborted and leaves no trace, carrying what the dry-run learned (ruling R71).
 */
class DryRunOutcome extends Error
{
    private static readonly Text = 'Prepare dry-run (aborted on purpose)';

    public constructor(public readonly Keys: WriteKeySet, public readonly Dependencies: ReadSet)
    {
        super(DryRunOutcome.Text);
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

/**
 * The seed needed an internal id the pre-pass did not allocate (the purge removed a node the pre-pass
 * saw); aborts the upgrade's store.Write so the upgrade can re-run with those ids (ruling R16).
 */
class SeedIdMiss extends Error
{
    private static readonly Text = 'Seed needs ids the pre-pass did not allocate';

    public constructor(public readonly PublicIds: readonly string[])
    {
        super(SeedIdMiss.Text);
    }
}

/** The seed's Batch commit as applied inside an upgrade's write. */
interface ISeedCommit
{
    readonly Bytes: Uint8Array;
    readonly Ids: readonly bigint[];
    readonly Keys: WriteKeySet;
}

/**
 * A batch rejected while its group was applying, after it had written into the group's store.Write: it
 * failed semantically (CommitError) or its applied write keys hit a prepared commit's reservation
 * (ConflictError, ruling R71). Aborts the Write; the rest of the group re-runs.
 */
class BatchFailure extends Error
{
    public constructor(public readonly Pending: PendingCommit, public readonly Failure: CommitError | ConflictError)
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
 * Prepare / Finalize (ruling R71) split a commit so external connectors can commit in between:
 * Prepare validates and dry-runs a batch and reserves its keys; while reserved, a group batch whose
 * applied write keys hit the reservation is rejected through the BatchFailure re-run (ConflictError),
 * and one that writes after reading the prepared write keys is rejected before applying. Finalize
 * applies the prepared batch with its prepared ids and cannot fail on a conflict while the reservation
 * holds and the catalog is unchanged.
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
    /** How long a prepared commit holds its reservation when Prepare is given no timeout. */
    public static readonly DefaultPrepareTimeoutMs = 30000;

    private static readonly ErrSnapshot = 'Snapshot commit is after the last commit: ';
    private static readonly ErrStale = 'Stored last commit does not match the committer (another writer, or not opened with Committer.Open): stored ';
    private static readonly ErrExpected = ', expected ';
    private static readonly ErrDisposed = 'Committer has been disposed';
    private static readonly ErrInGroup = 'Read set conflicts with an earlier batch of the same commit group';
    private static readonly ErrCompactMember = 'Delta for a member the catalog does not know: ';
    private static readonly ErrSchema = 'The schema changed after the transaction began: catalog version ';
    private static readonly ErrSchemaNow = ', now ';
    private static readonly ErrBindings = 'The connector bindings changed after the commit was routed: generation ';
    private static readonly ErrSchemaVersion = 'Schema version must be well-formed UTF-16 (no lone surrogates)';
    private static readonly ErrSeedIds = 'Seed still needs unallocated ids after the retry: ';
    private static readonly ErrTimeout = 'Prepare timeout must be a finite, non-negative number of milliseconds: ';
    private static readonly ErrForeign = 'The prepared commit belongs to another committer';
    private static readonly ErrDryRun = 'Prepare dry-run ended without its outcome';
    private static readonly Comma = ', ';
    private static readonly EmptyBatch = new WriteBatch().Seal();
    private static readonly Encoder = new TextEncoder();
    private static readonly Decoder = new TextDecoder();

    public readonly CommitApplied = new Signal<ICommitApplied>();

    private readonly columns = new ColumnStore();
    private readonly compactor = new Compactor(this.columns);
    private readonly edges = new EdgeStore();
    private readonly rows = new RowIndex();
    private readonly ids = new PublicIdIndex();
    private readonly indexes = new IndexStore(this.columns, this.ids);
    private readonly log = new CommitLog();
    private readonly history: ConflictHistory;
    private readonly purger = new DataPurger(this.columns, this.edges, this.rows, this.ids, this.indexes);
    private readonly queue: Array<PendingCommit | IExclusiveCommit> = [];
    private readonly reservations = new Reservations();
    private index: CatalogIndex;
    private allocator: Promise<IdAllocator> | undefined;
    /** The running Pump (undefined when idle); dispose() awaits it. */
    private pump: Promise<void> | undefined;
    private disposed = false;
    /** The installed bindings and connectors (ruling R72); undefined: every write is engine-only. */
    private connectors: ConnectorSetup | undefined;
    /** Bumped by every InstallConnectors; 0 while none was ever installed (ruling R77). */
    private generation = 0;

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

    /**
     * The conflict for `readSet`, taken at `snapshotCommit`, against the commits recorded since, or
     * undefined; commits nothing. Lets a transaction tell a decision made on stale reads (its write gate's
     * denial) from one that would stand at commit time (ruling R70).
     */
    public CheckReads(readSet: ReadSet, snapshotCommit: bigint): ConflictError | undefined
    {
        return this.history.Check(readSet, snapshotCommit);
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

    /** The installed bindings and connectors; undefined (every write engine-only) until InstallConnectors. */
    public get Connectors(): ConnectorSetup | undefined
    {
        return this.connectors;
    }

    /**
     * The generation of the installed connector setup (0 before any install). A transaction reads it
     * together with Connectors when it routes and hands it to Submit / Prepare (ruling R77).
     */
    public get BindingGeneration(): number
    {
        return this.generation;
    }

    /**
     * Installs connector bindings for commits routed afterwards (ruling R77): a new generation, so every
     * batch or prepare routed with the previous setup and not yet applied fails with ConflictError
     * (retry-safe), and every reservation is invalidated (a prepared commit routed with the old setup
     * fails Finalize with ConflictError, as after a schema change). SubmitUpgrade installs inside the
     * upgrade's own turn instead.
     */
    public InstallConnectors(setup: ConnectorSetup): void
    {
        this.connectors = setup;
        this.generation++;
        this.reservations.InvalidateAll();
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
     * `bindingGeneration`, when given, must still be BindingGeneration in the batch's group, else ConflictError.
     */
    public Submit(batch: WriteBatch, readSet: ReadSet, snapshotCommit: bigint, catalogVersion?: number, bindingGeneration?: number): Promise<bigint>
    {
        let bytes: Uint8Array;
        try
        {
            bytes = this.Capture(batch, snapshotCommit);
        }
        catch (error)
        {
            return Promise.reject(error);
        }
        return new Promise<bigint>((resolve, reject) =>
        {
            this.Push(new PendingCommit(bytes, WriteBatch.Deserialize(bytes).Seal(), readSet.Clone(), snapshotCommit, resolve, reject, catalogVersion, undefined, undefined, bindingGeneration));
        });
    }

    /**
     * Validates and reserves a batch without committing it (ruling R71). Queued like Submit; in its group
     * turn (after the group's commits) the read set is checked against history and the catalog version
     * against the committer's, ids are allocated (outside any Write, ruling R16), and the batch is
     * dry-run inside a store.Write that is then aborted, so semantic errors surface now and its write keys
     * are known. Rejects exactly as Submit would (ConflictError, CommitError, GraphError InvalidArgument),
     * and with ConflictError when its reads or dry-run dependencies hit keys another prepared commit writes,
     * or its write keys hit keys another reserved (also for an empty batch: its reads stay reserved). Resolves with a PreparedCommit holding a reservation for `timeoutMs` (default
     * DefaultPrepareTimeoutMs): until it finalizes, aborts or expires, a commit that writes what it read,
     * depends on or writes, or that writes after reading what it writes, fails with ConflictError.
     * Unrelated commits proceed. The batch and read set are captured now. `bindingGeneration` is checked
     * as for Submit, at the prepare's turn and again at Finalize.
     */
    public Prepare(batch: WriteBatch, readSet: ReadSet, snapshotCommit: bigint, catalogVersion?: number, timeoutMs: number = Committer.DefaultPrepareTimeoutMs, bindingGeneration?: number): Promise<PreparedCommit>
    {
        let bytes: Uint8Array;
        try
        {
            if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
            {
                throw new GraphError(GraphErrorCode.InvalidArgument, Committer.ErrTimeout + timeoutMs);
            }
            bytes = this.Capture(batch, snapshotCommit);
        }
        catch (error)
        {
            return Promise.reject(error);
        }
        return new Promise<PreparedCommit>((resolve, reject) =>
        {
            this.Push(new PendingPrepare(bytes, WriteBatch.Deserialize(bytes).Seal(), readSet.Clone(), snapshotCommit, resolve, reject, catalogVersion, timeoutMs, bindingGeneration));
        });
    }

    /**
     * @internal PreparedCommit.Finalize: queues the prepared batch as a group commit with its prepared
     * ids. It skips history validation (the reservation kept every later commit off its keys) and is not
     * checked against other reservations (each was checked against it when it prepared); the catalog
     * version is checked as for any batch. ConflictError after Abort or expiry (ruling R71).
     */
    public SubmitPrepared(prepared: PreparedCommit): Promise<bigint>
    {
        if (this.disposed)
        {
            return Promise.reject(new GraphError(GraphErrorCode.Disposed, Committer.ErrDisposed));
        }
        if (!prepared.Reservation.BelongsTo(this.reservations))
        {
            return Promise.reject(new GraphError(GraphErrorCode.InvalidArgument, Committer.ErrForeign));
        }
        const refused = this.reservations.BeginFinalize(prepared.Reservation);
        if (refused !== undefined)
        {
            return Promise.reject(refused);
        }
        return new Promise<bigint>((resolve, reject) =>
        {
            const pending = new PendingCommit(prepared.Bytes, prepared.Batch, new ReadSet(), this.history.Last, resolve, reject, prepared.CatalogVersion, prepared.Reservation, this.reservations, prepared.BindingGeneration);
            pending.Ids = [...prepared.Ids];
            this.Push(pending);
        });
    }

    /** Diagnostics: prepared commits whose reservations currently block other commits. */
    public get ReservationCount(): number
    {
        return this.reservations.Count;
    }

    /** The checks Submit and Prepare share; returns the batch's serialized bytes. */
    private Capture(batch: WriteBatch, snapshotCommit: bigint): Uint8Array
    {
        if (this.disposed)
        {
            throw new GraphError(GraphErrorCode.Disposed, Committer.ErrDisposed);
        }
        if (snapshotCommit > this.history.Last || snapshotCommit < 0n)
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, Committer.ErrSnapshot + snapshotCommit);
        }
        return batch.Serialize();
    }

    private Push(pending: PendingCommit): void
    {
        this.queue.push(pending);
        this.pump ??= this.Pump();
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
     * version differs or the catalog changed, the same Write then applies the description's seed
     * (SeedSynchronizer, ruling R53) and, iff it changed anything, logs it as a Batch entry with the next
     * commit number (SeedCommit) and raises it after the Upgrade entry. An unchanged catalog with an
     * unchanged seed only rewrites a differing Meta("schemaVersion"): no commit, no entry, no signal
     * (ruling R48). A planning error (CatalogError) or a seed error (CommitError) rejects only this
     * upgrade and changes nothing; a version that is not well-formed UTF-16 is GraphError InvalidArgument.
     * `connectors`, when given, is installed (InstallConnectors) inside the upgrade's turn once it
     * succeeded, before CommitApplied is raised, so no commit is ordered between the upgrade and the new
     * bindings (ruling R77); a failed upgrade installs nothing.
     */
    public SubmitUpgrade(description: ISchemaDescription, connectors?: ConnectorSetup): Promise<IUpgradeCommit>
    {
        if (this.disposed)
        {
            return Promise.reject(new GraphError(GraphErrorCode.Disposed, Committer.ErrDisposed));
        }
        if (Committer.Decoder.decode(Committer.Encoder.encode(description.Version)) !== description.Version)
        {
            return Promise.reject(new GraphError(GraphErrorCode.InvalidArgument, Committer.ErrSchemaVersion));
        }
        return this.Enqueue(() => this.RunUpgrade(description, connectors));
    }

    /**
     * Stops accepting work: every queued Submit, Prepare or Finalize not yet in a group and every later
     * one rejects; every held reservation is released; CommitApplied subscribers are dropped. A group already writing finishes (its commits are durable
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
        this.reservations.Clear();
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
        // Every prepared commit's Finalize can now only fail on the catalog version: release them now.
        this.reservations.InvalidateAll();
        this.RaiseApplied({ Commit: commit, Kind: CommitKind.SchemaChange, CatalogVersion: sealed.Version, Batch: Committer.EmptyBatch, CreatedIds: Object.freeze([]), Catalog: sealed });
        return { Commit: commit, Catalog: sealed };
    }

    /**
     * Plans against the current catalog. Nothing to do when the catalog and the stored version are both
     * unchanged (a read decides: no write transaction). Otherwise one Write purges and saves a changed
     * catalog (Upgrade entry), applies the seed (Batch entry, when it changes anything) and writes the
     * version. Seed ids come from a pre-pass outside the Write (ruling R16); when the purge removed a node
     * the pre-pass saw, the upgrade re-runs once with those ids too, and a second miss is Internal.
     */
    private async RunUpgrade(description: ISchemaDescription, connectors: ConnectorSetup | undefined): Promise<IUpgradeCommit>
    {
        const old = this.index;
        const plan = CatalogPlanner.Plan(old.Catalog, description);
        if (!plan.Changed && (await this.StoredSchemaVersion()) === description.Version)
        {
            if (connectors !== undefined)
            {
                this.InstallConnectors(connectors);
            }
            return { Commit: this.history.Last, Catalog: old.Catalog, Changed: false };
        }
        let missed: readonly string[] = [];
        for (let attempt = 0; ; attempt++)
        {
            const ids = await this.PreallocateSeed(old, description.Seed, missed);
            try
            {
                return await this.WriteUpgrade(description, plan, ids, connectors);
            }
            catch (error)
            {
                if (!(error instanceof SeedIdMiss))
                {
                    throw error;
                }
                if (attempt > 0)
                {
                    throw new GraphError(GraphErrorCode.Internal, Committer.ErrSeedIds + error.PublicIds.join(Committer.Comma), error);
                }
                missed = error.PublicIds;
            }
        }
    }

    /**
     * The read-only pre-pass over a store snapshot: one internal id per seed node that is absent or not
     * seeded with the same hash, plus one per id the previous attempt missed.
     */
    private async PreallocateSeed(index: CatalogIndex, seed: readonly ISeedNode[], missed: readonly string[]): Promise<Map<string, bigint>>
    {
        let needed: string[];
        const txn = await this.store.BeginRead();
        try
        {
            const view = new TransactionSeedView(txn, index, this.rows, this.ids, this.edges);
            needed = await SeedSynchronizer.IdsNeeded(view, seed, await SeedMarkers.ReadAll(txn));
        }
        finally
        {
            txn.dispose();
        }
        const out = new Map<string, bigint>();
        for (const publicId of [...needed, ...missed])
        {
            if (!out.has(publicId))
            {
                const allocator = await this.Allocator();
                out.set(publicId, await allocator.Next());
            }
        }
        return out;
    }

    /** One upgrade attempt: a single store.Write, then history, catalog and signals. */
    private async WriteUpgrade(description: ISchemaDescription, plan: ICatalogPlan, ids: ReadonlyMap<string, bigint>, connectors: ConnectorSetup | undefined): Promise<IUpgradeCommit>
    {
        const old = this.index;
        const next = plan.Changed ? new CatalogIndex(plan.Catalog) : old;
        const last = this.history.Last;
        const upgradeCommit = plan.Changed ? last + 1n : undefined;
        const seedCommit = (upgradeCommit ?? last) + 1n;
        const keys = new WriteKeySet();
        const seed = await this.store.Write(async txn =>
        {
            await this.RequireCurrent(txn);
            let change: ISeedCatalogChange | undefined;
            if (plan.Changed)
            {
                const stats = await this.purger.Purge(txn, old, next, plan.Diff, keys);
                change = { Modified: new Set(stats.ModifiedNodes) };
            }
            const applied = await this.ApplySeed(txn, next, description.Seed, ids, change);
            await this.Compact(txn, next);
            this.Flush(txn);
            if (upgradeCommit !== undefined)
            {
                await CatalogStore.Save(txn, plan.Catalog);
            }
            FormatMeta.WriteSchemaVersion(txn, description.Version);
            if (upgradeCommit !== undefined)
            {
                this.log.Append(txn, upgradeCommit, LogEntry.EncodeUpgrade(plan.Catalog, description.Version));
            }
            if (applied !== undefined)
            {
                this.log.Append(txn, seedCommit, LogEntry.EncodeBatch(next.Catalog.Version, applied.Ids, applied.Bytes));
                this.log.WriteLastCommit(txn, seedCommit);
            }
            else if (upgradeCommit !== undefined)
            {
                this.log.WriteLastCommit(txn, upgradeCommit);
            }
            return applied;
        });
        if (upgradeCommit !== undefined)
        {
            this.history.Record(upgradeCommit, keys);
            this.reservations.InvalidateAll();
        }
        if (seed !== undefined)
        {
            this.history.Record(seedCommit, seed.Keys);
            this.reservations.Invalidate(seed.Keys);
        }
        this.history.Prune();
        this.index = next;
        if (connectors !== undefined)
        {
            this.InstallConnectors(connectors);
        }
        if (upgradeCommit !== undefined)
        {
            this.RaiseApplied({
                Commit: upgradeCommit,
                Kind: CommitKind.Upgrade,
                CatalogVersion: plan.Catalog.Version,
                Batch: Committer.EmptyBatch,
                CreatedIds: Object.freeze([]),
                Catalog: plan.Catalog,
                SchemaVersion: description.Version,
            });
        }
        if (seed === undefined)
        {
            return { Commit: upgradeCommit ?? last, Catalog: next.Catalog, Changed: plan.Changed };
        }
        // One sealed, frozen batch: no subscriber can change what the others see.
        this.RaiseApplied({ Commit: seedCommit, Kind: CommitKind.Batch, CatalogVersion: next.Catalog.Version, Batch: WriteBatch.Deserialize(seed.Bytes).Seal(), CreatedIds: Object.freeze([...seed.Ids]) });
        return { Commit: upgradeCommit ?? last, Catalog: next.Catalog, Changed: plan.Changed, SeedCommit: seedCommit };
    }

    /**
     * Builds the seed batch against the post-purge state and applies it like a transaction's batch
     * (BatchApplier: the same validation and edge rules), then writes and removes seed markers; every
     * marker change also writes the node's Node key (IsSeeded records it). Undefined when the seed
     * changes nothing (no op, no marker change): then there is no Batch entry.
     */
    private async ApplySeed(txn: IWriteTransaction, index: CatalogIndex, seed: readonly ISeedNode[], ids: ReadonlyMap<string, bigint>, change: ISeedCatalogChange | undefined): Promise<ISeedCommit | undefined>
    {
        const view = new TransactionSeedView(txn, index, this.rows, this.ids, this.edges);
        const plan = await new SeedSynchronizer(index).Build(view, seed, await SeedMarkers.ReadAll(txn), change);
        if (plan.Batch.Count === 0 && plan.Hashes.size === 0 && plan.Removed.length === 0)
        {
            return undefined;
        }
        const batch = plan.Batch.Seal();
        const created: bigint[] = [];
        const missing: string[] = [];
        for (const op of batch.Ops())
        {
            if (op.Op !== WriteOp.CreateNode)
            {
                continue;
            }
            const id = ids.get(op.PublicId);
            if (id === undefined)
            {
                missing.push(op.PublicId);
            }
            else
            {
                created.push(id);
            }
        }
        if (missing.length > 0)
        {
            throw new SeedIdMiss(missing);
        }
        const keys = await new BatchApplier(index, this.columns, this.edges, this.rows, this.ids, this.indexes).Apply(txn, batch, created);
        for (const [publicId, hash] of plan.Hashes)
        {
            SeedMarkers.Write(txn, publicId, hash);
            keys.Add(ConflictKeys.NodeSpace, ConflictKeys.Node(publicId));
        }
        for (const publicId of plan.Removed)
        {
            SeedMarkers.Delete(txn, publicId);
            keys.Add(ConflictKeys.NodeSpace, ConflictKeys.Node(publicId));
        }
        return { Bytes: batch.Serialize(), Ids: created, Keys: keys };
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

    /** Releases expired reservations, commits the group's batches, then runs its Prepares in order. */
    private async RunGroup(group: PendingCommit[]): Promise<void>
    {
        this.reservations.Sweep();
        const commits = group.filter(p => !(p instanceof PendingPrepare));
        if (commits.length > 0)
        {
            await this.RunCommits(commits);
        }
        for (const p of group)
        {
            if (p instanceof PendingPrepare)
            {
                await this.RunPrepare(p);
            }
        }
    }

    /**
     * One prepare, after every commit of its group published: the history, catalog-version and
     * reservation read checks, ids, the dry-run, the reservation write check, then the reservation.
     */
    private async RunPrepare(p: PendingPrepare): Promise<void>
    {
        const index = this.index;
        const version = index.Catalog.Version;
        const early = this.history.Check(p.Reads, p.Snapshot)
            ?? Committer.VersionConflict(p.CatalogVersion, version)
            ?? this.GenerationConflict(p.BindingGeneration)
            // A prepare's reads stay reserved even when it writes nothing, so it is always checked.
            ?? this.reservations.ReadConflict(p.Reads);
        if (early !== undefined)
        {
            p.Reject(early);
            return;
        }
        let outcome: DryRunOutcome;
        try
        {
            await this.AllocateIds([p]);
            outcome = await this.DryRun(index, p);
        }
        catch (error)
        {
            p.Reject(error);
            return;
        }
        if (this.disposed)
        {
            p.Reject(new GraphError(GraphErrorCode.Disposed, Committer.ErrDisposed));
            return;
        }
        // Its dependencies too: another prepared commit's Finalize may change what its own dry-run relied on.
        const reserved = Reservations.ReservedReads(p.Reads, outcome.Dependencies, outcome.Keys);
        const clash = this.reservations.ReadConflict(reserved) ?? this.reservations.WriteConflict(outcome.Keys);
        if (clash !== undefined)
        {
            p.Reject(clash);
            return;
        }
        const reservation = this.reservations.Reserve(reserved, outcome.Keys, p.TimeoutMs);
        p.ResolvePrepared(new PreparedCommit(this, p.Batch, p.Bytes, p.Ids ?? [], version, reservation, p.BindingGeneration));
    }

    /**
     * Applies the batch inside a store.Write and aborts that Write with the DryRunOutcome sentinel, so
     * nothing is stored and the per-transaction caches (keyed by the aborted transaction) are dropped.
     */
    private async DryRun(index: CatalogIndex, p: PendingCommit): Promise<DryRunOutcome>
    {
        try
        {
            await this.store.Write(async txn =>
            {
                await this.RequireCurrent(txn);
                const dependencies = new ReadSet();
                const applier = new BatchApplier(index, this.columns, this.edges, this.rows, this.ids, this.indexes, dependencies);
                const keys = await applier.Apply(txn, p.Batch, p.Ids ?? []);
                throw new DryRunOutcome(keys, dependencies);
            });
        }
        catch (error)
        {
            if (error instanceof DryRunOutcome)
            {
                return error;
            }
            throw error;
        }
        throw new GraphError(GraphErrorCode.Internal, Committer.ErrDryRun);
    }

    /** The ConflictError for a batch begun on catalog `began` when the catalog is now `now`; undefined when unchecked or equal. */
    private static VersionConflict(began: number | undefined, now: number): ConflictError | undefined
    {
        return began === undefined || began === now ? undefined : new ConflictError(Committer.ErrSchema + began + Committer.ErrSchemaNow + now);
    }

    /** The ConflictError for work routed with connector-setup generation `routed` when that is no longer current; undefined when unchecked or equal. */
    private GenerationConflict(routed: number | undefined): ConflictError | undefined
    {
        return routed === undefined || routed === this.generation ? undefined : new ConflictError(Committer.ErrBindings + routed + Committer.ErrSchemaNow + this.generation);
    }

    private async RunCommits(group: PendingCommit[]): Promise<void>
    {
        const index = this.index;
        let candidates: PendingCommit[] = [];
        for (const p of group)
        {
            // A finalize skips history: its reservation kept every later commit off its keys (ruling R71).
            let conflict: ConflictError | undefined;
            if (p.Finalizes === undefined)
            {
                conflict = this.history.Check(p.Reads, p.Snapshot);
            }
            else if (p.Finalizes.Invalidated)
            {
                conflict = Reservation.InvalidatedError();
            }
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
        const applier = new BatchApplier(index, this.columns, this.edges, this.rows, this.ids, this.indexes);
        const groupKeys = new WriteKeySet();
        const accepted: IAccepted[] = [];
        const conflicts: Array<readonly [PendingCommit, Error]> = [];
        const version = index.Catalog.Version;
        // Reservations finalized earlier in this group no longer block the batches after them.
        const finalized = new Set<Reservation>();
        for (const p of candidates)
        {
            const stale = Committer.VersionConflict(p.CatalogVersion, version) ?? this.GenerationConflict(p.BindingGeneration);
            if (stale !== undefined)
            {
                conflicts.push([p, stale]);
                continue;
            }
            if (groupKeys.Intersects(p.Reads))
            {
                conflicts.push([p, new ConflictError(Committer.ErrInGroup)]);
                continue;
            }
            const reserved = p.Finalizes === undefined && p.Batch.Count > 0 ? this.reservations.ReadConflict(p.Reads, finalized) : undefined;
            if (reserved !== undefined)
            {
                conflicts.push([p, reserved]);
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
            if (p.Finalizes === undefined)
            {
                const clash = this.reservations.WriteConflict(keys, finalized);
                if (clash !== undefined)
                {
                    throw new BatchFailure(p, clash);
                }
            }
            else
            {
                finalized.add(p.Finalizes);
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
