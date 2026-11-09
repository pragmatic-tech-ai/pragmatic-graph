import { Binding, EvalContext } from '../Binding.js';
import { NullValue, type CypherValue } from '../CypherValue.js';
import type { ReturnItem } from '../CypherQueryModel.js';
import type { FunctionCall } from '../Expression.js';
import { CancelProbe, type ICancellation } from '../ExecutionLimits.js';
import { GroupState } from './GroupState.js';
import type { IOperator } from './IOperator.js';

export interface AggregateItem
{
    readonly Column: string;
    readonly Call: FunctionCall;
}

/**
 * Groups rows by the grouping items (equivalence keys, R81 e) and folds each aggregate item per group. Groups
 * emit in first-seen order; no input and no grouping still yields one row of empty results.
 */
export class Aggregate implements IOperator
{
    private static readonly EmptyGroupKey = '';

    constructor(
        private readonly child: IOperator,
        private readonly groupingItems: readonly ReturnItem[],
        private readonly aggregateItems: readonly AggregateItem[],
        private readonly parameters: ReadonlyMap<string, CypherValue>,
        private readonly cancel?: ICancellation,
    )
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        const groups = new Map<string, GroupState>();
        const probe = new CancelProbe(this.cancel);
        probe.Begin();
        for await (const row of this.child.Rows())
        {
            probe.Tick();
            const ctx = new EvalContext(row, this.parameters);
            const values = this.groupingItems.map((i) => i.Expr.Evaluate(ctx));
            const key = JSON.stringify(values.map((v) => v.GroupKey()));
            let state = groups.get(key);
            if (state === undefined)
            {
                state = new GroupState(values, this.aggregateItems);
                groups.set(key, state);
            }
            this.Accumulate(state, ctx);
        }
        if (groups.size === 0 && this.groupingItems.length === 0)
        {
            groups.set(Aggregate.EmptyGroupKey, new GroupState([], this.aggregateItems));
        }
        for (const state of groups.values())
        {
            yield this.Emit(state);
        }
    }

    private Accumulate(state: GroupState, ctx: EvalContext): void
    {
        for (let i = 0; i < this.aggregateItems.length; i++)
        {
            const call = this.aggregateItems[i]!.Call;
            const value = call.Star || call.Args.length === 0 ? NullValue.Instance : call.Args[0]!.Evaluate(ctx);
            if (call.Distinct && !call.Star)
            {
                const gk = value.GroupKey();
                if (state.Seen[i]!.has(gk))
                {
                    continue;
                }
                state.Seen[i]!.add(gk);
            }
            state.Aggregators[i]!.Accept(value);
        }
    }

    private Emit(state: GroupState): Binding
    {
        let out = new Binding();
        for (let i = 0; i < this.groupingItems.length; i++)
        {
            out = out.With(this.groupingItems[i]!.ColumnName(), state.GroupValues[i]!);
        }
        for (let i = 0; i < this.aggregateItems.length; i++)
        {
            out = out.With(this.aggregateItems[i]!.Column, state.Aggregators[i]!.Result());
        }
        return out;
    }

    public Inputs(): readonly IOperator[]
    {
        return [this.child];
    }
}
