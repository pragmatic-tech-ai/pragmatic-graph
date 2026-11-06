import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GraphError, GraphErrorCode } from '../../errors/GraphError.js';

/**
 * Exclusive writer lock on one LMDB environment directory (ruling F9): the file `graph.lock` in the
 * directory holds the owning process id. A second LmdbStore on the same directory, in this process or
 * another live one, is refused with GraphError Locked, so two single-writer committers can never
 * interleave commit numbers. A lock whose process is gone (a crash, or an exit without dispose) is
 * stale and is taken over. The file is created atomically (exclusive create, pid written and fsynced
 * before close). A lock file that is empty or does not hold a pid (an opener between create and
 * write, or a torn write) counts as held for GraceMs after its last modification, then as stale.
 * Taking over a stale lock is not atomic across two processes racing for it; that window is accepted
 * in v1.
 */
export class LmdbLock
{
    public static readonly FileName = 'graph.lock';
    /** How long an unreadable (empty or non-numeric) lock file is treated as held. */
    public static readonly GraceMs = 10000;
    private static readonly Held = new Set<string>();
    private static readonly ErrLocked = 'The graph store is already open for writing by process ';
    private static readonly ErrAt = ' at ';
    private static readonly ExclusiveCreate = 'wx';
    private static readonly Overwrite = 'w';
    private static readonly AlreadyExists = 'EEXIST';
    private static readonly NoPermission = 'EPERM';
    private static readonly Utf8 = 'utf8';
    private static readonly PidPattern = /^[1-9][0-9]*$/;
    private static readonly UnknownOwner = 'unknown (lock file being written)';

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
            LmdbLock.WritePid(file, LmdbLock.ExclusiveCreate);
        }
        catch (error)
        {
            if ((error as NodeJS.ErrnoException).code !== LmdbLock.AlreadyExists)
            {
                throw error;
            }
            const owner = LmdbLock.ReadPid(file);
            if (owner === undefined)
            {
                if (Date.now() - statSync(file).mtimeMs < LmdbLock.GraceMs)
                {
                    throw LmdbLock.Locked(owner, dir);
                }
            }
            else if (owner !== process.pid && LmdbLock.IsAlive(owner))
            {
                throw LmdbLock.Locked(owner, dir);
            }
            LmdbLock.WritePid(file, LmdbLock.Overwrite);
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
            if (LmdbLock.ReadPid(this.file) === process.pid)
            {
                rmSync(this.file, { force: true });
            }
        }
        catch
        {
            // Already gone: nothing to release.
        }
    }

    /** Opens the file with `flag`, writes this process id and fsyncs it before closing. */
    private static WritePid(file: string, flag: string): void
    {
        const fd = openSync(file, flag);
        try
        {
            writeSync(fd, String(process.pid));
            fsyncSync(fd);
        }
        finally
        {
            closeSync(fd);
        }
    }

    /** The pid the lock file holds, or undefined when it is empty, unreadable or not a positive integer. */
    private static ReadPid(file: string): number | undefined
    {
        let text: string;
        try
        {
            text = readFileSync(file, LmdbLock.Utf8).trim();
        }
        catch
        {
            return undefined;
        }
        return LmdbLock.PidPattern.test(text) ? Number(text) : undefined;
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

    private static Locked(pid: number | undefined, dir: string): GraphError
    {
        return new GraphError(GraphErrorCode.Locked, LmdbLock.ErrLocked + (pid ?? LmdbLock.UnknownOwner) + LmdbLock.ErrAt + dir);
    }
}
