import * as fs from "node:fs";
import * as path from "node:path";
import { generateReport } from "./report.js";
import { buildTargetKey, CURRENT_SCHEMA_VERSION } from "./cache.js";
import { computeEngineeringIntelligence } from "./developer-stats.js";
import { computeDoraMetrics, computeReviewStats } from "./dora.js";
import { computeInsights } from "./insights.js";
import { computeHealthReport, healthGrade } from "./health.js";
import { computeCollaborationStats } from "./collaboration.js";
import { loadHistory, computeHistoryDeltas, appendHistorySnapshot } from "./history.js";
import { computeDeliveryForecast } from "./forecast.js";
import { loadTargetsConfig, evaluateTargets, TARGETS_CONFIG_FILENAME } from "./targets.js";
import { loadRollupMetrics } from "./rollup.js";
import {
  computeCopilotAdoptionImpact,
  copilotAdoptionPhaseLabel,
  sortCopilotRepositoryUsage,
} from "./copilot-impact.js";
import type {
  CacheEnvelope,
  OrgMetrics,
  RepoMetrics,
  CopilotUsageMetrics,
  EngineeringIntelligence,
  DoraMetrics,
  DoraTier,
  HealthGrade,
  ReviewStats,
  InsightSeverity,
  InsightsSummary,
  HealthReport,
  CollaborationStats,
  HistoryDeltas,
  MetricDelta,
  DeliveryForecast,
  TargetEvaluation,
} from "./types.js";

/**
 * Build a static GitHub Pages site from cached metrics data.
 *
 * Usage:
 *   node dist/build-pages.js <owner> [org|user] [repo]
 *   node dist/build-pages.js --rollup
 *
 * The single-owner form reads data/<owner>.json; `--rollup` merges the
 * caches of every target in the `rollup` entry of devex.config.json into
 * one combined dashboard. Both write:
 *   _site/index.html  – interactive dashboard
 *   _site/report.md   – Markdown report
 *   _site/data.json   – raw JSON API
 */
function main(): void {
  if (process.argv[2] === "--rollup") {
    buildRollupSite();
    return;
  }

  const owner = process.argv[2];
  const ownerType = (process.argv[3] ?? "org") as "org" | "user";
  const repo = process.argv[4];
  if (!owner) {
    console.error("Usage: build-pages <owner> [org|user] [repo] | build-pages --rollup");
    process.exit(1);
  }
  const targetKey = buildTargetKey(owner, ownerType, repo);

  const dataDir = path.resolve(process.cwd(), "data");
  const cacheFile = path.join(dataDir, `${targetKey}.json`);
  const fixtureFile = path.join(dataDir, `${targetKey}.fixture.json`);

  let envelope: CacheEnvelope;
  if (fs.existsSync(cacheFile)) {
    const raw = JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as CacheEnvelope;
    if (raw.data?.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      console.error(
        `Cache file schema version ${raw.data?.schemaVersion ?? "none"} does not match ` +
        `current version ${CURRENT_SCHEMA_VERSION}. Please re-run data collection.`
      );
      process.exit(1);
    }
    envelope = raw;
  } else if (fs.existsSync(fixtureFile)) {
    console.log(`No daily cache found; falling back to fixture at ${fixtureFile}`);
    const data = JSON.parse(fs.readFileSync(fixtureFile, "utf-8")) as OrgMetrics;
    if (data.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      console.error(
        `Fixture schema version ${data.schemaVersion ?? "none"} does not match ` +
        `current version ${CURRENT_SCHEMA_VERSION}. Fixture is stale — re-run collection to regenerate it.`
      );
      process.exit(1);
    }
    envelope = { date: data.collectedAt.slice(0, 10), data };
  } else {
    console.error(`No data found at ${cacheFile} or ${fixtureFile}`);
    process.exit(1);
  }

  buildSite(envelope.data, envelope.date);
}

/**
 * Build the merged multi-owner dashboard for `node dist/build-pages.js
 * --rollup`. Loads the rollup definition from devex.config.json, merges the
 * per-target caches, appends a history snapshot for the rollup's own key
 * (so the merged dashboard gets week-over-week deltas), and then builds the
 * site exactly like the single-owner path. Exits 1 with a clear error when
 * no config, no rollup entry, or no loadable target cache exists.
 */
function buildRollupSite(): void {
  const config = loadTargetsConfig();
  if (!config) {
    console.error(
      `--rollup requires a ${TARGETS_CONFIG_FILENAME} in the working directory ` +
      `with a "rollup" entry (see devex.config.example.json).`
    );
    process.exit(1);
  }
  if (!config.rollup) {
    console.error(
      `${TARGETS_CONFIG_FILENAME} has no valid "rollup" entry; add one with a ` +
      `name and a targets array (see devex.config.example.json).`
    );
    process.exit(1);
  }

  const merged = loadRollupMetrics(config.rollup);
  if (!merged) {
    console.error(
      `No rollup target caches could be loaded. Collect each target first ` +
      `(node dist/index.js <owner> <org|user> or node dist/index.js --rollup).`
    );
    process.exit(1);
  }

  // Give the rollup its own history so the merged dashboard shows real
  // deltas over time (buildDashboardHtml reloads it by the same key).
  try {
    appendHistorySnapshot(buildTargetKey(merged.owner, "org"), merged);
  } catch (error) {
    console.warn(`Failed to append rollup history snapshot: ${String(error)}`);
  }

  buildSite(merged, merged.collectedAt.slice(0, 10));
}

/**
 * Write the dashboard, Markdown report, raw JSON, and badge endpoints for
 * `data` into `_site/`. Shared by the single-owner and --rollup modes.
 */
function buildSite(data: OrgMetrics, date: string): void {
  const siteDir = path.resolve(process.cwd(), "_site");
  const markdown = generateReport(data);

  fs.mkdirSync(siteDir, { recursive: true });
  fs.writeFileSync(path.join(siteDir, "report.md"), markdown);
  fs.writeFileSync(
    path.join(siteDir, "data.json"),
    JSON.stringify(data, null, 2)
  );

  const branch = process.env.GITHUB_REF_NAME;
  const runUrl = buildRunUrl();
  const dashboard = buildDashboardHtml(data, date, branch, runUrl);
  fs.writeFileSync(path.join(siteDir, "index.html"), dashboard.html);

  // shields.io endpoint-badge JSON, computed from the same analytics the
  // dashboard already rendered (no recomputation just for badges).
  writeBadgeEndpoints(siteDir, dashboard.health, dashboard.dora30, dashboard.prsMerged30);

  console.log(`GitHub Pages site built in ${siteDir}/`);
}

/* ------------------------------------------------------------------ */
/*  Utilities                                                         */
/* ------------------------------------------------------------------ */

// GitHub mark SVG icon (used in hero nav and repo card links)
const GITHUB_MARK_SVG = '<svg height="16" width="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function buildRunUrl(): string | undefined {
  const server = process.env.GITHUB_SERVER_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (server && repo && runId) {
    return `${server}/${repo}/actions/runs/${runId}`;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/*  shields.io badge endpoints                                        */
/* ------------------------------------------------------------------ */

/** shields.io endpoint-badge schema (https://shields.io/badges/endpoint-badge). */
interface ShieldsEndpoint {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
}

/** Badge color per health letter grade (healthGrade in health.ts). */
const HEALTH_GRADE_BADGE_COLORS: Record<HealthGrade, string> = {
  A: "brightgreen",
  B: "green",
  C: "yellowgreen",
  D: "orange",
  F: "red",
};

/** Badge color per DORA tier (dora.ts benchmark bands). */
const DORA_TIER_BADGE_COLORS: Record<DoraTier, string> = {
  elite: "brightgreen",
  high: "green",
  medium: "yellow",
  low: "red",
};

/**
 * Emit machine-readable shields.io endpoint files next to the dashboard so a
 * README can embed live badges via https://img.shields.io/endpoint?url=…
 * Reuses the health report, 30-day DORA metrics, and 30-day merged-PR count
 * the dashboard already computed.
 */
function writeBadgeEndpoints(
  siteDir: string,
  health: HealthReport,
  dora: DoraMetrics,
  mergedPRs30d: number,
): void {
  const writeBadge = (name: string, badge: ShieldsEndpoint): void => {
    fs.writeFileSync(path.join(siteDir, name), JSON.stringify(badge, null, 2));
  };

  const grade = healthGrade(health.avgScore);
  writeBadge(
    "badge-health.json",
    health.hasData
      ? {
          schemaVersion: 1,
          label: "devex health",
          message: `${health.avgScore} (${grade})`,
          color: HEALTH_GRADE_BADGE_COLORS[grade],
        }
      : { schemaVersion: 1, label: "devex health", message: "no data", color: "lightgrey" },
  );

  const lead = dora.leadTimeHours;
  writeBadge(
    "badge-dora.json",
    lead.hasData && lead.tier
      ? {
          schemaVersion: 1,
          label: "DORA lead time",
          message: `${formatDurationHtml(lead.value)} · ${lead.tier}`,
          color: DORA_TIER_BADGE_COLORS[lead.tier],
        }
      : { schemaVersion: 1, label: "DORA lead time", message: "no data", color: "lightgrey" },
  );

  writeBadge("badge-throughput.json", {
    schemaVersion: 1,
    label: "merged PRs (30d)",
    message: String(mergedPRs30d),
    color: "blue",
  });
}

interface Totals {
  openIssues: number;
  closedIssues: number;
  openPRs: number;
  mergedPRs: number;
  closedPRs: number;
  committers: number;
  reviewers: number;
}

function aggregate(repos: RepoMetrics[]): Totals {
  let openIssues = 0,
    closedIssues = 0,
    openPRs = 0,
    mergedPRs = 0,
    closedPRs = 0,
    committers = 0,
    reviewers = 0;
  for (const r of repos) {
    openIssues += Math.max(0, r.issues.open);
    closedIssues += Math.max(0, r.issues.closed);
    openPRs += r.pullRequests.open;
    mergedPRs += r.pullRequests.merged;
    closedPRs += r.pullRequests.closed;
    committers += r.committerCount;
    reviewers += r.reviewerCount;
  }
  return {
    openIssues,
    closedIssues,
    openPRs,
    mergedPRs,
    closedPRs,
    committers,
    reviewers,
  };
}

function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function computePercentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(Math.max(ratio, 0), 1);
  const index = (sorted.length - 1) * clamped;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

function formatDurationHtml(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}min`;
  if (hours < 24) return `${hours.toFixed(1)}hr`;
  const days = hours / 24;
  return `${days.toFixed(1)}days`;
}

/** Mirrors the client-side weekToDate() — returns the Monday of the given ISO week. */
function weekToDate(weekStr: string): Date {
  const [yearStr, weekNum] = weekStr.split('-W');
  const year = parseInt(yearStr, 10);
  const week = parseInt(weekNum, 10);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dow = jan4.getUTCDay() || 7;
  const mon = new Date(jan4);
  mon.setUTCDate(jan4.getUTCDate() - dow + 1 + (week - 1) * 7);
  return mon;
}

/* ------------------------------------------------------------------ */
/*  Dashboard HTML builder                                            */
/* ------------------------------------------------------------------ */

/** Dashboard HTML plus the already-computed analytics the badge files reuse. */
interface DashboardBuild {
  html: string;
  health: HealthReport;
  dora30: DoraMetrics;
  prsMerged30: number;
}

function buildDashboardHtml(
  data: OrgMetrics,
  date: string,
  branch?: string,
  runUrl?: string,
): DashboardBuild {
  const totals = aggregate(data.repos);

  // Compute data date range from merged PR details
  let oldestDataDate = '';
  let newestDataDate = '';
  for (const repo of data.repos) {
    for (const pr of repo.pullRequestDetails) {
      if (pr.mergedAt) {
        const d = pr.mergedAt.slice(0, 10);
        if (!oldestDataDate || d < oldestDataDate) oldestDataDate = d;
        if (!newestDataDate || d > newestDataDate) newestDataDate = d;
      }
    }
  }
  // Fall back to weekly trends if no PR details have dates
  if (!oldestDataDate && data.weeklyTrends && data.weeklyTrends.length > 0) {
    oldestDataDate = data.weeklyTrends[0].week;
    newestDataDate = data.weeklyTrends[data.weeklyTrends.length - 1].week;
  }
  const dataRangeHtml = oldestDataDate
    ? ` &middot; ${escapeHtml(oldestDataDate)} &rarr; ${escapeHtml(newestDataDate || data.collectedAt.slice(0, 10))}`
    : '';
  const ownerUrl = `https://github.com/${escapeHtml(data.owner)}`;

  let deployedFrom = "";
  if (branch) {
    deployedFrom = ` Deployed from branch <strong>${escapeHtml(branch)}</strong>`;
    if (runUrl) {
      deployedFrom += ` (<a href="${escapeHtml(runUrl)}">workflow run</a>)`;
    }
    deployedFrom += ".";
  }

  const topRepos = [...data.repos]
    .map((r) => ({
      name: r.name,
      issues: Math.max(0, r.issues.open) + Math.max(0, r.issues.closed),
      prs:
        r.pullRequests.open + r.pullRequests.merged + r.pullRequests.closed,
    }))
    .sort((a, b) => b.issues + b.prs - (a.issues + a.prs))
    .slice(0, 15);

  const repoRows = data.repos.map((repo) => buildRepoRow(repo)).join("\n");

  const intel = computeEngineeringIntelligence(data);

  // Build enriched PR details for charts — prefer the mergedPRTimeline
  // (wider history, 1 cheap API call) over the 10-entry pullRequestDetails.
  const allPRDetails = data.repos.flatMap((r) => {
    if (r.mergedPRTimeline && r.mergedPRTimeline.length > 0) {
      return r.mergedPRTimeline.map((p) => ({
        repo: r.name,
        mergedAt: p.mergedAt,
        createdAt: p.createdAt,
        author: p.author,
        isBotAuthor: p.isBotAuthor,
        isCopilotAuthored: p.isCopilotAuthored,
        aiAuthorType: p.aiAuthorType,
        timeToMergeHours: p.timeToMergeHours,
        linesAdded: p.linesAdded,
        linesDeleted: p.linesDeleted,
        isRevert: p.isRevert,
        timeToFirstReviewHours: p.timeToFirstReviewHours,
        reviewers: p.reviewers,
      }));
    }
    return r.pullRequestDetails
      .filter((pr) => !!pr.mergedAt)
      .map((pr) => ({
        repo: r.name,
        mergedAt: pr.mergedAt!,
        createdAt: pr.createdAt,
        author: pr.author,
        isBotAuthor: false,
        isCopilotAuthored: pr.isCopilotAuthored,
        aiAuthorType: pr.aiAuthorType,
        timeToMergeHours: pr.timeToMergeHours ?? 0,
        linesAdded: pr.linesAdded,
        linesDeleted: pr.linesDeleted,
        // Revert/review data only exists on the GraphQL timeline path.
        isRevert: undefined as boolean | undefined,
        timeToFirstReviewHours: undefined as number | undefined,
        reviewers: undefined as string[] | undefined,
      }));
  });

  // Aggregate Copilot adoption
  let copilotAuthored = 0, copilotReviewed = 0, copilotTotalMerged = 0, copilotTotalDetailed = 0;
  for (const r of data.repos) {
    if (r.copilotAdoption) {
      copilotAuthored += r.copilotAdoption.copilotAuthoredPRs;
      copilotReviewed += r.copilotAdoption.copilotReviewedPRs;
      copilotTotalMerged += r.copilotAdoption.totalMergedPRs;
      copilotTotalDetailed += r.copilotAdoption.totalDetailedPRs;
    }
  }

  // AI author breakdown by tool (computed from the full merged-PR timeline)
  const aiByType = { copilot: 0, claude: 0, codex: 0 };
  for (const p of allPRDetails) {
    if (p.aiAuthorType === "copilot") aiByType.copilot++;
    else if (p.aiAuthorType === "claude") aiByType.claude++;
    else if (p.aiAuthorType === "codex") aiByType.codex++;
  }

  // Aggregate Copilot agent metrics
  let agentTotalTasks = 0, agentCompleted = 0, agentFailed = 0, agentCancelled = 0,
    agentTimedOut = 0, agentActive = 0, agentTotalSessions = 0, agentCloudSessions = 0,
    agentCliSessions = 0, agentCredits = 0, agentPRs = 0, agentActionsMinutes = 0;
  const agentByRepo: Record<string, {
    totalTasks: number; completed: number; failed: number;
    cancelled: number; timedOut: number; active: number;
    sessions: number; credits: number; agentPRs: number; actionsMinutes: number;
  }> = {};
  for (const r of data.repos) {
    const a = r.copilotAgentMetrics;
    if (!a || a.totalTasks === 0) continue;
    agentTotalTasks += a.totalTasks;
    agentCompleted += a.completedTasks;
    agentFailed += a.failedTasks;
    agentCancelled += a.cancelledTasks;
    agentTimedOut += a.timedOutTasks;
    agentActive += a.activeTasksCount;
    agentTotalSessions += a.totalSessions;
    agentCloudSessions += a.cloudAgentSessions;
    agentCliSessions += a.cliRemoteSessions;
    agentCredits += a.totalCreditsUsed;
    agentPRs += a.agentCreatedPRs;
    agentActionsMinutes += a.agentActionsMinutes ?? 0;
    agentByRepo[r.name] = {
      totalTasks: a.totalTasks,
      completed: a.completedTasks,
      failed: a.failedTasks,
      cancelled: a.cancelledTasks,
      timedOut: a.timedOutTasks,
      active: a.activeTasksCount,
      sessions: a.totalSessions,
      credits: a.totalCreditsUsed,
      agentPRs: a.agentCreatedPRs,
      actionsMinutes: a.agentActionsMinutes ?? 0,
    };
  }
  const copilotUsage = data.copilotUsage;

  // Aggregate issue lead times
  const allIssueLeadTimes = data.repos.flatMap((r) =>
    (r.issueLeadTimes ?? []).map((lt) => ({
      issueNumber: lt.issueNumber,
      prNumber: lt.prNumber,
      leadTimeHours: lt.leadTimeHours,
      prMergedAt: lt.prMergedAt,
      repo: r.name,
    })),
  );

  // Median cycle time (all-time)
  const cycleTimes = allPRDetails.map((p) => p.timeToMergeHours).filter((h) => h > 0);
  const medianCycleHrs = computeMedian(cycleTimes);

  // Pre-compute 30-day initial values so the HTML is already correct for the
  // default "Last 30 Days" filter, preventing a visible flicker on page load.
  // This mirrors getCutoffDate("30days") + applyFilter logic in the client JS.
  const collected = new Date(data.collectedAt);
  const cutoff30d = new Date(collected);
  cutoff30d.setUTCDate(cutoff30d.getUTCDate() - 30);
  const trends30d = (data.weeklyTrends ?? []).filter(
    (t) => weekToDate(t.week) >= cutoff30d,
  );
  const issuesOpened30 = trends30d.reduce((s, t) => s + (t.issuesOpened ?? 0), 0);
  const issuesClosed30 = trends30d.reduce((s, t) => s + (t.issuesClosed ?? 0), 0);
  const prsOpened30 = trends30d.reduce((s, t) => s + (t.prsOpened ?? 0), 0);
  const filtered30d = allPRDetails.filter((p) => new Date(p.mergedAt) >= cutoff30d);
  const prsMerged30 = filtered30d.length;
  const medianCycle30d = computeMedian(
    filtered30d.map((p) => p.timeToMergeHours).filter((h) => h > 0),
  );
  const cycleP75_30d = computePercentile(
    filtered30d.map((p) => p.timeToMergeHours).filter((h) => h > 0),
    0.75,
  );
  const activeWeeks30d = trends30d.filter((t) => (t.prsOpened ?? 0) > 0 || (t.prsMerged ?? 0) > 0).length;
  const throughput30d = activeWeeks30d > 0 ? prsMerged30 / activeWeeks30d : 0;
  const prFlowRatio30d = prsOpened30 > 0 ? prsMerged30 / prsOpened30 : 0;
  const issueClosureRatio30d = issuesOpened30 > 0 ? issuesClosed30 / issuesOpened30 : 0;
  const cyclePredictability30d = medianCycle30d > 0 && cycleP75_30d > 0 ? cycleP75_30d / medianCycle30d : 0;
  const leadTimeDays30d = computeMedian(
    allIssueLeadTimes
      .filter((lead) => new Date(lead.prMergedAt) >= cutoff30d)
      .map((lead) => lead.leadTimeHours / 24)
      .filter((days) => days > 0),
  );
  const prSize30d = computeMedian(
    filtered30d
      .map((pr) => (pr.linesAdded ?? 0) + (pr.linesDeleted ?? 0))
      .filter((size) => size > 0),
  );

  const repoSummaries = data.repos.map((r) => ({
    name: r.name,
    issues: Math.max(0, r.issues.open) + Math.max(0, r.issues.closed),
    prs: r.pullRequests.open + r.pullRequests.merged + r.pullRequests.closed,
  }));

  // ── DORA & code-review initial values (default 30-day period) ──
  // Server-rendered so the tiles are already correct for the default filter;
  // the client recomputes the same numbers on every filter change.
  const dora30 = computeDoraMetrics(data, { windowDays: 30 });
  const review30 = computeReviewStats(data, { windowDays: 30 });

  // ── Health, collaboration & automated insights ──
  // Server-rendered from the full collection window. Insights deliberately use
  // the default 90-day DORA/review window (not the 30-day tile values above)
  // so findings reflect the broader analysis window.
  const health = computeHealthReport(data);
  const collaboration = computeCollaborationStats(data);

  // ── Phase 2 analytics: history deltas, forecast & team targets ──
  // Mirrors the compute calls in generateReport (src/report.ts). Targets are
  // evaluated against the default 90-day DORA/review window like insights.
  const doraFull = computeDoraMetrics(data);
  const reviewFull = computeReviewStats(data);
  const history = loadHistory(buildTargetKey(data.owner, data.ownerType, data.targetRepo));
  const deltas = computeHistoryDeltas(history);
  const forecast = computeDeliveryForecast(data);
  const targetsConfig = loadTargetsConfig();
  const targetEvals = targetsConfig
    ? evaluateTargets(targetsConfig, { dora: doraFull, review: reviewFull, health })
    : undefined;

  const insights = computeInsights(data, {
    intel,
    dora: doraFull,
    review: reviewFull,
    health,
    collaboration,
    targets: targetEvals,
  });
  // Restore-time sample counts for the MTTR tile sub-line (not exposed by
  // DoraMetrics): matched reverts and closed incidents in the 30-day window.
  const cutoff30Ms = cutoff30d.getTime();
  const collectedMs = collected.getTime();
  let restoreSamples30 = 0;
  let incidentSamples30 = 0;
  for (const r of data.repos) {
    for (const rv of r.reverts ?? []) {
      const t = Date.parse(rv.revertMergedAt);
      if (t >= cutoff30Ms && t <= collectedMs && (rv.restoreHours ?? 0) > 0) restoreSamples30++;
    }
    for (const inc of r.incidents ?? []) {
      // Same sample rule as dora.ts MTTR: closed in window, known resolution.
      if (inc.resolutionHours === undefined || !inc.closedAt) continue;
      const t = Date.parse(inc.closedAt);
      if (t >= cutoff30Ms && t <= collectedMs) incidentSamples30++;
    }
  }

  // Per-repo deployment/revert events for client-side DORA recompute.
  const repoDeployments = Object.fromEntries(
    data.repos
      .filter((r) => (r.deployments ?? []).length > 0)
      .map((r) => [r.name, r.deployments!.map((d) => d.createdAt)]),
  );
  const repoReverts = Object.fromEntries(
    data.repos
      .filter((r) => (r.reverts ?? []).length > 0)
      .map((r) => [
        r.name,
        r.reverts!.map((rv) => ({
          revertMergedAt: rv.revertMergedAt,
          restoreHours: rv.restoreHours,
        })),
      ]),
  );
  // Per-repo labeled incidents (only the fields the client mirror needs).
  // Any non-empty entry here flips the client's failure signal to incidents,
  // matching hasIncidentSignal() in dora.ts.
  const repoIncidents = Object.fromEntries(
    data.repos
      .filter((r) => (r.incidents ?? []).length > 0)
      .map((r) => [
        r.name,
        r.incidents!.map((inc) => ({
          createdAt: inc.createdAt,
          closedAt: inc.closedAt,
          resolutionHours: inc.resolutionHours,
        })),
      ]),
  );

  const chartPayload = serializeForInlineScript({
    owner: data.owner,
    issues: { open: totals.openIssues, closed: totals.closedIssues },
    prs: {
      open: totals.openPRs,
      merged: totals.mergedPRs,
      closed: totals.closedPRs,
    },
    topRepos,
    repoSummaries,
    repoNames: data.repos.map((r) => r.name).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })),
    weeklyTrends: (data.weeklyTrends ?? []).map((t) => ({
      ...t,
      linesAdded: t.linesAdded ?? 0,
      linesDeleted: t.linesDeleted ?? 0,
    })),
    repoWeeklyTrends: Object.fromEntries(
      data.repos
        .filter((r) => r.weeklyTrends && r.weeklyTrends.length > 0)
        .map((r) => [
          r.name,
          r.weeklyTrends!.map((t) => ({
            week: t.week,
            issuesOpened: t.issuesOpened ?? 0,
            issuesClosed: t.issuesClosed ?? 0,
            prsOpened: t.prsOpened ?? 0,
            prsMerged: t.prsMerged ?? 0,
            linesAdded: t.linesAdded ?? 0,
            linesDeleted: t.linesDeleted ?? 0,
          })),
        ])
    ),
    allPRDetails,
    allIssueLeadTimes,
    repoDeployments,
    repoReverts,
    repoIncidents,
    copilot: {
      authored: copilotAuthored,
      reviewed: copilotReviewed,
      totalMerged: copilotTotalMerged,
      totalDetailed: copilotTotalDetailed,
      byType: aiByType,
    },
    copilotAgent: {
      totalTasks: agentTotalTasks,
      completed: agentCompleted,
      failed: agentFailed,
      cancelled: agentCancelled,
      timedOut: agentTimedOut,
      active: agentActive,
      totalSessions: agentTotalSessions,
      cloudSessions: agentCloudSessions,
      cliSessions: agentCliSessions,
      totalCredits: Math.round(agentCredits * 100) / 100,
      agentPRs,
      totalActionsMinutes: Math.round(agentActionsMinutes * 100) / 100,
      byRepo: agentByRepo,
    },
    copilotUsage: copilotUsage
      ? {
          byFeature: copilotUsage.byFeature,
          byLanguage: copilotUsage.byLanguage,
          byModel: copilotUsage.byModel,
          dailyTotals: copilotUsage.dailyTotals,
        }
      : null,
    collectedAt: data.collectedAt,
  });

  // ── Numbered sections (rail nav + section headers) ──
  // Only sections with data are rendered; numbering follows the rendered order.
  const sectionDefs: { id: string; label: string }[] = [
    ...(insights.insights.length > 0 ? [{ id: "insights", label: "Insights" }] : []),
    { id: "overview", label: "Overview" },
    { id: "delivery", label: "Delivery" },
    ...(health.hasData ? [{ id: "health", label: "Health" }] : []),
    ...(intel.hasData ? [{ id: "team", label: "Team" }] : []),
    { id: "ai", label: "AI Impact" },
    { id: "trends", label: "Trends" },
    ...(copilotUsage ? [{ id: "copilot", label: "Copilot" }] : []),
    { id: "repos", label: "Repositories" },
  ];
  const secNum = (id: string): string =>
    String(sectionDefs.findIndex((s) => s.id === id) + 1).padStart(2, "0");
  const secTitle = (id: string): string => {
    const def = sectionDefs.find((s) => s.id === id);
    if (!def) return "";
    return `<h2 class="sec-title"><span class="sec-num">${secNum(id)}</span> ${escapeHtml(def.label)}</h2>`;
  };
  const railLinks = sectionDefs
    .map((s) => `<a href="#${s.id}"><span class="rail-num">${secNum(s.id)}</span>${escapeHtml(s.label)}</a>`)
    .join("\n    ");
  const railChips = sectionDefs
    .map((s) => `<a href="#${s.id}">${escapeHtml(s.label)}</a>`)
    .join("");

  const insightsSectionHtml = insights.insights.length > 0
    ? `<section class="sec" id="insights" aria-label="Insights">
    ${secTitle("insights")}
    ${buildInsightsSection(insights)}
  </section>`
    : "";

  const healthSectionHtml = health.hasData
    ? `<section class="sec" id="health" aria-label="Health">
    ${secTitle("health")}
    ${buildHealthSection(health)}
  </section>`
    : "";

  const teamSectionHtml = intel.hasData
    ? `<section class="sec" id="team" aria-label="Team">
    ${secTitle("team")}
    ${buildEngineeringIntelligenceSection(intel)}
    ${buildCodeReviewSection(review30)}
    ${buildCollaborationSection(collaboration)}
  </section>`
    : "";

  const copilotSectionHtml = copilotUsage
    ? `<section class="sec" id="copilot" aria-label="Copilot">
    ${secTitle("copilot")}
    ${buildCopilotUsageCharts(copilotUsage)}
    ${buildCopilotUsageSection(copilotUsage)}
  </section>`
    : "";

  const attributionHtml = process.env.ATTRIBUTION_LINK
    ? ` &middot; <a href="${escapeHtml(process.env.ATTRIBUTION_LINK)}" target="_blank" rel="noopener noreferrer">${escapeHtml(process.env.ATTRIBUTION_TEXT || 'View source')}</a>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DevEx Metrics &ndash; ${escapeHtml(data.owner)}</title>
  <script>(function(){try{var t=localStorage.getItem("devex-theme");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();</script>
  <script defer src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation@3.0.1/dist/chartjs-plugin-annotation.min.js"></script>
  <style>${getCSS()}</style>
</head>
<body>

<header class="site-header">
  <div class="site-header-inner">
    <div class="brand">
      <span class="wordmark">DEVEX&middot;METRICS</span>
      <a class="brand-owner" href="${ownerUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(data.owner)}</a>
    </div>
    <div class="header-controls" role="toolbar" aria-label="Dashboard filters">
      <div class="filter-btns" role="group" aria-label="Time period filter">
        <button class="filter-btn" data-period="all">All Time</button>
        <button class="filter-btn" data-period="year">This Year</button>
        <button class="filter-btn" data-period="90days">Last 90 Days</button>
        <button class="filter-btn active" data-period="30days">Last 30 Days</button>
      </div>
      <label class="filter-toggle" title="Exclude PRs authored by bots (dependabot, renovate, etc.) from charts and KPIs">
        <input type="checkbox" id="excludeBots" /> Exclude bots
      </label>
      <div class="repo-picker" id="repoPicker">
        <button class="repo-picker-btn" id="repoPickerBtn" aria-haspopup="true" aria-expanded="false" title="Filter charts by repository">
          <span id="repoPickerLabel">All repos</span> <span class="repo-picker-caret" aria-hidden="true">&#9660;</span>
        </button>
        <div class="repo-picker-panel" id="repoPickerPanel" hidden>
          <div class="repo-picker-toolbar">
            <button class="repo-picker-action" id="repoPickerReset">Reset</button>
            <button class="repo-picker-action" id="repoPickerClear">Clear</button>
            <input type="search" class="repo-picker-search" id="repoPickerSearch" placeholder="Search repos&hellip;" autocomplete="off" />
          </div>
          <div class="repo-picker-list" id="repoPickerList"></div>
        </div>
      </div>
      <button class="theme-toggle" id="themeToggle" type="button" aria-label="Toggle color theme">&#9680;</button>
    </div>
  </div>
</header>

<nav class="rail-chips" aria-label="Sections">${railChips}</nav>

<div class="shell">
  <nav class="rail" aria-label="Sections">
    ${railLinks}
  </nav>
  <div class="content">

<header class="masthead" id="masthead">
  <div class="masthead-kicker">DEVEX&middot;METRICS</div>
  <h1 class="masthead-owner"><a href="${ownerUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(data.owner)}</a></h1>
  <p class="masthead-meta">${escapeHtml(data.ownerType)} &middot; collected ${escapeHtml(data.collectedAt)}${dataRangeHtml}</p>
</header>

<main>
  ${insightsSectionHtml}

  <section class="sec" id="overview" aria-label="Overview">
    ${secTitle("overview")}
    ${buildDeltaCaption(deltas)}
    <div class="kpis" aria-label="Key metrics">
      <div class="kpi">
        <div class="kpi-lbl">Repositories</div>
        <div class="kpi-val">${data.repoCount}</div>
      </div>
      <div class="kpi">
        <div class="kpi-lbl" id="kpiIssueLbl">Issues Opened</div>
        <div class="kpi-val" id="kpiIssueVal">${issuesOpened30}</div>
        <div class="kpi-sub" id="kpiIssueSub">${issuesClosed30} closed</div>
      </div>
      <div class="kpi">
        <div class="kpi-lbl" id="kpiPRLbl">Merged PRs</div>
        <div class="kpi-val" id="kpiPRVal">${prsMerged30}</div>
        <div class="kpi-sub" id="kpiPRSub">${prsOpened30} opened</div>
        <div class="kpi-spark"><canvas id="kpiPRSpark" aria-hidden="true"></canvas></div>
      </div>
      <div class="kpi">
        <div class="kpi-lbl">Committers</div>
        <div class="kpi-val">${totals.committers}</div>
        <div class="kpi-sub">${totals.reviewers} reviewers (90&nbsp;d)</div>
      </div>
      <div class="kpi">
        <div class="kpi-lbl" id="kpiCopilotLbl">AI PRs</div>
        <div class="kpi-val" id="kpiCopilotVal">${copilotTotalMerged > 0 ? ((copilotAuthored / copilotTotalMerged) * 100).toFixed(1) + '%' : '–'}</div>
        <div class="kpi-sub" id="kpiCopilotSub">${copilotAuthored} AI-authored &middot; ${copilotReviewed} reviewed</div>
      </div>
      <div class="kpi">
        <div class="kpi-lbl">Agent Tasks (30d)</div>
        <div class="kpi-val" id="kpiAgentVal">${agentTotalTasks > 0 ? agentTotalTasks : '–'}</div>
        <div class="kpi-sub" id="kpiAgentSub">${agentTotalTasks > 0 ? `${agentCompleted} completed &middot; ${agentPRs} PRs` : 'no agent data'}</div>
      </div>
      ${buildCopilotUsageKpi(copilotUsage)}
      <div class="kpi">
        <div class="kpi-lbl" id="kpiCycleLbl">Median Cycle Time</div>
        <div class="kpi-val" id="kpiCycleVal">${medianCycle30d > 0 ? formatDurationHtml(medianCycle30d) : '–'}</div>
        <div class="kpi-sub" id="kpiCycleSub">PR created &rarr; merged</div>
      </div>
    </div>
    ${buildDeltaStrip(deltas)}
    <div class="charts" aria-label="Overview charts">
      <div class="card card-chart"><h2>Issues</h2><canvas id="chartIssues"></canvas></div>
      <div class="card card-chart"><h2>Pull Requests</h2><canvas id="chartPRs"></canvas></div>
      <div class="card card-chart card-wide"><h2 id="chartReposTitle">Top Repositories</h2><canvas id="chartRepos"></canvas></div>
    </div>
  </section>

  <section class="sec" id="delivery" aria-label="Delivery">
    ${secTitle("delivery")}
    ${buildDoraTiles(dora30, restoreSamples30, incidentSamples30)}
    ${buildForecastBlock(forecast)}
    ${buildTargetsBlock(targetEvals)}
    <div class="block-head" aria-label="Developer insights">
      <h3>Developer Insights</h3>
      <p>Velocity and delivery health for the selected period and repository scope.</p>
    </div>
    <div class="insights-grid">
      <article class="insight-card">
        <h3>Developer Velocity</h3>
        <div class="insight-val" id="insightVelocityVal">${throughput30d > 0 ? throughput30d.toFixed(1) : '–'}</div>
        <div class="insight-sub">merged PRs per active week</div>
      </article>
      <article class="insight-card">
        <h3>PR Flow Ratio</h3>
        <div class="insight-val" id="insightPrFlowVal">${prFlowRatio30d > 0 ? `${(prFlowRatio30d * 100).toFixed(1)}%` : '–'}</div>
        <div class="insight-sub" id="insightPrFlowSub">merged vs opened PRs</div>
      </article>
      <article class="insight-card">
        <h3>Issue Closure Ratio</h3>
        <div class="insight-val" id="insightIssueFlowVal">${issueClosureRatio30d > 0 ? `${(issueClosureRatio30d * 100).toFixed(1)}%` : '–'}</div>
        <div class="insight-sub" id="insightIssueFlowSub">closed vs opened issues</div>
      </article>
      <article class="insight-card">
        <h3>Cycle Predictability</h3>
        <div class="insight-val" id="insightCyclePredictabilityVal">${cyclePredictability30d > 0 ? `${cyclePredictability30d.toFixed(2)}x` : '–'}</div>
        <div class="insight-sub">p75 / p50 merge time</div>
      </article>
      <article class="insight-card">
        <h3>Issue Lead Time</h3>
        <div class="insight-val" id="insightLeadTimeVal">${leadTimeDays30d > 0 ? `${leadTimeDays30d.toFixed(1)}d` : '–'}</div>
        <div class="insight-sub">median issue created &rarr; PR merged</div>
      </article>
      <article class="insight-card">
        <h3>Median PR Size</h3>
        <div class="insight-val" id="insightPrSizeVal">${prSize30d > 0 ? Math.round(prSize30d).toLocaleString("en-US") : '–'}</div>
        <div class="insight-sub">lines changed per merged PR</div>
      </article>
    </div>
    <div class="charts" aria-label="Delivery metric charts">
      <div class="card card-chart card-wide"><h2>PR Cycle Time (weekly median, hours)</h2><canvas id="chartCycleTime"></canvas></div>
      <div class="card card-chart card-wide"><h2>Issue &rarr; PR Lead Time</h2><canvas id="chartLeadTime"></canvas></div>
    </div>
  </section>

  ${healthSectionHtml}

  ${teamSectionHtml}

  <section class="sec" id="ai" aria-label="AI Impact">
    ${secTitle("ai")}
    <div class="charts" aria-label="AI impact charts">
      <div class="card card-chart"><h2>AI Adoption</h2><canvas id="chartCopilotAdoption"></canvas></div>
      <div class="card card-chart"><h2>AI Author Breakdown</h2><canvas id="chartAIAuthorBreakdown"></canvas></div>
      <div class="card card-chart card-wide"><h2>Actor Breakdown (PRs merged per week)</h2><canvas id="chartActorBreakdown"></canvas></div>
      <div class="card card-chart card-wide"><h2>Copilot-authored PRs merged per week</h2><canvas id="chartCopilotPRTrend"></canvas></div>
      <div class="card card-chart card-wide"><h2>Agent Tasks by Repository (30&nbsp;d)</h2><canvas id="chartAgentTasks"></canvas></div>
    </div>
  </section>

  <section class="sec" id="trends" aria-label="Trends">
    ${secTitle("trends")}
    <div class="charts" aria-label="Trend charts">
      <div class="card card-chart card-wide"><h2>PR Trends (per week)</h2><canvas id="chartPRTrends"></canvas></div>
      <div class="card card-chart card-wide"><h2>Issue Trends (per week)</h2><canvas id="chartIssueTrends"></canvas></div>
      <div class="card card-chart card-wide"><h2>PR Size Trends (lines/week)</h2><canvas id="chartPRSizeTrends"></canvas></div>
    </div>
  </section>

  ${copilotSectionHtml}

  <section class="sec" id="repos" aria-label="Repositories">
    ${secTitle("repos")}
    <div class="repos-toolbar">
      <input type="search" id="repoFilter" placeholder="Filter&hellip;" aria-label="Filter repositories" />
      <select id="repoSort" aria-label="Sort repositories">
        <option value="name">Name</option>
        <option value="openIssues">Open Issues</option>
        <option value="mergedPrs">Merged PRs</option>
        <option value="openPrs">Open PRs</option>
        <option value="contributors">Contributors</option>
        <option value="dependents">Dependents</option>
        <option value="pushed">Last Updated</option>
        <option value="linesAdded">Lines Added</option>
        <option value="agentTasks">Agent Tasks</option>
      </select>
    </div>
    <p class="repos-period-note" id="reposPeriodNote">The <strong>merged PR</strong> count reflects the selected period. Expand a row for all-time details.</p>
    <div class="table-wrap">
      <table class="repo-table" aria-label="Repositories">
        <thead><tr>
          <th class="col-repo th-sortable" data-sort="name">Repository <span class="sort-ind" aria-hidden="true"></span></th>
          <th class="col-num th-sortable" data-sort="openIssues">Issues <span class="sort-ind" aria-hidden="true"></span></th>
          <th class="col-num th-sortable" data-sort="mergedPrs">Merged PRs <span class="sort-ind" aria-hidden="true"></span></th>
          <th class="col-num th-sortable" data-sort="openPrs">Open PRs <span class="sort-ind" aria-hidden="true"></span></th>
          <th class="col-num th-sortable" data-sort="contributors">Contributors <span class="sort-ind" aria-hidden="true"></span></th>
          <th class="col-num th-sortable" data-sort="dependents">Dependents <span class="sort-ind" aria-hidden="true"></span></th>
          <th class="col-date th-sortable" data-sort="pushed">Last Updated <span class="sort-ind" aria-hidden="true"></span></th>
          <th class="col-lines th-sortable" data-sort="linesAdded" title="Total lines added/removed across merged PRs in the last ~13 months (or last 10 detailed PRs when full timeline data is unavailable)">Lines +/- <span class="sort-ind" aria-hidden="true"></span></th>
          <th class="col-num th-sortable" data-sort="agentTasks" title="Copilot agent tasks in the 30-day collection window">Agent Tasks <span class="sort-ind" aria-hidden="true"></span></th>
        </tr></thead>
        <tbody id="repoList">${repoRows}</tbody>
      </table>
    </div>
    <p class="repo-count"><span id="shown">${data.repos.length}</span> of ${data.repos.length} repositories</p>
  </section>
</main>

<footer>Data cached on ${escapeHtml(date)}.${deployedFrom} Served via GitHub Pages. <a href="data.json">Raw JSON</a> &middot; <a href="report.md">Markdown</a>${attributionHtml}</footer>

  </div>
</div>

<button class="back-to-top" id="backToTop" type="button" aria-label="Back to top" hidden>&uarr;</button>

<script>
var CHART_DATA=${chartPayload};
${getJS()}
</script>
</body>
</html>`;

  return { html, health, dora30, prsMerged30 };
}

