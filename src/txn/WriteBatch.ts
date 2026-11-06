import { ValueType } from '../catalog/ValueType.js';
import { CellValue, DateTimeValue, DateValue, DurationValue } from '../columns/CellValue.js';
import { ValueCodec } from '../columns/ValueCodec.js';

export enum WriteOp
{
    CreateNode = 1,
    SetProperty = 2,
    DeleteNode = 3,
    Link = 4,
    Unlink = 5,
}

/** Placement and properties of a new edge. Siblings are public ids of existing targets of the same (from, relationship). */
export interface LinkOptions
{
    readonly AfterSibling?: string;
    readonly BeforeSibling?: string;
    readonly Properties?: ReadonlyMap<string, CellValue>;
}

export interface ICreateNodeOp
{
    readonly Op: WriteOp.CreateNode;
    readonly PublicId: string;
    readonly Concept: string;
    readonly ClusterHint?: string;
}

export interface ISetPropertyOp
{
    readonly Op: WriteOp.SetProperty;
    readonly PublicId: string;
    readonly Member: string;
    readonly Value: CellValue;
}

export interface IDeleteNodeOp
{
    readonly Op: WriteOp.DeleteNode;
    readonly PublicId: string;
}

export interface ILinkOp
{
    readonly Op: WriteOp.Link;
    readonly From: string;
    readonly Relationship: string;
    readonly To: string;
    readonly Options?: LinkOptions;
}

export interface IUnlinkOp
{
    readonly Op: WriteOp.Unlink;
    readonly From: string;
    readonly Relationship: string;
    readonly To: string;
}

export type BatchOp = ICreateNodeOp | ISetPropertyOp | IDeleteNodeOp | ILinkOp | IUnlinkOp;

/** A Map that rejects every mutation once constructed; edge properties of recorded ops are held in one. */
class FrozenMap<K, V> extends Map<K, V>
{
    private static readonly ErrFrozen = 'Recorded edge properties are read-only';

    #locked = false;

    public constructor(entries: Iterable<readonly [K, V]>)
    {
        super();
        for (const [k, v] of entries)
        {
            super.set(k, v);
        }
        this.#locked = true;
    }

    public override set(key: K, value: V): this
    {
        this.RequireUnlocked();
        return super.set(key, value);
    }

    public override delete(key: K): boolean
    {
        this.RequireUnlocked();
        return super.delete(key);
    }

    public override clear(): void
    {
        this.RequireUnlocked();
        super.clear();
    }

    private RequireUnlocked(): void
    {
        if (this.#locked)
        {
            throw new TypeError(FrozenMap.ErrFrozen);
        }
    }
}

/** Growable little-endian byte buffer for Serialize. */
class ByteWriter
{
    private bytes = new Uint8Array(64);
    private view = new DataView(this.bytes.buffer);
    private length = 0;

    public U8(value: number): void
    {
        this.Reserve(1);
        this.view.setUint8(this.length, value);
        this.length += 1;
    }

    public U32(value: number): void
    {
        this.Reserve(4);
        this.view.setUint32(this.length, value, true);
        this.length += 4;
    }

    public Raw(data: Uint8Array): void
    {
        this.Reserve(data.length);
        this.bytes.set(data, this.length);
        this.length += data.length;
    }

    public Text(text: string): void
    {
        const data = ValueCodec.EncodeText(text);
        this.U32(data.length);
        this.Raw(data);
    }

    public Finish(): Uint8Array
    {
        return this.bytes.slice(0, this.length);
    }

    private Reserve(n: number): void
    {
        if (this.length + n <= this.bytes.length)
        {
            return;
        }
        const grown = new Uint8Array(Math.max(this.bytes.length * 2, this.length + n));
        grown.set(this.bytes.subarray(0, this.length));
        this.bytes = grown;
        this.view = new DataView(grown.buffer);
    }
}

/** Bounds-checked little-endian reader for Deserialize; every failure is a RangeError. */
class ByteReader
{
    private static readonly ErrTruncated = 'Corrupt write batch: truncated';
    private static readonly ErrTrailing = 'Corrupt write batch: trailing bytes';

    public At = 0;
    public readonly View: DataView;

    public constructor(public readonly Bytes: Uint8Array)
    {
        this.View = new DataView(Bytes.buffer, Bytes.byteOffset, Bytes.byteLength);
    }

    public U8(): number
    {
        this.Need(1);
        const v = this.View.getUint8(this.At);
        this.At += 1;
        return v;
    }

    public U32(): number
    {
        this.Need(4);
        const v = this.View.getUint32(this.At, true);
        this.At += 4;
        return v;
    }

