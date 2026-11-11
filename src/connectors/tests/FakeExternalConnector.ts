import { ConnectorResidency, type IConnectorCapabilities, type IExternalConnector, type IFetchPage, type IFetchRequest, type IFetchedRow } from '../FetchContract.js';
import type { IConnectorTransaction } from '../GraphConnector.js';

/**
 * A scripted external connector. `Pages` are served in order through Resume tokens (the token is the next page
 * index); a request with Keys is answered from every scripted row whose id is asked for. `Requests` logs every
 * Fetch; `ThrowAtCall` (1-based) makes that call throw `Failure`.
 */
export class FakeExternalConnector implements IExternalConnector
{
    private static readonly ReadOnly = 'read-only';
    private static readonly Boom = 'fake fetch failure';

    public readonly Residency = ConnectorResidency.External as const;
    public readonly Requests: IFetchRequest[] = [];
    public ThrowAtCall: number | undefined;
    public readonly Failure = new Error(FakeExternalConnector.Boom);
    public Override: ((request: IFetchRequest) => IFetchPage) | undefined;

    public constructor(
        public readonly Name: string,
        public Pages: readonly (readonly IFetchedRow[])[],
        public readonly Capabilities: IConnectorCapabilities = { KeyLookup: true, ReverseLookup: true, PushDown: new Set() },
    )
    {
    }

    public Begin(_context?: unknown): Promise<IConnectorTransaction>
    {
        return Promise.reject(new Error(FakeExternalConnector.ReadOnly));
    }

    public Fetch(request: IFetchRequest): Promise<IFetchPage>
    {
        this.Requests.push(request);
        if (this.ThrowAtCall === this.Requests.length)
        {
            return Promise.reject(this.Failure);
        }
        if (this.Override !== undefined)
        {
            return Promise.resolve(this.Override(request));
        }
        if (request.Keys !== undefined)
        {
            const keys = new Set(request.Keys);
            return Promise.resolve({ Rows: this.Pages.flat().filter(r => keys.has(r.PublicId)) });
        }
        const index = request.Resume === undefined ? 0 : Number(request.Resume);
        const next = index + 1;
        return Promise.resolve(next < this.Pages.length ? { Rows: this.Pages[index]!, Resume: String(next) } : { Rows: this.Pages[index] ?? [] });
    }
}
