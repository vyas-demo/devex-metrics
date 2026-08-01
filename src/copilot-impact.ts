import type {
  CopilotAdoptionImpactSummary,
  CopilotAiAdoptionPhaseImpact,
  CopilotRepositoryUsageMetrics,
  CopilotUsageMetrics,
} from "./types.js";

/** Build the latest aggregate-day Copilot adoption and delivery-association summary. */
export function computeCopilotAdoptionImpact(
  usage: CopilotUsageMetrics,
): CopilotAdoptionImpactSummary | undefined {
  const latest = [...usage.dailyTotals]
    .filter((row) => (row.aiAdoptionPhases?.length ?? 0) > 0)
    .sort((a, b) => b.day.localeCompare(a.day))[0];
  if (!latest?.aiAdoptionPhases) return undefined;

  const phases = [...latest.aiAdoptionPhases].sort((a, b) => a.phaseNumber - b.phaseNumber);
  const passive = phases.filter((phase) => phase.phaseNumber === 0);
  const engaged = phases.filter((phase) => phase.phaseNumber > 0);
  const totalUsers = sumUsers(phases);
  const engagedUsers = sumUsers(engaged);
  const passiveAvgPullRequestsMerged = mergedPullRequestsPerUser(passive);
  const engagedAvgPullRequestsMerged = mergedPullRequestsPerUser(engaged);
  const mergedPullRequestAssociation =
    passiveAvgPullRequestsMerged !== undefined &&
    passiveAvgPullRequestsMerged > 0 &&
    engagedAvgPullRequestsMerged !== undefined
      ? engagedAvgPullRequestsMerged / passiveAvgPullRequestsMerged
      : undefined;

  return {
    day: latest.day,
    phases,
    totalUsers,
    engagedUsers,
    engagedShare: totalUsers > 0 ? engagedUsers / totalUsers : 0,
    engagedAvgPullRequestsMerged,
    passiveAvgPullRequestsMerged,
    mergedPullRequestAssociation,
  };
}

/** User-facing label for one GitHub Copilot adoption phase. */
export function copilotAdoptionPhaseLabel(phase: CopilotAiAdoptionPhaseImpact): string {
  if (phase.phaseNumber === 0 || phase.phase === "No Cohort") return "Passive users";
  const descriptions: Record<number, string> = {
    1: "Code first",
    2: "Agent first",
    3: "Multi-agent",
  };
  const description = descriptions[phase.phaseNumber];
  return description ? `${phase.phase}: ${description}` : phase.phase;
}

/** Sort sparse daily repository rows by Copilot-related activity, then total PR activity. */
export function sortCopilotRepositoryUsage(
  repositories: CopilotRepositoryUsageMetrics[],
): CopilotRepositoryUsageMetrics[] {
  return [...repositories].sort((a, b) =>
    repositoryCopilotActivity(b) - repositoryCopilotActivity(a) ||
    repositoryTotalActivity(b) - repositoryTotalActivity(a) ||
    a.fullName.localeCompare(b.fullName, undefined, { sensitivity: "base" }),
  );
}

function sumUsers(phases: CopilotAiAdoptionPhaseImpact[]): number {
  return phases.reduce((sum, phase) => sum + phase.totalEngagedUsers, 0);
}

function mergedPullRequestsPerUser(
  phases: CopilotAiAdoptionPhaseImpact[],
): number | undefined {
  const users = sumUsers(phases);
  if (users <= 0) return undefined;
  return phases.reduce((sum, phase) => sum + phase.totalPullRequestsMerged, 0) / users;
}

function repositoryCopilotActivity(repository: CopilotRepositoryUsageMetrics): number {
  const pullRequests = repository.pullRequests;
  return (
    pullRequests.totalCreatedByCopilot +
    pullRequests.totalReviewedByCopilot +
    pullRequests.totalMergedCreatedByCopilot +
    pullRequests.totalMergedReviewedByCopilot +
    pullRequests.totalCopilotAppliedSuggestions
  );
}

function repositoryTotalActivity(repository: CopilotRepositoryUsageMetrics): number {
  const pullRequests = repository.pullRequests;
  return pullRequests.totalCreated + pullRequests.totalReviewed + pullRequests.totalMerged;
}
