import { AccessScope, GraphEngine, StorageKind } from '../index.js';
import { EngineDescriptions } from './EngineDescriptions.js';

/**
 * Child process for the GraphEngine reopen tests: `seed <dir>` opens an engine on `dir` with
 * EngineDescriptions.V1 (creating and seeding it), commits node n1 with text and extra set and exits
 * without disposing, as a crashing or killed process would. The parent then reopens the directory.
 */
class EngineChild
{
    private static readonly SeedMode = 'seed';
    private static readonly Ready = 'ready';
    private static readonly ErrUsage = 'usage: EngineChild seed <dir>';
    private static readonly Node = 'n1';
    private static readonly Kept = 'kept';
    private static readonly Dropped = 'dropped';

    public static async Main(args: readonly string[]): Promise<void>
    {
        const [mode, dir] = args;
        if (dir === undefined || mode !== EngineChild.SeedMode)
        {
            throw new Error(EngineChild.ErrUsage);
        }
        const engine = await GraphEngine.Open({ Description: EngineDescriptions.V1, Storage: { Kind: StorageKind.Lmdb, Path: dir } });
        const t = await engine.Begin(AccessScope.System);
        t.CreateNode(EngineChild.Node, EngineDescriptions.Note);
        t.SetProperty(EngineChild.Node, EngineDescriptions.Text, EngineChild.Kept);
        t.SetProperty(EngineChild.Node, EngineDescriptions.Extra, EngineChild.Dropped);
        await t.Commit();
        process.stdout.write(EngineChild.Ready + '\n', () => process.exit(0));
    }
}

await EngineChild.Main(process.argv.slice(2));