/* ------------------------------------------------------------------ */
/*  Engineering Intelligence section                                  */
/* ------------------------------------------------------------------ */

/** Format a benchmark value that may be 0 → em dash, else numeric via fmt. */
function benchCell(value: number, fmt: (n: number) => string): string {
  return value > 0 ? fmt(value) : "&ndash;";
}

/**
 * Build the "Engineering Intelligence" section: benchmark cards, a
 * Median / Top 10% / Top 1% team-benchmarks table, a sortable per-developer
 * leaderboard, and an AI-vs-human impact comparison. Rendered only when the
 * intelligence pass found data.
 */
function buildEngineeringIntelligenceSection(intel: EngineeringIntelligence): string {
  if (!intel.hasData) return "";

  const fmtInt = (n: number): string => Math.round(n).toLocaleString("en-US");
  const ai = intel.aiImpact;

  // ── Benchmark cards (reuse the Developer Insights card pattern) ──
  const cards = `
      <article class="insight-card">
        <h3>Contributors</h3>
        <div class="insight-val">${intel.contributorCount.toLocaleString("en-US")}</div>
        <div class="insight-sub">developers with merged PRs</div>
      </article>
      <article class="insight-card">
        <h3>Total Merged PRs</h3>
        <div class="insight-val">${intel.totalMergedPRs.toLocaleString("en-US")}</div>
        <div class="insight-sub">human-authored in window</div>
      </article>
      <article class="insight-card">
        <h3>AI Share of Merged PRs</h3>
        <div class="insight-val">${ai.aiMergedPRs > 0 ? `${(ai.aiShare * 100).toFixed(1)}%` : "&ndash;"}</div>
        <div class="insight-sub">${ai.aiMergedPRs.toLocaleString("en-US")} AI-authored</div>
      </article>
      <article class="insight-card">
        <h3>Top 10% Throughput</h3>
        <div class="insight-val">${benchCell(intel.throughputBenchmark.p90, fmtInt)}</div>
        <div class="insight-sub">merged PRs (p90 developer)</div>
      </article>`;

  // ── Team benchmarks table (Median / Top 10% / Top 1%) ──
  const fmtUnits = (n: number): string => n.toFixed(1);
  const tp = intel.throughputBenchmark;
  const ct = intel.cycleTimeBenchmark;
  const ps = intel.prSizeBenchmark;
  const wu = intel.workUnitsBenchmark;
  const benchmarksTable = `
    <div class="table-wrap intel-table-wrap">
      <table class="repo-table" aria-label="Team benchmarks">
        <thead><tr>
          <th>Metric</th>
          <th class="col-num">Median (p50)</th>
          <th class="col-num">Top 10% (p90)</th>
          <th class="col-num">Top 1% (p99)</th>
        </tr></thead>
        <tbody>
          <tr>
            <td>Merged PRs per developer</td>
            <td class="col-num">${benchCell(tp.p50, fmtInt)}</td>
            <td class="col-num">${benchCell(tp.p90, fmtInt)}</td>
            <td class="col-num">${benchCell(tp.p99, fmtInt)}</td>
          </tr>
          <tr>
            <td>Work units per developer <span class="intel-note">(~32-line PR &asymp; 1 unit)</span></td>
            <td class="col-num">${benchCell(wu.p50, fmtUnits)}</td>
            <td class="col-num">${benchCell(wu.p90, fmtUnits)}</td>
            <td class="col-num">${benchCell(wu.p99, fmtUnits)}</td>
          </tr>
          <tr>
            <td>Median cycle time <span class="intel-note">(lower is better)</span></td>
            <td class="col-num">${benchCell(ct.p50, formatDurationHtml)}</td>
            <td class="col-num">${benchCell(ct.p90, formatDurationHtml)}</td>
            <td class="col-num">${benchCell(ct.p99, formatDurationHtml)}</td>
          </tr>
          <tr>
            <td>Median PR size <span class="intel-note">(lines changed)</span></td>
            <td class="col-num">${benchCell(ps.p50, fmtInt)}</td>
            <td class="col-num">${benchCell(ps.p90, fmtInt)}</td>
            <td class="col-num">${benchCell(ps.p99, fmtInt)}</td>
          </tr>
        </tbody>
      </table>
    </div>`;

  // ── Developer leaderboard (sortable by clicking headers) ──
  const leaderboardRows = intel.developers
    .map((d) => {
      const login = escapeHtml(d.login);
      return `<tr class="intel-row"
      data-login="${escapeHtml(d.login.toLowerCase())}"
      data-merged="${d.mergedPRs}"
      data-units="${d.workUnits.toFixed(1)}"
      data-lines="${d.linesChanged}"
      data-size="${Math.round(d.medianPRSizeLines)}"
      data-cycle="${d.medianCycleHours}"
      data-repos="${d.reposContributed}">
      <td>${login}</td>
      <td class="col-num">${d.mergedPRs.toLocaleString("en-US")}</td>
      <td class="col-num">${d.workUnits.toFixed(1)}</td>
      <td class="col-num">${d.linesChanged.toLocaleString("en-US")}</td>
      <td class="col-num">${d.medianPRSizeLines > 0 ? fmtInt(d.medianPRSizeLines) : "&ndash;"}</td>
      <td class="col-num">${d.medianCycleHours > 0 ? formatDurationHtml(d.medianCycleHours) : "&ndash;"}</td>
      <td class="col-num">${d.reposContributed.toLocaleString("en-US")}</td>
    </tr>`;
    })
    .join("\n");

  const leaderboard = intel.developers.length > 0
    ? `
    <h3 class="intel-subhead">Developer Leaderboard</h3>
    <div class="table-wrap intel-table-wrap">
      <table class="repo-table intel-leaderboard" aria-label="Developer leaderboard">
        <thead><tr>
          <th class="intel-th-sortable" data-intel-sort="login">Developer <span class="sort-ind" aria-hidden="true"></span></th>
          <th class="col-num intel-th-sortable" data-intel-sort="merged">Merged PRs <span class="sort-ind" aria-hidden="true"></span></th>
          <th class="col-num intel-th-sortable" data-intel-sort="units" title="Calibrated output: each merged PR contributes clamp(log2(1 + lines/32), 0.25, 4) units, so a ~32-line PR is about 1 unit">Work Units <span class="sort-ind" aria-hidden="true"></span></th>
          <th class="col-num intel-th-sortable" data-intel-sort="lines">Lines Changed <span class="sort-ind" aria-hidden="true"></span></th>
          <th class="col-num intel-th-sortable" data-intel-sort="size">Median PR Size <span class="sort-ind" aria-hidden="true"></span></th>
          <th class="col-num intel-th-sortable" data-intel-sort="cycle">Median Cycle <span class="sort-ind" aria-hidden="true"></span></th>
          <th class="col-num intel-th-sortable" data-intel-sort="repos">Repos <span class="sort-ind" aria-hidden="true"></span></th>
        </tr></thead>
        <tbody id="intelLeaderboardRows">${leaderboardRows}</tbody>
      </table>
    </div>`
    : "";

  // ── AI vs human impact ──
  let aiSection = "";
  if (ai.aiMergedPRs > 0) {
    const compare = `
    <div class="table-wrap intel-table-wrap">
      <table class="repo-table" aria-label="AI vs human impact">
        <thead><tr>
          <th>Metric</th>
          <th class="col-num">AI-authored</th>
          <th class="col-num">Human-authored</th>
        </tr></thead>
        <tbody>
          <tr>
            <td>Merged PRs</td>
            <td class="col-num">${ai.aiMergedPRs.toLocaleString("en-US")}</td>
            <td class="col-num">${ai.humanMergedPRs.toLocaleString("en-US")}</td>
          </tr>
          <tr>
            <td>Median cycle time</td>
            <td class="col-num">${benchCell(ai.aiMedianCycleHours, formatDurationHtml)}</td>
            <td class="col-num">${benchCell(ai.humanMedianCycleHours, formatDurationHtml)}</td>
          </tr>
          <tr>
            <td>Median PR size</td>
            <td class="col-num">${benchCell(ai.aiMedianPRSize, fmtInt)}</td>
            <td class="col-num">${benchCell(ai.humanMedianPRSize, fmtInt)}</td>
          </tr>
        </tbody>
      </table>
    </div>`;

    const toolRows = ai.byTool
      .map((t) => {
        const name = t.tool ? t.tool[0].toUpperCase() + t.tool.slice(1) : t.tool;
        return `<tr>
      <td>${escapeHtml(name)}</td>
      <td class="col-num">${t.mergedPRs.toLocaleString("en-US")}</td>
      <td class="col-num">${benchCell(t.medianCycleHours, formatDurationHtml)}</td>
      <td class="col-num">${benchCell(t.medianPRSize, fmtInt)}</td>
    </tr>`;
      })
      .join("\n");

    const toolTable = ai.byTool.length > 0
      ? `
    <div class="table-wrap intel-table-wrap">
      <table class="repo-table" aria-label="AI impact by tool">
        <thead><tr>
          <th>Tool</th>
          <th class="col-num">Merged PRs</th>
          <th class="col-num">Median Cycle</th>
          <th class="col-num">Median PR Size</th>
        </tr></thead>
        <tbody>${toolRows}</tbody>
      </table>
    </div>`
      : "";

    aiSection = `
    <h3 class="intel-subhead">AI vs Human Impact</h3>
    ${compare}${toolTable}`;
  }

  return `<div class="intel-section" aria-label="Engineering intelligence">
    <div class="block-head">
      <h3>Engineering Intelligence</h3>
      <p>Per-developer output with percentile benchmarking and AI-vs-human contribution.</p>
    </div>
    <div class="insights-grid">${cards}
    </div>
    <h3 class="intel-subhead">Team Benchmarks</h3>
    ${benchmarksTable}${leaderboard}${aiSection}
  </div>`;
}

/* ------------------------------------------------------------------ */
/*  DORA tiles & Code Review block                                    */
/* ------------------------------------------------------------------ */

/**
 * Tier badge pill for a DORA stat tile. Text + color carry the tier together
 * (never color alone); hidden via the `hidden` attribute when unclassified.
 */
function doraTierBadge(id: string, tier: DoraTier | undefined): string {
  const cls = tier ? ` tier-${tier}` : "";
  const label = tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : "";
  return `<span class="dora-tier${cls}" id="${id}"${tier ? "" : " hidden"}>${label}</span>`;
}

/**
 * DORA stat-tile row for the Delivery section, server-rendered with the
 * default 30-day values. The client-side `updateDora()` keeps the tiles in
 * sync with the period/repo/bot filters.
 */
