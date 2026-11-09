import { DateTimeValue, DateValue, type CellValue } from './CellValue.js';

/**
 * The ordering rules shared by everything that compares cell values (predicates, the query layer):
 * Int64 vs Float64 compare numerically (exact mathematical values; NaN compares with nothing);
 * strings by UTF-8 byte order (lone surrogates encode as U+FFFD, as TupleCodec does); booleans
 * false < true; Dates by day; DateTimes by Micros (zone ignored). Date and DateTime are distinct
 * types, and Durations have no order (only equality, see DurationValue.Equals).
 */
export class CellOrder
{
    /** Negative/zero/positive ordering of two non-null values, or undefined when they are not comparable. */
    public static Order(a: CellValue, b: CellValue): number | undefined
    {
        if ((typeof a === 'bigint' || typeof a === 'number') && (typeof b === 'bigint' || typeof b === 'number'))
        {
            if (Number.isNaN(a) || Number.isNaN(b))
            {
                return undefined;
            }
            // Mixed bigint/number relational operators in JS compare the exact mathematical values.
            return a < b ? -1 : a > b ? 1 : 0;
        }
        if (typeof a === 'string' && typeof b === 'string')
        {
            return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
        }
        if (typeof a === 'boolean' && typeof b === 'boolean')
        {
            return Number(a) - Number(b);
        }
        if (a instanceof DateValue && b instanceof DateValue)
        {
            return Math.sign(a.Days - b.Days);
        }
        if (a instanceof DateTimeValue && b instanceof DateTimeValue)
        {
            return a.Micros < b.Micros ? -1 : a.Micros > b.Micros ? 1 : 0;
        }
        return undefined;
    }
}
