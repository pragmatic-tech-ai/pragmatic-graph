import { AggregatorFactory, type IAggregator } from '../AggregatorFactory.js';
import type { CypherValue } from '../CypherValue.js';
import type { AggregateItem } from './Aggregate.js';

/** One group of an Aggregate: its grouping values, one aggregator per aggregate item, and DISTINCT seen-sets. */
export class GroupState
{
    public readonly Aggregators: IAggregator[];
    public readonly Seen: Set<string>[];

    constructor(public readonly GroupValues: readonly CypherValue[], items: readonly AggregateItem[])
    {
        this.Aggregators = items.map((i) => AggregatorFactory.Create(i.Call.Name, i.Call.Star));
        this.Seen = items.map(() => new Set<string>());
    }
}
