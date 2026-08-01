import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("./cache.js", () => ({
  buildTargetKey: vi.fn((owner: string, ownerType: "org" | "user", repo?: string) =>
    repo ? `${ownerType}-${owner}--${repo.replace(/[^a-zA-Z0-9._-]+/g, "_")}` : owner
  ),
  loadCache: vi.fn(),
  loadRawCache: vi.fn(),
  isWithinHours: vi.fn(),
  saveCache: vi.fn(),
  CURRENT_SCHEMA_VERSION: 2,
}));

vi.mock("./history.js", () => ({
  appendHistorySnapshot: vi.fn(),
}));

vi.mock("./collectors/index.js", () => ({
  collectRepos: vi.fn(),
  collectIssueCounts: vi.fn(),
  collectIssueLeadTimes: vi.fn(),
  collectPullRequestCounts: vi.fn(),
  collectPullRequestDetails: vi.fn(),
  collectMergedPRTimeline: vi.fn(),
  computeCopilotAdoption: vi.fn(),
  collectContributors: vi.fn(),
  collectDependentCount: vi.fn(),
  collectWeeklyTrends: vi.fn(),
  collectRepoGraphQL: vi.fn(),
  buildPullRequestCounts: vi.fn(),
  buildMergedPRTimeline: vi.fn(),
  collectPullRequestDetailsFromNodes: vi.fn(),
  extractReviewerLogins: vi.fn(),
  collectCopilotAgentMetrics: vi.fn(),
  collectCopilotUsageMetrics: vi.fn(),
  buildRevertEvents: vi.fn(),
  collectDeployments: vi.fn(),
  collectIncidents: vi.fn(),
}));

vi.mock("./targets.js", () => ({
  loadTargetsConfig: vi.fn(() => null),
}));

import { collect } from "./collect.js";
import { buildTargetKey, loadCache, loadRawCache, isWithinHours, saveCache } from "./cache.js";
import { appendHistorySnapshot } from "./history.js";
import {
  collectRepos,
  collectIssueCounts,
  collectIssueLeadTimes,
  collectPullRequestCounts,
  collectPullRequestDetails,
  collectMergedPRTimeline,
  computeCopilotAdoption,
  collectContributors,
  collectDependentCount,
  collectWeeklyTrends,
  collectRepoGraphQL,
  buildPullRequestCounts,
  buildMergedPRTimeline,
  collectPullRequestDetailsFromNodes,
  extractReviewerLogins,
  collectCopilotAgentMetrics,
  collectCopilotUsageMetrics,
  buildRevertEvents,
  collectDeployments,
  collectIncidents,
} from "./collectors/index.js";
import { loadTargetsConfig } from "./targets.js";
import type { OrgMetrics } from "./types.js";

function setupDefaultMocks() {
  vi.mocked(loadCache).mockReturnValue(null);
  vi.mocked(loadRawCache).mockReturnValue(null);
  vi.mocked(isWithinHours).mockReturnValue(false);
  vi.mocked(saveCache).mockReturnValue(undefined);
  vi.mocked(collectRepos).mockResolvedValue([]);
  // GraphQL path returns null by default → triggers REST fallback
  vi.mocked(collectRepoGraphQL).mockResolvedValue(null);
  vi.mocked(collectIssueCounts).mockResolvedValue({ open: 0, closed: 0 });
  vi.mocked(collectPullRequestCounts).mockResolvedValue({ open: 0, closed: 0, merged: 0 });
  vi.mocked(collectPullRequestDetails).mockResolvedValue([]);
  vi.mocked(collectMergedPRTimeline).mockResolvedValue([]);
  vi.mocked(collectIssueLeadTimes).mockResolvedValue([]);
  vi.mocked(computeCopilotAdoption).mockReturnValue({
    copilotAuthoredPRs: 0, copilotReviewedPRs: 0, totalMergedPRs: 0, totalDetailedPRs: 0,
  });
  vi.mocked(collectContributors).mockResolvedValue({ committerCount: 0, reviewerCount: 0, contributorCount: 0 });
  vi.mocked(collectDependentCount).mockResolvedValue(0);
  vi.mocked(collectWeeklyTrends).mockResolvedValue({ orgTrends: [], repoTrends: new Map() });
  vi.mocked(buildPullRequestCounts).mockReturnValue({ open: 0, closed: 0, merged: 0 });
  vi.mocked(buildMergedPRTimeline).mockReturnValue([]);
  vi.mocked(collectPullRequestDetailsFromNodes).mockResolvedValue([]);
  vi.mocked(extractReviewerLogins).mockReturnValue(new Set());
  vi.mocked(collectCopilotAgentMetrics).mockResolvedValue(null);
  vi.mocked(collectCopilotUsageMetrics).mockResolvedValue(null);
  vi.mocked(buildRevertEvents).mockReturnValue([]);
  vi.mocked(collectDeployments).mockResolvedValue(null);
  vi.mocked(collectIncidents).mockResolvedValue([]);
  vi.mocked(loadTargetsConfig).mockReturnValue(null);
}

