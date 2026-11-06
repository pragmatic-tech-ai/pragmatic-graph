/** Subscription handle returned by Signal.Subscribe; dispose() is idempotent. */
export interface ISubscription
{
    dispose(): void;
}

/**
 * Upward notification primitive: the engine raises, higher layers subscribe. Raise delivers to the
 * handlers subscribed when it starts, in subscription order. Every handler runs even if an earlier one
 * throws; the failures are then thrown together as one AggregateError.
 */
export class Signal<T>
{
    private static readonly ErrHandlers = 'One or more signal handlers threw';

    private handlers: ReadonlyArray<(value: T) => void> = [];

    public Subscribe(handler: (value: T) => void): ISubscription
    {
        // A fresh wrapper per subscription so the same function subscribed twice is two subscriptions.
        const entry = (value: T): void => handler(value);
        this.handlers = [...this.handlers, entry];
        return {
            dispose: () =>
            {
                this.handlers = this.handlers.filter(h => h !== entry);
            },
        };
    }

    public Raise(value: T): void
    {
        const errors: unknown[] = [];
        for (const handler of this.handlers)
        {
            try
            {
                handler(value);
            }
            catch (error)
            {
                errors.push(error);
            }
        }
        if (errors.length > 0)
        {
            throw new AggregateError(errors, Signal.ErrHandlers);
        }
    }
}
