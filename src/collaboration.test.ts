import { describe, it, expect } from "vitest";
import { computeCollaborationStats } from "./collaboration.js";
import type { OrgMetrics, RepoMetrics, MergedPRSummary } from "./types.js";

// ── Fixture factories ──────────────────────────────────────────────────────────

/** Build a MergedPRSummary with sensible defaults; override the fields a test cares about. */
function makePR(overrides: Partial<MergedPRSummary> = {}): MergedPRSummary {
  return {
    number: 1,
    createdAt: "2026-05-01T00:00:00Z",
    mergedAt: "2026-05-02T00:00:00Z",
    author: "alice",
    isBotAuthor: false,
    isCopilotAuthored: false,
    timeToMergeHours: 10,
    closesIssues: [],
    ...overrides,
  };
}

/** Build a RepoMetrics with a merged-PR timeline. */
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

/** `count` human PRs by `author` (optionally reviewed by `reviewers`), numbered from `startNumber`. */
function prsBy(
  author: string,
  count: number,
  reviewers?: string[],
  startNumber = 1
): MergedPRSummary[] {
  return Array.from({ length: count }, (_, i) =>
    makePR({ number: startNumber + i, author, reviewers })
  );
}

// ── computeCollaborationStats ──────────────────────────────────────────────────

