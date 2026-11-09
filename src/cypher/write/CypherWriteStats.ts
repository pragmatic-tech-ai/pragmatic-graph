/** The plain shape of CypherWriteStats (result DTOs). */
export interface CypherWriteStatsDto
{
    NodesCreated: number;
    NodesDeleted: number;
    RelationshipsCreated: number;
    RelationshipsDeleted: number;
    PropertiesSet: number;
}

/**
 * What a write query changed, counted as the mutation pipeline records its writes: a created node counts its
 * initial properties as set; a detach delete counts every relationship it unlinked.
 */
export class CypherWriteStats
{
    constructor(
        public NodesCreated: number = 0,
        public NodesDeleted: number = 0,
        public RelationshipsCreated: number = 0,
        public RelationshipsDeleted: number = 0,
        public PropertiesSet: number = 0,
    )
    {
    }

    public ToDto(): CypherWriteStatsDto
    {
        return {
            NodesCreated: this.NodesCreated,
            NodesDeleted: this.NodesDeleted,
            RelationshipsCreated: this.RelationshipsCreated,
            RelationshipsDeleted: this.RelationshipsDeleted,
            PropertiesSet: this.PropertiesSet,
        };
    }
}
