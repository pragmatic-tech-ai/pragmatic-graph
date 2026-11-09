import { CatalogError } from '../catalog/CatalogError.js';
import type { MemberDef } from '../catalog/CatalogTypes.js';
import { MemberKind } from '../catalog/ValueType.js';
import { GraphError, GraphErrorCode } from '../errors/GraphError.js';
import { EdgeDirection } from '../format/FormatKeys.js';
import type { And, Compare, ConceptIs, In, IsNull, Not, Or, Predicate, Reachable, Related } from '../predicate/Predicate.js';
import { PredicateKind } from '../predicate/Predicate.js';
import type { CatalogIndex } from '../txn/CatalogIndex.js';
import type { AccessScope } from './AccessScope.js';

/**
 * Where a scope predicate is evaluated: on the scope entry's key (top level), or on the concepts a
 * Related step can reach (inside a Target). A property or relationship name is valid on a key when it is
 * a member of the key (CatalogSnapshot.MemberOf), and on reached concepts when at least one has it.
 */
class Place
{
    public constructor(public readonly Label: string, public readonly Key: string | undefined, public readonly Concepts: readonly string[])
    {
    }
}

/**
 * Internal: checks an AccessScope's names against a catalog (ruling R63). Every Rows, Hidden and Writes
 * key must be a concept or aspect; every Hidden member and every Writes ReadOnly member (Create and Update) a member of its key;
 * every HiddenExact key and the key of every Writes entry with ReadOnlyExact a concept, never an aspect, and their
 * members members of that key (R94); every ConceptIs name a concept (R93); every property a Rows or
 * Writes predicate reads an effective property of its key (Related Targets: of a concept the step
 * reaches), and every relationship a Related or Reachable step follows an effective relationship
 * (parity with index Where, R61). Violations are GraphError InvalidArgument naming the key and name.
 */
export class ScopeValidator
{
    private static readonly ErrUnknownName = 'AccessScope names an unknown concept or aspect: ';
    private static readonly ErrUnknownMember = 'AccessScope hides a member that is not effective on its key: ';
    private static readonly ErrUnknownReadOnly = 'AccessScope marks read-only a member that is not effective on its key: ';
    private static readonly ErrProperty = 'AccessScope predicate reads a name that is not an effective property: ';
    private static readonly ErrRelationship = 'AccessScope predicate follows a name that is not an effective relationship: ';
    private static readonly ErrHiddenExactKey = 'AccessScope HiddenExact key is not a concept: ';
    private static readonly ErrReadOnlyExactKey = 'AccessScope Writes ReadOnlyExact key is not a concept: ';
    private static readonly ErrConceptIs = 'AccessScope predicate tests for a name that is not a concept: ';
    private static readonly ErrNoConcept = 'AccessScope predicate follows a relationship that reaches no concept: ';
    private static readonly Dot = '.';
    private static readonly Colon = ': ';

    public static Validate(scope: AccessScope, index: CatalogIndex): void
    {
        const catalog = index.Catalog;
        for (const keys of [scope.Rows.keys(), scope.Hidden.keys(), scope.Writes.keys()])
        {
            for (const key of keys)
            {
                if (!catalog.Has(key))
                {
                    throw new GraphError(GraphErrorCode.InvalidArgument, ScopeValidator.ErrUnknownName + key);
                }
            }
        }
        for (const [key, members] of scope.Hidden)
        {
            ScopeValidator.RequireMembers(index, key, members, ScopeValidator.ErrUnknownMember);
        }
        for (const [key, members] of scope.HiddenExact)
        {
            ScopeValidator.RequireConcept(index, key, ScopeValidator.ErrHiddenExactKey);
            ScopeValidator.RequireMembers(index, key, members, ScopeValidator.ErrUnknownMember);
        }
        for (const [key, predicate] of scope.Rows)
        {
            ScopeValidator.Walk(index, predicate, new Place(key, key, []));
        }
        for (const [key, rules] of scope.Writes)
        {
            ScopeValidator.RequireMembers(index, key, rules.ReadOnly?.Create ?? [], ScopeValidator.ErrUnknownReadOnly);
            ScopeValidator.RequireMembers(index, key, rules.ReadOnly?.Update ?? [], ScopeValidator.ErrUnknownReadOnly);
            if (rules.ReadOnlyExact !== undefined)
            {
                ScopeValidator.RequireConcept(index, key, ScopeValidator.ErrReadOnlyExactKey);
                ScopeValidator.RequireMembers(index, key, rules.ReadOnlyExact.Create ?? [], ScopeValidator.ErrUnknownReadOnly);
                ScopeValidator.RequireMembers(index, key, rules.ReadOnlyExact.Update ?? [], ScopeValidator.ErrUnknownReadOnly);
            }
            for (const predicate of [rules.Create, rules.Update, rules.Delete])
            {
                if (predicate !== undefined)
                {
                    ScopeValidator.Walk(index, predicate, new Place(key, key, []));
                }
            }
        }
    }

