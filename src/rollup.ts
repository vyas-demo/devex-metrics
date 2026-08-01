/**
 * Multi-owner rollups.
 *
 * Merges the cached `OrgMetrics` of several collection targets (defined in
 * the `rollup` entry of `devex.config.json`) into one combined `OrgMetrics`
 * so a single dashboard/report can span multiple orgs or users. Pure merge
 * logic plus cache reads — no API calls; each target must have been
 * collected first so its cache is fresh and schema-current.
 */
import { buildTargetKey, loadRawCache, CURRENT_SCHEMA_VERSION } from "./cache.js";
import type {
  OrgMetrics,
  RepoMetrics,
  RollupConfig,
  WeeklyTrendPoint,
} from "./types.js";

/** Millisecond timestamp of an optional ISO string; missing → -Infinity. */
function timeOf(timestamp: string | undefined): number {
  if (!timestamp) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * Concatenate repo lists, deduplicating by `fullName`. When the same repo
 * appears in multiple inputs the entry with the newer `collectedAt` wins;
 * an entry without `collectedAt` loses ties (and ties between equal or
 * both-missing timestamps keep the first-seen entry).
 */
function mergeRepos(inputs: OrgMetrics[]): RepoMetrics[] {
  const byFullName = new Map<string, RepoMetrics>();
  for (const input of inputs) {
    for (const repo of input.repos) {
      const existing = byFullName.get(repo.fullName);
      if (!existing || timeOf(repo.collectedAt) > timeOf(existing.collectedAt)) {
        byFullName.set(repo.fullName, repo);
      }
    }
  }
  return [...byFullName.values()];
}

/**
 * Union weekly trend series by ISO week label, summing every numeric field
 * across inputs, sorted ascending by label. Undefined when no input has
 * trend data.
 */
function mergeWeeklyTrends(inputs: OrgMetrics[]): WeeklyTrendPoint[] | undefined {
  const byWeek = new Map<string, WeeklyTrendPoint>();
  let sawTrends = false;
  for (const input of inputs) {
    if (!input.weeklyTrends) continue;
    sawTrends = true;
    for (const point of input.weeklyTrends) {
      const existing = byWeek.get(point.week);
      if (!existing) {
        byWeek.set(point.week, {
          week: point.week,
          prsOpened: point.prsOpened ?? 0,
          prsMerged: point.prsMerged ?? 0,
          issuesOpened: point.issuesOpened ?? 0,
          issuesClosed: point.issuesClosed ?? 0,
          linesAdded: point.linesAdded ?? 0,
          linesDeleted: point.linesDeleted ?? 0,
        });
        continue;
      }
      existing.prsOpened += point.prsOpened ?? 0;
      existing.prsMerged += point.prsMerged ?? 0;
      existing.issuesOpened += point.issuesOpened ?? 0;
      existing.issuesClosed += point.issuesClosed ?? 0;
      existing.linesAdded += point.linesAdded ?? 0;
      existing.linesDeleted += point.linesDeleted ?? 0;
    }
  }
  if (!sawTrends) return undefined;
  return [...byWeek.values()].sort((a, b) => a.week.localeCompare(b.week));
}

/**
 * Merge several collected `OrgMetrics` into one combined view named `name`.
 *
 * The result is stamped `owner: name`, `ownerType: "org"`, and the current
 * cache schema version; `collectedAt` is the newest input timestamp. Repos
 * are concatenated and deduplicated by `fullName` (newer `collectedAt`
 * wins; missing `collectedAt` loses ties) and `repoCount` reflects the
 * merged list. Weekly trends are unioned by week label with all numeric
 * fields summed, sorted ascending.
 *
 * `copilotUsage` is included ONLY when exactly one input carries it:
 * usage reports from org and enterprise scopes can describe overlapping
 * user populations, so summing their counters would double-count shared
 * reports. When two or more inputs have usage data it is dropped with a
 * console warning; when none has it the result has none either.
 *
 * @throws Error when `inputs` is empty.
 */
export function mergeOrgMetrics(inputs: OrgMetrics[], name: string): OrgMetrics {
  if (inputs.length === 0) {
    throw new Error("mergeOrgMetrics requires at least one input OrgMetrics");
  }

  const repos = mergeRepos(inputs);
  const weeklyTrends = mergeWeeklyTrends(inputs);
  const collectedAt = inputs
    .map((input) => input.collectedAt)
    .reduce((max, current) => (timeOf(current) > timeOf(max) ? current : max));

  const withUsage = inputs.filter((input) => input.copilotUsage !== undefined);
  let copilotUsage: OrgMetrics["copilotUsage"];
  if (withUsage.length === 1) {
    copilotUsage = withUsage[0].copilotUsage;
  } else if (withUsage.length > 1) {
    console.warn(
      `Rollup "${name}": ${withUsage.length} targets have Copilot usage data ` +
        `(${withUsage.map((input) => input.owner).join(", ")}). Merging usage ` +
        `counters across scopes double-counts shared reports, so Copilot usage ` +
        `is omitted from the rollup.`
    );
  }

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    owner: name,
    ownerType: "org",
    collectedAt,
    repoCount: repos.length,
    repos,
    ...(weeklyTrends ? { weeklyTrends } : {}),
    ...(copilotUsage ? { copilotUsage } : {}),
  };
}

/**
 * Load and merge the cached metrics for every target of a rollup config.
 *
 * Each target's cache is read via `loadRawCache(buildTargetKey(...))`;
 * targets whose cache is missing, unreadable, or schema-stale are skipped
 * with a console warning telling the user to collect that target first.
 * Returns null (with a warning) when no target could be loaded, otherwise
 * the `mergeOrgMetrics` result named after the rollup.
 */
export function loadRollupMetrics(config: RollupConfig): OrgMetrics | null {
  const loaded: OrgMetrics[] = [];
  for (const target of config.targets) {
    const key = buildTargetKey(target.owner, target.ownerType, target.repo);
    const metrics = loadRawCache(key);
    if (!metrics) {
      const targetLabel = target.repo
        ? `${target.owner}/${target.repo} (${target.ownerType})`
        : `${target.owner} (${target.ownerType})`;
      console.warn(
        `Rollup "${config.name}": no usable cache for ${targetLabel} ` +
          `(expected data/${key}.json with schema version ${CURRENT_SCHEMA_VERSION}). ` +
          `Collect it first: node dist/index.js ${target.owner} ${target.ownerType}` +
          `${target.repo ? ` ${target.repo}` : ""}. Skipping this target.`
      );
      continue;
    }
    loaded.push(metrics);
  }

  if (loaded.length === 0) {
    console.warn(
      `Rollup "${config.name}": none of the ${config.targets.length} configured ` +
        `targets had usable cached data. Collect each target first.`
    );
    return null;
  }

  return mergeOrgMetrics(loaded, config.name);
}
