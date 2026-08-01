import type {
  CopilotAiAdoptionPhaseImpact,
  CopilotRepositoryUsageMetrics,
  CopilotUsageMetrics,
} from "./types.js";
import {
  computeCopilotAdoptionImpact,
  copilotAdoptionPhaseLabel,
  sortCopilotRepositoryUsage,
} from "./copilot-impact.js";

function phase(
  phaseNumber: number,
  totalEngagedUsers: number,
  avgPullRequestsMerged: number,
): CopilotAiAdoptionPhaseImpact {
  return {
    phaseNumber,
    phase: phaseNumber === 0 ? "No Cohort" : `Phase ${phaseNumber}`,
    totalEngagedUsers,
    avgUserInitiatedInteractions: 0,
    avgCodeGenerationActivities: 0,
    avgCodeAcceptanceActivities: 0,
    avgLocAdded: 0,
    avgLocDeleted: 0,
    avgPullRequestsReviewed: 0,
    avgPullRequestsCreated: 0,
    avgPullRequestsMerged,
    totalPullRequestsMerged: totalEngagedUsers * avgPullRequestsMerged,
    avgPullRequestsMedianMinutesToMerge: 0,
  };
}

function usageWithPhases(
  day: string,
  phases: CopilotAiAdoptionPhaseImpact[],
): CopilotUsageMetrics {
  return {
    scope: "organization",
    scopeName: "example",
    collectedAt: "2026-07-23T00:00:00Z",
    totals: {
      totalUsers: 0,
      activeUsers: 0,
      chatUsers: 0,
      agentUsers: 0,
      cliUsers: 0,
      codeReviewActiveUsers: 0,
      codeReviewPassiveUsers: 0,
      assignedSeats: 0,
      seatsActiveThisCycle: 0,
      userInitiatedInteractions: 0,
      codeGenerations: 0,
      codeAcceptances: 0,
      locSuggestedToAdd: 0,
      locSuggestedToDelete: 0,
      locAdded: 0,
      locDeleted: 0,
      acceptanceRate: 0,
    },
    cli: { sessionCount: 0, requestCount: 0, promptCount: 0, promptTokens: 0, outputTokens: 0, avgTokensPerRequest: 0 },
    pullRequests: {
      totalCreated: 0,
      totalReviewed: 0,
      totalMerged: 0,
      medianMinutesToMerge: null,
      totalSuggestions: 0,
      totalAppliedSuggestions: 0,
      totalCreatedByCopilot: 0,
      totalReviewedByCopilot: 0,
      totalMergedCreatedByCopilot: 0,
      totalMergedReviewedByCopilot: 0,
      medianMinutesToMergeCopilotAuthored: null,
      medianMinutesToMergeCopilotReviewed: null,
      totalCopilotSuggestions: 0,
      totalCopilotAppliedSuggestions: 0,
      copilotSuggestionsByCommentType: [],
    },
    codeReview: { dailyActiveUsers: 0, dailyPassiveUsers: 0, weeklyActiveUsers: 0, weeklyPassiveUsers: 0, monthlyActiveUsers: 0, monthlyPassiveUsers: 0 },
    users: [],
    dailyTotals: [{
      day,
      dailyActiveUsers: 0,
      weeklyActiveUsers: 0,
      monthlyActiveUsers: 0,
      dailyActiveCliUsers: 0,
      dailyActiveChatUsers: 0,
      dailyActiveAgentUsers: 0,
      weeklyActiveChatUsers: 0,
      weeklyActiveAgentUsers: 0,
      monthlyActiveChatUsers: 0,
      monthlyActiveAgentUsers: 0,
      codeReview: { dailyActiveUsers: 0, dailyPassiveUsers: 0, weeklyActiveUsers: 0, weeklyPassiveUsers: 0, monthlyActiveUsers: 0, monthlyPassiveUsers: 0 },
      cli: { sessionCount: 0, requestCount: 0, promptCount: 0, promptTokens: 0, outputTokens: 0, avgTokensPerRequest: 0 },
      pullRequests: {
        totalCreated: 0,
        totalReviewed: 0,
        totalMerged: 0,
        medianMinutesToMerge: null,
        totalSuggestions: 0,
        totalAppliedSuggestions: 0,
        totalCreatedByCopilot: 0,
        totalReviewedByCopilot: 0,
        totalMergedCreatedByCopilot: 0,
        totalMergedReviewedByCopilot: 0,
        medianMinutesToMergeCopilotAuthored: null,
        medianMinutesToMergeCopilotReviewed: null,
        totalCopilotSuggestions: 0,
        totalCopilotAppliedSuggestions: 0,
        copilotSuggestionsByCommentType: [],
      },
      aiAdoptionPhases: phases,
      userInitiatedInteractions: 0,
      codeGenerations: 0,
      codeAcceptances: 0,
      locSuggestedToAdd: 0,
      locSuggestedToDelete: 0,
      locAdded: 0,
      locDeleted: 0,
      acceptanceRate: 0,
    }],
    byFeature: [],
    byIde: [],
    byLanguage: [],
    byModel: [],
    byTeam: [],
    byLanguageFeature: [],
    byLanguageModel: [],
    byModelFeature: [],
    ideVersions: [],
  };
}

