import type { Binding } from '../Binding.js';
import { CancelProbe, type ICancellation } from '../ExecutionLimits.js';
import type { IOperator } from '../operators/IOperator.js';
import type { OverlaySource } from './OverlaySource.js';

/**
 * Drains its input completely before yielding a row, then yields every row refreshed through the overlay
 * (deleted nodes become null, touched nodes their current state). Placed around every write clause, so each read
 * feeding a write finishes before the write starts (no Halloween re-reads of its own effects) and the write
 * finishes before anything above reads: openCypher's clause-at-a-time semantics (the Eager operator of Neo4j).
 */
export class EagerBarrier implements IOperator
{
    constructor(private readonly child: IOperator, private readonly view: OverlaySource, private readonly cancel?: ICancellation)
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        const buffered: Binding[] = [];
        const probe = new CancelProbe(this.cancel);
        probe.Begin();
        for await (const row of this.child.Rows())
        {
            probe.Tick();
            buffered.push(row);
        }
        for (const row of buffered) yield this.view.RefreshRow(row);
    }

    public Inputs(): readonly IOperator[]
    {
        return [this.child];
    }
}
