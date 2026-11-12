/**
 * How a GraphTransaction's connector participation ended (rulings R137 E6, R138 E7). One of these is reported on
 * ConnectorApplied, once per transaction, at its end.
 */
export enum ConnectorOutcome
{
    /** The engine commit (and every connector finalize) succeeded. */
    Committed = 1,
    /** A failure or abort whose external steps were all undone (or reverted). */
    Compensated = 2,
    /** A compensation of that failure or abort itself failed; the source may hold residue (ruling R137 E6). */
    CompensationFailed = 3,
}

/**
 * One GraphTransaction's connector participation, raised on GraphEngine.ConnectorApplied once, at the transaction's end
 * (ruling R138 E7), Mirrored and External connectors alike: how change push (spec §8) learns about writes that never
 * reach engine storage. A transaction with no connector participation raises none. Subscribe-only; a throwing
 * subscriber never affects the commit.
 */
export interface IConnectorApplied
{
    /** The engine commit, when the batch also had engine ops and the transaction committed; undefined otherwise. */
    readonly Commit?: bigint;
    /** Per participating connector (in name order), the distinct concepts its change set touched, sorted. */
    readonly Connectors: ReadonlyMap<string, readonly string[]>;
    /** How the participation ended: Committed, Compensated or CompensationFailed (ruling R137 E6). */
    readonly Outcome: ConnectorOutcome;
}
