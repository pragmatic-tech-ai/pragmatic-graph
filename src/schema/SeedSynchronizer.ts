import type { MemberDef } from '../catalog/CatalogTypes.js';
import { MemberKind } from '../catalog/ValueType.js';
import { type CellValue, DateTimeValue, DateValue, DurationValue } from '../columns/CellValue.js';
import type { ColumnStore } from '../columns/ColumnStore.js';
import type { EdgeStore } from '../edges/EdgeStore.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import { EdgeDirection } from '../format/FormatKeys.js';
import type { PublicIdIndex } from '../identity/PublicIdIndex.js';
import type { RowIndex } from '../identity/RowIndex.js';
import type { IReadTransaction } from '../kv/KeyValue.js';
import { BatchApplier } from '../txn/BatchApplier.js';
import type { CatalogIndex } from '../txn/CatalogIndex.js';
import { CommitError, CommitErrorCode } from '../txn/CommitError.js';
import { type LinkOptions, WriteBatch } from '../txn/WriteBatch.js';
import type { ISeedLink, ISeedNode } from './SchemaDescription.js';
import { SeedHash } from './SeedHash.js';

/** What the synchronizer needs to know about the stored graph (post-purge, inside the upgrade's write). */
export interface ISeedView
{
    Resolve(publicId: string): Promise<{ readonly Concept: string; readonly Owner: string } | undefined>;
    /**
     * Every out-edge of the node over its concept's relationships, per relationship in edge order, with its edge
     * properties.
     */
    OutEdges(publicId: string): Promise<readonly ISeedEdge[]>;
    /** The stored value of every effective property of the node (null when unset); empty when the node is absent. */
    Properties(publicId: string): Promise<ReadonlyMap<string, CellValue>>;
}

/** One stored out-edge, as the seed view reports it. */
export interface ISeedEdge
{
    readonly Relationship: string;
    readonly To: string;
    readonly Properties: ReadonlyMap<string, CellValue>;
}

/** The seed's effect: one batch, the markers to write and the previously seeded ids to unmark. */
export interface ISeedPlan
{
    /** Unlinks, deletes, creates, property sets, links, in that order. */
    readonly Batch: WriteBatch;
    /** New markers: every seed node the batch creates or overwrites. */
    readonly Hashes: ReadonlyMap<string, Uint8Array>;
    /** Previously seeded ids absent from the new seed (deleted by the batch when still live). */
    readonly Removed: readonly string[];
}

/** What the upgrade's purge did, when the catalog changed (ruling R55). */
export interface ISeedCatalogChange
{
    /** Surviving nodes the purge modified (a value dropped, an edge removed): IPurgeStats.ModifiedNodes. */
    readonly Modified: ReadonlySet<string>;
}

/** How one seed node is applied. */
enum SeedAction
{
    /** Present, seeded, same hash: left alone (runtime edits survive). */
    Keep = 0,
    /** Absent: created. */
    Create = 1,
    /** Present with another concept: deleted and created again. */
    Recreate = 2,
    /** Present with the same concept: the properties and relationships that differ from the seed rewritten. */
    Overwrite = 3,
}

interface ISeedStep
{
    readonly Node: ISeedNode;
    /** Keep may be promoted to Overwrite (ruling R55). */
    Action: SeedAction;
    readonly Hash: Uint8Array;
}

/** What an Overwrite rewrites: only the parts of the node that differ from its seed (ruling R53). */
interface ISeedDiff
{
    /** Property sets, in seed order, then the nulls of absent effective properties in member order. */
    readonly Sets: ReadonlyArray<readonly [string, CellValue]>;
    /** Relationships whose stored out-edges are replaced by the seed's links. */
    readonly Relinked: ReadonlySet<string>;
    /** The stored out-edges of the relinked relationships, unlinked first. */
    readonly Unlinks: readonly ISeedEdge[];
}

