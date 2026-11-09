import {
    AccessScope, GraphEngine, MemberKind, StorageKind, ValueType,
    type CellValue, type IBindingDescription, type IDefinitionDescription, type IGraphConnector, type IIndexDescription, type MemberInput, type ISeedNode,
} from '../../index.js';
import type { Binding } from '../Binding.js';
import { CypherParser } from '../CypherParser.js';
import type { CypherValue } from '../CypherValue.js';
import { NodeValue, NullValue, ScalarValue } from '../CypherValue.js';
import type { ICypherSource } from '../CypherSource.js';
import { LogicalPlanner } from '../LogicalPlanner.js';
import type { IOperator } from '../operators/IOperator.js';
import { ReaderSource } from '../ReaderSource.js';
import { RelValue } from '../StructuredValues.js';

/**
 * A real GraphEngine on Memory storage, built from a definitions + seed literal, for the Cypher operator and
 * planner tests. Reads run through a ReaderSource over a scoped GraphReader.
 */
export class CypherFixture
{
    private static readonly Version = 'cypher-fixture';
    private static readonly NoOwner = '';
    private static readonly RelText = '->';

    private constructor(public readonly Engine: GraphEngine)
    {
    }

    /** `bindings` route owners to `connectors` (write-through tests); none by default. */
    public static async Open(
        definitions: readonly IDefinitionDescription[],
        seed: readonly ISeedNode[],
        indexes: readonly IIndexDescription[] = [],
        bindings: readonly IBindingDescription[] = [],
        connectors: readonly IGraphConnector[] = [],
    ): Promise<CypherFixture>
    {
        const engine = await GraphEngine.Open({
            Description: { Version: CypherFixture.Version, Definitions: definitions, Indexes: indexes, Seed: seed, Bindings: bindings },
            Storage: { Kind: StorageKind.Memory },
            Connectors: connectors,
        });
        return new CypherFixture(engine);
    }

    public static Concept(name: string, members: readonly MemberInput[], parent: string | null = null, aspects: readonly string[] = []): IDefinitionDescription
    {
        return { Name: name, IsAspect: false, Parent: parent, Aspects: aspects, Members: members };
    }

    public static Aspect(name: string, members: readonly MemberInput[]): IDefinitionDescription
    {
        return { Name: name, IsAspect: true, Parent: null, Aspects: [], Members: members };
    }

    public static Text(name: string): MemberInput
    {
        return { Name: name, Kind: MemberKind.Property, Type: ValueType.String, Nullable: true };
    }

    public static Int(name: string): MemberInput
    {
        return { Name: name, Kind: MemberKind.Property, Type: ValueType.Int64, Nullable: true };
    }

    public static Required(name: string): MemberInput
    {
        return { Name: name, Kind: MemberKind.Property, Type: ValueType.String, Nullable: false };
    }

    public static Float(name: string): MemberInput
    {
        return { Name: name, Kind: MemberKind.Property, Type: ValueType.Float64, Nullable: true };
    }

    public static Rel(name: string, targets: readonly string[]): MemberInput
    {
        return { Name: name, Kind: MemberKind.Relationship, Targets: targets, Many: true, Ordered: true };
    }

    /** A seed node; links are [relationship, target] pairs. */
    public static Node(id: string, concept: string, properties: Readonly<Record<string, CellValue>> = {}, links: readonly (readonly [string, string])[] = [], owner: string = CypherFixture.NoOwner): ISeedNode
    {
        return { PublicId: id, Concept: concept, Owner: owner, Properties: properties, Links: links.map(([r, to]) => ({ Relationship: r, To: to })) };
    }

    public static async Collect(op: IOperator): Promise<Binding[]>
    {
        const out: Binding[] = [];
        for await (const row of op.Rows())
        {
            out.push(row);
        }
        return out;
    }

    /** A plain view of a Cypher value: node → its id, scalar → its value, null → null, rel → "from-type->to". */
    public static Plain(value: CypherValue | undefined): unknown
    {
        if (value instanceof NodeValue) return value.Id;
        if (value instanceof ScalarValue) return value.Value;
        if (value instanceof NullValue || value === undefined) return null;
        if (value instanceof RelValue) return `${value.FromId}-${value.Type}${CypherFixture.RelText}${value.ToId}`;
        return value;
    }

    /** Runs `work` over a ReaderSource on a fresh reader under `scope`; the reader is disposed afterwards. */
    public async Read<T>(work: (source: ICypherSource) => Promise<T>, scope: AccessScope = AccessScope.System): Promise<T>
    {
        const reader = await this.Engine.BeginRead(scope);
        try
        {
            return await work(new ReaderSource(reader));
        }
        finally
        {
            reader.dispose();
        }
    }

    /** Parses, plans and runs a read query; each row maps the final columns to Plain values. */
    public async Rows(text: string, scope: AccessScope = AccessScope.System, parameters: ReadonlyMap<string, CypherValue> = new Map()): Promise<Map<string, unknown>[]>
    {
        const model = new CypherParser(text).Parse();
        const columns = model.FinalColumns();
        return this.Read(async source =>
        {
            const rows = await CypherFixture.Collect(new LogicalPlanner(source, parameters).Plan(model));
            return rows.map(b => new Map(columns.map(c => [c, CypherFixture.Plain(b.Get(c))])));
        }, scope);
    }

    /** The values of one column, in row order. */
    public async Column(text: string, column: string, scope: AccessScope = AccessScope.System): Promise<unknown[]>
    {
        return (await this.Rows(text, scope)).map(r => r.get(column));
    }

    public dispose(): Promise<void>
    {
        return this.Engine.dispose();
    }
}
