/**
 * Internal: the recorded ops of a transaction's batch that the WriteGate exempts from the scope's member rules,
 * by op index. Defaults: SetProperty ops recorded by GraphTransaction.SetDefault (placement defaults, ruling R91),
 * exempt from Hidden and ReadOnly on a node the batch created. Detaches: Unlink ops recorded by
 * GraphTransaction.DetachUnlink (the edges a DETACH DELETE removes), exempt from ReadOnly and the source's Update
 * rule when the batch later deletes one of the edge's ends (R92, ruling F-a): only the Delete rule governs them.
 * There is no shared empty instance: `None()` returns a fresh one per call, so no caller can mutate another's.
 */
export class WriteExemptions
{
    public readonly Defaults = new Set<number>();
    public readonly Detaches = new Set<number>();

    /** A fresh, empty set of exemptions (per call: the sets are mutable). */
    public static None(): WriteExemptions
    {
        return new WriteExemptions();
    }
}
