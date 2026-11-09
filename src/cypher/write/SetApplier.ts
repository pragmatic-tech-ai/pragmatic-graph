import type { Binding } from '../Binding.js';
import { SetMode } from '../CypherEnums.js';
import { CypherSemanticError } from '../CypherError.js';
import type { SetItem } from '../CypherQueryModel.js';
import { NodeValue, NullValue, ScalarValue, type CypherValue } from '../CypherValue.js';
import { MapValue } from '../StructuredValues.js';
import type { TransactionSink } from './TransactionSink.js';
import { WriteSupport } from './WriteSupport.js';

/**
 * Applies SET items (SET n.p = v / n += {map} / n = {map}) to the bound node. Shared by SET and by MERGE's
 * ON CREATE / ON MATCH actions so both write identically. Each item returns the row refreshed through the
 * overlay, so a later item of the same SET sees the earlier one.
 */
export class SetApplier
{
    constructor(private readonly sink: TransactionSink, private readonly parameters: ReadonlyMap<string, CypherValue>)
    {
    }

    public async Apply(row: Binding, item: SetItem): Promise<Binding>
    {
        const id = WriteSupport.RequiredNodeId(row, item.Variable);
        if (id === undefined) return row;
        const value = WriteSupport.Eval(item.Value, row, this.parameters);
        if (item.Mode === SetMode.Property && item.Property !== undefined)
        {
            await this.Assign(id, item.Property, value);
            return this.sink.View.RefreshRow(row);
        }
        if (value instanceof NullValue) return row;
        if (!(value instanceof MapValue))
        {
            throw new CypherSemanticError(item.Mode === SetMode.Replace ? WriteSupport.ReplaceNotMap : WriteSupport.MergeMapNotMap);
        }
        if (item.Mode === SetMode.Replace) await this.RemoveUnlisted(id, value);
        for (const [name, entry] of value.Entries) await this.Assign(id, name, entry);
        return this.sink.View.RefreshRow(row);
    }

    /**
     * SET n = {map}: every property of the node (as the query now sees it, so also a node created earlier in
     * the query) that is set and not in the map is set to null. Relationships are untouched.
     */
    private async RemoveUnlisted(id: string, map: MapValue): Promise<void>
    {
        const node = await this.sink.View.Node(id);
        if (node === undefined) return;
        for (const [name, value] of node.Properties)
        {
            if (value !== null && !map.Entries.has(name)) await this.sink.RemoveProperty(id, name);
        }
    }

    private async Assign(id: string, name: string, value: CypherValue): Promise<void>
    {
        if (value instanceof NullValue)
        {
            await this.sink.RemoveProperty(id, name);
        }
        else if (value instanceof NodeValue)
        {
            await this.sink.ReplaceRelationship(id, name, value.Id);
        }
        else if (value instanceof ScalarValue)
        {
            await this.sink.SetProperty(id, name, value.Value);
        }
        else
        {
            throw new CypherSemanticError(WriteSupport.NotAScalar);
        }
    }
}
