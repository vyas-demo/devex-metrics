import { describe, it, expect } from "vitest";
import { computeInsights, type InsightInputs } from "./insights.js";
import type {
  OrgMetrics,
  RepoMetrics,
  MergedPRSummary,
  Benchmark,
  AiImpactStats,
  EngineeringIntelligence,
  DoraMetric,
  DoraMetrics,
  ReviewStats,
  HealthReport,
  RepoHealth,
  CollaborationStats,
  RepoBusFactor,
  Insight,
  InsightsSummary,
  TargetEvaluation,
} from "./types.js";

// ── Fixture factories ──────────────────────────────────────────────────────────

/** collectedAt in every fixture — the end of both trend windows. */
const NOW_ISO = "2026-07-13T00:00:00Z";
/** A merge date inside the recent window (last 30 days before NOW_ISO). */
const RECENT_ISO = "2026-07-01T00:00:00Z";
/** A merge date inside the prior window (30–60 days before NOW_ISO). */
const PRIOR_ISO = "2026-06-01T00:00:00Z";

function makePR(overrides: Partial<MergedPRSummary> = {}): MergedPRSummary {
  return {
    number: 1,
    createdAt: "2026-05-01T00:00:00Z",
    mergedAt: RECENT_ISO,
    author: "alice",
    isBotAuthor: false,
    isCopilotAuthored: false,
    timeToMergeHours: 10,
    closesIssues: [],
    ...overrides,
  };
}

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

function makeOrg(repos: RepoMetrics[]): OrgMetrics {
  return {
    owner: "org",
    ownerType: "org",
    collectedAt: NOW_ISO,
    repoCount: repos.length,
    repos,
  };
}

const ZERO_BENCHMARK: Benchmark = { p50: 0, p90: 0, p99: 0, max: 0 };

function makeAiImpact(overrides: Partial<AiImpactStats> = {}): AiImpactStats {
  return {
    aiMergedPRs: 0,
    humanMergedPRs: 0,
    aiShare: 0,
    aiMedianCycleHours: 0,
    humanMedianCycleHours: 0,
    aiMedianPRSize: 0,
    humanMedianPRSize: 0,
    byTool: [],
    ...overrides,
  };
}

function makeIntel(overrides: Partial<EngineeringIntelligence> = {}): EngineeringIntelligence {
  return {
    hasData: false,
    developers: [],
    contributorCount: 0,
    totalMergedPRs: 0,
    throughputBenchmark: ZERO_BENCHMARK,
    cycleTimeBenchmark: ZERO_BENCHMARK,
    prSizeBenchmark: ZERO_BENCHMARK,
    workUnitsBenchmark: ZERO_BENCHMARK,
    aiImpact: makeAiImpact(),
    ...overrides,
  };
}

function makeDoraMetric(overrides: Partial<DoraMetric> = {}): DoraMetric {
  return { value: 0, hasData: false, ...overrides };
}

function makeDora(overrides: Partial<DoraMetrics> = {}): DoraMetrics {
  return {
    hasData: false,
    windowDays: 90,
    deployFrequencyPerWeek: makeDoraMetric(),
    leadTimeHours: makeDoraMetric(),
    changeFailureRate: makeDoraMetric(),
    mttrHours: makeDoraMetric(),
    totalDeploys: 0,
    totalMergedPRs: 0,
    totalReverts: 0,
    ...overrides,
  };
}

function makeReview(overrides: Partial<ReviewStats> = {}): ReviewStats {
  return {
    hasData: false,
    reviewedPRs: 0,
    totalPRs: 0,
    reviewCoverage: 0,
    medianTimeToFirstReviewHours: 0,
    p90TimeToFirstReviewHours: 0,
    reviewers: [],
    topReviewerShare: 0,
    ...overrides,
  };
}

function makeHealth(overrides: Partial<HealthReport> = {}): HealthReport {
  return { hasData: false, repos: [], avgScore: 0, ...overrides };
}

function makeRepoHealth(overrides: Partial<RepoHealth> = {}): RepoHealth {
  return {
    fullName: "org/a",
    score: 50,
    grade: "D",
    components: [],
    needsAttention: true,
    ...overrides,
  };
}

function makeCollab(overrides: Partial<CollaborationStats> = {}): CollaborationStats {
  return {
    hasData: false,
    edges: [],
    reviewerGini: 0,
    busFactors: [],
    siloedContributors: [],
    distinctAuthors: 0,
    distinctReviewers: 0,
    ...overrides,
  };
}

function makeBusFactor(overrides: Partial<RepoBusFactor> = {}): RepoBusFactor {
  return { fullName: "org/a", busFactor: 1, topAuthorShare: 0.8, mergedPRs: 20, ...overrides };
}

