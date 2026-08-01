/**
 * Snapshot history (Phase 2: memory).
 *
 * Every collection appends a compact daily rollup of key metrics to a
 * per-target history file (`data/<targetKey>-history.json`) so the dashboard
 * can show real week-over-week deltas instead of re-deriving trends from PR
 * timestamps alone. Snapshot values are derived with the existing pure
 * compute modules (DORA, review stats, engineering intelligence, health) —
 * no additional API calls.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  HistoryDeltas,
  HistoryFile,
  HistorySnapshot,
  MetricDelta,
  OrgMetrics,
} from "./types.js";
import { computeDoraMetrics, computeReviewStats } from "./dora.js";
import { computeEngineeringIntelligence } from "./developer-stats.js";
import { computeHealthReport } from "./health.js";

const DATA_DIR = path.resolve(process.cwd(), "data");

/**
 * Current history-file schema version. Bump whenever `HistorySnapshot`
 * changes shape incompatibly so stale history files are discarded instead of
 * mixing incompatible snapshots.
 */
export const HISTORY_SCHEMA_VERSION = 1;

/** Ring-buffer cap on stored snapshots (~13 months of daily collections). */
const MAX_SNAPSHOTS = 400;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build a compact history snapshot from collected org metrics.
 *
 * Pure: derives everything from `metrics` via the existing compute modules
 * (30-day windows for the DORA/review rollups, full window for contributor
 * and health figures) without touching the filesystem or network.
 */
export function buildHistorySnapshot(metrics: OrgMetrics): HistorySnapshot {
  let openIssues = 0;
  let openPRs = 0;
  for (const repo of metrics.repos) {
    openIssues += repo.issues.open;
    openPRs += repo.pullRequests.open;
  }

  const dora = computeDoraMetrics(metrics, { windowDays: 30 });
  const review = computeReviewStats(metrics, { windowDays: 30 });
  const intelligence = computeEngineeringIntelligence(metrics);
  const health = computeHealthReport(metrics);
  const copilotActiveUsers = metrics.copilotUsage?.totals.activeUsers;

  return {
    date: metrics.collectedAt.slice(0, 10),
    collectedAt: metrics.collectedAt,
    repoCount: metrics.repoCount,
    openIssues,
    openPRs,
    mergedPRs30d: dora.totalMergedPRs,
    medianCycleHours30d: dora.leadTimeHours.value,
    reviewCoverage30d: review.reviewCoverage,
    contributorCount: intelligence.contributorCount,
    avgHealthScore: health.avgScore,
    needsAttentionCount: health.repos.filter((r) => r.needsAttention).length,
    aiShare: intelligence.aiImpact.aiShare,
    deploys30d: dora.totalDeploys,
    reverts30d: dora.totalReverts,
    ...(copilotActiveUsers !== undefined ? { copilotActiveUsers } : {}),
  };
}

/** Absolute path of the history file for a cache target key. */
export function historyFilePath(targetKey: string): string {
  return path.join(DATA_DIR, `${targetKey}-history.json`);
}

/**
 * Load the history file for `targetKey`.
 *
 * Returns null (never throws) when the file is absent, unparseable, or has a
 * schema version other than `HISTORY_SCHEMA_VERSION`; the latter two cases
 * log a warning.
 */
export function loadHistory(targetKey: string): HistoryFile | null {
  const filePath = historyFilePath(targetKey);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const file = JSON.parse(raw) as HistoryFile;
    if (file.schemaVersion !== HISTORY_SCHEMA_VERSION || !Array.isArray(file.snapshots)) {
      console.warn(
        `History file for ${targetKey} has schema version ${file.schemaVersion ?? "none"} ` +
        `(current: ${HISTORY_SCHEMA_VERSION}). Ignoring stale history.`
      );
      return null;
    }
    return file;
  } catch (error) {
    console.warn(`Failed to read history file for ${targetKey}: ${String(error)}`);
    return null;
  }
}

/**
 * Append a snapshot built from `metrics` to the history file for `targetKey`
 * and persist it.
 *
 * Idempotent per day: an existing snapshot with the same `date` is replaced
 * rather than duplicated. Snapshots are kept in ascending date order and
 * trimmed to the most recent `MAX_SNAPSHOTS`. Load errors never throw (a
 * fresh file is started instead); write errors propagate to the caller.
 */
