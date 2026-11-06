import { AccessScope, GraphStore, MemberKind, ValueType } from '../index.js';

/**
 * Child process for the GraphStore durability tests: `commit <dir>` defines the schema, commits one
 * file node and exits; `abandon <dir>` records writes in a transaction and exits without Commit. Both
 * call process.exit without disposing the store, as a crashing or killed process would.
 */
class DurabilityChild
{
    private static readonly CommitMode = 'commit';
    private static readonly AbandonMode = 'abandon';
    private static readonly Ready = 'ready';
    private static readonly ErrUsage = 'usage: DurabilityChild <commit|abandon> <dir>';

    public static async Main(args: readonly string[]): Promise<void>
    {
        const [mode, dir] = args;
        if (dir === undefined || (mode !== DurabilityChild.CommitMode && mode !== DurabilityChild.AbandonMode))
        {
            throw new Error(DurabilityChild.ErrUsage);
        }
        const g = await GraphStore.OpenLmdb(dir);
        if (mode === DurabilityChild.CommitMode)
        {
            await g.DefineSchema(m => m.DefineConcept('file', null, [], [{ Name: 'path', Kind: MemberKind.Property, Type: ValueType.String }]));
            const t = await g.Begin(AccessScope.System);
            t.CreateNode('child', 'file');
            t.SetProperty('child', 'path', '/from-child');
            await t.Commit();
        }
        else
        {
            const t = await g.Begin(AccessScope.System);
            t.CreateNode('orphan', 'file');
            t.SetProperty('orphan', 'path', '/orphan');
            t.SetProperty('child', 'path', '/overwritten');
        }
        process.stdout.write(DurabilityChild.Ready + '\n', () => process.exit(0));
    }
}

await DurabilityChild.Main(process.argv.slice(2));
