import type { IFetchTarget } from '../connectors/FetchContract.js';
import type { IOperator } from './operators/IOperator.js';

/** Renders an operator tree, one line per operator, children indented under their parent. */
export class OperatorPrinter
{
    private static readonly Indent = '  ';
    private static readonly Fetch = 'Fetch ';
    private static readonly Via = ' via ';
    private static readonly NewLine = '\n';

    public static Print(root: IOperator): string
    {
        const lines: string[] = [];
        OperatorPrinter.Visit(root, 0, lines);
        return lines.join(OperatorPrinter.NewLine);
    }

    /** One `Fetch <concept> via <connector>` line per External fetch of a scan (ruling R101). */
    public static FetchLines(targets: readonly IFetchTarget[]): readonly string[]
    {
        return targets.map(t => OperatorPrinter.Fetch + t.Concept + OperatorPrinter.Via + t.Connector);
    }

    private static Visit(op: IOperator, depth: number, lines: string[]): void
    {
        lines.push(OperatorPrinter.Indent.repeat(depth) + (op.Describe?.() ?? op.constructor.name));
        for (const detail of op.Details?.() ?? [])
        {
            lines.push(OperatorPrinter.Indent.repeat(depth + 1) + detail);
        }
        for (const child of op.Inputs?.() ?? [])
        {
            OperatorPrinter.Visit(child, depth + 1, lines);
        }
    }
}