/**
 * Seed synchronization (spec 4.3, "seed wins for seeded nodes"): turns the description's seed into one
 * WriteBatch against the store as it is after the upgrade's purge. A node absent from the store is
 * created (with its owner) and given its properties and links; a node seeded with the same hash is left
 * alone; any other present node (a different hash, or a runtime node that has the seed's id) is
 * overwritten with only what differs from the stored node (ruling R53): a property whose stored value
 * differs from the seed's (absent ones count as null; a non-nullable absent one is MissingRequired) is
 * set, and a relationship whose stored out-edges differ from the seed's links (ordered: the same
 * sequence of targets and edge properties; unordered: the same targets with the same edge properties)
 * has its out-edges removed and the seed links re-added in seed order; a node that already matches its
 * seed (the data a connector write-through just put in the engine) gets only its marker. Its owner must
 * match (owner is create-time: InvalidValue otherwise, checked first); a node whose concept differs is
 * deleted and created again. Previously seeded ids missing from the seed are deleted. Creates come
 * before property sets and links, so links may point at seed nodes later in the array.
 *
 * A node left alone is promoted to overwritten (ruling R55) when one of its seed links points at a node
 * the batch creates, recreates or deletes, and, after a catalog change, when the purge modified it or
 * its seed no longer fits the new catalog (unknown concept, a property that is not an effective
 * property, a link whose relationship is not effective or does not accept the target): its seed is then
 * re-applied, or the batch fails exactly as an edited seed would.
 */
export class SeedSynchronizer
{
    private static readonly ErrDuplicate = 'Seed lists the public id twice: ';
    private static readonly ErrOwner = 'Seed owner differs from the stored node owner (owner is fixed at creation): ';
    private static readonly ErrRequired = 'Seed lacks a value for a required property: ';
    private static readonly Dot = '.';

    public constructor(private readonly index: CatalogIndex)
    {
    }

    /**
     * The read-only pre-pass (ruling R16: ids are allocated outside the write): the public ids of every
     * seed node absent from the view or present but not seeded with the same hash. Only the ones Build
     * then creates or recreates consume their id; an overwritten node keeps its own (the rest are wasted).
     */
    public static async IdsNeeded(view: ISeedView, seed: readonly ISeedNode[], storedHashes: ReadonlyMap<string, Uint8Array>): Promise<string[]>
    {
        const out: string[] = [];
        for (const node of SeedSynchronizer.Validated(seed))
        {
            const present = await view.Resolve(node.PublicId);
            if (present === undefined || !SeedHash.Equal(storedHashes.get(node.PublicId), SeedHash.Of(node)))
            {
                out.push(node.PublicId);
            }
        }
        return out;
    }

    /** `catalogChange`: given iff the upgrade changed the catalog (and purged). */
    public async Build(view: ISeedView, seed: readonly ISeedNode[], storedHashes: ReadonlyMap<string, Uint8Array>, catalogChange?: ISeedCatalogChange): Promise<ISeedPlan>
    {
        const steps: ISeedStep[] = [];
        for (const node of SeedSynchronizer.Validated(seed))
        {
            steps.push(await this.Classify(view, node, storedHashes));
        }
        const seeded = new Set(seed.map(n => n.PublicId));
        const removed = [...storedHashes.keys()].filter(id => !seeded.has(id));
        await this.Promote(view, steps, new Set(removed), catalogChange);
        // A stored edge to a node the batch deletes goes with it, so its relationship must be relinked.
        const dropped = new Set([...removed, ...steps.filter(s => s.Action === SeedAction.Recreate).map(s => s.Node.PublicId)]);
        const diffs = new Map<ISeedStep, ISeedDiff>();
        for (const step of steps.filter(s => s.Action === SeedAction.Overwrite))
        {
            diffs.set(step, await this.Diff(view, step.Node, dropped));
        }
        const batch = new WriteBatch();
        for (const [step, diff] of diffs)
        {
            for (const edge of diff.Unlinks)
            {
                batch.Unlink(step.Node.PublicId, edge.Relationship, edge.To);
            }
        }
        for (const id of removed)
        {
            if ((await view.Resolve(id)) !== undefined)
            {
                batch.DeleteNode(id);
            }
        }
        for (const step of steps)
        {
            if (step.Action === SeedAction.Recreate)
            {
                batch.DeleteNode(step.Node.PublicId);
            }
            if (step.Action === SeedAction.Create || step.Action === SeedAction.Recreate)
            {
                const node = step.Node;
                batch.CreateNode(node.PublicId, node.Concept, node.Owner.length > 0 ? { Owner: node.Owner } : undefined);
            }
        }
        for (const step of steps.filter(s => s.Action !== SeedAction.Keep))
        {
            const diff = diffs.get(step);
            const sets = diff === undefined ? Object.entries(step.Node.Properties) : diff.Sets;
            for (const [name, value] of sets)
            {
                batch.SetProperty(step.Node.PublicId, name, value as CellValue);
            }
        }
        const hashes = new Map<string, Uint8Array>();
        for (const step of steps.filter(s => s.Action !== SeedAction.Keep))
        {
            const diff = diffs.get(step);
            for (const link of step.Node.Links.filter(l => diff === undefined || diff.Relinked.has(l.Relationship)))
            {
                const options: LinkOptions | undefined = link.Properties === undefined ? undefined : { Properties: new Map(Object.entries(link.Properties)) };
                batch.Link(step.Node.PublicId, link.Relationship, link.To, options);
            }
            hashes.set(step.Node.PublicId, step.Hash);
        }
        return { Batch: batch, Hashes: hashes, Removed: removed };
    }

