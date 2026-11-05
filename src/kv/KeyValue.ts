import { Keyspace } from './Keyspace.js';

/** Half-open key range: Start inclusive, End exclusive. */
export interface IKeyRange
{
    readonly Start: Uint8Array;
    readonly End: Uint8Array;
}

/**
 * Sees one immutable snapshot for its whole life. Returned buffers are always copies.
 * Keys must be non-empty: an empty key is rejected (Get rejects, Put/Delete throw).
 * Store disposal releases every still-open transaction; later use throws.
 */
export interface IReadTransaction
{
    Get(space: Keyspace, key: Uint8Array): Promise<Uint8Array | undefined>;
    Scan(space: Keyspace, range: IKeyRange, limit?: number): AsyncIterable<[Uint8Array, Uint8Array]>;
    dispose(): void;
}

/** Reads see this transaction's own pending writes merged over its snapshot. Empty keys are rejected. */
export interface IWriteTransaction extends IReadTransaction
{
    Put(space: Keyspace, key: Uint8Array, value: Uint8Array): void;
    Delete(space: Keyspace, key: Uint8Array): void;
}

export interface IKeyValueStore
{
    BeginRead(): Promise<IReadTransaction>;
    /** Runs exclusively; commits atomically when work resolves, rolls back when it rejects. */
    Write<T>(work: (txn: IWriteTransaction) => Promise<T>): Promise<T>;
    dispose(): Promise<void>;
}