export function appendHistorySnapshot(targetKey: string, metrics: OrgMetrics): HistoryFile {
  const file: HistoryFile = loadHistory(targetKey) ?? {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    targetKey,
    snapshots: [],
  };

  const snapshot = buildHistorySnapshot(metrics);
  const snapshots = file.snapshots.filter((s) => s.date !== snapshot.date);
  snapshots.push(snapshot);
  snapshots.sort((a, b) => a.date.localeCompare(b.date));
  file.snapshots = snapshots.slice(-MAX_SNAPSHOTS);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(historyFilePath(targetKey), JSON.stringify(file, null, 2));
  return file;
}

/** Options for `computeHistoryDeltas`. */
export interface HistoryDeltaOptions {
  /** Ideal age in days of the baseline snapshot. Default 7. */
  targetDays?: number;
}

/** Numeric snapshot fields compared by `computeHistoryDeltas`, in emit order. */
const DELTA_METRICS: ReadonlyArray<{
  id:
    | "mergedPRs30d"
    | "medianCycleHours30d"
    | "reviewCoverage30d"
    | "avgHealthScore"
    | "needsAttentionCount"
    | "openIssues"
    | "openPRs"
    | "contributorCount"
    | "aiShare"
    | "deploys30d"
    | "reverts30d";
  label: string;
  goodDirection: "up" | "down";
}> = [
  { id: "mergedPRs30d", label: "Merged PRs (30d)", goodDirection: "up" },
  { id: "medianCycleHours30d", label: "Median cycle time (30d)", goodDirection: "down" },
  { id: "reviewCoverage30d", label: "Review coverage (30d)", goodDirection: "up" },
  { id: "avgHealthScore", label: "Avg health score", goodDirection: "up" },
  { id: "needsAttentionCount", label: "Repos needing attention", goodDirection: "down" },
  { id: "openIssues", label: "Open issues", goodDirection: "down" },
  { id: "openPRs", label: "Open PRs", goodDirection: "down" },
  { id: "contributorCount", label: "Contributors", goodDirection: "up" },
  { id: "aiShare", label: "AI share of merges", goodDirection: "up" },
  { id: "deploys30d", label: "Deploys (30d)", goodDirection: "up" },
  { id: "reverts30d", label: "Reverts (30d)", goodDirection: "down" },
];

/**
 * Compare the latest history snapshot against a ~`targetDays`-old baseline.
 *
 * The baseline is the snapshot whose date is closest to
 * `latest.date − targetDays`, considering only snapshots at least one day
 * older than the latest; on a distance tie the older snapshot wins. When no
 * usable baseline exists (missing history, fewer than two snapshots) the
 * result has `hasData: false` and no deltas.
 */
export function computeHistoryDeltas(
  history: HistoryFile | null,
  options?: HistoryDeltaOptions
): HistoryDeltas {
  const targetDays = options?.targetDays ?? 7;
  const snapshots = [...(history?.snapshots ?? [])].sort((a, b) =>
    a.date.localeCompare(b.date)
  );
  if (snapshots.length < 2) return { hasData: false, deltas: [] };

  const latest = snapshots[snapshots.length - 1];
  const latestMs = Date.parse(latest.date);
  const targetMs = latestMs - targetDays * DAY_MS;

  let baseline: HistorySnapshot | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const snapshot of snapshots) {
    const ms = Date.parse(snapshot.date);
    if (latestMs - ms < DAY_MS) continue; // must be at least 1 day older
    const distance = Math.abs(ms - targetMs);
    // Strict < keeps the first (oldest) snapshot on a distance tie, since we
    // iterate in ascending date order.
    if (distance < bestDistance) {
      baseline = snapshot;
      bestDistance = distance;
    }
  }
  if (baseline === undefined) return { hasData: false, deltas: [] };

  const baselineMs = Date.parse(baseline.date);
  const deltas: MetricDelta[] = DELTA_METRICS.map(({ id, label, goodDirection }) => {
    const current = latest[id];
    const previous = baseline[id];
    const delta = current - previous;
    return {
      id,
      label,
      current,
      previous,
      delta,
      ...(previous !== 0 ? { pctChange: delta / previous } : {}),
      goodDirection,
    };
  });

  return {
    hasData: true,
    baselineDate: baseline.date,
    daysSpanned: Math.round((latestMs - baselineMs) / DAY_MS),
    deltas,
  };
}
