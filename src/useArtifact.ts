import type { Artifact, ArtifactBinding, ArtifactEntry, ArtifactKey } from './types.ts';

// Module-level read cache keyed by storage key (TTL opt-in).
const READ_CACHE = new Map<string, { value: any; expires: number }>();
import { resolveBinding } from './config.ts';
import { localAdapter, isAvailable as localIsAvailable } from './adapters/local.ts';
import { httpAdapter } from './adapters/http.ts';

export class ArtifactValidationError extends Error {
  constructor(key: string, detail: string) {
    super(`[module-runtime] validation failed for ${key}: ${detail}`);
    this.name = 'ArtifactValidationError';
  }
}

export type SchemaValidator<T = any> = (payload: unknown) => boolean | { ok: boolean; error?: string };

function runSchema(schema: SchemaValidator | undefined, payload: unknown, key: string): void {
  if (!schema) return;
  const res = schema(payload);
  const ok = typeof res === 'boolean' ? res : !!res?.ok;
  if (!ok) {
    const detail = typeof res === 'boolean' ? 'schema validation failed' : (res?.error ?? 'schema validation failed');
    throw new ArtifactValidationError(key, detail);
  }
}

function adapterFor(binding: ReturnType<typeof resolveBinding>) {
  return binding.adapter === 'http'
    ? httpAdapter(binding.endpoint ?? '', binding.headers, binding.timeout)
    : localAdapter();
}

export interface ArtifactHandle<T = any> {
  /** The resolved storage key / resource id. */
  key: string;
  /** Read the full artifact envelope (null if absent). */
  read(): Promise<Artifact<T> | null>;
  /** Convenience: read just the payload (null if absent). */
  readPayload(): Promise<T | null>;
  /** Persist an artifact envelope. */
  write(artifact: Artifact<T>): Promise<void>;
}

export interface UseArtifactOptions<T = any> {
  /** Optional schema validator applied to the payload on read. Throws ArtifactValidationError on mismatch. */
  schema?: SchemaValidator<T>;
}

/**
 * The one entry point a module uses for artifact I/O. Replaces every direct
 * `localStorage.getItem/setItem` call. The adapter (local vs http) and endpoint
 * are resolved from the runtime config, so the same module is a localStorage
 * demo or a backend-wired app depending on configuration alone.
 *
 *   const obligations = useArtifact('bl-obligation-set');
 *   const env = await obligations.read();
 *
 *   const memo = useArtifact('bl-memo');
 *   await memo.write({ artifact_type: 'bluelab.memo', schema_version: '0.1.0', payload, lineage });
 */
export function useArtifact<T = any>(key: string, override?: ArtifactBinding, options?: UseArtifactOptions<T>): ArtifactHandle<T> {
  const binding = resolveBinding(key, override);
  const adapter = adapterFor(binding);
  const storageKey = binding.storageKey;
  const schema = options?.schema;
  const ttl = binding.cacheTtlMs ?? 0;

  async function cachedRead(): Promise<Artifact<T> | null> {
    if (ttl > 0) {
      const entry = READ_CACHE.get(storageKey) as { value: Artifact<T> | null; expires: number } | undefined;
      if (entry && Date.now() < entry.expires) return entry.value;
    }
    const value = await adapter.read<T>(storageKey);
    if (value) runSchema(schema, value.payload, storageKey);
    if (ttl > 0) READ_CACHE.set(storageKey, { value, expires: Date.now() + ttl });
    return value;
  }

  return {
    key: storageKey,
    read: cachedRead,
    async readPayload() {
      const env = await cachedRead();
      return env ? env.payload : null;
    },
    write: async (artifact) => {
      await adapter.write<T>(storageKey, artifact);
      READ_CACHE.delete(storageKey);
    },
  };
}

/**
 * List every stored artifact whose key starts with prefix. For aggregation
 * screens (e.g. export-all) that read many artifacts at once. Binding resolves
 * from config under the prefix, else the runtime defaults.
 */
export function listArtifacts(prefix: string, override?: ArtifactBinding): Promise<ArtifactEntry[]> {
  return adapterFor(resolveBinding(prefix, override)).list(prefix);
}

export async function listArtifactsPage(prefix: string, cursor?: string | null, override?: ArtifactBinding): Promise<{ entries: ArtifactEntry[]; nextCursor: string | null }> {
  const binding = resolveBinding(prefix, override);
  const adapter = adapterFor(binding) as any;
  if (typeof adapter.listPage === 'function') {
    return adapter.listPage(prefix, cursor ?? null);
  }
  const entries = await adapter.list(prefix);
  return { entries, nextCursor: null };
}

export function isAvailable(): boolean {
  return localIsAvailable();
}
