import type { Artifact, ArtifactAdapter, ArtifactEntry } from '../types.ts';
import { getOnError } from '../config.ts';

export interface ListDiagnostics {
  entries: ArtifactEntry[];
  skipped: number;
}

function getStore(): Storage | null {
  const g = globalThis as unknown as { localStorage?: Storage };
  return g.localStorage ?? null;
}

function warnUnavailable(): void {
  // eslint-disable-next-line no-console
  console.warn('[module-runtime] localStorage is unavailable; reads return null and writes are no-ops');
}

/**
 * Resolve a Web Storage implementation. Returns the browser localStorage when
 * present (Nuxt SPA, builder preview), or any shim assigned to
 * globalThis.localStorage (tests, SSR). Returns null when no store exists, in
 * which case reads yield null and writes are no-ops.
 */
export function isAvailable(): boolean {
  return getStore() !== null;
}

/**
 * The default adapter: persists artifacts in Web Storage under the storage key.
 * This is byte-for-byte compatible with the hand-written
 * `localStorage.getItem/setItem(JSON.stringify(envelope))` calls the modules
 * used before the bus existed, so converting a module changes nothing at runtime
 * until an endpoint is configured.
 */
export function localAdapter(): ArtifactAdapter & { isAvailable(): boolean; listWithDiagnostics(prefix: string): ListDiagnostics } {
  let warned = false;
  function store(): Storage | null {
    const s = getStore();
      if (!s && !warned) {
        warned = true;
        warnUnavailable();
        try { getOnError()?.(new Error('localStorage unavailable')); } catch {}
      }
    return s;
  }

  const adapter: any = {
    isAvailable(): boolean {
      return getStore() !== null;
    },
    async read<T>(key: string): Promise<Artifact<T> | null> {
      const s = store();
      if (!s) return null;
      const raw = s.getItem(key);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as Artifact<T>;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[module-runtime] skipping unparseable entry for ${key}`);
        try { getOnError()?.(e); } catch {}
        return null;
      }
    },
    async write<T>(key: string, artifact: Artifact<T>): Promise<void> {
      const s = store();
      if (!s) return;
      s.setItem(key, JSON.stringify(artifact));
    },
    async list(prefix: string): Promise<ArtifactEntry[]> {
      return adapter.listWithDiagnostics(prefix).entries;
    },
    listWithDiagnostics(prefix: string): ListDiagnostics {
      const s = store();
      if (!s) return { entries: [], skipped: 0 };
      const out: ArtifactEntry[] = [];
      let skipped = 0;
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (!k || !k.startsWith(prefix)) continue;
        const raw = s.getItem(k);
        if (!raw) continue;
        try {
          out.push({ key: k, artifact: JSON.parse(raw) });
        } catch {
          skipped++;
          // eslint-disable-next-line no-console
          console.warn(`[module-runtime] skipping unparseable entry ${k}`);
        }
      }
      return { entries: out, skipped };
    },
  };
  return adapter;
}