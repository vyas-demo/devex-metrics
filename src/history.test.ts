import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  HISTORY_SCHEMA_VERSION,
  buildHistorySnapshot,
  historyFilePath,
  loadHistory,
  appendHistorySnapshot,
  computeHistoryDeltas,
} from "./history.js";
import { computeHealthReport } from "./health.js";
import type {
  CopilotUsageMetrics,
  HistoryFile,
  HistorySnapshot,
  MergedPRSummary,
  OrgMetrics,
  RepoMetrics,
} from "./types.js";

// ── Fixture factories (mirrors dora.test.ts) ───────────────────────────────────

/** collectedAt of every fixture; snapshot date is its first 10 chars. */
const NOW_ISO = "2026-07-13T12:00:00Z";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Build a MergedPRSummary with sensible defaults; override the fields a test cares about. */
function makePR(overrides: Partial<MergedPRSummary> = {}): MergedPRSummary {
  return {
    number: 1,
    createdAt: "2026-07-01T00:00:00Z",
    mergedAt: "2026-07-02T00:00:00Z",
    author: "alice",
    isBotAuthor: false,
    isCopilotAuthored: false,
    timeToMergeHours: 10,
    closesIssues: [],
    ...overrides,
  };
}

/** Build a RepoMetrics with a merged-PR timeline plus optional extras. */
function makeRepo(
  fullName: string,
  prs: MergedPRSummary[],
  extras: Partial<RepoMetrics> = {}
): RepoMetrics {
  return {
    name: fullName.includes("/") ? fullName.split("/")[1] : fullName,
    fullName,
    issues: { open: 0, closed: 0 },
    pullRequests: { open: 0, closed: 0, merged: prs.length },
    pullRequestDetails: [],
    mergedPRTimeline: prs,
    committerCount: 0,
    reviewerCount: 0,
    contributorCount: 0,
    dependentCount: 0,
    ...extras,
  };
}

/** Build an OrgMetrics wrapping the given repos, collected at NOW_ISO. */
function makeOrg(repos: RepoMetrics[], extras: Partial<OrgMetrics> = {}): OrgMetrics {
  return {
    owner: "org",
    ownerType: "org",
    collectedAt: NOW_ISO,
    repoCount: repos.length,
    repos,
    ...extras,
  };
}

