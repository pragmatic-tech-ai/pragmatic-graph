import { DateTimeValue, DateValue, DurationValue } from '../columns/CellValue.js';
import { CypherCellCodec } from './CypherCellCodec.js';
import { CypherSemanticError } from './CypherError.js';
import { CypherValue, NullValue, ScalarValue, type ParameterValue } from './CypherValue.js';
import { ScalarSemantics } from './ScalarSemantics.js';
import { ListValue, MapValue } from './StructuredValues.js';
import { TemporalText } from './TemporalText.js';

// Converts caller-supplied plain-JS (JSON-shaped) parameter trees into the engine's internal CypherValue currency.
// Numbers: a safe integer binds as an Int64 (bigint), any other number as a Float64; bigints must fit Int64.
// Temporals: { $date: 'YYYY-MM-DD' }, { $datetime: '<ISO-8601 instant>', zone?: '<IANA>' } (an absent zone is UTC; a present zone must be a string)
// and { $duration: '<ISO-8601 duration>' }, or engine DateValue/DateTimeValue/DurationValue instances.
// Non-finite floats (which JSON cannot carry): { $float: 'NaN' | 'Infinity' | '-Infinity' }, the result-cell tag.
// Lives apart from CypherValue because ListValue/MapValue import CypherValue.ts; a static on the abstract root would
// create an import cycle.
export class ParameterBinder
{
    private static readonly Unsupported = 'unsupported parameter value: only scalars, null, arrays and plain objects are allowed';
    private static readonly MalformedTemporal = 'malformed temporal parameter: ';
    private static readonly MalformedFloat = 'malformed float parameter: ';
    private static readonly DateKey = '$date';
    private static readonly DateTimeKey = '$datetime';
    private static readonly ZoneKey = 'zone';
    private static readonly DurationKey = '$duration';
    private static readonly DefaultZone = 'UTC';

    public static FromInput(value: ParameterValue | undefined): CypherValue
    {
        if (value === null || value === undefined) return NullValue.Instance;
        if (typeof value === 'number') return new ScalarValue(ScalarSemantics.FromNumber(value));
        if (typeof value === 'bigint') return new ScalarValue(ScalarSemantics.CheckInt64(value));
        if (value instanceof DateValue || value instanceof DateTimeValue || value instanceof DurationValue) return new ScalarValue(value);
        if (Array.isArray(value)) return new ListValue(value.map((v) => ParameterBinder.FromInput(v)));
        if (typeof value === 'object')
        {
            const proto = Object.getPrototypeOf(value);
            if (proto !== Object.prototype && proto !== null) throw new CypherSemanticError(ParameterBinder.Unsupported);
            const record = value as { readonly [key: string]: ParameterValue };
            const tagged = ParameterBinder.Float(record) ?? ParameterBinder.Temporal(record);
            if (tagged !== undefined) return tagged;
            const entries = new Map<string, CypherValue>();
            for (const [k, v] of Object.entries(record)) entries.set(k, ParameterBinder.FromInput(v));
            return new MapValue(entries);
        }
        return new ScalarValue(value as string | boolean);
    }

    public static FromInputMap(parameters: ReadonlyMap<string, ParameterValue>): ReadonlyMap<string, CypherValue>
    {
        const out = new Map<string, CypherValue>();
        for (const [name, value] of parameters) out.set(name, ParameterBinder.FromInput(value));
        return out;
    }

    // A { $float } wrapper object, or undefined when the object has no $float key.
    private static Float(record: { readonly [key: string]: ParameterValue }): ScalarValue | undefined
    {
        const keys = Object.keys(record);
        if (!keys.includes(CypherCellCodec.FloatKey)) return undefined;
        const text = record[CypherCellCodec.FloatKey];
        const value = typeof text === 'string' && keys.length === 1 ? ScalarSemantics.ParseNonFinite(text) : undefined;
        if (value === undefined) throw new CypherSemanticError(ParameterBinder.MalformedFloat + CypherCellCodec.FloatKey);
        return new ScalarValue(value);
    }

    // A temporal wrapper object, or undefined when the object is an ordinary map.
    private static Temporal(record: { readonly [key: string]: ParameterValue }): ScalarValue | undefined
    {
        const keys = Object.keys(record);
        if (keys.includes(ParameterBinder.DateKey))
        {
            return new ScalarValue(TemporalText.ParseDate(ParameterBinder.Text(record, ParameterBinder.DateKey, keys, [])));
        }
        if (keys.includes(ParameterBinder.DateTimeKey))
        {
            const text = ParameterBinder.Text(record, ParameterBinder.DateTimeKey, keys, [ParameterBinder.ZoneKey]);
            // An absent zone defaults to UTC; a present one (null included) must be a string.
            const zone = Object.hasOwn(record, ParameterBinder.ZoneKey) ? record[ParameterBinder.ZoneKey] : ParameterBinder.DefaultZone;
            if (typeof zone !== 'string') throw new CypherSemanticError(ParameterBinder.MalformedTemporal + ParameterBinder.ZoneKey);
            return new ScalarValue(TemporalText.ParseDateTime(text, zone));
        }
        if (keys.includes(ParameterBinder.DurationKey))
        {
            return new ScalarValue(TemporalText.ParseDuration(ParameterBinder.Text(record, ParameterBinder.DurationKey, keys, [])));
        }
        return undefined;
    }

    // The string under the wrapper key; the object may carry no keys beyond it and the allowed extras.
    private static Text(record: { readonly [key: string]: ParameterValue }, key: string, keys: readonly string[], extras: readonly string[]): string
    {
        const text = record[key];
        if (typeof text !== 'string' || keys.some((k) => k !== key && !extras.includes(k)))
        {
            throw new CypherSemanticError(ParameterBinder.MalformedTemporal + key);
        }
        return text;
    }
}
