/**
 * Scalar types of properties. Date = days since epoch; DateTime = UTC epoch microseconds plus IANA zone; Duration =
 * months, days, microseconds.
 */
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

/**
 * Where a concept's instances live (seam 3): Replicated concepts (ontology core, taxonomies) are copied to
 * every partition; Partitioned ones (instance data) live in one partition each. All data is in
 * partition 0 in v1, but the catalog records the choice.
 */
export enum Placement
{
    Replicated = 1,
    Partitioned = 2,
}

export enum MemberKind
{
    Property = 1,
    Relationship = 2,
}
