import type { MemberDef } from '../catalog/CatalogTypes.js';
import { MemberKind } from '../catalog/ValueType.js';
import type { CellValue } from '../columns/CellValue.js';
import type { BindingTable } from '../connectors/BindingTable.js';
import type { IFetchTarget, IFetchedRow } from '../connectors/FetchContract.js';
import type { FetchSession, IFetchScope } from '../connectors/FetchSession.js';
import { EdgeDirection } from '../format/FormatKeys.js';
import { FederatedReads, type IFederatedLink } from '../FederatedReads.js';
import type { GraphReader, ILinkView, IReadProbe } from '../GraphReader.js';
import { And, Compare, CompareOp, Or, Predicate, PredicateKind } from '../predicate/Predicate.js';
import { PredicateCodec } from '../predicate/PredicateCodec.js';
import { CatalogSource } from './CatalogSource.js';
import { RelDirection } from './CypherEnums.js';
import { CypherSemanticError } from './CypherError.js';
import { CypherNode } from './CypherNode.js';
import type { IExpandRow } from './CypherSource.js';
import type { ReaderSource } from './ReaderSource.js';
import { ScalarSemantics } from './ScalarSemantics.js';

/** An external node this query fetched and the scope admitted: the admitted row (hidden members removed) and its model. */
interface IAdmittedRow
{
    readonly Row: IFetchedRow;
    readonly Owner: string;
}

/**
 * ICypherSource for a read over engine data and External connectors (ruling R101): the scoped ReaderSource unioned with
 * one FetchSession (one per Execute, so nothing external outlives the query). Engine nodes come from the reader as
 * before; a stub never surfaces as engine data. External rows are fetched through the session, pass
 * GraphReader.AdmitFetched (validation, the scope in Kleene logic, hidden members removed) and become CypherNodes owned by
 * the fetch target's model, with every visible property of their concept (null when the row has no value).
 *
 * Fetches (design ruling D4, push-down advisory): a scan of a label fetches each BindingTable.ExternalTargets target with
 * Predicate And(scope, hint). The scope part is GraphReader.FetchPredicate of the target concept, or the Or of it over the
 * target concept and its subtypes when they differ (a fetch of a concept also returns its subtypes' rows, which their own
 * Rows entries decide). The hint part keeps only the terms whose members are properties of the target concept that the
 * scope hides on none of the fetched concepts (a hidden member reads null in the query, so its true value must not narrow
 * the fetch). Members are chosen by the session (FetchSession: every property of the target concept's family, hidden
 * ones included; the scope may rule on a hidden member, and AdmitFetched removes it).
 *
 * Node(id): an engine node as is; a stub resolved through a key lookup restricted to the stub's owner model (undefined
 * when dangling); a node fetched in this query; else undefined. Two models claiming one public id: the first admitted
 * owner is the one Node and Expand see (R98). Links of an engine node come from FederatedReads.Links, stubs resolved as
 * Node does and dangling ones omitted. Links of an external node are its row's Links in relationship declaration order,
 * each target resolved as Node does, or else (an id neither stored nor fetched) through a key lookup of the External
 * targets of the relationship's target concepts, the row's own model first, then every other model in model order (spec
 * §5.4). Incoming edges are the engine edges into the node (or into its stub) plus FetchSession.Reverse over every
 * External target of each concept or aspect declaring an incoming relationship (a reverse lookup, or a scan under the
 * scope for a connector without ReverseLookup); a reverse row counts only when its admitted Links hold the edge.
 * Fallback scans and key-less lookups push the scope down through IFetchScope (RowPredicate).
 */
export class FederatedSource extends CatalogSource implements IFetchScope
{
    private static readonly UnknownDirection = 'unknown relationship direction';
    private static readonly StepSeparator = '\u0000';
    private static readonly AnyRelationship = '';

    private readonly fetched = new Map<string, IAdmittedRow>();
    private readonly scopes = new Map<string, Predicate>();
    private readonly incoming = new Map<string, readonly MemberDef[]>();
    private declared: readonly MemberDef[] | undefined;
    private readonly reads: FederatedReads;

    constructor(private readonly base: ReaderSource, private readonly reader: GraphReader, private readonly session: FetchSession, bindings: BindingTable)
    {
        super(reader.Catalog, reader.Scope.HiddenNames, bindings, session.ConnectorNames);
        this.reads = FederatedReads.Of(reader);
    }

