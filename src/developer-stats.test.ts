import { describe, it, expect } from "vitest";
import {
  computeEngineeringIntelligence,
  percentile,
  median,
  benchmark,
  prWorkUnits,
} from "./developer-stats.js";
import type { OrgMetrics, RepoMetrics, MergedPRSummary } from "./types.js";

// ── Fixture factories ──────────────────────────────────────────────────────────

/** Build a MergedPRSummary with sensible defaults; override the fields a test cares about. */
function makePR(overrides: Partial<MergedPRSummary> = {}): MergedPRSummary {
  return {
    number: 1,
    createdAt: "2026-01-01T00:00:00Z",
    mergedAt: "2026-01-02T00:00:00Z",
    author: "alice",
    isBotAuthor: false,
    isCopilotAuthored: false,
    timeToMergeHours: 10,
    closesIssues: [],
    ...overrides,
  };
}

/** Build a RepoMetrics whose only meaningful payload is its merged-PR timeline. */
function makeRepo(fullName: string, prs: MergedPRSummary[]): RepoMetrics {
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
  };
}

/** Build an OrgMetrics wrapping the given repos. */
function makeOrg(repos: RepoMetrics[]): OrgMetrics {
  return {
    owner: "org",
    ownerType: "org",
    collectedAt: "2026-07-13T00:00:00Z",
    repoCount: repos.length,
    repos,
  };
}

// ── percentile ─────────────────────────────────────────────────────────────────

describe("percentile", () => {
  it("returns 0 for an empty array", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([], 0)).toBe(0);
    expect(percentile([], 1)).toBe(0);
  });

  it("returns the single value regardless of ratio", () => {
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 1)).toBe(42);
  });

  it("linearly interpolates between two values", () => {
    expect(percentile([10, 20], 0.5)).toBe(15);
    expect(percentile([10, 20], 0.25)).toBe(12.5);
    expect(percentile([10, 20], 0.75)).toBe(17.5);
  });

  it("sorts before computing (order-independent)", () => {
    expect(percentile([20, 10], 0.5)).toBe(15);
  });

  it("returns min at p0 and max at p100", () => {
    expect(percentile([3, 1, 2, 5, 4], 0)).toBe(1);
    expect(percentile([3, 1, 2, 5, 4], 1)).toBe(5);
  });

  it("clamps ratios below 0 to the minimum", () => {
    expect(percentile([10, 20, 30], -1)).toBe(10);
    expect(percentile([10, 20, 30], -0.5)).toBe(10);
  });

  it("clamps ratios above 1 to the maximum", () => {
    expect(percentile([10, 20, 30], 2)).toBe(30);
    expect(percentile([10, 20, 30], 1.5)).toBe(30);
  });
});

// ── median ──────────────────────────────────────────────────────────────────────

describe("median", () => {
  it("returns 0 for an empty array", () => {
    expect(median([])).toBe(0);
  });

  it("returns the middle value for an odd count", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([3, 1, 2])).toBe(2);
  });

  it("averages the two middle values for an even count", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([10, 40, 150])).toBe(40);
  });
});

// ── benchmark ────────────────────────────────────────────────────────────────────

describe("benchmark", () => {
  it("returns all zeros for an empty array", () => {
    expect(benchmark([])).toEqual({ p50: 0, p90: 0, p99: 0, max: 0 });
  });

  it("computes p50/p90/p99/max for a sample", () => {
    const b = benchmark([1, 2, 3, 4]);
    expect(b.p50).toBe(2.5);
    // p90: index = 3 * 0.9 = 2.7 → 3 + (4-3)*0.7 = 3.7
    expect(b.p90).toBeCloseTo(3.7, 10);
    // p99: index = 3 * 0.99 = 2.97 → 3 + (4-3)*0.97 = 3.97
    expect(b.p99).toBeCloseTo(3.97, 10);
    expect(b.max).toBe(4);
  });

  it("reports the true max even when unsorted", () => {
    expect(benchmark([5, 1, 9, 3]).max).toBe(9);
  });
});

// ── computeEngineeringIntelligence ────────────────────────────────────────────────

