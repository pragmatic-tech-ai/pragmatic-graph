/** Where a node's cells live. Internal ids never encode this (seam 2); the row index maps id to it. */
export interface Location
{
    readonly Partition: number;
    readonly TypeId: number;
    readonly Slot: number;
}
