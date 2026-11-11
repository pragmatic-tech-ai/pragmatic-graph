import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AccessDefault, AccessScope, BindingTable, CommitError, CommitErrorCode, ConnectorError, ConnectorPhase, EdgeError, EdgeErrorCode, IdIn, MemberKind, type MemberInput } from '../../index.js';
import { CommitErrorRedactor } from '../../txn/CommitErrorRedactor.js';
import { CypherWriteError, CypherWriteErrorCode } from '../CypherError.js';
import { CypherFixture as F } from './CypherFixture.js';
import { WriteFixture as W } from './WriteFixture.js';

/**
 * Project { code (unique ProjectCode), name }; Person { name, manager -> Person (single-valued) }. Seed: proj-shown (A),
 * proj-hidden (B), person-a/-b/-hidden and person-a -manager-> person-hidden. Hiding shows proj-shown, person-a and person-b.
 */
class ScopedCommitFx
{
    public static readonly Project = 'Project';
    public static readonly Person = 'Person';
    public static readonly Code = 'code';
    public static readonly Name = 'name';
    public static readonly Manager = 'manager';
    public static readonly NameA = 'a';
    public static readonly NameB = 'b';
    public static readonly NameHidden = 'h';
    public static readonly Shown = 'proj-shown';
    public static readonly Hidden = 'proj-hidden';
    public static readonly Fresh = 'proj-new';
    public static readonly HiddenValue = 'B';
    public static readonly PersonA = 'person-a';
    public static readonly PersonB = 'person-b';
    public static readonly PersonHidden = 'person-hidden';
    public static readonly Redacted = 'Public id already exists';
    public static readonly Cardinality = 'the relationship allows one outgoing edge per node';
    public static readonly Reassign = `MATCH (x:Person {name: '${ScopedCommitFx.NameA}'}), (y:Person {name: '${ScopedCommitFx.NameB}'}) SET x.manager = y`;

    public static Open(): Promise<F>
    {
        const manager: MemberInput = { Name: ScopedCommitFx.Manager, Kind: MemberKind.Relationship, Targets: [ScopedCommitFx.Person], Many: false, Ordered: false };
        return F.Open(
            [F.Concept(ScopedCommitFx.Project, [F.Text(ScopedCommitFx.Code), F.Text(ScopedCommitFx.Name)]), F.Concept(ScopedCommitFx.Person, [F.Text(ScopedCommitFx.Name), manager])],
            [
                F.Node(ScopedCommitFx.Shown, ScopedCommitFx.Project, { code: 'A' }),
                F.Node(ScopedCommitFx.Hidden, ScopedCommitFx.Project, { code: ScopedCommitFx.HiddenValue }),
                F.Node(ScopedCommitFx.PersonA, ScopedCommitFx.Person, { name: ScopedCommitFx.NameA }, [[ScopedCommitFx.Manager, ScopedCommitFx.PersonHidden]]),
                F.Node(ScopedCommitFx.PersonB, ScopedCommitFx.Person, { name: ScopedCommitFx.NameB }),
                F.Node(ScopedCommitFx.PersonHidden, ScopedCommitFx.Person, { name: ScopedCommitFx.NameHidden }),
            ],
            [{ Name: 'ProjectCode', On: ScopedCommitFx.Project, Members: [ScopedCommitFx.Code], Unique: true }]);
    }

    public static Hiding(): AccessScope
    {
        return AccessScope.Build({
            Default: AccessDefault.Allow,
            Rows: new Map([
                [ScopedCommitFx.Project, new IdIn(new Set([ScopedCommitFx.Shown]))],
                [ScopedCommitFx.Person, new IdIn(new Set([ScopedCommitFx.PersonA, ScopedCommitFx.PersonB]))],
            ]),
        });
    }

    public static async CommitFailure(fx: F, scope: AccessScope, work: (t: Awaited<ReturnType<F['Engine']['Begin']>>) => void): Promise<unknown>
    {
        const t = await fx.Engine.Begin(scope);
        work(t);
        try
        {
            await t.Commit();
        }
        catch (error)
        {
            return error;
        }
        return assert.fail('the commit was expected to fail');
    }
}

