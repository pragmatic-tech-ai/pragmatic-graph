export enum TokenKind
{
    LParen, RParen, LBracket, RBracket, LBrace, RBrace,
    Colon, Comma, Dot, Dollar, Dash, ArrowRight, ArrowLeft,
    Eq, Neq, Lt, Lte, Gt, Gte, Star, Plus, PlusEq, Slash, Percent,
    Identifier, Keyword, String, Number, Eof,
}

// Property: SET n.p = v. MergeMap: SET n += {map} (listed props only). Replace: SET n = {map} (listed props, all others
// removed).
export enum SetMode { Property, MergeMap, Replace }

export enum RelDirection { Outgoing, Incoming, Undirected }

export enum ComparisonOp { Eq, Neq, Lt, Lte, Gt, Gte }

export enum BooleanOp { And, Or, Not }

export enum ArithmeticOp { Add, Sub, Mul, Div, Mod }

// How a write clause reaches its external connectors (ruling R140 E10). PerRow: one flushed step per input row.
// Batched: the clause's writes for every input row go in one step (a batched stage, or one Apply), when no later
// clause depends on the rows it writes.
export enum WriteMode { PerRow = 1, Batched = 2 }
