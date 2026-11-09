import { DateTimeValue, DateValue, DurationValue } from '../columns/CellValue.js';
import { CypherSemanticError } from './CypherError.js';

/**
 * ISO-8601 text forms of the engine temporal values: parsing for typed query parameters and result cells, and
 * formatting for toString() and the result cell codec. Dates are YYYY-MM-DD; instants are
 * YYYY-MM-DDThh:mm[:ss[.fraction]] with Z or a +hh:mm offset (fraction truncated to microseconds; formatted in
 * UTC, toString() followed by the [zone]); durations are [-]P[nY][nM][nW][nD][T[nH][nM][n[.fraction]S]] with
 * each component optionally signed when there is no outer sign, one sign per group (Y/M, W/D, H/M/S): a duration
 * whose months, days and time differ in sign formats that way. Years may be
 * negative or longer than four digits (ISO-8601 expanded form), so every engine Date and DateTime formats and
 * parses back exactly: calendar arithmetic is proleptic Gregorian on plain integers, not on the JS Date range.
 */
export class TemporalText
{
    private static readonly DatePattern = /^([+-]?\d{4,})-(\d{2})-(\d{2})$/;
    private static readonly DateTimePattern = /^([+-]?\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/i;
    private static readonly DurationPattern = /^([+-])?P(?:([+-]?\d+)Y)?(?:([+-]?\d+)M)?(?:([+-]?\d+)W)?(?:([+-]?\d+)D)?(?:T(?:([+-]?\d+)H)?(?:([+-]?\d+)M)?(?:([+-]?)(\d+)(?:\.(\d{1,9}))?S)?)?$/i;
    private static readonly BadDate = 'invalid date (expected YYYY-MM-DD): ';
    private static readonly BadDateTime = 'invalid datetime (expected an ISO-8601 instant with Z or an offset): ';
    private static readonly BadZone = 'unknown time zone: ';
    private static readonly BadOffset = 'invalid UTC offset (hours at most 18, minutes at most 59): ';
    private static readonly BadDuration = 'invalid duration (expected ISO-8601 PnYnMnDTnHnMnS): ';
    private static readonly MicrosPerSecond = 1_000_000n;
    private static readonly MicrosPerMinute = 60_000_000n;
    private static readonly MicrosPerHour = 3_600_000_000n;
    private static readonly MicrosPerDay = 86_400_000_000n;
    private static readonly MonthsPerYear = 12;
    private static readonly DaysPerWeek = 7;
    private static readonly HoursPerDay = 24;
    private static readonly MinutesPerHourNumber = 60;
    private static readonly SecondsPerMinute = 60;
    private static readonly Int32Min = -(2 ** 31);
    private static readonly Int32Max = 2 ** 31 - 1;
    private static readonly Int64Min = -(2n ** 63n);
    private static readonly Int64Max = 2n ** 63n - 1n;
    // Proleptic Gregorian day arithmetic (H. Hinnant's days-from-civil / civil-from-days).
    private static readonly DaysPerEra = 146_097;
    private static readonly YearsPerEra = 400;
    private static readonly EpochShift = 719_468;
    private static readonly MicroDigits = 6;
    private static readonly Utc = 'Z';
    private static readonly Minus = '-';
    private static readonly SignChars = '+-';
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
        const days = m === null ? undefined : TemporalText.Days(Number(m[1]), Number(m[2]), Number(m[3]));
        if (days === undefined || days < TemporalText.Int32Min || days > TemporalText.Int32Max)
        {
            throw new CypherSemanticError(TemporalText.BadDate + text);
        }
        return new DateValue(days);
    }

    public static ParseDateTime(text: string, zone: string): DateTimeValue
    {
        const micros = TemporalText.ParseInstant(text);
        TemporalText.RequireZone(zone);
        return new DateTimeValue(micros, zone);
    }