describe("computeCollaborationStats", () => {
  it("returns hasData:false and empty results for empty metrics", () => {
    expect(computeCollaborationStats(makeOrg([]))).toEqual({
      hasData: false,
      edges: [],
      reviewerGini: 0,
      busFactors: [],
      siloedContributors: [],
      distinctAuthors: 0,
      distinctReviewers: 0,
    });
  });

  it("handles repos with mergedPRTimeline missing", () => {
    const repo = makeRepo("org/bare", [], { mergedPRTimeline: undefined });
    expect(computeCollaborationStats(makeOrg([repo])).hasData).toBe(false);
  });

  describe("edges", () => {
    it("aggregates author→reviewer pairs across repos and orders by count then names", () => {
      const repoA = makeRepo("org/a", [
        makePR({ number: 1, author: "alice", reviewers: ["bob", "carol"] }),
        makePR({ number: 2, author: "alice", reviewers: ["bob"] }),
        makePR({ number: 3, author: "bob", reviewers: ["alice"] }),
      ]);
      const repoB = makeRepo("org/b", [
        makePR({ number: 4, author: "alice", reviewers: ["bob"] }),
      ]);

      const result = computeCollaborationStats(makeOrg([repoA, repoB]));

      // alice→bob spans both repos (3 PRs); prCount-1 ties order by author
      // then reviewer alphabetically.
      expect(result.edges).toEqual([
        { author: "alice", reviewer: "bob", prCount: 3 },
        { author: "alice", reviewer: "carol", prCount: 1 },
        { author: "bob", reviewer: "alice", prCount: 1 },
      ]);
      expect(result.hasData).toBe(true);
      expect(result.distinctAuthors).toBe(2);
      expect(result.distinctReviewers).toBe(3);
    });

    it("counts a reviewer once per PR even if listed twice", () => {
      const repo = makeRepo("org/a", [
        makePR({ number: 1, author: "alice", reviewers: ["bob", "bob"] }),
      ]);
      const result = computeCollaborationStats(makeOrg([repo]));
      expect(result.edges).toEqual([{ author: "alice", reviewer: "bob", prCount: 1 }]);
    });

    it("skips the reviewer when it equals the author", () => {
      const repo = makeRepo("org/a", [
        makePR({ number: 1, author: "alice", reviewers: ["alice", "bob"] }),
      ]);
      const result = computeCollaborationStats(makeOrg([repo]));
      expect(result.edges).toEqual([{ author: "alice", reviewer: "bob", prCount: 1 }]);
      expect(result.distinctReviewers).toBe(1);
    });

    it("excludes bot and Copilot reviewers but keeps human-style AI-adjacent logins", () => {
      const repo = makeRepo("org/a", [
        makePR({
          number: 1,
          author: "alice",
          reviewers: [
            "copilot[bot]",
            "COPILOT",
            "renovate-bot",
            "bot-account",
            "copilot-pull-request-reviewer",
          ],
        }),
      ]);
      const result = computeCollaborationStats(makeOrg([repo]));
      expect(result.edges).toEqual([
        { author: "alice", reviewer: "copilot-pull-request-reviewer", prCount: 1 },
      ]);
      expect(result.distinctReviewers).toBe(1);
    });

    it("ignores bot- and AI-authored PRs entirely", () => {
      const repo = makeRepo("org/a", [
        makePR({ number: 1, author: "dependabot[bot]", isBotAuthor: true, reviewers: ["bob"] }),
        // Heuristic bot login without the upstream flag.
        makePR({ number: 2, author: "step-security-bot", reviewers: ["bob"] }),
        makePR({
          number: 3,
          author: "copilot-swe-agent",
          isCopilotAuthored: true,
          aiAuthorType: "copilot",
          reviewers: ["bob"],
        }),
        makePR({ number: 4, author: "alice", reviewers: ["bob"] }),
      ]);
      const result = computeCollaborationStats(makeOrg([repo]));
      expect(result.edges).toEqual([{ author: "alice", reviewer: "bob", prCount: 1 }]);
      expect(result.distinctAuthors).toBe(1);
      expect(result.distinctReviewers).toBe(1);
    });

    it("caps the edge list at the top 25", () => {
      // 26 authors, each reviewed once by "rev": all prCount 1, ordered by
      // author name — the alphabetically last author falls off.
      const prs = Array.from({ length: 26 }, (_, i) =>
        makePR({
          number: i + 1,
          author: `a${String(i).padStart(2, "0")}`,
          reviewers: ["rev"],
        })
      );
      const result = computeCollaborationStats(makeOrg([makeRepo("org/a", prs)]));
      expect(result.edges).toHaveLength(25);
      expect(result.edges[0]).toEqual({ author: "a00", reviewer: "rev", prCount: 1 });
      expect(result.edges[24].author).toBe("a24");
      expect(result.edges.some((e) => e.author === "a25")).toBe(false);
    });
  });

  describe("reviewerGini", () => {
    it("returns 0 when there is a single reviewer", () => {
      const repo = makeRepo("org/a", prsBy("alice", 5, ["bob"]));
      expect(computeCollaborationStats(makeOrg([repo])).reviewerGini).toBe(0);
    });

    it("returns 0 for a perfectly even review load", () => {
      const repo = makeRepo("org/a", [
        ...prsBy("alice", 2, ["bob"], 1),
        ...prsBy("alice", 2, ["carol"], 3),
        ...prsBy("alice", 2, ["dave"], 5),
      ]);
      expect(computeCollaborationStats(makeOrg([repo])).reviewerGini).toBe(0);
    });

    it("rises when one reviewer dominates", () => {
      // Distinct-PR counts bob:8, carol:1, dave:1 → sorted [1,1,8], n=3,
      // G = 2·(1·1 + 2·1 + 3·8)/(3·10) − 4/3 = 54/30 − 4/3 = 0.4667.
      const repo = makeRepo("org/a", [
        ...prsBy("alice", 8, ["bob"], 1),
        makePR({ number: 9, author: "alice", reviewers: ["carol"] }),
        makePR({ number: 10, author: "alice", reviewers: ["dave"] }),
      ]);
      const result = computeCollaborationStats(makeOrg([repo]));
      expect(result.reviewerGini).toBe(0.4667);
    });
  });

  describe("busFactors", () => {
    it("reports busFactor 1 for a single dominant author", () => {
      const repo = makeRepo("org/a", [
        ...prsBy("alice", 4, undefined, 1),
        makePR({ number: 5, author: "bob" }),
      ]);
      const result = computeCollaborationStats(makeOrg([repo]));
      expect(result.busFactors).toEqual([
        { fullName: "org/a", busFactor: 1, topAuthorShare: 0.8, mergedPRs: 5 },
      ]);
    });

    it("reports a higher busFactor for evenly spread ownership", () => {
      // 6 PRs split 2/2/2: top author covers 2 < 3, top two cover 4 ≥ 3 → 2.
      const repo = makeRepo("org/a", [
        ...prsBy("alice", 2, undefined, 1),
        ...prsBy("bob", 2, undefined, 3),
        ...prsBy("carol", 2, undefined, 5),
      ]);
      const result = computeCollaborationStats(makeOrg([repo]));
      expect(result.busFactors).toEqual([
        { fullName: "org/a", busFactor: 2, topAuthorShare: 0.3333, mergedPRs: 6 },
      ]);
    });

    it("excludes repos with fewer than 5 human-authored merged PRs (bot PRs do not count)", () => {
      const small = makeRepo("org/small", prsBy("alice", 4));
      const padded = makeRepo("org/padded", [
        ...prsBy("alice", 4, undefined, 1),
        makePR({ number: 5, author: "dependabot[bot]", isBotAuthor: true }),
      ]);
      const result = computeCollaborationStats(makeOrg([small, padded]));
      expect(result.busFactors).toEqual([]);
      expect(result.hasData).toBe(true);
    });

    it("sorts by busFactor asc, then topAuthorShare desc, then fullName asc", () => {
      const spread = makeRepo("org/spread", [
        ...prsBy("a", 2, undefined, 1),
        ...prsBy("b", 2, undefined, 3),
        ...prsBy("c", 2, undefined, 5),
      ]);
      const dominated = makeRepo("org/dominated", [
        ...prsBy("bob", 3, undefined, 1),
        ...prsBy("carol", 2, undefined, 4),
      ]);
      const soloZeta = makeRepo("org/zeta", prsBy("alice", 5));
      const soloAlpha = makeRepo("org/alpha", prsBy("alice", 5));

      const result = computeCollaborationStats(
        makeOrg([spread, dominated, soloZeta, soloAlpha])
      );
      expect(result.busFactors.map((b) => b.fullName)).toEqual([
        "org/alpha", // busFactor 1, share 1.0 (fullName tiebreak)
        "org/zeta", // busFactor 1, share 1.0
        "org/dominated", // busFactor 1, share 0.6
        "org/spread", // busFactor 2
      ]);
    });
  });

  describe("siloedContributors", () => {
    it("lists single-repo authors with ≥3 merged PRs, sorted alphabetically", () => {
      const repoA = makeRepo("org/a", [
        ...prsBy("zoe", 3, undefined, 1),
        ...prsBy("amy", 3, undefined, 4),
        // Below the 3-PR threshold.
        ...prsBy("bob", 2, undefined, 7),
      ]);
      const repoB = makeRepo("org/b", [
        // Cross-repo author: not siloed even with many PRs.
        ...prsBy("carol", 3, undefined, 1),
      ]);
      const repoA2 = makeRepo("org/a2", prsBy("carol", 3));

      const result = computeCollaborationStats(makeOrg([repoA, repoB, repoA2]));
      expect(result.siloedContributors).toEqual(["amy", "zoe"]);
    });

    it("returns [] when fewer than 2 repos have a human merged PR", () => {
      const only = makeRepo("org/a", prsBy("alice", 5));
      // A repo with only bot PRs does not count as active.
      const botsOnly = makeRepo("org/bots", [
        makePR({ number: 1, author: "dependabot[bot]", isBotAuthor: true }),
      ]);
      const result = computeCollaborationStats(makeOrg([only, botsOnly]));
      expect(result.siloedContributors).toEqual([]);
      expect(result.hasData).toBe(true);
    });
  });

  it("counts PRs without reviewer data (REST path) for busFactors and authors", () => {
    const repo = makeRepo("org/a", prsBy("alice", 5, undefined));
    const result = computeCollaborationStats(makeOrg([repo]));

    expect(result.hasData).toBe(true);
    expect(result.distinctAuthors).toBe(1);
    expect(result.distinctReviewers).toBe(0);
    expect(result.edges).toEqual([]);
    expect(result.reviewerGini).toBe(0);
    expect(result.busFactors).toEqual([
      { fullName: "org/a", busFactor: 1, topAuthorShare: 1, mergedPRs: 5 },
    ]);
  });
});
