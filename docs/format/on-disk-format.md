# On-disk format, version 1

This document is the contract between the TypeScript engine and the future Rust core. Both must read and write exactly these bytes. `src/format/FormatKeys.ts` is the single place keys are built.

## Conventions

- Every key is a flat tuple encoded with the FoundationDB tuple layer (`TupleCodec`). Encoded keys order bytewise like their tuples. Rules:
  - Byte string: `0x01`, the bytes with each `0x00` escaped as `0x00 0xFF`, then terminator `0x00`.
  - UTF-8 string: same as byte string with type code `0x02`.
  - Integer, type codes `0x0C..0x1C`, `0x14` = zero. Positive n-byte value (n = 1..8): code `0x14 + n`, then the value big-endian in n bytes. Negative value whose magnitude needs n bytes: code `0x14 - n`, then the one's complement of the magnitude (big-endian, n bytes). Maximum 8 bytes (magnitude below 2^64); larger values are rejected.
- Negative integers are supported by the codec, but v1 keys only use non-negative values. Ids and chunk/block numbers are 64-bit. Internal ids are positive and at most 2^63-1 so that the node-id column (member 0, Int64) stores them as plain signed values.
- Values outside keys (row blocks, chunk headers, delta entries) are little-endian binary as specified below.
- Format version: `1` (not yet frozen: this wave changed layouts without a version bump). `SlotsPerChunk = 2048`. Id block size `4096`. Row block size `512` entries. Maximum public id length: 400 UTF-8 bytes.
- Maximum encoded key size: **511 bytes** in every keyspace (the portable limit; LMDB allows 1,978, heed's default is 511). Every backend rejects a longer key on Put, Delete and Get and as a Scan bound with a `KeyTooLong` error. The formats below are designed so that no valid write exceeds it: a public id has at most 400 UTF-8 bytes and contains no U+0000 (so its tuple string needs at most 400 + 2 bytes), and edge positions are kept short (see Edges, Positions).
- Partition is always `0` in v1 but present in every location-bearing key (seam 3). Internal ids never encode location (seam 2). Intentionally partition-free (global) keys: `meta` names `format`, `catalogVersion`, `nextBlock` and `commit`; the whole `catalog` keyspace (the schema is global; placement is per concept inside it); the `ids` keyspace (identity is location-free); the `rows` keyspace (the row index maps every id to a location that itself carries the partition); and the `log` keyspace (one commit order per store). Every key that addresses node data (`columns`, `deltas`, `edges`, `meta` `slots`) carries the partition.
- Each key family lives in exactly one keyspace. Keyspaces that hold several families prefix the tuple with a small integer tag.
- Each keyspace is its own ordered map: in LMDB one named database per keyspace (named by the keyspace's string, e.g. `meta`, `edges`) with the default key comparison, which is `memcmp` (unsigned bytewise, a shorter key that is a prefix of a longer one sorts first). The tuple encoding is designed for exactly that order; a Rust core must use the same named databases and the default comparator (no custom comparators, no dup-sort).
- The LMDB environment directory also holds `graph.lock`: the decimal process id of the store that has it open for writing (one writer per directory; a lock whose process no longer exists is stale and may be taken over). It is not part of the data and is removed on a clean close. Commits are synchronous (`overlappingSync` off): a commit is on disk when it is reported.
- **Encoders must be canonical** (note for the Rust implementation): for every value there is exactly one valid encoding, and readers may compare encoded bytes for equality. Integers use the minimal byte count (no leading zero bytes; zero is the single byte `0x14`); strings are well-formed UTF-8 with no normalization applied; positions follow the validity rule (Edges, Positions); edge-property and delta entries are sorted as specified with no duplicates; JSON catalogs are written by the engine and only parsed (never compared) by readers. A Rust encoder must produce byte-identical output for identical input.

## Keyspaces and keys

| Keyspace | Key tuple | Value |
|---|---|---|
| `meta` | `(name: string, ...qualifiers)` | per name, see Meta |
| `catalog` | `(1)` catalog root | catalog definitions: UTF-8 JSON, see Catalog |
| `ids` | `(1, publicId: string)` | internal id: tuple-encoded `(id: u64)` |
| `ids` | `(2, id: u64)` | public id: UTF-8 bytes |
| `rows` | `(block: u64)` | row block (global; entries carry the partition) |
| `columns` | `(partition, typeId, memberId, chunk: u64)` | column chunk |
| `deltas` | `(partition, typeId, memberId, chunk: u64)` | delta |
| `edges` | `(partition, relationshipId, direction, node: u64, position: bytes, other: u64)` | Out: edge-property list; In: empty (see Edges) |
| `log` | `(commit: u64)` | log entry |

### Meta

Keys are `(name, ...qualifiers)`. Names defined so far:

- `("format")`: the format version, stored as a tuple-encoded single integer `(1)`. `FormatMeta.Verify` throws `FormatVersionMismatchError` if absent or not `1`.
- `("catalogVersion")`: the catalog version, a tuple-encoded single integer `(n)`; absent means `0` (empty catalog). Every schema change bumps it by one, through the committer (it is a commit with a SchemaChange log entry).
- `("nextBlock")`: the next unreserved id block number, a tuple-encoded single integer `(n)`; absent means `0`. The allocator reserves 16 blocks at a time by committing `(n + 16)` in its own write before handing out any id from blocks `n .. n + 15` (ruling F6), so a block is durable before use and a rolled-back caller (or a restart, which forgets unused reserved blocks) can waste ids but never duplicate them.

Names added by later tasks, each with its value layout completed by that task:

- `("slots", partition, typeId)`: the number of slots ever allocated for the type in that partition (only partition 0 in v1), a tuple-encoded single integer `(n)`; absent means `0`. Slots are allocated densely from 0 (`AllocateSlot` returns `n` and stores `n + 1`) inside the caller's write transaction; slot `0xFFFFFFFF` is reserved. Deleted slots are not reused in v1.
- `("commit")`: the last commit number, a tuple-encoded single integer `(n)`; absent means `0` (no commits). Written only by the committer, in the same write transaction as the log entries it covers, so it always equals the highest `log` key.

### Catalog

`(1)` is the catalog root and the only catalog key in v1. Its value is the UTF-8 encoding of a JSON object:

```
{ NextTypeId: number, NextMemberId: number, Definitions: TypeDefinition[] }
TypeDefinition = { Name, IsAspect, TypeId, Parent: string|null, Aspects: string[], Members: MemberDef[], Placement?, AggregateRoot? }
MemberDef = { Id, Name, Kind, Type?, Nullable, Targets?, Many?, Ordered?, EdgeProperties?: MemberDef[], DeclaredBy }
```

`Definitions` are in definition order. `Placement` and `AggregateRoot` (seam 3, ruling F5) are concept-only and additive: `Placement` is `1` Replicated (ontology core, taxonomies: copied to every partition) or `2` Partitioned (instance data); a concept stored without it loads as Partitioned, and the engine always writes it for concepts. `AggregateRoot` is optional and names a concept (not an aspect, not undefined) whose instances this concept's instances are co-located with and conflict-partitioned by. An aspect with either field, or a `Placement` outside `1..2`, is a corrupt catalog; an `AggregateRoot` that does not name a concept is rejected as a schema error (`InvalidAggregateRoot`). `Kind` is `1` Property or `2` Relationship; `Type` is `1` Boolean, `2` Int64, `3` Float64, `4` String, `5` Date, `6` DateTime, `7` Duration. Type ids and member ids are stored as assigned. `NextTypeId` and `NextMemberId` are the persisted next-id counters, so ids are never reused; a counter must be at least `1` and at least one more than the largest stored id of its kind (edge properties included), else the catalog is corrupt. The catalog version lives in `Meta("catalogVersion")`, not in the row, and is written in the same transaction. A save must carry exactly the stored version plus one, otherwise it is rejected as a version conflict. A value that is not valid JSON of this shape, or that repeats a type id or member id (edge properties included), is rejected on load as a corrupt catalog.

Cost note (F9): the catalog root is one value, so every schema change rewrites (and logs) the whole catalog: O(catalog size) per change, fine at thousands of concepts. Per-definition keys (one key per type definition, so a change writes only what it touches) are a deferred format change; the root key `(1)` and its tag leave room for them.

Member ids are catalog-global: one id space across all concepts and aspects, assigned once, stable, never reused, starting at `1`. An aspect-contributed member keeps its one id in every carrier concept. Member id `0` is reserved: it is the implicit node-id column (Int64, non-null) present on every concept.

### Ids

Both directions live in the `ids` keyspace, distinguished by tag: `1` = `PublicToInternal`, `2` = `InternalToPublic`. Internal ids are allocated in blocks of 4096 and never encode partition or location. Id `0` is never allocated: it is reserved to mean "no id" (the first block starts at id `1`). Block number is `id / 4096`.

Values: `PublicToInternal` holds the internal id as a tuple-encoded single integer `(id)`; `InternalToPublic` holds the public id as raw UTF-8 bytes. A public id is non-empty, at most 400 UTF-8 bytes and contains no U+0000 (rejected on read and write, so the `(1, publicId)` key always fits the key limit). The two directions are always written and deleted together; a public id is bound to at most one internal id and vice versa.

### Rows (row index)

The row index is global (ruling F5): it maps every internal id to its location, whatever partition holds the node, so its key is the row block number alone and each entry carries the partition. A row block covers 512 consecutive internal ids, independent of the 4,096-id allocation block (ruling F6): `block = id / 512`, entry index `id % 512`. The value is 512 entries of 12 bytes (6,144 bytes), entry `i` at byte offset `12 * i`:

```
partition : u32 little-endian
typeId    : u32 little-endian
slot      : u32 little-endian
```

An entry is unassigned iff all three of `partition`, `typeId` and `slot` are `0xFFFFFFFF`; therefore `0xFFFFFFFF` is reserved and is never a valid partition, type id or slot. The index is sparse: a missing block means all of its entries are unassigned. A write transaction writes each changed block once (at the committer's flush), not once per entry change. The row entry is an index only: it locates the node's cells; it never copies data. Edges point to internal ids, never slots.

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

Member id `0` of every type is the node-id column. A slot is live iff its member-0 cell is non-null; deleted slots have a null node id. Deleting a node nulls every property cell of its slot, not only member 0 (ruling F9), so no value of a deleted node remains readable at its old location. Slot reuse is a documented follow-up: in v1 a deleted slot stays allocated (null) forever and `Meta("slots", ...)` only grows; reusing slots later needs a free-slot list per type and partition and is additive (a new `meta` name), not a change of these layouts.

### Deltas

Same key tuple as the column chunk it overlays, stored in the `deltas` keyspace. Value is a list of entries, concatenated with no count or padding, in ascending `slot` order; readers overlay them on the chunk:

```
slot    : u16 LE    the slot within the chunk (0..2047), i.e. node slot % 2048, not the node's type-wide slot
present : u8        0 = cell is null, 1 = value follows
value   : present = 1 only; one cell encoded as defined by ChunkCodec (Task 9)
```

The `value` bytes are the single-value layout defined under Columns (Single value bytes); they are self-delimiting, so entries parse without a length field.

### Edges

Key `(partition, relationshipId, direction, node, position, other)` where `direction` is `0` = Out, `1` = In and `position` is a position byte string (tuple byte-string element, see Positions). Every edge is written twice: once as Out under its source node and once as In under its target node. For one `(partition, relationshipId, direction, node)` prefix, keys sort by `position` then `other`. All edges of a node and direction form the range `[prefix, PrefixEnd(prefix))`, built by `FormatKeys.EdgeRange`.

The Out key on the source is `(partition, relationshipId, 0, from, position, to)` and the In key on the target is `(partition, relationshipId, 1, to, position, from)`; both carry the same position. Unordered relationships use the empty position (zero-length byte string); ordered ones use a valid position (see Positions). A `(from, relationship, to)` pair links at most once, and a relationship without `Many` allows one Out edge per source.

**Out value** (edge properties): for each non-null property, sorted by member id ascending, `memberId: u32 LE`, `length: u32 LE`, then `length` bytes of single-value encoding (the Columns single value layout for the property type). Null and absent properties are not stored; an edge with no properties has an empty value. **In value**: empty; In-direction reads fetch properties from the matching Out key.

Lookup cost by `(from, to)`: O(1) for unordered Many relationships (direct key), one single-key scan for unordered one-valued relationships, and O(in-degree of `to`) for ordered relationships: the In keys carry the position, so the target's In range is scanned (ruling R33; 1 for trees). An ordered insert after a sibling then finds the neighbour with one forward scan of at most 2 keys from that sibling's Out position; a plain append finds the last sibling, and an insert with only a Before sibling the preceding one, with one reverse scan of limit 1 (ruling F1). No ordered insert costs O(out-degree).

#### Positions

A position is opaque to readers: only its bytewise order matters, and the engine may rewrite it (positions are internal; ruling F1). Layout: an integer part, then a fraction.

```
head   : u8      integer digit count n = head - 0x7F when head >= 0x80, else 0x80 - head (1..128)
digits : n bytes the integer's digits, most significant first
fraction: 0 or more bytes, a base-256 fraction 0.f1f2... (compared bytewise; shorter = smaller when a prefix)
```

A larger head is a larger integer; equal heads compare digit by digit, so the fixed-length integer part followed by the fraction orders bytewise. **Validity rule:** a valid position is non-empty, holds its whole integer part (`length >= 1 + n`) and does not end in `0x00`; readers treat any other position as corrupt input to placement. The first position of an empty list is `80 80`. Appending steps the integer up by one (on overflow of all digits the head moves up one and the digits restart at all `00`); prepending steps it down (the head moves down and digits restart at all `FF`); a stepped integer whose last digit would be `00` is skipped. So n appends or prepends need O(log n) bytes (100,000 appends: 4 bytes). An insert between two positions with different integer parts takes the next integer if it sorts below the upper bound, else the lower bound's integer plus the midpoint of its fraction and 1; between two positions with the same integer part it bisects the fractions (about one bit per insert at the same spot).

**Renumbering.** When a between-insert would make the longer of the edge's two keys exceed 511 bytes, the committer renumbers that `(source, relationship)` list inside the same write transaction: every edge of the list is rewritten (Out and In keys, Out value unchanged) with consecutive integer positions starting at `80 80`, in the same order, and the insert is then placed between its renumbered neighbours. The rewritten edges are written conflict keys of the batch. No other code path ever changes a stored position.

### Log

Key `(commit: u64)`; commits are monotonic and gap-free from `1`, and `Meta("commit")` is the highest one. The log is the changefeed (seam 7) and the record of every commit, batches and schema changes alike (ruling F4); the committer appends one entry per commit inside the same write transaction that applies it. Each entry is self-sufficient for deterministic replay: replaying the entries in order against an empty store reproduces the same catalog, the same internal ids and the same data. `GraphStore.ReadChanges(afterCommit)` reads it.

The value is a log entry. All integers little-endian:

```
kind : u8   1 = Batch, 2 = SchemaChange
Batch:
  catalogVersion : u32      the catalog version the batch was validated and applied against
  idCount        : u32      number of CreateNode ops in the batch
  ids            : idCount x u64   the internal ids allocated for the CreateNode ops, in op order (never 0)
  batch          : the rest: the serialized WriteBatch (below)
SchemaChange:
  catalogVersion : u32      the catalog version the change produced
  catalog        : the rest: the complete catalog root value after the change (UTF-8 JSON, see Catalog)
```

A schema change is committed alone (never grouped with batches); it writes the catalog root, `Meta("catalogVersion")`, its log entry and `Meta("commit")` in one write transaction. A batch whose transaction began on another catalog version than the one its group applies against is rejected with a conflict before it writes anything. A reader rejects an unknown kind, a truncated entry, an `idCount` that differs from the batch's CreateNode count, an id `0`, and a batch or catalog that fails its own validation.

The serialized `WriteBatch` holds logical operations addressed by public id, in the order they were applied:

```
version : u8      1
count   : u32     number of operations
ops     : count x op
op      : kind u8, then the fields of that kind
  1 CreateNode  : publicId str, concept str, hasHint u8 (0|1), [clusterHint str]
  2 SetProperty : publicId str, member str, value
  3 DeleteNode  : publicId str
  4 Link        : from str, relationship str, to str, flags u8, [afterSibling str], [beforeSibling str], [properties]
  5 Unlink      : from str, relationship str, to str
str        : byteLength u32, UTF-8 bytes (well-formed Unicode)
value      : tag u8; 0 = null (no bytes follow), else the ValueType (1 Boolean .. 7 Duration)
             followed by that type's single value bytes (see Columns, Single value bytes)
flags      : bit 0 = options present, bit 1 = afterSibling, bit 2 = beforeSibling, bit 3 = properties;
             0 = no options; any other bit set, or a field bit without bit 0, is corrupt
properties : count u32, then count x (name str, value); names are distinct
```

`afterSibling` / `beforeSibling` are public ids of existing targets of the same `(from, relationship)`; the committer resolves them to those edges' positions. A value's tag is the value's own type (a bigint is Int64, a JS number Float64); the member's declared type is checked when the batch is applied. A reader rejects an unknown version, kind, tag or flag, a truncated entry, invalid UTF-8, and trailing bytes.