    public Text(): string
    {
        const n = this.U32();
        this.Need(n);
        const text = ValueCodec.DecodeText(this.Bytes.subarray(this.At, this.At + n));
        this.At += n;
        return text;
    }

    public RequireEnd(): void
    {
        if (this.At !== this.Bytes.length)
        {
            throw new RangeError(ByteReader.ErrTrailing);
        }
    }

    private Need(n: number): void
    {
        if (this.At + n > this.Bytes.length)
        {
            throw new RangeError(ByteReader.ErrTruncated);
        }
    }
}

/**
 * Logical write operations addressed by public id, recorded in order. The committer applies them in
 * order inside one storage transaction, so later operations see earlier ones. Values are validated and
 * caller collections copied at record time; recorded operations are immutable.
 *
 * Serialize layout (docs/format/on-disk-format.md, Log): u8 format version (1), u32 LE op count, then
 * per op a u8 WriteOp and its fields. Strings are u32 LE byte length + UTF-8. A cell value is a u8
 * ValueType tag (0 = null) followed, when non-null, by the single-value bytes of that type.
 */
export class WriteBatch
{
    public static readonly FormatVersion = 1;

    private static readonly NullTag = 0;
    private static readonly FlagOptions = 1;
    private static readonly FlagAfter = 2;
    private static readonly FlagBefore = 4;
    private static readonly FlagProperties = 8;
    private static readonly KnownFlags = 15;
    private static readonly LoneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    private static readonly ErrValueType = 'Unsupported cell value: ';
    private static readonly ErrValue = 'Invalid cell value: ';
    private static readonly ErrText = 'String contains a lone surrogate: ';
    private static readonly ErrVersion = 'Corrupt write batch: unsupported format version ';
    private static readonly ErrOp = 'Corrupt write batch: unknown op ';
    private static readonly ErrTag = 'Corrupt write batch: unknown value tag ';
    private static readonly ErrFlags = 'Corrupt write batch: unknown link option flags ';
    private static readonly ErrHasHint = 'Corrupt write batch: CreateNode hint flag must be 0 or 1, got ';
    private static readonly ErrSealed = 'Write batch is sealed: no further operations can be recorded';
    private static readonly ErrDuplicateProperty = 'Corrupt write batch: duplicate edge property ';
    private static readonly ErrValueBytes = 'Corrupt write batch: invalid value bytes';

    private readonly ops: BatchOp[] = [];
    // ES private fields: not own enumerable properties, so a sealed batch still deep-equals its unsealed copy.
    #sealed = false;
    #view: readonly BatchOp[] | undefined;

    public get Count(): number
    {
        return this.ops.length;
    }

    /** True once Seal() was called: the batch can no longer change. */
    public get IsSealed(): boolean
    {
        return this.#sealed;
    }

    /**
     * The recorded operations in order: a frozen array of frozen ops (edge property maps are read-only),
     * unaffected by operations recorded later.
     */
    public Ops(): readonly BatchOp[]
    {
        this.#view ??= Object.freeze([...this.ops]);
        return this.#view;
    }

    /** Makes the batch immutable: every later record call throws TypeError. Returns this. */
    public Seal(): this
    {
        this.#sealed = true;
        return this;
    }

    public CreateNode(publicId: string, concept: string, clusterHint?: string): void
    {
        WriteBatch.RequireText(publicId, concept);
        if (clusterHint === undefined)
        {
            this.Push({ Op: WriteOp.CreateNode, PublicId: publicId, Concept: concept });
            return;
        }
        WriteBatch.RequireText(clusterHint);
        this.Push({ Op: WriteOp.CreateNode, PublicId: publicId, Concept: concept, ClusterHint: clusterHint });
    }

    public SetProperty(publicId: string, member: string, value: CellValue): void
    {
        WriteBatch.RequireText(publicId, member);
        WriteBatch.RequireValue(value);
        this.Push({ Op: WriteOp.SetProperty, PublicId: publicId, Member: member, Value: value });
    }

    public DeleteNode(publicId: string): void
    {
        WriteBatch.RequireText(publicId);
        this.Push({ Op: WriteOp.DeleteNode, PublicId: publicId });
    }

    public Link(from: string, relationship: string, to: string, options?: LinkOptions): void
    {
        WriteBatch.RequireText(from, relationship, to);
        if (options === undefined)
        {
            this.Push({ Op: WriteOp.Link, From: from, Relationship: relationship, To: to });
            return;
        }
        this.Push({ Op: WriteOp.Link, From: from, Relationship: relationship, To: to, Options: WriteBatch.CopyOptions(options) });
    }