describe("Copilot impact summaries", () => {
  it("uses the latest phase snapshot and user-weights engaged averages", () => {
    const usage = usageWithPhases("2026-07-22", [phase(0, 10, 1), phase(1, 5, 2), phase(3, 15, 4)]);
    usage.dailyTotals.unshift({ ...usage.dailyTotals[0], day: "2026-07-21", aiAdoptionPhases: [phase(0, 100, 10)] });

    expect(computeCopilotAdoptionImpact(usage)).toMatchObject({
      day: "2026-07-22",
      totalUsers: 30,
      engagedUsers: 20,
      engagedShare: 2 / 3,
      engagedAvgPullRequestsMerged: 3.5,
      passiveAvgPullRequestsMerged: 1,
      mergedPullRequestAssociation: 3.5,
    });
  });

  it("omits the association when the passive denominator is zero", () => {
    const summary = computeCopilotAdoptionImpact(
      usageWithPhases("2026-07-22", [phase(0, 10, 0), phase(2, 5, 3)]),
    );

    expect(summary?.mergedPullRequestAssociation).toBeUndefined();
    expect(copilotAdoptionPhaseLabel(phase(0, 10, 0))).toBe("Passive users");
    expect(copilotAdoptionPhaseLabel(phase(3, 10, 2))).toBe("Phase 3: Multi-agent");
  });

  it("uses exact merged-PR totals instead of rounded phase averages", () => {
    const passive = phase(0, 3, 0.3);
    passive.totalPullRequestsMerged = 1;
    const engaged = phase(1, 3, 0.7);
    engaged.totalPullRequestsMerged = 2;

    expect(computeCopilotAdoptionImpact(
      usageWithPhases("2026-07-22", [passive, engaged]),
    )).toMatchObject({
      passiveAvgPullRequestsMerged: 1 / 3,
      engagedAvgPullRequestsMerged: 2 / 3,
      mergedPullRequestAssociation: 2,
    });
  });

  it("sorts repositories by Copilot activity and keeps owner-qualified names", () => {
    const makeRepository = (fullName: string, copilotActivity: number): CopilotRepositoryUsageMetrics => ({
      day: "2026-07-22",
      organizationId: "1",
      repoId: fullName,
      owner: fullName.split("/")[0],
      name: fullName.split("/")[1],
      fullName,
      visibility: "PRIVATE",
      pullRequests: {
        totalCreated: 1,
        totalReviewed: 1,
        totalMerged: 1,
        medianMinutesToMerge: null,
        totalSuggestions: 0,
        totalAppliedSuggestions: 0,
        totalCreatedByCopilot: copilotActivity,
        totalReviewedByCopilot: 0,
        totalMergedCreatedByCopilot: 0,
        totalMergedReviewedByCopilot: 0,
        medianMinutesToMergeCopilotAuthored: null,
        medianMinutesToMergeCopilotReviewed: null,
        totalCopilotSuggestions: 0,
        totalCopilotAppliedSuggestions: 0,
        copilotSuggestionsByCommentType: [],
      },
    });

    expect(sortCopilotRepositoryUsage([
      makeRepository("beta/api", 1),
      makeRepository("alpha/api", 3),
    ]).map((repository) => repository.fullName)).toEqual(["alpha/api", "beta/api"]);
  });
});
