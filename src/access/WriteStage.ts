/** Which ReadOnly set of a Writes entry a member write is checked against (ruling R92). */
export enum WriteStage
{
    /** The written node is one the batch creates. */
    Create = 1,
    /** The written node exists in the snapshot. */
    Update = 2,
}