function makeInputs(overrides: Partial<InsightInputs> = {}): InsightInputs {
  return {
    intel: makeIntel(),
    dora: makeDora(),
    review: makeReview(),
    health: makeHealth(),
    collaboration: makeCollab(),
    ...overrides,
  };
}

const EMPTY_ORG = makeOrg([]);

/** Run computeInsights with defaults, overriding only what a test cares about. */
function run(
  overrides: Partial<InsightInputs> = {},
  metrics: OrgMetrics = EMPTY_ORG
): InsightsSummary {
  return computeInsights(metrics, makeInputs(overrides));
}

function find(summary: InsightsSummary, id: string): Insight | undefined {
  return summary.insights.find((insight) => insight.id === id);
}

/** Org with `recent` PRs merged at RECENT_ISO and `prior` PRs at PRIOR_ISO. */
function trendOrg(
  recent: Array<Partial<MergedPRSummary>>,
  prior: Array<Partial<MergedPRSummary>>
): OrgMetrics {
  const prs = [
    ...recent.map((o, i) => makePR({ number: i + 1, mergedAt: RECENT_ISO, ...o })),
    ...prior.map((o, i) => makePR({ number: 1000 + i, mergedAt: PRIOR_ISO, ...o })),
  ];
  return makeOrg([makeRepo("org/a", prs)]);
}

/** n PR overrides with the given cycle hours (one per entry). */
function hoursPRs(hours: number[]): Array<Partial<MergedPRSummary>> {
  return hours.map((h) => ({ timeToMergeHours: h }));
}

/** Five PRs all taking `hours` to merge (clean median). */
function five(hours: number): Array<Partial<MergedPRSummary>> {
  return hoursPRs([hours, hours, hours, hours, hours]);
}

/** n empty PR overrides (for throughput counting). */
function countPRs(n: number): Array<Partial<MergedPRSummary>> {
  return Array.from({ length: n }, () => ({}));
}

/** PR overrides with line data (one per size, deletions 0). */
function sizePRs(sizes: number[]): Array<Partial<MergedPRSummary>> {
  return sizes.map((s) => ({ linesAdded: s, linesDeleted: 0 }));
}

// ── hasData & empty input ──────────────────────────────────────────────────────

describe("computeInsights hasData and empty input", () => {
  it("returns no insights, zero counts, and hasData:false for empty inputs", () => {
    const result = run();
    expect(result).toEqual({
      hasData: false,
      insights: [],
      counts: { critical: 0, warning: 0, info: 0, positive: 0 },
    });
  });

  it("sets hasData when any single input has data, even with no findings", () => {
    expect(run({ review: makeReview({ hasData: true }) }).hasData).toBe(true);
    expect(run({ intel: makeIntel({ hasData: true }) }).hasData).toBe(true);
    expect(run({ dora: makeDora({ hasData: true }) }).hasData).toBe(true);
    expect(run({ health: makeHealth({ hasData: true }) }).hasData).toBe(true);
    expect(run({ collaboration: makeCollab({ hasData: true }) }).hasData).toBe(true);
  });
});

// ── review-bottleneck ──────────────────────────────────────────────────────────

describe("review-bottleneck", () => {
  function bottleneckReview(share: number, overrides: Partial<ReviewStats> = {}): ReviewStats {
    return makeReview({
      hasData: true,
      reviewedPRs: 20,
      totalPRs: 20,
      reviewCoverage: 1,
      reviewers: [
        { login: "bob", prsReviewed: 15, loadShare: share },
        { login: "amy", prsReviewed: 5, loadShare: 1 - share },
      ],
      topReviewerShare: share,
      ...overrides,
    });
  }

  it("is critical above 60% and names the top reviewer with their share", () => {
    const insight = find(run({ review: bottleneckReview(0.61) }), "review-bottleneck");
    expect(insight?.severity).toBe("critical");
    expect(insight?.detail).toContain("bob");
    expect(insight?.detail).toContain("61%");
    expect(insight?.recommendation).toBeDefined();
  });

  it("is warning at exactly 60% (critical requires strictly >0.6)", () => {
    expect(find(run({ review: bottleneckReview(0.6) }), "review-bottleneck")?.severity).toBe(
      "warning"
    );
  });

  it("is warning just above 40% and silent at exactly 40%", () => {
    expect(find(run({ review: bottleneckReview(0.41) }), "review-bottleneck")?.severity).toBe(
      "warning"
    );
    expect(find(run({ review: bottleneckReview(0.4) }), "review-bottleneck")).toBeUndefined();
  });

  it("does not fire below 10 reviewed PRs", () => {
    const review = bottleneckReview(0.9, { reviewedPRs: 9, totalPRs: 9 });
    expect(find(run({ review }), "review-bottleneck")).toBeUndefined();
  });

  it("does not fire with fewer than 2 reviewers", () => {
    const review = bottleneckReview(1, {
      reviewers: [{ login: "bob", prsReviewed: 20, loadShare: 1 }],
      topReviewerShare: 1,
    });
    expect(find(run({ review }), "review-bottleneck")).toBeUndefined();
  });
});