function buildDoraTiles(
  dora: DoraMetrics,
  restoreSamples: number,
  incidentSamples: number,
): string {
  const df = dora.deployFrequencyPerWeek;
  const lt = dora.leadTimeHours;
  const cfr = dora.changeFailureRate;
  const mttr = dora.mttrHours;
  // Failure-signal caption: labeled incidents where the org has any
  // (failureSignal "incidents"), the revert-PR proxy otherwise. The span id
  // lets the client updateDora() rewrite it on filter changes.
  const usesIncidents = dora.failureSignal === "incidents";
  const signalNote = usesIncidents
    ? `failure = labeled incident (${dora.totalIncidents ?? 0} in window)`
    : "failure = reverted merge";
  const cfrSub = usesIncidents
    ? `${dora.totalIncidents ?? 0} incidents / ${dora.totalMergedPRs} merged`
    : `${dora.totalReverts} reverts / ${dora.totalMergedPRs} merged`;
  const mttrSub = usesIncidents
    ? incidentSamples > 0
      ? `median of ${incidentSamples} incidents`
      : "no closed incidents"
    : restoreSamples > 0
      ? `median of ${restoreSamples} reverts`
      : "no matched reverts";
  return `<div class="block-head" aria-label="DORA metrics">
      <h3>DORA</h3>
      <p>deploy frequency from deployments/releases &middot; <span id="doraSignalNote">${signalNote}</span> &middot; scoped to the selected period</p>
    </div>
    <div class="kpis" aria-label="DORA metrics">
      <div class="kpi">
        <div class="kpi-lbl kpi-lbl-row">Deploy Frequency ${doraTierBadge("doraDeployTier", df.tier)}</div>
        <div class="kpi-val" id="doraDeployVal">${df.hasData ? `${df.value.toFixed(1)}/wk` : "&ndash;"}</div>
        <div class="kpi-sub" id="doraDeploySub">${dora.totalDeploys} deploys</div>
      </div>
      <div class="kpi">
        <div class="kpi-lbl kpi-lbl-row">Lead Time for Changes ${doraTierBadge("doraLeadTier", lt.tier)}</div>
        <div class="kpi-val" id="doraLeadVal">${lt.hasData ? formatDurationHtml(lt.value) : "&ndash;"}</div>
        <div class="kpi-sub" id="doraLeadSub">median PR created &rarr; merged</div>
      </div>
      <div class="kpi">
        <div class="kpi-lbl kpi-lbl-row">Change Failure Rate ${doraTierBadge("doraCfrTier", cfr.tier)}</div>
        <div class="kpi-val" id="doraCfrVal">${cfr.hasData ? `${(cfr.value * 100).toFixed(1)}%` : "&ndash;"}</div>
        <div class="kpi-sub" id="doraCfrSub">${cfrSub}</div>
      </div>
      <div class="kpi">
        <div class="kpi-lbl kpi-lbl-row">Time to Restore ${doraTierBadge("doraMttrTier", mttr.tier)}</div>
        <div class="kpi-val" id="doraMttrVal">${mttr.hasData ? formatDurationHtml(mttr.value) : "&ndash;"}</div>
        <div class="kpi-sub" id="doraMttrSub">${mttrSub}</div>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/*  Week-over-week deltas, Delivery Forecast & Team Targets           */
/* ------------------------------------------------------------------ */

/** Delta metric ids whose values are ratios, rendered as percentage points. */
const RATIO_DELTA_IDS = new Set(["reviewCoverage30d", "aiShare"]);

/** Format the absolute value of a delta metric (for tooltips: "was → now"). */
function formatDeltaLevel(d: MetricDelta, value: number): string {
  if (RATIO_DELTA_IDS.has(d.id)) return `${(value * 100).toFixed(1)}%`;
  if (d.id === "medianCycleHours30d") return `${(Math.round(value * 10) / 10).toLocaleString("en-US")}h`;
  return (Math.round(value * 10) / 10).toLocaleString("en-US");
}

/** Format the magnitude of a delta: ratios as points ("3.5pp"), hours as "4.2h". */
function formatDeltaMagnitude(d: MetricDelta): string {
  const magnitude = Math.abs(d.delta);
  if (RATIO_DELTA_IDS.has(d.id)) return `${(magnitude * 100).toFixed(1)}pp`;
  if (d.id === "medianCycleHours30d") return `${(Math.round(magnitude * 10) / 10).toLocaleString("en-US")}h`;
  return (Math.round(magnitude * 10) / 10).toLocaleString("en-US");
}

/**
 * Muted caption under the Overview title naming the baseline snapshot the
 * delta chips below the KPI tiles are compared against. Empty without history.
 */
function buildDeltaCaption(deltas: HistoryDeltas): string {
  if (!deltas.hasData || deltas.deltas.length === 0) return "";
  return `<p class="sec-sub">Changes vs the ${escapeHtml(deltas.baselineDate ?? "")} snapshot (${deltas.daysSpanned}d ago)</p>`;
}

/**
 * "What changed" chip strip rendered directly under the Overview KPI tiles.
 * One chip per history delta: label + arrow + signed move, colored by whether
 * the move is in the metric's good direction (muted when unchanged). Chips
 * are used instead of per-tile annotations because the tiles are re-rendered
 * client-side on every filter change while deltas are fixed snapshots.
 */
function buildDeltaStrip(deltas: HistoryDeltas): string {
  if (!deltas.hasData || deltas.deltas.length === 0) return "";
  const chips = deltas.deltas
    .map((d) => {
      const cls =
        d.delta === 0
          ? "delta-flat"
          : (d.delta > 0) === (d.goodDirection === "up")
            ? "delta-good"
            : "delta-bad";
      const move =
        d.delta === 0
          ? "&plusmn;0"
          : `${d.delta > 0 ? "&#9650; +" : "&#9660; &minus;"}${formatDeltaMagnitude(d)}`;
      const title = `${formatDeltaLevel(d, d.previous)} on ${deltas.baselineDate} &rarr; ${formatDeltaLevel(d, d.current)} now`;
      return `<span class="delta-chip ${cls}" title="${title}">${escapeHtml(d.label)} <span class="delta-move">${move}</span></span>`;
    })
    .join("\n      ");
  return `<div class="delta-strip" aria-label="Changes vs the previous snapshot">
      ${chips}
    </div>`;
}

/**
 * Delivery Forecast sub-block for the Delivery section: Monte-Carlo
 * completion dates at 50/85/95% confidence per PR-count target. Static
 * server-rendered from the full weekly-trend history (not filter-scoped).
 */
function buildForecastBlock(forecast: DeliveryForecast): string {
  if (!forecast.hasData || forecast.targets.length === 0) return "";
  const median = (Math.round(forecast.medianWeeklyThroughput * 10) / 10).toLocaleString("en-US");
  const rows = forecast.targets
    .map(
      (t) =>
        `<tr><td>${t.prCount} PRs</td>` +
        `<td class="col-num">${t.p50Date} (${t.p50Weeks}w)</td>` +
        `<td class="col-num">${t.p85Date} (${t.p85Weeks}w)</td>` +
        `<td class="col-num">${t.p95Date} (${t.p95Weeks}w)</td></tr>`,
    )
    .join("\n");
  return `<div class="block-head" aria-label="Delivery forecast">
      <h3>Delivery Forecast</h3>
      <p>Monte-Carlo over the last ${forecast.sampleWeeks} completed weeks &middot; median ${median} merged PRs/week</p>
    </div>
    <div class="table-wrap intel-table-wrap forecast-table-wrap">
      <table class="repo-table" aria-label="Delivery forecast">
        <thead><tr>
          <th>Deliver next&hellip;</th>
          <th class="col-num">50% confidence</th>
          <th class="col-num">85% confidence</th>
          <th class="col-num">95% confidence</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/** Met / missed / no-data status pill for one target evaluation. */
function targetStatusPill(target: TargetEvaluation): string {
  if (!target.hasData) return '<span class="insight-chip chip-nodata">No data</span>';
  return target.met
    ? '<span class="insight-chip chip-positive">Met</span>'
    : '<span class="insight-chip chip-critical">Missed</span>';
}

/**
 * Team Targets sub-block for the Delivery section: one row per configured
 * threshold from devex.config.json with a met/missed/no-data status pill
 * (reusing the Insights severity-chip styling) and the evidence sentence.
 */
function buildTargetsBlock(targets: TargetEvaluation[] | undefined): string {
  if (!targets || targets.length === 0) return "";
  const rows = targets
    .map(
      (t) =>
        `<tr><td>${escapeHtml(t.label)}</td>` +
        `<td>${targetStatusPill(t)}</td>` +
        `<td class="target-detail">${escapeHtml(t.detail)}</td></tr>`,
    )
    .join("\n");
  return `<div class="block-head" aria-label="Team targets">
      <h3>Team Targets</h3>
      <p>Thresholds from devex.config.json</p>
    </div>
    <div class="table-wrap intel-table-wrap targets-table-wrap">
      <table class="repo-table" aria-label="Team targets">
        <thead><tr>
          <th>Target</th>
          <th>Status</th>
          <th>Detail</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/**
 * Code Review block for the Team section: coverage/latency stat tiles plus a
 * reviewer-load table, server-rendered with the default 30-day values. The
 * client-side `updateReviewStats()` re-renders on every filter change.
 */
function buildCodeReviewSection(review: ReviewStats): string {
  const totalReviews = review.reviewers.reduce((s, r) => s + r.prsReviewed, 0);
  const rows = review.reviewers
    .slice(0, 15)
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.login)}</td>` +
        `<td class="col-num">${r.prsReviewed.toLocaleString("en-US")}</td>` +
        `<td class="col-num">${totalReviews > 0 ? `${(r.loadShare * 100).toFixed(1)}%` : "&ndash;"}</td></tr>`,
    )
    .join("\n");
  const emptyRow = `<tr><td colspan="3" class="col-muted">No reviewer data in the selected period.</td></tr>`;
  const moreCount = Math.max(0, review.reviewers.length - 15);
  return `<div class="block-head" aria-label="Code review">
      <h3>Code Review</h3>
      <p>coverage and reviewer load across merged PRs (bot authors excluded) &middot; scoped to the selected period</p>
    </div>
    <div class="kpis" aria-label="Code review metrics">
      <div class="kpi">
        <div class="kpi-lbl">Review Coverage</div>
        <div class="kpi-val" id="reviewCoverageVal">${review.totalPRs > 0 ? `${(review.reviewCoverage * 100).toFixed(1)}%` : "&ndash;"}</div>
        <div class="kpi-sub" id="reviewCoverageSub">${review.reviewedPRs} of ${review.totalPRs} PRs reviewed</div>
      </div>
      <div class="kpi">
        <div class="kpi-lbl">Time to First Review</div>
        <div class="kpi-val" id="reviewMedianVal">${review.medianTimeToFirstReviewHours > 0 ? formatDurationHtml(review.medianTimeToFirstReviewHours) : "&ndash;"}</div>
        <div class="kpi-sub" id="reviewMedianSub">median, PR created &rarr; first review</div>
      </div>
      <div class="kpi">
        <div class="kpi-lbl">p90 Time to First Review</div>
        <div class="kpi-val" id="reviewP90Val">${review.p90TimeToFirstReviewHours > 0 ? formatDurationHtml(review.p90TimeToFirstReviewHours) : "&ndash;"}</div>
        <div class="kpi-sub" id="reviewP90Sub">slowest decile of first reviews</div>
      </div>
    </div>
    <div class="table-wrap intel-table-wrap review-table-wrap">
      <table class="repo-table" aria-label="Reviewer load">
        <thead><tr>
          <th>Reviewer</th>
          <th class="col-num">PRs Reviewed</th>
          <th class="col-num">Load Share</th>
        </tr></thead>
        <tbody id="reviewerLoadRows">${rows || emptyRow}</tbody>
      </table>
    </div>
    <p class="repo-count" id="reviewerLoadMore"${moreCount > 0 ? "" : " hidden"}>&hellip;and ${moreCount} more</p>`;
}

/* ------------------------------------------------------------------ */
/*  Insights, Health & Collaboration sections                         */
/* ------------------------------------------------------------------ */

/** Display label per insight severity (uppercased to a chip via CSS). */
const INSIGHT_SEVERITY_LABEL: Record<InsightSeverity, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
  positive: "Positive",
};

/**
 * Insights section body: an executive-summary list of automated findings,
 * severity-ordered (critical first). Static server-rendered HTML over the
 * full collection window — deliberately not wired to the period/repo filters.
 */
function buildInsightsSection(insights: InsightsSummary): string {
  const cards = insights.insights
    .map((insight) => {
      const repoTag = insight.repo
        ? ` <span class="insight-item-repo">${escapeHtml(insight.repo)}</span>`
        : "";
      const reco = insight.recommendation
        ? `\n      <p class="insight-item-reco">Recommendation: ${escapeHtml(insight.recommendation)}</p>`
        : "";
      return `<article class="insight-item sev-${insight.severity}">
      <div class="insight-item-head">
        <span class="insight-chip chip-${insight.severity}">${INSIGHT_SEVERITY_LABEL[insight.severity]}</span>
        <h3>${escapeHtml(insight.title)}</h3>${repoTag}
      </div>
      <p class="insight-item-detail">${escapeHtml(insight.detail)}</p>${reco}
    </article>`;
    })
    .join("\n    ");
  return `<p class="sec-sub">Automated findings from the full collection window</p>
    <div class="insight-list" aria-label="Automated findings">${cards}</div>`;
}

/**
 * Health section body: summary stat tiles plus a sortable table
 * of per-repo composite scores, grades, and the six component scores.
 * Sorting is handled client-side by `setupHealthControls()`.
 */
function buildHealthSection(health: HealthReport): string {
  const attentionCount = health.repos.filter((repo) => repo.needsAttention).length;
  const tiles = `<div class="kpis" aria-label="Repository health summary">
      <div class="kpi">
        <div class="kpi-lbl">Average Health Score</div>
        <div class="kpi-val">${health.avgScore}</div>
        <div class="kpi-sub">grade ${healthGrade(health.avgScore)} across ${health.repos.length} scored ${health.repos.length === 1 ? "repo" : "repos"}</div>
      </div>
      <div class="kpi">
        <div class="kpi-lbl">Repos Needing Attention</div>
        <div class="kpi-val">${attentionCount > 0 ? attentionCount : "&ndash;"}</div>
        <div class="kpi-sub">${attentionCount > 0 ? "score below 55 with recent activity" : "no active repo scores below 55"}</div>
      </div>
    </div>`;

  // Component columns follow the fixed scorer order shared by every repo.
  const componentDefs = health.repos[0]?.components ?? [];
  const componentHeaders = componentDefs
    .map(
      (component, i) =>
        `<th class="col-num health-th-sortable" data-health-sort="c${i}">${escapeHtml(component.label)} <span class="sort-ind" aria-hidden="true"></span></th>`,
    )
    .join("\n          ");

  const rows = health.repos
    .map((repo) => {
      const componentData = repo.components
        .map((component, i) => ` data-c${i}="${component.score ?? ""}"`)
        .join("");
      const componentCells = repo.components
        .map((component) =>
          component.score !== undefined
            ? `<td class="col-num" title="${escapeHtml(component.detail)}">${component.score}</td>`
            : `<td class="col-num col-muted" title="${escapeHtml(component.detail)}">&ndash;</td>`,
        )
        .join("");
      return `<tr class="health-row${repo.needsAttention ? " health-attn" : ""}"
      data-name="${escapeHtml(repo.fullName.toLowerCase())}"
      data-score="${repo.score}"
      data-grade="${repo.grade}"${componentData}>
      <td>${escapeHtml(repo.fullName)}</td>
      <td class="col-num health-score">${repo.score}</td>
      <td class="health-grade">${repo.grade}</td>
      ${componentCells}
    </tr>`;
    })
    .join("\n");

  return `${tiles}
    <div class="block-head" aria-label="Repository health scores">
      <h3>Repository Health Scores</h3>
      <p>weighted composite of activity, review, cycle time, failure, redundancy, and backlog</p>
    </div>
    <div class="table-wrap health-table-wrap">
      <table class="repo-table health-table" aria-label="Repository health scores">
        <thead><tr>
          <th class="health-th-sortable" data-health-sort="name">Repository <span class="sort-ind" aria-hidden="true"></span></th>
          <th class="col-num health-th-sortable" data-health-sort="score">Score <span class="sort-ind" aria-hidden="true"></span></th>
          <th class="health-th-sortable" data-health-sort="grade">Grade <span class="sort-ind" aria-hidden="true"></span></th>
          ${componentHeaders}
        </tr></thead>
        <tbody id="healthRows">${rows}</tbody>
      </table>
    </div>
    <p class="intel-caption">Component cells show 0&ndash;100 scores; &ndash; means the underlying signal is unavailable. Hover a cell for its evidence.</p>`;
}

/**
 * Collaboration block for the Team section: network stat tiles, per-repo
 * ownership concentration (bus factors), and the strongest author-reviewer
 * relationships when review data exists. Full collection window, static.
 */
function buildCollaborationSection(collaboration: CollaborationStats): string {
  if (!collaboration.hasData) return "";

  const tiles = `<div class="kpis" aria-label="Collaboration metrics">
      <div class="kpi">
        <div class="kpi-lbl">Distinct Authors</div>
        <div class="kpi-val">${collaboration.distinctAuthors.toLocaleString("en-US")}</div>
        <div class="kpi-sub">humans with merged PRs</div>
      </div>
      <div class="kpi">
        <div class="kpi-lbl">Distinct Reviewers</div>
        <div class="kpi-val">${collaboration.distinctReviewers > 0 ? collaboration.distinctReviewers.toLocaleString("en-US") : "&ndash;"}</div>
        <div class="kpi-sub">humans reviewing merged PRs</div>
      </div>
      <div class="kpi">
        <div class="kpi-lbl">Review-Load Gini</div>
        <div class="kpi-val">${collaboration.distinctReviewers >= 2 ? collaboration.reviewerGini.toFixed(2) : "&ndash;"}</div>
        <div class="kpi-sub">0 = even load &middot; 1 = one reviewer</div>
      </div>
      <div class="kpi">
        <div class="kpi-lbl">Siloed Contributors</div>
        <div class="kpi-val">${collaboration.siloedContributors.length > 0 ? collaboration.siloedContributors.length : "&ndash;"}</div>
        <div class="kpi-sub">3+ merges, all in a single repo</div>
      </div>
    </div>`;

  const busRows = collaboration.busFactors
    .slice(0, 8)
    .map(
      (repo) =>
        `<tr><td>${escapeHtml(repo.fullName)}</td>` +
        `<td class="col-num">${repo.busFactor}</td>` +
        `<td class="col-num">${(repo.topAuthorShare * 100).toFixed(1)}%</td>` +
        `<td class="col-num">${repo.mergedPRs.toLocaleString("en-US")}</td></tr>`,
    )
    .join("\n");
  const busTable = collaboration.busFactors.length > 0
    ? `
    <h3 class="intel-subhead">Ownership Concentration</h3>
    <div class="table-wrap intel-table-wrap collab-table-wrap">
      <table class="repo-table" aria-label="Ownership concentration">
        <thead><tr>
          <th>Repository</th>
          <th class="col-num">Bus Factor</th>
          <th class="col-num">Top Author Share</th>
          <th class="col-num">Merged PRs</th>
        </tr></thead>
        <tbody>${busRows}</tbody>
      </table>
    </div>
    <p class="intel-caption">Bus factor = smallest set of authors covering at least 50% of a repo&rsquo;s merged PRs. Lower is riskier. Repos with 5+ human-authored merges, riskiest first.</p>`
    : "";

  const edgeRows = collaboration.edges
    .slice(0, 8)
    .map(
      (edge) =>
        `<tr><td>${escapeHtml(edge.author)}</td>` +
        `<td>${escapeHtml(edge.reviewer)}</td>` +
        `<td class="col-num">${edge.prCount.toLocaleString("en-US")}</td></tr>`,
    )
    .join("\n");
  const edgesTable = collaboration.edges.length > 0
    ? `
    <h3 class="intel-subhead">Strongest Review Relationships</h3>
    <div class="table-wrap intel-table-wrap collab-table-wrap">
      <table class="repo-table" aria-label="Strongest review relationships">
        <thead><tr>
          <th>Author</th>
          <th>Reviewer</th>
          <th class="col-num">PRs</th>
        </tr></thead>
        <tbody>${edgeRows}</tbody>
      </table>
    </div>`
    : "";

  return `<div class="collab-section" aria-label="Collaboration network">
    <div class="block-head">
      <h3>Collaboration</h3>
      <p>author&ndash;reviewer network across human-authored merged PRs &middot; full collection window</p>
    </div>
    ${tiles}${busTable}${edgesTable}
  </div>`;
}

/* ------------------------------------------------------------------ */
/*  Repo row builder (table layout)                                  */
/* ------------------------------------------------------------------ */

function buildRepoRow(repo: RepoMetrics): string {
  const sortedPRDetails = [...repo.pullRequestDetails].sort((a, b) => {
    if (!a.mergedAt && !b.mergedAt) return 0;
    if (!a.mergedAt) return 1;
    if (!b.mergedAt) return -1;
    return b.mergedAt.localeCompare(a.mergedAt);
  });

  const prRows = sortedPRDetails
    .map(
      (pr) =>
        `<tr><td>#${pr.number} ${escapeHtml(pr.title)}</td>` +
        `<td>${pr.mergedAt ? pr.mergedAt.slice(0, 10) : ""}</td>` +
        `<td class="td-lines"><span class="add">+${pr.linesAdded}</span><span class="del">-${pr.linesDeleted}</span></td>` +
        `<td>${pr.commentCount}</td><td>${pr.commitCount}</td><td>${pr.actionsMinutes}</td></tr>`,
    )
    .join("");

  const prTable =
    sortedPRDetails.length > 0
      ? `<div class="pr-wrap"><h4>Recent Pull Requests</h4>
      <table class="pr-tbl"><thead><tr><th>PR</th><th>Merged</th><th>Lines</th><th>Comments</th><th>Commits</th><th>CI&nbsp;min</th></tr></thead>
      <tbody>${prRows}</tbody></table></div>`
      : "";

  const totalContrib = repo.contributorCount;
  // Prefer the full merged-PR timeline (covers ~13 months) over the
  // 10-PR detailed sample so the per-repo Lines +/- column reflects all
  // recent activity. Fall back to the detailed sample when the timeline
  // lacks line counts (REST fallback path doesn't fetch them).
  const timelineLineEntries =
    repo.mergedPRTimeline?.filter(
      (pr) => pr.linesAdded !== undefined || pr.linesDeleted !== undefined,
    ) ?? [];
  const useTimeline = timelineLineEntries.length > 0;
  const linesAdded = useTimeline
    ? timelineLineEntries.reduce((s, pr) => s + (pr.linesAdded ?? 0), 0)
    : repo.pullRequestDetails.reduce((s, pr) => s + pr.linesAdded, 0);
  const linesDeleted = useTimeline
    ? timelineLineEntries.reduce((s, pr) => s + (pr.linesDeleted ?? 0), 0)
    : repo.pullRequestDetails.reduce((s, pr) => s + pr.linesDeleted, 0);
  const pushedDate = repo.pushedAt ? repo.pushedAt.slice(0, 10) : "";
  const repoUrl = `https://github.com/${escapeHtml(repo.fullName)}`;
  const repoId = repo.fullName
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-");

  const agentTaskCount = repo.copilotAgentMetrics?.totalTasks ?? 0;
  const dataRow =
    `<tr class="repo-row" ` +
    `data-name="${escapeHtml(repo.fullName.toLowerCase())}" ` +
    `data-repo-name="${escapeHtml(repo.name.toLowerCase())}" ` +
    `data-open-issues="${repo.issues.open}" ` +
    `data-merged-prs="${repo.pullRequests.merged}" ` +
    `data-merged-prs-all="${repo.pullRequests.merged}" ` +
    `data-open-prs="${repo.pullRequests.open}" ` +
    `data-contributors="${totalContrib}" ` +
    `data-dependents="${repo.dependentCount}" ` +
    `data-pushed="${escapeHtml(repo.pushedAt ?? "")}" ` +
    `data-lines-added="${linesAdded}" ` +
    `data-lines-deleted="${linesDeleted}" ` +
    `data-agent-tasks="${agentTaskCount}" ` +
    `data-repo-id="${repoId}">` +
    `<td><div class="repo-name-cell">` +
    `<button class="repo-expand-btn" onclick="toggleRepo(this)" aria-expanded="false" aria-label="Toggle details for ${escapeHtml(repo.fullName)}"><span class="chev" aria-hidden="true">&rsaquo;</span></button>` +
    `<a class="rname" href="${repoUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(repo.fullName)}</a>` +
    `<span class="bdg bdg-age"></span>` +
    `</div></td>` +
    `<td>${repo.issues.open}<span class="col-muted"> / ${repo.issues.closed}</span></td>` +
    `<td class="td-merged-prs">${repo.pullRequests.merged}</td>` +
    `<td>${repo.pullRequests.open}</td>` +
    `<td title="${repo.committerCount} committers, ${repo.reviewerCount} reviewers">${totalContrib}</td>` +
    `<td>${repo.dependentCount}</td>` +
    `<td>${pushedDate}</td>` +
    `<td class="td-lines"><span class="add">+${linesAdded}</span><span class="del">-${linesDeleted}</span></td>` +
    `<td>${agentTaskCount > 0 ? agentTaskCount : '<span class="col-muted">&ndash;</span>'}</td>` +
    `</tr>`;

  const detailRow =
    `<tr class="repo-detail-row" id="detail-${repoId}" hidden>` +
    `<td colspan="9" class="repo-detail-cell">` +
    `<div class="stats-grid">` +
    `<div class="sg"><h4>Issues</h4><dl><div class="dr"><dt>Open</dt><dd>${repo.issues.open}</dd></div><div class="dr"><dt>Closed</dt><dd>${repo.issues.closed}</dd></div></dl></div>` +
    `<div class="sg"><h4>Pull Requests</h4><dl><div class="dr"><dt>Open</dt><dd>${repo.pullRequests.open}</dd></div><div class="dr"><dt>Merged</dt><dd>${repo.pullRequests.merged}</dd></div><div class="dr"><dt>Closed</dt><dd>${repo.pullRequests.closed}</dd></div></dl></div>` +
    `<div class="sg"><h4>People (90 d)</h4><dl><div class="dr"><dt>Committers</dt><dd>${repo.committerCount}</dd></div><div class="dr"><dt>Reviewers</dt><dd>${repo.reviewerCount}</dd></div></dl></div>` +
    `<div class="sg"><h4>Dependents</h4><dl><div class="dr"><dt>Repos</dt><dd>${repo.dependentCount}</dd></div></dl></div>` +
    (repo.copilotAgentMetrics && repo.copilotAgentMetrics.totalTasks > 0
      ? `<div class="sg"><h4>Agent Tasks (30 d)</h4><dl>` +
        `<div class="dr"><dt>Total</dt><dd>${repo.copilotAgentMetrics.totalTasks}</dd></div>` +
        `<div class="dr"><dt>Completed</dt><dd>${repo.copilotAgentMetrics.completedTasks}</dd></div>` +
        (repo.copilotAgentMetrics.failedTasks > 0 ? `<div class="dr"><dt>Failed</dt><dd>${repo.copilotAgentMetrics.failedTasks}</dd></div>` : "") +
        (repo.copilotAgentMetrics.cancelledTasks > 0 ? `<div class="dr"><dt>Cancelled</dt><dd>${repo.copilotAgentMetrics.cancelledTasks}</dd></div>` : "") +
        (repo.copilotAgentMetrics.timedOutTasks > 0 ? `<div class="dr"><dt>Timed out</dt><dd>${repo.copilotAgentMetrics.timedOutTasks}</dd></div>` : "") +
        (repo.copilotAgentMetrics.activeTasksCount > 0 ? `<div class="dr"><dt>Active</dt><dd>${repo.copilotAgentMetrics.activeTasksCount}</dd></div>` : "") +
        `<div class="dr"><dt>Sessions</dt><dd>${repo.copilotAgentMetrics.totalSessions}</dd></div>` +
        (repo.copilotAgentMetrics.totalCreditsUsed > 0 ? `<div class="dr"><dt>Credits</dt><dd>${repo.copilotAgentMetrics.totalCreditsUsed.toFixed(1)}</dd></div>` : "") +
        (repo.copilotAgentMetrics.avgCompletedSessionHours != null ? `<div class="dr"><dt>Avg&nbsp;duration</dt><dd>${formatDurationHtml(repo.copilotAgentMetrics.avgCompletedSessionHours)}</dd></div>` : "") +
        (repo.copilotAgentMetrics.agentCreatedPRs > 0 ? `<div class="dr"><dt>PRs created</dt><dd>${repo.copilotAgentMetrics.agentCreatedPRs}</dd></div>` : "") +
        ((repo.copilotAgentMetrics.agentActionsMinutes ?? 0) > 0 ? `<div class="dr"><dt>Actions&nbsp;min</dt><dd>${(repo.copilotAgentMetrics.agentActionsMinutes ?? 0).toFixed(1)}</dd></div>` : "") +
        `</dl></div>`
      : "") +
    `</div>` +
    prTable +
    `</td>` +
    `</tr>`;

  return dataRow + "\n" + detailRow;
}

