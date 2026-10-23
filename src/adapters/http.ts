import type { Artifact, ArtifactAdapter, ArtifactEntry } from '../types.ts';
import { getOnError } from '../config.ts';

export class HttpError extends Error {
  status: number;
  constructor(status: number, statusText: string, key: string) {
    super(`[module-runtime] ${key} failed: ${status} ${statusText}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

export class NetworkError extends Error {
  constructor(key: string, cause: unknown) {
    super(`[module-runtime] ${key} network error`);
    this.name = 'NetworkError';
    (this as any).cause = cause;
  }
}

export interface ListPageResult {
  entries: ArtifactEntry[];
  nextCursor: string | null;
}

function report(err: unknown): void {
  try { getOnError()?.(err); } catch { /* never throw from reporter */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * HTTP adapter. Maps an artifact key onto a REST resource:
 *   GET  {endpoint}/artifacts/{key}   -> 200 Artifact | 404 (absent)
 *   PUT  {endpoint}/artifacts/{key}   <- Artifact body
 *
 * This is the contract a module owner points at when they "provide their own
 * endpoint". The shape is intentionally minimal; a backend can implement it over
 * any store. Headers (auth, tenant) come from the binding.
 */
export function httpAdapter(endpoint: string, headers: Record<string, string> = {}, timeout = 15000): ArtifactAdapter & { listPage(prefix: string, cursor?: string | null): Promise<ListPageResult> } {
  if (!endpoint) {
    throw new Error('[module-runtime] http adapter requires an endpoint');
  }
  const base = endpoint.replace(/\/+$/, '');
  const url = (key: string) => `${base}/artifacts/${encodeURIComponent(key)}`;

  async function fetchWithTimeout(input: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function readOnce<T>(key: string): Promise<Response> {
    return fetchWithTimeout(url(key), { headers });
  }

  const adapter: any = {
    async read<T>(key: string): Promise<Artifact<T> | null> {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await readOnce<T>(key);
          if (res.status === 404) return null;
          if (!res.ok) {
            if (res.status >= 500 && attempt < 2) {
              await sleep(100 * Math.pow(2, attempt));
              continue;
            }
            const err = new HttpError(res.status, res.statusText, key);
            report(err);
            throw err;
          }
          return (await res.json()) as Artifact<T>;
        } catch (e) {
          if (e instanceof HttpError) throw e;
          lastErr = e;
          if (attempt < 2) {
            await sleep(100 * Math.pow(2, attempt));
            continue;
          }
          const err = new NetworkError(key, e);
          report(err);
          throw err;
        }
      }
      const err = new NetworkError(key, lastErr);
      report(err);
      throw err;
    },
    async write<T>(key: string, artifact: Artifact<T>): Promise<void> {
      let res: Response;
      try {
        res = await fetchWithTimeout(url(key), {
          method: 'PUT',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(artifact),
        });
      } catch (e) {
        const err = new NetworkError(key, e);
        report(err);
        throw err;
      }
      if (!res.ok) {
        const err = new HttpError(res.status, res.statusText, key);
        report(err);
        throw err;
      }
    },
    async list(prefix: string): Promise<ArtifactEntry[]> {
      const page = await adapter.listPage(prefix);
      return page.entries;
    },
    async listPage(prefix: string, cursor?: string | null): Promise<ListPageResult> {
      const qs = new URLSearchParams({ prefix });
      if (cursor) qs.set('cursor', cursor);
      let res: Response;
      try {
        res = await fetchWithTimeout(`${base}/artifacts?${qs.toString()}`, { headers });
      } catch (e) {
        const err = new NetworkError(prefix, e);
        report(err);
        throw err;
      }
      if (!res.ok) {
        const err = new HttpError(res.status, res.statusText, prefix);
        report(err);
        throw err;
      }
      const items = (await res.json()) as any;
      // Support { items, nextCursor } or a bare array.
      const rawItems: any[] = Array.isArray(items) ? items : (items?.items ?? items?.entries ?? []);
      const nextCursor: string | null = Array.isArray(items) ? null : (items?.nextCursor ?? items?.cursor ?? null);
      const entries: ArtifactEntry[] = rawItems.map((it: any) => {
        if (!it || typeof it !== 'object') throw new Error(`[module-runtime] list ${prefix}: entry is not an object`);
        if (!('key' in it) && !('artifact' in it)) {
          // bare artifact without key -> invalid
        }
        const key = it.key ?? it.artifact_id ?? '';
        if (!key) {
          throw new Error(`[module-runtime] list ${prefix}: entry missing required "key"`);
        }
        const artifact = 'artifact' in it ? it.artifact : it;
        return { key, artifact } as ArtifactEntry;
      });
      return { entries, nextCursor };
    },
  };

  return adapter;
}