// ── low-review-coverage ────────────────────────────────────────────────────────

describe("low-review-coverage", () => {
  function coverageReview(reviewed: number, total: number): ReviewStats {
    return makeReview({
      hasData: true,
      reviewedPRs: reviewed,
      totalPRs: total,
      reviewCoverage: reviewed / total,
    });
  }

  // At least one PR must carry a defined `reviewers` array for the detector
  // to trust the coverage figure (REST-path caches have none, and there 0%
  // coverage means "no review data", not "nobody reviews").
  const REVIEWED_ORG = makeOrg([
    makeRepo("org/reviewed", [makePR({ number: 1, reviewers: ["bob"] })]),
  ]);

  it("is critical below 25% with reviewed/total in the detail", () => {
    const insight = find(
      run({ review: coverageReview(24, 100) }, REVIEWED_ORG),
      "low-review-coverage"
    );
    expect(insight?.severity).toBe("critical");
    expect(insight?.detail).toContain("24 of 100");
    expect(insight?.detail).toContain("24%");
  });

  it("is warning at exactly 25% (critical requires strictly <0.25)", () => {
    expect(
      find(run({ review: coverageReview(25, 100) }, REVIEWED_ORG), "low-review-coverage")
        ?.severity
    ).toBe("warning");
  });

  it("is warning just below 50% and silent at exactly 50%", () => {
    expect(
      find(run({ review: coverageReview(49, 100) }, REVIEWED_ORG), "low-review-coverage")
        ?.severity
    ).toBe("warning");
    expect(
      find(run({ review: coverageReview(50, 100) }, REVIEWED_ORG), "low-review-coverage")
    ).toBeUndefined();
  });

  it("does not fire below 10 total PRs", () => {
    expect(
      find(run({ review: coverageReview(0, 9) }, REVIEWED_ORG), "low-review-coverage")
    ).toBeUndefined();
  });

  it("does not fire when no PR carries review data (REST-path cache)", () => {
    const restOrg = makeOrg([
      makeRepo("org/rest", [makePR({ number: 1, reviewers: undefined })]),
    ]);
    expect(
      find(run({ review: coverageReview(0, 100) }, restOrg), "low-review-coverage")
    ).toBeUndefined();
  });
});

// ── slow-first-review ──────────────────────────────────────────────────────────

describe("slow-first-review", () => {
  function latencyReview(p90: number, med = 20, reviewedPRs = 10): ReviewStats {
    return makeReview({
      hasData: true,
      reviewedPRs,
      totalPRs: reviewedPRs,
      reviewCoverage: 1,
      medianTimeToFirstReviewHours: med,
      p90TimeToFirstReviewHours: p90,
    });
  }

  it("warns when p90 exceeds 48h, reporting p90 and median", () => {
    const insight = find(run({ review: latencyReview(72.5, 20) }), "slow-first-review");
    expect(insight?.severity).toBe("warning");
    expect(insight?.detail).toContain("72.5h");
    expect(insight?.detail).toContain("20h");
  });

  it("does not fire at exactly 48h", () => {
    expect(find(run({ review: latencyReview(48) }), "slow-first-review")).toBeUndefined();
  });

  it("does not fire below 5 reviewed PRs", () => {
    expect(find(run({ review: latencyReview(100, 20, 4) }), "slow-first-review")).toBeUndefined();
  });
});

// ── bus-factor ─────────────────────────────────────────────────────────────────

