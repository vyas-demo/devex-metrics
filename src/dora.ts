/**
 * DORA metrics & code-review analytics.
 *
 * Pure, side-effect-free derivations from the deployment, revert, incident,
 * and merged-PR-timeline data that `collect` already gathers for every repo.
 * Deploy frequency uses deployment/release events; lead time uses PR
 * created→merged as the change proxy; change-failure rate and MTTR prefer
 * labeled incident issues where the org has any, falling back to revert PRs
 * as a proxy otherwise. No additional API calls.
 */
import type {
  OrgMetrics,
  DoraMetric,
  DoraMetrics,
  DoraTier,
  ReviewStats,
  ReviewerStats,
} from "./types.js";
import { median, percentile } from "./developer-stats.js";

/** Options shared by the DORA and review-analytics computations. */
export interface DoraWindowOptions {
  /** Analysis window length in days. Default 90. */
  windowDays?: number;
  /**
   * End of the analysis window. Defaults to `metrics.collectedAt` (NOT the
   * wall clock) so results are deterministic for a given collection.
   */
  now?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS_PER_WEEK = 7;

/** Resolved analysis window: [startMs, endMs], inclusive on both ends. */
interface Window {
  startMs: number;
  endMs: number;
  windowDays: number;
}

function resolveWindow(metrics: OrgMetrics, options?: DoraWindowOptions): Window {
  const windowDays = options?.windowDays ?? 90;
  const now = options?.now ?? new Date(metrics.collectedAt);
  const endMs = now.getTime();
  return { startMs: endMs - windowDays * DAY_MS, endMs, windowDays };
}

/** True when the ISO timestamp falls inside the window (NaN/undefined → false). */
function inWindow(iso: string | undefined, window: Window): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return t >= window.startMs && t <= window.endMs;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

// ── Tier classification (approximate dora.dev benchmark bands) ────────────────

/** Deploys per week: elite ≥7, high ≥1, medium ≥0.25, low <0.25. */
function deployFrequencyTier(perWeek: number): DoraTier {
  if (perWeek >= 7) return "elite";
  if (perWeek >= 1) return "high";
  if (perWeek >= 0.25) return "medium";
  return "low";
}

/** Median lead-time hours: elite <24h, high <168h (1wk), medium <730h (~1mo), low ≥730h. */
function leadTimeTier(hours: number): DoraTier {
  if (hours < 24) return "elite";
  if (hours < 168) return "high";
  if (hours < 730) return "medium";
  return "low";
}

/** Change-failure ratio: elite ≤5%, high ≤10%, medium ≤15%, low >15%. */
function changeFailureTier(ratio: number): DoraTier {
  if (ratio <= 0.05) return "elite";
  if (ratio <= 0.1) return "high";
  if (ratio <= 0.15) return "medium";
  return "low";
}

/** Median restore hours: elite <1h, high <24h, medium <168h (1wk), low ≥168h. */
function mttrTier(hours: number): DoraTier {
  if (hours < 1) return "elite";
  if (hours < 24) return "high";
  if (hours < 168) return "medium";
  return "low";
}

/**
 * Build a DoraMetric. The value is rounded to 2 decimals and the tier is
 * classified from the rounded value, so the reported value and tier can never
 * appear inconsistent. Tier is undefined when there is no data to classify.
 */
function makeMetric(
  value: number,
  hasData: boolean,
  tierOf: (v: number) => DoraTier
): DoraMetric {
  const rounded = round2(value);
  return { value: rounded, tier: hasData ? tierOf(rounded) : undefined, hasData };
}

// ── DORA metrics ──────────────────────────────────────────────────────────────

/**
 * True when any repo carries at least one labeled incident issue — in-window
 * or not. Deliberately ignores the analysis window: a team that labels
 * incidents but had a clean month should get a change-failure rate of 0 from
 * the incident signal, not silently fall back to revert-PR noise.
 */
function hasIncidentSignal(metrics: OrgMetrics): boolean {
  return metrics.repos.some((repo) => (repo.incidents ?? []).length > 0);
}

/**
 * Compute the four DORA metrics from collected org metrics over a trailing
 * window ending at `options.now` (default: `metrics.collectedAt`).
 *
 * - Deploy frequency: deployment/release events in the window ÷ weeks.
 * - Lead time: median created→merged hours of non-bot merged PRs in the window.
 * - Change-failure rate: failure events ÷ all merged PRs in the window.
 * - MTTR: median hours to resolve/restore across failures in the window.
 *
 * Failure-signal preference: when the org has ANY labeled incident issues
 * (`repo.incidents`), change-failure rate counts incidents opened in the
 * window and MTTR is the median `resolutionHours` over incidents closed in
 * the window (`failureSignal: "incidents"`). Incident labels are ground truth
 * where present; revert PRs are only a proxy — a revert may be a harmless
 * rollback and a real outage may never produce a revert. Orgs without any
 * incidents keep the revert-based behavior (`failureSignal: "reverts"`).
 * `totalReverts` is always reported for reference either way.
 */
export function computeDoraMetrics(
  metrics: OrgMetrics,
  options?: DoraWindowOptions
): DoraMetrics {
  const window = resolveWindow(metrics, options);

  let deploysInWindow = 0;
  let mergedInWindow = 0;
  let revertsInWindow = 0;
  let incidentsInWindow = 0;
  const leadTimes: number[] = [];
  const restoreTimes: number[] = [];
  const incidentResolutionTimes: number[] = [];

  for (const repo of metrics.repos) {
    for (const deploy of repo.deployments ?? []) {
      if (inWindow(deploy.createdAt, window)) deploysInWindow++;
    }

    for (const pr of repo.mergedPRTimeline ?? []) {
      if (!inWindow(pr.mergedAt, window)) continue;
      mergedInWindow++;
      if (pr.isRevert) revertsInWindow++;
      // Lead-time sample: human-authored PRs with a positive merge time.
      if (!pr.isBotAuthor && pr.timeToMergeHours > 0) {
        leadTimes.push(pr.timeToMergeHours);
      }
    }

    for (const revert of repo.reverts ?? []) {
      if (!inWindow(revert.revertMergedAt, window)) continue;
      if (revert.restoreHours !== undefined && revert.restoreHours > 0) {
        restoreTimes.push(revert.restoreHours);
      }
    }

    for (const incident of repo.incidents ?? []) {
      // CFR sample: incidents OPENED in the window (when the failure surfaced).
      if (inWindow(incident.createdAt, window)) incidentsInWindow++;
      // MTTR sample: incidents CLOSED in the window with a known resolution
      // time. Open incidents have no resolution yet and are excluded here.
      if (incident.resolutionHours !== undefined && inWindow(incident.closedAt, window)) {
        incidentResolutionTimes.push(incident.resolutionHours);
      }
    }
  }

  const weeks = window.windowDays / DAYS_PER_WEEK;
  const deployFrequencyPerWeek = makeMetric(
    weeks > 0 ? deploysInWindow / weeks : 0,
    deploysInWindow > 0,
    deployFrequencyTier
  );
  const leadTimeHours = makeMetric(
    median(leadTimes),
    leadTimes.length > 0,
    leadTimeTier
  );
  // Prefer real incident signals over revert proxies (see the function JSDoc).
  const useIncidents = hasIncidentSignal(metrics);
  const failuresInWindow = useIncidents ? incidentsInWindow : revertsInWindow;
  const changeFailureRate = makeMetric(
    mergedInWindow > 0 ? failuresInWindow / mergedInWindow : 0,
    mergedInWindow > 0,
    changeFailureTier
  );
  const resolutionSample = useIncidents ? incidentResolutionTimes : restoreTimes;
  const mttrHours = makeMetric(
    median(resolutionSample),
    resolutionSample.length > 0,
    mttrTier
  );

  return {
    hasData:
      deployFrequencyPerWeek.hasData ||
      leadTimeHours.hasData ||
      changeFailureRate.hasData ||
      mttrHours.hasData,
    windowDays: window.windowDays,
    deployFrequencyPerWeek,
    leadTimeHours,
    changeFailureRate,
    mttrHours,
    totalDeploys: deploysInWindow,
    totalMergedPRs: mergedInWindow,
    totalReverts: revertsInWindow,
    failureSignal: useIncidents ? "incidents" : "reverts",
    totalIncidents: useIncidents ? incidentsInWindow : 0,
  };
}

// ── Review analytics ──────────────────────────────────────────────────────────

/**
 * Reviewer logins to exclude from reviewer-load analytics.
 *
 * Same defensive bot heuristic as `isLikelyBot` in developer-stats.ts (not
 * exported there, so the tiny regex is duplicated here): `[bot]` suffix,
 * `-bot` suffix, or `bot-` prefix, case-insensitive. Additionally excludes
 * logins whose lowercase is exactly "copilot" — Copilot code review can
 * surface as a bare `Copilot` login without the `[bot]` suffix.
 */
function isExcludedReviewer(login: string): boolean {
  const l = login.toLowerCase();
  return /\[bot\]$/.test(l) || /-bot$/.test(l) || /^bot-/.test(l) || l === "copilot";
}

/**
 * Compute code-review analytics over merged PRs in a trailing window ending
 * at `options.now` (default: `metrics.collectedAt`).
 *
 * Bot-authored PRs (dependabot etc.) are auto-merged noise and are excluded
 * from both the numerator and the denominator. Bot reviewers are excluded
 * from the per-reviewer load table.
 */
export function computeReviewStats(
  metrics: OrgMetrics,
  options?: DoraWindowOptions
): ReviewStats {
  const window = resolveWindow(metrics, options);

  let totalPRs = 0;
  let reviewedPRs = 0;
  const firstReviewHours: number[] = [];
  const prsReviewedByLogin = new Map<string, number>();

  for (const repo of metrics.repos) {
    for (const pr of repo.mergedPRTimeline ?? []) {
      if (pr.isBotAuthor) continue;
      if (!inWindow(pr.mergedAt, window)) continue;

      totalPRs++;
      const reviewers = pr.reviewers ?? [];
      if (reviewers.length > 0) reviewedPRs++;
      if (pr.timeToFirstReviewHours !== undefined && pr.timeToFirstReviewHours > 0) {
        firstReviewHours.push(pr.timeToFirstReviewHours);
      }

      // Distinct-PR counting: a login reviewing one PR several times counts once.
      const distinctLogins = new Set(
        reviewers.map((login) => login.trim()).filter((login) => login.length > 0)
      );
      for (const login of distinctLogins) {
        if (isExcludedReviewer(login)) continue;
        prsReviewedByLogin.set(login, (prsReviewedByLogin.get(login) ?? 0) + 1);
      }
    }
  }

  let totalReviews = 0;
  for (const count of prsReviewedByLogin.values()) totalReviews += count;

  const reviewers: ReviewerStats[] = [...prsReviewedByLogin.entries()]
    .map(([login, prsReviewed]) => ({
      login,
      prsReviewed,
      loadShare: totalReviews > 0 ? round4(prsReviewed / totalReviews) : 0,
    }))
    .sort((a, b) => b.prsReviewed - a.prsReviewed || a.login.localeCompare(b.login));

  return {
    hasData: totalPRs > 0 || reviewers.length > 0,
    reviewedPRs,
    totalPRs,
    reviewCoverage: totalPRs > 0 ? round4(reviewedPRs / totalPRs) : 0,
    medianTimeToFirstReviewHours: round2(median(firstReviewHours)),
    p90TimeToFirstReviewHours: round2(percentile(firstReviewHours, 0.9)),
    reviewers,
    // Sorted by prsReviewed desc, so the head carries the max load share.
    topReviewerShare: reviewers.length > 0 ? reviewers[0].loadShare : 0,
  };
}
