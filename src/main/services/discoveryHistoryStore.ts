// Persisted discovery snapshots, so novelty can compare against the previous
// completed scan.
//
// Snapshots are gzipped and kept for 30 days. Only the fields novelty needs are
// stored — a full run result per scan would grow without bound for no benefit.

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { DiscoverySnapshot, DiscoverySnapshotEntry } from '../../shared/discoveryNovelty';

export const DISCOVERY_HISTORY_DIR = 'discovery-history-v3';
export const LATEST_SNAPSHOT_FILE = 'latest.json.gz';
const RETENTION_DAYS = 30;

let rootOverride: string | null = null;

export function setDiscoveryHistoryRoot(root: string | null): void {
  rootOverride = root;
}

/** The resolved snapshot directory. Exported because `setDiscoveryHistoryRoot`
 *  takes the *parent* — a caller that assumed otherwise would read and write
 *  different directories without any error. */
export function discoveryHistoryDir(): string {
  return path.join(rootOverride ?? app.getPath('userData'), DISCOVERY_HISTORY_DIR);
}

function historyDir(): string {
  return discoveryHistoryDir();
}

/** `2026-09-15T190000Z.json.gz` — sortable, filename-safe. */
export function snapshotFileName(completedAt: string): string {
  const stamp = new Date(completedAt).toISOString().replace(/[:.]/g, '').replace(/\d{3}Z$/, 'Z');
  return `${stamp}.json.gz`;
}

function readSnapshotFile(filePath: string): DiscoverySnapshot | null {
  try {
    const parsed = JSON.parse(
      zlib.gunzipSync(fs.readFileSync(filePath)).toString('utf8'),
    ) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const snapshot = parsed as Partial<DiscoverySnapshot>;
    if (typeof snapshot.id !== 'string' || typeof snapshot.completedAt !== 'string') return null;
    if (!snapshot.entries || typeof snapshot.entries !== 'object') return null;
    return {
      id: snapshot.id,
      completedAt: snapshot.completedAt,
      entries: snapshot.entries as Record<string, DiscoverySnapshotEntry>,
    };
  } catch {
    // A corrupt snapshot means novelty has no baseline, which is a degraded
    // result rather than a failure.
    return null;
  }
}

export function getLatestDiscoverySnapshot(): DiscoverySnapshot | null {
  return readSnapshotFile(path.join(historyDir(), LATEST_SNAPSHOT_FILE));
}

export function saveDiscoverySnapshot(snapshot: DiscoverySnapshot): void {
  const dir = historyDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const payload = zlib.gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8'));
    const dated = path.join(dir, snapshotFileName(snapshot.completedAt));
    const latest = path.join(dir, LATEST_SNAPSHOT_FILE);
    // The dated copy commits first: if the process dies between the two writes,
    // `latest` still points at the previous good snapshot rather than nothing.
    fs.writeFileSync(`${dated}.tmp`, payload);
    fs.renameSync(`${dated}.tmp`, dated);
    fs.writeFileSync(`${latest}.tmp`, payload);
    fs.renameSync(`${latest}.tmp`, latest);
    pruneDiscoveryHistory();
  } catch {
    // Failing to persist a snapshot costs the next run its novelty baseline.
  }
}

export function pruneDiscoveryHistory(retentionDays = RETENTION_DAYS): number {
  const dir = historyDir();
  let removed = 0;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60_000;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name === LATEST_SNAPSHOT_FILE) continue;
      if (!name.endsWith('.json.gz')) {
        if (name.endsWith('.tmp')) {
          fs.rmSync(path.join(dir, name), { force: true });
          removed += 1;
        }
        continue;
      }
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.rmSync(full, { force: true });
          removed += 1;
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no directory yet */
  }
  return removed;
}

export function listDiscoverySnapshots(): string[] {
  try {
    return fs
      .readdirSync(historyDir())
      .filter((name) => name.endsWith('.json.gz') && name !== LATEST_SNAPSHOT_FILE)
      .sort();
  } catch {
    return [];
  }
}