describe("bus-factor", () => {
  it("warns for busFactor-1 repos with ≥10 merges, listing repos and worst share", () => {
    const collaboration = makeCollab({
      hasData: true,
      busFactors: [
        makeBusFactor({ fullName: "org/a", topAuthorShare: 0.7, mergedPRs: 10 }),
        makeBusFactor({ fullName: "org/b", topAuthorShare: 0.92, mergedPRs: 30 }),
        makeBusFactor({ fullName: "org/safe", busFactor: 3, topAuthorShare: 0.3 }),
      ],
    });
    const insight = find(run({ collaboration }), "bus-factor");
    expect(insight?.severity).toBe("warning");
    expect(insight?.detail).toContain("org/a");
    expect(insight?.detail).toContain("org/b");
    expect(insight?.detail).not.toContain("org/safe");
    expect(insight?.detail).toContain("92%");
    expect(insight?.recommendation).toBeDefined();
  });

  it("lists at most 3 repos", () => {
    const collaboration = makeCollab({
      busFactors: ["org/a", "org/b", "org/c", "org/d"].map((fullName) =>
        makeBusFactor({ fullName })
      ),
    });
    const insight = find(run({ collaboration }), "bus-factor");
    expect(insight?.detail).toContain("org/c");
    expect(insight?.detail).not.toContain("org/d");
  });

  it("ignores repos below 10 merged PRs or with busFactor above 1", () => {
    const collaboration = makeCollab({
      busFactors: [
        makeBusFactor({ mergedPRs: 9 }),
        makeBusFactor({ fullName: "org/b", busFactor: 2 }),
      ],
    });
    expect(find(run({ collaboration }), "bus-factor")).toBeUndefined();
  });
});

// ── knowledge-silos ────────────────────────────────────────────────────────────

describe("knowledge-silos", () => {
  it("emits info at 3 siloed contributors with the count", () => {
    const collaboration = makeCollab({ siloedContributors: ["amy", "bob", "cal"] });
    const insight = find(run({ collaboration }), "knowledge-silos");
    expect(insight?.severity).toBe("info");
    expect(insight?.detail).toContain("3");
    expect(insight?.detail).toContain("amy");
  });

  it("does not fire at 2 siloed contributors", () => {
    const collaboration = makeCollab({ siloedContributors: ["amy", "bob"] });
    expect(find(run({ collaboration }), "knowledge-silos")).toBeUndefined();
  });

  it("lists at most 3 logins of 5", () => {
    const collaboration = makeCollab({
      siloedContributors: ["amy", "bob", "cal", "dee", "eli"],
    });
    const insight = find(run({ collaboration }), "knowledge-silos");
    expect(insight?.detail).toContain("5");
    expect(insight?.detail).toContain("cal");
    expect(insight?.detail).not.toContain("dee");
  });
});

// ── cycle-time-trend ───────────────────────────────────────────────────────────

describe("cycle-time-trend", () => {
  it("warns at exactly 1.3× the prior median with both medians in the detail", () => {
    const insight = find(run({}, trendOrg(five(13), five(10))), "cycle-time-trend");
    expect(insight?.severity).toBe("warning");
    expect(insight?.title).toBe("Cycle time regressed");
    expect(insight?.detail).toContain("10h");
    expect(insight?.detail).toContain("13h");
  });

  it("does not fire just below 1.3×", () => {
    expect(find(run({}, trendOrg(five(12.9), five(10))), "cycle-time-trend")).toBeUndefined();
  });

  it("is positive at exactly 0.8× the prior median", () => {
    const insight = find(run({}, trendOrg(five(8), five(10))), "cycle-time-trend");
    expect(insight?.severity).toBe("positive");
    expect(insight?.title).toBe("Cycle time improved");
  });

  it("does not fire just above 0.8×", () => {
    expect(find(run({}, trendOrg(five(8.1), five(10))), "cycle-time-trend")).toBeUndefined();
  });

  it("does not fire when a window has fewer than 5 cycle samples", () => {
    expect(
      find(run({}, trendOrg(hoursPRs([13, 13, 13, 13]), five(10))), "cycle-time-trend")
    ).toBeUndefined();
  });

  it("excludes zero-hour PRs from the cycle sample", () => {
    // Recent has 5 PRs but only 4 with positive cycle time → below the minimum.
    const org = trendOrg(hoursPRs([13, 13, 13, 13, 0]), five(10));
    expect(find(run({}, org), "cycle-time-trend")).toBeUndefined();
  });

  it("stays silent when both medians are under an hour (minute-scale noise)", () => {
    // 0.1h → 0.3h is a 3× ratio but a 12-minute swing nobody should act on.
    expect(find(run({}, trendOrg(five(0.3), five(0.1))), "cycle-time-trend")).toBeUndefined();
    // Crossing the hour threshold fires normally.
    expect(find(run({}, trendOrg(five(1.5), five(1))), "cycle-time-trend")?.severity).toBe(
      "warning"
    );
  });
});

// ── throughput-trend ───────────────────────────────────────────────────────────

