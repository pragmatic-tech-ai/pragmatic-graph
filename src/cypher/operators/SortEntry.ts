import type { Binding } from '../Binding.js';
import type { CypherValue } from '../CypherValue.js';

/** A buffered row of a Sort with its evaluated sort keys. */
export class SortEntry
{
    constructor(public readonly Row: Binding, public readonly Keys: readonly CypherValue[])
    {
    }
}
