import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogError, CatalogErrorCode } from '../../catalog/CatalogError.js';
import { CatalogModel } from '../../catalog/CatalogModel.js';
import type { CatalogSnapshot } from '../../catalog/CatalogSnapshot.js';
import type { MemberInput } from '../../catalog/CatalogTypes.js';
import { MemberKind, ValueType } from '../../catalog/ValueType.js';
import { Compare, CompareOp } from '../../predicate/Predicate.js';
import { CatalogPlanner } from '../CatalogPlanner.js';
import type { IDefinitionDescription, IIndexDescription, ISchemaDescription } from '../SchemaDescription.js';

class Fx
{
    public static Prop(name: string, type: ValueType, nullable = false): MemberInput
    {
        return { Name: name, Kind: MemberKind.Property, Type: type, Nullable: nullable };
    }

    public static Concept(name: string, members: MemberInput[], parent: string | null = null, aspects: string[] = []): IDefinitionDescription
    {
        return { Name: name, IsAspect: false, Parent: parent, Aspects: aspects, Members: members };
    }

    public static Aspect(name: string, members: MemberInput[]): IDefinitionDescription
    {
        return { Name: name, IsAspect: true, Parent: null, Aspects: [], Members: members };
    }

    public static Desc(defs: readonly IDefinitionDescription[], indexes: IIndexDescription[] = []): ISchemaDescription
    {
        return { Version: 'v', Definitions: defs, Indexes: indexes, Seed: [], Bindings: [] };
    }

    /** Stored catalog = the plan of a description against an empty catalog. */
    public static Stored(desc: ISchemaDescription): CatalogSnapshot
    {
        return CatalogPlanner.Plan(new CatalogModel().Seal(), desc).Catalog;
    }

    public static MemberId(s: CatalogSnapshot, concept: string, name: string): number
    {
        return s.Member(concept, name).Id;
    }

    public static Code(fn: () => unknown): CatalogErrorCode | undefined
    {
        try
        {
            fn();
        }
        catch (e)
        {
            return e instanceof CatalogError ? e.Code : undefined;
        }
        return undefined;
    }

    public static Base(): ISchemaDescription
    {
        return Fx.Desc([Fx.Concept('File', [Fx.Prop('size', ValueType.Int64, true), Fx.Prop('name', ValueType.String)])]);
    }
}

