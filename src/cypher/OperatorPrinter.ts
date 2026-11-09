import type { IOperator } from './operators/IOperator.js';

/** Renders an operator tree, one line per operator, children indented under their parent. */
export class OperatorPrinter
{
    private static readonly Indent = '  ';
    private static readonly NewLine = '\n';

    public static Print(root: IOperator): string
    {
        const lines: string[] = [];
        OperatorPrinter.Visit(root, 0, lines);
        return lines.join(OperatorPrinter.NewLine);
    }

    private static Visit(op: IOperator, depth: number, lines: string[]): void
    {
        lines.push(OperatorPrinter.Indent.repeat(depth) + (op.Describe?.() ?? op.constructor.name));
        for (const child of op.Inputs?.() ?? [])
        {
            OperatorPrinter.Visit(child, depth + 1, lines);
        }
    }
}
