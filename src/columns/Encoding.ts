/** Chunk encoding ids (seam 9). The ids are fixed forever: they are the first byte of every column chunk. */
export enum Encoding
{
    Plain = 0,
    BitPacked = 1,
    Dictionary = 2,
}
