# On-disk format, version 1

This document is the contract between the TypeScript engine and the future Rust core. Both must read and write exactly these bytes. `src/format/FormatKeys.ts` is the single place keys are built.

## Conventions

- Every key is a flat tuple encoded with the FoundationDB tuple layer (`TupleCodec`). Encoded keys order bytewise like their tuples. Rules:
  - Byte string: `0x01`, the bytes with each `0x00` escaped as `0x00 0xFF`, then terminator `0x00`.
  - UTF-8 string: same as byte string with type code `0x02`.
  - Integer, type codes `0x0C..0x1C`, `0x14` = zero. Positive n-byte value (n = 1..8): code `0x14 + n`, then the value big-endian in n bytes. Negative value whose magnitude needs n bytes: code `0x14 - n`, then the one's complement of the magnitude (big-endian, n bytes). Maximum 8 bytes (magnitude below 2^64); larger values are rejected.
- Negative integers are supported by the codec, but v1 keys only use non-negative values. Ids and chunk/block numbers are 64-bit.
- Values outside keys (row blocks, chunk headers, delta entries) are little-endian binary as specified below.
- Format version: `1`. `SlotsPerChunk = 2048`. Id block size `4096`. Maximum public id length: 400 UTF-8 bytes.
- Partition is always `0` in v1 but present in every location-bearing key (seam 3). Internal ids never encode location (seam 2).
- Each key family lives in exactly one keyspace. Keyspaces that hold several families prefix the tuple with a small integer tag.

## Keyspaces and keys

| Keyspace | Key tuple | Value |
|---|---|---|
| `meta` | `(name: string, ...qualifiers)` | per name, see Meta |
| `catalog` | `(1)` catalog root | catalog definitions: UTF-8 JSON, see Catalog |
| `ids` | `(1, publicId: string)` | internal id: tuple-encoded `(id: u64)` |
| `ids` | `(2, id: u64)` | public id: UTF-8 bytes |
| `rows` | `(partition, block: u64)` | row block |
| `columns` | `(partition, typeId, memberId, chunk: u64)` | column chunk |
| `deltas` | `(partition, typeId, memberId, chunk: u64)` | delta |
| `edges` | `(partition, relationshipId, direction, node: u64, position: bytes, other: u64)` | edge payload (empty in v1 unless a later task defines properties) |
| `log` | `(commit: u64)` | log entry |

### Meta

Keys are `(name, ...qualifiers)`. Names defined so far:

- `("format")`: the format version, stored as a tuple-encoded single integer `(1)`. `FormatMeta.Verify` throws `FormatVersionMismatchError` if absent or not `1`.
- `("catalogVersion")`: the catalog version, a tuple-encoded single integer `(n)`; absent means `0` (empty catalog).
- `("nextBlock")`: the next unallocated id block number, a tuple-encoded single integer `(n)`; absent means `0`. The allocator reserves a block by committing `(n + 1)` in its own write before handing out any id from block `n`, so a block is durable before use and a rolled-back caller can waste ids but never duplicate them.

Names added by later tasks, each with its value layout completed by that task:

- `("slots", typeId)`: Task 10.
- `("commit")`: Task 12.

### Catalog

`(1)` is the catalog root and the only catalog key in v1. Its value is the UTF-8 encoding of a JSON object:

```
{ NextTypeId: number, NextMemberId: number, Definitions: TypeDefinition[] }
TypeDefinition = { Name, IsAspect, TypeId, Parent: string|null, Aspects: string[], Members: MemberDef[] }
MemberDef = { Id, Name, Kind, Type?, Nullable, Targets?, Many?, Ordered?, EdgeProperties?: MemberDef[], DeclaredBy }
```