function buildCopilotUsageKpi(usage: CopilotUsageMetrics | undefined): string {
  if (!usage) return "";
  const active = `${usage.totals.activeUsers}/${usage.totals.totalUsers}`;
  const seats = usage.totals.assignedSeats > 0
    ? `${usage.totals.assignedSeats} seats`
    : "usage report";
  return `<div class="kpi">
      <div class="kpi-lbl">Copilot Users</div>
      <div class="kpi-val">${escapeHtml(active)}</div>
      <div class="kpi-sub">${usage.totals.acceptanceRate.toFixed(1)}% acceptance &middot; ${escapeHtml(seats)}</div>
    </div>`;
}

function buildCopilotUsageCharts(usage: CopilotUsageMetrics | undefined): string {
  if (!usage) return "";
  const featureChart = usage.byFeature.length > 0
    ? `<div class="card card-chart card-wide"><h2>Copilot Usage by Feature</h2><canvas id="chartCopilotUsageFeature"></canvas></div>`
    : "";
  const languageChart = usage.byLanguage.length > 0
    ? `<div class="card card-chart"><h2>Copilot Language Mix</h2><canvas id="chartCopilotUsageLanguage"></canvas></div>`
    : "";
  const modelChart = usage.byModel.length > 0
    ? `<div class="card card-chart"><h2>Copilot Model Mix</h2><canvas id="chartCopilotUsageModel"></canvas></div>`
    : "";
  const dailyChart = usage.dailyTotals.length > 0
    ? `<div class="card card-chart card-wide"><h2>Copilot Daily Active Users</h2><canvas id="chartCopilotUsageDaily"></canvas></div>`
    : "";
  const cliChart = usage.dailyTotals.some((day) => day.cli.requestCount > 0)
    ? `<div class="card card-chart"><h2>Copilot CLI Requests</h2><canvas id="chartCopilotUsageCli"></canvas></div>`
    : "";
  const reviewChart = usage.dailyTotals.some((day) => day.codeReview.dailyActiveUsers > 0 || day.codeReview.dailyPassiveUsers > 0)
    ? `<div class="card card-chart"><h2>Copilot Code Review Users</h2><canvas id="chartCopilotCodeReview"></canvas></div>`
    : "";
  const prChart = usage.dailyTotals.some((day) => day.pullRequests.totalCreated > 0 || day.pullRequests.totalReviewed > 0 || day.pullRequests.totalMerged > 0)
    ? `<div class="card card-chart card-wide"><h2>Copilot PR Activity from Usage API</h2><canvas id="chartCopilotPrActivity"></canvas></div>`
    : "";
  if (!featureChart && !languageChart && !modelChart && !dailyChart && !cliChart && !reviewChart && !prChart) return "";
  return `<div class="charts" aria-label="Copilot usage charts">${featureChart}${languageChart}${modelChart}${dailyChart}${cliChart}${reviewChart}${prChart}</div>`;
}

function buildCopilotAdoptionImpact(usage: CopilotUsageMetrics): string {
  const impact = computeCopilotAdoptionImpact(usage);
  if (!impact) return "";

  const segments = impact.phases.map((phase) => {
    const share = impact.totalUsers > 0 ? phase.totalEngagedUsers / impact.totalUsers : 0;
    const label = copilotAdoptionPhaseLabel(phase);
    return `<span class="impact-segment impact-phase-${Math.min(Math.max(phase.phaseNumber, 0), 3)}"
      style="width:${(share * 100).toFixed(2)}%"
      title="${escapeHtml(label)}: ${phase.totalEngagedUsers} users (${(share * 100).toFixed(1)}%)"></span>`;
  }).join("");
  const distributionLabel = impact.phases.map((phase) => {
    const share = impact.totalUsers > 0 ? phase.totalEngagedUsers / impact.totalUsers : 0;
    return `${copilotAdoptionPhaseLabel(phase)} ${phase.totalEngagedUsers} users, ${(share * 100).toFixed(1)} percent`;
  }).join("; ");
  const rows = impact.phases.map((phase) => {
    const share = impact.totalUsers > 0 ? phase.totalEngagedUsers / impact.totalUsers : 0;
    return `<tr>
      <td><span class="impact-key impact-phase-${Math.min(Math.max(phase.phaseNumber, 0), 3)}"></span>${escapeHtml(copilotAdoptionPhaseLabel(phase))}</td>
      <td>${phase.totalEngagedUsers}</td>
      <td>${(share * 100).toFixed(1)}%</td>
      <td>${phase.avgPullRequestsMerged.toFixed(2)}</td>
      <td>${phase.totalPullRequestsMerged > 0 ? formatDurationHtml(phase.avgPullRequestsMedianMinutesToMerge / 60) : `<span class="col-muted">Unavailable</span>`}</td>
    </tr>`;
  }).join("");
  const association = impact.mergedPullRequestAssociation !== undefined
    ? `<div><strong>${impact.mergedPullRequestAssociation.toFixed(2)}&times;</strong><span>merged-PR association</span><small>Phase 1+ vs passive</small></div>`
    : `<div><strong>Unavailable</strong><span>merged-PR association</span><small>insufficient cohort baseline</small></div>`;

  return `<section class="impact-section" aria-labelledby="copilotImpactTitle">
    <div class="impact-heading">
      <div><p class="section-kicker">Impact snapshot &middot; ${escapeHtml(impact.day)}</p><h3 id="copilotImpactTitle">Adoption depth and delivery association</h3></div>
      <p>Trailing 28-day snapshot. Association only, not a causal productivity estimate.</p>
    </div>
    <div class="impact-layout">
      <div class="impact-overview">
        <div class="impact-stats">
          <div><strong>${(impact.engagedShare * 100).toFixed(1)}%</strong><span>Phase 1+ share</span><small>${impact.engagedUsers} of ${impact.totalUsers} licensed cohort users</small></div>
          ${association}
        </div>
        <div class="impact-bar" role="img" aria-label="${escapeHtml(`Copilot adoption phase distribution: ${distributionLabel}`)}">${segments}</div>
      </div>
      <div class="table-wrap impact-table-wrap"><table class="impact-table" aria-label="Copilot adoption phase impact">
        <thead><tr><th>Phase</th><th>Users</th><th>Share</th><th>Merged PRs / user (28 d)</th><th>Avg user median merge time</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>
    <p class="impact-note">Passive users is GitHub&rsquo;s <em>No Cohort</em> phase for licensed users who did not meet the two-active-day threshold. Phases are recalculated daily.</p>
  </section>`;
}

function buildCopilotRepositoryUsage(usage: CopilotUsageMetrics): string {
  const report = usage.repositoryReport;
  if (!report) {
    return usage.repositoryReportStatus === "unavailable"
      ? `<section class="repo-usage-section" aria-labelledby="copilotRepoUsageTitle">
        <div class="impact-heading"><div><p class="section-kicker">Latest complete day</p><h3 id="copilotRepoUsageTitle">Repository PR activity</h3></div></div>
        <p class="usage-unavailable">Repository-level Copilot PR activity was unavailable for this collection run.</p>
      </section>`
      : "";
  }
  const repositories = sortCopilotRepositoryUsage(report.repositories);
  const rows = repositories.map((repository) => {
    const pullRequests = repository.pullRequests;
    const badges = [
      pullRequests.totalCreatedByCopilot > 0 ? `<span class="activity-badge">Cloud agent activity</span>` : "",
      pullRequests.totalReviewedByCopilot > 0 ? `<span class="activity-badge activity-badge-review">Code review activity</span>` : "",
    ].join("");
    return `<tr>
      <td><strong>${escapeHtml(repository.fullName)}</strong><span class="repo-visibility">${escapeHtml(repository.visibility.toLowerCase())}</span>${badges ? `<span class="activity-badges">${badges}</span>` : ""}</td>
      <td>${pullRequests.totalCreated} / ${pullRequests.totalReviewed} / ${pullRequests.totalMerged}</td>
      <td>${pullRequests.totalCreatedByCopilot} / ${pullRequests.totalReviewedByCopilot}</td>
      <td>${pullRequests.totalMergedCreatedByCopilot} authored / ${pullRequests.totalMergedReviewedByCopilot} reviewed</td>
      <td>${pullRequests.totalCopilotAppliedSuggestions} / ${pullRequests.totalCopilotSuggestions}</td>
      <td>${pullRequests.medianMinutesToMerge === null ? `<span class="col-muted">Unavailable</span>` : formatDurationHtml(pullRequests.medianMinutesToMerge / 60)}</td>
    </tr>`;
  }).join("");

  return `<section class="repo-usage-section" aria-labelledby="copilotRepoUsageTitle">
    <div class="impact-heading">
      <div><p class="section-kicker">Latest complete day &middot; ${escapeHtml(report.reportDay)}</p><h3 id="copilotRepoUsageTitle">Repository PR activity</h3></div>
      <p>${repositories.length} ${repositories.length === 1 ? "repository" : "repositories"} with PR activity reported. Missing repositories are not zero-usage rows.</p>
    </div>
    <div class="table-wrap repo-usage-table-wrap"><table class="repo-table repo-usage-table" aria-label="Latest repository Copilot pull request activity">
      <thead><tr><th>Repository</th><th>Created / reviewed / merged</th><th>Copilot-created / reviewed</th><th>Copilot-associated merges</th><th>Suggestions applied / generated</th><th>Median merge time</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6">No repository rows were returned for this available report.</td></tr>`}</tbody>
    </table></div>
  </section>`;
}

function buildCopilotUsageSection(usage: CopilotUsageMetrics | undefined): string {
  if (!usage) return "";
  const range = usage.reportStartDay && usage.reportEndDay
    ? `${escapeHtml(usage.reportStartDay)} &rarr; ${escapeHtml(usage.reportEndDay)}`
    : "latest report window";
  const rows = usage.users.map((user) => {
    const surfaceValues = [
      user.usedChat ? "chat" : undefined,
      user.usedAgent ? "agent" : undefined,
      user.usedCli ? "cli" : undefined,
      user.usedCodeReviewActive || user.usedCodeReviewPassive ? "review" : undefined,
    ].filter((value): value is string => value !== undefined);
    const surfaces = surfaceValues.map((value) => value === "cli" ? "CLI" : value[0].toUpperCase() + value.slice(1)).join(", ") || "-";
    const lastSeen = user.lastActivityAt?.slice(0, 10) ?? user.lastUsageDay ?? "-";
    const phase = user.aiAdoptionPhase
      ? (user.aiAdoptionPhase.phaseNumber === 0 ? "Passive users" : user.aiAdoptionPhase.phase)
      : "-";
    const searchText = `${user.login} ${phase} ${surfaces} ${user.lastActivityEditor ?? ""}`.toLowerCase();
    return `<tr class="usage-row"
      data-login="${escapeHtml(user.login.toLowerCase())}"
      data-search="${escapeHtml(searchText)}"
      data-surface="${escapeHtml(surfaceValues.join(" "))}"
      data-active-days="${user.activeDays}"
      data-interactions="${user.userInitiatedInteractions}"
      data-generations="${user.codeGenerations}"
      data-acceptance="${user.acceptanceRate}"
      data-loc-added="${user.locAdded}"
      data-last-activity="${escapeHtml(lastSeen === "-" ? "" : lastSeen)}">
      <td>${escapeHtml(user.login)}</td>
      <td>${escapeHtml(phase)}</td>
      <td>${user.activeDays}</td>
      <td>${formatWholeNumber(user.userInitiatedInteractions)}</td>
      <td>${formatWholeNumber(user.codeGenerations)} / ${formatWholeNumber(user.codeAcceptances)}</td>
      <td>${user.acceptanceRate.toFixed(1)}%</td>
      <td class="td-lines"><span class="add">+${formatWholeNumber(user.locAdded)}</span><span class="del">-${formatWholeNumber(user.locDeleted)}</span></td>
      <td>${surfaces}</td>
      <td>${escapeHtml(lastSeen)}</td>
      <td>${escapeHtml(user.lastActivityEditor ?? "-")}</td>
    </tr>`;
  }).join("\n");

  const featurePills = usage.byFeature.slice(0, 5).map((feature) =>
    `<span class="usage-pill">${escapeHtml(feature.name)} <strong>${formatWholeNumber(feature.userInitiatedInteractions)}</strong></span>`,
  ).join("");
  const pullRequests = usage.pullRequests;
  const cli = usage.cli;
  const codeReview = usage.codeReview;
  const billing = usage.billing;
  const hasPullRequestActivity = pullRequests.totalCreated > 0 || pullRequests.totalReviewed > 0 || pullRequests.totalSuggestions > 0;
  const hasCliActivity = cli.requestCount > 0 || cli.sessionCount > 0;
  const hasCodeReviewActivity = codeReview.monthlyActiveUsers > 0 || codeReview.monthlyPassiveUsers > 0;
  const hasBilling = billing !== undefined;
  const adoptionImpact = buildCopilotAdoptionImpact(usage);
  const repositoryUsage = buildCopilotRepositoryUsage(usage);

  return `<div class="usage-section" aria-label="Copilot usage">
    <div class="usage-header">
      <div>
        <h3>Copilot Usage</h3>
        <p class="usage-meta">${escapeHtml(usage.scopeName)} ${usage.scope} report &middot; fixed 28-day window ${range} &middot; collected ${escapeHtml(usage.collectedAt.slice(0, 16).replace("T", " "))} UTC &middot; unaffected by global filters</p>
      </div>
      <div class="usage-pill-row">${featurePills}</div>
    </div>
    ${adoptionImpact}
    ${repositoryUsage}
    <div class="usage-summary-grid">
      <div><span>${usage.totals.activeUsers}</span><small>active users</small></div>
      <div><span>${usage.totals.assignedSeats || usage.totals.totalUsers}</span><small>${usage.totals.assignedSeats ? "assigned seats" : "reported users"}</small></div>
      <div><span>${usage.totals.acceptanceRate.toFixed(1)}%</span><small>acceptance</small></div>
      <div><span>${formatWholeNumber(usage.totals.userInitiatedInteractions)}</span><small>interactions</small></div>
      <div><span>+${formatWholeNumber(usage.totals.locAdded)}</span><small>LOC added</small></div>
      ${hasCliActivity ? `<div><span>${formatWholeNumber(cli.requestCount)}</span><small>CLI requests</small></div>` : ""}
      ${hasPullRequestActivity ? `<div><span>${formatWholeNumber(pullRequests.totalReviewedByCopilot)}</span><small>PRs reviewed by Copilot</small></div>` : ""}
      ${hasCodeReviewActivity ? `<div><span>${formatWholeNumber(codeReview.monthlyActiveUsers)}</span><small>active review users</small></div>` : ""}
    </div>
    <div class="usage-insights-grid">
      ${hasPullRequestActivity ? `<div class="usage-panel"><h3>Pull Requests</h3><dl>
        <div class="dr"><dt>Created / reviewed / merged</dt><dd>${pullRequests.totalCreated} / ${pullRequests.totalReviewed} / ${pullRequests.totalMerged}</dd></div>
        <div class="dr"><dt>Created by Copilot</dt><dd>${pullRequests.totalCreatedByCopilot}</dd></div>
        <div class="dr"><dt>Reviewed by Copilot</dt><dd>${pullRequests.totalReviewedByCopilot}</dd></div>
        <div class="dr"><dt>Copilot suggestions applied</dt><dd>${pullRequests.totalCopilotAppliedSuggestions} / ${pullRequests.totalCopilotSuggestions}</dd></div>
        ${pullRequests.medianMinutesToMerge !== null && pullRequests.medianMinutesToMerge > 0 ? `<div class="dr"><dt>Median of daily merge medians</dt><dd>${formatDurationHtml(pullRequests.medianMinutesToMerge / 60)}</dd></div>` : ""}
      </dl></div>` : ""}
      ${hasCliActivity ? `<div class="usage-panel"><h3>CLI</h3><dl>
        <div class="dr"><dt>Sessions</dt><dd>${formatWholeNumber(cli.sessionCount)}</dd></div>
        <div class="dr"><dt>Requests</dt><dd>${formatWholeNumber(cli.requestCount)}</dd></div>
        <div class="dr"><dt>Prompts</dt><dd>${formatWholeNumber(cli.promptCount)}</dd></div>
        <div class="dr"><dt>Prompt / output tokens</dt><dd>${formatWholeNumber(cli.promptTokens)} / ${formatWholeNumber(cli.outputTokens)}</dd></div>
        ${cli.lastKnownCliVersion ? `<div class="dr"><dt>Latest version</dt><dd>${escapeHtml(cli.lastKnownCliVersion)}</dd></div>` : ""}
      </dl></div>` : ""}
      ${hasCodeReviewActivity ? `<div class="usage-panel"><h3>Code Review</h3><dl>
        <div class="dr"><dt>Daily active / passive</dt><dd>${codeReview.dailyActiveUsers} / ${codeReview.dailyPassiveUsers}</dd></div>
        <div class="dr"><dt>Weekly active / passive</dt><dd>${codeReview.weeklyActiveUsers} / ${codeReview.weeklyPassiveUsers}</dd></div>
        <div class="dr"><dt>Monthly active / passive</dt><dd>${codeReview.monthlyActiveUsers} / ${codeReview.monthlyPassiveUsers}</dd></div>
        <div class="dr"><dt>Per-user active / passive</dt><dd>${usage.totals.codeReviewActiveUsers} / ${usage.totals.codeReviewPassiveUsers}</dd></div>
      </dl></div>` : ""}
      ${hasBilling ? `<div class="usage-panel"><h3>Seats & Policies</h3><dl>
        <div class="dr"><dt>Active / inactive seats</dt><dd>${billing.activeThisCycle} / ${billing.inactiveThisCycle}</dd></div>
        <div class="dr"><dt>Added / pending cancel</dt><dd>${billing.addedThisCycle} / ${billing.pendingCancellation}</dd></div>
        ${billing.seatManagementSetting ? `<div class="dr"><dt>Seat management</dt><dd>${escapeHtml(billing.seatManagementSetting)}</dd></div>` : ""}
        ${billing.ideChat || billing.platformChat || billing.cli ? `<div class="dr"><dt>IDE / GitHub / CLI</dt><dd>${escapeHtml(billing.ideChat ?? "-")} / ${escapeHtml(billing.platformChat ?? "-")} / ${escapeHtml(billing.cli ?? "-")}</dd></div>` : ""}
      </dl></div>` : ""}
    </div>
    <div class="usage-breakdown-grid">
      ${buildUsageBreakdownTable("IDEs", usage.byIde, "IDE")}
      ${buildUsageBreakdownTable("Languages", usage.byLanguage, "Language")}
      ${buildUsageBreakdownTable("Models", usage.byModel, "Model")}
      ${buildUsageBreakdownTable("Language / Feature", usage.byLanguageFeature, "Bucket")}
      ${buildUsageBreakdownTable("Language / Model", usage.byLanguageModel, "Bucket")}
      ${buildUsageBreakdownTable("Model / Feature", usage.byModelFeature, "Bucket")}
      ${buildIdeVersionTable(usage)}
      ${buildCommentTypeTable(usage)}
    </div>
    <div class="usage-toolbar" aria-label="Copilot usage table controls">
      <input type="search" id="copilotUsageSearch" placeholder="Search users or phases&hellip;" aria-label="Search Copilot usage users" autocomplete="off" />
      <select id="copilotUsageSurface" aria-label="Filter Copilot usage by surface">
        <option value="">All surfaces</option>
        <option value="chat">Chat</option>
        <option value="agent">Agent</option>
        <option value="cli">CLI</option>
        <option value="review">Code review</option>
      </select>
      <select id="copilotUsageSort" aria-label="Sort Copilot usage users">
        <option value="interactions">Interactions</option>
        <option value="login">User</option>
        <option value="activeDays">Active days</option>
        <option value="acceptance">Acceptance</option>
        <option value="locAdded">LOC added</option>
        <option value="lastActivity">Last activity</option>
      </select>
    </div>
    <div class="table-wrap usage-table-wrap">
      <table class="repo-table usage-table" aria-label="Copilot per-user usage">
        <thead><tr>
          <th class="usage-th-sortable" data-usage-sort="login">User <span class="sort-ind" aria-hidden="true"></span></th>
          <th>Adoption Phase</th>
          <th class="usage-th-sortable" data-usage-sort="activeDays">Report Rows <span class="sort-ind" aria-hidden="true"></span></th>
          <th class="usage-th-sortable" data-usage-sort="interactions">Interactions <span class="sort-ind" aria-hidden="true"></span></th>
          <th class="usage-th-sortable" data-usage-sort="generations">Gen / Accept <span class="sort-ind" aria-hidden="true"></span></th>
          <th class="usage-th-sortable" data-usage-sort="acceptance">Accept <span class="sort-ind" aria-hidden="true"></span></th>
          <th class="usage-th-sortable" data-usage-sort="locAdded">LOC +/- <span class="sort-ind" aria-hidden="true"></span></th>
          <th>Surfaces</th>
          <th class="usage-th-sortable" data-usage-sort="lastActivity">Last Activity <span class="sort-ind" aria-hidden="true"></span></th>
          <th>Editor</th>
        </tr></thead>
        <tbody id="copilotUsageRows">${rows || `<tr class="usage-empty-row"><td colspan="10">No per-user Copilot usage rows were returned.</td></tr>`}</tbody>
      </table>
    </div>
    <p class="repo-count usage-count"><span id="copilotUsageShown">${usage.users.length}</span> of ${usage.users.length} users</p>
  </div>`;
}

function buildUsageBreakdownTable(
  title: string,
  rows: CopilotUsageMetrics["byFeature"],
  label: string,
): string {
  if (rows.length === 0) return "";
  const body = rows.slice(0, 8).map((row) =>
    `<tr><td>${escapeHtml(row.name)}</td><td>${row.users}</td><td>${formatWholeNumber(row.userInitiatedInteractions)}</td><td>+${formatWholeNumber(row.locAdded)}</td><td>${row.acceptanceRate.toFixed(1)}%</td></tr>`,
  ).join("");
  return `<div class="usage-breakdown-panel"><h3>${escapeHtml(title)}</h3>
    <table><thead><tr><th>${escapeHtml(label)}</th><th>Users</th><th>Interactions</th><th>LOC</th><th>Accept</th></tr></thead><tbody>${body}</tbody></table>
  </div>`;
}

function buildIdeVersionTable(usage: CopilotUsageMetrics): string {
  if (usage.ideVersions.length === 0) return "";
  const body = usage.ideVersions.slice(0, 8).map((row) =>
    `<tr><td>${escapeHtml(row.ide)}</td><td>${escapeHtml(row.ideVersion ?? "-")}</td><td>${escapeHtml(row.pluginVersion ?? "-")}</td><td>${row.users}</td></tr>`,
  ).join("");
  return `<div class="usage-breakdown-panel"><h3>IDE Versions</h3>
    <table><thead><tr><th>IDE</th><th>IDE version</th><th>Plugin</th><th>Users</th></tr></thead><tbody>${body}</tbody></table>
  </div>`;
}

function buildCommentTypeTable(usage: CopilotUsageMetrics): string {
  const rows = usage.pullRequests.copilotSuggestionsByCommentType;
  if (rows.length === 0) return "";
  const body = rows.slice(0, 8).map((row) =>
    `<tr><td>${escapeHtml(row.commentType)}</td><td>${row.totalCopilotSuggestions}</td><td>${row.totalCopilotAppliedSuggestions}</td></tr>`,
  ).join("");
  return `<div class="usage-breakdown-panel"><h3>Review Suggestion Types</h3>
    <table><thead><tr><th>Type</th><th>Suggested</th><th>Applied</th></tr></thead><tbody>${body}</tbody></table>
  </div>`;
}

function formatWholeNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/* ------------------------------------------------------------------ */
/*  Embedded CSS                                                      */
/* ------------------------------------------------------------------ */

function getCSS(): string {
  // Dark-mode token overrides. Applied twice: once for an explicit
  // data-theme="dark" attribute, once for OS preference when no explicit
  // light theme is set (so: no attribute -> follows OS; attribute wins).
  const darkTokens =
    '--page:#0d0d0d;--surface:#1a1a19;--ink:#ffffff;--ink-2:#c3c2b7;--muted:#898781;' +
    '--grid:#2c2c2a;--rule:#383835;--border:rgba(255,255,255,.10);' +
    '--accent:#3987e5;--accent-wash:rgba(57,135,229,.12);' +
    '--good:#0ca30c;--good-text:#0ca30c;--warn:#fab219;--serious:#ec835a;--critical:#d03b3b;' +
    '--s1:#3987e5;--s2:#199e70;--s3:#c98500;--s4:#008300;--s5:#9085e9;--s6:#e66767;--s7:#d55181;--s8:#d95926;' +
    '--shadow:0 1px 2px rgba(0,0,0,.35)';
  return `
:root{--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink-2:#52514e;--muted:#898781;
  --grid:#e1e0d9;--rule:#c3c2b7;--border:rgba(11,11,11,.10);
  --accent:#2a78d6;--accent-wash:rgba(42,120,214,.08);
  --good:#0ca30c;--good-text:#006300;--warn:#fab219;--serious:#ec835a;--critical:#d03b3b;
  --s1:#2a78d6;--s2:#1baf7a;--s3:#eda100;--s4:#008300;--s5:#4a3aa7;--s6:#e34948;--s7:#e87ba4;--s8:#eb6834;
  --shadow:0 1px 2px rgba(11,11,11,.05)}
:root[data-theme="dark"]{${darkTokens}}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){${darkTokens}}}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-padding-top:76px}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
  color:var(--ink);background:var(--page);line-height:1.55;min-height:100vh}
