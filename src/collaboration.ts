/**
 * Collaboration-network analytics.
 *
 * Pure, side-effect-free derivations from the `mergedPRTimeline` review data
 * that `collect` already gathers for every repo: author→reviewer edges,
 * reviewer-load concentration (Gini), per-repo bus factors, and siloed
 * contributors. Human-authored merged PRs only — no additional API calls.
 */
import type {
  OrgMetrics,
  CollaborationStats,
  CollaborationEdge,
  RepoBusFactor,
} from "./types.js";
import { attribute, isLikelyBot } from "./developer-stats.js";

/** Maximum number of author→reviewer edges returned. */
const MAX_EDGES = 25;

/**
 * Reviewer logins to exclude from collaboration analytics.
 *
 * Replicates the (unexported) `isExcludedReviewer` in dora.ts: the defensive
 * `isLikelyBot` heuristic plus logins whose lowercase is exactly "copilot" —
 * Copilot code review can surface as a bare `Copilot` login without the
 * `[bot]` suffix.
 */
function isExcludedReviewer(login: string): boolean {
  return isLikelyBot(login) || login.toLowerCase() === "copilot";
}

/**
 * Gini coefficient over a set of non-negative counts using the standard
 * ascending-sorted formula G = (2·Σᵢ i·xᵢ)/(n·Σxᵢ) − (n+1)/n with i starting
 * at 1. Returns 0 when fewer than 2 values or when the total is 0.
 */
function gini(counts: number[]): number {
  const n = counts.length;
  if (n < 2) return 0;
  const sorted = [...counts].sort((a, b) => a - b);
  let sum = 0;
  let weightedSum = 0;
  for (let i = 0; i < n; i++) {
    sum += sorted[i];
    weightedSum += (i + 1) * sorted[i];
  }
  if (sum === 0) return 0;
  // Clamp at 0: a perfectly even distribution can leave -0/-ε residue.
  return Math.max(0, (2 * weightedSum) / (n * sum) - (n + 1) / n);
}

/** Round to 4 decimals to keep ratio outputs free of floating-point noise. */
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Compute collaboration-network analytics from collected org metrics.
 *
 * Folds over every repo's `mergedPRTimeline`, considering only PRs attributed
 * to human authors (bot- and AI-authored PRs are excluded everywhere).
 * Reviewer-based outputs (edges, Gini, distinct reviewers) additionally drop
 * self-reviews and bot/Copilot reviewer logins; PRs without reviewer data
 * (REST-sourced timelines) still count toward bus factors and author stats.
 */
export function computeCollaborationStats(metrics: OrgMetrics): CollaborationStats {
  // author → reviewer → distinct merged-PR count.
  const edgeCounts = new Map<string, Map<string, number>>();
  // reviewer → distinct merged PRs reviewed (human-authored PRs only).
  const reviewerCounts = new Map<string, number>();
  // repo fullName → author → human merged-PR count.
  const repoAuthorCounts = new Map<string, Map<string, number>>();
  // author → org-wide merge count and set of repos merged into.
  const authorTotals = new Map<string, { prs: number; repos: Set<string> }>();

  for (const repo of metrics.repos) {
    for (const pr of repo.mergedPRTimeline ?? []) {
      if (attribute(pr) !== "human") continue;
      const author = pr.author?.trim();
      if (!author) continue;

      // Per-repo author counts (bus factors).
      const byAuthor = repoAuthorCounts.get(repo.fullName) ?? new Map<string, number>();
      byAuthor.set(author, (byAuthor.get(author) ?? 0) + 1);
      repoAuthorCounts.set(repo.fullName, byAuthor);

      // Org-wide author totals (siloed contributors, distinct authors).
      const totals = authorTotals.get(author) ?? { prs: 0, repos: new Set<string>() };
      totals.prs++;
      totals.repos.add(repo.fullName);
      authorTotals.set(author, totals);

      // Reviewer edges — distinct per PR so a double-listed login counts once.
      const distinctReviewers = new Set(
        (pr.reviewers ?? []).map((login) => login.trim()).filter((login) => login.length > 0)
      );
      for (const reviewer of distinctReviewers) {
        if (reviewer === author || isExcludedReviewer(reviewer)) continue;
        reviewerCounts.set(reviewer, (reviewerCounts.get(reviewer) ?? 0) + 1);
        const byReviewer = edgeCounts.get(author) ?? new Map<string, number>();
        byReviewer.set(reviewer, (byReviewer.get(reviewer) ?? 0) + 1);
        edgeCounts.set(author, byReviewer);
      }
    }
  }

  // Flatten, sort, and cap the edge list.
  const edges: CollaborationEdge[] = [];
  for (const [author, byReviewer] of edgeCounts) {
    for (const [reviewer, prCount] of byReviewer) {
      edges.push({ author, reviewer, prCount });
    }
  }
  edges.sort(
    (a, b) =>
      b.prCount - a.prCount ||
      a.author.localeCompare(b.author) ||
      a.reviewer.localeCompare(b.reviewer)
  );
  const topEdges = edges.slice(0, MAX_EDGES);

  // Per-repo bus factors (repos with ≥5 human-authored merged PRs).
  const busFactors: RepoBusFactor[] = [];
  for (const [fullName, byAuthor] of repoAuthorCounts) {
    let mergedPRs = 0;
    for (const count of byAuthor.values()) mergedPRs += count;
    if (mergedPRs < 5) continue;

    const counts = [...byAuthor.values()].sort((a, b) => b - a);
    let covered = 0;
    let busFactor = 0;
    for (const count of counts) {
      covered += count;
      busFactor++;
      if (covered >= mergedPRs * 0.5) break;
    }
    busFactors.push({
      fullName,
      busFactor,
      topAuthorShare: round4(counts[0] / mergedPRs),
      mergedPRs,
    });
  }
  busFactors.sort(
    (a, b) =>
      a.busFactor - b.busFactor ||
      b.topAuthorShare - a.topAuthorShare ||
      a.fullName.localeCompare(b.fullName)
  );

  // Siloed contributors: only meaningful when ≥2 repos have human merges.
  const activeRepos = repoAuthorCounts.size;
  const siloedContributors =
    activeRepos >= 2
      ? [...authorTotals.entries()]
          .filter(([, totals]) => totals.prs >= 3 && totals.repos.size === 1)
          .map(([login]) => login)
          .sort((a, b) => a.localeCompare(b))
      : [];

  return {
    hasData: authorTotals.size > 0,
    edges: topEdges,
    reviewerGini: round4(gini([...reviewerCounts.values()])),
    busFactors,
    siloedContributors,
    distinctAuthors: authorTotals.size,
    distinctReviewers: reviewerCounts.size,
  };
}
