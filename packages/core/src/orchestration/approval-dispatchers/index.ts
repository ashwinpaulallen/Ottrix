import type { ApprovalRequest } from '../human-approval.js';

export interface WebhookDispatcherOptions {
  url: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

/** POSTs approval requests to a webhook URL. */
export class WebhookDispatcher {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WebhookDispatcherOptions) {
    this.url = options.url;
    this.headers = options.headers ?? { 'Content-Type': 'application/json' };
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async notify(request: ApprovalRequest): Promise<void> {
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`WebhookDispatcher failed with status ${response.status}`);
    }
  }
}

export interface CallbackDispatcherOptions {
  callback: (request: ApprovalRequest) => Promise<void>;
}

/** Invokes a custom async callback for approval notifications. */
export class CallbackDispatcher {
  private readonly callback: (request: ApprovalRequest) => Promise<void>;

  constructor(options: CallbackDispatcherOptions) {
    this.callback = options.callback;
  }

  async notify(request: ApprovalRequest): Promise<void> {
    await this.callback(request);
  }
}

/** Logs approval requests to the console (development). */
export class ConsoleDispatcher {
  notify(request: ApprovalRequest): Promise<void> {
    console.info('[HumanApproval]', JSON.stringify(request, null, 2));
    return Promise.resolve();
  }
}