describe("throughput-trend", () => {
  it("is positive at exactly 1.3× prior merges with both counts in the detail", () => {
    const insight = find(run({}, trendOrg(countPRs(13), countPRs(10))), "throughput-trend");
    expect(insight?.severity).toBe("positive");
    expect(insight?.detail).toContain("13");
    expect(insight?.detail).toContain("10");
  });

  it("warns at exactly 0.7× prior merges", () => {
    const insight = find(run({}, trendOrg(countPRs(7), countPRs(10))), "throughput-trend");
    expect(insight?.severity).toBe("warning");
  });

  it("does not fire between the thresholds", () => {
    expect(find(run({}, trendOrg(countPRs(12), countPRs(10))), "throughput-trend")).toBeUndefined();
  });

  it("does not fire when combined merges are below 10", () => {
    expect(find(run({}, trendOrg(countPRs(6), countPRs(3))), "throughput-trend")).toBeUndefined();
  });

  it("counts only human-authored PRs", () => {
    // With bots/AI counted the ratio would be 17/10 = 1.7 (positive);
    // human-only it is 12/10 = 1.2 → no insight.
    const recent = [
      ...countPRs(12),
      ...Array.from({ length: 3 }, () => ({
        author: "dependabot[bot]",
        isBotAuthor: true,
      })),
      ...Array.from({ length: 2 }, () => ({ isCopilotAuthored: true })),
    ];
    expect(find(run({}, trendOrg(recent, countPRs(10))), "throughput-trend")).toBeUndefined();
  });
});

// ── pr-size-trend ──────────────────────────────────────────────────────────────

describe("pr-size-trend", () => {
  it("emits info at exactly 1.5× the prior median size", () => {
    const org = trendOrg(sizePRs([150, 150, 150, 150, 150]), sizePRs([100, 100, 100, 100, 100]));
    const insight = find(run({}, org), "pr-size-trend");
    expect(insight?.severity).toBe("info");
    expect(insight?.detail).toContain("100");
    expect(insight?.detail).toContain("150");
    expect(insight?.recommendation).toContain("small");
  });

  it("does not fire just below 1.5×", () => {
    const org = trendOrg(sizePRs([149, 149, 149, 149, 149]), sizePRs([100, 100, 100, 100, 100]));
    expect(find(run({}, org), "pr-size-trend")).toBeUndefined();
  });

  it("requires 5 PRs with line data in each window", () => {
    // Recent has 5 PRs, but only 4 carry line data.
    const recent = [...sizePRs([150, 150, 150, 150]), {}];
    const org = trendOrg(recent, sizePRs([100, 100, 100, 100, 100]));
    expect(find(run({}, org), "pr-size-trend")).toBeUndefined();
  });
});

// ── change-failure ─────────────────────────────────────────────────────────────

describe("change-failure", () => {
  function cfrDora(tier: DoraMetric["tier"], value = 0.2): DoraMetrics {
    return makeDora({
      hasData: true,
      changeFailureRate: makeDoraMetric({ value, tier, hasData: true }),
      totalMergedPRs: 50,
      totalReverts: 10,
    });
  }

  it("is critical for tier low with reverts/merged and rate in the detail", () => {
    const insight = find(run({ dora: cfrDora("low") }), "change-failure");
    expect(insight?.severity).toBe("critical");
    expect(insight?.detail).toContain("10 of 50");
    expect(insight?.detail).toContain("20%");
    expect(insight?.recommendation).toBeDefined();
  });

  it("is warning for tier medium", () => {
    expect(find(run({ dora: cfrDora("medium", 0.12) }), "change-failure")?.severity).toBe(
      "warning"
    );
  });

  it("does not fire for tiers high or elite", () => {
    expect(find(run({ dora: cfrDora("high", 0.08) }), "change-failure")).toBeUndefined();
    expect(find(run({ dora: cfrDora("elite", 0.02) }), "change-failure")).toBeUndefined();
  });

  it("does not fire without change-failure data", () => {
    expect(find(run({ dora: makeDora({ hasData: true }) }), "change-failure")).toBeUndefined();
  });

  it("cites labeled incidents instead of reverts when that signal fed CFR", () => {
    const dora = { ...cfrDora("low"), failureSignal: "incidents" as const, totalIncidents: 4 };
    const insight = find(run({ dora }), "change-failure");
    expect(insight?.detail).toContain("4 labeled incidents");
    expect(insight?.detail).not.toContain("reverts");
  });
});

// ── dora-elite ─────────────────────────────────────────────────────────────────