    /** The UTC epoch microseconds of an ISO-8601 instant (Z or an offset); no zone is involved. */
    public static ParseInstant(text: string): bigint
    {
        const m = TemporalText.DateTimePattern.exec(text);
        const days = m === null ? undefined : TemporalText.Days(Number(m[1]), Number(m[2]), Number(m[3]));
        if (m === null || days === undefined)
        {
            throw new CypherSemanticError(TemporalText.BadDateTime + text);
        }
        const hour = Number(m[4]);
        const minute = Number(m[5]);
        const second = Number(m[6] ?? 0);
        if (hour >= TemporalText.HoursPerDay || minute >= TemporalText.MinutesPerHourNumber || second >= TemporalText.SecondsPerMinute)
        {
            throw new CypherSemanticError(TemporalText.BadDateTime + text);
        }
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
        const micros = BigInt(days) * TemporalText.MicrosPerDay + BigInt(hour) * TemporalText.MicrosPerHour
            + BigInt(minute) * TemporalText.MicrosPerMinute + BigInt(second) * TemporalText.MicrosPerSecond
            + fraction - offsetMinutes * TemporalText.MicrosPerMinute;
        if (micros < TemporalText.Int64Min || micros > TemporalText.Int64Max)
        {
            throw new CypherSemanticError(TemporalText.BadDateTime + text);
        }
        return micros;
    }

    public static ParseDuration(text: string): DurationValue
    {
        const m = TemporalText.DurationPattern.exec(text);
        // At least one component, and a T must be followed by a time component.
        if (m === null || [m[2], m[3], m[4], m[5], m[6], m[7], m[9]].every((g) => g === undefined) || TemporalText.TrailingTimeMarker.test(text)
            || !TemporalText.SignsConsistent(m))
        {
            throw new CypherSemanticError(TemporalText.BadDuration + text);
        }
        const sign = m[1] === TemporalText.Minus ? -1 : 1;
        // `+ 0` folds a -0 (e.g. -P0D) into 0.
        const months = (Number(m[2] ?? 0) * TemporalText.MonthsPerYear + Number(m[3] ?? 0)) * sign + 0;
        const days = (Number(m[4] ?? 0) * TemporalText.DaysPerWeek + Number(m[5] ?? 0)) * sign + 0;
        if (!Number.isSafeInteger(months) || !Number.isSafeInteger(days) || months < TemporalText.Int32Min || months > TemporalText.Int32Max
            || days < TemporalText.Int32Min || days > TemporalText.Int32Max)
        {
            throw new CypherSemanticError(TemporalText.BadDuration + text);
        }
        // The fraction belongs to the seconds and takes their sign, so -0.5S is half a second back.
        const seconds = BigInt(m[9] ?? 0) * TemporalText.MicrosPerSecond + TemporalText.FractionMicros(m[10]);
        const micros = (BigInt(m[6] ?? 0) * TemporalText.MicrosPerHour + BigInt(m[7] ?? 0) * TemporalText.MicrosPerMinute
            + (m[8] === TemporalText.Minus ? -seconds : seconds)) * BigInt(sign);
        if (micros < TemporalText.Int64Min || micros > TemporalText.Int64Max)
        {
            throw new CypherSemanticError(TemporalText.BadDuration + text);
        }
        return new DurationValue(months, days, micros);
    }

    public static FormatDate(value: DateValue): string
    {
        return TemporalText.DatePart(value.Days);
    }

    /** The instant in UTC followed by the [zone] (toString). */
    public static FormatDateTime(value: DateTimeValue): string
    {
        return TemporalText.FormatInstant(value) + TemporalText.ZoneOpen + value.Zone + TemporalText.ZoneClose;
    }

