import type { Env, IssueLabel } from './types.js';

const API = 'https://api.github.com';

export class GitHubClient {
  private readonly env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('authorization', 'Bearer ' + this.env.GITHUB_TOKEN);
    headers.set('accept', 'application/vnd.github+json');
    headers.set('x-github-api-version', '2022-11-28');
    headers.set('user-agent', 'jev-issue-triage-poc');
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

    const response = await fetch(API + path, { ...init, headers });
    if (!response.ok) {
      const body = await response.text();
      throw new Error('GitHub API ' + response.status + ': ' + body.slice(0, 500));
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  private repoPath(): string {
    return '/repos/' + this.env.GITHUB_REPOSITORY;
  }

  async ensureLabel(name: string, color: string, description: string): Promise<void> {
    const encoded = encodeURIComponent(name);
    try {
      await this.request(this.repoPath() + '/labels/' + encoded);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('GitHub API 404')) throw error;
    }

    await this.request(this.repoPath() + '/labels', {
      method: 'POST',
      body: JSON.stringify({ name, color, description }),
    });
  }

  async replaceManagedLabels(issueNumber: number, existing: IssueLabel[], managed: string[]): Promise<void> {
    const managedPrefixes = ['triage:', 'severity:'];
    const preserved = (existing ?? [])
      .map((label) => label.name)
      .filter((name) => !managedPrefixes.some((prefix) => name.startsWith(prefix)));
    const unique = [...new Set([...preserved, ...managed])];

    await this.request(this.repoPath() + '/issues/' + issueNumber + '/labels', {
      method: 'PUT',
      body: JSON.stringify({ labels: unique }),
    });
  }

  async listComments(issueNumber: number): Promise<Array<{ id: number; body?: string }>> {
    return this.request<Array<{ id: number; body?: string }>>(
      this.repoPath() + '/issues/' + issueNumber + '/comments?per_page=100',
    );
  }

  async upsertTriageComment(issueNumber: number, body: string): Promise<void> {
    const comments = await this.listComments(issueNumber);
    const previous = [...comments].reverse().find((comment) => comment.body?.includes('<!-- jev-issue-triage -->'));
    if (previous) {
      await this.request(this.repoPath() + '/issues/comments/' + previous.id, {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      });
      return;
    }

    await this.request(this.repoPath() + '/issues/' + issueNumber + '/comments', {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }
}

