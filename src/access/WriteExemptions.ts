/**
 * Internal: the recorded ops of a transaction's batch that the WriteGate exempts from the scope's member rules,
 * by op index. Defaults: SetProperty ops recorded by GraphTransaction.SetDefault (placement defaults, ruling R91),
 * exempt from Hidden and ReadOnly on a node the batch created. Detaches: Unlink ops recorded by
 * GraphTransaction.DetachUnlink (the edges a DETACH DELETE removes), exempt from ReadOnly when the batch later
 * deletes one of the edge's ends (R92): the Delete rule governs them.
 */
export class WriteExemptions
{
    public static readonly None: WriteExemptions = new WriteExemptions();

    public readonly Defaults = new Set<number>();
    public readonly Detaches = new Set<number>();
}
