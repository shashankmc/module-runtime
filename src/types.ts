/**
 * @legalblocks/module-runtime — shared types for the artifact bus.
 *
 * An Artifact is the envelope every LegalBlocks module reads and writes. It is
 * structurally compatible with @lawnotation/module-sdk's LawnotationArtifact, so
 * existing modules keep working unchanged.
 */

export interface Artifact<T = any> {
  artifact_id?: string;
  artifact_type: string;
  schema_version: string;
  scope?: {
    project_id?: string;
    task_id?: string;
    document_ids?: string[];
  };
  constraints?: Record<string, any>;
  payload: T;
  lineage?: {
    produced_by_package?: string;
    produced_by_module?: string;
    source_artifact_ids?: string[];
  };
}

/** Where a given artifact key is read from / written to. */
export type AdapterKind = 'local' | 'http';

/**
 * Per-artifact binding. Anything omitted falls back to the runtime defaults,
 * then to the built-in default (local adapter, key === logical key).
 */
export interface ArtifactBinding {
  adapter?: AdapterKind;
  /** Base URL for the http adapter, e.g. "https://api.example.org/v1". */
  endpoint?: string;
  /** Override the storage key / remote resource id (defaults to the logical key). */
  storageKey?: string;
  /** Extra headers for the http adapter (auth, tenant, etc.). */
  headers?: Record<string, string>;
  /** Request timeout in ms for the http adapter (default 15000). */
  timeout?: number;
  /** Read cache TTL in ms (default 0 = disabled). */
  cacheTtlMs?: number;
}

/** Logical artifact key. Phase 3 replaces this string alias with a generated union. */
export type ArtifactKey = string;

/**
 * Runtime configuration. In a generated app this is hydrated from
 * legalblocks.config.json; modules never hardcode endpoints.
 */
export interface RuntimeConfig {
  defaults?: {
    adapter?: AdapterKind;
    endpoint?: string;
    headers?: Record<string, string>;
    timeout?: number;
    cacheTtlMs?: number;
  };
  /** Keyed by logical artifact key (e.g. "bl-obligation-set"). */
  artifacts?: Record<string, ArtifactBinding>;
  /** Callback invoked when an adapter encounters an error (network, http, parse). */
  onError?: (error: unknown) => void;
}

/** One entry returned by a list() query. */
export interface ArtifactEntry<T = any> {
  key: string;
  artifact: Artifact<T>;
}

export interface ArtifactAdapter {
  read<T = any>(key: string): Promise<Artifact<T> | null>;
  write<T = any>(key: string, artifact: Artifact<T>): Promise<void>;
  /** All stored artifacts whose key starts with prefix (for aggregation screens). */
  list(prefix: string): Promise<ArtifactEntry[]>;
}

/** Fully resolved binding: adapter is always set. */
export interface ResolvedBinding extends ArtifactBinding {
  adapter: AdapterKind;
  storageKey: string;
  timeout: number;
  cacheTtlMs: number;
}