describe("collect", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  it("returns cached data immediately without calling collectRepos", async () => {
    const cached: OrgMetrics = {
      owner: "cached-org",
      ownerType: "org",
      collectedAt: "2026-01-01T00:00:00Z",
      repoCount: 3,
      repos: [],
    };
    vi.mocked(loadCache).mockReturnValue(cached);

    const result = await collect("cached-org", "org");

    expect(result).toBe(cached);
    expect(collectRepos).not.toHaveBeenCalled();
  });

  it("rejects an organization cache when enterprise usage is requested", async () => {
    setupDefaultMocks();
    vi.stubEnv("COPILOT_USAGE_ENTERPRISE", "enterprise-a");
    vi.mocked(loadCache).mockReturnValue({
      owner: "cached-org",
      ownerType: "org",
      copilotUsageScope: "organization:cached-org",
      collectedAt: "2026-07-23T00:00:00Z",
      repoCount: 0,
      repos: [],
    });

    const result = await collect("cached-org", "org");

    expect(collectRepos).toHaveBeenCalled();
    expect(result.copilotUsageScope).toBe("enterprise:enterprise-a");
  });

  it("rejects an enterprise cache when organization usage is requested", async () => {
    setupDefaultMocks();
    vi.mocked(loadCache).mockReturnValue({
      owner: "cached-org",
      ownerType: "org",
      copilotUsageScope: "enterprise:enterprise-a",
      collectedAt: "2026-07-23T00:00:00Z",
      repoCount: 0,
      repos: [],
    });

    const result = await collect("cached-org", "org");

    expect(collectRepos).toHaveBeenCalled();
    expect(result.copilotUsageScope).toBe("organization:cached-org");
  });

  it("skips repos with a malformed fullName and logs a warning", async () => {
    setupDefaultMocks();
    vi.mocked(collectRepos).mockResolvedValue([
      { name: "bad", fullName: "bad", pushedAt: "" },           // no slash
      { name: "good", fullName: "owner/good", pushedAt: "" },   // valid
    ]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await collect("owner", "org");

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("bad"));
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].name).toBe("good");
    warnSpy.mockRestore();
  });

  it("bypasses cache when skipCache is true even if loadCache would return data", async () => {
    setupDefaultMocks();
    const stale: OrgMetrics = {
      owner: "skip-org",
      ownerType: "org",
      collectedAt: "2026-01-01T00:00:00Z",
      repoCount: 99,
      repos: [],
    };
    vi.mocked(loadCache).mockReturnValue(stale);

    const result = await collect("skip-org", "org", { skipCache: true });

    expect(collectRepos).toHaveBeenCalled();
    expect(result.repoCount).toBe(0); // fresh data – no repos from mock
  });

  it("saves collected metrics to cache after a fresh collection", async () => {
    setupDefaultMocks();

    await collect("fresh-org", "org");

    expect(saveCache).toHaveBeenCalledWith(
      "fresh-org",
      expect.objectContaining({ owner: "fresh-org", schemaVersion: 2 })
    );
  });

  it("attaches org-level Copilot usage metrics when available", async () => {
    setupDefaultMocks();
    vi.mocked(collectCopilotUsageMetrics).mockResolvedValue({
      scope: "organization",
      scopeName: "fresh-org",
      reportStartDay: "2026-04-01",
      reportEndDay: "2026-04-28",
      collectedAt: "2026-04-29T00:00:00Z",
      totals: {
        totalUsers: 1,
        activeUsers: 1,
        chatUsers: 1,
        agentUsers: 0,
        cliUsers: 0,
        codeReviewActiveUsers: 0,
        codeReviewPassiveUsers: 0,
        assignedSeats: 1,
        seatsActiveThisCycle: 1,
        userInitiatedInteractions: 10,
        codeGenerations: 5,
        codeAcceptances: 3,
        locSuggestedToAdd: 12,
        locSuggestedToDelete: 0,
        locAdded: 9,
        locDeleted: 0,
        acceptanceRate: 60,
      },
      users: [],
      dailyTotals: [],
      byFeature: [],
      byIde: [],
      byLanguage: [],
      byModel: [],
      byTeam: [],
    });

    const result = await collect("fresh-org", "org");

    expect(collectCopilotUsageMetrics).toHaveBeenCalledWith("fresh-org", "org");
    expect(result.copilotUsage?.totals.activeUsers).toBe(1);
    expect(saveCache).toHaveBeenCalledWith(
      "fresh-org",
      expect.objectContaining({ copilotUsage: expect.objectContaining({ scopeName: "fresh-org" }) }),
    );
  });

  it("passes repo selection to collectRepos and saves under a repo-specific cache key", async () => {
    setupDefaultMocks();
    vi.mocked(collectRepos).mockResolvedValue([
      { name: "repo-a", fullName: "myorg/repo-a", pushedAt: "" },
    ]);

    await collect("myorg", "org", { repo: "repo-a" });

    expect(collectRepos).toHaveBeenCalledWith("myorg", "org", { repo: "repo-a" });
    expect(saveCache).toHaveBeenCalledWith(
      buildTargetKey("myorg", "org", "repo-a"),
      expect.objectContaining({ owner: "myorg", ownerType: "org", targetRepo: "repo-a" })
    );
  });

  it("passes configured incidentLabels to collectIncidents and stores the result", async () => {
    setupDefaultMocks();
    vi.mocked(loadTargetsConfig).mockReturnValue({
      targets: {},
      incidentLabels: ["incident", "sev1"],
    });
    const incident = {
      number: 7,
      createdAt: "2026-06-01T00:00:00Z",
      closedAt: "2026-06-01T12:00:00Z",
      resolutionHours: 12,
      labels: ["incident"],
    };
    vi.mocked(collectIncidents).mockResolvedValue([incident]);
    vi.mocked(collectRepos).mockResolvedValue([
      { name: "r", fullName: "owner/r", pushedAt: "" },
    ]);

    const result = await collect("owner", "org");

    expect(collectIncidents).toHaveBeenCalledWith("owner", "r", ["incident", "sev1"]);
    expect(result.repos[0].incidents).toEqual([incident]);
  });

  it("stores undefined incidents when collectIncidents returns null", async () => {
    setupDefaultMocks();
    vi.mocked(collectIncidents).mockResolvedValue(null);
    vi.mocked(collectRepos).mockResolvedValue([
      { name: "r", fullName: "owner/r", pushedAt: "" },
    ]);

    const result = await collect("owner", "org");

    // No config → collector is called with undefined labels (its defaults).
    expect(collectIncidents).toHaveBeenCalledWith("owner", "r", undefined);
    expect(result.repos[0].incidents).toBeUndefined();
  });

  it("appends a history snapshot on the cache-hit path", async () => {
    const cached: OrgMetrics = {
      owner: "cached-org",
      ownerType: "org",
      collectedAt: "2026-01-01T00:00:00Z",
      repoCount: 3,
      repos: [],
    };
    vi.mocked(loadCache).mockReturnValue(cached);

    await collect("cached-org", "org");

    expect(appendHistorySnapshot).toHaveBeenCalledWith("cached-org", cached);
  });

  it("appends a history snapshot after a fresh collection", async () => {
    setupDefaultMocks();

    const result = await collect("fresh-org", "org");

    expect(appendHistorySnapshot).toHaveBeenCalledWith("fresh-org", result);
    expect(saveCache).toHaveBeenCalled();
  });

  it("still returns cached metrics when appendHistorySnapshot throws on the cache-hit path", async () => {
    const cached: OrgMetrics = {
      owner: "cached-org",
      ownerType: "org",
      collectedAt: "2026-01-01T00:00:00Z",
      repoCount: 3,
      repos: [],
    };
    vi.mocked(loadCache).mockReturnValue(cached);
    vi.mocked(appendHistorySnapshot).mockImplementation(() => {
      throw new Error("disk full");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await collect("cached-org", "org");

    expect(result).toBe(cached);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    warnSpy.mockRestore();
  });

  it("still returns fresh metrics when appendHistorySnapshot throws after collection", async () => {
    setupDefaultMocks();
    vi.mocked(appendHistorySnapshot).mockImplementation(() => {
      throw new Error("disk full");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await collect("fresh-org", "org");

    expect(result.owner).toBe("fresh-org");
    expect(saveCache).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    warnSpy.mockRestore();
  });

  it("recollects trends when cached repos are missing per-repo weeklyTrends", async () => {
    setupDefaultMocks();
    // Simulate raw cache with org-level trends but no per-repo weeklyTrends
    const rawCache: OrgMetrics = {
      owner: "org",
      ownerType: "org",
      collectedAt: "2026-01-01T00:00:00Z",
      repoCount: 1,
      repos: [
        {
          name: "r",
          fullName: "org/r",
          issues: { open: 0, closed: 0 },
          pullRequests: { open: 0, closed: 0, merged: 0 },
          pullRequestDetails: [],
          committerCount: 0,
          reviewerCount: 0,
          contributorCount: 0,
          dependentCount: 0,
          // weeklyTrends intentionally absent (old cache format)
        },
      ],
      weeklyTrends: [
        { week: "2026-W01", prsOpened: 1, prsMerged: 0, issuesOpened: 0, issuesClosed: 0, linesAdded: 0, linesDeleted: 0 },
      ],
    };
    vi.mocked(loadRawCache).mockReturnValue(rawCache);
    // All repos are "within hours" so none are re-fetched
    vi.mocked(isWithinHours).mockReturnValue(true);
    vi.mocked(collectRepos).mockResolvedValue([{ name: "r", fullName: "org/r", pushedAt: "" }]);
    vi.mocked(collectWeeklyTrends).mockResolvedValue({
      orgTrends: [{ week: "2026-W01", prsOpened: 1, prsMerged: 0, issuesOpened: 2, issuesClosed: 0, linesAdded: 0, linesDeleted: 0 }],
      repoTrends: new Map([["org/r", [{ week: "2026-W01", prsOpened: 1, prsMerged: 0, issuesOpened: 2, issuesClosed: 0, linesAdded: 0, linesDeleted: 0 }]]]),
    });

    const result = await collect("org", "org");

    // Trends should have been recollected due to missing per-repo weeklyTrends
    expect(collectWeeklyTrends).toHaveBeenCalled();
    // Repo should now have weeklyTrends populated
    expect(result.repos[0].weeklyTrends).toBeDefined();
    expect(result.repos[0].weeklyTrends).toHaveLength(1);
  });

  it("calls collectWeeklyTrends with 104 weeks to support multi-year trend history", async () => {
    setupDefaultMocks();
    vi.mocked(collectRepos).mockResolvedValue([{ name: "r", fullName: "owner/r", pushedAt: "" }]);

    await collect("owner", "org");

    expect(collectWeeklyTrends).toHaveBeenCalledWith(
      expect.any(Array),
      104,
      expect.any(Number),
      expect.any(Map)
    );
  });

  it("skips trend recollection when all repos already have per-repo weeklyTrends", async () => {
    setupDefaultMocks();
    const repoWithTrends = {
      name: "r",
      fullName: "org/r",
      issues: { open: 0, closed: 0 },
      pullRequests: { open: 0, closed: 0, merged: 0 },
      pullRequestDetails: [],
      committerCount: 0,
      reviewerCount: 0,
      contributorCount: 0,
      dependentCount: 0,
      weeklyTrends: [{ week: "2026-W01", prsOpened: 0, prsMerged: 0, issuesOpened: 1, issuesClosed: 0, linesAdded: 0, linesDeleted: 0 }],
    };
    const rawCache: OrgMetrics = {
      owner: "org",
      ownerType: "org",
      collectedAt: "2026-01-01T00:00:00Z",
      repoCount: 1,
      repos: [repoWithTrends],
      weeklyTrends: repoWithTrends.weeklyTrends,
    };
    vi.mocked(loadRawCache).mockReturnValue(rawCache);
    vi.mocked(isWithinHours).mockReturnValue(true);
    vi.mocked(collectRepos).mockResolvedValue([{ name: "r", fullName: "org/r", pushedAt: "" }]);

    await collect("org", "org");

    // Trends should NOT be recollected since per-repo data already exists
    expect(collectWeeklyTrends).not.toHaveBeenCalled();
  });
});
