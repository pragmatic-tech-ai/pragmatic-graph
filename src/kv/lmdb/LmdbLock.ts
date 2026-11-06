import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';

/**
 * Exclusive writer lock on one LMDB environment directory (ruling F9): the file `graph.lock` in the
 * directory holds the owning process id. A second LmdbStore on the same directory, in this process or
 * another live one, is refused with GraphError Locked, so two single-writer committers can never
 * interleave commit numbers. A lock whose process is gone (a crash, or an exit without dispose) is
 * stale and is taken over. Taking over a stale lock is not atomic across two processes racing for it;
 * that window is accepted in v1.
 */
export class LmdbLock
{
    public static readonly FileName = 'graph.lock';
    private static readonly Held = new Set<string>();
    private static readonly ErrLocked = 'The graph store is already open for writing by process ';
    private static readonly ErrAt = ' at ';
    private static readonly ExclusiveCreate = 'wx';
    private static readonly AlreadyExists = 'EEXIST';
    private static readonly NoPermission = 'EPERM';
    private static readonly Utf8 = 'utf8';

    private released = false;

    private constructor(private readonly directory: string, private readonly file: string)
    {
    }

    public static Acquire(directory: string): LmdbLock
    {
        const dir = resolve(directory);
        const file = join(dir, LmdbLock.FileName);
        if (LmdbLock.Held.has(dir))
        {
            throw LmdbLock.Locked(process.pid, dir);
        }
        mkdirSync(dir, { recursive: true });
        try
        {
            const fd = openSync(file, LmdbLock.ExclusiveCreate);
            try
            {
                writeSync(fd, String(process.pid));
            }
            finally
            {
                closeSync(fd);
            }
        }
        catch (error)
        {
            if ((error as NodeJS.ErrnoException).code !== LmdbLock.AlreadyExists)
            {
                throw error;
            }
            const owner = Number.parseInt(readFileSync(file, LmdbLock.Utf8), 10);
            if (Number.isInteger(owner) && owner !== process.pid && LmdbLock.IsAlive(owner))
            {
                throw LmdbLock.Locked(owner, dir);
            }
            writeFileSync(file, String(process.pid));
        }
        LmdbLock.Held.add(dir);
        return new LmdbLock(dir, file);
    }

    /** Releases the lock (removes the file while it still names this process). Idempotent. */
    public dispose(): void
    {
        if (this.released)
        {
            return;
        }
        this.released = true;
        LmdbLock.Held.delete(this.directory);
        try
        {
            if (Number.parseInt(readFileSync(this.file, LmdbLock.Utf8), 10) === process.pid)
            {
                rmSync(this.file, { force: true });
            }
        }
        catch
        {
            // Already gone: nothing to release.
        }
    }

    private static IsAlive(pid: number): boolean
    {
        try
        {
            process.kill(pid, 0);
            return true;
        }
        catch (error)
        {
            return (error as NodeJS.ErrnoException).code === LmdbLock.NoPermission;
        }
    }

    private static Locked(pid: number, dir: string): GraphError
    {
        return new GraphError(GraphErrorCode.Locked, LmdbLock.ErrLocked + pid + LmdbLock.ErrAt + dir);
    }
}