    /** The instant in UTC, YYYY-MM-DDThh:mm:ss[.ffffff]Z, without the zone; ParseInstant reads it back exactly. */
    public static FormatInstant(value: DateTimeValue): string
    {
        let days = value.Micros / TemporalText.MicrosPerDay;
        if (days * TemporalText.MicrosPerDay > value.Micros)
        {
            days -= 1n;
        }
        // Time of day as a floor modulo, so instants before 1970 keep a non-negative time and fraction.
        const rest = value.Micros - days * TemporalText.MicrosPerDay;
        const hours = rest / TemporalText.MicrosPerHour;
        const minutes = (rest % TemporalText.MicrosPerHour) / TemporalText.MicrosPerMinute;
        const seconds = (rest % TemporalText.MicrosPerMinute) / TemporalText.MicrosPerSecond;
        const time = [hours, minutes, seconds].map((n) => TemporalText.Two(Number(n))).join(TemporalText.Colon);
        return TemporalText.DatePart(Number(days)) + TemporalText.TimeMarker + time + TemporalText.Fraction(rest % TemporalText.MicrosPerSecond) + TemporalText.Utc;
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

    /**
     * Component signs are only what FormatDuration emits: none with an outer sign, and within each group that one
     * engine field feeds (years and months; weeks and days; hours, minutes and seconds) one sign for every component.
     */
    private static SignsConsistent(m: RegExpExecArray): boolean
    {
        const groups = [[m[2], m[3]], [m[4], m[5]], [m[6], m[7], m[9] === undefined ? undefined : m[8]! + m[9]]];
        const signed = (c: string | undefined): boolean => c !== undefined && TemporalText.SignChars.includes(c[0]!);
        if (m[1] !== undefined && groups.some((g) => g.some(signed))) return false;
        return groups.every((g) =>
        {
            const present = g.filter((c): c is string => c !== undefined);
            return present.every((c) => c.startsWith(TemporalText.Minus) === present[0]!.startsWith(TemporalText.Minus));
        });
    }

    // Up to nine fraction digits, truncated to microseconds.
    private static FractionMicros(digits: string | undefined): bigint
    {
        return BigInt((digits ?? TemporalText.Empty).padEnd(TemporalText.MicroDigits, TemporalText.Zero).slice(0, TemporalText.MicroDigits));
    }

    // Days since 1970-01-01 of a proleptic Gregorian date, or undefined when a field is out of range (e.g. 2026-02-30).
    private static Days(year: number, month: number, day: number): number | undefined
    {
        if (!Number.isSafeInteger(year) || month < 1 || month > TemporalText.MonthsPerYear || day < 1)
        {
            return undefined;
        }
        const days = TemporalText.DaysFromCivil(year, month, day);
        const [y, m, d] = TemporalText.CivilFromDays(days);
        return y === year && m === month && d === day ? days : undefined;
    }

    private static DaysFromCivil(year: number, month: number, day: number): number
    {
        const y = month <= 2 ? year - 1 : year;
        const era = Math.floor(y / TemporalText.YearsPerEra);
        const yoe = y - era * TemporalText.YearsPerEra;
        const doy = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
        const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
        return era * TemporalText.DaysPerEra + doe - TemporalText.EpochShift;
    }

    // [year, month, day] of a day count since 1970-01-01.
    private static CivilFromDays(days: number): [number, number, number]
    {
        const z = days + TemporalText.EpochShift;
        const era = Math.floor(z / TemporalText.DaysPerEra);
        const doe = z - era * TemporalText.DaysPerEra;
        const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / (TemporalText.DaysPerEra - 1))) / 365);
        const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
        const mp = Math.floor((5 * doy + 2) / 153);
        const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
        const month = mp < 10 ? mp + 3 : mp - 9;
        return [yoe + era * TemporalText.YearsPerEra + (month <= 2 ? 1 : 0), month, day];
    }

    private static DatePart(days: number): string
    {
        const [year, month, day] = TemporalText.CivilFromDays(days);
        const yearText = (year < 0 ? TemporalText.Minus : TemporalText.Empty) + String(Math.abs(year)).padStart(TemporalText.YearDigits, TemporalText.Zero);
        return yearText + TemporalText.DateSeparator + TemporalText.Two(month) + TemporalText.DateSeparator + TemporalText.Two(day);
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
