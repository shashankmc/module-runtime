/**
 * @legalblocks/module-runtime
 *
 * The shared artifact bus for LegalBlocks modules. Modules read and write typed
 * Artifact envelopes through useArtifact(); the adapter (localStorage by default,
 * HTTP when an endpoint is configured) is resolved from the runtime config rather
 * than hardcoded in each screen.
 */
export type {
  Artifact,
  AdapterKind,
  ArtifactBinding,
  ArtifactEntry,
  RuntimeConfig,
  ArtifactAdapter,
  ResolvedBinding,
  ArtifactKey,
} from './types.ts';

export { configureRuntime, getRuntimeConfig, resetRuntime, resolveBinding, getOnError } from './config.ts';
export { useArtifact, listArtifacts, listArtifactsPage, isAvailable } from './useArtifact.ts';
export type { ArtifactHandle, UseArtifactOptions, SchemaValidator } from './useArtifact.ts';
export { ArtifactValidationError } from './useArtifact.ts';
export { localAdapter, isAvailable as localIsAvailable } from './adapters/local.ts';
export type { ListDiagnostics } from './adapters/local.ts';
export { httpAdapter, HttpError, NetworkError } from './adapters/http.ts';
export type { ListPageResult } from './adapters/http.ts';
