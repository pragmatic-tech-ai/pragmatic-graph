import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import { FrozenNameSet } from './FrozenNameSet.js';
import type { Predicate } from '../predicate/Predicate.js';

/** What a scope grants a node none of whose concept, ancestors or carried aspects has a Rows entry. */
export enum AccessDefault
{
    Allow = 1,
    Deny = 2,
}

/** Per concept or aspect write rules (enforced by commits, not by reads). */
export interface IWriteRules
{
    readonly Create?: Predicate;
    readonly Update?: Predicate;
    readonly Delete?: Predicate;
    /**
     * Link and Unlink: holds on the edge's SOURCE node (pre-batch values), instead of Update, which now governs
     * SetProperty only (spec section 5, ruling R129). A node the batch created and a delete-implied unlink are exempt.
     */
    readonly Append?: Predicate;
    /** Link and Unlink: holds on the edge's TARGET node (pre-batch values); the same exemptions as Append. */
    readonly AppendTo?: Predicate;
    /**
     * Members (properties and relationships) the writer may not set, remove, link or unlink on the instances,
     * per operation (AccessError MemberReadOnly, ruling R92). They stay readable. Values a host places as
     * defaults on a node the batch creates (GraphTransaction.SetDefault) are exempt.
     */
    readonly ReadOnly?: IReadOnlyMembers;
    /**
     * As ReadOnly, but only on nodes whose own concept is exactly the entry's key: not its subconcepts, and never
     * through an aspect (an aspect key with ReadOnlyExact is refused by validation, ruling R94). Checked beside
     * ReadOnly, with the same per-stage meaning and the same exemptions (placement defaults, DETACH-implied unlinks).
     */
    readonly ReadOnlyExact?: IReadOnlyMembers;
}

/** Read-only members of one Writes entry, per operation (ruling R92). */
export interface IReadOnlyMembers
{
    /** Checked on a write to a node the batch created and that is live at the op. */
    readonly Create?: ReadonlySet<string>;
    /** Checked on a write to a node that exists in the snapshot (not created by the batch, or no longer live). */
    readonly Update?: ReadonlySet<string>;
}

export interface IAccessScopeOptions
{
    /** For nodes with no applicable Rows entry. */
    readonly Default: AccessDefault;
    /** Key: a concept or aspect name. A node is visible iff every applicable predicate holds. */
    readonly Rows?: ReadonlyMap<string, Predicate>;
    /** Key: a concept or aspect name; value: member names that read as hidden on its instances. */
    readonly Hidden?: ReadonlyMap<string, ReadonlySet<string>>;
    /**
     * Key: a concept name (never an aspect); value: member names that read as hidden on nodes whose own concept is
     * exactly the key, not on its subconcepts (ruling R94). A node's hidden members are the union of every applicable
     * Hidden entry and its own concept's HiddenExact entry; everything Hidden governs, HiddenExact governs too.
     */
    readonly HiddenExact?: ReadonlyMap<string, ReadonlySet<string>>;
    /** Key: a concept or aspect name. */
    readonly Writes?: ReadonlyMap<string, IWriteRules>;
}

/**
 * What one reader or transaction may see and write, declared in engine terms only (concepts, aspects,
 * members, predicates): the engine knows nothing about who the scope is for (spec section 7). Decided
 * outside, enforced inside: every GraphReader and GraphTransaction carries one. Immutable; Build copies
 * its maps. Every name must be known to the catalog a reader opens on, including the names its
 * predicates read (GraphStore.BeginRead and Begin validate it with ScopeValidator, ruling R63).
 */
export class AccessScope
{
    private static readonly ErrDefault = 'AccessScope Default must be an AccessDefault: ';
    private static readonly ErrReadOnlyShape = ' must be { Create?, Update? } of Sets: ';
    private static readonly ErrReadOnlySet = ' stage must be a Set: ';
    private static readonly ReadOnlyLabel = 'AccessScope Writes ReadOnly';
    private static readonly ReadOnlyExactLabel = 'AccessScope Writes ReadOnlyExact';
    private static readonly CreateStage = 'Create';
    private static readonly UpdateStage = 'Update';
    private static readonly Dot = '.';
    private static readonly NoRows: ReadonlyMap<string, Predicate> = new Map();
    private static readonly NoHidden: ReadonlyMap<string, ReadonlySet<string>> = new Map();
    private static readonly NoWrites: ReadonlyMap<string, IWriteRules> = new Map();

    /** Everything visible, nothing hidden, every write allowed; reads under it do no evaluator work. */
    public static readonly System: AccessScope = new AccessScope(AccessDefault.Allow, AccessScope.NoRows, AccessScope.NoHidden, AccessScope.NoHidden, AccessScope.NoWrites);

    public readonly Default: AccessDefault;
    public readonly Rows: ReadonlyMap<string, Predicate>;
    public readonly Hidden: ReadonlyMap<string, ReadonlySet<string>>;
    public readonly HiddenExact: ReadonlyMap<string, ReadonlySet<string>>;
    public readonly Writes: ReadonlyMap<string, IWriteRules>;
    /** Every member name some Hidden or HiddenExact entry hides, on any concept (see HiddenNames). */
    private readonly hiddenNames: FrozenNameSet;