describe("computeEngineeringIntelligence", () => {
  it("returns hasData:false and zeroed benchmarks for empty metrics", () => {
    const result = computeEngineeringIntelligence(makeOrg([]));
    expect(result.hasData).toBe(false);
    expect(result.developers).toEqual([]);
    expect(result.contributorCount).toBe(0);
    expect(result.totalMergedPRs).toBe(0);
    expect(result.throughputBenchmark).toEqual({ p50: 0, p90: 0, p99: 0, max: 0 });
    expect(result.cycleTimeBenchmark).toEqual({ p50: 0, p90: 0, p99: 0, max: 0 });
    expect(result.prSizeBenchmark).toEqual({ p50: 0, p90: 0, p99: 0, max: 0 });
    expect(result.aiImpact.aiMergedPRs).toBe(0);
    expect(result.aiImpact.humanMergedPRs).toBe(0);
    expect(result.aiImpact.aiShare).toBe(0);
    expect(result.aiImpact.byTool).toEqual([]);
  });

  it("also returns hasData:false when repos have empty timelines", () => {
    const result = computeEngineeringIntelligence(
      makeOrg([makeRepo("org/a", []), makeRepo("org/b", [])])
    );
    expect(result.hasData).toBe(false);
    expect(result.developers).toEqual([]);
  });

  it("aggregates per-developer stats across repos and sorts by mergedPRs desc", () => {
    const org = makeOrg([
      makeRepo("org/a", [
        makePR({
          number: 1,
          author: "alice",
          mergedAt: "2026-01-01T00:00:00Z",
          timeToMergeHours: 10,
          linesAdded: 100,
          linesDeleted: 50,
        }),
        makePR({
          number: 2,
          author: "alice",
          mergedAt: "2026-02-01T00:00:00Z",
          timeToMergeHours: 20,
          linesAdded: 30,
          linesDeleted: 10,
        }),
        makePR({
          number: 3,
          author: "bob",
          mergedAt: "2026-01-15T00:00:00Z",
          timeToMergeHours: 5,
          linesAdded: 10,
          linesDeleted: 0,
        }),
      ]),
      makeRepo("org/b", [
        makePR({
          number: 4,
          author: "alice",
          mergedAt: "2026-03-01T00:00:00Z",
          timeToMergeHours: 30,
          linesAdded: 5,
          linesDeleted: 5,
        }),
      ]),
    ]);

    const result = computeEngineeringIntelligence(org);

    expect(result.hasData).toBe(true);
    expect(result.contributorCount).toBe(2);
    expect(result.totalMergedPRs).toBe(4);
    expect(result.aiImpact.humanMergedPRs).toBe(4);

    // Sorted by mergedPRs desc → alice (3) before bob (1).
    expect(result.developers.map((d) => d.login)).toEqual(["alice", "bob"]);

    const alice = result.developers[0];
    expect(alice.mergedPRs).toBe(3);
    expect(alice.linesAdded).toBe(135); // 100 + 30 + 5
    expect(alice.linesDeleted).toBe(65); // 50 + 10 + 5
    expect(alice.linesChanged).toBe(200);
    // cycle sample [10,20,30] → median 20
    expect(alice.medianCycleHours).toBe(20);
    // size sample [150,40,10] → median 40
    expect(alice.medianPRSizeLines).toBe(40);
    expect(alice.reposContributed).toBe(2); // org/a and org/b
    expect(alice.firstMergedAt).toBe("2026-01-01T00:00:00Z");
    expect(alice.lastMergedAt).toBe("2026-03-01T00:00:00Z");
    expect(alice.isBot).toBe(false);

    const bob = result.developers[1];
    expect(bob.mergedPRs).toBe(1);
    expect(bob.linesChanged).toBe(10);
    expect(bob.medianCycleHours).toBe(5);
    expect(bob.medianPRSizeLines).toBe(10);
    expect(bob.reposContributed).toBe(1);
    expect(bob.firstMergedAt).toBe("2026-01-15T00:00:00Z");
    expect(bob.lastMergedAt).toBe("2026-01-15T00:00:00Z");
  });

  it("excludes non-AI bot authors from developers and human PR totals", () => {
    const org = makeOrg([
      makeRepo("org/a", [
        makePR({ number: 1, author: "alice", linesAdded: 10, linesDeleted: 0 }),
        makePR({
          number: 2,
          author: "dependabot[bot]",
          isBotAuthor: true,
          isCopilotAuthored: false,
          linesAdded: 1000,
          linesDeleted: 0,
        }),
      ]),
    ]);

    const result = computeEngineeringIntelligence(org);

    // The bot must not surface as a developer.
    expect(result.developers.map((d) => d.login)).toEqual(["alice"]);
    expect(result.developers.some((d) => d.login === "dependabot[bot]")).toBe(false);

    // The bot PR must not count toward human/total merged PRs.
    expect(result.totalMergedPRs).toBe(1);
    expect(result.aiImpact.humanMergedPRs).toBe(1);
    expect(result.aiImpact.aiMergedPRs).toBe(0);
    expect(result.contributorCount).toBe(1);
  });

  it("classifies a '-bot' suffix login as a bot even when isBotAuthor is false", () => {
    const org = makeOrg([
      makeRepo("org/a", [
        makePR({ number: 1, author: "alice", linesAdded: 10, linesDeleted: 0 }),
        makePR({
          number: 2,
          author: "step-security-bot",
          isBotAuthor: false, // upstream flag missing, but the login gives it away
          isCopilotAuthored: false,
          linesAdded: 500,
          linesDeleted: 0,
        }),
      ]),
    ]);

    const result = computeEngineeringIntelligence(org);

    // Defensive bot detection keeps the '-bot' login out of the human cohort.
    expect(result.developers.map((d) => d.login)).toEqual(["alice"]);
    expect(result.developers.some((d) => d.login === "step-security-bot")).toBe(false);
    expect(result.totalMergedPRs).toBe(1);
    expect(result.aiImpact.humanMergedPRs).toBe(1);
    expect(result.aiImpact.aiMergedPRs).toBe(0);
    expect(result.contributorCount).toBe(1);
  });

  it("attributes AI-authored PRs to aiImpact only, keeping AI authors out of the leaderboard", () => {
    const org = makeOrg([
      makeRepo("org/ai", [
        makePR({
          number: 10,
          author: "copilot-x",
          isBotAuthor: true,
          isCopilotAuthored: true,
          aiAuthorType: "copilot",
          timeToMergeHours: 2,
          linesAdded: 20,
          linesDeleted: 0,
        }),
        makePR({
          number: 11,
          author: "copilot-x",
          isBotAuthor: true,
          isCopilotAuthored: true,
          aiAuthorType: "copilot",
          timeToMergeHours: 4,
          linesAdded: 40,
          linesDeleted: 0,
        }),
        makePR({
          number: 12,
          author: "claude-x",
          isBotAuthor: true,
          isCopilotAuthored: true,
          aiAuthorType: "claude",
          timeToMergeHours: 6,
          linesAdded: 60,
          linesDeleted: 0,
        }),
        makePR({
          number: 13,
          author: "codex-x",
          isBotAuthor: true,
          isCopilotAuthored: true,
          aiAuthorType: "codex",
          timeToMergeHours: 8,
          linesAdded: 80,
          linesDeleted: 0,
        }),
        makePR({
          number: 14,
          author: "human1",
          isBotAuthor: false,
          isCopilotAuthored: false,
          timeToMergeHours: 10,
          linesAdded: 100,
          linesDeleted: 0,
        }),
      ]),
    ]);

    const result = computeEngineeringIntelligence(org);
    const ai = result.aiImpact;

    expect(ai.aiMergedPRs).toBe(4);
    expect(ai.humanMergedPRs).toBe(1);
    expect(ai.aiShare).toBeCloseTo(0.8, 10);

    // aiCycle [2,4,6,8] → median 5 ; aiSizes [20,40,60,80] → median 50
    expect(ai.aiMedianCycleHours).toBe(5);
    expect(ai.aiMedianPRSize).toBe(50);
    expect(ai.humanMedianCycleHours).toBe(10);
    expect(ai.humanMedianPRSize).toBe(100);

    // byTool sorted by mergedPRs desc: copilot (2) first, then claude & codex (1 each).
    expect(ai.byTool.map((t) => t.tool)).toEqual(["copilot", "claude", "codex"]);
    const copilot = ai.byTool[0];
    expect(copilot.mergedPRs).toBe(2);
    expect(copilot.medianCycleHours).toBe(3); // median([2,4])
    expect(copilot.medianPRSize).toBe(30); // median([20,40])
    expect(ai.byTool[1].mergedPRs).toBe(1);
    expect(ai.byTool[2].mergedPRs).toBe(1);

    // AI authors go ONLY into aiImpact — the leaderboard is human-only.
    expect(result.developers.map((d) => d.login)).toEqual(["human1"]);
    expect(result.developers.some((d) => d.login === "copilot-x")).toBe(false);
    expect(result.developers.some((d) => d.login === "claude-x")).toBe(false);
    expect(result.developers.some((d) => d.login === "codex-x")).toBe(false);
    const human = result.developers[0];
    expect(human.mergedPRs).toBe(1);
    expect(human.medianCycleHours).toBe(10);
    expect(human.medianPRSizeLines).toBe(100);

    // totalMergedPRs / humanMergedPRs are human-only.
    expect(result.totalMergedPRs).toBe(1);
    expect(result.contributorCount).toBe(1);
    expect(result.hasData).toBe(true);
  });

  it("skips PRs with empty or whitespace-only authors", () => {
    const org = makeOrg([
      makeRepo("org/a", [
        makePR({ number: 1, author: "alice", linesAdded: 5, linesDeleted: 5 }),
        makePR({ number: 2, author: "" }),
        makePR({ number: 3, author: "   " }),
      ]),
    ]);

    const result = computeEngineeringIntelligence(org);
    expect(result.developers.map((d) => d.login)).toEqual(["alice"]);
    expect(result.developers[0].mergedPRs).toBe(1);
    expect(result.totalMergedPRs).toBe(1);
  });

  it("excludes PRs with no line data from size medians but still counts them", () => {
    const org = makeOrg([
      makeRepo("org/a", [
        makePR({
          number: 1,
          author: "carol",
          timeToMergeHours: 5,
          linesAdded: 10,
          linesDeleted: 10,
        }),
        makePR({
          number: 2,
          author: "carol",
          timeToMergeHours: 7,
          // Both undefined → no line data.
          linesAdded: undefined,
          linesDeleted: undefined,
        }),
      ]),
    ]);

    const result = computeEngineeringIntelligence(org);
    const carol = result.developers[0];
    expect(carol.mergedPRs).toBe(2); // counted despite missing line data
    // Only the PR with line data feeds the size median.
    expect(carol.medianPRSizeLines).toBe(20);
    // Cycle median over both PRs: median([5,7]) = 6
    expect(carol.medianCycleHours).toBe(6);
    // Missing-line PR contributes 0 to totals.
    expect(carol.linesChanged).toBe(20);
    expect(carol.linesAdded).toBe(10);
    expect(carol.linesDeleted).toBe(10);
  });

  it("counts PRs with zero cycle time and no line data (mergedPRs is not sample-derived)", () => {
    const org = makeOrg([
      makeRepo("org/a", [
        makePR({
          number: 1,
          author: "dave",
          timeToMergeHours: 0, // dropped from cycle sample
          linesAdded: 5,
          linesDeleted: 5,
        }),
        makePR({
          number: 2,
          author: "dave",
          timeToMergeHours: 3,
          linesAdded: undefined, // dropped from size sample
          linesDeleted: undefined,
        }),
      ]),
    ]);

    const result = computeEngineeringIntelligence(org);
    const dave = result.developers[0];
    // Regression guard: neither the cycle sample ([3]) nor the size sample ([10])
    // has 2 entries, so mergedPRs must come from a raw count, not the samples.
    expect(dave.mergedPRs).toBe(2);
    expect(dave.medianCycleHours).toBe(3); // only the non-zero cycle
    expect(dave.medianPRSizeLines).toBe(10); // only the PR with line data
  });

  it("computes population benchmarks from per-developer stats", () => {
    const org = makeOrg([
      makeRepo("org/a", [
        makePR({ number: 1, author: "alice", timeToMergeHours: 10, linesAdded: 100, linesDeleted: 0 }),
        makePR({ number: 2, author: "alice", timeToMergeHours: 10, linesAdded: 100, linesDeleted: 0 }),
        makePR({ number: 3, author: "bob", timeToMergeHours: 4, linesAdded: 20, linesDeleted: 0 }),
      ]),
    ]);

    const result = computeEngineeringIntelligence(org);
    // Throughput sample = mergedPRs across devs = [2 (alice), 1 (bob)].
    expect(result.throughputBenchmark.max).toBe(2);
    expect(result.throughputBenchmark.p50).toBe(1.5);
    // Cycle benchmark uses per-dev median cycle hours (>0): [10, 4].
    expect(result.cycleTimeBenchmark.max).toBe(10);
    // PR-size benchmark uses per-dev median sizes (>0): [100, 20].
    expect(result.prSizeBenchmark.max).toBe(100);
  });
});