`Definitions` are in definition order. `Kind` is `1` Property or `2` Relationship; `Type` is `1` Boolean, `2` Int64, `3` Float64, `4` String, `5` Date, `6` DateTime, `7` Duration. Type ids and member ids are stored as assigned. `NextTypeId` and `NextMemberId` are the persisted next-id counters, so ids are never reused; a counter must be at least `1` and at least one more than the largest stored id of its kind (edge properties included), else the catalog is corrupt. The catalog version lives in `Meta("catalogVersion")`, not in the row, and is written in the same transaction. A save must carry exactly the stored version plus one, otherwise it is rejected as a version conflict. A value that is not valid JSON of this shape, or that repeats a type id or member id (edge properties included), is rejected on load as a corrupt catalog.

Member ids are catalog-global: one id space across all concepts and aspects, assigned once, stable, never reused, starting at `1`. An aspect-contributed member keeps its one id in every carrier concept. Member id `0` is reserved: it is the implicit node-id column (Int64, non-null) present on every concept.

### Ids

Both directions live in the `ids` keyspace, distinguished by tag: `1` = `PublicToInternal`, `2` = `InternalToPublic`. Internal ids are allocated in blocks of 4096 and never encode partition or location. Id `0` is never allocated: it is reserved to mean "no id" (the first block starts at id `1`). Block number is `id / 4096`.

Values: `PublicToInternal` holds the internal id as a tuple-encoded single integer `(id)`; `InternalToPublic` holds the public id as raw UTF-8 bytes. A public id is non-empty and at most 400 UTF-8 bytes. The two directions are always written and deleted together; a public id is bound to at most one internal id and vice versa.

### Rows (row index)

A block covers 4,096 consecutive internal ids: `block = id / 4096`, entry index `id % 4096`. The value is 4,096 entries of 8 bytes (32,768 bytes), entry `i` at byte offset `8 * i`:

```
typeId : u32 little-endian
slot   : u32 little-endian
```

An entry is unassigned iff both `typeId` and `slot` are `0xFFFFFFFF`; therefore `0xFFFFFFFF` is reserved and is never a valid type id or slot. A missing block means all 4,096 entries are unassigned. The row entry is an index only: it locates the node's cells; it never copies data. Edges point to internal ids, never slots.

### Columns

Key `(partition, typeId, memberId, chunk)`; chunk `c` holds slots `c * 2048` to `c * 2048 + 2047` of that type. Value:

```
encoding  : u8      0 = Plain, 1 = BitPacked, 2 = Dictionary (seam 9; ids fixed forever)
slotCount : u16 LE  number of slots covered (<= 2048)
nullBitmap: ceil(slotCount / 8) bytes, bit i = byte i/8, bit (i % 8) (LSB first); 1 = null
payload   : encoding-specific cell bytes
```

Columns read by traversal use only random-access encodings (0, 1, 2). A reader reads one cell from the header, its null bit and the bytes of that cell alone. Cell count is 1..2048; a chunk whose header says otherwise, whose encoding id is unknown, or whose payload is too short for the cell read is corrupt and rejected. A whole-chunk decode additionally requires the payload to have exactly its encoding's expected length (no trailing bytes) and the unused high bits of the last bitmap byte to be zero.

Null cells still occupy their slot in the payload (zero bytes, or code 0 / delta 0), so slot positions never shift. Value domains: Boolean; Int64 signed 64-bit; Float64 IEEE-754 binary64 (-0 and infinities are preserved; NaN is stored as canonical quiet NaN 0x7FF8000000000000; readers accept any NaN pattern); String is well-formed Unicode stored as UTF-8 (a lone surrogate is rejected on encode, invalid UTF-8 is corrupt on read); Date is `i32` days since 1970-01-01; DateTime is `i64` UTC microseconds plus a non-empty IANA zone name of at most 65,535 UTF-8 bytes; Duration is `i32 months, i32 days, i64 microseconds`. All integers little-endian.

Which encodings apply: Plain for every type. BitPacked for Boolean, Int64, Date. Dictionary for every type except Boolean. Requesting an inapplicable encoding is an error. The encoder picks the smallest payload among the applicable encodings (ties go to the lower id); BitPacked on Int64/Date is applicable only when `max - min` fits in 63 bits, otherwise Plain is chosen.

