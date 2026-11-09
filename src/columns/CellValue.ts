/** A calendar date: days since 1970-01-01 (signed 32-bit). */
export class DateValue
{
    public constructor(public readonly Days: number)
    {
        Object.freeze(this);
    }

    public Equals(other: DateValue): boolean
    {
        return this.Days === other.Days;
    }
}

/** An instant as UTC epoch microseconds plus the IANA zone name it is displayed in. */
export class DateTimeValue
{
    public constructor(public readonly Micros: bigint, public readonly Zone: string)
    {
        Object.freeze(this);
    }

    public Equals(other: DateTimeValue): boolean
    {
        return this.Micros === other.Micros && this.Zone === other.Zone;
    }
}

/** A calendar duration: months and days (signed 32-bit each) plus microseconds (signed 64-bit). */
export class DurationValue
{
    public constructor(public readonly Months: number, public readonly Days: number, public readonly Micros: bigint)
    {
        Object.freeze(this);
    }

    public Equals(other: DurationValue): boolean
    {
        return this.Months === other.Months && this.Days === other.Days && this.Micros === other.Micros;
    }
}

/**
 * One cell of a column; temporal values are frozen instances. null is the null cell. Int64 is bigint, Float64 is
 * number.
 */
export type CellValue = boolean | bigint | number | string | DateValue | DateTimeValue | DurationValue | null;
