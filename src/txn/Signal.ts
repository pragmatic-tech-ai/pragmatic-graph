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
    private static readonly ErrDisposed = 'Signal has been disposed';

    private handlers: ReadonlyArray<(value: T) => void> = [];
    private disposed = false;

    /** Throws once the signal is disposed: a disposed source never raises again. */
    public Subscribe(handler: (value: T) => void): ISubscription
    {
        if (this.disposed)
        {
            throw new Error(Signal.ErrDisposed);
        }
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

    /** Drops every handler; later Raise calls deliver to nobody. Idempotent. */
    public dispose(): void
    {
        this.disposed = true;
        this.handlers = [];
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
