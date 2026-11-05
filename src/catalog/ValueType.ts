/** Scalar types of properties. Date = days since epoch; DateTime = UTC epoch microseconds plus IANA zone; Duration = months, days, microseconds. */
export enum ValueType
{
    Boolean = 1,
    Int64 = 2,
    Float64 = 3,
    String = 4,
    Date = 5,
    DateTime = 6,
    Duration = 7,
}

export enum MemberKind
{
    Property = 1,
    Relationship = 2,
}
