// Persistent market-data cache: gzip JSON payloads under a manifest, written
// atomically, verified by hash.
//
// Responsibilities are deliberately narrow — paths, bytes, integrity, pruning,
// stats. It knows nothing about charts, Yahoo, ranges or sessions; that is
// `chartRepository.ts`. No native database dependency.
//
// The integrity rules that matter:
//   * payload is written to `*.tmp`, fsynced, then renamed — a torn write can
//     never be observed under the final path;
//   * the manifest goes through the same temp-and-rename sequence;
//   * the SHA-256 is over the *compressed* bytes, so a truncated or corrupted
//     file fails verification rather than deserializing into nonsense;
//   * a hash mismatch invalidates only that entry, never the manifest;
//   * the previous valid payload is never deleted before a new one commits.

import { app } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { DataSource, MarketCacheStats } from '../../shared/types';

export const MARKET_CACHE_SCHEMA_VERSION = 3;
export const MARKET_CACHE_DIR_NAME = 'market-cache-v3';
export const DEFAULT_MARKET_CACHE_BUDGET_BYTES = 512 * 1024 * 1024;

export interface MarketCacheManifestEntry {
  relativePath: string;
  fetchedAt: string;
  expiresAt: string;
  source: DataSource;
  byteLength: number;
  sha256: string;
}

export interface MarketCacheManifestV3 {
  schemaVersion: typeof MARKET_CACHE_SCHEMA_VERSION;
  updatedAt: string;
  entries: Record<string, MarketCacheManifestEntry>;
}

export interface PersistentCacheRead<T> {
  value: T;
  fetchedAt: string;
  expiresAt: string;
  stale: boolean;
  source: DataSource;
}

/** Overridable so tests and the prune job can point at a scratch directory
 *  without an Electron app instance. */
let cacheRootOverride: string | null = null;

export function setMarketCacheRoot(root: string | null): void {
  cacheRootOverride = root;
}

export function marketCacheRoot(): string {
  if (cacheRootOverride) return cacheRootOverride;
  return path.join(app.getPath('userData'), MARKET_CACHE_DIR_NAME);
}

function manifestPath(root = marketCacheRoot()): string {
  return path.join(root, 'manifest.json');
}

/**
 * Maps a logical key to a relative path.
 *
 * Keys look like `charts/NVDA/1d-5m-ext` or `universe/latest-eod-features`.
 * Every segment is sanitised: a key is partly derived from a symbol, and a
 * symbol like `../../etc` must not be able to address a path outside the cache
 * root. Anything outside the allowed set collapses to `_`.
 */
export function cacheKeyToRelativePath(key: string): string {
  const segments = key
    .split('/')
    .map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, '_'))
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
  if (!segments.length) return '_.json.gz';
  return `${segments.join(path.sep)}.json.gz`;
}

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function emptyManifest(): MarketCacheManifestV3 {
  return {
    schemaVersion: MARKET_CACHE_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    entries: {},
  };
}

function isManifestEntry(value: unknown): value is MarketCacheManifestEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<MarketCacheManifestEntry>;
  return (
    typeof entry.relativePath === 'string' &&
    typeof entry.fetchedAt === 'string' &&
    typeof entry.expiresAt === 'string' &&
    (entry.source === 'live' || entry.source === 'sample') &&
    typeof entry.byteLength === 'number' &&
    typeof entry.sha256 === 'string'
  );
}