    private async Classify(view: ISeedView, node: ISeedNode, storedHashes: ReadonlyMap<string, Uint8Array>): Promise<ISeedStep>
    {
        const hash = SeedHash.Of(node);
        const present = await view.Resolve(node.PublicId);
        if (present === undefined)
        {
            return { Node: node, Action: SeedAction.Create, Hash: hash };
        }
        if (SeedHash.Equal(storedHashes.get(node.PublicId), hash))
        {
            return { Node: node, Action: SeedAction.Keep, Hash: hash };
        }
        if (present.Owner !== node.Owner)
        {
            throw new CommitError(CommitErrorCode.InvalidValue, SeedSynchronizer.ErrOwner + node.PublicId);
        }
        return { Node: node, Action: present.Concept !== node.Concept ? SeedAction.Recreate : SeedAction.Overwrite, Hash: hash };
    }

    /** Ruling R55: Keep becomes Overwrite when leaving the node alone would lose or skip part of its seed. */
    private async Promote(view: ISeedView, steps: readonly ISeedStep[], removed: ReadonlySet<string>, catalogChange: ISeedCatalogChange | undefined): Promise<void>
    {
        const byId = new Map(steps.map(s => [s.Node.PublicId, s] as const));
        const replaced = new Set(steps.filter(s => s.Action === SeedAction.Create || s.Action === SeedAction.Recreate).map(s => s.Node.PublicId));
        for (const step of steps.filter(s => s.Action === SeedAction.Keep))
        {
            const node = step.Node;
            if (node.Links.some(l => replaced.has(l.To) || removed.has(l.To)))
            {
                step.Action = SeedAction.Overwrite;
            }
            else if (catalogChange !== undefined && (catalogChange.Modified.has(node.PublicId) || !(await this.Fits(view, node, byId))))
            {
                step.Action = SeedAction.Overwrite;
            }
        }
    }

    /** True iff the seed node is valid against the catalog: concept, property names, link relationships and targets. */
    private async Fits(view: ISeedView, node: ISeedNode, byId: ReadonlyMap<string, ISeedStep>): Promise<boolean>
    {
        const catalog = this.index.Catalog;
        if (!catalog.Definitions().some(d => d.Name === node.Concept && !d.IsAspect))
        {
            return false;
        }
        const members = catalog.EffectiveMembers(node.Concept);
        const properties = new Set(members.filter(m => m.Kind === MemberKind.Property).map(m => m.Name));
        if (Object.keys(node.Properties).some(name => !properties.has(name)))
        {
            return false;
        }
        for (const link of node.Links)
        {
            const rel = members.find(m => m.Kind === MemberKind.Relationship && m.Name === link.Relationship);
            const target = byId.get(link.To);
            const created = target !== undefined && (target.Action === SeedAction.Create || target.Action === SeedAction.Recreate);
            const concept = created ? target.Node.Concept : (await view.Resolve(link.To))?.Concept;
            if (rel === undefined || concept === undefined || !this.index.Accepts(rel, concept))
            {
                return false;
            }
        }
        return true;
    }