describe("dora-elite", () => {
  it("is positive with 2 elite tiers and no low tier, naming the elite metrics", () => {
    const dora = makeDora({
      hasData: true,
      deployFrequencyPerWeek: makeDoraMetric({ value: 10, tier: "elite", hasData: true }),
      leadTimeHours: makeDoraMetric({ value: 12, tier: "elite", hasData: true }),
      changeFailureRate: makeDoraMetric({ value: 0.08, tier: "high", hasData: true }),
    });
    const insight = find(run({ dora }), "dora-elite");
    expect(insight?.severity).toBe("positive");
    expect(insight?.detail).toContain("deploy frequency");
    expect(insight?.detail).toContain("lead time");
    expect(insight?.detail).not.toContain("MTTR");
  });

  it("does not fire when any metric is tier low", () => {
    const dora = makeDora({
      hasData: true,
      deployFrequencyPerWeek: makeDoraMetric({ value: 10, tier: "elite", hasData: true }),
      leadTimeHours: makeDoraMetric({ value: 12, tier: "elite", hasData: true }),
      mttrHours: makeDoraMetric({ value: 500, tier: "low", hasData: true }),
    });
    expect(find(run({ dora }), "dora-elite")).toBeUndefined();
  });

  it("does not fire with only 1 elite metric", () => {
    const dora = makeDora({
      hasData: true,
      leadTimeHours: makeDoraMetric({ value: 12, tier: "elite", hasData: true }),
    });
    expect(find(run({ dora }), "dora-elite")).toBeUndefined();
  });
});

// ── unhealthy-repos ────────────────────────────────────────────────────────────

describe("unhealthy-repos", () => {
  it("is info for a single grade-D repo, listing it with its grade", () => {
    const health = makeHealth({
      hasData: true,
      repos: [makeRepoHealth({ fullName: "org/sick", score: 45, grade: "D" })],
    });
    const insight = find(run({ health }), "unhealthy-repos");
    expect(insight?.severity).toBe("info");
    expect(insight?.detail).toContain("org/sick (D)");
  });

  it("escalates to warning with 3 repos needing attention", () => {
    const health = makeHealth({
      hasData: true,
      repos: ["org/a", "org/b", "org/c"].map((fullName) => makeRepoHealth({ fullName })),
    });
    expect(find(run({ health }), "unhealthy-repos")?.severity).toBe("warning");
  });

  it("escalates to warning when any repo has grade F", () => {
    const health = makeHealth({
      hasData: true,
      repos: [makeRepoHealth({ fullName: "org/f", score: 20, grade: "F" })],
    });
    expect(find(run({ health }), "unhealthy-repos")?.severity).toBe("warning");
  });

  it("lists only the worst 3 repos by score", () => {
    const health = makeHealth({
      hasData: true,
      repos: [
        makeRepoHealth({ fullName: "org/ok", score: 54 }),
        makeRepoHealth({ fullName: "org/bad", score: 30 }),
        makeRepoHealth({ fullName: "org/worse", score: 20 }),
        makeRepoHealth({ fullName: "org/worst", score: 10, grade: "F" }),
      ],
    });
    const insight = find(run({ health }), "unhealthy-repos");
    expect(insight?.detail).toContain("org/worst (F)");
    expect(insight?.detail).toContain("org/worse");
    expect(insight?.detail).toContain("org/bad");
    expect(insight?.detail).not.toContain("org/ok");
  });

  it("does not fire when no repo needs attention", () => {
    const health = makeHealth({
      hasData: true,
      repos: [makeRepoHealth({ score: 90, grade: "A", needsAttention: false })],
    });
    expect(find(run({ health }), "unhealthy-repos")).toBeUndefined();
  });
});

// ── ai-adoption ────────────────────────────────────────────────────────────────

describe("ai-adoption", () => {
  function aiIntel(overrides: Partial<AiImpactStats>): EngineeringIntelligence {
    return makeIntel({
      hasData: true,
      aiImpact: makeAiImpact({ aiMergedPRs: 10, humanMergedPRs: 30, aiShare: 0.25, ...overrides }),
    });
  }

  it("emits info at exactly 5 AI PRs and 20% share, with the share in the detail", () => {
    const intel = aiIntel({ aiMergedPRs: 5, humanMergedPRs: 20, aiShare: 0.2 });
    const insight = find(run({ intel }), "ai-adoption");
    expect(insight?.severity).toBe("info");
    expect(insight?.detail).toContain("20%");
  });

  it("does not fire below 5 AI PRs or below 20% share", () => {
    expect(find(run({ intel: aiIntel({ aiMergedPRs: 4 }) }), "ai-adoption")).toBeUndefined();
    expect(find(run({ intel: aiIntel({ aiShare: 0.19 }) }), "ai-adoption")).toBeUndefined();
  });

  it("appends a faster-than-human comparison when AI cycle is lower", () => {
    const intel = aiIntel({ aiMedianCycleHours: 12, humanMedianCycleHours: 30 });
    const insight = find(run({ intel }), "ai-adoption");
    expect(insight?.detail).toContain("faster");
    expect(insight?.detail).toContain("12h");
    expect(insight?.detail).toContain("30h");
  });

  it("appends a slower-than-human comparison when AI cycle is higher", () => {
    const intel = aiIntel({ aiMedianCycleHours: 40, humanMedianCycleHours: 30 });
    expect(find(run({ intel }), "ai-adoption")?.detail).toContain("slower");
  });

  it("omits the comparison when either median cycle is 0", () => {
    const intel = aiIntel({ aiMedianCycleHours: 0, humanMedianCycleHours: 30 });
    const insight = find(run({ intel }), "ai-adoption");
    expect(insight?.detail).not.toContain("faster");
    expect(insight?.detail).not.toContain("slower");
  });
});