    /**
     * An exact-concept set's key must be a concept of the catalog, never an aspect: a node's own concept is never an
     * aspect, so such a set could never apply (R94, as ConceptIs in R93).
     */
    private static RequireConcept(index: CatalogIndex, key: string, error: string): void
    {
        if (!index.Catalog.Has(key) || index.Catalog.IsAspect(key))
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, error + key);
        }
    }

    /** Every name in `members` must be a member of `key` (CatalogSnapshot.MemberOf: effective on it). */
    private static RequireMembers(index: CatalogIndex, key: string, members: Iterable<string>, error: string): void
    {
        for (const member of members)
        {
            if (ScopeValidator.MemberOf(index, key, member) === undefined)
            {
                throw new GraphError(GraphErrorCode.InvalidArgument, error + key + ScopeValidator.Dot + member);
            }
        }
    }

    private static Walk(index: CatalogIndex, p: Predicate, place: Place): void
    {
        switch (p.Kind)
        {
            case PredicateKind.Compare:
                ScopeValidator.RequireProperty(index, place, (p as Compare).Member);
                break;
            case PredicateKind.In:
                ScopeValidator.RequireProperty(index, place, (p as In).Member);
                break;
            case PredicateKind.IsNull:
                ScopeValidator.RequireProperty(index, place, (p as IsNull).Member);
                break;
            case PredicateKind.ConceptIs:
            {
                // A node's own concept is never an aspect: naming one could only ever be false (R93).
                const concept = (p as ConceptIs).Concept;
                if (!index.Catalog.Has(concept) || index.Catalog.IsAspect(concept))
                {
                    throw new GraphError(GraphErrorCode.InvalidArgument, ScopeValidator.ErrConceptIs + place.Label + ScopeValidator.Colon + concept);
                }
                break;
            }
            case PredicateKind.And:
            case PredicateKind.Or:
                for (const term of (p as And | Or).Terms)
                {
                    ScopeValidator.Walk(index, term, place);
                }
                break;
            case PredicateKind.Not:
                ScopeValidator.Walk(index, (p as Not).Term, place);
                break;
            case PredicateKind.Related:
            {
                const related = p as Related;
                ScopeValidator.Walk(index, related.Target, ScopeValidator.Follow(index, place, related.Relationship, related.Direction));
                break;
            }
            case PredicateKind.Reachable:
                for (const step of (p as Reachable).Steps)
                {
                    // Steps walk from arbitrary nodes: the relationship must exist on some concept.
                    ScopeValidator.Follow(index, new Place(place.Label, undefined, ScopeValidator.AllConcepts(index)), step.Relationship, step.Direction);
                }
                break;
            default:
                break;
        }
    }

    private static RequireProperty(index: CatalogIndex, place: Place, name: string): void
    {
        const found = place.Key !== undefined
            ? ScopeValidator.MemberOf(index, place.Key, name)?.Kind === MemberKind.Property
            : place.Concepts.some(c => ScopeValidator.Effective(index, c, name)?.Kind === MemberKind.Property);
        if (!found)
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, ScopeValidator.ErrProperty + place.Label + ScopeValidator.Dot + name);
        }
    }

    /** The concepts a step over `name` in `direction` reaches from `place`; throws when none can be followed. */
    private static Follow(index: CatalogIndex, place: Place, name: string, direction: EdgeDirection): Place
    {
        const reached = new Set<string>();
        if (direction === EdgeDirection.Out)
        {
            const rels = place.Key !== undefined
                ? [ScopeValidator.MemberOf(index, place.Key, name)]
                : place.Concepts.map(c => ScopeValidator.Effective(index, c, name));
            let found = false;
            for (const rel of rels)
            {
                if (rel?.Kind === MemberKind.Relationship)
                {
                    found = true;
                    for (const target of rel.Targets ?? [])
                    {
                        ScopeValidator.AddMatching(index, target, reached);
                    }
                }
            }
            if (found && reached.size === 0)
            {
                // A relationship whose targets are only aspects no concept carries: real, but it reaches nothing.
                throw new GraphError(GraphErrorCode.InvalidArgument, ScopeValidator.ErrNoConcept + place.Label + ScopeValidator.Dot + name);
            }
        }
        else
        {
            const from = place.Key !== undefined ? ScopeValidator.Matching(index, place.Key) : place.Concepts;
            const ids = new Set<number>();
            for (const concept of from)
            {
                for (const rel of index.IncomingRelationships(concept))
                {
                    if (rel.Name === name)
                    {
                        ids.add(rel.Id);
                    }
                }
            }
            for (const concept of ScopeValidator.AllConcepts(index))
            {
                if (index.Catalog.EffectiveMembers(concept).some(m => ids.has(m.Id)))
                {
                    reached.add(concept);
                }
            }
        }
        if (reached.size === 0)
        {
            throw new GraphError(GraphErrorCode.InvalidArgument, ScopeValidator.ErrRelationship + place.Label + ScopeValidator.Dot + name);
        }
        return new Place(place.Label + ScopeValidator.Dot + name, undefined, [...reached]);
    }

    private static MemberOf(index: CatalogIndex, key: string, name: string): MemberDef | undefined
    {
        try
        {
            return index.Catalog.MemberOf(key, name);
        }
        catch (error)
        {
            if (error instanceof CatalogError)
            {
                return undefined;
            }
            throw error;
        }
    }

    private static Effective(index: CatalogIndex, concept: string, name: string): MemberDef | undefined
    {
        return index.Catalog.EffectiveMembers(concept).find(m => m.Name === name);
    }

    private static Matching(index: CatalogIndex, name: string): readonly string[]
    {
        const out = new Set<string>();
        ScopeValidator.AddMatching(index, name, out);
        return [...out];
    }

    private static AddMatching(index: CatalogIndex, name: string, out: Set<string>): void
    {
        for (const typeId of index.Catalog.ConceptsMatching(name))
        {
            const concept = index.ConceptOf(typeId);
            if (concept !== undefined)
            {
                out.add(concept);
            }
        }
    }

    private static AllConcepts(index: CatalogIndex): readonly string[]
    {
        return index.Catalog.Definitions().filter(d => !d.IsAspect).map(d => d.Name);
    }
}
