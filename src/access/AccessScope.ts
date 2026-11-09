import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
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
     * Members (properties and relationships) the writer may not set, remove, link or unlink on the instances,
     * per operation (AccessError MemberReadOnly, ruling R92). They stay readable. Values a host places as
     * defaults on a node the batch creates (GraphTransaction.SetDefault) are exempt.
     */
    readonly ReadOnly?: IReadOnlyMembers;
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
    private static readonly ErrReadOnlyShape = 'AccessScope Writes ReadOnly must be { Create?, Update? } of Sets: ';
    private static readonly ErrReadOnlySet = 'AccessScope Writes ReadOnly stage must be a Set: ';
    private static readonly CreateStage = 'Create';
    private static readonly UpdateStage = 'Update';
    private static readonly Dot = '.';
    private static readonly NoRows: ReadonlyMap<string, Predicate> = new Map();
    private static readonly NoHidden: ReadonlyMap<string, ReadonlySet<string>> = new Map();
    private static readonly NoWrites: ReadonlyMap<string, IWriteRules> = new Map();

    /** Everything visible, nothing hidden, every write allowed; reads under it do no evaluator work. */
    public static readonly System: AccessScope = new AccessScope(AccessDefault.Allow, AccessScope.NoRows, AccessScope.NoHidden, AccessScope.NoWrites);

    public readonly Default: AccessDefault;
    public readonly Rows: ReadonlyMap<string, Predicate>;
    public readonly Hidden: ReadonlyMap<string, ReadonlySet<string>>;
    public readonly Writes: ReadonlyMap<string, IWriteRules>;

    private constructor(fallback: AccessDefault, rows: ReadonlyMap<string, Predicate>, hidden: ReadonlyMap<string, ReadonlySet<string>>, writes: ReadonlyMap<string, IWriteRules>)
    {
        this.Default = fallback;
        this.Rows = rows;
        this.Hidden = hidden;
        this.Writes = writes;
        Object.freeze(this);
    }

    /**
     * A scope from `options` (maps and sets copied). GraphError InvalidArgument for an unknown Default or a Writes
     * ReadOnly that is not `{ Create?, Update? }` of Sets.
     */
    public static Build(options: IAccessScopeOptions): AccessScope
    {
        if (options.Default !== AccessDefault.Allow && options.Default !== AccessDefault.Deny)
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, AccessScope.ErrDefault + String(options.Default));
        }
        const hidden = new Map<string, ReadonlySet<string>>();
        for (const [name, members] of options.Hidden ?? AccessScope.NoHidden)
        {
            hidden.set(name, new Set(members));
        }
        const writes = new Map<string, IWriteRules>();
        for (const [name, rules] of options.Writes ?? AccessScope.NoWrites)
        {
            const copy: IWriteRules = rules.ReadOnly === undefined ? { ...rules } : { ...rules, ReadOnly: AccessScope.CopyReadOnly(name, rules.ReadOnly) };
            writes.set(name, Object.freeze(copy));
        }
        return new AccessScope(options.Default, new Map(options.Rows ?? AccessScope.NoRows), hidden, writes);
    }

    /**
     * A frozen copy of `name`'s `readOnly`, each present set copied. GraphError InvalidArgument when it is a Set
     * (the pre-R92-amendment shape) or a present Create/Update is not a Set.
     */
    private static CopyReadOnly(name: string, readOnly: IReadOnlyMembers): IReadOnlyMembers
    {
        if (readOnly instanceof Set || typeof readOnly !== 'object' || readOnly === null)
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, AccessScope.ErrReadOnlyShape + name);
        }
        const copy: { Create?: ReadonlySet<string>; Update?: ReadonlySet<string> } = {};
        if (readOnly.Create !== undefined)
        {
            copy.Create = AccessScope.CopySet(name, AccessScope.CreateStage, readOnly.Create);
        }
        if (readOnly.Update !== undefined)
        {
            copy.Update = AccessScope.CopySet(name, AccessScope.UpdateStage, readOnly.Update);
        }
        return Object.freeze(copy);
    }

    private static CopySet(name: string, stage: string, members: ReadonlySet<string>): ReadonlySet<string>
    {
        if (!(members instanceof Set))
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, AccessScope.ErrReadOnlySet + name + AccessScope.Dot + stage);
        }
        return new Set(members);
    }

    /**
     * @internal True iff reads need no evaluation: Default Allow, no Rows and no Hidden entries
     * (System, or any scope built that way). Readers then skip the evaluator entirely.
     */
    public get ReadsUnrestricted(): boolean
    {
        return this.Default === AccessDefault.Allow && this.Rows.size === 0 && this.Hidden.size === 0;
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
