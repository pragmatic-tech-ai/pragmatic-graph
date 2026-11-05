import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogError, CatalogErrorCode } from '../CatalogError.js';
import { CatalogModel, MemberInput } from '../CatalogModel.js';
import { CatalogSnapshot } from '../CatalogSnapshot.js';
import { MemberKind, ValueType } from '../ValueType.js';

class Fx
{
    public static Prop(name: string, type: ValueType = ValueType.String): MemberInput
    {
        return { Name: name, Kind: MemberKind.Property, Type: type };
    }

    public static Rel(name: string, targets: string[], edge?: MemberInput[]): MemberInput
    {
        return edge === undefined
            ? { Name: name, Kind: MemberKind.Relationship, Targets: targets, Many: true }
            : { Name: name, Kind: MemberKind.Relationship, Targets: targets, Many: true, EdgeProperties: edge };
    }

    public static Code(code: CatalogErrorCode): (e: unknown) => boolean
    {
        return (e: unknown) => e instanceof CatalogError && e.Code === code;
    }

    public static Names(snapshot: CatalogSnapshot, concept: string): string[]
    {
        return snapshot.EffectiveMembers(concept).map(m => m.Name);
    }
}

describe('CatalogModel', () =>
{
    it('inherits parent and aspect members with DeclaredBy', () =>
    {
        const m = new CatalogModel();
        m.DefineAspect('Named', [], [Fx.Prop('name')]);
        m.DefineConcept('Thing', null, [], [Fx.Prop('id')]);
        m.DefineConcept('Person', 'Thing', ['Named'], [Fx.Prop('age', ValueType.Int64)]);
        const s = m.Seal();
        assert.deepEqual(Fx.Names(s, 'Person'), ['id', 'name', 'age']);
        const by = Object.fromEntries(s.EffectiveMembers('Person').map(x => [x.Name, x.DeclaredBy]));
        assert.deepEqual(by, { id: 'Thing', name: 'Named', age: 'Person' });
        assert.equal(s.Version, 1);
    });

    it('an aspect reached by two paths contributes once', () =>
    {
        const m = new CatalogModel();
        m.DefineAspect('A', [], [Fx.Prop('a')]);
        m.DefineAspect('B', ['A'], [Fx.Prop('b')]);
        m.DefineAspect('C', ['A'], [Fx.Prop('c')]);
        m.DefineConcept('T', null, ['B', 'C'], []);
        m.DefineConcept('U', 'T', ['A'], []);
        const s = m.Seal();
        assert.deepEqual(Fx.Names(s, 'T').sort(), ['a', 'b', 'c']);
        assert.deepEqual(Fx.Names(s, 'U').sort(), ['a', 'b', 'c']);
    });

    it('redeclaring an inherited member throws MemberRedeclared', () =>
    {
        const m = new CatalogModel();
        m.DefineConcept('P', null, [], [Fx.Prop('x')]);
        m.DefineConcept('C', 'P', [], [Fx.Prop('x')]);
        assert.throws(() => m.Seal(), Fx.Code(CatalogErrorCode.MemberRedeclared));
    });

    it('redeclaring an aspect member throws MemberRedeclared', () =>
    {
        const m = new CatalogModel();
        m.DefineAspect('A', [], [Fx.Prop('x')]);
        m.DefineConcept('C', null, ['A'], [Fx.Prop('x')]);
        assert.throws(() => m.Seal(), Fx.Code(CatalogErrorCode.MemberRedeclared));
    });

    it('two aspects contributing the same name throw MemberCollision', () =>
    {
        const m = new CatalogModel();
        m.DefineAspect('A', [], [Fx.Prop('x')]);
        m.DefineAspect('B', [], [Fx.Prop('x')]);
        m.DefineConcept('C', null, ['A', 'B'], []);
        assert.throws(() => m.Seal(), Fx.Code(CatalogErrorCode.MemberCollision));
    });

    it('an aspect and the parent chain with the same name throw MemberCollision', () =>
    {
        const m = new CatalogModel();
        m.DefineAspect('A', [], [Fx.Prop('x')]);
        m.DefineConcept('P', null, [], [Fx.Prop('x')]);
        m.DefineConcept('C', 'P', ['A'], []);
        assert.throws(() => m.Seal(), Fx.Code(CatalogErrorCode.MemberCollision));
    });

    it('extends cycle throws InheritanceCycle', () =>
    {
        const m = new CatalogModel();
        m.DefineConcept('A', 'B', [], []);
        m.DefineConcept('B', 'A', [], []);
        assert.throws(() => m.Seal(), Fx.Code(CatalogErrorCode.InheritanceCycle));
    });

    it('aspect inclusion cycle throws InheritanceCycle', () =>
    {
        const m = new CatalogModel();
        m.DefineAspect('A', ['B'], []);
        m.DefineAspect('B', ['A'], []);
        m.DefineConcept('C', null, ['A'], []);
        assert.throws(() => m.Seal(), Fx.Code(CatalogErrorCode.InheritanceCycle));
    });

    it('rejects unknown references and kind misuse', () =>
    {
        let m = new CatalogModel();
        m.DefineConcept('C', 'Nope', [], []);
        assert.throws(() => m.Seal(), Fx.Code(CatalogErrorCode.UnknownType));

        m = new CatalogModel();
        m.DefineConcept('C', null, ['Nope'], []);
        assert.throws(() => m.Seal(), Fx.Code(CatalogErrorCode.UnknownType));

        m = new CatalogModel();
        m.DefineConcept('C', null, [], [Fx.Rel('r', ['Nope'])]);
        assert.throws(() => m.Seal(), Fx.Code(CatalogErrorCode.UnknownType));

        m = new CatalogModel();
        m.DefineAspect('A', [], []);
        m.DefineConcept('C', 'A', [], []);
        assert.throws(() => m.Seal(), Fx.Code(CatalogErrorCode.AspectAsParent));

        m = new CatalogModel();
        m.DefineConcept('K', null, [], []);
        m.DefineConcept('C', null, ['K'], []);
        assert.throws(() => m.Seal(), Fx.Code(CatalogErrorCode.ConceptInAspectList));

        m = new CatalogModel();
        m.DefineConcept('K', null, [], []);
        m.DefineAspect('A', ['K'], []);
        assert.throws(() => m.Seal(), Fx.Code(CatalogErrorCode.ConceptInAspectList));
    });

    it('duplicate definitions throw DuplicateType or MultipleParents', () =>
    {
        const m = new CatalogModel();
        m.DefineConcept('C', null, [], []);
        assert.throws(() => m.DefineConcept('C', null, [], []), Fx.Code(CatalogErrorCode.DuplicateType));
        assert.throws(() => m.DefineAspect('C', [], []), Fx.Code(CatalogErrorCode.DuplicateType));
        assert.throws(() => m.DefineConcept('C', 'X', [], []), Fx.Code(CatalogErrorCode.MultipleParents));
    });

    it('relationship targets may be aspects; forward references are allowed', () =>
    {
        const m = new CatalogModel();
        m.DefineConcept('Doc', null, [], [Fx.Rel('owner', ['Named'])]);
        m.DefineAspect('Named', [], []);
        const s = m.Seal();
        assert.deepEqual(s.EffectiveMembers('Doc')[0]!.Targets, ['Named']);
    });

    it('ConceptsMatching covers subtypes and aspect carriers, concepts only', () =>
    {
        const m = new CatalogModel();
        m.DefineAspect('Base', [], [Fx.Prop('b')]);
        m.DefineAspect('Mid', ['Base'], [Fx.Prop('m')]);
        m.DefineConcept('Root', null, [], []);
        m.DefineConcept('Kid', 'Root', [], []);
        m.DefineConcept('Direct', null, ['Mid'], []);
        m.DefineConcept('Viaparent', 'Direct', [], []);
        m.DefineConcept('Other', null, [], []);
        const s = m.Seal();
        const ids = (...n: string[]) => n.map(x => s.TypeId(x)).sort((a, b) => a - b);
        assert.deepEqual([...s.ConceptsMatching('Root')].sort((a, b) => a - b), ids('Root', 'Kid'));
        assert.deepEqual([...s.ConceptsMatching('Mid')].sort((a, b) => a - b), ids('Direct', 'Viaparent'));
        assert.deepEqual([...s.ConceptsMatching('Base')].sort((a, b) => a - b), ids('Direct', 'Viaparent'));
        assert.equal(s.IsA('Kid', 'Root'), true);
        assert.equal(s.IsA('Kid', 'Kid'), true);
        assert.equal(s.IsA('Root', 'Kid'), false);
        assert.equal(s.IsA('Viaparent', 'Base'), true);
        assert.equal(s.IsA('Other', 'Base'), false);
    });

    it('type ids and member ids are stable across a re-seal; intervals nest', () =>
    {
        const m = new CatalogModel();
        m.DefineAspect('Named', [], [Fx.Prop('name')]);
        m.DefineConcept('Root', null, ['Named'], [Fx.Prop('r')]);
        m.DefineConcept('Kid', 'Root', [], [Fx.Prop('k')]);
        const s1 = m.Seal();

        const m2 = CatalogModel.FromSnapshot(s1);
        m2.DefineConcept('Aardvark', null, [], [Fx.Prop('z')]);
        m2.DefineConcept('Grandkid', 'Kid', [], [Fx.Prop('g')]);
        const s2 = m2.Seal();

        for (const n of ['Named', 'Root', 'Kid'])
        {
            assert.equal(s2.TypeId(n), s1.TypeId(n));
        }
        assert.ok(s2.TypeId('Aardvark') > s1.TypeId('Kid'));
        for (const c of ['Root', 'Kid'])
        {
            assert.deepEqual(s2.EffectiveMembers(c).map(x => x.Id), s1.EffectiveMembers(c).map(x => x.Id));
        }
        assert.equal(s2.Version, 2);
        assert.ok(s2.EffectiveMembers('Grandkid').every(x => x.Id >= 1));
        const gk = s2.EffectiveMembers('Grandkid').find(x => x.Name === 'g')!;
        assert.ok(gk.Id > Math.max(...s1.EffectiveMembers('Kid').map(x => x.Id)));

        const [pl, ph] = s2.PreOrderInterval('Root');
        const [kl, kh] = s2.PreOrderInterval('Kid');
        const [gl, gh] = s2.PreOrderInterval('Grandkid');
        assert.ok(pl <= kl && kh <= ph);
        assert.ok(kl <= gl && gh <= kh);
        const [al, ah] = s2.PreOrderInterval('Aardvark');
        assert.ok(ah < pl || al > ph);
    });

    it('an aspect member has the same Id in every carrier; ids are global and unique', () =>
    {
        const m = new CatalogModel();
        m.DefineAspect('Named', [], [Fx.Prop('name')]);
        m.DefineConcept('A', null, ['Named'], [Fx.Prop('a')]);
        m.DefineConcept('B', null, ['Named'], [Fx.Rel('r', ['A'], [Fx.Prop('since', ValueType.Date)])]);
        const s = m.Seal();
        const na = s.Member('A', 'name');
        const nb = s.Member('B', 'name');
        assert.equal(na.Id, nb.Id);
        const rel = s.Member('B', 'r');
        const edgeId = rel.EdgeProperties![0]!.Id;
        const all = [na.Id, s.Member('A', 'a').Id, rel.Id, edgeId];
        assert.equal(new Set(all).size, all.length);
        assert.ok(all.every(i => i >= 1));
        assert.equal(CatalogSnapshot.NodeIdMember.Id, 0);
    });

    it('RequireInstantiable and lookups', () =>
    {
        const m = new CatalogModel();
        m.DefineAspect('A', [], []);
        m.DefineConcept('C', null, [], []);
        const s = m.Seal();
        assert.equal(s.RequireInstantiable('C'), s.TypeId('C'));
        assert.throws(() => s.RequireInstantiable('A'), Fx.Code(CatalogErrorCode.AspectNotInstantiable));
        assert.throws(() => s.RequireInstantiable('Z'), Fx.Code(CatalogErrorCode.UnknownType));
        assert.throws(() => s.TypeId('Z'), Fx.Code(CatalogErrorCode.UnknownType));
        assert.throws(() => s.Member('C', 'q'), Fx.Code(CatalogErrorCode.UnknownMember));
    });

    it('snapshots are immutable and detached', () =>
    {
        const m = new CatalogModel();
        m.DefineConcept('C', null, [], [Fx.Prop('x')]);
        const s1 = m.Seal();
        m.DefineConcept('D', null, [], []);
        const s2 = m.Seal();
        assert.throws(() => s1.TypeId('D'), Fx.Code(CatalogErrorCode.UnknownType));
        assert.equal(s2.Version, 2);
        const members = s1.EffectiveMembers('C') as unknown as unknown[];
        assert.throws(() => members.push({}));
        assert.throws(() => { (s1.EffectiveMembers('C')[0] as { Name: string }).Name = 'y'; });
    });

    it('aspect including itself throws InheritanceCycle', () =>
    {
        const m = new CatalogModel();
        m.DefineAspect('A', ['A'], []);
        assert.throws(() => m.Seal(), Fx.Code(CatalogErrorCode.InheritanceCycle));
    });

    it('a concept extending itself throws InheritanceCycle', () =>
    {
        const m = new CatalogModel();
        m.DefineConcept('A', 'A', [], []);
        assert.throws(() => m.Seal(), Fx.Code(CatalogErrorCode.InheritanceCycle));
    });

    it('a type outside a cycle that descends into it still throws InheritanceCycle', () =>
    {
        const m = new CatalogModel();
        m.DefineConcept('Leaf', 'A', [], []);
        m.DefineConcept('A', 'B', [], []);
        m.DefineConcept('B', 'A', [], []);
        assert.throws(() => m.Seal(), Fx.Code(CatalogErrorCode.InheritanceCycle));
    });

    it('a collision inside an aspect include chain throws MemberCollision', () =>
    {
        const m = new CatalogModel();
        m.DefineAspect('B', [], [Fx.Prop('x')]);
        m.DefineAspect('C', [], [Fx.Prop('x')]);
        m.DefineAspect('A', ['B', 'C'], []);
        assert.throws(() => m.Seal(), Fx.Code(CatalogErrorCode.MemberCollision));
    });

    it('a child listing an aspect already carried via the parent gets its members once', () =>
    {
        const m = new CatalogModel();
        m.DefineAspect('Base', [], [Fx.Prop('b')]);
        m.DefineAspect('Mid', ['Base'], [Fx.Prop('m')]);
        m.DefineConcept('P', null, ['Base'], []);
        m.DefineConcept('C', 'P', ['Mid'], []);
        const s = m.Seal();
        assert.deepEqual(Fx.Names(s, 'C'), ['b', 'm']);
    });

    it('ConceptsMatching(parent) is exactly the concepts within the parent interval', () =>
    {
        const m = new CatalogModel();
        m.DefineConcept('Root', null, [], []);
        m.DefineConcept('Kid', 'Root', [], []);
        m.DefineConcept('Grand', 'Kid', [], []);
        m.DefineConcept('Other', null, [], []);
        m.DefineConcept('Kid2', 'Other', [], []);
        const s = m.Seal();
        for (const parent of ['Root', 'Kid', 'Other'])
        {
            const [lo, hi] = s.PreOrderInterval(parent);
            const within = s.Definitions()
                .filter(d => !d.IsAspect)
                .filter(d => { const [l, h] = s.PreOrderInterval(d.Name); return l >= lo && h <= hi; })
                .map(d => d.TypeId)
                .sort((a, b) => a - b);
            assert.deepEqual([...s.ConceptsMatching(parent)].sort((a, b) => a - b), within);
        }
    });

    it('duplicate member names in one declaration throw InvalidMember', () =>
    {
        const m = new CatalogModel();
        assert.throws(() => m.DefineConcept('C', null, [], [Fx.Prop('x'), Fx.Prop('x')]), Fx.Code(CatalogErrorCode.InvalidMember));
        assert.throws(
            () => m.DefineConcept('D', null, [], [Fx.Rel('r', ['D'], [Fx.Prop('p'), Fx.Prop('p')])]),
            Fx.Code(CatalogErrorCode.InvalidMember));
    });

    it('a failed Seal leaves version and id counters untouched', () =>
    {
        const m = new CatalogModel();
        m.DefineConcept('Ok', null, [], [Fx.Prop('x')]);
        const first = m.Seal();
        const fresh = CatalogModel.FromSnapshot(first);
        fresh.DefineConcept('Bad', 'Missing', [], [Fx.Prop('y')]);
        assert.throws(() => fresh.Seal(), Fx.Code(CatalogErrorCode.UnknownType));
        assert.throws(() => fresh.Seal(), Fx.Code(CatalogErrorCode.UnknownType));
        const again = CatalogModel.FromSnapshot(first);
        again.DefineConcept('Good', null, [], [Fx.Prop('z')]);
        const second = again.Seal();
        assert.equal(second.Version, 2);
        assert.equal(second.Member('Good', 'z').Id, 2);
        assert.equal(second.TypeId('Good'), 2);
    });
});