    private constructor(fallback: AccessDefault, rows: ReadonlyMap<string, Predicate>, hidden: ReadonlyMap<string, ReadonlySet<string>>,
        hiddenExact: ReadonlyMap<string, ReadonlySet<string>>, writes: ReadonlyMap<string, IWriteRules>)
    {
        this.Default = fallback;
        this.Rows = rows;
        this.Hidden = hidden;
        this.HiddenExact = hiddenExact;
        this.Writes = writes;
        const names = new Set<string>();
        for (const map of [hidden, hiddenExact])
        {
            for (const members of map.values())
            {
                for (const member of members)
                {
                    names.add(member);
                }
            }
        }
        this.hiddenNames = new FrozenNameSet(names);
        Object.freeze(this);
    }

    /**
     * @internal Every member name some Hidden or HiddenExact entry hides, on any concept: what plan-time index choice
     * (CatalogSource) rules out, conservatively, without knowing which concepts a plan reaches. A frozen view: it
     * cannot be mutated, not even by casting away ReadonlySet.
     */
    public get HiddenNames(): ReadonlySet<string>
    {
        return this.hiddenNames;
    }

    /**
     * A scope from `options` (maps and sets copied). GraphError InvalidArgument for an unknown Default or a Writes
     * ReadOnly or ReadOnlyExact that is not `{ Create?, Update? }` of Sets.
     */
    public static Build(options: IAccessScopeOptions): AccessScope
    {
        if (options.Default !== AccessDefault.Allow && options.Default !== AccessDefault.Deny)
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, AccessScope.ErrDefault + String(options.Default));
        }
        const writes = new Map<string, IWriteRules>();
        for (const [name, rules] of options.Writes ?? AccessScope.NoWrites)
        {
            const copy: { -readonly [K in keyof IWriteRules]: IWriteRules[K] } = { ...rules };
            if (rules.ReadOnly !== undefined)
            {
                copy.ReadOnly = AccessScope.CopyReadOnly(AccessScope.ReadOnlyLabel, name, rules.ReadOnly);
            }
            if (rules.ReadOnlyExact !== undefined)
            {
                copy.ReadOnlyExact = AccessScope.CopyReadOnly(AccessScope.ReadOnlyExactLabel, name, rules.ReadOnlyExact);
            }
            writes.set(name, Object.freeze(copy));
        }
        return new AccessScope(options.Default, new Map(options.Rows ?? AccessScope.NoRows), AccessScope.CopyMembers(options.Hidden),
            AccessScope.CopyMembers(options.HiddenExact), writes);
    }

    /** A copy of a Hidden or HiddenExact map, each member set copied. */
    private static CopyMembers(source: ReadonlyMap<string, ReadonlySet<string>> | undefined): ReadonlyMap<string, ReadonlySet<string>>
    {
        const out = new Map<string, ReadonlySet<string>>();
        for (const [name, members] of source ?? AccessScope.NoHidden)
        {
            out.set(name, new Set(members));
        }
        return out;
    }

    /**
     * A frozen copy of `name`'s `readOnly` (its ReadOnly or ReadOnlyExact, named by `label`), each present set copied.
     * GraphError InvalidArgument when it is a Set (the pre-R92-amendment shape) or a present Create/Update is not a Set.
     */
    private static CopyReadOnly(label: string, name: string, readOnly: IReadOnlyMembers): IReadOnlyMembers
    {
        if (readOnly instanceof Set || typeof readOnly !== 'object' || readOnly === null)
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, label + AccessScope.ErrReadOnlyShape + name);
        }
        const copy: { Create?: ReadonlySet<string>; Update?: ReadonlySet<string> } = {};
        if (readOnly.Create !== undefined)
        {
            copy.Create = AccessScope.CopySet(label, name, AccessScope.CreateStage, readOnly.Create);
        }
        if (readOnly.Update !== undefined)
        {
            copy.Update = AccessScope.CopySet(label, name, AccessScope.UpdateStage, readOnly.Update);
        }
        return Object.freeze(copy);
    }

    private static CopySet(label: string, name: string, stage: string, members: ReadonlySet<string>): ReadonlySet<string>
    {
        if (!(members instanceof Set))
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, label + AccessScope.ErrReadOnlySet + name + AccessScope.Dot + stage);
        }
        return new Set(members);
    }

    /**
     * @internal True iff reads need no evaluation: Default Allow, no Rows, no Hidden and no HiddenExact entries
     * (System, or any scope built that way). Readers then skip the evaluator entirely.
     */
    public get ReadsUnrestricted(): boolean
    {
        return this.Default === AccessDefault.Allow && this.Rows.size === 0 && this.Hidden.size === 0 && this.HiddenExact.size === 0;
    }

    /**
     * @internal True iff no write needs checking: reads are unrestricted (every node visible, nothing
     * hidden) and there are no Writes entries. GraphTransaction.Commit then skips the WriteGate entirely.
     */
    public get WritesUnrestricted(): boolean
    {
        return this.ReadsUnrestricted && this.Writes.size === 0;
    }
}
