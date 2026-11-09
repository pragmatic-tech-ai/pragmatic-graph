import { RelDirection } from '../CypherEnums.js';
import { RelValue } from '../StructuredValues.js';

/**
 * Single home for how a traversed edge is reported as a RelValue, shared by every expand operator so fixed and
 * variable-length relationship variables agree. The type is the relationship actually walked. Outgoing walks
 * current->next; Incoming walks against the edge, so the real edge is next->current. Undirected keeps traversal
 * order (an expand row does not say which way its edge points; TODL behaved the same).
 */
export class RelOrientation
{
    public static Oriented(direction: RelDirection, relationship: string, currentId: string, nextId: string): RelValue
    {
        return direction === RelDirection.Incoming ? new RelValue(nextId, relationship, currentId) : new RelValue(currentId, relationship, nextId);
    }
}