    public async *ScanLabel(label: string, probe?: IReadProbe, hint?: Predicate): AsyncIterable<CypherNode>
    {
        const name = this.labels.Resolve(label);
        yield* this.EngineNodes(this.base.ScanLabel(name, probe));
        for (const target of this.FetchTargets(name))
        {
            yield* this.Fetch(target, hint, probe);
        }
    }

    /** Per root concept in definition order: its engine nodes, then its External fetches. */
    public async *ScanAll(probe?: IReadProbe): AsyncIterable<CypherNode>
    {
        for (const root of this.RootConcepts())
        {
            yield* this.EngineNodes(this.base.ScanLabel(root, probe));
            for (const target of this.FetchTargets(root))
            {
                yield* this.Fetch(target, undefined, probe);
            }
        }
    }

    /**
     * Per id, in the ids' order: an engine node, a stub resolved through its owner, or a row this query already fetched;
     * the ids left over are looked up in one go (FetchSession.LookupMany: one keyed request per External target of the
     * label) and admitted under the scope, so an id the scope hides yields nothing, as in a label scan. Without a label
     * nothing is fetched. Nodes that are not the label are dropped.
     */
    public async *NodesById(ids: readonly string[], label: string | undefined, probe?: IReadProbe): AsyncIterable<CypherNode>
    {
        const name = label === undefined ? undefined : this.labels.Resolve(label);
        const order = [...new Set(ids)];
        const found = new Map<string, CypherNode>();
        const pending: string[] = [];
        for (const id of order)
        {
            probe?.Tick();
            const located = await this.Locate(id, probe);
            if (located.Node !== undefined)
            {
                found.set(id, located.Node);
            }
            else if (located.Unresolved && !await this.reads.StoredNonStub(id))
            {
                // An id no node answers for: only now may a connector be asked. An engine node, visible or not, owns its id (D2).
                pending.push(id);
            }
        }
        if (name !== undefined && pending.length > 0)
        {
            const entries = await this.session.LookupMany(pending, this.FetchTargets(name), probe, this);
            for (const [id, entry] of entries)
            {
                const admitted = await this.Admit(entry.Row, entry.Model);
                if (admitted !== undefined)
                {
                    found.set(id, admitted);
                }
            }
        }
        for (const id of order)
        {
            const node = found.get(id);
            if (node !== undefined && (name === undefined || this.catalog.IsA(node.Concept, name)))
            {
                yield node;
            }
        }
    }

    public Node(publicId: string): Promise<CypherNode | undefined>
    {
        return this.NodeOf(publicId, undefined);
    }

    /** Node, with the probe a lookup it needs ticks (per page and per row). */
    private async NodeOf(publicId: string, probe: IReadProbe | undefined): Promise<CypherNode | undefined>
    {
        return (await this.Locate(publicId, probe)).Node;
    }

    /**
     * What is known of the id without asking a connector for it: an engine node, a stub resolved through its owner, or a
     * row this query fetched. Unresolved: none of these answered (the id may be a hidden engine node or an unfetched row).
     */
    private async Locate(publicId: string, probe: IReadProbe | undefined): Promise<{ readonly Node?: CypherNode; readonly Unresolved: boolean }>
    {
        const node = await this.base.Node(publicId);
        if (node !== undefined && !this.IsStub(node.Owner, node.Concept))
        {
            return { Node: node, Unresolved: false };
        }
        const stub = node !== undefined ? { Concept: node.Concept, Owner: node.Owner } : await this.reads.StubIdentity(publicId);
        if (stub !== undefined)
        {
            const resolved = await this.Resolve(publicId, stub.Concept, stub.Owner, probe);
            return resolved === undefined ? { Unresolved: false } : { Node: resolved, Unresolved: false };
        }
        const known = this.fetched.get(publicId);
        return known === undefined ? { Unresolved: true } : { Node: this.ToNode(known), Unresolved: false };
    }

