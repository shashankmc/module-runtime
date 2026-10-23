/**
 * Tests for the artifact bus.
 * Run: npx tsx module-runtime/test/runtime.test.ts
 */
import assert from 'node:assert';
import {
  useArtifact,
  listArtifacts,
  listArtifactsPage,
  configureRuntime,
  resetRuntime,
  resolveBinding,
  isAvailable,
  localAdapter,
  type Artifact,
} from '../src/index.ts';

let passed = 0;
const ok = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve(fn()).then(() => {
    passed++;
    console.log('  ✓', name);
  });

// --- localStorage shim (Node has none) ---------------------------------------
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
}
(globalThis as any).localStorage = new MemoryStorage();

const obligationEnvelope: Artifact = {
  artifact_type: 'bluelab.obligation_set',
  schema_version: '0.1.0',
  payload: {
    obligations: [
      { agent: 'Member State', action: 'establish maritime spatial plans', source_text: 'Each Member State shall establish maritime spatial plans.' },
    ],
  },
  lineage: { produced_by_package: 'bluelab.obligation-adapter' },
};

await (async () => {
  // 1. local round-trip (default, zero-config)
  await ok('local adapter round-trips an envelope', async () => {
    resetRuntime();
    (globalThis as any).localStorage.clear();
    const h = useArtifact('bl-obligation-set');
    await h.write(obligationEnvelope);
    const back = await h.read();
    assert.deepEqual(back, obligationEnvelope);
  });

  // 2. readPayload returns just the payload (mirrors memo.vue's read path)
  await ok('readPayload unwraps the envelope', async () => {
    const h = useArtifact('bl-obligation-set');
    const payload = await h.readPayload();
    assert.equal((payload as any).obligations.length, 1);
  });

  // 3. default key === logical key, byte-compatible with the old hand-written code
  await ok('local persists under the logical key verbatim', async () => {
    const raw = (globalThis as any).localStorage.getItem('bl-obligation-set');
    assert.deepEqual(JSON.parse(raw), obligationEnvelope);
  });

  // 4. binding resolution precedence
  await ok('resolveBinding merges defaults < config < override', () => {
    configureRuntime({
      defaults: { adapter: 'http', endpoint: 'https://api.example.org' },
      artifacts: { 'bl-memo': { endpoint: 'https://memo.example.org', headers: { 'x-tenant': 'demo' } } },
    });
    const b = resolveBinding('bl-memo', { storageKey: 'memo-42' });
    assert.equal(b.adapter, 'http');                       // from defaults
    assert.equal(b.endpoint, 'https://memo.example.org');  // config beats defaults
    assert.equal(b.storageKey, 'memo-42');                 // override wins
    assert.equal(b.headers?.['x-tenant'], 'demo');
  });

  // 4a2. a prefix binding applies to dynamic keys; an exact binding still wins
  await ok('resolveBinding falls back to the longest matching prefix', () => {
    configureRuntime({
      artifacts: {
        'lb-annotations-': { adapter: 'http', endpoint: 'https://ann.example.org' },
        'bl-memo': { adapter: 'local' },
      },
    });
    const dyn = resolveBinding('lb-annotations-doc-001');
    assert.equal(dyn.adapter, 'http');                        // matched the prefix
    assert.equal(dyn.endpoint, 'https://ann.example.org');
    assert.equal(dyn.storageKey, 'lb-annotations-doc-001');   // real key preserved
    const exact = resolveBinding('bl-memo');
    assert.equal(exact.adapter, 'local');                     // exact match, no prefix bleed
    const none = resolveBinding('unbound-key');
    assert.equal(none.adapter, 'local');                      // built-in default
  });

  // 4b. listArtifacts returns every entry under a prefix (aggregation screens)
  await ok('listArtifacts lists entries by key prefix', async () => {
    resetRuntime();
    (globalThis as any).localStorage.clear();
    const a = useArtifact('lb-annotations-doc-1');
    const b = useArtifact('lb-annotations-doc-2');
    const other = useArtifact('bl-memo');
    await a.write({ artifact_type: 'lawnotation.annotation_set', schema_version: '1.0.0', payload: { 0: 'x' } });
    await b.write({ artifact_type: 'lawnotation.annotation_set', schema_version: '1.0.0', payload: { 1: 'y' } });
    await other.write({ artifact_type: 'bluelab.memo', schema_version: '0.1.0', payload: {} });
    const entries = await listArtifacts('lb-annotations-');
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((e) => e.key).sort(), ['lb-annotations-doc-1', 'lb-annotations-doc-2']);
  });

  // 5. http adapter hits the configured endpoint (mock fetch)
  await ok('http adapter reads/writes the configured endpoint', async () => {
    resetRuntime();
    const store = new Map<string, string>();
    const calls: string[] = [];
    (globalThis as any).fetch = async (url: string, init?: any) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (init?.method === 'PUT') { store.set(url, init.body); return { ok: true, status: 200 }; }
      if (store.has(url)) return { ok: true, status: 200, json: async () => JSON.parse(store.get(url)!) };
      return { ok: false, status: 404, statusText: 'Not Found' };
    };
    configureRuntime({ artifacts: { 'bl-memo': { adapter: 'http', endpoint: 'https://memo.example.org/' } } });
    const memo = useArtifact('bl-memo');
    assert.equal(await memo.read(), null); // 404 -> null
    const env: Artifact = { artifact_type: 'bluelab.memo', schema_version: '0.1.0', payload: { title: 'T', sections: [] } };
    await memo.write(env);
    const back = await memo.read();
    assert.deepEqual(back, env);
    assert.deepEqual(calls, [
      'GET https://memo.example.org/artifacts/bl-memo',
      'PUT https://memo.example.org/artifacts/bl-memo',
      'GET https://memo.example.org/artifacts/bl-memo',
    ]);
  });

  // 6. http adapter times out via AbortController
  await ok('http adapter times out slow reads', async () => {
    resetRuntime();
    (globalThis as any).fetch = async (_url: string, init?: any) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };
    configureRuntime({ artifacts: { 'bl-memo': { adapter: 'http', endpoint: 'https://memo.example.org/', timeout: 20 } } });
    const memo = useArtifact('bl-memo');
    let threw = false;
    try { await memo.read(); } catch (e: any) { threw = true; assert.match(String(e?.name ?? e), /NetworkError|AbortError|Error/); }
    assert.equal(threw, true);
  });

  // 7. http adapter retries a 5xx GET then succeeds
  await ok('http adapter retries 5xx reads', async () => {
    resetRuntime();
    let n = 0;
    (globalThis as any).fetch = async () => {
      n++;
      if (n === 1) return { ok: false, status: 503, statusText: 'Service Unavailable' };
      return { ok: true, status: 200, json: async () => ({ artifact_type: 'bluelab.memo', schema_version: '0.1.0', payload: { title: 'T', sections: [] } }) };
    };
    configureRuntime({ artifacts: { 'bl-memo': { adapter: 'http', endpoint: 'https://memo.example.org/' } } });
    const memo = useArtifact('bl-memo');
    const back = await memo.read();
    assert.equal((back as any).payload.title, 'T');
    assert.equal(n, 2);
  });

  // 8. http adapter list requires "key" in each entry
  await ok('http adapter list throws when an entry lacks key', async () => {
    resetRuntime();
    (globalThis as any).fetch = async () => ({ ok: true, status: 200, json: async () => ([{ artifact: { artifact_type: 'x', schema_version: '1', payload: {} } }]) });
    configureRuntime({ artifacts: { 'lb-annotations-': { adapter: 'http', endpoint: 'https://ann.example.org/' } } });
    const h = listArtifacts('lb-annotations-');
    let threw = false;
    try { await h; } catch (e) { threw = true; }
    assert.equal(threw, true);
  });

  // 9. http adapter pagination via cursor
  await ok('http adapter listPage follows cursor', async () => {
    resetRuntime();
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes('cursor=abc')) {
        return { ok: true, status: 200, json: async () => ({ items: [{ key: 'k2', artifact: { artifact_type: 'x', schema_version: '1', payload: {} } }], nextCursor: null }) };
      }
      return { ok: true, status: 200, json: async () => ({ items: [{ key: 'k1', artifact: { artifact_type: 'x', schema_version: '1', payload: {} } }], nextCursor: 'abc' }) };
    };
    configureRuntime({ artifacts: { 'lb-annotations-': { adapter: 'http', endpoint: 'https://ann.example.org/' } } });
    const p1 = await listArtifactsPage('lb-annotations-');
    assert.equal(p1.entries.length, 1);
    assert.equal(p1.entries[0].key, 'k1');
    assert.equal(p1.nextCursor, 'abc');
    const p2 = await listArtifactsPage('lb-annotations-', 'abc');
    assert.equal(p2.entries[0].key, 'k2');
    assert.equal(p2.nextCursor, null);
  });

  // 10. local adapter isAvailable + listWithDiagnostics
  await ok('local adapter reports availability and diagnostics', async () => {
    resetRuntime();
    (globalThis as any).localStorage.clear();
    // inject an unparseable entry under the prefix
    (globalThis as any).localStorage.setItem('lb-annotations-bad', '{not json');
    (globalThis as any).localStorage.setItem('lb-annotations-good', JSON.stringify({ artifact_type: 'x', schema_version: '1', payload: {} }));
    const adapter = localAdapter();
    assert.equal(adapter.isAvailable(), true);
    const diag = adapter.listWithDiagnostics('lb-annotations-');
    assert.equal(diag.entries.length, 1);
    assert.equal(diag.skipped, 1);
    (globalThis as any).localStorage.removeItem('lb-annotations-bad');
    (globalThis as any).localStorage.removeItem('lb-annotations-good');
  });

  // 11. configureRuntime validates config and throws
  await ok('configureRuntime rejects invalid config', () => {
    let threw = false;
    try { configureRuntime({ defaults: { adapter: 'ftp' as any } }); } catch (e) { threw = true; }
    assert.equal(threw, true);
    resetRuntime();
  });

  // 12. onError callback is invoked on http failure
  await ok('onError callback fires on http failure', async () => {
    resetRuntime();
    let seen: any = null;
    (globalThis as any).fetch = async () => ({ ok: false, status: 400, statusText: 'Bad Request', json: async () => ({}) });
    configureRuntime({ artifacts: { 'bl-memo': { adapter: 'http', endpoint: 'https://memo.example.org/' } }, onError: (e) => { seen = e; } });
    const memo = useArtifact('bl-memo');
    let threw = false;
    try { await memo.read(); } catch { threw = true; }
    assert.equal(threw, true);
    assert.ok(seen, 'onError should have been called');
    resetRuntime();
  });

  // 13. schema validator throws ArtifactValidationError
  await ok('schema validator throws on mismatch', async () => {
    resetRuntime();
    (globalThis as any).localStorage.clear();
    const h = useArtifact('bl-memo', undefined, { schema: (p: any) => (p && p.title ? true : { ok: false, error: 'missing title' }) });
    await h.write({ artifact_type: 'bluelab.memo', schema_version: '0.1.0', payload: { title: 'T', sections: [] } });
    // corrupt the stored payload directly
    const raw = (globalThis as any).localStorage.getItem('bl-memo');
    const env = JSON.parse(raw);
    env.payload = { sections: [] };
    (globalThis as any).localStorage.setItem('bl-memo', JSON.stringify(env));
    let threw = false;
    try { await h.read(); } catch (e: any) { threw = true; assert.equal(e?.name, 'ArtifactValidationError'); }
    assert.equal(threw, true);
    resetRuntime();
    (globalThis as any).localStorage.clear();
  });

  // 14. read cache with TTL
  await ok('read cache serves within TTL', async () => {
    resetRuntime();
    (globalThis as any).localStorage.clear();
    const env: Artifact = { artifact_type: 'bluelab.memo', schema_version: '0.1.0', payload: { title: 'T', sections: [] } };
    (globalThis as any).localStorage.setItem('bl-memo', JSON.stringify(env));
    let reads = 0;
    const origGet = (globalThis as any).localStorage.getItem.bind((globalThis as any).localStorage);
    (globalThis as any).localStorage.getItem = (k: string) => { reads++; return origGet(k); };
    configureRuntime({ artifacts: { 'bl-memo': { adapter: 'local', cacheTtlMs: 10000 } } });
    const h = useArtifact('bl-memo');
    await h.read();
    await h.read();
    assert.equal(reads, 1, 'second read should be served from cache');
    (globalThis as any).localStorage.getItem = origGet;
    resetRuntime();
    (globalThis as any).localStorage.clear();
  });

  // 15. isAvailable exported
  await ok('isAvailable is exported and true with store', () => {
    assert.equal(isAvailable(), true);
  });
})();

console.log(`\\n${passed} passed`);

console.log(`\n${passed} passed`);
