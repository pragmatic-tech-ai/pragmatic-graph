import type { Binding } from '../Binding.js';
import { CancelProbe, type ICancellation } from '../ExecutionLimits.js';
import type { IOperator } from './IOperator.js';

/** Every left row merged with every right row; pairs disagreeing on a shared variable are dropped. */
export class CartesianProduct implements IOperator
{
    constructor(
        private readonly left: IOperator,
        private readonly right: IOperator,
        private readonly cancel?: ICancellation,
    )
    {
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        // Right is re-scanned per left row; buffer it since a pass is single-use. It is buffered at the FIRST left
        // row, not up front: a write clause under the left side has then completed before the right side reads the
        // graph, and an empty left side never scans the right at all.
        const probe = new CancelProbe(this.cancel);
        probe.Begin();
        let rights: Binding[] | undefined;
        for await (const l of this.left.Rows())
        {
            rights ??= await this.BufferRight(probe);
            for (const r of rights)
            {
                probe.Tick();
                const merged = l.Merge(r);
                if (merged !== undefined)
                {
                    yield merged;
                }
            }
        }
    }

    private async BufferRight(probe: CancelProbe): Promise<Binding[]>
    {
        const rights: Binding[] = [];
        for await (const r of this.right.Rows())
        {
            probe.Tick();
            rights.push(r);
        }
        return rights;
    }

    public Inputs(): readonly IOperator[]
    {
        return [this.left, this.right];
    }
}
