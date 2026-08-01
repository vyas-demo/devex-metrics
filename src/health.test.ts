import { describe, it, expect } from "vitest";
import { computeHealthReport, healthGrade } from "./health.js";
import type {
  OrgMetrics,
  RepoMetrics,
  MergedPRSummary,
  RepoHealth,
  HealthComponent,
} from "./types.js";

// ── Fixture factories ──────────────────────────────────────────────────────────

/** Default `now` in every fixture (= collectedAt). */
const NOW_ISO = "2026-07-13T00:00:00Z";

/** Build a MergedPRSummary with sensible defaults; override the fields a test cares about. */
function makePR(overrides: Partial<MergedPRSummary> = {}): MergedPRSummary {
  return {
    number: 1,
    createdAt: "2026-07-10T00:00:00Z",
    mergedAt: "2026-07-11T00:00:00Z",
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
function makeOrg(repos: RepoMetrics[]): OrgMetrics {
  return {
    owner: "org",
    ownerType: "org",
    collectedAt: NOW_ISO,
    repoCount: repos.length,
    repos,
  };
}

/**
 * A repo that scores 100 on all six components: six distinct human authors,
 * fresh merges, everything reviewed, fast cycle times, zero reverts, and a
 * mostly closed issue backlog.
 */
function makeHealthyRepo(fullName = "org/healthy"): RepoMetrics {
  const authors = ["alice", "bob", "carol", "dave", "erin", "frank"];
  const prs = authors.map((author, i) =>
    makePR({
      number: i + 1,
      author,
      mergedAt: "2026-07-11T00:00:00Z", // 2 days before NOW_ISO
      timeToMergeHours: 10,
      reviewers: ["reviewer"],
    })
  );
  return makeRepo(fullName, prs, { issues: { open: 1, closed: 9 } });
}

/**
 * A repo that bottoms out everywhere except redundancy: one author, merges
 * over a year old, nothing reviewed, ~400h cycle times, 2/6 reverts, and an
 * 80%-open backlog. Weighted composite: (25×2)/12 = 4.17 → 4.
 */
function makeStaleRepo(fullName = "org/stale"): RepoMetrics {
  const prs = Array.from({ length: 6 }, (_, i) =>
    makePR({
      number: i + 1,
      author: "solo",
      createdAt: "2025-05-15T00:00:00Z",
      mergedAt: "2025-06-01T00:00:00Z", // >180 days before NOW_ISO
      timeToMergeHours: 400,
      reviewers: [],
      isRevert: i < 2,
    })
  );
  return makeRepo(fullName, prs, { issues: { open: 4, closed: 1 } });
}

/** The single RepoHealth in a report, asserting there is exactly one. */
function onlyRepo(metrics: OrgMetrics, options?: { now?: string }): RepoHealth {
  const report = computeHealthReport(metrics, options);
  expect(report.repos).toHaveLength(1);
  return report.repos[0];
}

/** A component by id, asserting it exists. */
function getComponent(repo: RepoHealth, id: string): HealthComponent {
  const component = repo.components.find((c) => c.id === id);
  if (!component) throw new Error(`missing component ${id}`);
  return component;
}

// ── computeHealthReport ────────────────────────────────────────────────────────

describe("computeHealthReport", () => {
  it("returns hasData:false, no repos, and avgScore 0 for empty metrics", () => {
    expect(computeHealthReport(makeOrg([]))).toEqual({
      hasData: false,
      repos: [],
      avgScore: 0,
    });
  });

  it("emits the six components with expected ids, labels, and weights", () => {
    const repo = onlyRepo(makeOrg([makeHealthyRepo()]));
    expect(repo.components.map((c) => [c.id, c.label, c.weight])).toEqual([
      ["activity", "Activity", 3],
      ["review-coverage", "Review coverage", 2],
      ["cycle-time", "Cycle time", 2],
      ["change-failure", "Change failure", 2],
      ["redundancy", "Contributor redundancy", 2],
      ["backlog", "Issue backlog", 1],
    ]);
  });

  it("grades a healthy, active, well-reviewed repo A with all components at 100", () => {
    const repo = onlyRepo(makeOrg([makeHealthyRepo()]));

    for (const component of repo.components) expect(component.score).toBe(100);
    expect(repo.score).toBe(100);
    expect(repo.grade).toBe("A");
    expect(repo.needsAttention).toBe(false);
    expect(getComponent(repo, "activity").detail).toBe("Last activity 2 days ago");
  });

  it("scores a stale single-author repo with reverts low and flags needsAttention", () => {
    const repo = onlyRepo(makeOrg([makeStaleRepo()]));

    expect(getComponent(repo, "activity").score).toBe(0);
    expect(getComponent(repo, "review-coverage").score).toBe(0);
    expect(getComponent(repo, "cycle-time").score).toBe(0); // 400h ≥ 336h
    expect(getComponent(repo, "change-failure").score).toBe(0); // 2/6 ≥ 15%
    expect(getComponent(repo, "redundancy").score).toBe(25); // one author
    expect(getComponent(repo, "backlog").score).toBe(0); // 4/5 open = 0.8

    // Weighted mean: 25×2 / 12 = 4.17 → 4.
    expect(repo.score).toBe(4);
    expect(repo.grade).toBe("F");
    expect(repo.needsAttention).toBe(true); // low score AND merged PRs present
  });

  it("REST-sourced timeline: review and backlog undefined, composite from the rest", () => {
    // No `reviewers` arrays (REST fallback), no line data, no tracked issues.
    const prs = Array.from({ length: 5 }, (_, i) =>
      makePR({ number: i + 1, author: "alice", mergedAt: "2026-07-11T00:00:00Z" })
    );
    const repo = onlyRepo(makeOrg([makeRepo("org/rest", prs)]));

    expect(getComponent(repo, "review-coverage").score).toBeUndefined();
    expect(getComponent(repo, "backlog").score).toBeUndefined();
    expect(getComponent(repo, "activity").score).toBe(100);
    expect(getComponent(repo, "cycle-time").score).toBe(100); // median 10h ≤ 24h
    expect(getComponent(repo, "change-failure").score).toBe(100); // 0/5 reverts
    expect(getComponent(repo, "redundancy").score).toBe(25); // one author

    // (100×3 + 100×2 + 100×2 + 25×2) / 9 = 83.33 → 83 → B.
    expect(repo.score).toBe(83);
    expect(repo.grade).toBe("B");
  });

  it("excludes a repo where no component has data", () => {
    // Empty timeline, no pushedAt, zero issues → all six signals absent.
    const dead = makeRepo("org/dead", []);
    const report = computeHealthReport(makeOrg([dead, makeHealthyRepo()]));

    expect(report.repos.map((r) => r.fullName)).toEqual(["org/healthy"]);

    const alone = computeHealthReport(makeOrg([dead]));
    expect(alone.hasData).toBe(false);
    expect(alone.repos).toEqual([]);
    expect(alone.avgScore).toBe(0);
  });

  it("sorts repos by score ascending (worst first)", () => {
    const report = computeHealthReport(
      makeOrg([makeHealthyRepo("org/good"), makeStaleRepo("org/bad")])
    );
    expect(report.repos.map((r) => r.fullName)).toEqual(["org/bad", "org/good"]);
  });

  it("breaks score ties by fullName ascending", () => {
    const report = computeHealthReport(
      makeOrg([makeHealthyRepo("org/zebra"), makeHealthyRepo("org/apple")])
    );
    expect(report.repos.map((r) => r.score)).toEqual([100, 100]);
    expect(report.repos.map((r) => r.fullName)).toEqual(["org/apple", "org/zebra"]);
  });

  it("averages composite scores across repos", () => {
    const report = computeHealthReport(makeOrg([makeHealthyRepo(), makeStaleRepo()]));
    expect(report.hasData).toBe(true);
    // Scores 100 and 4 → mean 52.
    expect(report.avgScore).toBe(52);
  });

  it("does not flag needsAttention on a low-scoring repo with no activity signal of life", () => {
    // Only activity has data (old push); no merged PRs, no open issues.
    const repo = onlyRepo(
      makeOrg([makeRepo("org/quiet", [], { pushedAt: "2026-04-10T12:00:00Z" })])
    );
    // 93.5 days since push → 100×(180−93.5)/173 = 50 → grade D.
    expect(repo.score).toBe(50);
    expect(repo.grade).toBe("D");
    expect(repo.needsAttention).toBe(false);
  });

  it("flags needsAttention on a low-scoring repo whose only life sign is open issues", () => {
    const repo = onlyRepo(
      makeOrg([
        makeRepo("org/ignored", [], {
          pushedAt: "2020-01-01T00:00:00Z",
          issues: { open: 8, closed: 0 },
        }),
      ])
    );
    expect(repo.score).toBe(0); // activity 0 (w3) + backlog 0 (w1)
    expect(repo.needsAttention).toBe(true);
  });

  describe("activity component", () => {
    it("uses the max of pushedAt and the latest merge", () => {
      const repo = onlyRepo(
        makeOrg([
          makeRepo("org/a", [makePR({ mergedAt: "2026-07-11T00:00:00Z" })], {
            pushedAt: "2020-01-01T00:00:00Z",
          }),
        ])
      );
      expect(getComponent(repo, "activity").score).toBe(100);
    });

    it("interpolates linearly between 7 and 180 days", () => {
      // 93.5 days since the only signal → exactly the midpoint score 50.
      const repo = onlyRepo(
        makeOrg([makeRepo("org/a", [], { pushedAt: "2026-04-10T12:00:00Z" })])
      );
      const activity = getComponent(repo, "activity");
      expect(activity.score).toBe(50);
      expect(activity.detail).toBe("Last activity 94 days ago");
    });

    it("defaults `now` to collectedAt and honors options.now", () => {
      const org = makeOrg([
        makeRepo("org/a", [makePR({ mergedAt: "2020-05-01T00:00:00Z", timeToMergeHours: 400 })]),
      ]);
      // Relative to collectedAt (2026-07-13) the 2020 merge is ancient…
      expect(getComponent(onlyRepo(org), "activity").score).toBe(0);
      // …but with `now` pinned two days after the merge it is fresh.
      expect(
        getComponent(onlyRepo(org, { now: "2020-05-03T00:00:00Z" }), "activity").score
      ).toBe(100);
    });
  });

  describe("review-coverage component", () => {
    it("only counts PRs whose reviewers array is defined", () => {
      const repo = onlyRepo(
        makeOrg([
          makeRepo("org/a", [
            makePR({ number: 1, reviewers: ["bob"] }),
            makePR({ number: 2, reviewers: [] }),
            makePR({ number: 3 }), // reviewers undefined → excluded
            makePR({ number: 4 }),
            makePR({ number: 5 }),
          ]),
        ])
      );
      const coverage = getComponent(repo, "review-coverage");
      expect(coverage.score).toBe(50); // 1 of 2 with data
      expect(coverage.detail).toBe("1 of 2 merged PRs reviewed (50%)");
    });
  });

  describe("cycle-time component", () => {
    it("scores the log-space midpoint of 24h and 336h as 50", () => {
      const repo = onlyRepo(
        makeOrg([
          makeRepo("org/a", [makePR({ timeToMergeHours: Math.sqrt(24 * 336) })]),
        ])
      );
      const cycle = getComponent(repo, "cycle-time");
      expect(cycle.score).toBe(50);
      expect(cycle.detail).toBe("median 90h created→merged");
    });

    it("uses only human-authored PRs for the median", () => {
      const repo = onlyRepo(
        makeOrg([
          makeRepo("org/a", [
            makePR({ number: 1, author: "alice", timeToMergeHours: 10 }),
            makePR({
              number: 2,
              author: "dependabot[bot]",
              isBotAuthor: true,
              timeToMergeHours: 1000,
            }),
            makePR({
              number: 3,
              author: "copilot",
              isCopilotAuthored: true,
              timeToMergeHours: 1000,
            }),
          ]),
        ])
      );
      expect(getComponent(repo, "cycle-time").score).toBe(100);
      expect(getComponent(repo, "redundancy").detail).toBe("1 distinct human author");
    });
  });

  describe("change-failure component", () => {
    it("interpolates linearly: 7.5% revert rate scores 50", () => {
      const prs = Array.from({ length: 40 }, (_, i) =>
        makePR({ number: i + 1, isRevert: i < 3 })
      );
      const cfr = getComponent(onlyRepo(makeOrg([makeRepo("org/a", prs)])), "change-failure");
      expect(cfr.score).toBe(50);
      expect(cfr.detail).toBe("8% revert rate over 40 merged PRs");
    });

    it("is undefined with fewer than 5 merged PRs", () => {
      const prs = Array.from({ length: 4 }, (_, i) => makePR({ number: i + 1 }));
      const cfr = getComponent(onlyRepo(makeOrg([makeRepo("org/a", prs)])), "change-failure");
      expect(cfr.score).toBeUndefined();
    });
  });

  describe("redundancy component", () => {
    it.each([
      [1, 25],
      [2, 55],
      [3, 75],
      [4, 90],
      [5, 100],
      [7, 100],
    ])("maps %i distinct human authors to score %i", (authorCount, expected) => {
      const prs = Array.from({ length: authorCount }, (_, i) =>
        makePR({ number: i + 1, author: `dev${i}` })
      );
      const repo = onlyRepo(makeOrg([makeRepo("org/a", prs)]));
      expect(getComponent(repo, "redundancy").score).toBe(expected);
    });
  });

  describe("backlog component", () => {
    it("interpolates linearly: 50% open scores 50", () => {
      const repo = onlyRepo(
        makeOrg([makeRepo("org/a", [], { pushedAt: NOW_ISO, issues: { open: 5, closed: 5 } })])
      );
      const backlog = getComponent(repo, "backlog");
      expect(backlog.score).toBe(50);
      expect(backlog.detail).toBe("5 open of 10 tracked issues (50% open)");
    });

    it("scores 100 at a 20% open ratio and 0 at 80%", () => {
      const at20 = onlyRepo(
        makeOrg([makeRepo("org/a", [], { pushedAt: NOW_ISO, issues: { open: 1, closed: 4 } })])
      );
      expect(getComponent(at20, "backlog").score).toBe(100);

      const at80 = onlyRepo(
        makeOrg([makeRepo("org/a", [], { pushedAt: NOW_ISO, issues: { open: 4, closed: 1 } })])
      );
      expect(getComponent(at80, "backlog").score).toBe(0);
    });

    it("is undefined with fewer than 5 tracked issues", () => {
      const repo = onlyRepo(
        makeOrg([makeRepo("org/a", [], { pushedAt: NOW_ISO, issues: { open: 2, closed: 2 } })])
      );
      expect(getComponent(repo, "backlog").score).toBeUndefined();
    });
  });
});

// ── healthGrade ────────────────────────────────────────────────────────────────

describe("healthGrade", () => {
  it.each([
    [100, "A"],
    [85, "A"],
    [84, "B"],
    [70, "B"],
    [69, "C"],
    [55, "C"],
    [54, "D"],
    [40, "D"],
    [39, "F"],
    [0, "F"],
  ])("grades %i as %s", (score, expected) => {
    expect(healthGrade(score)).toBe(expected);
  });
});