    public Unlink(from: string, relationship: string, to: string): void
    {
        WriteBatch.RequireText(from, relationship, to);
        this.Push({ Op: WriteOp.Unlink, From: from, Relationship: relationship, To: to });
    }

    public Serialize(): Uint8Array
    {
        const w = new ByteWriter();
        w.U8(WriteBatch.FormatVersion);
        w.U32(this.ops.length);
        for (const op of this.ops)
        {
            w.U8(op.Op);
            switch (op.Op)
            {
                case WriteOp.CreateNode:
                    w.Text(op.PublicId);
                    w.Text(op.Concept);
                    w.U8(op.ClusterHint === undefined ? 0 : 1);
                    if (op.ClusterHint !== undefined)
                    {
                        w.Text(op.ClusterHint);
                    }
                    break;
                case WriteOp.SetProperty:
                    w.Text(op.PublicId);
                    w.Text(op.Member);
                    WriteBatch.WriteValue(w, op.Value);
                    break;
                case WriteOp.DeleteNode:
                    w.Text(op.PublicId);
                    break;
                case WriteOp.Link:
                    w.Text(op.From);
                    w.Text(op.Relationship);
                    w.Text(op.To);
                    WriteBatch.WriteOptions(w, op.Options);
                    break;
                case WriteOp.Unlink:
                    w.Text(op.From);
                    w.Text(op.Relationship);
                    w.Text(op.To);
                    break;
            }
        }
        return w.Finish();
    }

    /** Parses Serialize output; any malformed input (version, op, tag, truncation, trailing bytes, UTF-8) is a RangeError. */
    public static Deserialize(bytes: Uint8Array): WriteBatch
    {
        const r = new ByteReader(bytes);
        const version = r.U8();
        if (version !== WriteBatch.FormatVersion)
        {
            throw new RangeError(WriteBatch.ErrVersion + version);
        }
        const count = r.U32();
        const batch = new WriteBatch();
        try
        {
            for (let i = 0; i < count; i++)
            {
                WriteBatch.ReadOp(r, batch);
            }
        }
        catch (error)
        {
            throw error instanceof RangeError ? error : new RangeError(WriteBatch.ErrValueBytes, { cause: error });
        }
        r.RequireEnd();
        return batch;
    }

    private static ReadOp(r: ByteReader, batch: WriteBatch): void
    {
        const op = r.U8();
        switch (op)
        {
            case WriteOp.CreateNode:
            {
                const publicId = r.Text();
                const concept = r.Text();
                const hasHint = r.U8();
                if (hasHint === 0)
                {
                    batch.CreateNode(publicId, concept);
                }
                else if (hasHint === 1)
                {
                    batch.CreateNode(publicId, concept, r.Text());
                }
                else
                {
                    throw new RangeError(WriteBatch.ErrHasHint + hasHint);
                }
                return;
            }
            case WriteOp.SetProperty:
            {
                const publicId = r.Text();
                const member = r.Text();
                batch.SetProperty(publicId, member, WriteBatch.ReadValue(r));
                return;
            }
            case WriteOp.DeleteNode:
                batch.DeleteNode(r.Text());
                return;
            case WriteOp.Link:
            {
                const from = r.Text();
                const relationship = r.Text();
                const to = r.Text();
                const options = WriteBatch.ReadOptions(r);
                if (options === undefined)
                {
                    batch.Link(from, relationship, to);
                }
                else
                {
                    batch.Link(from, relationship, to, options);
                }
                return;
            }
            case WriteOp.Unlink:
            {
                const from = r.Text();
                const relationship = r.Text();
                batch.Unlink(from, relationship, r.Text());
                return;
            }
            default:
                throw new RangeError(WriteBatch.ErrOp + op);
        }
    }

    private static WriteOptions(w: ByteWriter, options: LinkOptions | undefined): void
    {
        if (options === undefined)
        {
            w.U8(0);
            return;
        }
        let flags = WriteBatch.FlagOptions;
        flags |= options.AfterSibling === undefined ? 0 : WriteBatch.FlagAfter;
        flags |= options.BeforeSibling === undefined ? 0 : WriteBatch.FlagBefore;
        flags |= options.Properties === undefined ? 0 : WriteBatch.FlagProperties;
        w.U8(flags);
        if (options.AfterSibling !== undefined)
        {
            w.Text(options.AfterSibling);
        }
        if (options.BeforeSibling !== undefined)
        {
            w.Text(options.BeforeSibling);
        }
        if (options.Properties !== undefined)
        {
            w.U32(options.Properties.size);
            for (const [name, value] of options.Properties)
            {
                w.Text(name);
                WriteBatch.WriteValue(w, value);
            }
        }
    }

