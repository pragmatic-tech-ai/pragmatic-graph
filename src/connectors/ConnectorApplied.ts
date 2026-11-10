/**
 * One successful write-through (ruling R103, controller ruling P13), raised on GraphEngine.ConnectorApplied once every
 * participating connector committed, Mirrored and External alike: how change push (spec §8) learns about writes that
 * never reach engine storage. Subscribe-only; a throwing subscriber never affects the commit.
 */
export interface IConnectorApplied
{
    /** The engine commit, when the batch also had engine ops; undefined for a write-through of external ops only. */
    readonly Commit?: bigint;
    /** Per participating connector (in name order), the distinct concepts its change set touched, sorted. */
    readonly Connectors: ReadonlyMap<string, readonly string[]>;
}
