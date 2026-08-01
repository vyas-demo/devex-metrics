/**
 * Repository health scores.
 *
 * Pure, side-effect-free derivations from the merged-PR-timeline, push, and
 * issue-count data that `collect` already gathers for every repo. Each repo
 * is scored on six weighted components (activity, review coverage, cycle
 * time, change failure, contributor redundancy, issue backlog). A component
 * whose underlying signal is absent gets `score: undefined` and is excluded
 * from the weighted mean rather than penalized. No additional API calls.
 */
import type {
  OrgMetrics,
  RepoMetrics,
  HealthComponent,
  HealthGrade,
  HealthReport,
  RepoHealth,
} from "./types.js";
import { attribute, median } from "./developer-stats.js";

/** Options for `computeHealthReport`. */
export interface HealthReportOptions {
  /**
   * ISO-8601 end-of-analysis timestamp used by the activity component.
   * Defaults to `metrics.collectedAt` (NOT the wall clock) so results are
   * deterministic for a given collection.
   */
  now?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Activity: days since the latest merge/push signal.
const ACTIVITY_FULL_DAYS = 7;
const ACTIVITY_ZERO_DAYS = 180;
// Cycle time: median created→merged hours, log-interpolated in between.
const CYCLE_FULL_HOURS = 24;
const CYCLE_ZERO_HOURS = 336;
// Change failure: revert rate at which the score bottoms out, and the
// minimum merged-PR sample below which the signal is considered absent.
const CFR_ZERO_SCORE_RATE = 0.15;
const CFR_MIN_MERGED_PRS = 5;
// Backlog: open/(open+closed) ratio thresholds and minimum issue sample.
const BACKLOG_FULL_RATIO = 0.2;
const BACKLOG_ZERO_RATIO = 0.8;
const BACKLOG_MIN_ISSUES = 5;
// Composite score below which a repo (with activity) needs attention.
const NEEDS_ATTENTION_BELOW = 55;

function clampScore(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * Letter grade for a 0–100 composite health score:
 * A ≥85, B ≥70, C ≥55, D ≥40, F otherwise.
 */
export function healthGrade(score: number): HealthGrade {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

// ── Component scorers ─────────────────────────────────────────────────────────

/**
 * Activity (weight 3): days since the latest signal, where the latest signal
 * is the max of the newest merged-PR timestamp and `pushedAt`. ≤7 days → 100,
 * ≥180 days → 0, linear in between. No signal at all → undefined.
 */
function activityComponent(repo: RepoMetrics, nowMs: number): HealthComponent {
  const base = { id: "activity", label: "Activity", weight: 3 };

  let latestMs: number | undefined;
  const consider = (iso: string | undefined): void => {
    if (!iso) return;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return;
    if (latestMs === undefined || t > latestMs) latestMs = t;
  };
  consider(repo.pushedAt);
  for (const pr of repo.mergedPRTimeline ?? []) consider(pr.mergedAt);

  if (latestMs === undefined) {
    return { ...base, detail: "No merge or push activity recorded" };
  }

  const days = Math.max(0, (nowMs - latestMs) / DAY_MS);
  const score =
    days <= ACTIVITY_FULL_DAYS
      ? 100
      : days >= ACTIVITY_ZERO_DAYS
        ? 0
        : (100 * (ACTIVITY_ZERO_DAYS - days)) /
          (ACTIVITY_ZERO_DAYS - ACTIVITY_FULL_DAYS);
  const roundedDays = Math.round(days);
  return {
    ...base,
    score: Math.round(score),
    detail: `Last activity ${roundedDays} ${roundedDays === 1 ? "day" : "days"} ago`,
  };
}

/**
 * Review coverage (weight 2): over merged PRs whose `reviewers` array is
 * defined (GraphQL-sourced; the REST fallback leaves it undefined), the share
 * with at least one reviewer, ×100. No PR with review data → undefined.
 */
function reviewCoverageComponent(repo: RepoMetrics): HealthComponent {
  const base = { id: "review-coverage", label: "Review coverage", weight: 2 };

  const withData = (repo.mergedPRTimeline ?? []).filter(
    (pr) => pr.reviewers !== undefined
  );
  if (withData.length === 0) {
    return { ...base, detail: "No review data in timeline (REST-sourced)" };
  }

  const reviewed = withData.filter((pr) => (pr.reviewers ?? []).length > 0).length;
  const pct = Math.round((100 * reviewed) / withData.length);
  return {
    ...base,
    score: pct,
    detail: `${reviewed} of ${withData.length} merged PRs reviewed (${pct}%)`,
  };
}

/**
 * Cycle time (weight 2): median created→merged hours over human-authored
 * merged PRs with a positive merge time. Log-scale score: median ≤24h → 100,
 * ≥336h → 0, linearly interpolated in log-space in between. No qualifying
 * PR → undefined.
 */
function cycleTimeComponent(repo: RepoMetrics): HealthComponent {
  const base = { id: "cycle-time", label: "Cycle time", weight: 2 };

  const cycles = (repo.mergedPRTimeline ?? [])
    .filter((pr) => attribute(pr) === "human" && pr.timeToMergeHours > 0)
    .map((pr) => pr.timeToMergeHours);
  if (cycles.length === 0) {
    return { ...base, detail: "No human-authored merged PRs with timing data" };
  }

  const medianHours = median(cycles);
  const raw =
    100 *
    (1 -
      (Math.log(medianHours) - Math.log(CYCLE_FULL_HOURS)) /
        (Math.log(CYCLE_ZERO_HOURS) - Math.log(CYCLE_FULL_HOURS)));
  return {
    ...base,
    score: Math.round(clampScore(raw)),
    detail: `median ${Math.round(medianHours)}h created→merged`,
  };
}

/**
 * Change failure (weight 2): revert rate over the merged-PR timeline
 * (`isRevert` PRs ÷ all merged PRs). Rate 0 → 100, ≥0.15 → 0, linear in
 * between. Fewer than 5 merged PRs → undefined (sample too small).
 */
function changeFailureComponent(repo: RepoMetrics): HealthComponent {
  const base = { id: "change-failure", label: "Change failure", weight: 2 };

  const timeline = repo.mergedPRTimeline ?? [];
  if (timeline.length < CFR_MIN_MERGED_PRS) {
    return {
      ...base,
      detail: `Fewer than ${CFR_MIN_MERGED_PRS} merged PRs (${timeline.length})`,
    };
  }

  const reverts = timeline.filter((pr) => pr.isRevert === true).length;
  const rate = reverts / timeline.length;
  const raw =
    rate >= CFR_ZERO_SCORE_RATE ? 0 : 100 * (1 - rate / CFR_ZERO_SCORE_RATE);
  return {
    ...base,
    score: Math.round(raw),
    detail: `${Math.round(rate * 100)}% revert rate over ${timeline.length} merged PRs`,
  };
}

/** Redundancy score for a distinct human author count (≥5 → 100). */
function redundancyScore(authorCount: number): number {
  if (authorCount >= 5) return 100;
  if (authorCount === 4) return 90;
  if (authorCount === 3) return 75;
  if (authorCount === 2) return 55;
  return 25;
}

/**
 * Contributor redundancy (weight 2): distinct human authors in the merged-PR
 * timeline, mapped 1→25, 2→55, 3→75, 4→90, ≥5→100 (a bus-factor proxy).
 * No human merged PRs → undefined.
 */
function redundancyComponent(repo: RepoMetrics): HealthComponent {
  const base = { id: "redundancy", label: "Contributor redundancy", weight: 2 };

  const authors = new Set<string>();
  for (const pr of repo.mergedPRTimeline ?? []) {
    if (attribute(pr) === "human" && pr.author.trim().length > 0) {
      authors.add(pr.author);
    }
  }
  if (authors.size === 0) {
    return { ...base, detail: "No human-authored merged PRs" };
  }

  return {
    ...base,
    score: redundancyScore(authors.size),
    detail: `${authors.size} distinct human ${authors.size === 1 ? "author" : "authors"}`,
  };
}

/**
 * Issue backlog (weight 1): open/(open+closed) issue ratio. ≤0.2 → 100,
 * ≥0.8 → 0, linear in between. Fewer than 5 issues total → undefined.
 */
function backlogComponent(repo: RepoMetrics): HealthComponent {
  const base = { id: "backlog", label: "Issue backlog", weight: 1 };

  const total = repo.issues.open + repo.issues.closed;
  if (total < BACKLOG_MIN_ISSUES) {
    return { ...base, detail: `Fewer than ${BACKLOG_MIN_ISSUES} tracked issues (${total})` };
  }

  const ratio = repo.issues.open / total;
  const score =
    ratio <= BACKLOG_FULL_RATIO
      ? 100
      : ratio >= BACKLOG_ZERO_RATIO
        ? 0
        : (100 * (BACKLOG_ZERO_RATIO - ratio)) /
          (BACKLOG_ZERO_RATIO - BACKLOG_FULL_RATIO);
  return {
    ...base,
    score: Math.round(score),
    detail: `${repo.issues.open} open of ${total} tracked issues (${Math.round(ratio * 100)}% open)`,
  };
}

// ── Report ────────────────────────────────────────────────────────────────────

/**
 * Compute per-repo health scores from collected org metrics.
 *
 * Each repo's composite score is the weighted mean of its components that
 * have data, rounded to a whole number; a repo where no component has data is
 * excluded entirely. Repos are sorted worst-first (score ascending, ties by
 * fullName). `needsAttention` flags repos scoring below 55 that still show
 * signs of life (≥1 merged PR in the timeline or ≥1 open issue) — a dead
 * archive is not actionable, a struggling active repo is.
 */
export function computeHealthReport(
  metrics: OrgMetrics,
  options?: HealthReportOptions
): HealthReport {
  const nowMs = Date.parse(options?.now ?? metrics.collectedAt);
  const repos: RepoHealth[] = [];

  for (const repo of metrics.repos) {
    const components: HealthComponent[] = [
      activityComponent(repo, nowMs),
      reviewCoverageComponent(repo),
      cycleTimeComponent(repo),
      changeFailureComponent(repo),
      redundancyComponent(repo),
      backlogComponent(repo),
    ];

    let weightedSum = 0;
    let weightTotal = 0;
    for (const component of components) {
      if (component.score === undefined) continue;
      weightedSum += component.score * component.weight;
      weightTotal += component.weight;
    }
    // No component had data → nothing to say about this repo; skip it.
    if (weightTotal === 0) continue;

    const score = Math.round(weightedSum / weightTotal);
    const showsActivity =
      (repo.mergedPRTimeline ?? []).length > 0 || repo.issues.open > 0;

    repos.push({
      fullName: repo.fullName,
      score,
      grade: healthGrade(score),
      components,
      needsAttention: score < NEEDS_ATTENTION_BELOW && showsActivity,
    });
  }

  repos.sort((a, b) => a.score - b.score || a.fullName.localeCompare(b.fullName));

  const avgScore =
    repos.length > 0
      ? Math.round(repos.reduce((sum, r) => sum + r.score, 0) / repos.length)
      : 0;

  return { hasData: repos.length > 0, repos, avgScore };
}