describe('commit errors under a read-restricting scope', () =>
{
    let fx: F;
    before(async () => { fx = await ScopedCommitFx.Open(); });
    after(async () => { await fx.dispose(); });

    test('a unique conflict with a hidden record names neither value nor id', async () =>
    {
        const X = ScopedCommitFx;
        const error = await X.CommitFailure(fx, X.Hiding(), t =>
        {
            t.CreateNode(X.Fresh, X.Project);
            t.SetProperty(X.Fresh, X.Code, X.HiddenValue);
        });
        assert.ok(error instanceof CommitError);
        assert.equal(error.Code, CommitErrorCode.UniqueViolation);
        assert.ok(!error.message.includes(X.HiddenValue) && !error.message.includes(X.Hidden), error.message);
        assert.equal(error.cause, undefined);
    });

    test('a duplicate public id of a hidden record carries no id', async () =>
    {
        const X = ScopedCommitFx;
        const error = await X.CommitFailure(fx, X.Hiding(), t => t.CreateNode(X.Hidden, X.Project));
        assert.ok(error instanceof CommitError);
        assert.equal(error.Code, CommitErrorCode.DuplicatePublicId);
        assert.equal(error.message, X.Redacted);
        assert.equal(error.cause, undefined);
    });

    test('a cardinality conflict with a hidden edge carries no ids', async () =>
    {
        const X = ScopedCommitFx;
        let error: unknown;
        try
        {
            await W.Write(fx, X.Reassign, { Scope: X.Hiding() });
        }
        catch (e)
        {
            error = e;
        }
        assert.ok(error instanceof CypherWriteError);
        assert.equal(error.WriteCode, CypherWriteErrorCode.Invalid);
        assert.equal(error.message, 'the write was rejected by the graph: Edge rejected: ' + X.Cardinality);
        const commit = error.cause;
        assert.ok(commit instanceof CommitError);
        assert.equal(commit.Code, CommitErrorCode.InvalidEdge);
        const edge = commit.cause;
        assert.ok(edge instanceof EdgeError);
        assert.equal(edge.Code, EdgeErrorCode.CardinalityExceeded);
        assert.equal(edge.message, X.Cardinality);
        for (const message of [error.message, commit.message, edge.message])
        {
            assert.ok(!message.includes('person-') && !/\d/.test(message), message);
        }
    });

    test('System keeps detailed commit errors', async () =>
    {
        const X = ScopedCommitFx;
        const error = await X.CommitFailure(fx, AccessScope.System, t => t.CreateNode(X.Hidden, X.Project));
        assert.ok(error instanceof CommitError);
        assert.ok(error.message.includes(X.Hidden), error.message);
    });
});

describe('CommitErrorRedactor.RedactAny', () =>
{
    test('redacts a CommitError behind a ConnectorError and inside an AggregateError', () =>
    {
        const leaky = (): CommitError => new CommitError(CommitErrorCode.DuplicatePublicId, ScopedCommitFx.Redacted + ': ' + ScopedCommitFx.Hidden);
        const wrapped = CommitErrorRedactor.RedactAny(new ConnectorError(BindingTable.EngineStorage, ConnectorPhase.Finalize, leaky()));
        assert.ok(wrapped instanceof ConnectorError);
        assert.equal(wrapped.Phase, ConnectorPhase.Finalize);
        assert.equal((wrapped.cause as CommitError).message, ScopedCommitFx.Redacted);
        const reverted = CommitErrorRedactor.RedactAny(new ConnectorError(BindingTable.EngineStorage, ConnectorPhase.Finalize, new AggregateError([leaky(), new Error('x')], 'reverts')));
        const members = ((reverted as ConnectorError).cause as AggregateError).errors;
        assert.equal((members[0] as CommitError).message, ScopedCommitFx.Redacted);
        assert.equal((members[1] as Error).message, 'x');
    });
});
