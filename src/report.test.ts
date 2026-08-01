import { describe, it, expect } from "vitest";
import { generateReport } from "./report.js";
import type { OrgMetrics } from "./types.js";

function makeSampleMetrics(): OrgMetrics {
  return {
    owner: "test-org",
    ownerType: "org",
    collectedAt: "2026-03-28T12:00:00Z",
    repoCount: 2,
    repos: [
      {
        name: "repo-a",
        fullName: "test-org/repo-a",
        issues: { open: 5, closed: 20 },
        pullRequests: { open: 2, closed: 1, merged: 15 },
        pullRequestDetails: [
          {
            number: 42,
            title: "Add feature X",
            state: "merged",
            createdAt: "2026-03-01T00:00:00Z",
            author: "dev1",
            isCopilotAuthored: false,
            hasCopilotReview: true,
            linesAdded: 120,
            linesDeleted: 30,
            commentCount: 8,
            commitCount: 3,
            actionsMinutes: 4.5,
            timeToMergeHours: 48,
            mergedAt: "2026-03-03T00:00:00Z",
          },
        ],
        mergedPRTimeline: [
          { number: 42, createdAt: "2026-03-01T00:00:00Z", mergedAt: "2026-03-03T00:00:00Z", author: "dev1", isBotAuthor: false, isCopilotAuthored: false, timeToMergeHours: 48, closesIssues: [] },
          { number: 43, createdAt: "2026-03-02T00:00:00Z", mergedAt: "2026-03-04T00:00:00Z", author: "copilot[bot]", isBotAuthor: true, isCopilotAuthored: true, timeToMergeHours: 48, closesIssues: [] },
        ],
        copilotAdoption: { copilotAuthoredPRs: 1, copilotReviewedPRs: 1, totalMergedPRs: 2, totalDetailedPRs: 1 },
        issueLeadTimes: [],
        committerCount: 4,
        reviewerCount: 3,
        contributorCount: 5,
        dependentCount: 10,
      },
      {
        name: "repo-b",
        fullName: "test-org/repo-b",
        issues: { open: 0, closed: 5 },
        pullRequests: { open: 0, closed: 0, merged: 3 },
        pullRequestDetails: [],
        mergedPRTimeline: [],
        copilotAdoption: { copilotAuthoredPRs: 0, copilotReviewedPRs: 0, totalMergedPRs: 0, totalDetailedPRs: 0 },
        issueLeadTimes: [],
        committerCount: 1,
        reviewerCount: 1,
        contributorCount: 1,
        dependentCount: 0,
      },
    ],
  };
}