// ── work units ─────────────────────────────────────────────────────────────────

describe("prWorkUnits", () => {
  it("counts a PR without line data as exactly 1 unit", () => {
    expect(prWorkUnits(undefined)).toBe(1);
  });

  it("gives a 32-line PR exactly 1 unit", () => {
    expect(prWorkUnits(32)).toBeCloseTo(1, 10);
  });

  it("floors tiny PRs at 0.25 units", () => {
    expect(prWorkUnits(0)).toBe(0.25);
    expect(prWorkUnits(1)).toBe(0.25);
  });

  it("caps mega-PRs at 4 units", () => {
    expect(prWorkUnits(100_000)).toBe(4);
    // Just below the cap threshold (2^4 - 1) * 32 = 480 lines.
    expect(prWorkUnits(480)).toBeCloseTo(4, 10);
    expect(prWorkUnits(479)).toBeLessThan(4);
  });

  it("grows with diminishing returns", () => {
    const small = prWorkUnits(32);
    const tenX = prWorkUnits(320);
    expect(tenX).toBeGreaterThan(small);
    expect(tenX).toBeLessThan(small * 10);
  });
});

describe("computeEngineeringIntelligence work units", () => {
  it("accumulates calibrated work units per developer and benchmarks them", () => {
    const org = makeOrg([
      makeRepo("org/a", [
        // alice: 32 lines (1 unit) + no line data (1 unit) = 2 units.
        makePR({ number: 1, author: "alice", linesAdded: 32, linesDeleted: 0 }),
        makePR({ number: 2, author: "alice" }),
        // bob: one giant PR, capped at 4 units.
        makePR({ number: 3, author: "bob", linesAdded: 50_000, linesDeleted: 0 }),
      ]),
    ]);

    const result = computeEngineeringIntelligence(org);
    const alice = result.developers.find((d) => d.login === "alice")!;
    const bob = result.developers.find((d) => d.login === "bob")!;
    expect(alice.workUnits).toBeCloseTo(2, 10);
    expect(bob.workUnits).toBe(4);
    expect(result.workUnitsBenchmark.max).toBe(4);
  });

  it("excludes bot and AI-authored PRs from work units", () => {
    const org = makeOrg([
      makeRepo("org/a", [
        makePR({ number: 1, author: "alice", linesAdded: 32, linesDeleted: 0 }),
        makePR({ number: 2, author: "dependabot[bot]", isBotAuthor: true, linesAdded: 5000, linesDeleted: 0 }),
        makePR({ number: 3, author: "copilot-swe-agent", isCopilotAuthored: true, linesAdded: 5000, linesDeleted: 0 }),
      ]),
    ]);

    const result = computeEngineeringIntelligence(org);
    expect(result.developers).toHaveLength(1);
    expect(result.workUnitsBenchmark.max).toBeCloseTo(1, 10);
  });
});