    private static ReadOptions(r: ByteReader): LinkOptions | undefined
    {
        const flags = r.U8();
        if ((flags & ~WriteBatch.KnownFlags) !== 0 || (flags !== 0 && (flags & WriteBatch.FlagOptions) === 0))
        {
            throw new RangeError(WriteBatch.ErrFlags + flags);
        }
        if (flags === 0)
        {
            return undefined;
        }
        const options: { AfterSibling?: string; BeforeSibling?: string; Properties?: ReadonlyMap<string, CellValue> } = {};
        if ((flags & WriteBatch.FlagAfter) !== 0)
        {
            options.AfterSibling = r.Text();
        }
        if ((flags & WriteBatch.FlagBefore) !== 0)
        {
            options.BeforeSibling = r.Text();
        }
        if ((flags & WriteBatch.FlagProperties) !== 0)
        {
            const n = r.U32();
            const properties = new Map<string, CellValue>();
            for (let i = 0; i < n; i++)
            {
                const name = r.Text();
                if (properties.has(name))
                {
                    throw new RangeError(WriteBatch.ErrDuplicateProperty + name);
                }
                properties.set(name, WriteBatch.ReadValue(r));
            }
            options.Properties = properties;
        }
        return options;
    }

    private static WriteValue(w: ByteWriter, value: CellValue): void
    {
        const type = WriteBatch.TypeOf(value);
        if (type === undefined)
        {
            w.U8(WriteBatch.NullTag);
            return;
        }
        w.U8(type);
        w.Raw(ValueCodec.Encode(type, value));
    }

    private static ReadValue(r: ByteReader): CellValue
    {
        const tag = r.U8();
        if (tag === WriteBatch.NullTag)
        {
            return null;
        }
        if (!(tag in ValueType) || typeof ValueType[tag] !== 'string')
        {
            throw new RangeError(WriteBatch.ErrTag + tag);
        }
        const decoded = ValueCodec.DecodeAt(tag as ValueType, r.Bytes, r.At, r.View);
        r.At = decoded.End;
        return decoded.Value;
    }

    /** The column type a JS value encodes as; undefined for null. Throws TypeError for anything else. */
    private static TypeOf(value: CellValue): ValueType | undefined
    {
        if (value === null)
        {
            return undefined;
        }
        switch (typeof value)
        {
            case 'boolean':
                return ValueType.Boolean;
            case 'bigint':
                return ValueType.Int64;
            case 'number':
                return ValueType.Float64;
            case 'string':
                return ValueType.String;
        }
        if (value instanceof DateValue)
        {
            return ValueType.Date;
        }
        if (value instanceof DateTimeValue)
        {
            return ValueType.DateTime;
        }
        if (value instanceof DurationValue)
        {
            return ValueType.Duration;
        }
        throw new TypeError(WriteBatch.ErrValueType + String(value));
    }

    private static RequireValue(value: CellValue): void
    {
        const type = WriteBatch.TypeOf(value);
        if (type === undefined)
        {
            return;
        }
        try
        {
            ValueCodec.Check(type, value);
        }
        catch (error)
        {
            throw new RangeError(WriteBatch.ErrValue + String(value), { cause: error });
        }
    }

    private static RequireText(...texts: string[]): void
    {
        for (const t of texts)
        {
            if (WriteBatch.LoneSurrogate.test(t))
            {
                throw new RangeError(WriteBatch.ErrText + JSON.stringify(t));
            }
        }
    }

    private static CopyOptions(options: LinkOptions): LinkOptions
    {
        const copy: { AfterSibling?: string; BeforeSibling?: string; Properties?: ReadonlyMap<string, CellValue> } = {};
        if (options.AfterSibling !== undefined)
        {
            WriteBatch.RequireText(options.AfterSibling);
            copy.AfterSibling = options.AfterSibling;
        }
        if (options.BeforeSibling !== undefined)
        {
            WriteBatch.RequireText(options.BeforeSibling);
            copy.BeforeSibling = options.BeforeSibling;
        }
        if (options.Properties !== undefined)
        {
            for (const [name, value] of options.Properties)
            {
                WriteBatch.RequireText(name);
                WriteBatch.RequireValue(value);
            }
            copy.Properties = new FrozenMap(options.Properties);
        }
        return Object.freeze(copy);
    }

    private Push(op: BatchOp): void
    {
        if (this.#sealed)
        {
            throw new TypeError(WriteBatch.ErrSealed);
        }
        this.#view = undefined;
        this.ops.push(Object.freeze(op));
    }
}