    /**
     * What an overwrite of `node` must write against the stored node: the property sets whose value
     * differs (a seed property that is not an effective property is kept, so the batch fails on it as
     * before), the nulls of absent effective properties not already null (MissingRequired for a
     * non-nullable one, whatever is stored), and the relationships whose stored out-edges differ from
     * the seed's links or point at a node in `dropped`.
     */
    private async Diff(view: ISeedView, node: ISeedNode, dropped: ReadonlySet<string>): Promise<ISeedDiff>
    {
        const stored = await view.Properties(node.PublicId);
        const sets: Array<readonly [string, CellValue]> = [];
        for (const [name, value] of Object.entries(node.Properties))
        {
            if (!stored.has(name) || !SeedSynchronizer.SameValue(stored.get(name) as CellValue, value as CellValue))
            {
                sets.push([name, value as CellValue]);
            }
        }
        const members = this.index.Catalog.EffectiveMembers(node.Concept);
        for (const member of members)
        {
            if (member.Kind !== MemberKind.Property || Object.hasOwn(node.Properties, member.Name))
            {
                continue;
            }
            if (!member.Nullable)
            {
                throw new CommitError(CommitErrorCode.MissingRequired, SeedSynchronizer.ErrRequired + node.PublicId + SeedSynchronizer.Dot + member.Name);
            }
            if ((stored.get(member.Name) ?? null) !== null)
            {
                sets.push([member.Name, null]);
            }
        }
        const edges = await view.OutEdges(node.PublicId);
        const names = new Set([...edges.map(e => e.Relationship), ...node.Links.map(l => l.Relationship)]);
        const relinked = new Set<string>();
        for (const name of names)
        {
            const have = edges.filter(e => e.Relationship === name);
            const want = node.Links.filter(l => l.Relationship === name);
            const rel = members.find(m => m.Kind === MemberKind.Relationship && m.Name === name);
            if (have.some(e => dropped.has(e.To)) || !SeedSynchronizer.SameEdges(rel, have, want))
            {
                relinked.add(name);
            }
        }
        return { Sets: sets, Relinked: relinked, Unlinks: edges.filter(e => relinked.has(e.Relationship)) };
    }

    /**
     * True iff the stored out-edges of one relationship are exactly the seed's links: for an ordered
     * relationship the same sequence, otherwise the same targets; each with the same edge properties
     * (absent counts as null). A relationship that is not effective has no stored edges: a link to it differs.
     */
    private static SameEdges(rel: MemberDef | undefined, have: readonly ISeedEdge[], want: readonly ISeedLink[]): boolean
    {
        if (rel === undefined || have.length !== want.length)
        {
            return false;
        }
        if (rel.Ordered === true)
        {
            return want.every((link, i) =>
            {
                const edge = have[i];
                return edge !== undefined && edge.To === link.To && SeedSynchronizer.SameEdgeProperties(edge.Properties, link.Properties ?? {});
            });
        }
        const byTarget = new Map(have.map(e => [e.To, e] as const));
        return want.every(link =>
        {
            const edge = byTarget.get(link.To);
            return edge !== undefined && SeedSynchronizer.SameEdgeProperties(edge.Properties, link.Properties ?? {});
        });
    }

    private static SameEdgeProperties(stored: ReadonlyMap<string, CellValue>, seed: Readonly<Record<string, CellValue>>): boolean
    {
        const names = new Set([...stored.keys(), ...Object.keys(seed)]);
        return [...names].every(name => SeedSynchronizer.SameValue(stored.get(name) ?? null, seed[name] ?? null));
    }

