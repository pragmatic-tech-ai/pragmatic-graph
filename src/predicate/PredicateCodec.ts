import { DateTimeValue, DateValue, DurationValue, type CellValue } from '../columns/CellValue.js';
import { EdgeDirection } from '../format/FormatKeys.js';
import { And, Compare, CompareOp, IdIn, In, IsNull, Not, Or, OwnerIs, Predicate, PredicateKind, Reachable, Related, Seeded, type IPathStep } from './Predicate.js';
import { PredicateError, PredicateErrorCode } from './PredicateError.js';

type Json = Record<string, unknown>;

/**
 * JSON form of a predicate. Every node is an object with a numeric `Kind` (PredicateKind) plus:
 *   True, False, Seeded: nothing more.
 *   Compare: Member (string), Op (CompareOp number), Value (cell value, below).
 *   In: Member, Values (cell value array).      IsNull: Member.
 *   And, Or: Terms (predicate array).            Not: Term.
 *   IdIn: Ids (sorted string array).             OwnerIs: Owners (sorted string array).
 *   Related: Relationship, Direction (EdgeDirection number), Target (predicate).
 *   Reachable: From (sorted string array), Steps ([{ Relationship, Direction }]), MaxHops (integer >= 1).
 * Cell values: null, boolean and string are plain JSON; every other type is a single-key tagged
 * object so nothing is lossy: { Int64: "decimal" }, { Float64: "text" } (String(n): "NaN",
 * "Infinity", "-0" survive), { Date: days }, { DateTime: { Micros: "decimal", Zone } },
 * { Duration: { Months, Days, Micros: "decimal" } }.
 */
export class PredicateCodec
{
    private static readonly KindField = 'Kind';
    private static readonly MemberField = 'Member';
    private static readonly OpField = 'Op';
    private static readonly ValueField = 'Value';
    private static readonly ValuesField = 'Values';
    private static readonly TermsField = 'Terms';
    private static readonly TermField = 'Term';
    private static readonly IdsField = 'Ids';
    private static readonly OwnersField = 'Owners';
    private static readonly RelationshipField = 'Relationship';
    private static readonly DirectionField = 'Direction';
    private static readonly TargetField = 'Target';
    private static readonly FromField = 'From';
    private static readonly StepsField = 'Steps';
    private static readonly MaxHopsField = 'MaxHops';
    private static readonly Int64Tag = 'Int64';
    private static readonly Float64Tag = 'Float64';
    private static readonly DateTag = 'Date';
    private static readonly DateTimeTag = 'DateTime';
    private static readonly DurationTag = 'Duration';
    private static readonly MicrosField = 'Micros';
    private static readonly ZoneField = 'Zone';
    private static readonly MonthsField = 'Months';
    private static readonly DaysField = 'Days';
    private static readonly IntegerPattern = /^-?\d+$/;
    private static readonly MalformedPrefix = 'Malformed predicate: ';
    private static readonly NotAnObject = 'expected an object';
    private static readonly UnknownKind = 'unknown predicate kind';
    private static readonly BadField = 'missing or invalid field ';
    private static readonly BadCellValue = 'invalid cell value';
    private static readonly BadNumber = 'invalid number text';
    private static readonly BadInteger = 'invalid integer text';

    public static ToJson(p: Predicate): unknown
    {
        const kind = p.Kind;
        switch (kind)
        {
            case PredicateKind.True:
            case PredicateKind.False:
            case PredicateKind.Seeded:
                return { Kind: kind };
            case PredicateKind.Compare:
            {
                const c = p as Compare;
                return { Kind: kind, Member: c.Member, Op: c.Op, Value: PredicateCodec.ValueToJson(c.Value) };
            }
            case PredicateKind.In:
            {
                const i = p as In;
                return { Kind: kind, Member: i.Member, Values: i.Values.map(v => PredicateCodec.ValueToJson(v)) };
            }
            case PredicateKind.IsNull:
                return { Kind: kind, Member: (p as IsNull).Member };
            case PredicateKind.And:
                return { Kind: kind, Terms: (p as And).Terms.map(t => PredicateCodec.ToJson(t)) };
            case PredicateKind.Or:
                return { Kind: kind, Terms: (p as Or).Terms.map(t => PredicateCodec.ToJson(t)) };
            case PredicateKind.Not:
                return { Kind: kind, Term: PredicateCodec.ToJson((p as Not).Term) };
            case PredicateKind.IdIn:
                return { Kind: kind, Ids: PredicateCodec.Sorted((p as IdIn).Ids) };
            case PredicateKind.OwnerIs:
                return { Kind: kind, Owners: PredicateCodec.Sorted((p as OwnerIs).Owners) };
            case PredicateKind.Related:
            {
                const r = p as Related;
                return { Kind: kind, Relationship: r.Relationship, Direction: r.Direction, Target: PredicateCodec.ToJson(r.Target) };
            }
            case PredicateKind.Reachable:
            {
                const r = p as Reachable;
                return {
                    Kind: kind,
                    From: PredicateCodec.Sorted(r.From),
                    Steps: r.Steps.map(s => ({ Relationship: s.Relationship, Direction: s.Direction })),
                    MaxHops: r.MaxHops,
                };
            }
            default:
                throw PredicateCodec.Fail(PredicateCodec.UnknownKind);
        }
    }

