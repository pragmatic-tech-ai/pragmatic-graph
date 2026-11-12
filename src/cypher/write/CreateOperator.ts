import type { Binding } from '../Binding.js';
import { WriteMode } from '../CypherEnums.js';
import type { CreateClause } from '../CypherQueryModel.js';
import type { ICypherSource } from '../CypherSource.js';
import type { IOperator } from '../operators/IOperator.js';
import { PathCreator } from './PathCreator.js';
import type { ICypherSink } from './CypherSink.js';
import { WriteSupport } from './WriteSupport.js';

/** CREATE (per-row, ruling R135 E1): writes every pattern of the clause for each input row, flushing per row. */
export class CreateOperator implements IOperator
{
    private readonly creator: PathCreator;

    constructor(private readonly child: IOperator, private readonly clause: CreateClause, source: ICypherSource, private readonly sink: ICypherSink, bound: ReadonlySet<string>)
    {
        for (const path of clause.Paths)
        {
            PathCreator.ValidateRels(path);
            PathCreator.ValidateLabels(source, path, bound);
        }
        this.creator = new PathCreator(source, sink);
    }

    public async *Rows(): AsyncIterable<Binding>
    {
        for await (const row of this.child.Rows())
        {
            let current = row;
            for (const path of this.clause.Paths) current = await this.creator.Create(current, path);
            // Per-row write step (ruling R135 E1): the row's external writes execute before it flows on.
            await this.sink.EndStep();
            yield current;
        }
    }

    public Inputs(): readonly IOperator[]
    {
        return [this.child];
    }

    public Details(): readonly string[]
    {
        return [WriteSupport.ModeLabel(WriteMode.PerRow)];
    }
}