/** A missing or unreadable manifest is an empty cache, never a startup crash. */
export function readManifest(root = marketCacheRoot()): MarketCacheManifestV3 {
  try {
    const raw = fs.readFileSync(manifestPath(root), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return emptyManifest();
    const candidate = parsed as Partial<MarketCacheManifestV3>;
    if (candidate.schemaVersion !== MARKET_CACHE_SCHEMA_VERSION) return emptyManifest();
    const entries: Record<string, MarketCacheManifestEntry> = {};
    for (const [key, entry] of Object.entries(candidate.entries ?? {})) {
      if (isManifestEntry(entry)) entries[key] = entry;
    }
    return {
      schemaVersion: MARKET_CACHE_SCHEMA_VERSION,
      updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : new Date().toISOString(),
      entries,
    };
  } catch {
    return emptyManifest();
  }
}

function writeFileAtomic(filePath: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp`;
  const handle = fs.openSync(temp, 'w');
  try {
    fs.writeFileSync(handle, data);
    // fsync before the rename, otherwise the rename can be durable while the
    // bytes it points at are not.
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temp, filePath);
}

function writeManifest(manifest: MarketCacheManifestV3, root = marketCacheRoot()): void {
  writeFileAtomic(
    manifestPath(root),
    JSON.stringify({ ...manifest, updatedAt: new Date().toISOString() }, null, 2),
  );
}

/** Drops one entry from the manifest without touching the others. */
function forgetEntry(key: string, root: string): void {
  const manifest = readManifest(root);
  if (!manifest.entries[key]) return;
  delete manifest.entries[key];
  writeManifest(manifest, root);
}

export function readMarketCache<T>(
  key: string,
  root = marketCacheRoot(),
  now = Date.now(),
): PersistentCacheRead<T> | null {
  const manifest = readManifest(root);
  const entry = manifest.entries[key];
  if (!entry) return null;

  const filePath = path.join(root, entry.relativePath);
  let compressed: Buffer;
  try {
    compressed = fs.readFileSync(filePath);
  } catch {
    forgetEntry(key, root);
    return null;
  }

  // Verify before decompressing: a mismatch means the bytes on disk are not
  // what was committed, and gunzip on garbage throws in ways callers should not
  // have to distinguish.
  if (sha256(compressed) !== entry.sha256 || compressed.byteLength !== entry.byteLength) {
    deleteMarketCache(key, root);
    return null;
  }

  let value: T;
  try {
    value = JSON.parse(zlib.gunzipSync(compressed).toString('utf8')) as T;
  } catch {
    deleteMarketCache(key, root);
    return null;
  }

  return {
    value,
    fetchedAt: entry.fetchedAt,
    expiresAt: entry.expiresAt,
    stale: Date.parse(entry.expiresAt) <= now,
    source: entry.source,
  };
}

export function writeMarketCache<T>(
  key: string,
  value: T,
  ttlMs: number,
  source: DataSource,
  root = marketCacheRoot(),
  now = Date.now(),
): MarketCacheManifestEntry | null {
  let compressed: Buffer;
  try {
    compressed = zlib.gzipSync(Buffer.from(JSON.stringify(value), 'utf8'));
  } catch {
    return null;
  }

  const relativePath = cacheKeyToRelativePath(key);
  const filePath = path.join(root, relativePath);
  const entry: MarketCacheManifestEntry = {
    relativePath,
    fetchedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Math.max(0, ttlMs)).toISOString(),
    source,
    byteLength: compressed.byteLength,
    sha256: sha256(compressed),
  };

  try {
    // Payload commits first. If the process dies here the manifest still points
    // at the previous payload, which is the safe direction to fail.
    writeFileAtomic(filePath, compressed);
    const manifest = readManifest(root);
    manifest.entries[key] = entry;
    writeManifest(manifest, root);
    return entry;
  } catch {
    return null;
  }
}

export function deleteMarketCache(key: string, root = marketCacheRoot()): void {
  const manifest = readManifest(root);
  const entry = manifest.entries[key];
  if (entry) {
    try {
      fs.rmSync(path.join(root, entry.relativePath), { force: true });
    } catch {
      /* the manifest entry is dropped regardless */
    }
    delete manifest.entries[key];
    try {
      writeManifest(manifest, root);
    } catch {
      /* stats stay slightly wrong until the next successful write */
    }
  }
}

export function getMarketCacheStats(root = marketCacheRoot()): MarketCacheStats {
  const manifest = readManifest(root);
  const values = Object.values(manifest.entries);
  return {
    entries: values.length,
    compressedBytes: values.reduce((sum, entry) => sum + entry.byteLength, 0),
  };
}

/**
 * Evicts oldest-fetched entries until the cache fits the budget, then removes
 * files the manifest no longer references.
 *
 * Orphan sweeping matters because a crash between the payload write and the
 * manifest write leaves a file nothing points at; without this it would never
 * be reclaimed and the budget would drift away from the real disk footprint.
 */
export function pruneMarketCache(
  maxBytes = DEFAULT_MARKET_CACHE_BUDGET_BYTES,
  root = marketCacheRoot(),
): { removedEntries: number; removedBytes: number; removedOrphans: number } {
  const manifest = readManifest(root);
  const entries = Object.entries(manifest.entries).sort(
    (a, b) => Date.parse(a[1].fetchedAt) - Date.parse(b[1].fetchedAt),
  );
  let total = entries.reduce((sum, [, entry]) => sum + entry.byteLength, 0);

  let removedEntries = 0;
  let removedBytes = 0;
  for (const [key, entry] of entries) {
    if (total <= maxBytes) break;
    try {
      fs.rmSync(path.join(root, entry.relativePath), { force: true });
    } catch {
      /* fall through: the entry is dropped either way */
    }
    delete manifest.entries[key];
    total -= entry.byteLength;
    removedBytes += entry.byteLength;
    removedEntries += 1;
  }

  const referenced = new Set(
    Object.values(manifest.entries).map((entry) => path.join(root, entry.relativePath)),
  );
  let removedOrphans = 0;
  const sweep = (dir: string): void => {
    let listing: fs.Dirent[];
    try {
      listing = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of listing) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        sweep(full);
        continue;
      }
      if (full === manifestPath(root)) continue;
      const isPayload = item.name.endsWith('.json.gz');
      const isTemp = item.name.endsWith('.tmp');
      if ((isPayload && !referenced.has(full)) || isTemp) {
        try {
          fs.rmSync(full, { force: true });
          removedOrphans += 1;
        } catch {
          /* ignore */
        }
      }
    }
  };
  sweep(root);

  if (removedEntries > 0) {
    try {
      writeManifest(manifest, root);
    } catch {
      /* the files are gone; the manifest self-heals on the next read */
    }
  }
  return { removedEntries, removedBytes, removedOrphans };
}

const PRUNE_INTERVAL_MS = 24 * 60 * 60_000;
let lastPruneAt = 0;

/** Runs at most once per 24 hours, on the main thread only. */
export function pruneMarketCacheIfDue(
  maxBytes = DEFAULT_MARKET_CACHE_BUDGET_BYTES,
  now = Date.now(),
): boolean {
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return false;
  lastPruneAt = now;
  try {
    pruneMarketCache(maxBytes);
  } catch {
    /* a failed prune must never take the app down */
  }
  return true;
}

/** Test seam: resets the 24-hour prune throttle. */
export function resetPruneThrottleForTests(): void {
  lastPruneAt = 0;
}