    public static FromJson(json: unknown): Predicate
    {
        const o = PredicateCodec.AsObject(json);
        const kind = o[PredicateCodec.KindField];
        switch (kind)
        {
            case PredicateKind.True:
                return Predicate.True;
            case PredicateKind.False:
                return Predicate.False;
            case PredicateKind.Seeded:
                return new Seeded();
            case PredicateKind.Compare:
                return new Compare(
                    PredicateCodec.Str(o, PredicateCodec.MemberField),
                    PredicateCodec.Op(o[PredicateCodec.OpField]),
                    PredicateCodec.ValueFromJson(o[PredicateCodec.ValueField]));
            case PredicateKind.In:
                return new In(
                    PredicateCodec.Str(o, PredicateCodec.MemberField),
                    PredicateCodec.Arr(o, PredicateCodec.ValuesField).map(v => PredicateCodec.ValueFromJson(v)));
            case PredicateKind.IsNull:
                return new IsNull(PredicateCodec.Str(o, PredicateCodec.MemberField));
            case PredicateKind.And:
                return new And(PredicateCodec.Arr(o, PredicateCodec.TermsField).map(t => PredicateCodec.FromJson(t)));
            case PredicateKind.Or:
                return new Or(PredicateCodec.Arr(o, PredicateCodec.TermsField).map(t => PredicateCodec.FromJson(t)));
            case PredicateKind.Not:
                return new Not(PredicateCodec.FromJson(o[PredicateCodec.TermField]));
            case PredicateKind.IdIn:
                return new IdIn(PredicateCodec.StrSet(o, PredicateCodec.IdsField));
            case PredicateKind.OwnerIs:
                return new OwnerIs(PredicateCodec.StrSet(o, PredicateCodec.OwnersField));
            case PredicateKind.Related:
                return new Related(
                    PredicateCodec.Str(o, PredicateCodec.RelationshipField),
                    PredicateCodec.Direction(o[PredicateCodec.DirectionField]),
                    PredicateCodec.FromJson(o[PredicateCodec.TargetField]));
            case PredicateKind.Reachable:
                return new Reachable(
                    PredicateCodec.StrSet(o, PredicateCodec.FromField),
                    PredicateCodec.Arr(o, PredicateCodec.StepsField).map(s => PredicateCodec.Step(s)),
                    PredicateCodec.MaxHops(o[PredicateCodec.MaxHopsField]));
            default:
                throw PredicateCodec.Fail(PredicateCodec.UnknownKind);
        }
    }

    private static ValueToJson(v: CellValue): unknown
    {
        if (v === null || typeof v === 'boolean' || typeof v === 'string')
        {
            return v;
        }
        if (typeof v === 'bigint')
        {
            return { Int64: v.toString() };
        }
        if (typeof v === 'number')
        {
            return { Float64: Object.is(v, -0) ? '-0' : String(v) };
        }
        if (v instanceof DateValue)
        {
            return { Date: v.Days };
        }
        if (v instanceof DateTimeValue)
        {
            return { DateTime: { Micros: v.Micros.toString(), Zone: v.Zone } };
        }
        return { Duration: { Months: v.Months, Days: v.Days, Micros: v.Micros.toString() } };
    }

