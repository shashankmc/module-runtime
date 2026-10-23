import type { ArtifactBinding, ResolvedBinding, RuntimeConfig } from './types.ts';

let runtimeConfig: RuntimeConfig = {};

function validateConfig(config: RuntimeConfig): void {
  if (config === null || typeof config !== 'object') {
    throw new Error('[module-runtime] RuntimeConfig must be an object');
  }
  const defaults = config.defaults;
  if (defaults !== undefined) {
    if (typeof defaults !== 'object' || defaults === null) throw new Error('[module-runtime] defaults must be an object');
    if (defaults.adapter !== undefined && defaults.adapter !== 'local' && defaults.adapter !== 'http') {
      throw new Error('[module-runtime] defaults.adapter must be "local" or "http"');
    }
    if (defaults.endpoint !== undefined && typeof defaults.endpoint !== 'string') throw new Error('[module-runtime] defaults.endpoint must be a string');
    if (defaults.headers !== undefined && (typeof defaults.headers !== 'object' || defaults.headers === null)) throw new Error('[module-runtime] defaults.headers must be an object');
    if (defaults.timeout !== undefined && (typeof defaults.timeout !== 'number' || defaults.timeout < 0)) throw new Error('[module-runtime] defaults.timeout must be a non-negative number');
    if (defaults.cacheTtlMs !== undefined && (typeof defaults.cacheTtlMs !== 'number' || defaults.cacheTtlMs < 0)) throw new Error('[module-runtime] defaults.cacheTtlMs must be a non-negative number');
  }
  const artifacts = config.artifacts;
  if (artifacts !== undefined) {
    if (typeof artifacts !== 'object' || artifacts === null) throw new Error('[module-runtime] artifacts must be an object');
    for (const [k, v] of Object.entries(artifacts)) {
      if (typeof v !== 'object' || v === null) throw new Error(`[module-runtime] artifacts.${k} must be an object`);
      const b = v as ArtifactBinding;
      if (b.adapter !== undefined && b.adapter !== 'local' && b.adapter !== 'http') throw new Error(`[module-runtime] artifacts.${k}.adapter must be "local" or "http"`);
      if (b.endpoint !== undefined && typeof b.endpoint !== 'string') throw new Error(`[module-runtime] artifacts.${k}.endpoint must be a string`);
      if (b.headers !== undefined && (typeof b.headers !== 'object' || b.headers === null)) throw new Error(`[module-runtime] artifacts.${k}.headers must be an object`);
      if (b.timeout !== undefined && (typeof b.timeout !== 'number' || b.timeout < 0)) throw new Error(`[module-runtime] artifacts.${k}.timeout must be a non-negative number`);
      if (b.cacheTtlMs !== undefined && (typeof b.cacheTtlMs !== 'number' || b.cacheTtlMs < 0)) throw new Error(`[module-runtime] artifacts.${k}.cacheTtlMs must be a non-negative number`);
    }
  }
  if (config.onError !== undefined && typeof config.onError !== 'function') throw new Error('[module-runtime] onError must be a function');
}

/**
 * Install the runtime configuration. Call once at app boot, typically:
 *   import cfg from '../legalblocks.config.json';
 *   configureRuntime(cfg.runtime ?? {});
 * Modules that never call this default to localStorage, so demos still work.
 */
export function configureRuntime(config: RuntimeConfig): void {
  const c = config ?? {};
  validateConfig(c);
  runtimeConfig = c;
}

export function getOnError(): ((error: unknown) => void) | undefined {
  return runtimeConfig.onError;
}

export function getRuntimeConfig(): RuntimeConfig {
  return runtimeConfig;
}

/** Reset to an empty config (used by tests). */
export function resetRuntime(): void {
  runtimeConfig = {};
}

/**
 * Merge, in precedence order: per-call override > config.artifacts[key] >
 * config.defaults > built-in default (local, key === logical key).
 *
 * Key lookup is exact first, then longest-prefix: a binding registered under
 * "lb-annotations-" applies to every "lb-annotations-<id>" dynamic key.
 */
function lookupBinding(key: string): ArtifactBinding {
  const artifacts = runtimeConfig.artifacts ?? {};
  if (artifacts[key]) return artifacts[key];
  let best: ArtifactBinding | undefined;
  let bestLen = -1;
  for (const k of Object.keys(artifacts)) {
    if (k.length <= key.length && k.length > bestLen && key.startsWith(k)) {
      best = artifacts[k];
      bestLen = k.length;
    }
  }
  return best ?? {};
}

export function resolveBinding(key: string, override?: ArtifactBinding): ResolvedBinding {
  const fromConfig = lookupBinding(key);
  const defaults = runtimeConfig.defaults ?? {};
  return {
    adapter: override?.adapter ?? fromConfig.adapter ?? defaults.adapter ?? 'local',
    endpoint: override?.endpoint ?? fromConfig.endpoint ?? defaults.endpoint,
    storageKey: override?.storageKey ?? fromConfig.storageKey ?? key,
    headers: {
      ...(defaults.headers ?? {}),
      ...(fromConfig.headers ?? {}),
      ...(override?.headers ?? {}),
    },
    timeout: override?.timeout ?? fromConfig.timeout ?? defaults.timeout ?? 15000,
    cacheTtlMs: override?.cacheTtlMs ?? fromConfig.cacheTtlMs ?? defaults.cacheTtlMs ?? 0,
  };
}
