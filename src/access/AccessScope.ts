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

    /** A scope from `options` (maps and sets copied). GraphError InvalidArgument for an unknown Default. */
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
            writes.set(name, Object.freeze({ ...rules }));
        }
        return new AccessScope(options.Default, new Map(options.Rows ?? AccessScope.NoRows), hidden, writes);
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