#### Plain payload (encoding 0), `n = slotCount`

| Type | Layout |
|---|---|
| Boolean | `ceil(n/8)` bytes, bit i = byte i/8 bit (i % 8), LSB first, 1 = true |
| Int64 | `n` x `i64` |
| Float64 | `n` x `f64` |
| Date | `n` x `i32` |
| Duration | `n` x 16 bytes: `months i32, days i32, micros i64` |
| String | `end[n]`: `n` x `u32`, the cumulative end offset of each slot's UTF-8 bytes in the heap; then the heap. Slot i spans `[end[i-1], end[i])` (start 0 for slot 0). A null slot has `end[i] = end[i-1]` |
| DateTime | `micros[n]`: `n` x `i64`; `zoneIndex[n]`: `n` x `u16`; `zoneCount u16`; `zoneEnd[zoneCount]`: `zoneCount` x `u32` cumulative end offsets; zone heap (UTF-8). Zones are listed in order of first appearance; a null slot has micros 0 and zone index 0 |

#### BitPacked payload (encoding 1)

Boolean: identical to the Plain Boolean layout. Int64 and Date (frame of reference):

```
base  : i64   minimum non-null value (0 when every cell is null)
width : u8    bits per slot, 0..63; width 0 when all non-null values are equal
data  : ceil(n * width / 8) bytes; slot i holds (value - base) as an unsigned width-bit
        integer starting at bit i * width, LSB first across bytes. Null slots hold 0.
```

#### Dictionary payload (encoding 2)

```
dictCount : u16   number of distinct non-null values, in order of first appearance
width     : u8    bits per code, 0..11; 0 when dictCount <= 1, else bitlength(dictCount - 1)
codes     : ceil(n * width / 8) bytes, one code per slot packed LSB first as in BitPacked; null slots hold 0
dictionary: the Plain payload of the type for dictCount slots (no header, no nulls)
```

A code at or above `dictCount` is corrupt. Float64 values are distinct by bit pattern (0 and -0 are different entries).

#### Single value bytes

One non-null value, self-delimiting (used by delta entries and edge properties; null is expressed by the surrounding `present = 0`, never by value bytes). `ChunkCodec.EncodeValue(type, value)` / `DecodeValue(type, bytes)`:

| Type | Bytes |
|---|---|
| Boolean | 1 byte, 0 or 1 (anything else is corrupt) |
| Int64 | `i64` |
| Float64 | `f64` |
| Date | `i32` |
| Duration | `months i32, days i32, micros i64` |
| String | `byteLength u32`, UTF-8 bytes |
| DateTime | `micros i64`, `zoneLength u16`, zone UTF-8 bytes |

Member id `0` of every type is the node-id column. A slot is live iff its member-0 cell is non-null; deleted slots have a null node id.

### Deltas

Same key tuple as the column chunk it overlays, stored in the `deltas` keyspace. Value is a list of entries, concatenated with no count or padding, in ascending `slot` order; readers overlay them on the chunk:

```
slot    : u16 LE
present : u8        0 = cell is null, 1 = value follows
value   : present = 1 only; one cell encoded as defined by ChunkCodec (Task 9)
```

The `value` bytes are the single-value layout defined under Columns (Single value bytes); they are self-delimiting, so entries parse without a length field.

### Edges

Key `(partition, relationshipId, direction, node, position, other)` where `direction` is `0` = Out, `1` = In and `position` is a `FractionalPosition` byte string (tuple byte-string element). Every edge is written twice: once as Out under its source node and once as In under its target node. For one `(partition, relationshipId, direction, node)` prefix, keys sort by `position` then `other`. All edges of a node and direction form the range `[prefix, PrefixEnd(prefix))`, built by `FormatKeys.EdgeRange`.

### Log

Key `(commit: u64)`; commits are monotonic and gap-free from `1`. The value is the serialized `WriteBatch` defined in Task 12; this section is completed by that task.
