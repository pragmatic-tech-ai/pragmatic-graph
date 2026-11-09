import { DateTimeValue, DateValue, DurationValue } from '../columns/CellValue.js';
import { CypherSemanticError } from './CypherError.js';

/**
 * ISO-8601 text forms of the engine temporal values: parsing for typed query parameters and formatting for
 * toString(). Dates are YYYY-MM-DD; instants are YYYY-MM-DDThh:mm[:ss[.fraction]] with Z or a +hh:mm offset
 * (fraction truncated to microseconds; formatted in UTC followed by the [zone]); durations are
 * [-]P[nY][nM][nW][nD][T[nH][nM][n[.fraction]S]].
 */
export class TemporalText
{
    private static readonly DatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
    private static readonly DateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/i;
    private static readonly DurationPattern = /^([+-])?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.(\d{1,9}))?S)?)?$/i;
    private static readonly BadDate = 'invalid date (expected YYYY-MM-DD): ';
    private static readonly BadDateTime = 'invalid datetime (expected an ISO-8601 instant with Z or an offset): ';
    private static readonly BadZone = 'unknown time zone: ';
    private static readonly BadOffset = 'invalid UTC offset (hours at most 18, minutes at most 59): ';
    private static readonly BadDuration = 'invalid duration (expected ISO-8601 PnYnMnDTnHnMnS): ';
    private static readonly MillisPerDay = 86_400_000;
    private static readonly MicrosPerMilli = 1000n;
    private static readonly MicrosPerSecond = 1_000_000n;
    private static readonly MicrosPerMinute = 60_000_000n;
    private static readonly MicrosPerHour = 3_600_000_000n;
    private static readonly MonthsPerYear = 12;
    private static readonly DaysPerWeek = 7;
    private static readonly Int32Max = 2 ** 31 - 1;
    private static readonly MicroDigits = 6;
    private static readonly Utc = 'Z';
    private static readonly Minus = '-';
    private static readonly Zero = '0';
    private static readonly Dot = '.';
    private static readonly ZeroDuration = 'PT0S';
    private static readonly TrailingZeros = /0+$/;
    private static readonly TrailingTimeMarker = /T$/i;
    private static readonly Empty = '';
    private static readonly Colon = ':';
    private static readonly DateSeparator = '-';
    private static readonly DurationMarker = 'P';
    private static readonly TimeMarker = 'T';
    private static readonly YearDesignator = 'Y';
    private static readonly MonthDesignator = 'M';
    private static readonly DayDesignator = 'D';
    private static readonly HourDesignator = 'H';
    private static readonly MinuteDesignator = 'M';
    private static readonly SecondDesignator = 'S';
    private static readonly ZoneOpen = '[';
    private static readonly ZoneClose = ']';
    private static readonly MinutesPerHour = 60n;
    private static readonly MaxOffsetHours = 18n;
    private static readonly MaxOffsetMinutes = 59n;
    private static readonly YearDigits = 4;
    private static readonly FieldDigits = 2;

    public static ParseDate(text: string): DateValue
    {
        const m = TemporalText.DatePattern.exec(text);
        const millis = m === null ? undefined : TemporalText.UtcMillis(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, 0);
        if (millis === undefined)
        {
            throw new CypherSemanticError(TemporalText.BadDate + text);
        }
        return new DateValue(millis / TemporalText.MillisPerDay);
    }

    public static ParseDateTime(text: string, zone: string): DateTimeValue
    {
        const m = TemporalText.DateTimePattern.exec(text);
        const millis = m === null
            ? undefined
            : TemporalText.UtcMillis(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
        if (m === null || millis === undefined)
        {
            throw new CypherSemanticError(TemporalText.BadDateTime + text);
        }
        TemporalText.RequireZone(zone);
        const fraction = TemporalText.FractionMicros(m[7]);
        let offsetMinutes = 0n;
        if (m[9] !== undefined)
        {
            const hours = BigInt(m[10]!);
            const minutes = BigInt(m[11]!);
            if (hours > TemporalText.MaxOffsetHours || minutes > TemporalText.MaxOffsetMinutes)
            {
                throw new CypherSemanticError(TemporalText.BadOffset + text);
            }
            offsetMinutes = (hours * TemporalText.MinutesPerHour + minutes) * (m[9] === TemporalText.Minus ? -1n : 1n);
        }
        const micros = BigInt(millis) * TemporalText.MicrosPerMilli + fraction - offsetMinutes * TemporalText.MicrosPerMinute;
        return new DateTimeValue(micros, zone);
    }

    public static ParseDuration(text: string): DurationValue
    {
        const m = TemporalText.DurationPattern.exec(text);
        // At least one component, and a T must be followed by a time component.
        if (m === null || m.slice(2, 10).every((g) => g === undefined) || TemporalText.TrailingTimeMarker.test(text))
        {
            throw new CypherSemanticError(TemporalText.BadDuration + text);
        }
        const sign = m[1] === TemporalText.Minus ? -1 : 1;
        const months = (Number(m[2] ?? 0) * TemporalText.MonthsPerYear + Number(m[3] ?? 0)) * sign;
        const days = (Number(m[4] ?? 0) * TemporalText.DaysPerWeek + Number(m[5] ?? 0)) * sign;
        if (Math.abs(months) > TemporalText.Int32Max || Math.abs(days) > TemporalText.Int32Max)
        {
            throw new CypherSemanticError(TemporalText.BadDuration + text);
        }
        const fraction = TemporalText.FractionMicros(m[9]);
        const micros = BigInt(m[6] ?? 0) * TemporalText.MicrosPerHour + BigInt(m[7] ?? 0) * TemporalText.MicrosPerMinute
            + BigInt(m[8] ?? 0) * TemporalText.MicrosPerSecond + fraction;
        return new DurationValue(months, days, micros * BigInt(sign));
    }

    public static FormatDate(value: DateValue): string
    {
        return TemporalText.DatePart(new Date(value.Days * TemporalText.MillisPerDay));
    }

    public static FormatDateTime(value: DateTimeValue): string
    {
        let millis = value.Micros / TemporalText.MicrosPerMilli;
        if (millis * TemporalText.MicrosPerMilli > value.Micros)
        {
            millis -= 1n;
        }
        const date = new Date(Number(millis));
        // Sub-second part as a floor modulo, so instants before 1970 keep a non-negative fraction.
        const fractionMicros = ((value.Micros % TemporalText.MicrosPerSecond) + TemporalText.MicrosPerSecond) % TemporalText.MicrosPerSecond;
        const fraction = TemporalText.Fraction(fractionMicros);
        const time = [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()].map((n) => TemporalText.Two(n)).join(TemporalText.Colon);
        return TemporalText.DatePart(date) + TemporalText.TimeMarker + time + fraction + TemporalText.Utc
            + TemporalText.ZoneOpen + value.Zone + TemporalText.ZoneClose;
    }

    public static FormatDuration(value: DurationValue): string
    {
        const years = Math.trunc(value.Months / TemporalText.MonthsPerYear);
        const months = value.Months % TemporalText.MonthsPerYear;
        let out = TemporalText.DurationMarker;
        if (years !== 0) out += years + TemporalText.YearDesignator;
        if (months !== 0) out += months + TemporalText.MonthDesignator;
        if (value.Days !== 0) out += value.Days + TemporalText.DayDesignator;
        if (value.Micros !== 0n)
        {
            const negative = value.Micros < 0n;
            const abs = negative ? -value.Micros : value.Micros;
            const sign = negative ? TemporalText.Minus : TemporalText.Empty;
            const hours = abs / TemporalText.MicrosPerHour;
            const minutes = (abs % TemporalText.MicrosPerHour) / TemporalText.MicrosPerMinute;
            const rest = abs % TemporalText.MicrosPerMinute;
            out += TemporalText.TimeMarker;
            if (hours !== 0n) out += sign + hours + TemporalText.HourDesignator;
            if (minutes !== 0n) out += sign + minutes + TemporalText.MinuteDesignator;
            if (rest !== 0n)
            {
                const seconds = rest / TemporalText.MicrosPerSecond;
                const fractionMicros = rest % TemporalText.MicrosPerSecond;
                out += sign + seconds + TemporalText.Fraction(fractionMicros) + TemporalText.SecondDesignator;
            }
        }
        return out === TemporalText.DurationMarker ? TemporalText.ZeroDuration : out;
    }

    private static RequireZone(zone: string): void
    {
        if (zone.length === 0)
        {
            throw new CypherSemanticError(TemporalText.BadZone + zone);
        }
        try
        {
            new Intl.DateTimeFormat(undefined, { timeZone: zone });
        }
        catch
        {
            throw new CypherSemanticError(TemporalText.BadZone + zone);
        }
    }

    // Up to nine fraction digits, truncated to microseconds.
    private static FractionMicros(digits: string | undefined): bigint
    {
        return BigInt((digits ?? TemporalText.Empty).padEnd(TemporalText.MicroDigits, TemporalText.Zero).slice(0, TemporalText.MicroDigits));
    }

    // UTC epoch milliseconds of a calendar date and time, or undefined when a field is out of range (e.g. 2026-02-30).
    private static UtcMillis(year: number, month: number, day: number, hour: number, minute: number, second: number): number | undefined
    {
        const d = new Date(0);
        d.setUTCFullYear(year, month - 1, day);
        d.setUTCHours(hour, minute, second, 0);
        const valid = d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
            && d.getUTCHours() === hour && d.getUTCMinutes() === minute && d.getUTCSeconds() === second;
        return valid ? d.getTime() : undefined;
    }

    private static DatePart(d: Date): string
    {
        const year = d.getUTCFullYear();
        const yearText = (year < 0 ? TemporalText.Minus : TemporalText.Empty) + String(Math.abs(year)).padStart(TemporalText.YearDigits, TemporalText.Zero);
        return yearText + TemporalText.DateSeparator + TemporalText.Two(d.getUTCMonth() + 1) + TemporalText.DateSeparator + TemporalText.Two(d.getUTCDate());
    }

    // '.ffffff' with trailing zeros dropped, or '' for a whole second.
    private static Fraction(micros: bigint): string
    {
        if (micros === 0n)
        {
            return TemporalText.Empty;
        }
        return TemporalText.Dot + String(micros).padStart(TemporalText.MicroDigits, TemporalText.Zero).replace(TemporalText.TrailingZeros, TemporalText.Empty);
    }

    private static Two(n: number): string
    {
        return String(n).padStart(TemporalText.FieldDigits, TemporalText.Zero);
    }
}
