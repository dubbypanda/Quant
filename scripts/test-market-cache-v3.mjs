// Persistent market-cache integrity tests for Quant 3.0 (docs/quant-v3/01, Task 3).
//
// Every case here is a corruption or lifecycle scenario: the cache must degrade
// to a refetch, never crash and never hand back bytes it cannot verify.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(os.tmpdir(), `quant-market-cache-test-${process.pid}`);
fs.mkdirSync(tmp, { recursive: true });

const electronMock = {
  name: 'electron-mock',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron-mock', namespace: 'mock' }));
    build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
      // A real temp path: no code path may write into the repo working tree.
      contents: `export const app = { getPath: () => ${JSON.stringify(tmp)} };`,
    }));
  },
};

async function load(relativePath) {
  const outfile = path.join(tmp, `${path.basename(relativePath, '.ts')}.mjs`);
  await build({
    entryPoints: [path.join(root, relativePath)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    plugins: [electronMock],
    outfile,
    logLevel: 'silent',
  });
  return import(outfile);
}

const cache = await load('src/main/services/marketCache.ts');

let caseCounter = 0;
function freshRoot() {
  const dir = path.join(tmp, `root-${caseCounter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
console.log('--- Test 1: Valid round trip and manifest shape ---');
{
  const dir = freshRoot();
  const payload = { symbol: 'NVDA', candles: [{ time: 1, close: 2 }] };
  const entry = cache.writeMarketCache('charts/NVDA/1d-5m-ext', payload, 60_000, 'live', dir);
  assert.ok(entry, 'a write returns its manifest entry');
  assert.equal(entry.source, 'live');
  assert.ok(entry.byteLength > 0);
  assert.match(entry.sha256, /^[0-9a-f]{64}$/, 'the hash is over the compressed bytes');

  const read = cache.readMarketCache('charts/NVDA/1d-5m-ext', dir);
  assert.deepEqual(read.value, payload, 'the payload round trips exactly');
  assert.equal(read.stale, false, 'inside its TTL it is fresh');
  assert.equal(read.source, 'live');

  // The payload lands where the manifest says, gzipped.
  const file = path.join(dir, 'charts', 'NVDA', '1d-5m-ext.json.gz');
  assert.ok(fs.existsSync(file), `expected payload at ${file}`);
  assert.deepEqual(
    JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')),
    payload,
  );

  const manifest = cache.readManifest(dir);
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(Object.keys(manifest.entries).length, 1);

  // No temp files survive a successful write.
  const leftovers = fs
    .readdirSync(path.join(dir, 'charts', 'NVDA'))
    .filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'temp files are renamed, not left behind');

  const stats = cache.getMarketCacheStats(dir);
  assert.equal(stats.entries, 1);
  assert.equal(stats.compressedBytes, entry.byteLength);
}

// ---------------------------------------------------------------------------
console.log('--- Test 2: A missing manifest is an empty cache, not a crash ---');
{
  const dir = freshRoot();
  const manifest = cache.readManifest(dir);
  assert.equal(manifest.schemaVersion, 3);
  assert.deepEqual(manifest.entries, {});
  assert.equal(cache.readMarketCache('charts/AAPL/1d-5m', dir), null);
  assert.deepEqual(cache.getMarketCacheStats(dir), { entries: 0, compressedBytes: 0 });

  // Garbage in the manifest slot behaves the same way.
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{ not json');
  assert.deepEqual(cache.readManifest(dir).entries, {});

  // A manifest from a future schema is ignored rather than misread.
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ schemaVersion: 99, updatedAt: 'x', entries: { a: {} } }),
  );
  assert.deepEqual(cache.readManifest(dir).entries, {});
}

// ---------------------------------------------------------------------------
console.log('--- Test 3: Corrupt gzip and corrupt hash invalidate only that entry ---');
{
  const dir = freshRoot();
  cache.writeMarketCache('charts/AAA/1d-5m', { keep: 'me' }, 60_000, 'live', dir);
  cache.writeMarketCache('charts/BBB/1d-5m', { also: 'keep' }, 60_000, 'live', dir);
  cache.writeMarketCache('charts/CCC/1d-5m', { corrupt: 'this' }, 60_000, 'live', dir);
  assert.equal(cache.getMarketCacheStats(dir).entries, 3);

  // Overwrite one payload with bytes whose hash no longer matches the manifest.
  const target = path.join(dir, 'charts', 'CCC', '1d-5m.json.gz');
  fs.writeFileSync(target, Buffer.from('not gzip at all'));
  assert.equal(
    cache.readMarketCache('charts/CCC/1d-5m', dir),
    null,
    'a hash mismatch reads as a miss',
  );
  assert.ok(!fs.existsSync(target), 'and the bad payload is removed');

  // The unrelated entries are untouched.
  assert.deepEqual(cache.readMarketCache('charts/AAA/1d-5m', dir).value, { keep: 'me' });
  assert.deepEqual(cache.readMarketCache('charts/BBB/1d-5m', dir).value, { also: 'keep' });
  assert.equal(cache.getMarketCacheStats(dir).entries, 2, 'only the corrupt entry was dropped');

  // Valid gzip whose content is not JSON: same outcome, via the parse guard.
  cache.writeMarketCache('charts/DDD/1d-5m', { fine: true }, 60_000, 'live', dir);
  const ddd = path.join(dir, 'charts', 'DDD', '1d-5m.json.gz');
  const badJson = zlib.gzipSync(Buffer.from('{ truncated', 'utf8'));
  fs.writeFileSync(ddd, badJson);
  // Repoint the manifest hash so the bytes verify but the JSON does not parse —
  // this is the path that would otherwise throw out of gunzip/JSON.parse.
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const crypto = await import('node:crypto');
  manifest.entries['charts/DDD/1d-5m'].sha256 = crypto
    .createHash('sha256')
    .update(badJson)
    .digest('hex');
  manifest.entries['charts/DDD/1d-5m'].byteLength = badJson.byteLength;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.equal(
    cache.readMarketCache('charts/DDD/1d-5m', dir),
    null,
    'unparseable JSON reads as a miss instead of throwing',
  );

  // A manifest entry whose file is gone is forgotten, not fatal.
  cache.writeMarketCache('charts/EEE/1d-5m', { gone: true }, 60_000, 'live', dir);
  fs.rmSync(path.join(dir, 'charts', 'EEE', '1d-5m.json.gz'));
  assert.equal(cache.readMarketCache('charts/EEE/1d-5m', dir), null);
  assert.ok(
    !cache.readManifest(dir).entries['charts/EEE/1d-5m'],
    'the dangling manifest entry is dropped',
  );
}

// ---------------------------------------------------------------------------
console.log('--- Test 4: Stale entries are returned, flagged, and never silently fresh ---');
{
  const dir = freshRoot();
  const now = Date.UTC(2026, 0, 15, 15, 0, 0);
  cache.writeMarketCache('charts/SPY/1d-5m-ext', { v: 1 }, 20_000, 'live', dir, now);

  const fresh = cache.readMarketCache('charts/SPY/1d-5m-ext', dir, now + 10_000);
  assert.equal(fresh.stale, false, 'inside the TTL');

  const stale = cache.readMarketCache('charts/SPY/1d-5m-ext', dir, now + 30_000);
  assert.equal(stale.stale, true, 'past the TTL');
  assert.deepEqual(stale.value, { v: 1 }, 'but the payload is still returned');

  // Exactly at expiry counts as stale — a boundary that must not round in the
  // optimistic direction.
  const atBoundary = cache.readMarketCache('charts/SPY/1d-5m-ext', dir, now + 20_000);
  assert.equal(atBoundary.stale, true, 'expiry is inclusive');

  // Sample provenance survives the round trip so a reader can refuse it.
  cache.writeMarketCache('charts/XXX/1d-5m', { v: 2 }, 20_000, 'sample', dir, now);
  assert.equal(cache.readMarketCache('charts/XXX/1d-5m', dir, now).source, 'sample');
}

// ---------------------------------------------------------------------------
console.log('--- Test 5: Pruning evicts oldest first and sweeps orphans ---');
{
  const dir = freshRoot();
  const base = Date.UTC(2026, 0, 15, 15, 0, 0);
  // Distinct fetchedAt values so eviction order is deterministic.
  for (let i = 0; i < 6; i++) {
    cache.writeMarketCache(
      `charts/SYM${i}/1d-5m`,
      { filler: 'x'.repeat(4096), i },
      60_000,
      'live',
      dir,
      base + i * 1_000,
    );
  }
  const before = cache.getMarketCacheStats(dir);
  assert.equal(before.entries, 6);

  // Budget that only fits some of them.
  const budget = Math.floor(before.compressedBytes / 2);
  const result = cache.pruneMarketCache(budget, dir);
  assert.ok(result.removedEntries > 0, 'pruning removed something');
  const after = cache.getMarketCacheStats(dir);
  assert.ok(after.compressedBytes <= budget, `expected <= ${budget}, got ${after.compressedBytes}`);
  assert.ok(after.entries < before.entries);

  // The oldest went first, the newest survived.
  const surviving = Object.keys(cache.readManifest(dir).entries);
  assert.ok(!surviving.includes('charts/SYM0/1d-5m'), 'oldest evicted');
  assert.ok(surviving.includes('charts/SYM5/1d-5m'), 'newest retained');

  // Evicted payload files are gone from disk, not just from the manifest.
  assert.ok(!fs.existsSync(path.join(dir, 'charts', 'SYM0', '1d-5m.json.gz')));

  // An orphan payload — the crash-between-write-and-manifest case — is swept.
  const orphanDir = path.join(dir, 'charts', 'ORPH');
  fs.mkdirSync(orphanDir, { recursive: true });
  const orphan = path.join(orphanDir, '1d-5m.json.gz');
  fs.writeFileSync(orphan, zlib.gzipSync(Buffer.from('{}')));
  const strayTemp = path.join(orphanDir, '1d-5m.json.gz.tmp');
  fs.writeFileSync(strayTemp, Buffer.from('partial'));
  const sweep = cache.pruneMarketCache(budget, dir);
  assert.ok(sweep.removedOrphans >= 2, `expected the orphan and temp swept, got ${sweep.removedOrphans}`);
  assert.ok(!fs.existsSync(orphan), 'unreferenced payload removed');
  assert.ok(!fs.existsSync(strayTemp), 'stray temp file removed');

  // A generous budget is a no-op.
  const noop = cache.pruneMarketCache(1024 * 1024 * 1024, dir);
  assert.equal(noop.removedEntries, 0);
  assert.equal(cache.getMarketCacheStats(dir).entries, after.entries);
}

// ---------------------------------------------------------------------------
console.log('--- Test 6: Cache keys cannot escape the cache root ---');
{
  // A key is partly derived from a user-supplied symbol, so traversal has to be
  // structurally impossible rather than merely unlikely.
  const hostile = cache.cacheKeyToRelativePath('charts/../../../../etc/passwd');
  assert.ok(!hostile.includes('..'), `traversal survived: ${hostile}`);
  assert.ok(!path.isAbsolute(hostile));
  assert.equal(cache.cacheKeyToRelativePath('charts/NVDA/1d-5m-ext'), path.join('charts', 'NVDA', '1d-5m-ext.json.gz'));
  assert.ok(cache.cacheKeyToRelativePath('').endsWith('.json.gz'), 'an empty key still yields a path');
  assert.ok(!cache.cacheKeyToRelativePath('a/b\0c').includes('\0'), 'null bytes are stripped');

  const dir = freshRoot();
  cache.writeMarketCache('charts/../../escape', { v: 1 }, 60_000, 'live', dir);
  const read = cache.readMarketCache('charts/../../escape', dir);
  assert.ok(read, 'the write still round trips under a sanitised path');
  const written = cache.readManifest(dir).entries['charts/../../escape'].relativePath;
  assert.ok(
    !path.resolve(dir, written).startsWith(path.resolve(dir, '..') + path.sep) ||
      path.resolve(dir, written).startsWith(path.resolve(dir) + path.sep),
    `payload escaped the root: ${written}`,
  );
}

// ---------------------------------------------------------------------------
console.log('--- Test 7: Delete, and the 24-hour prune throttle ---');
{
  const dir = freshRoot();
  cache.writeMarketCache('charts/DEL/1d-5m', { v: 1 }, 60_000, 'live', dir);
  cache.deleteMarketCache('charts/DEL/1d-5m', dir);
  assert.equal(cache.readMarketCache('charts/DEL/1d-5m', dir), null);
  assert.equal(cache.getMarketCacheStats(dir).entries, 0);
  // Deleting something absent is a no-op, not an error.
  cache.deleteMarketCache('charts/NOPE/1d-5m', dir);

  cache.resetPruneThrottleForTests();
  const start = Date.UTC(2026, 0, 15, 15, 0, 0);
  assert.equal(cache.pruneMarketCacheIfDue(undefined, start), true, 'first call runs');
  assert.equal(
    cache.pruneMarketCacheIfDue(undefined, start + 60_000),
    false,
    'a minute later it is throttled',
  );
  assert.equal(
    cache.pruneMarketCacheIfDue(undefined, start + 25 * 60 * 60_000),
    true,
    'a day later it runs again',
  );
  cache.resetPruneThrottleForTests();
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nAll market cache v3 tests passed successfully!');