    /** Outgoing, Incoming, or both with each (relationship, far node) pair once, as ReaderSource.Expand. */
    public async *Expand(publicId: string, relationship: string | undefined, direction: RelDirection, probe?: IReadProbe): AsyncIterable<IExpandRow>
    {
        switch (direction)
        {
            case RelDirection.Outgoing:
                yield* this.Out(publicId, relationship, probe);
                return;
            case RelDirection.Incoming:
                yield* this.In(publicId, relationship, probe, new Set());
                return;
            case RelDirection.Undirected:
            {
                const seen = new Set<string>();
                for await (const row of this.Out(publicId, relationship, probe))
                {
                    if (FederatedSource.FirstTime(seen, row.Relationship, row.Target.PublicId))
                    {
                        yield row;
                    }
                }
                yield* this.In(publicId, relationship, probe, seen);
                return;
            }
        }
        throw new CypherSemanticError(`${FederatedSource.UnknownDirection} "${String(direction)}"`);
    }

    public async OutLinks(publicId: string): Promise<readonly ILinkView[]>
    {
        const links: ILinkView[] = [];
        for await (const row of this.Out(publicId, undefined, undefined))
        {
            links.push({ Relationship: row.Relationship, PublicId: row.Target.PublicId });
        }
        return links;
    }

    public override IndexFor(label: string, member: string): string | undefined
    {
        return this.base.IndexFor(label, member);
    }

    /**
     * The base seek (undefined when it has no index), then the label's External fetches with the hint
     * And(Compare(member, Eq, value), anchor hint), each fetched node kept only when its member equals the value as the
     * `=` filter decides (the connector may ignore the hint; the anchor's other filters stay in the plan).
     */
    public SeekEqual(label: string, member: string, value: CellValue, probe?: IReadProbe, hint?: Predicate): AsyncIterable<CypherNode> | undefined
    {
        const hits = this.base.SeekEqual(label, member, value, probe);
        return hits === undefined ? undefined : this.MergedSeek(hits, this.labels.Resolve(label), member, value, probe, hint);
    }

    private async *MergedSeek(hits: AsyncIterable<CypherNode>, label: string, member: string, value: CellValue, probe: IReadProbe | undefined, anchor: Predicate | undefined): AsyncIterable<CypherNode>
    {
        yield* this.EngineNodes(hits);
        if (value === null)
        {
            return;
        }
        const equality = new Compare(member, CompareOp.Eq, value);
        const hint = anchor === undefined ? equality : new And([equality, anchor]);
        for (const target of this.FetchTargets(label))
        {
            for await (const node of this.Fetch(target, hint, probe))
            {
                const actual = node.Properties.get(member) ?? null;
                if (actual !== null && ScalarSemantics.Equals(actual, value))
                {
                    yield node;
                }
            }
        }
    }

    private async *EngineNodes(nodes: AsyncIterable<CypherNode>): AsyncIterable<CypherNode>
    {
        for await (const node of nodes)
        {
            if (!this.IsStub(node.Owner, node.Concept))
            {
                yield node;
            }
        }
    }

    private async *Fetch(target: IFetchTarget, hint: Predicate | undefined, probe: IReadProbe | undefined): AsyncIterable<CypherNode>
    {
        const predicate = new And([this.ScopePredicate(target.Concept), this.UsableHint(hint, target.Concept) ?? Predicate.True]);
        for await (const row of this.session.Scan(target, predicate, probe))
        {
            const node = await this.Admit(row, target.Model);
            if (node !== undefined)
            {
                yield node;
            }
        }
    }

    /** The external node behind a stub (or a link target) of `owner`: memoised per query, undefined when dangling or not visible. */
    private async Resolve(publicId: string, concept: string, owner: string, probe: IReadProbe | undefined): Promise<CypherNode | undefined>
    {
        const known = this.fetched.get(publicId);
        if (known !== undefined && known.Owner === owner)
        {
            return this.ToNode(known);
        }
        const candidates = this.catalog.Has(concept) ? this.FetchTargets(concept).filter(t => t.Model === owner) : [];
        return this.LookUp(publicId, candidates, probe);
    }

    /** The first candidate's row of the id (FetchSession.Lookup), admitted as a node of the model it was fetched for. */
    private async LookUp(publicId: string, candidates: readonly IFetchTarget[], probe: IReadProbe | undefined): Promise<CypherNode | undefined>
    {
        if (candidates.length === 0)
        {
            return undefined;
        }
        const entry = await this.session.Lookup(publicId, candidates, probe, this);
        return entry === undefined ? undefined : this.Admit(entry.Row, entry.Model);
    }

    /** IFetchScope: the scope's row predicate for a fetch of the concept (ScopePredicate), what fallback scans push down. */
    public RowPredicate(concept: string): Predicate
    {
        return this.ScopePredicate(concept);
    }