    /** Cell value equality as stored: same type and value (floats by Object.is, temporal values by Equals). */
    private static SameValue(a: CellValue, b: CellValue): boolean
    {
        if (typeof a === 'number' && typeof b === 'number')
        {
            return Object.is(a, b);
        }
        if (a instanceof DateValue && b instanceof DateValue)
        {
            return a.Equals(b);
        }
        if (a instanceof DateTimeValue && b instanceof DateTimeValue)
        {
            return a.Equals(b);
        }
        if (a instanceof DurationValue && b instanceof DurationValue)
        {
            return a.Equals(b);
        }
        return a === b;
    }

    /** The seed with every public id checked (CommitError InvalidPublicId) and listed once (DuplicatePublicId). */
    private static Validated(seed: readonly ISeedNode[]): readonly ISeedNode[]
    {
        const seen = new Set<string>();
        for (const node of seed)
        {
            BatchApplier.RequirePublicId(node.PublicId);
            if (seen.has(node.PublicId))
            {
                throw new CommitError(CommitErrorCode.DuplicatePublicId, SeedSynchronizer.ErrDuplicate + node.PublicId);
            }
            seen.add(node.PublicId);
        }
        return seed;
    }
}

/** ISeedView over a store transaction and the catalog its data conforms to. */
export class TransactionSeedView implements ISeedView
{
    private static readonly ErrCorrupt = 'Corrupt graph: node has no stored row, concept or public id: ';

    public constructor(
        private readonly txn: IReadTransaction,
        private readonly index: CatalogIndex,
        private readonly rows: RowIndex,
        private readonly ids: PublicIdIndex,
        private readonly edges: EdgeStore,
        private readonly columns: ColumnStore,
    )
    {
    }

    public async Resolve(publicId: string): Promise<{ readonly Concept: string; readonly Owner: string } | undefined>
    {
        const node = await this.Locate(publicId);
        return node === undefined ? undefined : { Concept: node.Concept, Owner: await this.ids.OwnerOf(this.txn, node.Id) };
    }

    public async OutEdges(publicId: string): Promise<readonly ISeedEdge[]>
    {
        const node = await this.Locate(publicId);
        if (node === undefined)
        {
            return [];
        }
        const out: ISeedEdge[] = [];
        for (const rel of this.index.Catalog.EffectiveMembers(node.Concept).filter(m => m.Kind === MemberKind.Relationship))
        {
            for await (const edge of this.edges.Neighbors(this.txn, rel, node.Id, EdgeDirection.Out))
            {
                const to = await this.ids.PublicIdOf(this.txn, edge.Node);
                if (to === undefined)
                {
                    throw new GraphError(GraphErrorCode.Corrupt, TransactionSeedView.ErrCorrupt + edge.Node);
                }
                out.push({ Relationship: rel.Name, To: to, Properties: edge.Properties });
            }
        }
        return out;
    }

    public async Properties(publicId: string): Promise<ReadonlyMap<string, CellValue>>
    {
        const out = new Map<string, CellValue>();
        const node = await this.Locate(publicId);
        if (node === undefined)
        {
            return out;
        }
        const location = await this.rows.Locate(this.txn, node.Id);
        if (location === undefined)
        {
            throw new GraphError(GraphErrorCode.Corrupt, TransactionSeedView.ErrCorrupt + publicId);
        }
        for (const member of this.index.Catalog.EffectiveMembers(node.Concept).filter(m => m.Kind === MemberKind.Property))
        {
            out.set(member.Name, await this.columns.ReadCell(this.txn, location, member));
        }
        return out;
    }

    private async Locate(publicId: string): Promise<{ readonly Id: bigint; readonly Concept: string } | undefined>
    {
        const id = await this.ids.Resolve(this.txn, publicId);
        if (id === undefined)
        {
            return undefined;
        }
        const location = await this.rows.Locate(this.txn, id);
        const concept = location === undefined ? undefined : this.index.ConceptOf(location.TypeId);
        if (concept === undefined)
        {
            throw new GraphError(GraphErrorCode.Corrupt, TransactionSeedView.ErrCorrupt + publicId);
        }
        return { Id: id, Concept: concept };
    }
}