a{color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
/* ── App shell: sticky header ── */
.site-header{position:sticky;top:0;z-index:100;background:var(--surface);
  border-bottom:1px solid var(--border);min-height:52px;display:flex;align-items:center}
.site-header-inner{width:100%;max-width:1480px;margin:0 auto;display:flex;align-items:center;
  gap:1rem;flex-wrap:wrap;padding:.5rem 1.25rem}
.brand{display:flex;align-items:baseline;gap:.65rem;white-space:nowrap}
.wordmark{font-size:.7rem;font-weight:650;letter-spacing:.16em;color:var(--muted);text-transform:uppercase}
.brand-owner{font-size:.9rem;font-weight:600;color:var(--ink);text-decoration:none}
.brand-owner:hover{color:var(--accent)}
.header-controls{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin-left:auto}
.filter-btns{display:flex;gap:.3rem;flex-wrap:wrap}
.filter-btn{font:inherit;font-size:.78rem;padding:.26rem .75rem;border:1px solid var(--border);
  border-radius:999px;background:transparent;color:var(--ink-2);cursor:pointer;white-space:nowrap;
  transition:border-color .15s,color .15s,background-color .15s}
.filter-btn:hover{border-color:var(--accent);color:var(--accent)}
.filter-btn.active{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.filter-toggle{display:flex;align-items:center;gap:.35rem;font-size:.78rem;color:var(--ink-2);
  cursor:pointer;white-space:nowrap}
.filter-toggle input{accent-color:var(--accent);cursor:pointer}
.theme-toggle{font:inherit;font-size:.9rem;line-height:1;width:1.9rem;height:1.9rem;
  display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--border);
  border-radius:999px;background:transparent;color:var(--ink-2);cursor:pointer}
.theme-toggle:hover{border-color:var(--accent);color:var(--accent)}
/* ── Repo picker (header) ── */
.repo-picker{position:relative}
.repo-picker-btn{font:inherit;font-size:.78rem;padding:.26rem .7rem;border:1px solid var(--border);
  border-radius:999px;background:transparent;color:var(--ink-2);cursor:pointer;
  display:inline-flex;align-items:center;gap:.35rem;white-space:nowrap;
  transition:border-color .15s,color .15s,background-color .15s}
.repo-picker-btn:hover{border-color:var(--accent);color:var(--accent)}
.repo-picker-btn.active{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.repo-picker-caret{font-size:.6rem;opacity:.7}
.repo-picker-panel{position:absolute;top:calc(100% + .4rem);right:0;z-index:200;
  background:var(--surface);border:1px solid var(--border);border-radius:10px;
  box-shadow:0 4px 16px rgba(11,11,11,.10);min-width:240px;max-width:320px}
.repo-picker-toolbar{display:flex;align-items:center;gap:.4rem;padding:.5rem .6rem;
  border-bottom:1px solid var(--grid)}
.repo-picker-action{font:inherit;font-size:.75rem;padding:.2rem .55rem;border:1px solid var(--border);
  border-radius:999px;background:transparent;color:var(--ink-2);cursor:pointer;white-space:nowrap}
.repo-picker-action:hover{border-color:var(--accent);color:var(--accent)}
.repo-picker-search{font:inherit;font-size:.8rem;padding:.25rem .5rem;flex:1;min-width:0;
  border:1px solid var(--border);border-radius:6px;background:var(--page);color:var(--ink)}
.repo-picker-list{max-height:260px;overflow-y:auto;padding:.3rem 0}
.repo-picker-item{display:flex;align-items:center;gap:.45rem;padding:.3rem .75rem;
  font-size:.83rem;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink-2)}
.repo-picker-item:hover{background:var(--accent-wash)}
.repo-picker-item input{accent-color:var(--accent);cursor:pointer;flex-shrink:0}
/* ── Shell: rail + content ── */
.shell{max-width:1480px;margin:0 auto;display:grid;grid-template-columns:190px minmax(0,1fr);
  gap:2.5rem;padding:0 1.25rem}
.content{min-width:0}
.rail{position:sticky;top:68px;align-self:start;max-height:calc(100vh - 68px);overflow-y:auto;
  padding:2.75rem 0 1rem;display:flex;flex-direction:column;gap:.1rem}
.rail a{display:block;padding:.32rem .7rem;font-size:.8rem;color:var(--muted);text-decoration:none;
  border-left:2px solid transparent;white-space:nowrap}
.rail a:hover{color:var(--ink)}
.rail a.active{color:var(--accent);border-left-color:var(--accent);font-weight:600}
.rail-num{display:inline-block;min-width:1.5rem;font-size:.68rem;letter-spacing:.08em;opacity:.75}
.rail-chips{display:none}
@media(max-width:1099px){
  .shell{display:block}
  .rail{display:none}
  .rail-chips{display:flex;gap:.4rem;overflow-x:auto;padding:.55rem 1.25rem;
    border-bottom:1px solid var(--border);background:var(--page)}
  .rail-chips a{flex:0 0 auto;font-size:.75rem;padding:.24rem .7rem;border:1px solid var(--border);
    border-radius:999px;color:var(--ink-2);text-decoration:none;white-space:nowrap}
  .rail-chips a:hover{border-color:var(--accent);color:var(--accent)}
}
/* ── Masthead ── */
.masthead{padding:3rem 0 1.25rem}
.masthead-kicker{font-size:.72rem;font-weight:650;letter-spacing:.16em;color:var(--muted);text-transform:uppercase}
.masthead-owner{font-size:clamp(2rem,5vw,3.2rem);font-weight:750;letter-spacing:-.02em;line-height:1.05;margin-top:.35rem}
.masthead-owner a{color:var(--ink);text-decoration:none}
.masthead-owner a:hover{color:var(--accent)}
.masthead-meta{margin-top:.6rem;font-size:.85rem;color:var(--muted)}
/* ── Numbered sections ── */
.sec{margin:0 0 3.5rem}
.sec-title{display:flex;align-items:baseline;gap:.6rem;font-size:1.05rem;font-weight:700;
  padding-bottom:.55rem;border-bottom:1px solid var(--rule);margin-bottom:1.25rem}
.sec-num{font-size:.72rem;font-weight:600;letter-spacing:.1em;color:var(--muted)}
.block-head{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;flex-wrap:wrap;
  margin:1.75rem 0 .85rem}
.block-head h3{font-size:.95rem;font-weight:700}
.block-head p{font-size:.8rem;color:var(--muted)}
/* ── Stat tiles ── */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:.85rem;margin-bottom:1.25rem}
@media(min-width:1100px){.kpis{grid-template-columns:repeat(4,minmax(0,1fr))}}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:10px;
  padding:1.1rem 1.15rem;box-shadow:var(--shadow);display:flex;flex-direction:column;gap:.2rem}
.kpi-lbl{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:600}
.kpi-val{font-size:2.1rem;font-weight:700;line-height:1.1;color:var(--ink)}
.kpi-sub{font-size:.78rem;color:var(--ink-2)}
.kpi-spark{position:relative;height:36px;margin-top:.4rem}
.kpi-spark canvas{display:block;width:100%;height:100%}
/* ── DORA tier badges ── */
.kpi-lbl-row{display:flex;align-items:center;justify-content:space-between;gap:.5rem}
.dora-tier{display:inline-block;font-size:.62rem;font-weight:700;letter-spacing:.06em;
  text-transform:uppercase;padding:.1rem .5rem;border-radius:999px;line-height:1.5;white-space:nowrap}
.dora-tier[hidden]{display:none}
.tier-elite{background:var(--good);color:#fff}
.tier-high{background:var(--accent);color:#fff}
.tier-medium{background:var(--warn);color:#0b0b0b}
.tier-low{background:var(--critical);color:#fff}
/* ── Week-over-week delta chips (Overview) ── */
.delta-strip{display:flex;flex-wrap:wrap;gap:.4rem;margin:-.35rem 0 1.25rem}
.delta-chip{display:inline-flex;align-items:baseline;gap:.4rem;font-size:.75rem;padding:.18rem .6rem;
  border:1px solid var(--border);border-radius:999px;background:var(--surface);color:var(--ink-2);white-space:nowrap}
.delta-move{font-weight:700;font-variant-numeric:tabular-nums}
.delta-good .delta-move{color:var(--good-text)}
.delta-bad .delta-move{color:var(--critical)}
.delta-flat .delta-move{color:var(--muted)}
/* ── Delivery forecast & team targets ── */
.forecast-table-wrap{max-width:760px}
.targets-table-wrap{max-width:860px}
.target-detail{color:var(--ink-2)}
/* ── Code review ── */
.review-table-wrap{max-width:640px}
/* ── Insight / benchmark cards ── */
.insights-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:.85rem}
.insight-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;
  padding:1.1rem 1.15rem;box-shadow:var(--shadow);display:flex;flex-direction:column;gap:.25rem}
.insight-card h3{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:600}
.insight-val{font-size:1.5rem;font-weight:700;line-height:1.15;color:var(--ink)}
.insight-sub{font-size:.78rem;color:var(--ink-2)}
/* ── Chart cards ── */
.charts{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-top:1.25rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;
  padding:1.1rem 1.25rem;box-shadow:var(--shadow)}
.card h2{font-size:.8rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;
  color:var(--muted);margin-bottom:.75rem}
.card-wide{grid-column:1/-1}
.card canvas{display:block;width:100%;max-height:260px}
.card-wide canvas{max-height:340px}
/* ── Tables ── */
.repos-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem;margin-bottom:.85rem}
#repoFilter,#repoSort,#copilotUsageSearch,#copilotUsageSurface,#copilotUsageSort{font:inherit;
  font-size:.85rem;padding:.4rem .7rem;border:1px solid var(--border);border-radius:8px;
  background:var(--surface);color:var(--ink)}
#repoFilter{width:220px}
#copilotUsageSearch{width:260px;max-width:100%}
.repos-period-note{font-size:.78rem;color:var(--ink-2);margin:.25rem 0 .6rem;padding:.35rem .6rem;
  background:var(--accent-wash);border-left:2px solid var(--accent);border-radius:0 6px 6px 0}
.table-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:10px;background:var(--surface)}
.repo-table{width:100%;border-collapse:collapse;background:var(--surface);font-size:.85rem}
.repo-table thead tr{border-bottom:2px solid var(--rule)}
.repo-table th{padding:.55rem .8rem;text-align:left;font-size:.7rem;text-transform:uppercase;
  letter-spacing:.08em;color:var(--muted);font-weight:600;white-space:nowrap;background:var(--surface);
  position:sticky;top:0;z-index:1;box-shadow:inset 0 -2px 0 var(--rule)}
.repo-table td{padding:.5rem .8rem;border-bottom:1px solid var(--grid);vertical-align:middle;
  font-variant-numeric:tabular-nums}
.repo-row:hover>td{background:var(--accent-wash)}
.repo-row.expanded>td{background:var(--accent-wash)}
.repo-detail-cell{background:var(--page);padding:1rem 1.25rem}
.th-sortable,.intel-th-sortable,.usage-th-sortable,.health-th-sortable{cursor:pointer;user-select:none}
.th-sortable:hover,.th-sortable.sort-active,.intel-th-sortable:hover,.intel-th-sortable.sort-active,
.usage-th-sortable:hover,.usage-th-sortable.sort-active,
.health-th-sortable:hover,.health-th-sortable.sort-active{color:var(--accent)}
.sort-ind{margin-left:.3rem;font-size:.8rem;display:inline-block;min-width:.7rem}
.repo-name-cell{display:flex;align-items:center;gap:.4rem;min-width:180px}
.repo-expand-btn{display:inline-flex;align-items:center;justify-content:center;
  width:1.4rem;height:1.4rem;border:none;background:none;color:var(--muted);
  cursor:pointer;padding:0;flex-shrink:0;font-size:1.1rem;line-height:1}
.repo-expand-btn:hover{color:var(--accent)}
.chev{display:inline-block;transition:transform .2s}
.repo-row.expanded .chev{transform:rotate(90deg)}
.rname{font-weight:600;color:var(--accent);text-decoration:none;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:.85rem}
.rname:hover{text-decoration:underline}
.col-muted{color:var(--muted);font-size:.8rem}
.col-num{text-align:right}
.col-date,.col-lines{white-space:nowrap;text-align:right}
.td-lines{text-align:right}.td-lines span{display:block}
.grp-hdr-row{cursor:pointer;user-select:none}
.grp-hdr-cell{padding:.5rem .8rem;font-size:.78rem;font-weight:600;letter-spacing:.04em;
  background:var(--page);color:var(--muted);border-bottom:1px solid var(--grid)}
.grp-hdr-row:hover .grp-hdr-cell{color:var(--ink)}
.grp-chevron{display:inline-block;font-size:.9rem;transition:transform .2s;
  color:var(--muted);margin-right:.4rem}
.grp-hdr-row.expanded .grp-chevron{transform:rotate(90deg)}
.grp-count{color:var(--muted);font-size:.8rem;font-weight:400}
.bdg{font-size:.7rem;padding:.1rem .5rem;border-radius:999px;font-weight:500;white-space:nowrap;
  border:1px solid var(--border);color:var(--muted)}
.bdg-age{background:transparent}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1rem;margin-bottom:1rem}
.sg h4{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:.4rem}
dl{display:flex;flex-direction:column;gap:.15rem}
.dr{display:flex;justify-content:space-between;font-size:.85rem}
.dr dt{color:var(--muted)}.dr dd{font-weight:600;font-variant-numeric:tabular-nums}
.pr-wrap{margin-top:.5rem}.pr-wrap h4{font-size:.85rem;margin-bottom:.5rem}
.pr-tbl{width:100%;border-collapse:collapse;font-size:.8rem}
.pr-tbl th,.pr-tbl td{text-align:left;padding:.35rem .5rem;border-bottom:1px solid var(--grid)}
.pr-tbl td{font-variant-numeric:tabular-nums}
.pr-tbl th{color:var(--muted);font-weight:600;font-size:.7rem;text-transform:uppercase;letter-spacing:.06em}
.add{color:var(--good-text);font-weight:600}.del{color:var(--critical);font-weight:600}
.repo-count{text-align:center;font-size:.8rem;color:var(--muted);margin-top:.75rem}
/* ── Engineering intelligence ── */
.intel-section{margin-top:.5rem}
.intel-subhead{font-size:.92rem;font-weight:700;margin:1.75rem 0 .6rem}
.intel-table-wrap{margin-bottom:.85rem}
.intel-note{color:var(--muted);font-weight:400;font-size:.78rem}
.intel-caption{font-size:.78rem;color:var(--muted);margin:-.35rem 0 1rem}
/* ── Insights (automated findings) ── */
.sec-sub{font-size:.82rem;color:var(--muted);margin:-.85rem 0 1.1rem}
.insight-list{display:flex;flex-direction:column;gap:.65rem}
.insight-item{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--muted);
  border-radius:10px;padding:.85rem 1.1rem;box-shadow:var(--shadow)}
.insight-item.sev-critical{border-left-color:var(--critical)}
.insight-item.sev-warning{border-left-color:var(--warn)}
.insight-item.sev-info{border-left-color:var(--s1)}
.insight-item.sev-positive{border-left-color:var(--good)}
.insight-item-head{display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap}
.insight-item-head h3{font-size:.92rem;font-weight:700}
.insight-chip{display:inline-block;font-size:.62rem;font-weight:700;letter-spacing:.06em;
  text-transform:uppercase;padding:.1rem .5rem;border-radius:999px;line-height:1.5;white-space:nowrap;
  align-self:center}