describe('CatalogPlanner', () =>
{
    it('identical description is empty diff and returns the stored snapshot', () =>
    {
        const stored = Fx.Stored(Fx.Base());
        const plan = CatalogPlanner.Plan(stored, Fx.Base());
        assert.equal(plan.Catalog, stored);
        assert.ok(plan.Diff.IsEmpty);
    });

    it('added concept gets new ids, kept ids stable', () =>
    {
        const stored = Fx.Stored(Fx.Base());
        const desc = Fx.Desc([...Fx.Base().Definitions, Fx.Concept('Dir', [Fx.Prop('path', ValueType.String)])]);
        const plan = CatalogPlanner.Plan(stored, desc);
        assert.equal(plan.Catalog.Version, stored.Version + 1);
        assert.equal(plan.Catalog.TypeId('File'), stored.TypeId('File'));
        assert.equal(Fx.MemberId(plan.Catalog, 'File', 'size'), Fx.MemberId(stored, 'File', 'size'));
        assert.ok(plan.Catalog.TypeId('Dir') >= stored.NextTypeId);
        assert.ok(Fx.MemberId(plan.Catalog, 'Dir', 'path') >= stored.NextMemberId);
        assert.deepEqual(plan.Diff.AddedTypes.map(t => t.Name), ['Dir']);
        assert.equal(plan.Diff.RemovedTypes.length, 0);
        assert.equal(plan.Diff.RemovedMembers.length, 0);
        assert.ok(!plan.Diff.IsEmpty);
    });

    it('removed concept is listed with its old definition', () =>
    {
        const stored = Fx.Stored(Fx.Desc([...Fx.Base().Definitions, Fx.Concept('Dir', [Fx.Prop('path', ValueType.String)])]));
        const plan = CatalogPlanner.Plan(stored, Fx.Base());
        assert.deepEqual(plan.Diff.RemovedTypes.map(t => t.Name), ['Dir']);
        assert.equal(plan.Diff.RemovedTypes[0]!.TypeId, stored.TypeId('Dir'));
        assert.equal(plan.Catalog.Version, stored.Version + 1);
        assert.equal(plan.Catalog.NextTypeId, stored.NextTypeId);
    });

    it('retyped member gets a new id and the old one is listed removed', () =>
    {
        const stored = Fx.Stored(Fx.Base());
        const oldId = Fx.MemberId(stored, 'File', 'size');
        const plan = CatalogPlanner.Plan(stored, Fx.Desc([Fx.Concept('File', [Fx.Prop('size', ValueType.String, true), Fx.Prop('name', ValueType.String)])]));
        const newId = Fx.MemberId(plan.Catalog, 'File', 'size');
        assert.ok(newId > stored.NextMemberId - 1);
        assert.equal(plan.Diff.RemovedMembers.length, 1);
        assert.equal(plan.Diff.RemovedMembers[0]!.Type, 'File');
        assert.equal(plan.Diff.RemovedMembers[0]!.Member.Id, oldId);
        assert.equal(Fx.MemberId(plan.Catalog, 'File', 'name'), Fx.MemberId(stored, 'File', 'name'));
    });

    it('nullable true to false is a retype; false to true keeps the id', () =>
    {
        const stored = Fx.Stored(Fx.Base());
        const tight = CatalogPlanner.Plan(stored, Fx.Desc([Fx.Concept('File', [Fx.Prop('size', ValueType.Int64, false), Fx.Prop('name', ValueType.String)])]));
        assert.notEqual(Fx.MemberId(tight.Catalog, 'File', 'size'), Fx.MemberId(stored, 'File', 'size'));
        assert.equal(tight.Diff.RemovedMembers.length, 1);

        const loose = CatalogPlanner.Plan(stored, Fx.Desc([Fx.Concept('File', [Fx.Prop('size', ValueType.Int64, true), Fx.Prop('name', ValueType.String, true)])]));
        assert.equal(Fx.MemberId(loose.Catalog, 'File', 'name'), Fx.MemberId(stored, 'File', 'name'));
        assert.equal(loose.Diff.RemovedMembers.length, 0);
        assert.equal(loose.Catalog.Version, stored.Version + 1);
        assert.equal(loose.Catalog.Member('File', 'name').Nullable, true);
    });

    it('a member moved to a carried aspect keeps its id', () =>
    {
        const stored = Fx.Stored(Fx.Base());
        const plan = CatalogPlanner.Plan(stored, Fx.Desc([
            Fx.Aspect('Sized', [Fx.Prop('size', ValueType.Int64, true)]),
            Fx.Concept('File', [Fx.Prop('name', ValueType.String)], null, ['Sized']),
        ]));
        assert.equal(Fx.MemberId(plan.Catalog, 'File', 'size'), Fx.MemberId(stored, 'File', 'size'));
        assert.equal(plan.Catalog.Member('File', 'size').DeclaredBy, 'Sized');
        assert.equal(plan.Diff.RemovedMembers.length, 0);
        assert.deepEqual(plan.Diff.ChangedHierarchy, ['File']);
    });

    it('a parent change lists the concept in ChangedHierarchy and keeps its TypeId', () =>
    {
        const stored = Fx.Stored(Fx.Desc([Fx.Concept('A', []), Fx.Concept('B', []), Fx.Concept('C', [], 'A')]));
        const plan = CatalogPlanner.Plan(stored, Fx.Desc([Fx.Concept('A', []), Fx.Concept('B', []), Fx.Concept('C', [], 'B')]));
        assert.deepEqual(plan.Diff.ChangedHierarchy, ['C']);
        assert.equal(plan.Catalog.TypeId('C'), stored.TypeId('C'));
        assert.ok(!plan.Diff.IsEmpty);
    });

    it('an index change is remove plus add; an unchanged index keeps its id', () =>
    {
        const idx = (unique: boolean): IIndexDescription => ({ Name: 'ByName', On: 'File', Members: ['name'], Unique: unique });
        const other: IIndexDescription = { Name: 'BySize', On: 'File', Members: ['size'], Where: new Compare('size', CompareOp.Gt, 0n) };
        const defs = Fx.Base().Definitions;
        const stored = Fx.Stored(Fx.Desc(defs, [idx(false), other]));
        assert.equal(stored.Indexes().length, 2);
        const same = CatalogPlanner.Plan(stored, Fx.Desc(defs, [idx(false), other]));
        assert.equal(same.Catalog, stored);

        const plan = CatalogPlanner.Plan(stored, Fx.Desc(defs, [idx(true), other]));
        assert.deepEqual(plan.Diff.RemovedIndexes.map(i => i.Name), ['ByName']);
        assert.deepEqual(plan.Diff.AddedIndexes.map(i => i.Name), ['ByName']);
        assert.ok(plan.Diff.AddedIndexes[0]!.Id >= stored.NextIndexId);
        const kept = plan.Catalog.Indexes().find(i => i.Name === 'BySize')!;
        assert.equal(kept.Id, stored.Indexes().find(i => i.Name === 'BySize')!.Id);
        assert.deepEqual(kept.Members, [Fx.MemberId(stored, 'File', 'size')]);
    });

    it('an index on a retyped member is rebuilt', () =>
    {
        const idx: IIndexDescription = { Name: 'BySize', On: 'File', Members: ['size'] };
        const stored = Fx.Stored(Fx.Desc(Fx.Base().Definitions, [idx]));
        const plan = CatalogPlanner.Plan(stored, Fx.Desc([Fx.Concept('File', [Fx.Prop('size', ValueType.String, true), Fx.Prop('name', ValueType.String)])], [idx]));
        assert.equal(plan.Diff.RemovedIndexes.length, 1);
        assert.equal(plan.Diff.AddedIndexes.length, 1);
    });

    it('an index on an aspect is allowed; unknown member, type or duplicate name is a CatalogError', () =>
    {
        const defs = [Fx.Aspect('Sized', [Fx.Prop('size', ValueType.Int64, true)]), Fx.Concept('File', [], null, ['Sized'])];
        const ok = Fx.Stored(Fx.Desc(defs, [{ Name: 'BySize', On: 'Sized', Members: ['size'] }]));
        assert.equal(ok.Indexes()[0]!.On, 'Sized');
        assert.equal(ok.IndexesOn('File').length, 1);
        const empty = Fx.Stored(Fx.Desc(defs));
        assert.equal(Fx.Code(() => CatalogPlanner.Plan(empty, Fx.Desc(defs, [{ Name: 'X', On: 'File', Members: ['nope'] }]))), CatalogErrorCode.UnknownMember);
        assert.equal(Fx.Code(() => CatalogPlanner.Plan(empty, Fx.Desc(defs, [{ Name: 'X', On: 'Nope', Members: ['size'] }]))), CatalogErrorCode.UnknownType);
        assert.equal(Fx.Code(() => CatalogPlanner.Plan(empty, Fx.Desc(defs, [
            { Name: 'X', On: 'File', Members: ['size'] }, { Name: 'X', On: 'File', Members: ['size'] }]))), CatalogErrorCode.DuplicateType);
    });

    it('a validation error propagates and leaves the stored catalog unaffected', () =>
    {
        const stored = Fx.Stored(Fx.Base());
        const versionBefore = stored.Version;
        const bad = Fx.Desc([Fx.Concept('File', [], 'Missing')]);
        assert.equal(Fx.Code(() => CatalogPlanner.Plan(stored, bad)), CatalogErrorCode.UnknownType);
        assert.equal(stored.Definitions().length, 1);
        assert.equal(stored.Version, versionBefore);
    });

    it('a placement option change is a new version even with an empty diff', () =>
    {
        const stored = Fx.Stored(Fx.Base());
        const d = Fx.Base();
        const plan = CatalogPlanner.Plan(stored, Fx.Desc([{ ...d.Definitions[0]!, Options: { AggregateRoot: 'File' } }]));
        assert.ok(plan.Diff.IsEmpty);
        assert.equal(plan.Catalog.Version, stored.Version + 1);
        assert.equal(plan.Catalog.Definitions()[0]!.AggregateRoot, 'File');
    });
});