    /**
     * The row as this reader may see it, recorded for Node and Expand; undefined when the scope does not admit it, and
     * also, silently, when a stored engine node that is not a stub has its public id (visible or not, so nothing about
     * a hidden node is revealed): the engine-resident node owns its id (design ruling D2). That check records the id
     * read, so a transaction conflicts with a commit that creates or removes such a node.
     */
    private async Admit(row: IFetchedRow, owner: string): Promise<CypherNode | undefined>
    {
        const entry = await this.AdmitEntry(row, owner);
        return entry === undefined ? undefined : this.ToNode(entry);
    }

    /** Admit's admitted row and owner (this row's, not necessarily the first admitted one of its id). */
    private async AdmitEntry(row: IFetchedRow, owner: string): Promise<IAdmittedRow | undefined>
    {
        if (await this.reads.StoredNonStub(row.PublicId))
        {
            return undefined;
        }
        const admitted = await this.reader.AdmitFetched(row, owner);
        if (admitted === undefined)
        {
            return undefined;
        }
        const entry = { Row: admitted, Owner: owner };
        // Two models claiming one public id: the first admitted owner is the one Node(id) and Expand see (R98).
        if (!this.fetched.has(admitted.PublicId))
        {
            this.fetched.set(admitted.PublicId, entry);
        }
        return entry;
    }

    /** A fresh CypherNode for the admitted row: every visible property of its concept, null when the row has none. */
    private ToNode(entry: IAdmittedRow): CypherNode
    {
        const row = entry.Row;
        const hidden = this.reader.HiddenMembers(row.Concept);
        const properties = new Map<string, CellValue>();
        for (const def of this.catalog.EffectiveMembers(row.Concept))
        {
            if (def.Kind === MemberKind.Property && !hidden.has(def.Name))
            {
                properties.set(def.Name, row.Values.get(def.Name) ?? null);
            }
        }
        return new CypherNode(row.PublicId, row.Concept, entry.Owner, properties);
    }

    private async *Out(publicId: string, relationship: string | undefined, probe: IReadProbe | undefined): AsyncIterable<IExpandRow>
    {
        const external = this.fetched.get(publicId);
        if (external === undefined)
        {
            for (const link of await this.reads.Links(publicId, EdgeDirection.Out, relationship, probe))
            {
                const target = await this.LinkedNode(link, probe);
                if (target !== undefined)
                {
                    yield { Relationship: link.Relationship, Target: target };
                }
            }
            return;
        }
        const row = external.Row;
        for (const def of this.catalog.EffectiveMembers(row.Concept))
        {
            if (def.Kind !== MemberKind.Relationship || (relationship !== undefined && def.Name !== relationship))
            {
                continue;
            }
            for (const id of row.Links.get(def.Name) ?? [])
            {
                probe?.Tick();
                const target = await this.LinkTarget(id, def, external.Owner, probe);
                if (target !== undefined)
                {
                    yield { Relationship: def.Name, Target: target };
                }
            }
        }
    }

    /** An engine edge's far node: a stub resolved through its connector, any other node read from the engine. */
    private LinkedNode(link: IFederatedLink, probe: IReadProbe | undefined): Promise<CypherNode | undefined>
    {
        return link.Stub === undefined ? this.base.Node(link.PublicId) : this.Resolve(link.PublicId, link.Stub.Concept, link.Stub.Owner, probe);
    }

    /**
     * The far node of an external row's link: as Node, else a key lookup of the External targets of the relationship's
     * target concepts, those of the row's own model first, then those of every other model in model order (spec §5.4,
     * final review I6).
     */
    private async LinkTarget(publicId: string, relationship: MemberDef, owner: string, probe: IReadProbe | undefined): Promise<CypherNode | undefined>
    {
        const node = await this.NodeOf(publicId, probe);
        if (node !== undefined || this.fetched.has(publicId))
        {
            return node;
        }
        const own: IFetchTarget[] = [];
        const others: IFetchTarget[] = [];
        for (const concept of relationship.Targets ?? [])
        {
            for (const target of this.FetchTargets(concept))
            {
                const into = target.Model === owner ? own : others;
                if (!into.some(c => c.Model === target.Model && c.Concept === target.Concept && c.Connector === target.Connector))
                {
                    into.push(target);
                }
            }
        }
        others.sort((a, b) => (a.Model < b.Model ? -1 : a.Model > b.Model ? 1 : 0));
        return this.LookUp(publicId, [...own, ...others], probe);
    }