    private static ValueFromJson(json: unknown): CellValue
    {
        if (json === null || typeof json === 'boolean' || typeof json === 'string')
        {
            return json;
        }
        const o = PredicateCodec.AsObject(json);
        const keys = Object.keys(o);
        if (keys.length !== 1)
        {
            throw PredicateCodec.Fail(PredicateCodec.BadCellValue);
        }
        const tag = keys[0]!;
        const body = o[tag];
        switch (tag)
        {
            case PredicateCodec.Int64Tag:
                return PredicateCodec.BigIntText(body);
            case PredicateCodec.Float64Tag:
                return PredicateCodec.FloatText(body);
            case PredicateCodec.DateTag:
                return new DateValue(PredicateCodec.Int(body, PredicateCodec.DateTag));
            case PredicateCodec.DateTimeTag:
            {
                const d = PredicateCodec.AsObject(body);
                return new DateTimeValue(PredicateCodec.BigIntText(d[PredicateCodec.MicrosField]), PredicateCodec.Str(d, PredicateCodec.ZoneField));
            }
            case PredicateCodec.DurationTag:
            {
                const d = PredicateCodec.AsObject(body);
                return new DurationValue(
                    PredicateCodec.Int(d[PredicateCodec.MonthsField], PredicateCodec.MonthsField),
                    PredicateCodec.Int(d[PredicateCodec.DaysField], PredicateCodec.DaysField),
                    PredicateCodec.BigIntText(d[PredicateCodec.MicrosField]));
            }
            default:
                throw PredicateCodec.Fail(PredicateCodec.BadCellValue);
        }
    }

    private static BigIntText(v: unknown): bigint
    {
        if (typeof v !== 'string' || !PredicateCodec.IntegerPattern.test(v))
        {
            throw PredicateCodec.Fail(PredicateCodec.BadInteger);
        }
        return BigInt(v);
    }

    private static FloatText(v: unknown): number
    {
        if (typeof v !== 'string')
        {
            throw PredicateCodec.Fail(PredicateCodec.BadNumber);
        }
        const n = Number(v);
        if (Number.isNaN(n) && v !== 'NaN')
        {
            throw PredicateCodec.Fail(PredicateCodec.BadNumber);
        }
        return n;
    }

    private static Int(v: unknown, field: string): number
    {
        if (typeof v !== 'number' || !Number.isInteger(v))
        {
            throw PredicateCodec.Fail(PredicateCodec.BadField + field);
        }
        return v;
    }

    private static Op(v: unknown): CompareOp
    {
        if (typeof v !== 'number' || !(v in CompareOp) || typeof CompareOp[v as CompareOp] !== 'string')
        {
            throw PredicateCodec.Fail(PredicateCodec.BadField + PredicateCodec.OpField);
        }
        return v as CompareOp;
    }

    private static Direction(v: unknown): EdgeDirection
    {
        if (v !== EdgeDirection.Out && v !== EdgeDirection.In)
        {
            throw PredicateCodec.Fail(PredicateCodec.BadField + PredicateCodec.DirectionField);
        }
        return v;
    }

    private static MaxHops(v: unknown): number
    {
        const n = PredicateCodec.Int(v, PredicateCodec.MaxHopsField);
        if (n < 1)
        {
            throw PredicateCodec.Fail(PredicateCodec.BadField + PredicateCodec.MaxHopsField);
        }
        return n;
    }

    private static Step(json: unknown): IPathStep
    {
        const o = PredicateCodec.AsObject(json);
        return {
            Relationship: PredicateCodec.Str(o, PredicateCodec.RelationshipField),
            Direction: PredicateCodec.Direction(o[PredicateCodec.DirectionField]),
        };
    }

    private static AsObject(json: unknown): Json
    {
        if (typeof json !== 'object' || json === null || Array.isArray(json))
        {
            throw PredicateCodec.Fail(PredicateCodec.NotAnObject);
        }
        return json as Json;
    }

    private static Str(o: Json, field: string): string
    {
        const v = o[field];
        if (typeof v !== 'string')
        {
            throw PredicateCodec.Fail(PredicateCodec.BadField + field);
        }
        return v;
    }

    private static Arr(o: Json, field: string): unknown[]
    {
        const v = o[field];
        if (!Array.isArray(v))
        {
            throw PredicateCodec.Fail(PredicateCodec.BadField + field);
        }
        return v;
    }

    private static StrSet(o: Json, field: string): Set<string>
    {
        const items = PredicateCodec.Arr(o, field);
        if (!items.every(i => typeof i === 'string'))
        {
            throw PredicateCodec.Fail(PredicateCodec.BadField + field);
        }
        return new Set(items as string[]);
    }

    private static Sorted(set: ReadonlySet<string>): string[]
    {
        return [...set].sort();
    }

    private static Fail(detail: string): PredicateError
    {
        return new PredicateError(PredicateErrorCode.Malformed, PredicateCodec.MalformedPrefix + detail);
    }
}
