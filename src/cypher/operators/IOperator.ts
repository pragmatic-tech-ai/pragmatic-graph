import type { Binding } from '../Binding.js';

/** A pull-based query operator: an async stream of rows. Each call to Rows starts a fresh pass. */
export interface IOperator
{
    Rows(): AsyncIterable<Binding>;
}
