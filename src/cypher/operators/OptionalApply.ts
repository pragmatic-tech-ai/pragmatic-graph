import type { Binding } from '../Binding.js';
import { NullValue } from '../CypherValue.js';
import type { IOperator } from './IOperator.js';

/** Builds the inner plan of an OPTIONAL MATCH for one outer row. */
export interface IOptionalPlan
{
    Build(row: Binding): IOperator;
}

/** Runs the optional plan per outer row; a row with no match is passed on with the optional variables null. */
export class OptionalApply implements IOperator
{
    constructor(
        private readonly child: IOperator,
        private readonly plan: IOptionalPlan,
        private readonly optionalVars: readonly string[],
    )
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        for await (const row of this.child.Rows())
        {
            let matched = false;
            for await (const out of this.plan.Build(row).Rows())
            {
                matched = true;
                yield out;
            }
            if (!matched)
            {
                let padded = row;
                for (const name of this.optionalVars)
                {
                    padded = padded.With(name, NullValue.Instance);
                }
                yield padded;
            }
        }
    }

    public Inputs(): readonly IOperator[]
    {
        return [this.child];
    }
}
