import type { CatalogSnapshot } from '../catalog/CatalogSnapshot.js';
import { MemberKind } from '../catalog/ValueType.js';
import type { CellValue } from '../columns/CellValue.js';
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
import type { ISeedNode } from './SchemaDescription.js';
import { SeedHash } from './SeedHash.js';

/** What the synchronizer needs to know about the stored graph (post-purge, inside the upgrade's write). */
export interface ISeedView
{
    Resolve(publicId: string): Promise<{ readonly Concept: string; readonly Owner: string } | undefined>;
    /** Every out-edge of the node over its concept's relationships, per relationship in edge order. */
    OutEdges(publicId: string): Promise<readonly { readonly Relationship: string; readonly To: string }[]>;
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

/** How one seed node is applied. */
enum SeedAction
{
    /** Present, seeded, same hash: left alone (runtime edits survive). */
    Keep = 0,
    /** Absent: created. */
    Create = 1,
    /** Present with another concept: deleted and created again. */
    Recreate = 2,
    /** Present with the same concept: properties and out-edges replaced. */
    Overwrite = 3,
}

interface ISeedStep
{
    readonly Node: ISeedNode;
    readonly Action: SeedAction;
    readonly Hash: Uint8Array;
}

/**
 * Seed synchronization (spec 4.3, "seed wins for seeded nodes"): turns the description's seed into one
 * WriteBatch against the store as it is after the upgrade's purge. A node absent from the store is
 * created (with its owner) and given its properties and links; a node seeded with the same hash is left
 * alone; any other present node (a different hash, or a runtime node that has the seed's id) is
 * overwritten: every effective property set (absent ones to null; a non-nullable absent one is
 * MissingRequired), every out-edge removed and the seed links re-added in seed order. Its owner must
 * match (owner is create-time: InvalidValue otherwise); a node whose concept differs is deleted and
 * created again. Previously seeded ids missing from the seed are deleted. Creates come before property
 * sets and links, so links may point at seed nodes later in the array.
 */
export class SeedSynchronizer
{
    private static readonly ErrDuplicate = 'Seed lists the public id twice: ';
    private static readonly ErrOwner = 'Seed owner differs from the stored node owner (owner is fixed at creation): ';
    private static readonly ErrRequired = 'Seed lacks a value for a required property: ';
    private static readonly Dot = '.';

    public constructor(private readonly catalog: CatalogSnapshot)
    {
    }

    /**
     * The read-only pre-pass (ruling R16: ids are allocated outside the write): the public ids of every
     * seed node that may need a fresh internal id, i.e. absent from the view or not seeded with the same hash.
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

    public async Build(view: ISeedView, seed: readonly ISeedNode[], storedHashes: ReadonlyMap<string, Uint8Array>): Promise<ISeedPlan>
    {
        const steps: ISeedStep[] = [];
        for (const node of SeedSynchronizer.Validated(seed))
        {
            steps.push(await this.Classify(view, node, storedHashes));
        }
        const seeded = new Set(seed.map(n => n.PublicId));
        const removed = [...storedHashes.keys()].filter(id => !seeded.has(id));
        const batch = new WriteBatch();
        for (const step of steps.filter(s => s.Action === SeedAction.Overwrite))
        {
            for (const edge of await view.OutEdges(step.Node.PublicId))
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
            this.SetProperties(batch, step);
        }
        const hashes = new Map<string, Uint8Array>();
        for (const step of steps.filter(s => s.Action !== SeedAction.Keep))
        {
            for (const link of step.Node.Links)
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
        if (present.Concept !== node.Concept)
        {
            return { Node: node, Action: SeedAction.Recreate, Hash: hash };
        }
        if (present.Owner !== node.Owner)
        {
            throw new CommitError(CommitErrorCode.InvalidValue, SeedSynchronizer.ErrOwner + node.PublicId);
        }
        return { Node: node, Action: SeedAction.Overwrite, Hash: hash };
    }

    /** The seed's properties; an overwritten node also has every other effective property nulled. */
    private SetProperties(batch: WriteBatch, step: ISeedStep): void
    {
        const node = step.Node;
        for (const [name, value] of Object.entries(node.Properties))
        {
            batch.SetProperty(node.PublicId, name, value as CellValue);
        }
        if (step.Action !== SeedAction.Overwrite)
        {
            return;
        }
        for (const member of this.catalog.EffectiveMembers(node.Concept))
        {
            if (member.Kind !== MemberKind.Property || Object.hasOwn(node.Properties, member.Name))
            {
                continue;
            }
            if (!member.Nullable)
            {
                throw new CommitError(CommitErrorCode.MissingRequired, SeedSynchronizer.ErrRequired + node.PublicId + SeedSynchronizer.Dot + member.Name);
            }
            batch.SetProperty(node.PublicId, member.Name, null);
        }
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
    )
    {
    }

    public async Resolve(publicId: string): Promise<{ readonly Concept: string; readonly Owner: string } | undefined>
    {
        const node = await this.Locate(publicId);
        return node === undefined ? undefined : { Concept: node.Concept, Owner: await this.ids.OwnerOf(this.txn, node.Id) };
    }

    public async OutEdges(publicId: string): Promise<readonly { readonly Relationship: string; readonly To: string }[]>
    {
        const node = await this.Locate(publicId);
        if (node === undefined)
        {
            return [];
        }
        const out: Array<{ readonly Relationship: string; readonly To: string }> = [];
        for (const rel of this.index.Catalog.EffectiveMembers(node.Concept).filter(m => m.Kind === MemberKind.Relationship))
        {
            for await (const edge of this.edges.Adjacent(this.txn, rel, node.Id, EdgeDirection.Out))
            {
                const to = await this.ids.PublicIdOf(this.txn, edge.Node);
                if (to === undefined)
                {
                    throw new GraphError(GraphErrorCode.Corrupt, TransactionSeedView.ErrCorrupt + edge.Node);
                }
                out.push({ Relationship: rel.Name, To: to });
            }
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