.chip-critical{background:var(--critical);color:#fff}
.chip-warning{background:var(--warn);color:#0b0b0b}
.chip-info{background:var(--s1);color:#fff}
.chip-positive{background:var(--good);color:#fff}
.chip-nodata{background:var(--muted);color:#fff}
.insight-item-repo{font-size:.75rem;color:var(--muted);font-variant-numeric:tabular-nums}
.insight-item-detail{font-size:.85rem;color:var(--ink-2);margin-top:.35rem}
.insight-item-reco{font-size:.8rem;color:var(--muted);margin-top:.25rem}
/* ── Repo health ── */
.health-table-wrap{max-height:520px;overflow-y:auto;margin-bottom:.85rem}
.health-table th,.health-table td{white-space:nowrap}
.health-table td:first-child{white-space:normal;min-width:160px}
.health-attn>td{background:rgba(236,131,90,.08)}
.health-attn .health-score{color:var(--serious);font-weight:700}
.health-grade{font-weight:700}
/* ── Collaboration ── */
.collab-section{margin-top:2rem}
.collab-table-wrap{max-width:640px}
/* ── Copilot usage ── */
.usage-section{margin-top:1.5rem}
.usage-header{display:flex;align-items:flex-end;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:.9rem}
.usage-header h3{font-size:.95rem;font-weight:700}
.usage-meta{font-size:.82rem;color:var(--muted);margin-top:.15rem}
.usage-pill-row{display:flex;flex-wrap:wrap;gap:.4rem;justify-content:flex-end}
.usage-pill{font-size:.75rem;color:var(--ink-2);border:1px solid var(--border);border-radius:999px;
  padding:.18rem .6rem;background:var(--surface)}
.usage-pill strong{color:var(--ink);font-weight:600;margin-left:.25rem}
.impact-section,.repo-usage-section{padding:1.2rem 0;border-top:1px solid var(--rule);margin-bottom:1rem}
.impact-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:1.25rem;
  flex-wrap:wrap;margin-bottom:.9rem}
.impact-heading h3{font-size:1.05rem;line-height:1.25}
.impact-heading>p{max-width:560px;color:var(--muted);font-size:.78rem;text-align:right}
.section-kicker{font-size:.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:.18rem}
.impact-layout{display:grid;grid-template-columns:minmax(250px,.75fr) minmax(520px,1.5fr);gap:1.25rem;align-items:center}
.impact-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;margin-bottom:1rem}
.impact-stats div{min-width:0}
.impact-stats strong{display:block;font-size:1.75rem;line-height:1.05;font-weight:720}
.impact-stats span,.impact-stats small{display:block}
.impact-stats span{font-size:.75rem;font-weight:650;margin-top:.28rem}
.impact-stats small{font-size:.68rem;color:var(--muted);margin-top:.08rem}
.impact-bar{height:18px;display:flex;overflow:hidden;border-radius:4px;background:var(--grid);
  border:1px solid var(--border)}
.impact-segment{display:block;min-width:0;height:100%}
.impact-phase-0{background:var(--muted)}
.impact-phase-1{background:var(--s3)}
.impact-phase-2{background:var(--s2)}
.impact-phase-3{background:var(--s1)}
.impact-table-wrap{margin:0}
.impact-table{width:100%;border-collapse:collapse;font-size:.76rem}
.impact-table th,.impact-table td{padding:.42rem .5rem;border-bottom:1px solid var(--grid);
  text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.impact-table th{font-size:.64rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.impact-table th:first-child,.impact-table td:first-child{text-align:left}
.impact-key{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:.45rem}
.impact-note{font-size:.7rem;color:var(--muted);margin-top:.7rem}
.repo-usage-section{border-bottom:1px solid var(--rule)}
.repo-usage-table-wrap{margin:0;overflow-x:auto}
.repo-usage-table{min-width:920px}
.repo-usage-table td:first-child{min-width:220px;white-space:normal;overflow-wrap:anywhere}
.repo-visibility{display:block;color:var(--muted);font-size:.65rem;text-transform:uppercase;letter-spacing:.06em}
.activity-badges{display:flex;flex-wrap:wrap;gap:.25rem;margin-top:.35rem}
.activity-badge{display:inline-flex;align-items:center;width:max-content;border:1px solid rgba(27,175,122,.35);
  border-radius:999px;padding:.08rem .42rem;background:rgba(27,175,122,.08);color:var(--good-text);
  font-size:.62rem;font-weight:650}
.activity-badge-review{border-color:rgba(42,120,214,.35);background:var(--accent-wash);color:var(--accent)}
.usage-unavailable{font-size:.82rem;color:var(--muted);padding:.75rem 0}
.usage-summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.75rem;margin-bottom:1rem}
.usage-summary-grid div{background:var(--surface);border:1px solid var(--border);border-radius:10px;
  padding:.8rem .9rem;box-shadow:var(--shadow)}
.usage-summary-grid span{display:block;font-size:1.35rem;font-weight:700;line-height:1.1}
.usage-summary-grid small{display:block;color:var(--muted);font-size:.7rem;letter-spacing:.06em;
  text-transform:uppercase;margin-top:.25rem}
.usage-insights-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:.75rem;margin-bottom:1rem}
.usage-panel,.usage-breakdown-panel{background:var(--surface);border:1px solid var(--border);
  border-radius:10px;padding:.9rem 1rem;box-shadow:var(--shadow)}
.usage-panel h3,.usage-breakdown-panel h3{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;
  color:var(--muted);margin-bottom:.55rem;font-weight:600}
.usage-breakdown-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:.75rem;margin-bottom:1rem}
.usage-breakdown-panel{overflow-x:auto}
.usage-breakdown-panel table{width:100%;border-collapse:collapse;font-size:.78rem}
.usage-breakdown-panel th{color:var(--muted);font-size:.66rem;text-transform:uppercase;letter-spacing:.08em;
  text-align:left;padding:.25rem .35rem;border-bottom:1px solid var(--rule);white-space:nowrap}
.usage-breakdown-panel td{padding:.3rem .35rem;border-bottom:1px solid var(--grid);vertical-align:top;
  font-variant-numeric:tabular-nums}
.usage-breakdown-panel td:not(:first-child){text-align:right;white-space:nowrap}
.usage-toolbar{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin-bottom:.75rem}
.usage-table th,.usage-table td{white-space:nowrap}
.usage-table td:nth-child(1),.usage-table td:nth-child(2){white-space:normal}
/* ── Back to top ── */
.back-to-top{position:fixed;right:1.25rem;bottom:1.25rem;z-index:90;width:2.4rem;height:2.4rem;
  border-radius:999px;border:1px solid var(--border);background:var(--surface);color:var(--ink-2);
  font-size:1rem;line-height:1;cursor:pointer;box-shadow:0 1px 2px rgba(11,11,11,.08);
  display:inline-flex;align-items:center;justify-content:center}
.back-to-top:hover{color:var(--accent);border-color:var(--accent)}
.back-to-top[hidden]{display:none}
/* ── Footer ── */
footer{border-top:1px solid var(--border);margin-top:3.5rem;padding:1.25rem 0 2.5rem;
  font-size:.8rem;color:var(--muted)}
footer a{color:var(--ink-2)}
@media(max-width:640px){
  .charts{grid-template-columns:1fr}
  .kpis{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
  .repos-toolbar{flex-direction:column;align-items:stretch}
  #repoFilter{width:100%}
  .col-date,.col-lines{display:none}
  .masthead{padding-top:2rem}
  .impact-stats strong{font-size:1.45rem}
}
@media(max-width:900px){
  .impact-heading{align-items:flex-start}
  .impact-heading>p{text-align:left}
  .impact-layout{grid-template-columns:minmax(0,1fr)}
}
`;
}

/* ------------------------------------------------------------------ */
/*  Embedded JavaScript                                               */
/* ------------------------------------------------------------------ */

function getJS(): string {
  return `
var charts={};
var reposVisibility=[true,true];
var VT=null;
var SERIES=null;
var selectedRepos=new Set();
// ── Viz theme plumbing ──
// All chart colors resolve through CSS custom properties at chart-build time,
// so light/dark rebuilds pick up the active mode's values.
function vizTheme(){
  var cs=getComputedStyle(document.documentElement);
  function cv(n){return cs.getPropertyValue(n).trim();}
  return{s1:cv("--s1"),s2:cv("--s2"),s3:cv("--s3"),s4:cv("--s4"),
    s5:cv("--s5"),s6:cv("--s6"),s7:cv("--s7"),s8:cv("--s8"),
    grid:cv("--grid"),rule:cv("--rule"),muted:cv("--muted"),
    ink:cv("--ink"),ink2:cv("--ink-2"),surface:cv("--surface"),
    good:cv("--good"),warn:cv("--warn"),serious:cv("--serious"),critical:cv("--critical")};
}
// Fixed entity->color map: color follows the entity, never filter state or
// dataset order. Resolved from the current vizTheme at chart-build time.
function buildSeries(T){
  return{prsMerged:T.s1,prsOpened:T.s2,issuesOpened:T.s3,issuesClosed:T.s4,
    ai:T.s5,human:T.s1,bot:T.muted,linesAdded:T.s4,linesDeleted:T.s6,
    claude:T.s7,codex:T.s8,
    completed:T.good,failed:T.critical,cancelled:T.serious,timedOut:T.warn,active:T.s1};
}
function hexToRgba(hex,a){
  var h=(hex||"").replace("#","");
  if(h.length===3)h=h.split("").map(function(c){return c+c;}).join("");
  var r=parseInt(h.slice(0,2),16)||0,g=parseInt(h.slice(2,4),16)||0,b=parseInt(h.slice(4,6),16)||0;
  return "rgba("+r+","+g+","+b+","+a+")";
}
function contrastText(hex){
  var h=(hex||"").replace("#","");
  if(h.length===3)h=h.split("").map(function(c){return c+c;}).join("");
  var r=parseInt(h.slice(0,2),16)||0,g=parseInt(h.slice(2,4),16)||0,b=parseInt(h.slice(4,6),16)||0;
  return (0.2126*r+0.7152*g+0.0722*b)>150?"#0b0b0b":"#ffffff";
}
document.addEventListener("DOMContentLoaded",function(){
  if(typeof Chart!=="undefined"){renderCharts();}
  setupGroups();
  setupControls();
  setupSortHeaders();
  setupFilter();
  setupRepoPicker();
  setupCopilotUsageControls();
  setupLeaderboardControls();
  setupHealthControls();
  formatLineNumbers();
  setupTheme();
  setupScrollspy();
  setupBackToTop();
  applyFilter("30days");
});
// ── Theme re-render ──
// Destroy and rebuild every chart with fresh vizTheme() colors, then re-apply
// the current filter state (period button, bots toggle, repo selection) via
// the existing applyFilter entry point.
window.addEventListener("themechange",function(){
  if(typeof Chart==="undefined")return;
  Object.keys(charts).forEach(function(k){
    var c=charts[k];
    if(c&&typeof c.destroy==="function"){try{c.destroy();}catch(e){}}
    delete charts[k];
  });
  renderCharts();
  var activeBtn=document.querySelector(".filter-btn.active");
  applyFilter(activeBtn?activeBtn.dataset.period:"30days");
});
// ── App shell: theme toggle ──
// localStorage 'devex-theme' in {light,dark}; absent = follow OS preference.
// The <head> inline script applies the stored theme before first paint.
function setupTheme(){
  var btn=document.getElementById("themeToggle");
  if(!btn)return;
  function storedTheme(){
    try{
      var t=localStorage.getItem("devex-theme");
      if(t==="light"||t==="dark")return t;
    }catch(e){}
    return null;
  }
  function effectiveTheme(){
    var attr=document.documentElement.getAttribute("data-theme");
    if(attr==="light"||attr==="dark")return attr;
    if(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches)return "dark";
    return "light";
  }
  function updateGlyph(){
    var s=storedTheme();
    btn.textContent=s==="light"?"\\u2600":s==="dark"?"\\u263E":"\\u25D0";
    btn.setAttribute("title","Theme: "+(s||"system"));
  }
  btn.addEventListener("click",function(){
    var next=effectiveTheme()==="dark"?"light":"dark";
    document.documentElement.setAttribute("data-theme",next);
    try{localStorage.setItem("devex-theme",next);}catch(e){}
    updateGlyph();
    window.dispatchEvent(new CustomEvent("themechange"));
  });
  updateGlyph();
}
// ── App shell: rail scrollspy ──
function setupScrollspy(){
  var links=Array.prototype.slice.call(document.querySelectorAll(".rail a[href^='#']"));
  if(links.length===0||typeof IntersectionObserver==="undefined")return;
  var byId={};
  links.forEach(function(l){byId[l.getAttribute("href").slice(1)]=l;});
  var sections=Object.keys(byId).map(function(id){return document.getElementById(id);})
    .filter(function(el){return !!el;});
  if(sections.length===0)return;
  var visible={};
  var obs=new IntersectionObserver(function(entries){
    entries.forEach(function(en){visible[en.target.id]=en.isIntersecting;});
    var active=null;
    for(var i=0;i<sections.length;i++){
      if(visible[sections[i].id]){active=sections[i].id;break;}
    }
    if(active){
      links.forEach(function(l){l.classList.toggle("active",l===byId[active]);});
    }
  },{rootMargin:"-25% 0px -65% 0px"});
  sections.forEach(function(s){obs.observe(s);});
}
// ── App shell: back to top ──
function setupBackToTop(){
  var btn=document.getElementById("backToTop");
  if(!btn)return;
  btn.addEventListener("click",function(){
    window.scrollTo({top:0,behavior:"smooth"});
  });
  var mast=document.getElementById("masthead");
  if(!mast||typeof IntersectionObserver==="undefined")return;
  var obs=new IntersectionObserver(function(entries){
    btn.hidden=entries[0].isIntersecting;
  },{rootMargin:"200% 0px 0px 0px"});
  obs.observe(mast);
}
function formatLineNumbers(){
  document.querySelectorAll(".td-lines .add,.td-lines .del").forEach(function(el){
    var t=el.textContent||"";
    var sign=t.charAt(0);
    var n=parseInt(t.slice(1).replace(/,/g,""),10);
    if(!isNaN(n))el.textContent=sign+n.toLocaleString();
  });
}
// ── Chart plugins (per-chart, passed via plugins:[...]) ──
// Direct value labels at stacked-segment centers, drawn only when they fit;
// otherwise the legend + tooltip carry the value.
var segLabelPlugin={id:"segLabels",afterDatasetsDraw:function(chart){
  var opts=(chart.options.plugins||{}).segLabels||{};
  var ctx=chart.ctx;
  var totals=[];
  chart.data.datasets.forEach(function(ds,i){
    if(!chart.isDatasetVisible(i))return;
    (ds.data||[]).forEach(function(v,j){totals[j]=(totals[j]||0)+(v||0);});
  });
  chart.data.datasets.forEach(function(ds,i){
    if(!chart.isDatasetVisible(i))return;
    var meta=chart.getDatasetMeta(i);
    meta.data.forEach(function(el,j){
      var v=ds.data[j];
      if(!v)return;
      var txt=opts.pct&&totals[j]>0?(v/totals[j]*100).toFixed(1)+"%":fmtWhole(v);
      ctx.save();
      ctx.font="600 11px system-ui,-apple-system,'Segoe UI',sans-serif";
      var w=ctx.measureText(txt).width;
      var p=el.getProps(["x","y","base"],true);
      if(Math.abs(p.x-p.base)>w+14){
        ctx.fillStyle=contrastText(ds.backgroundColor);
        ctx.textAlign="center";ctx.textBaseline="middle";
        ctx.fillText(txt,(p.x+p.base)/2,p.y);
      }
      ctx.restore();
    });
  });
}};
// Value labels at horizontal-bar ends (drawn inside the bar when the label
// would overflow the chart area).
var barEndLabelPlugin={id:"barEndLabels",afterDatasetsDraw:function(chart){
  var ctx=chart.ctx;
  chart.data.datasets.forEach(function(ds,i){
    if(!chart.isDatasetVisible(i))return;
    var meta=chart.getDatasetMeta(i);
    meta.data.forEach(function(el,j){
      var v=ds.data[j];
      if(v==null)return;
      var txt=fmtWhole(v);
      ctx.save();
      ctx.font="600 11px system-ui,-apple-system,'Segoe UI',sans-serif";
      ctx.textBaseline="middle";
      var w=ctx.measureText(txt).width;
      var p=el.getProps(["x","y"],true);
      if(p.x+6+w>chart.chartArea.right){
        var bg=Array.isArray(ds.backgroundColor)?ds.backgroundColor[j]:ds.backgroundColor;
        ctx.fillStyle=contrastText(bg);
        ctx.textAlign="right";
        ctx.fillText(txt,p.x-6,p.y);
      }else{
        ctx.fillStyle=VT.ink2;
        ctx.textAlign="left";
        ctx.fillText(txt,p.x+6,p.y);
      }
      ctx.restore();
    });
  });
}};
// ── Shared mark specs ──
function lineDs(label,data,color,fill){
  return{label:label,data:data,borderColor:color,
    backgroundColor:fill?hexToRgba(color,0.10):"transparent",fill:!!fill,
    borderWidth:2,tension:0.3,pointRadius:0,pointHoverRadius:4,pointHitRadius:12,
    pointHoverBackgroundColor:color};
}
function barDs(label,data,color){
  return{label:label,data:data,backgroundColor:color,
    maxBarThickness:24,borderRadius:4,borderSkipped:"start"};
}
function stackDs(label,data,color){
  return{label:label,data:data,backgroundColor:color,
    maxBarThickness:24,borderRadius:4,borderSkipped:false,
    borderColor:VT.surface,borderWidth:2};
}
function lineOpts(multi){
  return{responsive:true,maintainAspectRatio:true,
    interaction:{mode:"index",intersect:false},
    scales:{x:{grid:{display:false},border:{color:VT.rule}},
      y:{beginAtZero:true,grid:{color:VT.grid},border:{color:VT.rule}}},
    plugins:{legend:multi?{}:{display:false}}};
}
// Single-row horizontal split bar (replaces the former doughnuts).
function splitBarDatasets(segments){
  return segments.map(function(s){
    return{label:s.label,data:[s.value],backgroundColor:s.color,
      borderColor:VT.surface,borderWidth:2,borderSkipped:false,maxBarThickness:28};
  });
}
function splitBarOpts(pct,total){
  // Part-to-whole: pin the axis to the segment total so the bar fills the
  // full width, and hide the (now redundant) axis — segment labels, the
  // legend, and tooltips carry the values.
  return{indexAxis:"y",responsive:true,maintainAspectRatio:true,aspectRatio:4,
    scales:{x:{stacked:true,beginAtZero:true,display:false,max:total>0?total:undefined},
      y:{stacked:true,display:false}},
    plugins:{legend:{},segLabels:pct?{pct:true}:{}}};
}
function updateSplitBar(chart,segments){
  var total=segments.reduce(function(s,seg){return s+(seg.value||0);},0);
  chart.options.scales.x.max=total>0?total:undefined;
  chart.data.labels=[""];
  chart.data.datasets=splitBarDatasets(segments);
  chart.update();
}
function reposDatasets(rows){
  return[
    barDs("Issues",rows.map(function(r){return r.issues;}),SERIES.issuesOpened),
    barDs("Pull Requests",rows.map(function(r){return r.prs;}),SERIES.prsMerged)];
}
function renderCharts(){
  VT=vizTheme();
  SERIES=buildSeries(VT);
  Chart.defaults.font.family='system-ui,-apple-system,"Segoe UI",sans-serif';
  Chart.defaults.font.size=11;
  Chart.defaults.color=VT.muted;
  Chart.defaults.borderColor=VT.grid;
  Chart.defaults.plugins.legend.position="top";
  Chart.defaults.plugins.legend.align="end";
  Chart.defaults.plugins.legend.labels.usePointStyle=true;
  Chart.defaults.plugins.legend.labels.boxWidth=8;
  Chart.defaults.plugins.legend.labels.boxHeight=8;
  Chart.defaults.plugins.legend.labels.padding=14;
  Chart.defaults.plugins.tooltip.backgroundColor=VT.surface;
  Chart.defaults.plugins.tooltip.titleColor=VT.ink;
  Chart.defaults.plugins.tooltip.bodyColor=VT.ink2;
  Chart.defaults.plugins.tooltip.borderColor=VT.grid;
  Chart.defaults.plugins.tooltip.borderWidth=1;
  Chart.defaults.plugins.tooltip.cornerRadius=8;
  Chart.defaults.plugins.tooltip.padding=10;
  charts.issues=new Chart(document.getElementById("chartIssues"),{type:"bar",
    data:{labels:[""],datasets:splitBarDatasets([
      {label:"Open",value:CHART_DATA.issues.open,color:SERIES.issuesOpened},
      {label:"Closed",value:CHART_DATA.issues.closed,color:SERIES.issuesClosed}])},
    options:splitBarOpts(false,CHART_DATA.issues.open+CHART_DATA.issues.closed),plugins:[segLabelPlugin]});
  charts.prs=new Chart(document.getElementById("chartPRs"),{type:"bar",
    data:{labels:[""],datasets:splitBarDatasets([
      {label:"Open",value:CHART_DATA.prs.open,color:SERIES.prsOpened},
      {label:"Merged",value:CHART_DATA.prs.merged,color:SERIES.prsMerged},
      {label:"Closed",value:CHART_DATA.prs.closed,color:VT.muted}])},
    options:splitBarOpts(false,CHART_DATA.prs.open+CHART_DATA.prs.merged+CHART_DATA.prs.closed),plugins:[segLabelPlugin]});
  if(CHART_DATA.topRepos.length>0){
    charts.repos=new Chart(document.getElementById("chartRepos"),{type:"bar",
      data:{labels:CHART_DATA.topRepos.map(function(r){return r.name;}),
        datasets:reposDatasets(CHART_DATA.topRepos)},
      options:{indexAxis:"y",responsive:true,maintainAspectRatio:true,
        scales:{x:{beginAtZero:true,grid:{color:VT.grid},border:{color:VT.rule}},
          y:{grid:{display:false},border:{color:VT.rule}}},
        plugins:{legend:{onClick:function(e,item,legend){
          reposVisibility[item.datasetIndex]=!reposVisibility[item.datasetIndex];
          legend.chart.setDatasetVisibility(item.datasetIndex,reposVisibility[item.datasetIndex]);
          legend.chart.update();
        }}}}});
  }
  if(CHART_DATA.weeklyTrends&&CHART_DATA.weeklyTrends.length>0){
    var tLabels=CHART_DATA.weeklyTrends.map(function(t){return t.week;});
    charts.prTrends=new Chart(document.getElementById("chartPRTrends"),{type:"line",
      data:{labels:tLabels,datasets:[
        lineDs("Opened",CHART_DATA.weeklyTrends.map(function(t){return t.prsOpened;}),SERIES.prsOpened,false),
        lineDs("Merged",CHART_DATA.weeklyTrends.map(function(t){return t.prsMerged;}),SERIES.prsMerged,false)]},
      options:lineOpts(true)});
    charts.issueTrends=new Chart(document.getElementById("chartIssueTrends"),{type:"line",
      data:{labels:tLabels,datasets:[
        lineDs("Opened",CHART_DATA.weeklyTrends.map(function(t){return t.issuesOpened;}),SERIES.issuesOpened,false),
        lineDs("Closed",CHART_DATA.weeklyTrends.map(function(t){return t.issuesClosed;}),SERIES.issuesClosed,false)]},
      options:lineOpts(true)});
    charts.prSizeTrends=new Chart(document.getElementById("chartPRSizeTrends"),{type:"line",
      data:{labels:tLabels,datasets:[
        lineDs("Lines Added",CHART_DATA.weeklyTrends.map(function(t){return t.linesAdded;}),SERIES.linesAdded,false),
        lineDs("Lines Removed",CHART_DATA.weeklyTrends.map(function(t){return t.linesDeleted;}),SERIES.linesDeleted,false)]},
      options:lineOpts(true)});
  }
  renderDeliveryCharts();
  renderSparkline();
}
// ── KPI sparkline: last 12 weeks of merged PRs in the Merged PRs stat tile ──
function renderSparkline(){
  var el=document.getElementById("kpiPRSpark");
  if(!el)return;
  var trends=CHART_DATA.weeklyTrends||[];
  if(trends.length===0)return;
  var last=trends.slice(-12);
  charts.kpiSpark=new Chart(el,{type:"line",
    data:{labels:last.map(function(t){return t.week;}),
      datasets:[{data:last.map(function(t){return t.prsMerged||0;}),
        borderColor:SERIES.prsMerged,borderWidth:2,tension:0.3,pointRadius:0,fill:false}]},
    options:{responsive:true,maintainAspectRatio:false,events:[],
      scales:{x:{display:false},y:{display:false}},
      plugins:{legend:{display:false},tooltip:{enabled:false}}}});
}
function getISOWeek(d){var date=new Date(d);date.setUTCDate(date.getUTCDate()+4-(date.getUTCDay()||7));var y=date.getUTCFullYear();var jan1=new Date(Date.UTC(y,0,1));var wn=Math.ceil(((date.getTime()-jan1.getTime())/86400000+1)/7);return y+"-W"+(wn<10?"0":"")+wn;}
function medianOf(arr){if(!arr.length)return 0;var s=arr.slice().sort(function(a,b){return a-b;});var m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;}
function percentileOf(arr,p){
  if(!arr.length)return 0;
  var s=arr.slice().sort(function(a,b){return a-b;});
  var clamped=Math.min(Math.max(p,0),1);
  var idx=(s.length-1)*clamped;
  var lo=Math.floor(idx),hi=Math.ceil(idx);
  if(lo===hi)return s[lo];
  var w=idx-lo;
  return s[lo]+(s[hi]-s[lo])*w;
}
function fmtDur(h){if(h<1)return Math.round(h*60)+"m";if(h<24)return h.toFixed(1)+"h";return(h/24).toFixed(1)+"d";}
function fmtWhole(n){return Math.round(n).toLocaleString("en-US");}
/**
 * Build Chart.js annotation plugin config with vertical lines at year
 * boundaries and centered year labels between them.
 * @param labels Array of ISO week labels ("YYYY-Www") currently displayed.
 * @returns annotation plugin options object (empty when <2 years spanned).
 */
function yearBoundaryAnnotations(labels){
  if(!labels||labels.length<2)return {};
  // Determine the set of distinct years present in the labels.
  var years=[];
  labels.forEach(function(lbl){
    var y=parseInt(lbl.slice(0,4),10);
    if(years.indexOf(y)===-1)years.push(y);
  });
  years.sort();
  if(years.length<2)return {};
  // For each year boundary, find the index of the first week of the new year.
  var annotations={};
  for(var i=1;i<years.length;i++){
    var yearStr=String(years[i]);
    var boundaryLabel=yearStr+"-W01";
    var idx=labels.indexOf(boundaryLabel);
    // If W01 is not in the data, find the first label that belongs to this year.
    if(idx===-1){
      for(var j=0;j<labels.length;j++){
        if(labels[j].slice(0,4)===yearStr){idx=j;break;}
      }
    }
    if(idx>0){
      annotations["yearLine"+i]={
        type:"line",
        xMin:idx-0.5,xMax:idx-0.5,
        borderColor:(VT&&VT.rule)||"#c3c2b7",
        borderWidth:1
      };
    }
  }
  // Add year label in the center of each year's range.
  for(var k=0;k<years.length;k++){
    var yStr=String(years[k]);
    var first=-1,last=-1;
    for(var m=0;m<labels.length;m++){
      if(labels[m].slice(0,4)===yStr){
        if(first===-1)first=m;
        last=m;
      }
    }
    if(first!==-1){
      var center=(first+last)/2;
      annotations["yearLabel"+k]={
        type:"label",
        xValue:center,
        yValue:0,
        yAdjust:-12,
        content:[yStr],
        color:(VT&&VT.muted)||"#898781",
        font:{size:11,weight:600},
        position:"start"
      };
    }
  }
  return {annotation:{annotations:annotations}};
}
function renderDeliveryCharts(){
  // Cycle time chart (single series -> no legend, 10% area fill)
  var prs=CHART_DATA.allPRDetails||[];
  if(prs.length>0){
    var weekCycleTimes={};
    prs.forEach(function(p){if(p.timeToMergeHours>0){var w=getISOWeek(p.mergedAt);if(!weekCycleTimes[w])weekCycleTimes[w]=[];weekCycleTimes[w].push(p.timeToMergeHours);}});
    var weeks=Object.keys(weekCycleTimes).sort();
    charts.cycleTime=new Chart(document.getElementById("chartCycleTime"),{type:"line",
      data:{labels:weeks,datasets:[
        lineDs("Median cycle time (hours)",weeks.map(function(w){return Math.round(medianOf(weekCycleTimes[w])*10)/10;}),VT.s1,true)]},
      options:lineOpts(false)});
  }
  // Actor breakdown chart (stacked weekly bars, entity colors)
  if(prs.length>0){
    var weekActors={};
    prs.forEach(function(p){
      var w=getISOWeek(p.mergedAt);
      if(!weekActors[w])weekActors[w]={human:0,copilot:0,dependabot:0,otherBot:0};
      if(p.isCopilotAuthored)weekActors[w].copilot++;
      else if(p.isBotAuthor&&p.author&&p.author.toLowerCase().indexOf("dependabot")!==-1)weekActors[w].dependabot++;
      else if(p.isBotAuthor)weekActors[w].otherBot++;
      else weekActors[w].human++;
    });
    var aWeeks=Object.keys(weekActors).sort();
    charts.actorBreakdown=new Chart(document.getElementById("chartActorBreakdown"),{type:"bar",
      data:{labels:aWeeks,datasets:[
        stackDs("Human",aWeeks.map(function(w){return weekActors[w].human;}),SERIES.human),
        stackDs("Copilot",aWeeks.map(function(w){return weekActors[w].copilot;}),SERIES.ai),
        stackDs("Dependabot",aWeeks.map(function(w){return weekActors[w].dependabot;}),SERIES.bot),
        stackDs("Other bots",aWeeks.map(function(w){return weekActors[w].otherBot;}),hexToRgba(SERIES.bot,0.55))]},
      options:{responsive:true,maintainAspectRatio:true,
        interaction:{mode:"index",intersect:false},
        scales:{x:{stacked:true,grid:{display:false},border:{color:VT.rule}},
          y:{stacked:true,beginAtZero:true,grid:{color:VT.grid},border:{color:VT.rule}}},
        plugins:{legend:{}}}});
  }
  // AI adoption: 100%-style horizontal split bar (AI share of merged PRs)
  var cop=CHART_DATA.copilot||{};
  if(cop.totalMerged>0){
    charts.copilotAdoption=new Chart(document.getElementById("chartCopilotAdoption"),{type:"bar",
      data:{labels:[""],datasets:splitBarDatasets([
        {label:"AI-authored",value:cop.authored,color:SERIES.ai},
        {label:"Human-authored",value:cop.totalMerged-cop.authored,color:SERIES.human}])},
      options:splitBarOpts(true,cop.totalMerged),plugins:[segLabelPlugin]});
  }
  // AI author breakdown: horizontal bar, one row per tool present
  var aiByType=cop.byType||{};
  var aiTotal=(aiByType.copilot||0)+(aiByType.claude||0)+(aiByType.codex||0);
  if(aiTotal>0){
    var toolDefs=[["copilot","Copilot",SERIES.ai],["claude","Claude",SERIES.claude],["codex","Codex",SERIES.codex]]
      .filter(function(t){return (aiByType[t[0]]||0)>0;});
    charts.aiAuthorBreakdown=new Chart(document.getElementById("chartAIAuthorBreakdown"),{type:"bar",
      data:{labels:toolDefs.map(function(t){return t[1];}),datasets:[
        {data:toolDefs.map(function(t){return aiByType[t[0]]||0;}),
          backgroundColor:toolDefs.map(function(t){return t[2];}),
          maxBarThickness:24,borderRadius:4,borderSkipped:"start"}]},
      options:{indexAxis:"y",responsive:true,maintainAspectRatio:true,aspectRatio:3,
        layout:{padding:{right:32}},
        scales:{x:{beginAtZero:true,grid:{display:false},border:{color:VT.rule}},
          y:{grid:{display:false},border:{color:VT.rule},ticks:{color:VT.ink2}}},
        plugins:{legend:{display:false}}},
      plugins:[barEndLabelPlugin]});
    charts.aiAuthorBreakdown.$tools=toolDefs.map(function(t){return t[0];});
  }
  // Issue lead time bars (single series -> no legend)
  var lts=CHART_DATA.allIssueLeadTimes||[];
  if(lts.length>0){
    var ltData=lts.map(function(lt){return{x:lt.prMergedAt.slice(0,10),y:Math.round(lt.leadTimeHours/24*10)/10};}).sort(function(a,b){return a.x<b.x?-1:1;});
    charts.leadTime=new Chart(document.getElementById("chartLeadTime"),{type:"bar",
      data:{labels:ltData.map(function(d){return d.x;}),datasets:[
        barDs("Lead time (days)",ltData.map(function(d){return d.y;}),SERIES.issuesClosed)]},
      options:{responsive:true,maintainAspectRatio:true,
        scales:{x:{grid:{display:false},border:{color:VT.rule},ticks:{maxTicksLimit:10,maxRotation:0,autoSkip:true}},
          y:{beginAtZero:true,title:{display:true,text:"Days"},grid:{color:VT.grid},border:{color:VT.rule}}},
        plugins:{legend:{display:false}}}});
  }
  // Copilot-authored PRs merged per week (single series -> no legend)
  var copPRs=CHART_DATA.allPRDetails||[];
  if(copPRs.length>0){
    var wCopPR={};
    copPRs.forEach(function(p){if(p.isCopilotAuthored){var w=getISOWeek(p.mergedAt);wCopPR[w]=(wCopPR[w]||0)+1;}});
    var copWeeks=Object.keys(wCopPR).sort();
    if(copWeeks.length>0){
      charts.copilotPRTrend=new Chart(document.getElementById("chartCopilotPRTrend"),{type:"line",
        data:{labels:copWeeks,datasets:[
          lineDs("Copilot-authored PRs merged",copWeeks.map(function(w){return wCopPR[w];}),SERIES.ai,false)]},
        options:lineOpts(false)});
    }
  }
  // Agent tasks by repo — horizontal stacked bar (30d window, static)
  var agentByRepo=(CHART_DATA.copilotAgent||{}).byRepo||{};
  var agentRepoNames=Object.keys(agentByRepo).filter(function(n){return agentByRepo[n].totalTasks>0;})
    .sort(function(a,b){return agentByRepo[b].totalTasks-agentByRepo[a].totalTasks;}).slice(0,15);
  if(agentRepoNames.length>0){
    charts.agentTasks=new Chart(document.getElementById("chartAgentTasks"),{type:"bar",
      data:{labels:agentRepoNames,datasets:[
        stackDs("Completed",agentRepoNames.map(function(n){return agentByRepo[n].completed||0;}),SERIES.completed),
        stackDs("Failed",agentRepoNames.map(function(n){return agentByRepo[n].failed||0;}),SERIES.failed),
        stackDs("Cancelled",agentRepoNames.map(function(n){return agentByRepo[n].cancelled||0;}),SERIES.cancelled),
        stackDs("Timed Out",agentRepoNames.map(function(n){return agentByRepo[n].timedOut||0;}),SERIES.timedOut),
        stackDs("Active",agentRepoNames.map(function(n){return agentByRepo[n].active||0;}),SERIES.active)]},
      options:{indexAxis:"y",responsive:true,maintainAspectRatio:true,
        scales:{x:{stacked:true,grid:{color:VT.grid},border:{color:VT.rule},beginAtZero:true},
          y:{stacked:true,grid:{display:false},border:{color:VT.rule}}},
        plugins:{legend:{}},
        onClick:function(e,elements){
          var repoName=null;
          if(elements.length>0){
            repoName=agentRepoNames[elements[0].index];
          } else if(e.native){
            var yAxis=e.chart.scales.y;
            var rect=e.chart.canvas.getBoundingClientRect();
            var cx=e.native.clientX-rect.left;
            var cy=e.native.clientY-rect.top;
            if(cx<yAxis.right){
              for(var i=0;i<agentRepoNames.length;i++){
                if(Math.abs(cy-yAxis.getPixelForTick(i))<15){repoName=agentRepoNames[i];break;}
              }
            }
          }
          if(repoName){window.open("https://github.com/"+(CHART_DATA.owner||"")+"/"+repoName+"/agents","_blank","noopener,noreferrer");}
        },
        onHover:function(e,elements){
          var cursor="default";
          if(elements.length>0){cursor="pointer";}
          else if(e.native){
            var yAxis=e.chart.scales.y;
            var rect=e.chart.canvas.getBoundingClientRect();
            var cx=e.native.clientX-rect.left;
            var cy=e.native.clientY-rect.top;
            if(cx<yAxis.right){
              for(var i=0;i<agentRepoNames.length;i++){
                if(Math.abs(cy-yAxis.getPixelForTick(i))<15){cursor="pointer";break;}
              }
            }
          }
          e.chart.canvas.style.cursor=cursor;}}});
  }
  // ── Copilot usage charts: stable named series in fixed categorical slots ──
  // Interactions -> s1, LOC added -> s2 wherever both appear, so entity colors
  // stay consistent across the feature/language/model charts.
  var usage=CHART_DATA.copilotUsage||null;
  var hBarOpts={indexAxis:"y",responsive:true,maintainAspectRatio:true,
    scales:{x:{beginAtZero:true,grid:{color:VT.grid},border:{color:VT.rule}},
      y:{grid:{display:false},border:{color:VT.rule}}},
    plugins:{legend:{}}};
  var usageFeatureCanvas=document.getElementById("chartCopilotUsageFeature");
  if(usage&&usageFeatureCanvas&&(usage.byFeature||[]).length>0){
    var features=(usage.byFeature||[]).slice(0,10);
    charts.copilotUsageFeature=new Chart(usageFeatureCanvas,{type:"bar",
      data:{labels:features.map(function(f){return f.name;}),datasets:[
        barDs("Interactions",features.map(function(f){return f.userInitiatedInteractions||0;}),VT.s1),
        barDs("LOC added",features.map(function(f){return f.locAdded||0;}),VT.s2)]},
      options:hBarOpts});
  }
  // Daily chart: single-axis (dual y-axes removed); DAU only, single series.
  var usageDailyCanvas=document.getElementById("chartCopilotUsageDaily");
  if(usage&&usageDailyCanvas&&(usage.dailyTotals||[]).length>0){
    var days=(usage.dailyTotals||[]).slice();
    charts.copilotUsageDaily=new Chart(usageDailyCanvas,{type:"line",
      data:{labels:days.map(function(d){return d.day;}),datasets:[
        lineDs("Daily active users",days.map(function(d){return d.dailyActiveUsers||0;}),VT.s1,true)]},
      options:lineOpts(false)});
  }
  var usageLanguageCanvas=document.getElementById("chartCopilotUsageLanguage");
  if(usage&&usageLanguageCanvas&&(usage.byLanguage||[]).length>0){
    var langs=(usage.byLanguage||[]).slice(0,10);
    charts.copilotUsageLanguage=new Chart(usageLanguageCanvas,{type:"bar",
      data:{labels:langs.map(function(r){return r.name;}),datasets:[
        barDs("Interactions",langs.map(function(r){return r.userInitiatedInteractions||0;}),VT.s1),
        barDs("LOC added",langs.map(function(r){return r.locAdded||0;}),VT.s2)]},
      options:hBarOpts});
  }
  var usageModelCanvas=document.getElementById("chartCopilotUsageModel");
  if(usage&&usageModelCanvas&&(usage.byModel||[]).length>0){
    var models=(usage.byModel||[]).slice(0,10);
    charts.copilotUsageModel=new Chart(usageModelCanvas,{type:"bar",
      data:{labels:models.map(function(r){return r.name;}),datasets:[
        barDs("Interactions",models.map(function(r){return r.userInitiatedInteractions||0;}),VT.s1),
        barDs("LOC added",models.map(function(r){return r.locAdded||0;}),VT.s2)]},
      options:hBarOpts});
  }
  var usageCliCanvas=document.getElementById("chartCopilotUsageCli");
  if(usage&&usageCliCanvas&&(usage.dailyTotals||[]).length>0){
    var cliDays=(usage.dailyTotals||[]).filter(function(d){return d.cli&&((d.cli.requestCount||0)>0||(d.cli.sessionCount||0)>0);});
    if(cliDays.length>0){charts.copilotUsageCli=new Chart(usageCliCanvas,{type:"line",
      data:{labels:cliDays.map(function(d){return d.day;}),datasets:[
        lineDs("Requests",cliDays.map(function(d){return d.cli.requestCount||0;}),VT.s1,true),
        lineDs("Sessions",cliDays.map(function(d){return d.cli.sessionCount||0;}),VT.s2,false)]},
      options:lineOpts(true)});}
  }
  var reviewCanvas=document.getElementById("chartCopilotCodeReview");
  if(usage&&reviewCanvas&&(usage.dailyTotals||[]).length>0){
    var reviewDays=(usage.dailyTotals||[]).filter(function(d){return d.codeReview&&((d.codeReview.dailyActiveUsers||0)>0||(d.codeReview.dailyPassiveUsers||0)>0);});
    if(reviewDays.length>0){charts.copilotCodeReview=new Chart(reviewCanvas,{type:"line",
      data:{labels:reviewDays.map(function(d){return d.day;}),datasets:[
        lineDs("Active",reviewDays.map(function(d){return d.codeReview.dailyActiveUsers||0;}),VT.s1,true),
        lineDs("Passive",reviewDays.map(function(d){return d.codeReview.dailyPassiveUsers||0;}),VT.s2,false)]},
      options:lineOpts(true)});}
  }
  var prActivityCanvas=document.getElementById("chartCopilotPrActivity");
  if(usage&&prActivityCanvas&&(usage.dailyTotals||[]).length>0){
    var prDays=(usage.dailyTotals||[]).filter(function(d){var p=d.pullRequests||{};return (p.totalCreated||0)>0||(p.totalReviewed||0)>0||(p.totalMerged||0)>0;});
    if(prDays.length>0){charts.copilotPrActivity=new Chart(prActivityCanvas,{type:"bar",
      data:{labels:prDays.map(function(d){return d.day;}),datasets:[
        barDs("Created",prDays.map(function(d){return d.pullRequests.totalCreated||0;}),VT.s1),
        barDs("Reviewed",prDays.map(function(d){return d.pullRequests.totalReviewed||0;}),VT.s2),
        barDs("Merged",prDays.map(function(d){return d.pullRequests.totalMerged||0;}),VT.s3),
        barDs("Created by Copilot",prDays.map(function(d){return d.pullRequests.totalCreatedByCopilot||0;}),VT.s4)]},
      options:{responsive:true,maintainAspectRatio:true,
        interaction:{mode:"index",intersect:false},
        scales:{x:{stacked:false,grid:{display:false},border:{color:VT.rule}},
          y:{beginAtZero:true,grid:{color:VT.grid},border:{color:VT.rule}}},
        plugins:{legend:{}}}});}
  }
}
function setupFilter(){
  document.querySelectorAll(".filter-btn").forEach(function(btn){
    btn.addEventListener("click",function(){
      document.querySelectorAll(".filter-btn").forEach(function(b){b.classList.remove("active");});
      btn.classList.add("active");
      applyFilter(btn.dataset.period);
    });
  });
  var botCb=document.getElementById("excludeBots");
  if(botCb){botCb.addEventListener("change",function(){
    var activeBtn=document.querySelector(".filter-btn.active");
    applyFilter(activeBtn?activeBtn.dataset.period:"30days");
  });}
}
// ── Repo filter helpers ──
function getRepoFilteredPRDetails(){
  var all=CHART_DATA.allPRDetails||[];
  if(selectedRepos.size===0)return all;
  return all.filter(function(p){return selectedRepos.has(p.repo);});
}
function getRepoFilteredIssueLeadTimes(){
  var all=CHART_DATA.allIssueLeadTimes||[];
  if(selectedRepos.size===0)return all;
  return all.filter(function(p){return selectedRepos.has(p.repo);});
}
function isRepoFilterActive(){
  var total=(CHART_DATA.repoNames||[]).length;
  return selectedRepos.size>0&&selectedRepos.size<total;
}
// Compute weekly PR/size trends from per-PR data (for repo-filtered view).
// Uses org-level week labels as a baseline so charts keep a consistent x-axis.
// prsOpened is NOT computed here (allPRDetails only contains merged PRs).
// Issue counts are always zero — issue trend data is org-wide only.
function computeTrendsFromPRDetails(prs){
  var weekData={};
  (CHART_DATA.weeklyTrends||[]).forEach(function(t){
    weekData[t.week]={week:t.week,prsOpened:0,prsMerged:0,issuesOpened:0,issuesClosed:0,linesAdded:0,linesDeleted:0};
  });
  prs.forEach(function(p){
    var wm=getISOWeek(p.mergedAt);
    if(!weekData[wm])weekData[wm]={week:wm,prsOpened:0,prsMerged:0,issuesOpened:0,issuesClosed:0,linesAdded:0,linesDeleted:0};
    weekData[wm].prsMerged++;
    weekData[wm].linesAdded+=(p.linesAdded||0);
    weekData[wm].linesDeleted+=(p.linesDeleted||0);
  });
  return Object.keys(weekData).map(function(k){return weekData[k];}).sort(function(a,b){return a.week<b.week?-1:1;});
}
// Aggregate PR trends from per-repo data for the selected repos.
// Uses org-level week labels as a baseline for a consistent x-axis.
// prsOpened reflects opened+closed/merged PRs within the window (open-only PRs may be undercounted).
function computePRTrendsForRepos(repoNames){
  var rwt=CHART_DATA.repoWeeklyTrends||{};
  var weekData={};
  (CHART_DATA.weeklyTrends||[]).forEach(function(t){
    weekData[t.week]={week:t.week,prsOpened:0,prsMerged:0,issuesOpened:0,issuesClosed:0,linesAdded:0,linesDeleted:0};
  });
  repoNames.forEach(function(name){
    (rwt[name]||[]).forEach(function(t){
      if(!weekData[t.week])weekData[t.week]={week:t.week,prsOpened:0,prsMerged:0,issuesOpened:0,issuesClosed:0,linesAdded:0,linesDeleted:0};
      weekData[t.week].prsOpened+=(t.prsOpened||0);
      weekData[t.week].prsMerged+=(t.prsMerged||0);
      weekData[t.week].linesAdded+=(t.linesAdded||0);
      weekData[t.week].linesDeleted+=(t.linesDeleted||0);
    });
  });
  return Object.keys(weekData).map(function(k){return weekData[k];}).sort(function(a,b){return a.week<b.week?-1:1;});
}
// Aggregate issue trends from per-repo data for the selected repos.
// Uses org-level week labels as a baseline for a consistent x-axis.
function computeIssueTrendsForRepos(repoNames){
  var rwt=CHART_DATA.repoWeeklyTrends||{};
  var weekData={};
  (CHART_DATA.weeklyTrends||[]).forEach(function(t){
    weekData[t.week]={week:t.week,issuesOpened:0,issuesClosed:0};
  });
  repoNames.forEach(function(name){
    (rwt[name]||[]).forEach(function(t){
      if(!weekData[t.week])weekData[t.week]={week:t.week,issuesOpened:0,issuesClosed:0};
      weekData[t.week].issuesOpened+=(t.issuesOpened||0);
      weekData[t.week].issuesClosed+=(t.issuesClosed||0);
    });
  });
  return Object.keys(weekData).map(function(k){return weekData[k];}).sort(function(a,b){return a.week<b.week?-1:1;});
}
function setupRepoPicker(){
  var names=CHART_DATA.repoNames||[];
  if(names.length===0)return;
  var panel=document.getElementById("repoPickerPanel");
  var list=document.getElementById("repoPickerList");
  var btn=document.getElementById("repoPickerBtn");
  var lbl=document.getElementById("repoPickerLabel");
  var searchInput=document.getElementById("repoPickerSearch");
  if(!panel||!list||!btn)return;
  names.forEach(function(name){
    var item=document.createElement("label");
    item.className="repo-picker-item";
    item.dataset.name=name.toLowerCase();
    var cb=document.createElement("input");
    cb.type="checkbox";
    cb.value=name;
    cb.addEventListener("change",function(){
      if(cb.checked)selectedRepos.add(name);
      else selectedRepos.delete(name);
      updatePickerLabel();
      triggerRepoFilter();
    });
    var txt=document.createTextNode("\u00a0"+name);
    item.appendChild(cb);
    item.appendChild(txt);
    list.appendChild(item);
  });
  btn.addEventListener("click",function(e){
    e.stopPropagation();
    var open=!panel.hidden;
    panel.hidden=open;
    btn.setAttribute("aria-expanded",String(!open));
    if(!open&&searchInput){setTimeout(function(){searchInput.focus();},0);}
  });
  document.addEventListener("click",function(e){
    var picker=document.getElementById("repoPicker");
    if(picker&&!picker.contains(e.target)){panel.hidden=true;btn.setAttribute("aria-expanded","false");}
  });
  var resetBtn=document.getElementById("repoPickerReset");
  var clearBtn=document.getElementById("repoPickerClear");
  if(resetBtn)resetBtn.addEventListener("click",function(){
    selectedRepos=new Set();
    list.querySelectorAll("input[type=checkbox]").forEach(function(cb){cb.checked=false;});
    if(searchInput){searchInput.value="";list.querySelectorAll(".repo-picker-item").forEach(function(it){it.style.display="";});}
    updatePickerLabel();
    triggerRepoFilter();
  });
  if(clearBtn)clearBtn.addEventListener("click",function(){
    list.querySelectorAll("input[type=checkbox]:checked").forEach(function(cb){cb.checked=false;selectedRepos.delete(cb.value);});
    updatePickerLabel();
    triggerRepoFilter();
  });
  if(searchInput)searchInput.addEventListener("input",function(){
    var q=searchInput.value.toLowerCase();
    list.querySelectorAll(".repo-picker-item").forEach(function(item){
      item.style.display=(!q||item.dataset.name.indexOf(q)!==-1)?"":"none";
    });
  });
  function updatePickerLabel(){
    if(!lbl)return;
    var active=isRepoFilterActive();
    if(active){lbl.textContent=selectedRepos.size+" repo"+(selectedRepos.size===1?"":"s");}
    else{lbl.textContent="All repos";}
    btn.classList.toggle("active",active);
  }
  function triggerRepoFilter(){
    var activeBtn=document.querySelector(".filter-btn.active");
    applyFilter(activeBtn?activeBtn.dataset.period:"30days");
  }
}
function setupCopilotUsageControls(){
  var tbody=document.getElementById("copilotUsageRows");
  if(!tbody)return;
  var rows=Array.from(tbody.querySelectorAll("tr.usage-row"));
  if(rows.length===0)return;
  var search=document.getElementById("copilotUsageSearch");
  var surface=document.getElementById("copilotUsageSurface");
  var sort=document.getElementById("copilotUsageSort");
  var shown=document.getElementById("copilotUsageShown");
  var currentSort=sort?sort.value:"interactions";
  function numeric(row,key){return Number(row.dataset[key]||0);}
  function compareUsageRows(a,b,key){
    if(key==="login")return (a.dataset.login||"").localeCompare(b.dataset.login||"",undefined,{sensitivity:"base"});
    if(key==="lastActivity")return (b.dataset.lastActivity||"").localeCompare(a.dataset.lastActivity||"");
    return numeric(b,key)-numeric(a,key);
  }
  function updateHeaderState(){
    document.querySelectorAll(".usage-th-sortable").forEach(function(th){
      var active=th.dataset.usageSort===currentSort;
      th.classList.toggle("sort-active",active);
      th.setAttribute("aria-sort",active?(currentSort==="login"?"ascending":"descending"):"none");
      var ind=th.querySelector(".sort-ind");
      if(ind)ind.textContent=active?(currentSort==="login"?"^":"v"):"";
    });
  }
  function applyUsageControls(){
    var q=search?search.value.toLowerCase().trim():"";
    var surfaceValue=surface?surface.value:"";
    var visible=0;
    rows.sort(function(a,b){return compareUsageRows(a,b,currentSort);});
    rows.forEach(function(row){
      var matchesText=!q||(row.dataset.search||"").indexOf(q)!==-1;
      var matchesSurface=!surfaceValue||(" "+(row.dataset.surface||"")+" ").indexOf(" "+surfaceValue+" ")!==-1;
      var show=matchesText&&matchesSurface;
      row.style.display=show?"":"none";
      if(show)visible++;
      tbody.appendChild(row);
    });
    if(shown)shown.textContent=String(visible);
    updateHeaderState();
  }
  if(search)search.addEventListener("input",applyUsageControls);
  if(surface)surface.addEventListener("change",applyUsageControls);
  if(sort)sort.addEventListener("change",function(){currentSort=sort.value;applyUsageControls();});
  document.querySelectorAll(".usage-th-sortable").forEach(function(th){
    th.addEventListener("click",function(){
      currentSort=th.dataset.usageSort||"interactions";
      if(sort)sort.value=currentSort;
      applyUsageControls();
    });
  });
  applyUsageControls();
}
function setupLeaderboardControls(){
  var tbody=document.getElementById("intelLeaderboardRows");
  if(!tbody)return;
  var rows=Array.from(tbody.querySelectorAll("tr.intel-row"));
  if(rows.length===0)return;
  var currentSort="merged";
  function numeric(row,key){return Number(row.dataset[key]||0);}
  function compareRows(a,b,key){
    if(key==="login")return (a.dataset.login||"").localeCompare(b.dataset.login||"",undefined,{sensitivity:"base"});
    return numeric(b,key)-numeric(a,key)||(a.dataset.login||"").localeCompare(b.dataset.login||"");
  }
  function updateHeaderState(){
    document.querySelectorAll(".intel-th-sortable").forEach(function(th){
      var active=th.dataset.intelSort===currentSort;
      th.classList.toggle("sort-active",active);
      th.setAttribute("aria-sort",active?(currentSort==="login"?"ascending":"descending"):"none");
      var ind=th.querySelector(".sort-ind");
      if(ind)ind.textContent=active?(currentSort==="login"?"^":"v"):"";
    });
  }
  function applySort(){
    rows.sort(function(a,b){return compareRows(a,b,currentSort);});
    rows.forEach(function(row){tbody.appendChild(row);});
    updateHeaderState();
  }
  document.querySelectorAll(".intel-th-sortable").forEach(function(th){
    th.addEventListener("click",function(){
      currentSort=th.dataset.intelSort||"merged";
      applySort();
    });
  });
  applySort();
}
// Health table sorting; rows whose component has no data sink to the bottom.
function setupHealthControls(){
  var tbody=document.getElementById("healthRows");
  if(!tbody)return;
  var rows=Array.from(tbody.querySelectorAll("tr.health-row"));
  if(rows.length===0)return;
  var currentSort="score";
  var currentDirection="descending";
  function compareRows(a,b,key){
    var av=a.dataset[key],bv=b.dataset[key];
    var aMissing=av===undefined||av==="",bMissing=bv===undefined||bv==="";
    if(aMissing!==bMissing)return aMissing?1:-1;
    var result;
    if(key==="name"||key==="grade")result=(av||"").localeCompare(bv||"",undefined,{sensitivity:"base"});
    else result=Number(av)-Number(bv);
    if(currentDirection==="descending")result=-result;
    return result||(a.dataset.name||"").localeCompare(b.dataset.name||"");
  }
  function updateHeaderState(){
    document.querySelectorAll(".health-th-sortable").forEach(function(th){
      var active=th.dataset.healthSort===currentSort;
      th.classList.toggle("sort-active",active);
      th.setAttribute("aria-sort",active?currentDirection:"none");
      var ind=th.querySelector(".sort-ind");
      if(ind)ind.textContent=active?(currentDirection==="ascending"?"^":"v"):"";
    });
  }
  function applySort(){
    rows.sort(function(a,b){return compareRows(a,b,currentSort);});
    rows.forEach(function(row){tbody.appendChild(row);});
    updateHeaderState();
  }
  document.querySelectorAll(".health-th-sortable").forEach(function(th){
    th.addEventListener("click",function(){
      var nextSort=th.dataset.healthSort||"score";
      if(nextSort===currentSort)currentDirection=currentDirection==="ascending"?"descending":"ascending";
      else{
        currentSort=nextSort;
        currentDirection=nextSort==="name"||nextSort==="grade"?"ascending":"descending";
      }
      applySort();
    });
  });
  applySort();
}
function getCutoffDate(period){
  var collected=new Date(CHART_DATA.collectedAt);
  var d;
  if(period==="year")return new Date(Date.UTC(collected.getUTCFullYear(),0,1));
  d=new Date(collected);
  if(period==="90days"){d.setUTCDate(d.getUTCDate()-90);return d;}
  if(period==="30days"){d.setUTCDate(d.getUTCDate()-30);return d;}
  return null;
}
function weekToDate(weekStr){
  var parts=weekStr.split("-W");
  var year=parseInt(parts[0],10);var week=parseInt(parts[1],10);
  var jan4=new Date(Date.UTC(year,0,4));
  var dow=jan4.getUTCDay()||7;
  var mon=new Date(jan4);
  mon.setUTCDate(jan4.getUTCDate()-dow+1+(week-1)*7);
  return mon;
}
function applyFilter(period){
  var cutoff=getCutoffDate(period);
  var excludeBots=!!document.getElementById("excludeBots")&&document.getElementById("excludeBots").checked;
  var repoFiltered=isRepoFilterActive();

  // ── Repo-filtered PR base (no period/bot filter yet) ──
  var allPRBase=getRepoFilteredPRDetails();

  // ── Trends ──
  // PR/size trends are recomputed from allPRBase when a repo filter is active.
  // Issue trends use per-repo data when available for ALL selected repos;
  // otherwise fall back to org-wide data.
  var orgTrends=CHART_DATA.weeklyTrends||[];
  var rwt=CHART_DATA.repoWeeklyTrends||{};
  var selRepoArr=repoFiltered?Array.from(selectedRepos):[];
  var allSelectedHaveRepoTrends=repoFiltered&&selRepoArr.length>0&&selRepoArr.every(function(n){return!!rwt[n];});
  var prTrends=allSelectedHaveRepoTrends?computePRTrendsForRepos(selRepoArr):(repoFiltered?computeTrendsFromPRDetails(allPRBase):orgTrends);
  var prTrendsPeriod=cutoff?prTrends.filter(function(t){return weekToDate(t.week)>=cutoff;}):prTrends;
  var issueTrends=allSelectedHaveRepoTrends?computeIssueTrendsForRepos(selRepoArr):orgTrends;
  var issueTrendsPeriod=cutoff?issueTrends.filter(function(t){return weekToDate(t.week)>=cutoff;}):issueTrends;

  // PR trends: hide "Opened" only when repo-filtered without per-repo trend data
  if(charts.prTrends){
    var prTrendLabels=prTrendsPeriod.map(function(t){return t.week;});
    charts.prTrends.data.labels=prTrendLabels;
    charts.prTrends.data.datasets[0].data=prTrendsPeriod.map(function(t){return t.prsOpened;});
    charts.prTrends.data.datasets[1].data=prTrendsPeriod.map(function(t){return t.prsMerged;});
    charts.prTrends.options.plugins.annotation=(yearBoundaryAnnotations(prTrendLabels).annotation||{annotations:{}});
    charts.prTrends.setDatasetVisibility(0,!repoFiltered||allSelectedHaveRepoTrends);
    charts.prTrends.update();
  }
  if(charts.issueTrends){
    var issueTrendLabels=issueTrendsPeriod.map(function(t){return t.week;});
    charts.issueTrends.data.labels=issueTrendLabels;
    charts.issueTrends.data.datasets[0].data=issueTrendsPeriod.map(function(t){return t.issuesOpened;});
    charts.issueTrends.data.datasets[1].data=issueTrendsPeriod.map(function(t){return t.issuesClosed;});
    charts.issueTrends.options.plugins.annotation=(yearBoundaryAnnotations(issueTrendLabels).annotation||{annotations:{}});
    charts.issueTrends.update();
  }
  if(charts.prSizeTrends){
    var prSizeTrendLabels=prTrendsPeriod.map(function(t){return t.week;});
    charts.prSizeTrends.data.labels=prSizeTrendLabels;
    charts.prSizeTrends.data.datasets[0].data=prTrendsPeriod.map(function(t){return t.linesAdded;});
    charts.prSizeTrends.data.datasets[1].data=prTrendsPeriod.map(function(t){return t.linesDeleted;});
    charts.prSizeTrends.options.plugins.annotation=(yearBoundaryAnnotations(prSizeTrendLabels).annotation||{annotations:{}});
    charts.prSizeTrends.update();
  }

  // ── Apply period + bot filter to repo-filtered PR base ──
  var allPR=allPRBase;
  if(excludeBots)allPR=allPR.filter(function(p){return !p.isBotAuthor;});
  var filteredPR=cutoff?allPR.filter(function(p){return new Date(p.mergedAt)>=cutoff;}):allPR;
  var filteredLT=getRepoFilteredIssueLeadTimes();
  if(cutoff)filteredLT=filteredLT.filter(function(lt){return new Date(lt.prMergedAt)>=cutoff;});

  // ── Top repos chart ──
  if(charts.repos){
    var titleEl=document.getElementById("chartReposTitle");
    if(repoFiltered){
      // Show only selected repos; all-time issue totals from repoSummaries
      var selArr=Array.from(selectedRepos);
      var selData=selArr.map(function(n){
        var rs=(CHART_DATA.repoSummaries||[]).find(function(r){return r.name===n;})||{issues:0,prs:0};
        var prCnt=0;filteredPR.forEach(function(p){if(p.repo===n)prCnt++;});
        return{name:n,issues:rs.issues,prs:prCnt};
      }).sort(function(a,b){return b.issues+b.prs-(a.issues+a.prs);}).slice(0,15);
      charts.repos.data.labels=selData.map(function(r){return r.name;});
      charts.repos.data.datasets=reposDatasets(selData);
      var pLabel=period==="all"?"All Time":period==="year"?"This Year":period==="90days"?"Last 90 Days":"Last 30 Days";
      if(titleEl)titleEl.textContent="Selected Repositories \u2014 "+pLabel;
    }else if(period==="all"){
      charts.repos.data.labels=CHART_DATA.topRepos.map(function(r){return r.name;});
      charts.repos.data.datasets=reposDatasets(CHART_DATA.topRepos);
      if(titleEl)titleEl.textContent="Top Repositories";
    }else{
      var counts={};
      filteredPR.forEach(function(p){counts[p.repo]=(counts[p.repo]||0)+1;});
      var topFiltered=Object.keys(counts).map(function(n){
        var rd=CHART_DATA.topRepos.find(function(r){return r.name===n;});
        return{name:n,prs:counts[n],issues:rd?rd.issues:0};
      }).sort(function(a,b){return b.prs-a.prs;}).slice(0,15);
      charts.repos.data.labels=topFiltered.map(function(r){return r.name;});
      charts.repos.data.datasets=reposDatasets(topFiltered);
      var periodLabel=period==="year"?"This Year":period==="90days"?"Last 90 Days":"Last 30 Days";
      if(titleEl)titleEl.textContent="Top Repositories \u2014 "+periodLabel;
    }
    reposVisibility.forEach(function(vis,i){
      if(i<charts.repos.data.datasets.length)charts.repos.setDatasetVisibility(i,vis);
    });
    charts.repos.update();
  }

  // ── Period sums from trends ──
  // Issue counts use per-repo data when available; prsOpened from PR trends (0 when repo-filtered)
  var issuesOpened=0,issuesClosed=0,prsOpened=0;
  issueTrendsPeriod.forEach(function(t){issuesOpened+=(t.issuesOpened||0);issuesClosed+=(t.issuesClosed||0);});
  prTrendsPeriod.forEach(function(t){prsOpened+=(t.prsOpened||0);});
  var prsMerged=filteredPR.length;

  // ── Issues / PRs split bars (entity-bound colors) ──
  if(charts.issues){
    if(period==="all"&&!repoFiltered){
      updateSplitBar(charts.issues,[
        {label:"Open",value:CHART_DATA.issues.open,color:SERIES.issuesOpened},
        {label:"Closed",value:CHART_DATA.issues.closed,color:SERIES.issuesClosed}]);
    }else{
      updateSplitBar(charts.issues,[
        {label:"Opened",value:issuesOpened,color:SERIES.issuesOpened},
        {label:"Closed",value:issuesClosed,color:SERIES.issuesClosed}]);
    }
  }
  if(charts.prs){
    if(period==="all"&&!repoFiltered){
      updateSplitBar(charts.prs,[
        {label:"Open",value:CHART_DATA.prs.open,color:SERIES.prsOpened},
        {label:"Merged",value:CHART_DATA.prs.merged,color:SERIES.prsMerged},
        {label:"Closed",value:CHART_DATA.prs.closed,color:VT.muted}]);
    }else if(repoFiltered){
      // Show selected repos' merged PRs as a share of total org merged PRs
      var orgMerged=CHART_DATA.prs.merged;
      updateSplitBar(charts.prs,[
        {label:"Selected repos (merged)",value:prsMerged,color:SERIES.prsMerged},
        {label:"Other repos",value:Math.max(0,orgMerged-prsMerged),color:VT.muted}]);
    }else{
      updateSplitBar(charts.prs,[
        {label:"Opened",value:prsOpened,color:SERIES.prsOpened},
        {label:"Merged",value:prsMerged,color:SERIES.prsMerged}]);
    }
  }

  // ── KPIs ──
  var issueVal=document.getElementById("kpiIssueVal");
  var issueLbl=document.getElementById("kpiIssueLbl");
  var issueSub=document.getElementById("kpiIssueSub");
  var prVal=document.getElementById("kpiPRVal");
  var prLbl=document.getElementById("kpiPRLbl");
  var prSub=document.getElementById("kpiPRSub");
  if(period==="all"&&!repoFiltered){
    if(issueVal)issueVal.textContent=String(CHART_DATA.issues.open);
    if(issueLbl)issueLbl.textContent="Open Issues";
    if(issueSub)issueSub.textContent=CHART_DATA.issues.closed+" closed";
    if(prVal)prVal.textContent=String(CHART_DATA.prs.merged);
    if(prLbl)prLbl.textContent="Merged PRs";
    if(prSub)prSub.textContent=CHART_DATA.prs.open+" open \u00B7 "+CHART_DATA.prs.closed+" closed";
  }else{
    if(issueVal)issueVal.textContent=String(issuesOpened);
    if(issueLbl)issueLbl.textContent="Issues Opened"+(repoFiltered&&!allSelectedHaveRepoTrends?" (org-wide)":"");
    if(issueSub)issueSub.textContent=issuesClosed+" closed";
    if(prVal)prVal.textContent=String(prsMerged);
    if(prLbl)prLbl.textContent="Merged PRs";
    // prsOpened is unavailable per repo only when no per-repo trend data exists
    if(prSub)prSub.textContent=(repoFiltered&&!allSelectedHaveRepoTrends)?"":prsOpened+" opened";
  }

  // ── Copilot adoption ──
  // When repo-filtered: recompute authored % from the repo-filtered all-time PRs.
  // "Reviewed" count is not available per repo; shown only for unfiltered view.
  var cop;
  if(repoFiltered){
    var copAuthored=allPRBase.filter(function(p){return p.isCopilotAuthored;}).length;
    var btCopilot=allPRBase.filter(function(p){return p.aiAuthorType==='copilot';}).length;
    var btClaude=allPRBase.filter(function(p){return p.aiAuthorType==='claude';}).length;
    var btCodex=allPRBase.filter(function(p){return p.aiAuthorType==='codex';}).length;
    cop={authored:copAuthored,totalMerged:allPRBase.length,reviewed:null,byType:{copilot:btCopilot,claude:btClaude,codex:btCodex}};
  }else{
    cop=CHART_DATA.copilot||{};
  }
  var copilotVal=document.getElementById("kpiCopilotVal");
  var copilotSub=document.getElementById("kpiCopilotSub");
  if(copilotVal){copilotVal.textContent=cop.totalMerged>0?(cop.authored/cop.totalMerged*100).toFixed(1)+"%":"\u2013";}
  if(copilotSub){
    if(repoFiltered)copilotSub.textContent=(cop.authored||0)+" AI-authored";
    else copilotSub.textContent=(cop.authored||0)+" AI-authored \u00B7 "+(cop.reviewed||0)+" reviewed";
  }
  if(charts.copilotAdoption&&cop.totalMerged>0){
    updateSplitBar(charts.copilotAdoption,[
      {label:"AI-authored",value:cop.authored,color:SERIES.ai},
      {label:"Human-authored",value:cop.totalMerged-cop.authored,color:SERIES.human}]);
  }
  if(charts.aiAuthorBreakdown){
    var bt2=cop.byType||{};
    var toolKeys=charts.aiAuthorBreakdown.$tools||["copilot","claude","codex"];
    charts.aiAuthorBreakdown.data.datasets[0].data=toolKeys.map(function(k){return bt2[k]||0;});
    charts.aiAuthorBreakdown.update();
  }

  // ── Cycle time KPI ──
  var cycleVals=filteredPR.map(function(p){return p.timeToMergeHours;}).filter(function(h){return h>0;});
  var medCycle=medianOf(cycleVals);
  var cycleVal=document.getElementById("kpiCycleVal");
  if(cycleVal){cycleVal.textContent=medCycle>0?fmtDur(medCycle):"\u2013";}

  // ── Developer insights cards ──
  var activeWeeks=prTrendsPeriod.filter(function(t){return (t.prsOpened||0)>0||(t.prsMerged||0)>0;}).length;
  var velocity=activeWeeks>0?prsMerged/activeWeeks:0;
  var prFlow=prsOpened>0?prsMerged/prsOpened:0;
  var issueFlow=issuesOpened>0?issuesClosed/issuesOpened:0;
  var cycleP75=percentileOf(cycleVals,0.75);
  var cyclePredictability=(medCycle>0&&cycleP75>0)?(cycleP75/medCycle):0;
  var leadDaysMedian=medianOf(filteredLT.map(function(lt){return lt.leadTimeHours/24;}).filter(function(days){return days>0;}));
  var prSizeMedian=medianOf(filteredPR
    .map(function(p){return (p.linesAdded||0)+(p.linesDeleted||0);})
    .filter(function(size){return size>0;}));

  var insightVelocity=document.getElementById("insightVelocityVal");
  var insightPrFlow=document.getElementById("insightPrFlowVal");
  var insightIssueFlow=document.getElementById("insightIssueFlowVal");
  var insightCyclePredict=document.getElementById("insightCyclePredictabilityVal");
  var insightLeadTime=document.getElementById("insightLeadTimeVal");
  var insightPrSize=document.getElementById("insightPrSizeVal");
  if(insightVelocity)insightVelocity.textContent=velocity>0?velocity.toFixed(1):"\u2013";
  if(insightPrFlow)insightPrFlow.textContent=prFlow>0?(prFlow*100).toFixed(1)+"%":"\u2013";
  if(insightIssueFlow)insightIssueFlow.textContent=issueFlow>0?(issueFlow*100).toFixed(1)+"%":"\u2013";
  if(insightCyclePredict)insightCyclePredict.textContent=cyclePredictability>0?cyclePredictability.toFixed(2)+"x":"\u2013";
  if(insightLeadTime)insightLeadTime.textContent=leadDaysMedian>0?leadDaysMedian.toFixed(1)+"d":"\u2013";
  if(insightPrSize)insightPrSize.textContent=prSizeMedian>0?fmtWhole(prSizeMedian):"\u2013";

  // ── Delivery charts ──
  if(charts.cycleTime){
    var weekCT={};
    filteredPR.forEach(function(p){if(p.timeToMergeHours>0){var w=getISOWeek(p.mergedAt);if(!weekCT[w])weekCT[w]=[];weekCT[w].push(p.timeToMergeHours);}});
    var ctWeeks=Object.keys(weekCT).sort();
    charts.cycleTime.data.labels=ctWeeks;
    charts.cycleTime.data.datasets[0].data=ctWeeks.map(function(w){return Math.round(medianOf(weekCT[w])*10)/10;});
    charts.cycleTime.options.plugins.annotation=(yearBoundaryAnnotations(ctWeeks).annotation||{annotations:{}});
    charts.cycleTime.update();
  }
  if(charts.actorBreakdown){
    var wA={};
    filteredPR.forEach(function(p){
      var w=getISOWeek(p.mergedAt);
      if(!wA[w])wA[w]={human:0,copilot:0,dependabot:0,otherBot:0};
      if(p.isCopilotAuthored)wA[w].copilot++;
      else if(p.isBotAuthor&&p.author&&p.author.toLowerCase().indexOf("dependabot")!==-1)wA[w].dependabot++;
      else if(p.isBotAuthor)wA[w].otherBot++;
      else wA[w].human++;
    });
    var aW=Object.keys(wA).sort();
    charts.actorBreakdown.data.labels=aW;
    charts.actorBreakdown.data.datasets[0].data=aW.map(function(w){return wA[w].human;});
    charts.actorBreakdown.data.datasets[1].data=aW.map(function(w){return wA[w].copilot;});
    charts.actorBreakdown.data.datasets[2].data=aW.map(function(w){return wA[w].dependabot;});
    charts.actorBreakdown.data.datasets[3].data=aW.map(function(w){return wA[w].otherBot;});
    charts.actorBreakdown.options.plugins.annotation=(yearBoundaryAnnotations(aW).annotation||{annotations:{}});
    charts.actorBreakdown.update();
  }

  // ── Copilot PR trend chart ──
  if(charts.copilotPRTrend){
    var wCopPR2={};
    filteredPR.forEach(function(p){if(p.isCopilotAuthored){var w=getISOWeek(p.mergedAt);wCopPR2[w]=(wCopPR2[w]||0)+1;}});
    var copWeeks2=Object.keys(wCopPR2).sort();
    charts.copilotPRTrend.data.labels=copWeeks2;
    charts.copilotPRTrend.data.datasets[0].data=copWeeks2.map(function(w){return wCopPR2[w];});
    charts.copilotPRTrend.options.plugins.annotation=(yearBoundaryAnnotations(copWeeks2).annotation||{annotations:{}});
    charts.copilotPRTrend.update();
  }

  // ── Agent tasks KPI (responds to repo filter; not period-filtered) ──
  var agentVal=document.getElementById("kpiAgentVal");
  var agentSub=document.getElementById("kpiAgentSub");
  var agentCopilotData=CHART_DATA.copilotAgent||{};
  if(repoFiltered){
    var selAgentTasks=0,selAgentCompleted=0,selAgentPRs=0;
    var aByRepo=agentCopilotData.byRepo||{};
    Array.from(selectedRepos).forEach(function(name){
      var rd=aByRepo[name];
      if(rd){selAgentTasks+=rd.totalTasks;selAgentCompleted+=rd.completed;selAgentPRs+=rd.agentPRs;}
    });
    if(agentVal)agentVal.textContent=selAgentTasks>0?String(selAgentTasks):"\u2013";
    if(agentSub)agentSub.textContent=selAgentTasks>0?selAgentCompleted+" completed \u00B7 "+selAgentPRs+" PRs":"no agent data";
  }else{
    if(agentVal)agentVal.textContent=agentCopilotData.totalTasks>0?String(agentCopilotData.totalTasks):"\u2013";
    if(agentSub)agentSub.textContent=agentCopilotData.totalTasks>0?agentCopilotData.completed+" completed \u00B7 "+agentCopilotData.agentPRs+" PRs":"no agent data";
  }

  // ── Issue lead times chart ──
  if(charts.leadTime){
    var ltData=filteredLT.map(function(lt){return{x:lt.prMergedAt.slice(0,10),y:Math.round(lt.leadTimeHours/24*10)/10};}).sort(function(a,b){return a.x<b.x?-1:1;});
    charts.leadTime.data.labels=ltData.map(function(d){return d.x;});
    charts.leadTime.data.datasets[0].data=ltData.map(function(d){return d.y;});
    charts.leadTime.update();
  }

  // ── Repo table merged-PR cells ──
  if(period==="all"&&!repoFiltered){
    document.querySelectorAll(".repo-row[data-repo-name]").forEach(function(row){
      var cell=row.querySelector(".td-merged-prs");
      var v=String(row.dataset.mergedPrsAll||0);
      if(cell)cell.textContent=v;
      row.dataset.mergedPrs=v;
    });
  }else{
    var repoCounts={};
    filteredPR.forEach(function(p){var key=p.repo.toLowerCase();repoCounts[key]=(repoCounts[key]||0)+1;});
    document.querySelectorAll(".repo-row[data-repo-name]").forEach(function(row){
      var cell=row.querySelector(".td-merged-prs");
      var v=String(repoCounts[row.dataset.repoName]||0);
      if(cell)cell.textContent=v;
      row.dataset.mergedPrs=v;
    });
  }
  var note=document.getElementById("reposPeriodNote");
  if(note)note.style.display=(period==="all"&&!repoFiltered)?"none":"";

  // ── DORA & code-review tiles ──
  updateDora(cutoff,filteredPR);
  updateReviewStats(filteredPR);
}
// ── DORA client-side recompute ──
// Tier thresholds mirror dora.ts exactly (approximate dora.dev bands), and so
// does the failure-signal preference: when ANY repo carries labeled incident
// issues (in-window or not — see hasIncidentSignal() in dora.ts), CFR/MTTR
// use incidents for the current period/repo slice; otherwise revert PRs
// remain the failure proxy.
function doraDeployTierOf(perWeek){if(perWeek>=7)return "elite";if(perWeek>=1)return "high";if(perWeek>=0.25)return "medium";return "low";}
function doraLeadTierOf(h){if(h<24)return "elite";if(h<168)return "high";if(h<730)return "medium";return "low";}
function doraCfrTierOf(r){if(r<=0.05)return "elite";if(r<=0.1)return "high";if(r<=0.15)return "medium";return "low";}
function doraMttrTierOf(h){if(h<1)return "elite";if(h<24)return "high";if(h<168)return "medium";return "low";}
function round2(v){return Math.round(v*100)/100;}
function setDoraTile(valId,subId,tierId,valText,subText,tier){
  var val=document.getElementById(valId);if(val)val.textContent=valText;
  var sub=document.getElementById(subId);if(sub)sub.textContent=subText;
  var badge=document.getElementById(tierId);
  if(badge){
    if(tier){
      badge.textContent=tier.charAt(0).toUpperCase()+tier.slice(1);
      badge.className="dora-tier tier-"+tier;
      badge.hidden=false;
    }else{
      badge.hidden=true;
    }
  }
}
// Recompute the four DORA metrics against the current filter slice.
// filteredPR already reflects the repo filter, the period cutoff, and the
// exclude-bots toggle (same slice as the other KPIs). Deploy/revert events
// are filtered here by the selected repos + cutoff.
function updateDora(cutoff,filteredPR){
  var collected=new Date(CHART_DATA.collectedAt);
  var windowDays;
  if(cutoff){
    windowDays=(collected.getTime()-cutoff.getTime())/86400000;
  }else{
    var oldest=null;
    filteredPR.forEach(function(p){var d=new Date(p.mergedAt);if(!oldest||d<oldest)oldest=d;});
    windowDays=oldest?(collected.getTime()-oldest.getTime())/86400000:7;
    if(windowDays<7)windowDays=7;
  }
  function eventInWindow(iso){
    var t=new Date(iso);
    return (!cutoff||t>=cutoff)&&t<=collected;
  }
  function repoSelected(name){return selectedRepos.size===0||selectedRepos.has(name);}
  // Deploy frequency: deployment/release events per week in the window.
  var deploys=0;
  var rd=CHART_DATA.repoDeployments||{};
  Object.keys(rd).forEach(function(name){
    if(!repoSelected(name))return;
    rd[name].forEach(function(iso){if(eventInWindow(iso))deploys++;});
  });
  var weeks=windowDays/7;
  var perWeek=round2(weeks>0?deploys/weeks:0);
  setDoraTile("doraDeployVal","doraDeploySub","doraDeployTier",
    deploys>0?perWeek.toFixed(1)+"/wk":"–",
    deploys+" deploys",
    deploys>0?doraDeployTierOf(perWeek):null);
  // Lead time: median created->merged hours of non-bot PRs (mirrors dora.ts,
  // which always excludes bot authors from the lead-time sample).
  var leads=[];
  filteredPR.forEach(function(p){if(!p.isBotAuthor&&p.timeToMergeHours>0)leads.push(p.timeToMergeHours);});
  var lead=round2(medianOf(leads));
  setDoraTile("doraLeadVal","doraLeadSub","doraLeadTier",
    leads.length>0?fmtDur(lead):"–",
    leads.length>0?"median of "+leads.length+" PRs":"median PR created → merged",
    leads.length>0?doraLeadTierOf(lead):null);
  // Failure signal: incidents when any repo has any (mirrors dora.ts).
  var ri=CHART_DATA.repoIncidents||{};
  var useIncidents=Object.keys(ri).length>0;
  // Change failure rate: failures / merged PRs in the slice. With the
  // incident signal, failures are incidents opened in the window across the
  // selected repos; otherwise revert PRs within the filtered slice.
  var merged=filteredPR.length;
  var failures=0;
  if(useIncidents){
    Object.keys(ri).forEach(function(name){
      if(!repoSelected(name))return;
      ri[name].forEach(function(inc){if(eventInWindow(inc.createdAt))failures++;});
    });
  }else{
    filteredPR.forEach(function(p){if(p.isRevert)failures++;});
  }
  var failureNoun=useIncidents?"incidents":"reverts";
  var cfr=round2(merged>0?failures/merged:0);
  setDoraTile("doraCfrVal","doraCfrSub","doraCfrTier",
    merged>0?(cfr*100).toFixed(1)+"%":"–",
    failures+" "+failureNoun+" / "+merged+" merged",
    merged>0?doraCfrTierOf(cfr):null);
  // MTTR: median resolution hours of incidents closed in the window, or the
  // median original-merge -> revert-merge hours of matched reverts.
  var restores=[];
  if(useIncidents){
    Object.keys(ri).forEach(function(name){
      if(!repoSelected(name))return;
      ri[name].forEach(function(inc){
        if(inc.resolutionHours!==undefined&&inc.closedAt&&eventInWindow(inc.closedAt))restores.push(inc.resolutionHours);
      });
    });
  }else{
    var rr=CHART_DATA.repoReverts||{};
    Object.keys(rr).forEach(function(name){
      if(!repoSelected(name))return;
      rr[name].forEach(function(rv){
        if(rv.restoreHours>0&&eventInWindow(rv.revertMergedAt))restores.push(rv.restoreHours);
      });
    });
  }
  var mttr=round2(medianOf(restores));
  setDoraTile("doraMttrVal","doraMttrSub","doraMttrTier",
    restores.length>0?fmtDur(mttr):"–",
    restores.length>0?"median of "+restores.length+" "+failureNoun:(useIncidents?"no closed incidents":"no matched reverts"),
    restores.length>0?doraMttrTierOf(mttr):null);
  // Keep the block-head signal caption in sync with the recomputed slice.
  var sigNote=document.getElementById("doraSignalNote");
  if(sigNote)sigNote.textContent=useIncidents?"failure = labeled incident ("+failures+" in window)":"failure = reverted merge";
}
// ── Code-review client-side recompute ──
// Mirrors computeReviewStats in dora.ts: bot-authored PRs excluded from the
// coverage denominator, bot reviewers excluded from the load table.
function isExcludedReviewer(login){
  var l=login.toLowerCase();
  return /\\[bot\\]$/.test(l)||/-bot$/.test(l)||/^bot-/.test(l)||l==="copilot";
}
function updateReviewStats(filteredPR){
  var prs=filteredPR.filter(function(p){return !p.isBotAuthor;});
  var total=prs.length,reviewed=0;
  var firstHours=[];
  var byLogin={};
  prs.forEach(function(p){
    var revs=p.reviewers||[];
    if(revs.length>0)reviewed++;
    if(p.timeToFirstReviewHours!==undefined&&p.timeToFirstReviewHours>0)firstHours.push(p.timeToFirstReviewHours);
    var seen={};
    revs.forEach(function(login){
      login=String(login).trim();
      if(!login||seen[login])return;
      seen[login]=true;
      if(isExcludedReviewer(login))return;
      byLogin[login]=(byLogin[login]||0)+1;
    });
  });
  var covEl=document.getElementById("reviewCoverageVal");
  var covSub=document.getElementById("reviewCoverageSub");
  if(covEl)covEl.textContent=total>0?(reviewed/total*100).toFixed(1)+"%":"–";
  if(covSub)covSub.textContent=reviewed+" of "+total+" PRs reviewed";
  var medEl=document.getElementById("reviewMedianVal");
  if(medEl)medEl.textContent=firstHours.length>0?fmtDur(round2(medianOf(firstHours))):"–";
  var p90El=document.getElementById("reviewP90Val");
  if(p90El)p90El.textContent=firstHours.length>0?fmtDur(round2(percentileOf(firstHours,0.9))):"–";
  // Reviewer-load table (top 15). Rows are built via textContent, never
  // innerHTML, so reviewer logins cannot inject markup.
  var tbody=document.getElementById("reviewerLoadRows");
  if(!tbody)return;
  var totalReviews=0;
  Object.keys(byLogin).forEach(function(l){totalReviews+=byLogin[l];});
  var rows=Object.keys(byLogin).map(function(l){return{login:l,n:byLogin[l]};})
    .sort(function(a,b){return b.n-a.n||a.login.localeCompare(b.login);});
  tbody.textContent="";
  if(rows.length===0){
    var tr0=document.createElement("tr");
    var td0=document.createElement("td");
    td0.colSpan=3;
    td0.className="col-muted";
    td0.textContent="No reviewer data in the selected period.";
    tr0.appendChild(td0);
    tbody.appendChild(tr0);
  }else{
    rows.slice(0,15).forEach(function(r){
      var tr=document.createElement("tr");
      var tdLogin=document.createElement("td");
      tdLogin.textContent=r.login;
      var tdN=document.createElement("td");
      tdN.className="col-num";
      tdN.textContent=r.n.toLocaleString("en-US");
      var tdShare=document.createElement("td");
      tdShare.className="col-num";
      tdShare.textContent=totalReviews>0?(r.n/totalReviews*100).toFixed(1)+"%":"–";
      tr.appendChild(tdLogin);tr.appendChild(tdN);tr.appendChild(tdShare);
      tbody.appendChild(tr);
    });
  }
  var more=document.getElementById("reviewerLoadMore");
  if(more){
    if(rows.length>15){
      more.hidden=false;
      more.textContent="…and "+(rows.length-15)+" more";
    }else{
      more.hidden=true;
    }
  }
}
function compareRows(a,b,by){
  if(by==="name")return a.dataset.name.localeCompare(b.dataset.name,undefined,{sensitivity:"base"});
  if(by==="pushed"){var pa=a.dataset.pushed||"";var pb=b.dataset.pushed||"";return pb.localeCompare(pa);}
  return Number(b.dataset[by]||0)-Number(a.dataset[by]||0);
}
function setupControls(){
  var f=document.getElementById("repoFilter");
  var st=document.getElementById("repoSort");
  var list=document.getElementById("repoList");
  var sh=document.getElementById("shown");
  if(!f||!list)return;
  function filterAndSort(){
    var q=f.value.toLowerCase();var by=st?st.value:"name";
    var n=0;
    var tbody=list;
    var grpHdrRows=Array.from(tbody.querySelectorAll("tr.grp-hdr-row"));
    if(grpHdrRows.length>0){
      grpHdrRows.forEach(function(hdrRow){
        var grpId=hdrRow.dataset.grpId;
        var dataRows=Array.from(tbody.querySelectorAll("tr.repo-row[data-grp-id='"+grpId+"']"));
        dataRows.sort(function(a,b){return compareRows(a,b,by);});
        // Find next group header to use as insertion point
        var nextHdr=hdrRow.nextElementSibling;
        while(nextHdr&&!nextHdr.classList.contains("grp-hdr-row")){nextHdr=nextHdr.nextElementSibling;}
        // Save detail-row refs before removal — getElementById won't find detached nodes
        var drMap=new Map();
        dataRows.forEach(function(row){
          var dr=document.getElementById("detail-"+row.dataset.repoId);
          drMap.set(row,dr);
          if(row.parentNode)row.parentNode.removeChild(row);
          if(dr&&dr.parentNode)dr.parentNode.removeChild(dr);
        });
        dataRows.forEach(function(row){
          var match=row.dataset.name.indexOf(q)!==-1;
          var grpHidden=!!row.dataset.grpHidden;
          row.style.display=(!match||grpHidden)?"none":"";
          if(match&&!grpHidden)n++;
          tbody.insertBefore(row,nextHdr||null);
          var dr=drMap.get(row);
          if(dr){
            if(!match||grpHidden)dr.style.display="none";
            else dr.style.display=dr.hidden?"none":"";
            tbody.insertBefore(dr,nextHdr||null);
          }
        });
      });
      // Hide group headers whose rows are all filtered out
      grpHdrRows.forEach(function(hdrRow){
        var grpId=hdrRow.dataset.grpId;
        var visible=Array.from(tbody.querySelectorAll("tr.repo-row[data-grp-id='"+grpId+"']"))
          .filter(function(r){return r.style.display!=="none";}).length;
        hdrRow.style.display=visible>0?"":"none";
      });
    }else{
      var allDataRows=Array.from(tbody.querySelectorAll("tr.repo-row"));
      allDataRows.sort(function(a,b){return compareRows(a,b,by);});
      allDataRows.forEach(function(row){
        var match=row.dataset.name.indexOf(q)!==-1;
        row.style.display=match?"":"none";
        if(match)n++;
        tbody.appendChild(row);
        var dr=document.getElementById("detail-"+row.dataset.repoId);
        if(dr){
          if(!match)dr.style.display="none";
          else dr.style.display=dr.hidden?"none":"";
          tbody.appendChild(dr);
        }
      });
    }
    if(sh)sh.textContent=String(n);
  }
  f.addEventListener("input",filterAndSort);
  if(st)st.addEventListener("change",filterAndSort);
}
function setupSortHeaders(){
  var st=document.getElementById("repoSort");
  document.querySelectorAll(".th-sortable").forEach(function(th){
    th.addEventListener("click",function(){
      var sortKey=th.dataset.sort;
      document.querySelectorAll(".th-sortable").forEach(function(h){
        h.classList.remove("sort-active");
        var ind=h.querySelector(".sort-ind");if(ind)ind.textContent="";
      });
      th.classList.add("sort-active");
      var ind=th.querySelector(".sort-ind");
      if(ind)ind.textContent=(sortKey==="name"||sortKey==="pushed")?"↑":"↓";
      if(st){st.value=sortKey;st.dispatchEvent(new Event("change"));}
    });
  });
}
function setupGroups(){
  var now=Date.now();
  var groupDefs=[
    {id:"grp-month",label:"Last Month",maxDays:30},
    {id:"grp-quarter",label:"Last Quarter",maxDays:90},
    {id:"grp-halfyear",label:"Last Half Year",maxDays:180},
    {id:"grp-older",label:"Older",maxDays:Infinity}
  ];
  var tbody=document.getElementById("repoList");
  if(!tbody)return;
  var dataRows=Array.from(tbody.querySelectorAll("tr.repo-row"));
  // Build detail-row map before removing from DOM (getElementById won't find detached nodes)
  var drMap=new Map();
  dataRows.forEach(function(row){
    drMap.set(row,document.getElementById("detail-"+row.dataset.repoId));
  });
  var allRows=Array.from(tbody.querySelectorAll("tr"));
  allRows.forEach(function(r){if(r.parentNode)r.parentNode.removeChild(r);});
  var groups={};
  groupDefs.forEach(function(g){groups[g.id]=[];});
  dataRows.forEach(function(row){
    var pushed=row.dataset.pushed;
    var days=pushed&&pushed.length>0?utcDaysSince(pushed,now):Infinity;
    var targetId=groupDefs[groupDefs.length-1].id;
    for(var i=0;i<groupDefs.length;i++){if(days<=groupDefs[i].maxDays){targetId=groupDefs[i].id;break;}}
    var ageBadge=row.querySelector(".bdg-age");
    if(ageBadge){var ageStr=computeAge(days);ageBadge.textContent=ageStr;ageBadge.style.display=ageStr?"":"none";}
    row.dataset.grpId=targetId;
    var dr=drMap.get(row);
    if(dr)dr.dataset.grpId=targetId;
    groups[targetId].push(row);
  });
  var firstOpened=false;
  groupDefs.forEach(function(g){
    var grpRows=groups[g.id];
    if(grpRows.length===0)return;
    var hdrTr=document.createElement("tr");
    hdrTr.className="grp-hdr-row";
    hdrTr.dataset.grpId=g.id;
    hdrTr.innerHTML='<td colspan="9" class="grp-hdr-cell"><span class="grp-chevron">&rsaquo;</span><span class="grp-label">'+g.label+'</span><span class="grp-count"> ('+grpRows.length+')</span></td>';
    hdrTr.addEventListener("click",function(){toggleGroup(g.id);});
    tbody.appendChild(hdrTr);
    grpRows.forEach(function(row){
      tbody.appendChild(row);
      var dr=drMap.get(row);
      if(dr)tbody.appendChild(dr);
    });
    if(!firstOpened){
      firstOpened=true;
      hdrTr.classList.add("expanded");
    }else{
      grpRows.forEach(function(row){
        row.style.display="none";row.dataset.grpHidden="1";
        var dr=drMap.get(row);
        if(dr){dr.style.display="none";dr.dataset.grpHidden="1";}
      });
    }
  });
}
function toggleGroup(grpId){
  var hdrRow=document.querySelector(".grp-hdr-row[data-grp-id='"+grpId+"']");
  if(!hdrRow)return;
  var expanded=hdrRow.classList.toggle("expanded");
  var tbody=document.getElementById("repoList");
  var dataRows=Array.from(tbody.querySelectorAll("tr.repo-row[data-grp-id='"+grpId+"']"));
  dataRows.forEach(function(row){
    if(expanded){
      delete row.dataset.grpHidden;
      row.style.display="";
    }else{
      row.dataset.grpHidden="1";
      row.style.display="none";
      var dr=document.getElementById("detail-"+row.dataset.repoId);
      if(dr){dr.style.display="none";dr.dataset.grpHidden="1";}
    }
  });
}
function utcDaysSince(isoDate,nowMs){
  var d=new Date(isoDate);
  var pushedMs=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate());
  var nowDate=new Date(nowMs);
  var todayMs=Date.UTC(nowDate.getUTCFullYear(),nowDate.getUTCMonth(),nowDate.getUTCDate());
  return Math.max(0,(todayMs-pushedMs)/86400000);
}
function computeAge(days){
  if(!isFinite(days))return "";
  if(days<1)return "today";
  days=Math.floor(days);
  if(days<7)return days+"d";
  var w=Math.floor(days/7);
  if(w<5)return w+"w";
  var m=Math.floor(days/30);
  if(m<12)return m+"mo";
  return Math.floor(days/365)+"y";
}
function toggleRepo(btn){
  var row=btn.closest("tr.repo-row");
  if(!row)return;
  var repoId=row.dataset.repoId;
  var dr=document.getElementById("detail-"+repoId);
  var exp=btn.getAttribute("aria-expanded")==="true";
  btn.setAttribute("aria-expanded",String(!exp));
  if(dr){dr.hidden=exp;dr.style.display=exp?"none":"";}
  row.classList.toggle("expanded");
}`;
}
main();
