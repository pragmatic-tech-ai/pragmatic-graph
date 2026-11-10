import type { Binding } from '../Binding.js';

/** A pull-based query operator: an async stream of rows. Each call to Rows starts a fresh pass. */
export interface IOperator
{
    Rows(): AsyncIterable<Binding>;
    /** The operators this one reads from (explain output); absent for a leaf. */
    Inputs?(): readonly IOperator[];
    /** The operator name with its salient detail (explain output); the class name when absent. */
    Describe?(): string;
    /** Extra explain lines shown under the operator, before its inputs (the External fetches a scan adds). */
    Details?(): readonly string[];
}