// ── stale-repos ────────────────────────────────────────────────────────────────

describe("stale-repos", () => {
  const OLD_ISO = "2026-03-01T00:00:00Z"; // well over 60 days before NOW_ISO

  it("emits info for a repo with old merges and open issues, naming it", () => {
    const repo = makeRepo("org/stale", [makePR({ mergedAt: OLD_ISO })], {
      issues: { open: 2, closed: 5 },
    });
    const insight = find(run({}, makeOrg([repo])), "stale-repos");
    expect(insight?.severity).toBe("info");
    expect(insight?.detail).toContain("org/stale");
  });

  it("counts open PRs as open work too", () => {
    const repo = makeRepo("org/stale", [makePR({ mergedAt: OLD_ISO })], {
      pullRequests: { open: 1, closed: 0, merged: 1 },
    });
    expect(find(run({}, makeOrg([repo])), "stale-repos")).toBeDefined();
  });

  it("does not fire when a merge happened within 60 days", () => {
    const repo = makeRepo(
      "org/active",
      [makePR({ mergedAt: OLD_ISO }), makePR({ number: 2, mergedAt: RECENT_ISO })],
      { issues: { open: 2, closed: 0 } }
    );
    expect(find(run({}, makeOrg([repo])), "stale-repos")).toBeUndefined();
  });

  it("does not fire without open issues or PRs", () => {
    const repo = makeRepo("org/done", [makePR({ mergedAt: OLD_ISO })]);
    expect(find(run({}, makeOrg([repo])), "stale-repos")).toBeUndefined();
  });

  it("ignores repos with an empty merge timeline", () => {
    const repo = makeRepo("org/empty", [], { issues: { open: 3, closed: 0 } });
    expect(find(run({}, makeOrg([repo])), "stale-repos")).toBeUndefined();
  });
});

// ── ordering & counts ──────────────────────────────────────────────────────────

describe("severity ordering and counts", () => {
  it("sorts critical → warning → info → positive, stable by detector order", () => {
    const result = run({
      // Critical review-bottleneck + warning slow-first-review from one input.
      review: makeReview({
        hasData: true,
        reviewedPRs: 20,
        totalPRs: 20,
        reviewCoverage: 1,
        medianTimeToFirstReviewHours: 30,
        p90TimeToFirstReviewHours: 60,
        reviewers: [
          { login: "bob", prsReviewed: 14, loadShare: 0.7 },
          { login: "amy", prsReviewed: 6, loadShare: 0.3 },
        ],
        topReviewerShare: 0.7,
      }),
      // Warning bus-factor + info knowledge-silos.
      collaboration: makeCollab({
        hasData: true,
        busFactors: [makeBusFactor()],
        siloedContributors: ["amy", "bob", "cal"],
      }),
      // Positive dora-elite.
      dora: makeDora({
        hasData: true,
        deployFrequencyPerWeek: makeDoraMetric({ value: 10, tier: "elite", hasData: true }),
        leadTimeHours: makeDoraMetric({ value: 12, tier: "elite", hasData: true }),
      }),
    });

    expect(result.insights.map((insight) => insight.id)).toEqual([
      "review-bottleneck",
      "slow-first-review",
      "bus-factor",
      "knowledge-silos",
      "dora-elite",
    ]);
    expect(result.insights.map((insight) => insight.severity)).toEqual([
      "critical",
      "warning",
      "warning",
      "info",
      "positive",
    ]);
    expect(result.counts).toEqual({ critical: 1, warning: 2, info: 1, positive: 1 });
    expect(result.hasData).toBe(true);
  });
});

// ── targets ────────────────────────────────────────────────────────────────────

function makeTarget(overrides: Partial<TargetEvaluation> = {}): TargetEvaluation {
  return {
    id: "max-median-cycle-hours",
    label: "Median cycle time",
    target: 24,
    actual: 12,
    met: true,
    hasData: true,
    detail: "Median cycle time 12.0h is within the 24h target.",
    ...overrides,
  };
}