describe("generateReport", () => {
  it("should produce a Markdown report with a summary", () => {
    const report = generateReport(makeSampleMetrics());

    expect(report).toContain("# DevEx Metrics – test-org");
    expect(report).toContain("Repositories | 2");
    expect(report).toContain("Open issues | 5");
    expect(report).toContain("Closed issues | 25");
    expect(report).toContain("Merged PRs | 18");
  });

  it("should include Copilot adoption metrics in the summary", () => {
    const report = generateReport(makeSampleMetrics());

    expect(report).toContain("Copilot-authored PRs | 1 (50.0%)");
    expect(report).toContain("Copilot-reviewed PRs | 1 (100.0%)");
  });

  it("should include median cycle time in the summary", () => {
    const report = generateReport(makeSampleMetrics());

    expect(report).toContain("Median cycle time");
  });

  it("should include developer insights and velocity metrics", () => {
    const metrics = makeSampleMetrics();
    metrics.weeklyTrends = [
      { week: "2026-W09", prsOpened: 2, prsMerged: 2, issuesOpened: 3, issuesClosed: 2, linesAdded: 120, linesDeleted: 30 },
      { week: "2026-W10", prsOpened: 1, prsMerged: 1, issuesOpened: 1, issuesClosed: 2, linesAdded: 80, linesDeleted: 20 },
    ];
    metrics.repos[0].issueLeadTimes = [
      {
        issueNumber: 101,
        issueCreatedAt: "2026-02-25T00:00:00Z",
        prNumber: 42,
        prMergedAt: "2026-03-03T00:00:00Z",
        leadTimeHours: 168,
      },
    ];

    const report = generateReport(metrics);

    expect(report).toContain("## Developer Insights");
    expect(report).toContain("PR throughput");
    expect(report).toContain("PR flow ratio");
    expect(report).toContain("Cycle predictability (p75 / p50)");
  });

  it("should include Copilot usage and per-user metrics", () => {
    const metrics = makeSampleMetrics();
    metrics.copilotUsage = {
      scope: "organization",
      scopeName: "test-org",
      reportStartDay: "2026-04-01",
      reportEndDay: "2026-04-28",
      collectedAt: "2026-04-29T00:00:00Z",
      totals: {
        totalUsers: 2,
        activeUsers: 2,
        chatUsers: 1,
        agentUsers: 1,
        cliUsers: 0,
        codeReviewActiveUsers: 0,
        codeReviewPassiveUsers: 0,
        assignedSeats: 2,
        seatsActiveThisCycle: 2,
        userInitiatedInteractions: 25,
        codeGenerations: 10,
        codeAcceptances: 5,
        locSuggestedToAdd: 40,
        locSuggestedToDelete: 5,
        locAdded: 30,
        locDeleted: 4,
        acceptanceRate: 50,
      },
      billing: {
        assignedSeats: 2,
        addedThisCycle: 0,
        pendingInvitation: 0,
        pendingCancellation: 0,
        activeThisCycle: 2,
        inactiveThisCycle: 0,
        seatManagementSetting: "assign_selected",
        ideChat: "enabled",
        platformChat: "enabled",
        cli: "enabled",
        publicCodeSuggestions: "block",
      },
      cli: {
        sessionCount: 1,
        requestCount: 3,
        promptCount: 2,
        promptTokens: 100,
        outputTokens: 300,
        avgTokensPerRequest: 133.33,
        lastKnownCliVersion: "1.0.8",
      },
      pullRequests: {
        totalCreated: 2,
        totalReviewed: 1,
        totalMerged: 1,
        medianMinutesToMerge: 90,
        totalSuggestions: 2,
        totalAppliedSuggestions: 1,
        totalCreatedByCopilot: 1,
        totalReviewedByCopilot: 1,
        totalMergedCreatedByCopilot: 1,
        totalMergedReviewedByCopilot: 1,
        medianMinutesToMergeCopilotAuthored: 90,
        medianMinutesToMergeCopilotReviewed: 90,
        totalCopilotSuggestions: 2,
        totalCopilotAppliedSuggestions: 1,
        copilotSuggestionsByCommentType: [
          { commentType: "bug_risk", totalCopilotSuggestions: 2, totalCopilotAppliedSuggestions: 1 },
        ],
      },
      codeReview: {
        dailyActiveUsers: 1,
        dailyPassiveUsers: 0,
        weeklyActiveUsers: 1,
        weeklyPassiveUsers: 0,
        monthlyActiveUsers: 1,
        monthlyPassiveUsers: 0,
      },
      repositoryReport: {
        reportDay: "2026-04-28",
        repositories: [
          {
            day: "2026-04-28",
            organizationId: "10",
            repoId: "101",
            owner: "test-org",
            name: "repo-a",
            fullName: "test-org/repo-a",
            visibility: "PRIVATE",
            pullRequests: {
              totalCreated: 3,
              totalReviewed: 2,
              totalMerged: 2,
              medianMinutesToMerge: null,
              totalSuggestions: 2,
              totalAppliedSuggestions: 1,
              totalCreatedByCopilot: 2,
              totalReviewedByCopilot: 1,
              totalMergedCreatedByCopilot: 1,
              totalMergedReviewedByCopilot: 1,
              medianMinutesToMergeCopilotAuthored: 60,
              medianMinutesToMergeCopilotReviewed: 80,
              totalCopilotSuggestions: 2,
              totalCopilotAppliedSuggestions: 1,
              copilotSuggestionsByCommentType: [],
            },
          },
        ],
      },
      users: [
        {
          login: "dev1",
          userId: "1",
          activeDays: 3,
          lastUsageDay: "2026-04-28",
          aiAdoptionPhase: { phaseNumber: 3, phase: "Phase 3", version: "2026-07" },
          teams: ["platform"],
          usedChat: true,
          usedAgent: false,
          usedCli: false,
          usedCodeReviewActive: false,
          usedCodeReviewPassive: false,
          userInitiatedInteractions: 15,
          codeGenerations: 6,
          codeAcceptances: 3,
          locSuggestedToAdd: 20,
          locSuggestedToDelete: 2,
          locAdded: 18,
          locDeleted: 1,
          acceptanceRate: 50,
        },
      ],
      dailyTotals: [
        {
          day: "2026-04-28",
          dailyActiveUsers: 2,
          weeklyActiveUsers: 2,
          monthlyActiveUsers: 2,
          dailyActiveCliUsers: 0,
          dailyActiveChatUsers: 1,
          dailyActiveAgentUsers: 1,
          weeklyActiveChatUsers: 1,
          weeklyActiveAgentUsers: 1,
          monthlyActiveChatUsers: 1,
          monthlyActiveAgentUsers: 1,
          codeReview: {
            dailyActiveUsers: 1,
            dailyPassiveUsers: 0,
            weeklyActiveUsers: 1,
            weeklyPassiveUsers: 0,
            monthlyActiveUsers: 1,
            monthlyPassiveUsers: 0,
          },
          cli: {
            sessionCount: 0,
            requestCount: 0,
            promptCount: 0,
            promptTokens: 0,
            outputTokens: 0,
            avgTokensPerRequest: 0,
          },
          pullRequests: {
            totalCreated: 2,
            totalReviewed: 1,
            totalMerged: 1,
            medianMinutesToMerge: 90,
            totalSuggestions: 2,
            totalAppliedSuggestions: 1,
            totalCreatedByCopilot: 1,
            totalReviewedByCopilot: 1,
            totalMergedCreatedByCopilot: 1,
            totalMergedReviewedByCopilot: 1,
            medianMinutesToMergeCopilotAuthored: 90,
            medianMinutesToMergeCopilotReviewed: 90,
            totalCopilotSuggestions: 2,
            totalCopilotAppliedSuggestions: 1,
            copilotSuggestionsByCommentType: [],
          },
          aiAdoptionPhases: [
            {
              phaseNumber: 0,
              phase: "No Cohort",
              totalEngagedUsers: 1,
              avgUserInitiatedInteractions: 5,
              avgCodeGenerationActivities: 2,
              avgCodeAcceptanceActivities: 1,
              avgLocAdded: 7,
              avgLocDeleted: 1,
              avgPullRequestsReviewed: 1,
              avgPullRequestsCreated: 1,
              avgPullRequestsMerged: 1,
              totalPullRequestsMerged: 1,
              avgPullRequestsMedianMinutesToMerge: 120,
            },
            {
              phaseNumber: 3,
              phase: "Phase 3",
              totalEngagedUsers: 1,
              avgUserInitiatedInteractions: 20,
              avgCodeGenerationActivities: 8,
              avgCodeAcceptanceActivities: 4,
              avgLocAdded: 23,
              avgLocDeleted: 3,
              avgPullRequestsReviewed: 3,
              avgPullRequestsCreated: 3,
              avgPullRequestsMerged: 3,
              totalPullRequestsMerged: 3,
              avgPullRequestsMedianMinutesToMerge: 60,
            },
          ],
          userInitiatedInteractions: 25,
          codeGenerations: 10,
          codeAcceptances: 5,
          locSuggestedToAdd: 40,
          locSuggestedToDelete: 5,
          locAdded: 30,
          locDeleted: 4,
          acceptanceRate: 50,
        },
      ],
      byFeature: [
        {
          name: "chat",
          users: 1,
          userInitiatedInteractions: 15,
          codeGenerations: 6,
          codeAcceptances: 3,
          locSuggestedToAdd: 20,
          locSuggestedToDelete: 2,
          locAdded: 18,
          locDeleted: 1,
          acceptanceRate: 50,
        },
      ],
      byIde: [],
      byLanguage: [
        { name: "typescript", users: 1, userInitiatedInteractions: 15, codeGenerations: 6, codeAcceptances: 3, locSuggestedToAdd: 20, locSuggestedToDelete: 2, locAdded: 18, locDeleted: 1, acceptanceRate: 50 },
      ],
      byModel: [
        { name: "gpt-5.4", users: 1, userInitiatedInteractions: 15, codeGenerations: 6, codeAcceptances: 3, locSuggestedToAdd: 20, locSuggestedToDelete: 2, locAdded: 18, locDeleted: 1, acceptanceRate: 50 },
      ],
      byTeam: [
        { name: "platform", users: 1, userInitiatedInteractions: 15, codeGenerations: 6, codeAcceptances: 3, locSuggestedToAdd: 20, locSuggestedToDelete: 2, locAdded: 18, locDeleted: 1, acceptanceRate: 50 },
      ],
      byLanguageFeature: [],
      byLanguageModel: [
        { name: "typescript / gpt-5.4", users: 1, userInitiatedInteractions: 15, codeGenerations: 6, codeAcceptances: 3, locSuggestedToAdd: 20, locSuggestedToDelete: 2, locAdded: 18, locDeleted: 1, acceptanceRate: 50 },
      ],
      byModelFeature: [],
      ideVersions: [
        { ide: "vscode", ideVersion: "1.104.0", pluginVersion: "0.31.0", users: 1 },
      ],
    };

    const report = generateReport(metrics);

    expect(report).toContain("Copilot active users | 2 / 2");
    expect(report).toContain("## Copilot Usage");
    expect(report).toContain("### Pull Request Activity");
    expect(report).toContain("### Adoption Depth and Delivery Association");
    expect(report).toContain("**3.00×** as many merged PRs");
    expect(report).toContain("| Passive users | 1 | 50.0% | 1.00 | 2.0h |");
    expect(report).toContain("### Latest Repository PR Activity");
    expect(report).toContain("| test-org/repo-a | private | 3 / 2 / 2 | 2 / 1 | 1 authored / 1 reviewed | Unavailable |");
    expect(report).toContain("CLI sessions / requests / prompts | 1 / 3 / 2");
    expect(report).toContain("### Language / Model Mix");
    expect(report).toContain("### IDE and Plugin Coverage");
    expect(report).toContain("### Per-User Usage");
    expect(report).toContain("| dev1 | Phase 3 | 3 | 15 | 6 / 3 | 50.0% | +18 / -1 | chat | 2026-04-28 |");
  });

  it("should list per-repo details", () => {
    const report = generateReport(makeSampleMetrics());

    expect(report).toContain("### test-org/repo-a");
    expect(report).toContain("### test-org/repo-b");
    expect(report).toContain("#42 Add feature X");
    expect(report).toContain("+120/-30");
  });

  it("should handle an empty repos list", () => {
    const metrics: OrgMetrics = {
      owner: "empty-org",
      ownerType: "org",
      collectedAt: "2026-03-28T12:00:00Z",
      repoCount: 0,
      repos: [],
    };
    const report = generateReport(metrics);
    expect(report).toContain("Repositories | 0");
  });

  it("should display pushedAt when present in the repo section", () => {
    const metrics: OrgMetrics = {
      owner: "test-org",
      ownerType: "org",
      collectedAt: "2026-03-28T12:00:00Z",
      repoCount: 1,
      repos: [
        {
          name: "pushed-repo",
          fullName: "test-org/pushed-repo",
          pushedAt: "2025-11-15T08:30:00Z",
          issues: { open: 0, closed: 0 },
          pullRequests: { open: 0, closed: 0, merged: 0 },
          pullRequestDetails: [],
          committerCount: 0,
          reviewerCount: 0,
          contributorCount: 0,
          dependentCount: 0,
        },
      ],
    };
    const report = generateReport(metrics);
    expect(report).toContain("Last pushed: 2025-11-15");
  });

  it("should sort PR details by mergedAt descending in the table", () => {
    const metrics: OrgMetrics = {
      owner: "test-org",
      ownerType: "org",
      collectedAt: "2026-03-28T12:00:00Z",
      repoCount: 1,
      repos: [
        {
          name: "repo-a",
          fullName: "test-org/repo-a",
          issues: { open: 0, closed: 0 },
          pullRequests: { open: 0, closed: 0, merged: 2 },
          pullRequestDetails: [
            { number: 10, title: "Older PR", state: "merged", mergedAt: "2026-01-01T00:00:00Z", linesAdded: 10, linesDeleted: 2, commentCount: 1, commitCount: 1, actionsMinutes: 0 },
            { number: 20, title: "Newer PR", state: "merged", mergedAt: "2026-03-01T00:00:00Z", linesAdded: 20, linesDeleted: 4, commentCount: 2, commitCount: 2, actionsMinutes: 1 },
          ],
          committerCount: 0,
          reviewerCount: 0,
          contributorCount: 0,
          dependentCount: 0,
        },
      ],
    };
    const report = generateReport(metrics);
    const posNewer = report.indexOf("#20 Newer PR");
    const posOlder = report.indexOf("#10 Older PR");
    expect(posNewer).toBeGreaterThanOrEqual(0);
    expect(posOlder).toBeGreaterThanOrEqual(0);
    expect(posNewer).toBeLessThan(posOlder);
  });

  it("should place PRs without mergedAt after those with mergedAt", () => {
    const metrics: OrgMetrics = {
      owner: "test-org",
      ownerType: "org",
      collectedAt: "2026-03-28T12:00:00Z",
      repoCount: 1,
      repos: [
        {
          name: "repo-a",
          fullName: "test-org/repo-a",
          issues: { open: 0, closed: 0 },
          pullRequests: { open: 0, closed: 0, merged: 2 },
          pullRequestDetails: [
            { number: 5, title: "No date PR", state: "merged", linesAdded: 5, linesDeleted: 1, commentCount: 0, commitCount: 1, actionsMinutes: 0 },
            { number: 6, title: "Has date PR", state: "merged", mergedAt: "2026-03-01T00:00:00Z", linesAdded: 6, linesDeleted: 2, commentCount: 0, commitCount: 1, actionsMinutes: 0 },
          ],
          committerCount: 0,
          reviewerCount: 0,
          contributorCount: 0,
          dependentCount: 0,
        },
      ],
    };
    const report = generateReport(metrics);
    const posHasDate = report.indexOf("#6 Has date PR");
    const posNoDate = report.indexOf("#5 No date PR");
    expect(posHasDate).toBeLessThan(posNoDate);
  });

  it("renders a Delivery Forecast when weekly throughput history exists", () => {
    const metrics = makeSampleMetrics();
    // 13 completed weeks of steady throughput + the in-progress week.
    metrics.weeklyTrends = Array.from({ length: 14 }, (_, i) => ({
      week: `2026-W${String(i + 1).padStart(2, "0")}`,
      prsOpened: 5,
      prsMerged: 5,
      issuesOpened: 0,
      issuesClosed: 0,
      linesAdded: 0,
      linesDeleted: 0,
    }));
    const report = generateReport(metrics);
    expect(report).toContain("## Delivery Forecast");
    expect(report).toContain("| 10 PRs |");
    expect(report).toContain("merged PRs/week");
  });

  it("omits forecast and what-changed sections without trend or history data", () => {
    const report = generateReport(makeSampleMetrics());
    expect(report).not.toContain("## Delivery Forecast");
    expect(report).not.toContain("## What Changed");
  });
});
