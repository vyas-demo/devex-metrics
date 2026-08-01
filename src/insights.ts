/**
 * Insights engine: automated, evidence-backed findings.
 *
 * Pure, side-effect-free detectors that scan the already-computed analytics
 * (engineering intelligence, DORA, review, health, collaboration) plus the
 * raw merged-PR timelines and emit prioritized `Insight` findings — each with
 * concrete numbers and, where actionable, a recommendation. No API calls.
 */
import type {
  OrgMetrics,
  MergedPRSummary,
  EngineeringIntelligence,
  DoraMetrics,
  DoraMetric,
  ReviewStats,
  HealthReport,
  CollaborationStats,
  Insight,
  InsightSeverity,
  InsightsSummary,
  TargetEvaluation,
  WeeklyTrendPoint,
} from "./types.js";
import { attribute, median } from "./developer-stats.js";

/** Pre-computed analytics consumed by the insight detectors. */
export interface InsightInputs {
  /** Per-developer & AI-impact analytics. */
  intel: EngineeringIntelligence;
  /** DORA metrics. */
  dora: DoraMetrics;
  /** Code-review analytics. */
  review: ReviewStats;
  /** Repo health scores. */
  health: HealthReport;
  /** Collaboration-network analytics. */
  collaboration: CollaborationStats;
  /** Team-target evaluations from devex.config.json, when configured. */
  targets?: TargetEvaluation[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Sort rank per severity: critical first, positive last. */
const SEVERITY_RANK: Record<InsightSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
  positive: 3,
};

// ── Formatting helpers ────────────────────────────────────────────────────────

/** Format a number with at most one decimal place ("38", "38.5"). */
function fmt1(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** Format hours human-readably, e.g. "38h" or "1.5h". */
function fmtHours(hours: number): string {
  return `${fmt1(hours)}h`;
}

/** Format a [0,1] ratio as a percentage, e.g. "42%" or "16.7%". */
function fmtPct(ratio: number): string {
  return `${fmt1(ratio * 100)}%`;
}

/** List up to `max` names, appending an ellipsis when some are omitted. */
function listSome(names: string[], max = 3): string {
  const shown = names.slice(0, max);
  return names.length > max ? `${shown.join(", ")}, …` : shown.join(", ");
}

/** "repo" / "repos" style pluralization. */
function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

// ── Trend windows ─────────────────────────────────────────────────────────────

/** Human-authored merged PRs split into the recent and prior 30-day windows. */
interface TrendWindows {
  /** Merged within 30 days before `collectedAt`. */
  recent: MergedPRSummary[];
  /** Merged 30–60 days before `collectedAt`. */
  prior: MergedPRSummary[];
}

/**
 * Split the human-authored merged-PR timelines into a recent window (last 30
 * days before `collectedAt`) and a prior window (30–60 days before). Bot- and
 * AI-authored PRs are excluded so trends reflect human delivery.
 */
function splitTrendWindows(metrics: OrgMetrics): TrendWindows {
  const endMs = Date.parse(metrics.collectedAt);
  const recentStartMs = endMs - 30 * DAY_MS;
  const priorStartMs = endMs - 60 * DAY_MS;
  const recent: MergedPRSummary[] = [];
  const prior: MergedPRSummary[] = [];

  for (const repo of metrics.repos) {
    for (const pr of repo.mergedPRTimeline ?? []) {
      if (attribute(pr) !== "human") continue;
      const mergedMs = Date.parse(pr.mergedAt);
      if (Number.isNaN(mergedMs) || mergedMs > endMs) continue;
      if (mergedMs >= recentStartMs) recent.push(pr);
      else if (mergedMs >= priorStartMs) prior.push(pr);
    }
  }
  return { recent, prior };
}

/** Lines changed by a merged PR, or undefined when line data is absent. */
function prLines(pr: MergedPRSummary): number | undefined {
  if (pr.linesAdded === undefined && pr.linesDeleted === undefined) return undefined;
  return (pr.linesAdded ?? 0) + (pr.linesDeleted ?? 0);
}

// ── Weekly anomaly detection ──────────────────────────────────────────────────

/** The last completed week's value compared against a trailing baseline. */
interface WeeklyAnomaly {
  /** Value observed in the evaluated (last completed) week. */
  value: number;
  /** Mean of the trailing 12-week baseline. */
  mean: number;
  /** Z-score of the evaluated value against the baseline. */
  z: number;
  /** ISO week label of the evaluated week. */
  week: string;
}

/**
 * Z-score of the last completed week against the 12 weeks before it. The
 * final trend point is the in-progress ISO week and is never evaluated.
 * Returns undefined with fewer than 8 baseline weeks or a zero-variance
 * baseline (a flat series has no meaningful anomalies).
 */
function weeklyAnomaly(
  trends: WeeklyTrendPoint[] | undefined,
  field: "prsMerged" | "issuesOpened"
): WeeklyAnomaly | undefined {
  if (!trends || trends.length < 10) return undefined;
  const completed = trends.slice(0, -1);
  const evaluated = completed[completed.length - 1];
  const baseline = completed.slice(-13, -1);
  if (!evaluated || baseline.length < 8) return undefined;
  const values = baseline.map((point) => point[field]);
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const sd = Math.sqrt(variance);
  if (sd === 0) return undefined;
  return {
    value: evaluated[field],
    mean,
    z: (evaluated[field] - mean) / sd,
    week: evaluated.week,
  };
}

/** Minimum absolute deviation from the mean before an anomaly may fire. */
const ANOMALY_MIN_DEVIATION = 3;

// ── Detectors (each emits at most one insight) ────────────────────────────────

/** Team-configured targets (devex.config.json) that are currently missed. */
function detectTargetsMissed(targets: TargetEvaluation[] | undefined): Insight | undefined {
  const missed = (targets ?? []).filter((t) => t.hasData && !t.met);
  if (missed.length === 0) return undefined;
  return {
    id: "targets-missed",
    severity: "warning",
    title: `${missed.length} team ${plural(missed.length, "target")} missed`,
    detail: missed
      .slice(0, 3)
      .map((t) => t.detail)
      .join(" ")
      .concat(missed.length > 3 ? ` …and ${missed.length - 3} more.` : ""),
    recommendation:
      "These thresholds come from devex.config.json — treat them as the team's own bar.",
  };
}

/** All team-configured targets with data are met. */
function detectTargetsMet(targets: TargetEvaluation[] | undefined): Insight | undefined {
  const evaluated = (targets ?? []).filter((t) => t.hasData);
  if (evaluated.length === 0 || evaluated.some((t) => !t.met)) return undefined;
  return {
    id: "targets-met",
    severity: "positive",
    title: `All ${evaluated.length} team ${plural(evaluated.length, "target")} met`,
    detail: `Every threshold configured in devex.config.json is currently satisfied: ${listSome(
      evaluated.map((t) => t.label)
    )}.`,
  };
}

/** Merge activity in the last completed week far outside its trailing band. */
function detectMergeAnomaly(metrics: OrgMetrics): Insight | undefined {
  const anomaly = weeklyAnomaly(metrics.weeklyTrends, "prsMerged");
  if (!anomaly || Math.abs(anomaly.value - anomaly.mean) < ANOMALY_MIN_DEVIATION) {
    return undefined;
  }
  if (anomaly.z <= -2) {
    return {
      id: "merge-anomaly",
      severity: "warning",
      title: "Merge activity dropped sharply",
      detail: `Only ${anomaly.value} PRs merged in week ${anomaly.week} vs a trailing 12-week average of ${fmt1(anomaly.mean)}.`,
      recommendation:
        "Check for blocked reviews, CI failures, or team availability behind the drop.",
    };
  }
  if (anomaly.z >= 2) {
    return {
      id: "merge-anomaly",
      severity: "info",
      title: "Merge activity spiked",
      detail: `${anomaly.value} PRs merged in week ${anomaly.week} vs a trailing 12-week average of ${fmt1(anomaly.mean)}.`,
    };
  }
  return undefined;
}

/** Unusually many issues opened in the last completed week. */
function detectIssueInfluxAnomaly(metrics: OrgMetrics): Insight | undefined {
  const anomaly = weeklyAnomaly(metrics.weeklyTrends, "issuesOpened");
  if (!anomaly || anomaly.value - anomaly.mean < ANOMALY_MIN_DEVIATION) return undefined;
  if (anomaly.z < 2) return undefined;
  return {
    id: "issue-influx-anomaly",
    severity: "warning",
    title: "Issue influx spike",
    detail: `${anomaly.value} issues opened in week ${anomaly.week} vs a trailing 12-week average of ${fmt1(anomaly.mean)}.`,
    recommendation:
      "Triage the new issues for a common cause — a bad release or a misbehaving integration often shows up here first.",
  };
}

/** Review load concentrated on a single reviewer. */
function detectReviewBottleneck(review: ReviewStats): Insight | undefined {
  if (!review.hasData || review.reviewedPRs < 10 || review.reviewers.length < 2) {
    return undefined;
  }
  const share = review.topReviewerShare;
  const severity: InsightSeverity | undefined =
    share > 0.6 ? "critical" : share > 0.4 ? "warning" : undefined;
  if (severity === undefined) return undefined;
  const top = review.reviewers[0];
  return {
    id: "review-bottleneck",
    severity,
    title: "Review load concentrated on one person",
    detail: `${top.login} carried ${fmtPct(share)} of all reviews across ${review.reviewedPRs} reviewed PRs.`,
    recommendation:
      "Rotate reviewers and build a second approver pool so reviews do not depend on one person.",
  };
}

/**
 * Too few merged PRs receive any review. Requires `hasReviewSignal`:
 * `computeReviewStats` counts PRs whose `reviewers` array is undefined
 * (REST-path / pre-v11 caches) as unreviewed, so without at least one PR
 * carrying real review data a 0% coverage figure means "no review data
 * collected", not "nobody reviews" — and must not fire a critical.
 */
function detectLowReviewCoverage(
  review: ReviewStats,
  hasReviewSignal: boolean
): Insight | undefined {
  if (!review.hasData || !hasReviewSignal || review.totalPRs < 10) return undefined;
  const coverage = review.reviewCoverage;
  const severity: InsightSeverity | undefined =
    coverage < 0.25 ? "critical" : coverage < 0.5 ? "warning" : undefined;
  if (severity === undefined) return undefined;
  return {
    id: "low-review-coverage",
    severity,
    title: "Low code-review coverage",
    detail: `Only ${review.reviewedPRs} of ${review.totalPRs} merged PRs (${fmtPct(coverage)}) received a review.`,
    recommendation: "Require at least one approving review before merge.",
  };
}

/** First reviews take too long at the tail. */
function detectSlowFirstReview(review: ReviewStats): Insight | undefined {
  if (!review.hasData || review.reviewedPRs < 5) return undefined;
  if (review.p90TimeToFirstReviewHours <= 48) return undefined;
  return {
    id: "slow-first-review",
    severity: "warning",
    title: "Slow time to first review",
    detail: `p90 time to first review is ${fmtHours(review.p90TimeToFirstReviewHours)} (median ${fmtHours(review.medianTimeToFirstReviewHours)}).`,
    recommendation:
      "Set a review-turnaround SLA and add reviewer reminders so PRs are not left waiting.",
  };
}

/** Repos where a single author accounts for most merges. */
function detectBusFactor(collaboration: CollaborationStats): Insight | undefined {
  const risky = collaboration.busFactors.filter(
    (repo) => repo.busFactor === 1 && repo.mergedPRs >= 10
  );
  if (risky.length === 0) return undefined;
  const worstShare = Math.max(...risky.map((repo) => repo.topAuthorShare));
  return {
    id: "bus-factor",
    severity: "warning",
    title: `Bus factor of 1 in ${risky.length} ${plural(risky.length, "repo")}`,
    detail: `A single author covers most merges in ${listSome(risky.map((repo) => repo.fullName))} (worst top-author share ${fmtPct(worstShare)}).`,
    recommendation:
      "Pair contributors on these repos and rotate code ownership to spread knowledge.",
  };
}

/** Contributors whose merged work all lands in one repo. */
function detectKnowledgeSilos(collaboration: CollaborationStats): Insight | undefined {
  const siloed = collaboration.siloedContributors;
  if (siloed.length < 3) return undefined;
  return {
    id: "knowledge-silos",
    severity: "info",
    title: "Siloed contributors",
    detail: `${siloed.length} contributors merged PRs into only a single repo (e.g. ${listSome(siloed)}).`,
  };
}

/** Median cycle time regression or improvement between 30-day windows. */
function detectCycleTimeTrend(windows: TrendWindows): Insight | undefined {
  const recentCycles = windows.recent
    .map((pr) => pr.timeToMergeHours)
    .filter((hours) => hours > 0);
  const priorCycles = windows.prior
    .map((pr) => pr.timeToMergeHours)
    .filter((hours) => hours > 0);
  if (recentCycles.length < 5 || priorCycles.length < 5) return undefined;

  const recentMedian = median(recentCycles);
  const priorMedian = median(priorCycles);
  if (priorMedian <= 0) return undefined;
  // Sub-hour medians in both windows are minute-scale noise (e.g. 0.1h →
  // 0.3h is a 3× "regression" nobody should act on) — stay silent.
  if (Math.max(recentMedian, priorMedian) < 1) return undefined;
  const ratio = recentMedian / priorMedian;

  if (ratio >= 1.3) {
    return {
      id: "cycle-time-trend",
      severity: "warning",
      title: "Cycle time regressed",
      detail: `Median time to merge rose from ${fmtHours(priorMedian)} to ${fmtHours(recentMedian)} over the last 30 days.`,
      recommendation:
        "Look for review delays or oversized PRs behind the slowdown.",
    };
  }
  if (ratio <= 0.8) {
    return {
      id: "cycle-time-trend",
      severity: "positive",
      title: "Cycle time improved",
      detail: `Median time to merge fell from ${fmtHours(priorMedian)} to ${fmtHours(recentMedian)} over the last 30 days.`,
    };
  }
  return undefined;
}

/** Merge throughput change between 30-day windows. */
function detectThroughputTrend(windows: TrendWindows): Insight | undefined {
  const recent = windows.recent.length;
  const prior = windows.prior.length;
  if (recent + prior < 10 || prior === 0) return undefined;
  const ratio = recent / prior;

  if (ratio >= 1.3) {
    return {
      id: "throughput-trend",
      severity: "positive",
      title: "Throughput up",
      detail: `${recent} PRs merged in the last 30 days vs ${prior} in the prior 30 days.`,
    };
  }
  if (ratio <= 0.7) {
    return {
      id: "throughput-trend",
      severity: "warning",
      title: "Throughput down",
      detail: `${recent} PRs merged in the last 30 days vs ${prior} in the prior 30 days.`,
      recommendation:
        "Check for blockers, review bottlenecks, or planned work shifting away from these repos.",
    };
  }
  return undefined;
}

/** PRs growing markedly larger between 30-day windows. */
function detectPRSizeTrend(windows: TrendWindows): Insight | undefined {
  const recentSizes = windows.recent
    .map(prLines)
    .filter((size): size is number => size !== undefined);
  const priorSizes = windows.prior
    .map(prLines)
    .filter((size): size is number => size !== undefined);
  if (recentSizes.length < 5 || priorSizes.length < 5) return undefined;

  const recentMedian = median(recentSizes);
  const priorMedian = median(priorSizes);
  if (priorMedian <= 0 || recentMedian / priorMedian < 1.5) return undefined;
  return {
    id: "pr-size-trend",
    severity: "info",
    title: "PRs are getting larger",
    detail: `Median PR size grew from ${fmt1(priorMedian)} to ${fmt1(recentMedian)} lines over the last 30 days.`,
    recommendation: "Keep PRs small — smaller changes review faster and revert cleaner.",
  };
}

/** Elevated change-failure (revert) rate. */
function detectChangeFailure(dora: DoraMetrics): Insight | undefined {
  const cfr = dora.changeFailureRate;
  if (!cfr.hasData) return undefined;
  const severity: InsightSeverity | undefined =
    cfr.tier === "low" ? "critical" : cfr.tier === "medium" ? "warning" : undefined;
  if (severity === undefined) return undefined;
  const detail =
    dora.failureSignal === "incidents"
      ? `${dora.totalIncidents ?? 0} labeled incidents against ${dora.totalMergedPRs} merged PRs (${fmtPct(cfr.value)}).`
      : `${dora.totalReverts} of ${dora.totalMergedPRs} merged PRs were reverts (${fmtPct(cfr.value)}).`;
  return {
    id: "change-failure",
    severity,
    title: "High change-failure rate",
    detail,
    recommendation:
      "Strengthen pre-merge testing and CI gates to catch failures before they ship.",
  };
}

/** Elite performance on most DORA metrics with no laggards. */
function detectDoraElite(dora: DoraMetrics): Insight | undefined {
  if (!dora.hasData) return undefined;
  const metrics: Array<[string, DoraMetric]> = [
    ["deploy frequency", dora.deployFrequencyPerWeek],
    ["lead time", dora.leadTimeHours],
    ["change-failure rate", dora.changeFailureRate],
    ["MTTR", dora.mttrHours],
  ];
  const elite = metrics.filter(([, metric]) => metric.tier === "elite").map(([name]) => name);
  const anyLow = metrics.some(([, metric]) => metric.tier === "low");
  if (elite.length < 2 || anyLow) return undefined;
  return {
    id: "dora-elite",
    severity: "positive",
    title: "Elite DORA performance",
    detail: `${elite.length} of 4 DORA metrics are in the elite tier: ${elite.join(", ")}.`,
  };
}

/** Repos scoring in the D/F health range. */
function detectUnhealthyRepos(health: HealthReport): Insight | undefined {
  if (!health.hasData) return undefined;
  const attention = health.repos.filter((repo) => repo.needsAttention);
  if (attention.length === 0) return undefined;
  const hasF = attention.some((repo) => repo.grade === "F");
  const severity: InsightSeverity = attention.length >= 3 || hasF ? "warning" : "info";
  const worst = [...attention].sort((a, b) => a.score - b.score).slice(0, 3);
  return {
    id: "unhealthy-repos",
    severity,
    title: `${attention.length} ${plural(attention.length, "repo")} need${attention.length === 1 ? "s" : ""} attention`,
    detail: `Lowest health scores: ${worst.map((repo) => `${repo.fullName} (${repo.grade})`).join(", ")}.`,
    recommendation: "Triage the lowest-graded repos and fix their weakest health components.",
  };
}

/** Meaningful AI-authoring adoption, with a cycle-time comparison when known. */
function detectAiAdoption(intel: EngineeringIntelligence): Insight | undefined {
  const ai = intel.aiImpact;
  if (ai.aiMergedPRs < 5 || ai.aiShare < 0.2) return undefined;

  let detail = `AI tools authored ${fmtPct(ai.aiShare)} of merged PRs (${ai.aiMergedPRs} PRs).`;
  if (ai.aiMedianCycleHours > 0 && ai.humanMedianCycleHours > 0) {
    const comparison =
      ai.aiMedianCycleHours < ai.humanMedianCycleHours
        ? "merge faster than"
        : ai.aiMedianCycleHours > ai.humanMedianCycleHours
          ? "merge slower than"
          : "merge at the same pace as";
    detail += ` AI-authored PRs ${comparison} human-authored ones (${fmtHours(ai.aiMedianCycleHours)} vs ${fmtHours(ai.humanMedianCycleHours)} median cycle).`;
  }
  return {
    id: "ai-adoption",
    severity: "info",
    title: "AI authorship is a significant share of merges",
    detail,
  };
}

/** Repos with historical merges and open work but nothing merged in 60 days. */
function detectStaleRepos(metrics: OrgMetrics): Insight | undefined {
  const endMs = Date.parse(metrics.collectedAt);
  const cutoffMs = endMs - 60 * DAY_MS;
  const stale: string[] = [];

  for (const repo of metrics.repos) {
    const timeline = repo.mergedPRTimeline ?? [];
    if (timeline.length === 0) continue;
    const hasRecentMerge = timeline.some((pr) => Date.parse(pr.mergedAt) >= cutoffMs);
    if (hasRecentMerge) continue;
    if (repo.issues.open < 1 && repo.pullRequests.open < 1) continue;
    stale.push(repo.fullName);
  }
  if (stale.length === 0) return undefined;
  return {
    id: "stale-repos",
    severity: "info",
    title: `${stale.length} stale ${plural(stale.length, "repo")} with open work`,
    detail: `No merges in over 60 days despite open issues or PRs: ${listSome(stale)}.`,
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Run all insight detectors over collected metrics and pre-computed analytics.
 *
 * Each detector contributes at most one insight. Results are sorted by
 * severity (critical → warning → info → positive) and, within a severity, by
 * the fixed detector order, so output is deterministic.
 */
export function computeInsights(
  metrics: OrgMetrics,
  inputs: InsightInputs
): InsightsSummary {
  const { intel, dora, review, health, collaboration, targets } = inputs;
  const windows = splitTrendWindows(metrics);
  const hasReviewSignal = metrics.repos.some((repo) =>
    (repo.mergedPRTimeline ?? []).some((pr) => pr.reviewers !== undefined)
  );

  const candidates: Array<Insight | undefined> = [
    // Team-set targets rank first within their severity band — they are the
    // team's own bar, not a generic heuristic.
    detectTargetsMissed(targets),
    detectReviewBottleneck(review),
    detectLowReviewCoverage(review, hasReviewSignal),
    detectSlowFirstReview(review),
    detectBusFactor(collaboration),
    detectKnowledgeSilos(collaboration),
    detectCycleTimeTrend(windows),
    detectThroughputTrend(windows),
    detectPRSizeTrend(windows),
    detectMergeAnomaly(metrics),
    detectIssueInfluxAnomaly(metrics),
    detectChangeFailure(dora),
    detectTargetsMet(targets),
    detectDoraElite(dora),
    detectUnhealthyRepos(health),
    detectAiAdoption(intel),
    detectStaleRepos(metrics),
  ];

  const insights = candidates.filter((insight): insight is Insight => insight !== undefined);
  // Stable sort: detector order is preserved within each severity band.
  insights.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  const counts: Record<InsightSeverity, number> = {
    critical: 0,
    warning: 0,
    info: 0,
    positive: 0,
  };
  for (const insight of insights) counts[insight.severity]++;

  return {
    hasData:
      intel.hasData ||
      dora.hasData ||
      review.hasData ||
      health.hasData ||
      collaboration.hasData,
    insights,
    counts,
  };
}
