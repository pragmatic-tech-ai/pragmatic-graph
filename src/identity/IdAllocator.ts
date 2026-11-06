import type { IKeyValueStore } from '../kv/KeyValue.js';
import { Keyspace } from '../kv/Keyspace.js';
import { FormatKeys } from '../format/FormatKeys.js';
import { TupleCodec } from '../format/TupleCodec.js';

interface IOpenBlock
{
    readonly Block: bigint;
    Used: number;
}

/**
 * Allocates internal ids from 4,096-id blocks. Each block reservation is its own short
 * store.Write that bumps Meta("nextBlock"), so a block is durable before any id from it is
 * handed out: a rolled-back caller transaction can waste ids but never duplicate them.
 *
 * Next must NOT be called from inside a Write on the same store: the single-writer mutex
 * would deadlock. Allocate ids before entering the group Write.
 *
 * Id 0 is never allocated (it means "no id"). Ids sharing a clusterHint come from the same
 * block while it has room; unhinted ids share a default block. Open hinted blocks are bounded
 * by MaxOpenHints (least recently used hint is forgotten; its next id opens a fresh block).
 */
export interface IIdAllocatorOptions
{
    readonly MaxOpenHints?: number;
}

export class IdAllocator
{
    public static readonly BlockSize = 4096;
    public static readonly MaxOpenHints = 1024;
    private static readonly BlockSizeBig = BigInt(IdAllocator.BlockSize);
    private static readonly ErrMaxHints = 'MaxOpenHints must be a positive safe integer: ';
    private static readonly NextBlockName = 'nextBlock';

    private readonly hints = new Map<string, IOpenBlock>();
    private defaultBlock: IOpenBlock | undefined;
    private chain: Promise<unknown> = Promise.resolve();

    private constructor(
        private readonly store: IKeyValueStore,
        private readonly maxOpenHints: number,
    )
    {
    }

    public static async Open(store: IKeyValueStore, options?: IIdAllocatorOptions): Promise<IdAllocator>
    {
        const max = options?.MaxOpenHints ?? IdAllocator.MaxOpenHints;
        if (!Number.isSafeInteger(max) || max < 1)
        {
            throw new RangeError(IdAllocator.ErrMaxHints + max);
        }
        return new IdAllocator(store, max);
    }

    /** Number of hinted blocks currently held open. */
    public get OpenHintCount(): number
    {
        return this.hints.size;
    }

    public Next(clusterHint?: string): Promise<bigint>
    {
        const run = this.chain.then(() => this.NextSerial(clusterHint));
        this.chain = run.catch(() => undefined);
        return run;
    }

    private async NextSerial(clusterHint: string | undefined): Promise<bigint>
    {
        let open = this.Lookup(clusterHint);
        if (open === undefined || open.Used >= IdAllocator.BlockSize)
        {
            open = await this.OpenBlock();
            this.Remember(clusterHint, open);
        }
        const id = open.Block * IdAllocator.BlockSizeBig + BigInt(open.Used);
        open.Used++;
        return id;
    }

    private Lookup(clusterHint: string | undefined): IOpenBlock | undefined
    {
        if (clusterHint === undefined)
        {
            return this.defaultBlock;
        }
        const found = this.hints.get(clusterHint);
        if (found !== undefined)
        {
            this.hints.delete(clusterHint);
            this.hints.set(clusterHint, found);
        }
        return found;
    }

    private Remember(clusterHint: string | undefined, open: IOpenBlock): void
    {
        if (clusterHint === undefined)
        {
            this.defaultBlock = open;
            return;
        }
        this.hints.delete(clusterHint);
        this.hints.set(clusterHint, open);
        while (this.hints.size > this.maxOpenHints)
        {
            const oldest = this.hints.keys().next().value as string;
            this.hints.delete(oldest);
        }
    }

    private async OpenBlock(): Promise<IOpenBlock>
    {
        const key = FormatKeys.Meta(IdAllocator.NextBlockName);
        const block = await this.store.Write(async txn =>
        {
            const raw = await txn.Get(Keyspace.Meta, key);
            const next = raw === undefined ? 0n : (TupleCodec.Decode(raw)[0] as bigint);
            txn.Put(Keyspace.Meta, key, TupleCodec.Encode([next + 1n]));
            return next;
        });
        // Id 0 is reserved, so block 0 starts at offset 1.
        return { Block: block, Used: block === 0n ? 1 : 0 };
    }
}
