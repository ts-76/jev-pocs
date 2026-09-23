import type {
  Env,
  GmailHeader,
  GmailHistoryEntry,
  GmailMessage,
  GmailMessagePart,
  GmailMessageSummary,
  GmailWatchResponse,
} from './types';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

type Label = { id: string; name: string; type?: string };
type ListMessagesResponse = { messages?: GmailMessageSummary[]; resultSizeEstimate?: number; nextPageToken?: string };
type ListLabelsResponse = { labels?: Label[] };
type ListHistoryResponse = { history?: GmailHistoryEntry[]; nextPageToken?: string; historyId?: string };
type TokenResponse = { access_token?: string; expires_in?: number; error?: string; error_description?: string };

export class GmailApiError extends Error {
  constructor(public readonly status: number, public readonly reason: string, public readonly retryAfterMs = 0) {
    super(`Gmail API ${status}: ${reason}`);
    this.name = 'GmailApiError';
  }
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500 || ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded'].includes(this.reason);
  }
}

export interface HistoryPage { messageIds: string[]; nextPageToken?: string; historyId: string }
export interface MessagePage { messages: GmailMessageSummary[]; nextPageToken?: string }

export class GmailClient {
  private readonly env: Env;
  private accessToken?: string;

  constructor(env: Env) {
    this.env = env;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    if (!this.env.GMAIL_REFRESH_TOKEN) throw new Error('GMAIL_REFRESH_TOKEN is not configured');

    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.env.GMAIL_CLIENT_ID,
        client_secret: this.env.GMAIL_CLIENT_SECRET,
        refresh_token: this.env.GMAIL_REFRESH_TOKEN,
        grant_type: 'refresh_token',
      }),
    });
    const payload = await response.json() as TokenResponse;
    if (!response.ok || !payload.access_token) {
      throw new GmailApiError(response.ok ? 401 : response.status, payload.error ?? 'oauthRefreshFailed');
    }
    this.accessToken = payload.access_token;
    return payload.access_token;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('authorization', 'Bearer ' + await this.getAccessToken());
    headers.set('accept', 'application/json');
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

    const response = await fetch(GMAIL_API + path, { ...init, headers, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { errors?: Array<{ reason?: string }> } } | null;
      const reason = payload?.error?.errors?.[0]?.reason ?? 'requestFailed';
      const retry = response.headers.get('retry-after');
      const retryAfterMs = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now())) : 0;
      throw new GmailApiError(response.status, reason, Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
    }
    return response.json() as Promise<T>;
  }

  async listMessages(query: string, maxResults: number): Promise<GmailMessageSummary[]> {
    return (await this.listMessagesPage(query, maxResults)).messages;
  }

  async listMessagesPage(query: string, maxResults = 100, pageToken?: string): Promise<MessagePage> {
    const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
    if (pageToken) params.set('pageToken', pageToken);
    const payload = await this.request<ListMessagesResponse>('/messages?' + params);
    return { messages: payload.messages ?? [], nextPageToken: payload.nextPageToken };
  }

  async getProfile(): Promise<{ emailAddress: string; historyId: string }> {
    return this.request('/profile');
  }

  async listHistoryPage(startHistoryId: string, pageToken?: string): Promise<HistoryPage> {
    const params = new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded', maxResults: '100', labelId: 'INBOX' });
    if (pageToken) params.set('pageToken', pageToken);
    const payload = await this.request<ListHistoryResponse>('/history?' + params);
    if (!payload.historyId || !/^\d+$/.test(payload.historyId)) throw new Error('Gmail history response is missing a valid historyId');
    const ids = new Set<string>();
    for (const entry of payload.history ?? []) for (const item of entry.messagesAdded ?? []) if (item.message?.id) ids.add(item.message.id);
    return { messageIds: [...ids], nextPageToken: payload.nextPageToken, historyId: payload.historyId };
  }

  async getMessage(id: string, format: 'metadata' | 'full'): Promise<GmailMessage> {
    const params = new URLSearchParams({ format });
    if (format === 'metadata') {
      params.append('metadataHeaders', 'From');
      params.append('metadataHeaders', 'Subject');
      params.append('metadataHeaders', 'Date');
    }
    return this.request<GmailMessage>('/messages/' + encodeURIComponent(id) + '?' + params);
  }

  async listHistory(startHistoryId: string): Promise<string[]> {
    const messageIds = new Set<string>();
    let pageToken: string | undefined;

    do {
      const payload = await this.listHistoryPage(startHistoryId, pageToken);
      for (const id of payload.messageIds) messageIds.add(id);
      pageToken = payload.nextPageToken;
    } while (pageToken);

    return [...messageIds];
  }

  async watch(topicName: string): Promise<GmailWatchResponse> {
    return this.request<GmailWatchResponse>('/watch', {
      method: 'POST',
      body: JSON.stringify({
        topicName,
        labelIds: ['INBOX'],
        labelFilterBehavior: 'INCLUDE',
      }),
    });
  }

  async listLabels(): Promise<Label[]> {
    const payload = await this.request<ListLabelsResponse>('/labels');
    return payload.labels ?? [];
  }

  async ensureLabels(names: string[]): Promise<Map<string, string>> {
    const existing = new Map((await this.listLabels()).map((label) => [label.name, label.id]));
    for (const name of names) {
      if (existing.has(name)) continue;
      const created = await this.request<Label>('/labels', {
        method: 'POST',
        body: JSON.stringify({
          name,
          labelListVisibility: 'labelShow',
          messageListVisibility: 'show',
        }),
      });
      existing.set(name, created.id);
    }
    return new Map(names.map((name) => [name, existing.get(name)!]));
  }

  async addLabels(messageId: string, labelIds: string[]): Promise<void> {
    await this.request('/messages/' + encodeURIComponent(messageId) + '/modify', {
      method: 'POST',
      body: JSON.stringify({ addLabelIds: labelIds }),
    });
  }

  async replaceManagedLabels(messageId: string, addLabelIds: string[], managedLabelIds: string[]): Promise<void> {
    await this.request('/messages/' + encodeURIComponent(messageId) + '/modify', {
      method: 'POST',
      body: JSON.stringify({ addLabelIds, removeLabelIds: managedLabelIds.filter(id => !addLabelIds.includes(id)) }),
    });
  }
}

export function headerValue(headers: GmailHeader[] | undefined, name: string): string {
  return headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

export function messageHeaders(message: GmailMessage): GmailHeader[] {
  return (message.payload as GmailMessagePart | undefined)?.headers ?? [];
}