describe("targets-missed / targets-met", () => {
  it("warns with the missed target's detail when a target with data is missed", () => {
    const missed = makeTarget({ met: false, actual: 30, detail: "Median cycle time 30.0h exceeds the 24h target." });
    const insight = find(run({ targets: [missed, makeTarget({ id: "min-review-coverage", label: "Review coverage" })] }), "targets-missed");
    expect(insight?.severity).toBe("warning");
    expect(insight?.title).toBe("1 team target missed");
    expect(insight?.detail).toContain("exceeds the 24h target");
    expect(find(run({ targets: [missed] }), "targets-met")).toBeUndefined();
  });

  it("ignores missed targets that had no data to evaluate", () => {
    const noData = makeTarget({ met: false, hasData: false });
    expect(find(run({ targets: [noData] }), "targets-missed")).toBeUndefined();
    expect(find(run({ targets: [noData] }), "targets-met")).toBeUndefined();
  });

  it("celebrates when every evaluated target is met", () => {
    const insight = find(
      run({ targets: [makeTarget(), makeTarget({ id: "min-review-coverage", label: "Review coverage" })] }),
      "targets-met"
    );
    expect(insight?.severity).toBe("positive");
    expect(insight?.title).toBe("All 2 team targets met");
  });

  it("emits neither insight when no targets are configured", () => {
    expect(find(run({}), "targets-missed")).toBeUndefined();
    expect(find(run({}), "targets-met")).toBeUndefined();
  });
});

// ── weekly anomalies ───────────────────────────────────────────────────────────

/**
 * Build an org whose weeklyTrends carry the given per-week values for one
 * field. The LAST value is the in-progress week (never evaluated); the one
 * before it is the evaluated week.
 */
function trendsOrg(field: "prsMerged" | "issuesOpened", values: number[]): OrgMetrics {
  return {
    ...makeOrg([]),
    weeklyTrends: values.map((value, i) => ({
      week: `2026-W${String(i + 1).padStart(2, "0")}`,
      prsOpened: 0,
      prsMerged: field === "prsMerged" ? value : 0,
      issuesOpened: field === "issuesOpened" ? value : 0,
      issuesClosed: 0,
      linesAdded: 0,
      linesDeleted: 0,
    })),
  };
}

/** 12 baseline weeks alternating 7/13 (mean 10, sd 3), then `evaluated`, then a partial week. */
function anomalySeries(evaluated: number, partial = 999): number[] {
  const baseline = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? 7 : 13));
  return [...baseline, evaluated, partial];
}

describe("merge-anomaly", () => {
  it("warns on a sharp drop (z ≤ −2) with week and baseline in the detail", () => {
    const insight = find(run({}, trendsOrg("prsMerged", anomalySeries(1))), "merge-anomaly");
    expect(insight?.severity).toBe("warning");
    expect(insight?.title).toBe("Merge activity dropped sharply");
    expect(insight?.detail).toContain("2026-W13");
    expect(insight?.detail).toContain("10");
  });

  it("reports a spike (z ≥ 2) as info", () => {
    const insight = find(run({}, trendsOrg("prsMerged", anomalySeries(30))), "merge-anomaly");
    expect(insight?.severity).toBe("info");
    expect(insight?.title).toBe("Merge activity spiked");
  });

  it("never evaluates the in-progress final week", () => {
    // Evaluated week is normal; the wild value sits in the partial week.
    expect(find(run({}, trendsOrg("prsMerged", anomalySeries(10, 0))), "merge-anomaly")).toBeUndefined();
  });

  it("stays silent within the band, below the absolute floor, and on flat series", () => {
    // z below 2 in magnitude.
    expect(find(run({}, trendsOrg("prsMerged", anomalySeries(6))), "merge-anomaly")).toBeUndefined();
    // Flat baseline → zero variance → no anomaly math.
    const flat = [...Array.from({ length: 12 }, () => 10), 0, 999];
    expect(find(run({}, trendsOrg("prsMerged", flat)), "merge-anomaly")).toBeUndefined();
    // Series too short.
    expect(find(run({}, trendsOrg("prsMerged", [7, 13, 7, 13, 1, 999])), "merge-anomaly")).toBeUndefined();
  });
});

describe("issue-influx-anomaly", () => {
  it("warns on an issue-opening spike", () => {
    const insight = find(run({}, trendsOrg("issuesOpened", anomalySeries(30))), "issue-influx-anomaly");
    expect(insight?.severity).toBe("warning");
    expect(insight?.title).toBe("Issue influx spike");
    expect(insight?.recommendation).toContain("Triage");
  });

  it("does not fire on a drop in issue openings", () => {
    expect(
      find(run({}, trendsOrg("issuesOpened", anomalySeries(1))), "issue-influx-anomaly")
    ).toBeUndefined();
  });
});