    private async *In(publicId: string, relationship: string | undefined, probe: IReadProbe | undefined, seen: Set<string>): AsyncIterable<IExpandRow>
    {
        const external = this.fetched.get(publicId);
        const concept = external?.Row.Concept ?? (await this.reader.ConceptOf(publicId));
        if (concept === undefined)
        {
            return;
        }
        for (const link of await this.reads.Links(publicId, EdgeDirection.In, relationship, probe, external?.Owner))
        {
            const source = await this.LinkedNode(link, probe);
            if (source !== undefined && FederatedSource.FirstTime(seen, link.Relationship, source.PublicId))
            {
                yield { Relationship: link.Relationship, Target: source };
            }
        }
        for (const def of this.Incoming(concept, relationship))
        {
            for (const target of this.FetchTargets(def.DeclaredBy))
            {
                for await (const row of this.session.Reverse(target, def.Name, publicId, this.ScopePredicate(target.Concept), probe))
                {
                    // The row just admitted decides the edge (not the id's first admitted row, which may be another model's).
                    const admitted = await this.AdmitEntry(row, target.Model);
                    if (admitted === undefined || !(admitted.Row.Links.get(def.Name) ?? []).includes(publicId))
                    {
                        continue;
                    }
                    if (FederatedSource.FirstTime(seen, def.Name, admitted.Row.PublicId))
                    {
                        yield { Relationship: def.Name, Target: this.ToNode(admitted) };
                    }
                }
            }
        }
    }

    /** Declared relationships (named `relationship` when given) whose targets accept `concept`, in catalog order. */
    private Incoming(concept: string, relationship: string | undefined): readonly MemberDef[]
    {
        const key = concept + FederatedSource.StepSeparator + (relationship ?? FederatedSource.AnyRelationship);
        let found = this.incoming.get(key);
        if (found === undefined)
        {
            this.declared ??= this.catalog.Definitions().flatMap(d => d.Members.filter(m => m.Kind === MemberKind.Relationship));
            found = this.declared.filter(m => (relationship === undefined || m.Name === relationship) && (m.Targets ?? []).some(t => this.catalog.Has(t) && this.catalog.IsA(concept, t)));
            this.incoming.set(key, found);
        }
        return found;
    }

    /** True when the stored node (owner, concept) is a stub: its data lives in an External connector. */
    private IsStub(owner: string, concept: string): boolean
    {
        return this.bindings.IsStub(owner, concept, this.catalog, this.external);
    }

    /** The scope's row predicate for a fetch of the concept: FetchPredicate of each family member, Or'ed when they differ. */
    private ScopePredicate(concept: string): Predicate
    {
        let predicate = this.scopes.get(concept);
        if (predicate === undefined)
        {
            const distinct = new Map<string, Predicate>();
            for (const name of this.bindings.Family(concept, this.catalog))
            {
                const p = this.reader.FetchPredicate(name);
                distinct.set(JSON.stringify(PredicateCodec.ToJson(p)), p);
            }
            const terms = [...distinct.values()];
            predicate = terms.some(t => t.Kind === PredicateKind.True) ? Predicate.True : terms.length === 1 ? terms[0]! : new Or(terms);
            this.scopes.set(concept, predicate);
        }
        return predicate;
    }

    /** The hint's terms over properties of the concept that no family member hides; undefined when none remain. */
    private UsableHint(hint: Predicate | undefined, concept: string): Predicate | undefined
    {
        if (hint === undefined)
        {
            return undefined;
        }
        const properties = new Set(this.catalog.EffectiveMembers(concept).filter(m => m.Kind === MemberKind.Property).map(m => m.Name));
        const family = this.bindings.Family(concept, this.catalog);
        const usable = (hint.Kind === PredicateKind.And ? (hint as And).Terms : [hint]).filter(term =>
            [...Predicate.MemberNames(term)].every(name => properties.has(name) && !family.some(c => this.reader.HiddenMembers(c).has(name))));
        if (usable.length === 0)
        {
            return undefined;
        }
        return usable.length === 1 ? usable[0] : new And(usable);
    }

    private static FirstTime(seen: Set<string>, relationship: string, publicId: string): boolean
    {
        const key = relationship + FederatedSource.StepSeparator + publicId;
        if (seen.has(key))
        {
            return false;
        }
        seen.add(key);
        return true;
    }
}
