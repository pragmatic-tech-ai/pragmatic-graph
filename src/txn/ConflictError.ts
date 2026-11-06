/**
 * The transaction's reads were invalidated by a commit after its snapshot (or its snapshot is older
 * than the retained conflict window, which is treated as a conflict). Retrying on a fresh snapshot may
 * succeed.
 */
export class ConflictError extends Error
{
    private static readonly ErrorName = 'ConflictError';

    public constructor(message: string)
    {
        super(message);
        this.name = ConflictError.ErrorName;
    }
}