/** Minimal complete CopilotUsageMetrics with the given active-user count. */
function makeCopilotUsage(activeUsers: number): CopilotUsageMetrics {
  const counters = {
    userInitiatedInteractions: 0,
    codeGenerations: 0,
    codeAcceptances: 0,
    locSuggestedToAdd: 0,
    locSuggestedToDelete: 0,
    locAdded: 0,
    locDeleted: 0,
    acceptanceRate: 0,
  };
  const cli = {
    sessionCount: 0,
    requestCount: 0,
    promptCount: 0,
    promptTokens: 0,
    outputTokens: 0,
    avgTokensPerRequest: 0,
  };
  const pullRequests = {
    totalCreated: 0,
    totalReviewed: 0,
    totalMerged: 0,
    medianMinutesToMerge: 0,
    totalSuggestions: 0,
    totalAppliedSuggestions: 0,
    totalCreatedByCopilot: 0,
    totalReviewedByCopilot: 0,
    totalMergedCreatedByCopilot: 0,
    totalMergedReviewedByCopilot: 0,
    medianMinutesToMergeCopilotAuthored: 0,
    medianMinutesToMergeCopilotReviewed: 0,
    totalCopilotSuggestions: 0,
    totalCopilotAppliedSuggestions: 0,
    copilotSuggestionsByCommentType: [],
  };
  const codeReview = {
    dailyActiveUsers: 0,
    dailyPassiveUsers: 0,
    weeklyActiveUsers: 0,
    weeklyPassiveUsers: 0,
    monthlyActiveUsers: 0,
    monthlyPassiveUsers: 0,
  };
  return {
    scope: "organization",
    scopeName: "org",
    collectedAt: NOW_ISO,
    totals: {
      ...counters,
      totalUsers: activeUsers,
      activeUsers,
      chatUsers: 0,
      agentUsers: 0,
      cliUsers: 0,
      codeReviewActiveUsers: 0,
      codeReviewPassiveUsers: 0,
      assignedSeats: 0,
      seatsActiveThisCycle: 0,
    },
    cli,
    pullRequests,
    codeReview,
    users: [],
    dailyTotals: [],
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

/**
 * Org fixture with deterministic 30-day rollups (window ends at NOW_ISO):
 * repo a has 3 in-window merged PRs (2 human, 1 AI/bot, 1 revert), one
 * out-of-window human PR, 2 in-window deploys of 3; repo b is empty.
 */
function makeSampleOrg(extras: Partial<OrgMetrics> = {}): OrgMetrics {
  const repoA = makeRepo(
    "org/a",
    [
      // In-window human PR, reviewed.
      makePR({
        number: 1,
        mergedAt: "2026-07-01T00:00:00Z",
        author: "alice",
        timeToMergeHours: 10,
        reviewers: ["bob"],
      }),
      // In-window human PR, unreviewed revert.
      makePR({
        number: 2,
        mergedAt: "2026-07-05T00:00:00Z",
        author: "bob",
        timeToMergeHours: 20,
        reviewers: [],
        isRevert: true,
      }),
      // In-window AI-authored PR (bot login) — excluded from lead-time and
      // review-coverage samples but counted in mergedPRs30d and aiShare.
      makePR({
        number: 3,
        mergedAt: "2026-07-06T00:00:00Z",
        author: "copilot-swe-agent[bot]",
        isBotAuthor: true,
        isCopilotAuthored: true,
        timeToMergeHours: 5,
        reviewers: ["alice"],
      }),
      // Out-of-window human PR — contributes carol to contributorCount only.
      makePR({
        number: 4,
        mergedAt: "2026-05-01T00:00:00Z",
        author: "carol",
        timeToMergeHours: 40,
        reviewers: ["alice"],
      }),
    ],
    {
      issues: { open: 3, closed: 1 },
      pullRequests: { open: 2, closed: 0, merged: 4 },
      pushedAt: "2026-07-13T00:00:00Z",
      deployments: [
        { createdAt: "2026-07-02T00:00:00Z", source: "deployment" },
        { createdAt: "2026-06-20T00:00:00Z", source: "release" },
        { createdAt: "2026-05-01T00:00:00Z", source: "deployment" },
      ],
    }
  );
  const repoB = makeRepo("org/b", [], {
    issues: { open: 2, closed: 5 },
    pullRequests: { open: 1, closed: 0, merged: 0 },
  });
  return makeOrg([repoA, repoB], extras);
}

/** Build a HistorySnapshot with zeroed metrics; override what a test cares about. */
function makeSnapshot(date: string, overrides: Partial<HistorySnapshot> = {}): HistorySnapshot {
  return {
    date,
    collectedAt: `${date}T00:00:00Z`,
    repoCount: 1,
    openIssues: 0,
    openPRs: 0,
    mergedPRs30d: 0,
    medianCycleHours30d: 0,
    reviewCoverage30d: 0,
    contributorCount: 0,
    avgHealthScore: 0,
    needsAttentionCount: 0,
    aiShare: 0,
    deploys30d: 0,
    reverts30d: 0,
    ...overrides,
  };
}

/** Wrap snapshots in a current-schema HistoryFile. */
function makeHistory(snapshots: HistorySnapshot[]): HistoryFile {
  return { schemaVersion: HISTORY_SCHEMA_VERSION, targetKey: "test-history", snapshots };
}

/** YYYY-MM-DD string `days` days after `base` (a YYYY-MM-DD string). */
function dateOffset(base: string, days: number): string {
  return new Date(Date.parse(`${base}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

// ── buildHistorySnapshot ───────────────────────────────────────────────────────

describe("buildHistorySnapshot", () => {
  it("derives every field from the collected metrics", () => {
    const org = makeSampleOrg();
    const snapshot = buildHistorySnapshot(org);

    expect(snapshot.date).toBe("2026-07-13");
    expect(snapshot.collectedAt).toBe(NOW_ISO);
    expect(snapshot.repoCount).toBe(2);
    expect(snapshot.openIssues).toBe(5); // 3 + 2
    expect(snapshot.openPRs).toBe(3); // 2 + 1
    // 30-day DORA window: PRs 1–3 merged in window; PR 4 outside.
    expect(snapshot.mergedPRs30d).toBe(3);
    // Human lead-time samples in window: 10h, 20h → median 15.
    expect(snapshot.medianCycleHours30d).toBe(15);
    // Non-bot PRs in window: #1 (reviewed) and #2 (not) → 1/2.
    expect(snapshot.reviewCoverage30d).toBe(0.5);
    // Human authors across the full window: alice, bob, carol.
    expect(snapshot.contributorCount).toBe(3);
    // 1 AI-authored of 4 attributed merges (3 human + 1 AI).
    expect(snapshot.aiShare).toBe(0.25);
    expect(snapshot.deploys30d).toBe(2);
    expect(snapshot.reverts30d).toBe(1);
    // Health figures match the health module's report for the same metrics.
    const health = computeHealthReport(org);
    expect(snapshot.avgHealthScore).toBe(health.avgScore);
    expect(snapshot.needsAttentionCount).toBe(
      health.repos.filter((r) => r.needsAttention).length
    );
  });

  it("omits copilotActiveUsers when no usage data was collected", () => {
    const snapshot = buildHistorySnapshot(makeSampleOrg());
    expect("copilotActiveUsers" in snapshot).toBe(false);
  });

  it("includes copilotActiveUsers when usage data is present", () => {
    const snapshot = buildHistorySnapshot(
      makeSampleOrg({ copilotUsage: makeCopilotUsage(7) })
    );
    expect(snapshot.copilotActiveUsers).toBe(7);
  });
});

// ── loadHistory / appendHistorySnapshot (filesystem) ──────────────────────────

describe("history file persistence", () => {
  // history.ts resolves DATA_DIR from process.cwd() + /data at module load,
  // so we use the actual data dir for these tests (same as cache.test.ts).
  const dataDir = path.resolve(process.cwd(), "data");
  const targetKey = "test-history";
  const testFile = path.join(dataDir, `${targetKey}-history.json`);

  afterEach(() => {
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
    vi.restoreAllMocks();
  });

  it("historyFilePath points into <cwd>/data", () => {
    expect(historyFilePath(targetKey)).toBe(testFile);
  });

  it("loadHistory returns null when no file exists", () => {
    expect(loadHistory(targetKey)).toBeNull();
  });

  it("loadHistory returns null and warns for unparseable JSON", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(testFile, "not-json{{{");
    expect(loadHistory(targetKey)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(targetKey));
  });

  it("loadHistory returns null and warns on schema version mismatch", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      testFile,
      JSON.stringify({ schemaVersion: 999, targetKey, snapshots: [] })
    );
    expect(loadHistory(targetKey)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("999"));
  });

  it("appendHistorySnapshot creates the file with one snapshot", () => {
    const file = appendHistorySnapshot(targetKey, makeSampleOrg());

    expect(file.schemaVersion).toBe(HISTORY_SCHEMA_VERSION);
    expect(file.targetKey).toBe(targetKey);
    expect(file.snapshots).toHaveLength(1);
    expect(file.snapshots[0].date).toBe("2026-07-13");

    const onDisk = loadHistory(targetKey);
    expect(onDisk).toEqual(file);
  });

  it("replaces a same-date snapshot instead of duplicating it", () => {
    appendHistorySnapshot(targetKey, makeSampleOrg());
    // Second collection the same day, later in the day, with fewer repos.
    const later = makeSampleOrg({
      collectedAt: "2026-07-13T18:00:00Z",
      repoCount: 1,
    });
    const file = appendHistorySnapshot(targetKey, later);

    expect(file.snapshots).toHaveLength(1);
    expect(file.snapshots[0].collectedAt).toBe("2026-07-13T18:00:00Z");
    expect(file.snapshots[0].repoCount).toBe(1);
  });

  it("keeps snapshots sorted ascending by date", () => {
    appendHistorySnapshot(targetKey, makeSampleOrg());
    appendHistorySnapshot(
      targetKey,
      makeSampleOrg({ collectedAt: "2026-07-10T00:00:00Z" })
    );
    const file = appendHistorySnapshot(
      targetKey,
      makeSampleOrg({ collectedAt: "2026-07-11T00:00:00Z" })
    );

    expect(file.snapshots.map((s) => s.date)).toEqual([
      "2026-07-10",
      "2026-07-11",
      "2026-07-13",
    ]);
  });

  it("trims to the most recent 400 snapshots", () => {
    // 400 daily snapshots ending the day before the new collection.
    const existing = Array.from({ length: 400 }, (_, i) =>
      makeSnapshot(dateOffset("2026-07-13", i - 400))
    );
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(testFile, JSON.stringify(makeHistory(existing)));

    const file = appendHistorySnapshot(targetKey, makeSampleOrg());

    expect(file.snapshots).toHaveLength(400);
    // Oldest entry dropped; newest is the freshly appended snapshot.
    expect(file.snapshots[0].date).toBe(existing[1].date);
    expect(file.snapshots[399].date).toBe("2026-07-13");
  });
});

// ── computeHistoryDeltas ───────────────────────────────────────────────────────

describe("computeHistoryDeltas", () => {
  it("returns hasData:false for null history", () => {
    expect(computeHistoryDeltas(null)).toEqual({ hasData: false, deltas: [] });
  });

  it("returns hasData:false for a single snapshot", () => {
    const history = makeHistory([makeSnapshot("2026-07-13")]);
    expect(computeHistoryDeltas(history)).toEqual({ hasData: false, deltas: [] });
  });

  it("prefers a snapshot exactly targetDays old as the baseline", () => {
    const history = makeHistory([
      makeSnapshot("2026-07-06"),
      makeSnapshot("2026-07-11"),
      makeSnapshot("2026-07-13"),
    ]);
    const result = computeHistoryDeltas(history);

    expect(result.hasData).toBe(true);
    expect(result.baselineDate).toBe("2026-07-06");
    expect(result.daysSpanned).toBe(7);
  });

  it("falls back to the snapshot nearest the 7-day target", () => {
    const history = makeHistory([
      makeSnapshot("2026-07-03"), // 3 days from target 2026-07-06
      makeSnapshot("2026-07-08"), // 2 days from target
      makeSnapshot("2026-07-13"),
    ]);
    const result = computeHistoryDeltas(history);

    expect(result.baselineDate).toBe("2026-07-08");
    expect(result.daysSpanned).toBe(5);
  });

  it("breaks distance ties toward the older snapshot", () => {
    const history = makeHistory([
      makeSnapshot("2026-07-04"), // 2 days before target 2026-07-06
      makeSnapshot("2026-07-08"), // 2 days after target
      makeSnapshot("2026-07-13"),
    ]);
    const result = computeHistoryDeltas(history);

    expect(result.baselineDate).toBe("2026-07-04");
    expect(result.daysSpanned).toBe(9);
  });

  it("honors a custom targetDays", () => {
    const history = makeHistory([
      makeSnapshot("2026-06-13"), // exactly 30 days old
      makeSnapshot("2026-07-06"),
      makeSnapshot("2026-07-13"),
    ]);
    const result = computeHistoryDeltas(history, { targetDays: 30 });

    expect(result.baselineDate).toBe("2026-06-13");
    expect(result.daysSpanned).toBe(30);
  });

  it("computes delta and pctChange, leaving pctChange undefined for a zero baseline", () => {
    const history = makeHistory([
      makeSnapshot("2026-07-06", { mergedPRs30d: 10, deploys30d: 0 }),
      makeSnapshot("2026-07-13", { mergedPRs30d: 15, deploys30d: 3 }),
    ]);
    const result = computeHistoryDeltas(history);

    const merged = result.deltas.find((d) => d.id === "mergedPRs30d");
    expect(merged).toMatchObject({
      label: "Merged PRs (30d)",
      current: 15,
      previous: 10,
      delta: 5,
      pctChange: 0.5,
      goodDirection: "up",
    });

    const deploys = result.deltas.find((d) => d.id === "deploys30d");
    expect(deploys).toMatchObject({ current: 3, previous: 0, delta: 3 });
    expect(deploys?.pctChange).toBeUndefined();
  });

  it("emits every metric in the documented order with its label and direction", () => {
    const history = makeHistory([
      makeSnapshot("2026-07-06"),
      makeSnapshot("2026-07-13"),
    ]);
    const result = computeHistoryDeltas(history);

    expect(
      result.deltas.map((d) => [d.id, d.label, d.goodDirection])
    ).toEqual([
      ["mergedPRs30d", "Merged PRs (30d)", "up"],
      ["medianCycleHours30d", "Median cycle time (30d)", "down"],
      ["reviewCoverage30d", "Review coverage (30d)", "up"],
      ["avgHealthScore", "Avg health score", "up"],
      ["needsAttentionCount", "Repos needing attention", "down"],
      ["openIssues", "Open issues", "down"],
      ["openPRs", "Open PRs", "down"],
      ["contributorCount", "Contributors", "up"],
      ["aiShare", "AI share of merges", "up"],
      ["deploys30d", "Deploys (30d)", "up"],
      ["reverts30d", "Reverts (30d)", "down"],
    ]);
  });
});
