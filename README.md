# @legalblocks/module-runtime

The shared **artifact bus** for LegalBlocks modules. Screens read and write typed artifact
envelopes through `useArtifact()`; the adapter (localStorage by default, an HTTP endpoint when
configured) is resolved from `legalblocks.config.json`, so modules never hardcode endpoints.

```ts
import { useArtifact, listArtifacts } from '@legalblocks/module-runtime';

const obligations = useArtifact('bl-obligation-set');
const env = await obligations.read();          // full envelope
const payload = await obligations.readPayload(); // just the payload

const memo = useArtifact('bl-memo');
await memo.write({ artifact_type: 'bluelab.memo', schema_version: '0.1.0', payload, lineage });

// aggregation screens (e.g. export-all):
for (const { key, artifact } of await listArtifacts('lb-annotations-')) { /* ... */ }
```

## Configuration

At app boot, hydrate the bus from per-project config (the generator emits a Nuxt plugin that
does this automatically):

```ts
import { configureRuntime } from '@legalblocks/module-runtime';
import config from '../legalblocks.config.json';
configureRuntime(config.runtime ?? {});
```

Binding precedence per artifact key: per-call override > `artifacts[key]` > `defaults` > built-in
local. Example runtime block:

```json
{
  "defaults": { "adapter": "local" },
  "artifacts": {
    "bl-memo": { "adapter": "http", "endpoint": "https://api.example.org", "headers": { "x-tenant": "demo" } }
  }
}
```

## HTTP contract

- `GET  {endpoint}/artifacts/{key}` → `200` Artifact | `404`
- `PUT  {endpoint}/artifacts/{key}` ← Artifact body
- `GET  {endpoint}/artifacts?prefix={p}` → `[{ key, artifact }]`

## Tests

```bash
npm test   # tsx test/runtime.test.ts — 6 passing
```

## Distribution

Vendored into generated apps by `@lawnotation/app-generator` (aliased so the explicit import
resolves without an install). Also published standalone as part of the LegalBlocks module
collection.
