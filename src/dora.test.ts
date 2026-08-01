import { describe, it, expect } from "vitest";
import { computeDoraMetrics, computeReviewStats } from "./dora.js";
import type {
  OrgMetrics,
  RepoMetrics,
  MergedPRSummary,
  DeploymentEvent,
  RevertEvent,
  IncidentEvent,
} from "./types.js";

// ── Fixture factories ──────────────────────────────────────────────────────────

/** End of the default analysis window in every fixture (= collectedAt). */
const NOW_ISO = "2026-07-13T00:00:00Z";
/** Start of the default 90-day window: 2026-07-13 minus 90 days. */
const WINDOW_START_ISO = "2026-04-14T00:00:00Z";

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

/** Build a DeploymentEvent at the given timestamp. */
function makeDeploy(createdAt: string, overrides: Partial<DeploymentEvent> = {}): DeploymentEvent {
  return { createdAt, source: "deployment", ...overrides };
}

/** Build a RevertEvent with sensible defaults. */
function makeRevert(overrides: Partial<RevertEvent> = {}): RevertEvent {
  return {
    revertPRNumber: 100,
    revertMergedAt: "2026-05-02T00:00:00Z",
    ...overrides,
  };
}

/** Build an IncidentEvent with sensible defaults (in-window, closed, 5h to resolve). */
function makeIncident(overrides: Partial<IncidentEvent> = {}): IncidentEvent {
  return {
    number: 500,
    createdAt: "2026-05-01T00:00:00Z",
    closedAt: "2026-05-01T05:00:00Z",
    resolutionHours: 5,
    labels: ["incident"],
    ...overrides,
  };
}

/** Build a RepoMetrics with a merged-PR timeline plus optional deploy/revert payloads. */
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

/** Org with `count` in-window merged PRs of which the first `revertCount` are reverts. */
function makeCfrOrg(count: number, revertCount: number): OrgMetrics {
  const prs = Array.from({ length: count }, (_, i) =>
    makePR({
      number: i + 1,
      mergedAt: "2026-06-01T00:00:00Z",
      isRevert: i < revertCount,
    })
  );
  return makeOrg([makeRepo("org/a", prs)]);
}

// ── computeDoraMetrics ─────────────────────────────────────────────────────────

describe("computeDoraMetrics", () => {
  it("returns hasData:false everywhere for empty metrics", () => {
    const result = computeDoraMetrics(makeOrg([]));

    expect(result.hasData).toBe(false);
    expect(result.windowDays).toBe(90);
    for (const metric of [
      result.deployFrequencyPerWeek,
      result.leadTimeHours,
      result.changeFailureRate,
      result.mttrHours,
    ]) {
      expect(metric.hasData).toBe(false);
      expect(metric.value).toBe(0);
      expect(metric.tier).toBeUndefined();
    }
    expect(result.totalDeploys).toBe(0);
    expect(result.totalMergedPRs).toBe(0);
    expect(result.totalReverts).toBe(0);
  });

  it("handles repos with all optional arrays missing", () => {
    const repo = makeRepo("org/bare", [], {
      mergedPRTimeline: undefined,
      deployments: undefined,
      reverts: undefined,
    });
    const result = computeDoraMetrics(makeOrg([repo]));
    expect(result.hasData).toBe(false);
    expect(result.totalDeploys).toBe(0);
    expect(result.totalMergedPRs).toBe(0);
    expect(result.totalReverts).toBe(0);
  });

  it("computes every field on a hand-built happy path across two repos", () => {
    const repoA = makeRepo(
      "org/a",
      [
        makePR({ number: 1, author: "alice", mergedAt: "2026-05-10T00:00:00Z", timeToMergeHours: 10 }),
        makePR({ number: 2, author: "alice", mergedAt: "2026-05-11T00:00:00Z", timeToMergeHours: 20 }),
        makePR({ number: 3, author: "bob", mergedAt: "2026-05-12T00:00:00Z", timeToMergeHours: 30 }),
        // Bot PR: in CFR denominator, excluded from the lead-time sample.
        makePR({
          number: 4,
          author: "dependabot[bot]",
          isBotAuthor: true,
          mergedAt: "2026-05-13T00:00:00Z",
          timeToMergeHours: 1000,
        }),
        // Zero merge time: in CFR denominator, excluded from the lead-time sample.
        makePR({ number: 5, author: "carol", mergedAt: "2026-05-14T00:00:00Z", timeToMergeHours: 0 }),
        // Revert PR: CFR numerator; also a valid lead-time sample (human, >0h).
        makePR({ number: 6, author: "dave", mergedAt: "2026-05-15T00:00:00Z", timeToMergeHours: 6, isRevert: true }),
        // Out-of-window PR: contributes nothing.
        makePR({ number: 7, author: "eve", mergedAt: "2026-01-05T00:00:00Z", timeToMergeHours: 5 }),
      ],
      {
        deployments: [
          makeDeploy("2026-05-01T00:00:00Z"),
          makeDeploy("2026-06-01T00:00:00Z", { source: "release", tagName: "v1.2.3" }),
          makeDeploy("2026-07-01T00:00:00Z"),
          makeDeploy("2026-01-01T00:00:00Z"), // out of window
        ],
        reverts: [
          makeRevert({ revertPRNumber: 6, revertMergedAt: "2026-05-15T00:00:00Z", restoreHours: 2 }),
          makeRevert({ revertPRNumber: 99, revertMergedAt: "2026-05-20T00:00:00Z", restoreHours: 10 }),
          makeRevert({ revertPRNumber: 98, revertMergedAt: "2026-01-10T00:00:00Z", restoreHours: 999 }), // out of window
          makeRevert({ revertPRNumber: 97, revertMergedAt: "2026-05-21T00:00:00Z" }), // no restoreHours
        ],
      }
    );
    const repoB = makeRepo("org/b", [], {
      deployments: [
        makeDeploy("2026-04-20T00:00:00Z"),
        makeDeploy(WINDOW_START_ISO), // exactly at the window start → included
      ],
    });

    const result = computeDoraMetrics(makeOrg([repoA, repoB]));

    expect(result.hasData).toBe(true);
    expect(result.windowDays).toBe(90);

    // Deploy frequency: 5 in-window events / (90/7) weeks = 0.3888… → 0.39, medium.
    expect(result.totalDeploys).toBe(5);
    expect(result.deployFrequencyPerWeek).toEqual({ value: 0.39, tier: "medium", hasData: true });

    // Lead time: median([10,20,30,6]) = 15 → elite.
    expect(result.leadTimeHours).toEqual({ value: 15, tier: "elite", hasData: true });

    // CFR: 1 revert / 6 merged (bot + zero-hour + revert PRs all in denominator)
    // = 0.1666… → 0.17 → low.
    expect(result.totalMergedPRs).toBe(6);
    expect(result.totalReverts).toBe(1);
    expect(result.changeFailureRate).toEqual({ value: 0.17, tier: "low", hasData: true });

    // MTTR: median([2,10]) = 6 → high (out-of-window and missing restoreHours skipped).
    expect(result.mttrHours).toEqual({ value: 6, tier: "high", hasData: true });
  });

  it("reports deploy hasData:false when deployments exist only outside the window", () => {
    const repo = makeRepo("org/a", [], {
      deployments: [makeDeploy("2020-01-01T00:00:00Z")],
    });
    const result = computeDoraMetrics(makeOrg([repo]));

    expect(result.deployFrequencyPerWeek.hasData).toBe(false);
    expect(result.deployFrequencyPerWeek.value).toBe(0);
    expect(result.deployFrequencyPerWeek.tier).toBeUndefined();
    expect(result.totalDeploys).toBe(0);
    expect(result.hasData).toBe(false);
  });

  it("sets top-level hasData when only one of the four metrics has data", () => {
    const result = computeDoraMetrics(
      makeOrg([makeRepo("org/a", [makePR({ mergedAt: "2026-06-01T00:00:00Z" })])])
    );
    expect(result.hasData).toBe(true);
    expect(result.leadTimeHours.hasData).toBe(true);
    expect(result.changeFailureRate.hasData).toBe(true);
    expect(result.deployFrequencyPerWeek.hasData).toBe(false);
    expect(result.mttrHours.hasData).toBe(false);
  });

  describe("deploy-frequency tiers", () => {
    /** Org with `count` deployments inside a window ending at NOW_ISO. */
    function deployOrg(count: number): OrgMetrics {
      const deployments = Array.from({ length: count }, () => makeDeploy("2026-07-12T00:00:00Z"));
      return makeOrg([makeRepo("org/a", [], { deployments })]);
    }

    it("classifies exactly 7/week as elite", () => {
      const result = computeDoraMetrics(deployOrg(7), { windowDays: 7 });
      expect(result.deployFrequencyPerWeek).toEqual({ value: 7, tier: "elite", hasData: true });
    });

    it("classifies just below 7/week as high", () => {
      const result = computeDoraMetrics(deployOrg(6), { windowDays: 7 });
      expect(result.deployFrequencyPerWeek).toEqual({ value: 6, tier: "high", hasData: true });
    });

    it("classifies exactly 1/week as high", () => {
      const result = computeDoraMetrics(deployOrg(1), { windowDays: 7 });
      expect(result.deployFrequencyPerWeek).toEqual({ value: 1, tier: "high", hasData: true });
    });

    it("classifies exactly 0.25/week as medium", () => {
      const result = computeDoraMetrics(deployOrg(1), { windowDays: 28 });
      expect(result.deployFrequencyPerWeek).toEqual({ value: 0.25, tier: "medium", hasData: true });
    });

    it("classifies below 0.25/week as low", () => {
      const result = computeDoraMetrics(deployOrg(1), { windowDays: 56 });
      expect(result.deployFrequencyPerWeek).toEqual({ value: 0.13, tier: "low", hasData: true });
    });
  });

  describe("lead-time tiers", () => {
    /** Org with a single in-window merged PR taking `hours` to merge. */
    function leadOrg(hours: number): OrgMetrics {
      return makeOrg([
        makeRepo("org/a", [makePR({ mergedAt: "2026-06-01T00:00:00Z", timeToMergeHours: hours })]),
      ]);
    }

    it("classifies just under 24h as elite", () => {
      expect(computeDoraMetrics(leadOrg(23.99)).leadTimeHours.tier).toBe("elite");
    });

    it("classifies exactly 24h as high (elite is strictly <24h)", () => {
      expect(computeDoraMetrics(leadOrg(24)).leadTimeHours.tier).toBe("high");
    });

    it("classifies just under 168h as high", () => {
      expect(computeDoraMetrics(leadOrg(167.99)).leadTimeHours.tier).toBe("high");
    });

    it("classifies exactly 168h as medium (high is strictly <168h)", () => {
      expect(computeDoraMetrics(leadOrg(168)).leadTimeHours.tier).toBe("medium");
    });

    it("classifies just under 730h as medium", () => {
      expect(computeDoraMetrics(leadOrg(729.99)).leadTimeHours.tier).toBe("medium");
    });

    it("classifies exactly 730h as low (medium is strictly <730h)", () => {
      expect(computeDoraMetrics(leadOrg(730)).leadTimeHours.tier).toBe("low");
    });
  });

  describe("change-failure-rate tiers", () => {
    it("classifies exactly 5% as elite", () => {
      const result = computeDoraMetrics(makeCfrOrg(20, 1));
      expect(result.changeFailureRate).toEqual({ value: 0.05, tier: "elite", hasData: true });
    });

    it("classifies exactly 10% as high", () => {
      const result = computeDoraMetrics(makeCfrOrg(20, 2));
      expect(result.changeFailureRate).toEqual({ value: 0.1, tier: "high", hasData: true });
    });

    it("classifies exactly 15% as medium", () => {
      const result = computeDoraMetrics(makeCfrOrg(20, 3));
      expect(result.changeFailureRate).toEqual({ value: 0.15, tier: "medium", hasData: true });
    });

    it("classifies above 15% as low", () => {
      const result = computeDoraMetrics(makeCfrOrg(20, 4));
      expect(result.changeFailureRate).toEqual({ value: 0.2, tier: "low", hasData: true });
    });

    it("classifies zero reverts as elite with value 0", () => {
      const result = computeDoraMetrics(makeCfrOrg(10, 0));
      expect(result.changeFailureRate).toEqual({ value: 0, tier: "elite", hasData: true });
      expect(result.totalReverts).toBe(0);
    });
  });

  describe("MTTR tiers", () => {
    /** Org with a single in-window revert event restoring in `hours`. */
    function mttrOrg(hours: number): OrgMetrics {
      return makeOrg([
        makeRepo("org/a", [], {
          reverts: [makeRevert({ revertMergedAt: "2026-06-01T00:00:00Z", restoreHours: hours })],
        }),
      ]);
    }

    it("classifies under 1h as elite", () => {
      expect(computeDoraMetrics(mttrOrg(0.5)).mttrHours.tier).toBe("elite");
    });

    it("classifies exactly 1h as high (elite is strictly <1h)", () => {
      expect(computeDoraMetrics(mttrOrg(1)).mttrHours.tier).toBe("high");
    });

    it("classifies just under 24h as high", () => {
      expect(computeDoraMetrics(mttrOrg(23.99)).mttrHours.tier).toBe("high");
    });

    it("classifies exactly 24h as medium (high is strictly <24h)", () => {
      expect(computeDoraMetrics(mttrOrg(24)).mttrHours.tier).toBe("medium");
    });

    it("classifies just under 168h as medium", () => {
      expect(computeDoraMetrics(mttrOrg(167.99)).mttrHours.tier).toBe("medium");
    });

    it("classifies exactly 168h as low (medium is strictly <168h)", () => {
      expect(computeDoraMetrics(mttrOrg(168)).mttrHours.tier).toBe("low");
    });
  });

  describe("incident failure signal", () => {
    /** `count` in-window merged human PRs, none of them reverts. */
    function makePRs(count: number): MergedPRSummary[] {
      return Array.from({ length: count }, (_, i) =>
        makePR({ number: i + 1, mergedAt: "2026-06-01T00:00:00Z" })
      );
    }

    it("prefers incidents over reverts for CFR and reports the signal", () => {
      const prs = makePRs(10);
      prs[0] = { ...prs[0], isRevert: true };
      const repo = makeRepo("org/a", prs, {
        incidents: [
          makeIncident({ number: 500, createdAt: "2026-05-01T00:00:00Z" }),
          makeIncident({ number: 501, createdAt: "2026-06-01T00:00:00Z" }),
        ],
      });
      const result = computeDoraMetrics(makeOrg([repo]));

      expect(result.failureSignal).toBe("incidents");
      expect(result.totalIncidents).toBe(2);
      // The revert is still tallied informationally but does not feed CFR.
      expect(result.totalReverts).toBe(1);
      expect(result.totalMergedPRs).toBe(10);
      // CFR = 2 incidents / 10 merged PRs = 0.2 → low.
      expect(result.changeFailureRate).toEqual({ value: 0.2, tier: "low", hasData: true });
    });

    it("computes MTTR as the median resolutionHours of window-closed incidents, ignoring revert restore times", () => {
      const repo = makeRepo("org/a", [], {
        // Revert restore times must NOT feed MTTR once incidents exist.
        reverts: [makeRevert({ revertMergedAt: "2026-06-01T00:00:00Z", restoreHours: 999 })],
        incidents: [
          makeIncident({ number: 1, closedAt: "2026-05-01T02:00:00Z", resolutionHours: 2 }),
          makeIncident({ number: 2, closedAt: "2026-05-02T00:00:00Z", resolutionHours: 10 }),
          makeIncident({ number: 3, closedAt: "2026-05-03T00:00:00Z", resolutionHours: 30 }),
          // Closed outside the window → excluded from the MTTR sample.
          makeIncident({
            number: 4,
            createdAt: "2026-01-01T00:00:00Z",
            closedAt: "2026-01-02T00:00:00Z",
            resolutionHours: 500,
          }),
        ],
      });
      const result = computeDoraMetrics(makeOrg([repo]));

      // median([2,10,30]) = 10 → high.
      expect(result.mttrHours).toEqual({ value: 10, tier: "high", hasData: true });
    });

    it("excludes out-of-window incidents from totals but still triggers the preference", () => {
      // A team that labels incidents but had a clean recent month must get
      // CFR 0 from the incident signal, not fall back to revert noise.
      const prs = makePRs(5);
      prs[0] = { ...prs[0], isRevert: true };
      const repo = makeRepo("org/a", prs, {
        reverts: [makeRevert({ revertMergedAt: "2026-06-01T00:00:00Z", restoreHours: 4 })],
        incidents: [
          makeIncident({
            createdAt: "2025-09-01T00:00:00Z",
            closedAt: "2025-09-02T00:00:00Z",
            resolutionHours: 24,
          }),
        ],
      });
      const result = computeDoraMetrics(makeOrg([repo]));

      expect(result.failureSignal).toBe("incidents");
      expect(result.totalIncidents).toBe(0);
      expect(result.changeFailureRate).toEqual({ value: 0, tier: "elite", hasData: true });
      // No incident closed in the window → no MTTR sample (revert ignored).
      expect(result.mttrHours).toEqual({ value: 0, tier: undefined, hasData: false });
    });

    it("counts open incidents in CFR but excludes them from MTTR", () => {
      const repo = makeRepo("org/a", makePRs(10), {
        incidents: [
          makeIncident({
            number: 600,
            createdAt: "2026-06-01T00:00:00Z",
            closedAt: undefined,
            resolutionHours: undefined,
          }),
        ],
      });
      const result = computeDoraMetrics(makeOrg([repo]));

      expect(result.totalIncidents).toBe(1);
      // CFR = 1 / 10 = 0.1 → high.
      expect(result.changeFailureRate).toEqual({ value: 0.1, tier: "high", hasData: true });
      expect(result.mttrHours.hasData).toBe(false);
    });

    it("falls back to reverts when incident arrays are present but all empty", () => {
      const prs = makePRs(10);
      prs[0] = { ...prs[0], isRevert: true };
      const repoA = makeRepo("org/a", prs, {
        incidents: [],
        reverts: [makeRevert({ revertMergedAt: "2026-06-01T00:00:00Z", restoreHours: 4 })],
      });
      const repoB = makeRepo("org/b", [], { incidents: [] });
      const result = computeDoraMetrics(makeOrg([repoA, repoB]));

      expect(result.failureSignal).toBe("reverts");
      expect(result.totalIncidents).toBe(0);
      // CFR = 1 revert / 10 merged = 0.1 → high; MTTR from revert restore time.
      expect(result.changeFailureRate).toEqual({ value: 0.1, tier: "high", hasData: true });
      expect(result.mttrHours).toEqual({ value: 4, tier: "high", hasData: true });
    });

    it("reports failureSignal 'reverts' and totalIncidents 0 when incidents are absent entirely", () => {
      const result = computeDoraMetrics(makeCfrOrg(20, 1));
      expect(result.failureSignal).toBe("reverts");
      expect(result.totalIncidents).toBe(0);
    });

    it("classifies tiers from incident-fed values", () => {
      // 1 incident / 20 merged PRs = 0.05 → elite CFR; 0.5h resolution → elite MTTR.
      const repo = makeRepo("org/a", makePRs(20), {
        incidents: [makeIncident({ closedAt: "2026-05-01T00:30:00Z", resolutionHours: 0.5 })],
      });
      const result = computeDoraMetrics(makeOrg([repo]));
      expect(result.changeFailureRate).toEqual({ value: 0.05, tier: "elite", hasData: true });
      expect(result.mttrHours).toEqual({ value: 0.5, tier: "elite", hasData: true });

      // 3 incidents / 20 PRs = 0.15 → medium CFR; 200h resolution → low MTTR
      // (the two open incidents count in CFR but not the MTTR sample).
      const slow = makeRepo("org/b", makePRs(20), {
        incidents: [
          makeIncident({ number: 1, closedAt: undefined, resolutionHours: undefined }),
          makeIncident({ number: 2, closedAt: undefined, resolutionHours: undefined }),
          makeIncident({ number: 3, closedAt: "2026-05-10T00:00:00Z", resolutionHours: 200 }),
        ],
      });
      const slowResult = computeDoraMetrics(makeOrg([slow]));
      expect(slowResult.changeFailureRate).toEqual({ value: 0.15, tier: "medium", hasData: true });
      expect(slowResult.mttrHours.tier).toBe("low");
    });

    it("reports both totalIncidents and totalReverts alongside each other", () => {
      const prs = makePRs(8);
      prs[0] = { ...prs[0], isRevert: true };
      prs[1] = { ...prs[1], isRevert: true };
      const repo = makeRepo("org/a", prs, {
        incidents: [makeIncident({ number: 1 }), makeIncident({ number: 2 }), makeIncident({ number: 3 })],
      });
      const result = computeDoraMetrics(makeOrg([repo]));
      expect(result.totalIncidents).toBe(3);
      expect(result.totalReverts).toBe(2);
      expect(result.failureSignal).toBe("incidents");
    });
  });

  describe("window filtering", () => {
    const now = new Date("2026-07-13T00:00:00Z");

    it("includes a deployment exactly at the window start and excludes one 1s earlier", () => {
      const repo = makeRepo("org/a", [], {
        deployments: [
          makeDeploy("2026-06-13T00:00:00Z"), // exactly now - 30 days
          makeDeploy("2026-06-12T23:59:59Z"), // 1 second before the window
        ],
      });
      const result = computeDoraMetrics(makeOrg([repo]), { windowDays: 30, now });
      expect(result.totalDeploys).toBe(1);
    });

    it("includes a PR merged exactly at `now` and excludes one merged 1s later", () => {
      const repo = makeRepo("org/a", [
        makePR({ number: 1, mergedAt: "2026-07-13T00:00:00Z" }),
        makePR({ number: 2, mergedAt: "2026-07-13T00:00:01Z" }),
      ]);
      const result = computeDoraMetrics(makeOrg([repo]), { windowDays: 30, now });
      expect(result.totalMergedPRs).toBe(1);
    });

    it("includes everything when windowDays covers all history", () => {
      const repo = makeRepo(
        "org/a",
        [makePR({ mergedAt: "2001-03-04T00:00:00Z", timeToMergeHours: 3 })],
        { deployments: [makeDeploy("1999-01-01T00:00:00Z")] }
      );
      const result = computeDoraMetrics(makeOrg([repo]), { windowDays: 36500 });
      expect(result.totalDeploys).toBe(1);
      expect(result.totalMergedPRs).toBe(1);
      expect(result.leadTimeHours.hasData).toBe(true);
    });
  });

  describe("determinism", () => {
    it("defaults the window end to collectedAt, not the wall clock", () => {
      // collectedAt is NOW_ISO (2026-07-13); this PR is in the 90-day window
      // relative to collectedAt but far outside any window ending at the real
      // current date the test happens to run on.
      const org = makeOrg([makeRepo("org/a", [makePR({ mergedAt: "2026-06-01T00:00:00Z" })])]);
      expect(computeDoraMetrics(org).totalMergedPRs).toBe(1);
    });

    it("honors options.now, shifting the window to old data", () => {
      const org = makeOrg([makeRepo("org/a", [makePR({ mergedAt: "2020-05-01T00:00:00Z" })])]);
      // Default window (ending at collectedAt 2026-07-13) misses the 2020 PR…
      expect(computeDoraMetrics(org).totalMergedPRs).toBe(0);
      // …but an explicit `now` back in 2020 captures it.
      const shifted = computeDoraMetrics(org, { now: new Date("2020-06-01T00:00:00Z") });
      expect(shifted.totalMergedPRs).toBe(1);
    });

    it("returns identical results across repeated calls with the same options", () => {
      const org = makeOrg([
        makeRepo("org/a", [makePR({ mergedAt: "2026-06-01T00:00:00Z" })], {
          deployments: [makeDeploy("2026-06-02T00:00:00Z")],
        }),
      ]);
      const options = { windowDays: 60, now: new Date("2026-07-01T00:00:00Z") };
      expect(computeDoraMetrics(org, options)).toEqual(computeDoraMetrics(org, options));
    });
  });
});

// ── computeReviewStats ─────────────────────────────────────────────────────────

describe("computeReviewStats", () => {
  it("returns hasData:false and zeroes for empty metrics", () => {
    const result = computeReviewStats(makeOrg([]));
    expect(result).toEqual({
      hasData: false,
      reviewedPRs: 0,
      totalPRs: 0,
      reviewCoverage: 0,
      medianTimeToFirstReviewHours: 0,
      p90TimeToFirstReviewHours: 0,
      reviewers: [],
      topReviewerShare: 0,
    });
  });

  it("handles repos with mergedPRTimeline missing", () => {
    const repo = makeRepo("org/bare", [], { mergedPRTimeline: undefined });
    expect(computeReviewStats(makeOrg([repo])).hasData).toBe(false);
  });

  it("computes coverage, latency percentiles, and reviewer load on a hand-built happy path", () => {
    const repo = makeRepo("org/a", [
      makePR({
        number: 1,
        author: "alice",
        mergedAt: "2026-05-10T00:00:00Z",
        reviewers: ["bob", "carol"],
        timeToFirstReviewHours: 2,
      }),
      makePR({
        number: 2,
        author: "bob",
        mergedAt: "2026-05-11T00:00:00Z",
        reviewers: ["carol"],
        timeToFirstReviewHours: 4,
      }),
      // Unreviewed PR: counts in the denominator only.
      makePR({ number: 3, author: "carol", mergedAt: "2026-05-12T00:00:00Z", reviewers: [] }),
      // Bot and copilot reviewers are excluded from the load table, but the PR
      // still counts as reviewed (bob is on it too).
      makePR({
        number: 4,
        author: "dave",
        mergedAt: "2026-05-13T00:00:00Z",
        reviewers: ["bob", "copilot[bot]", "Copilot", "renovate-bot"],
        timeToFirstReviewHours: 6,
      }),
      // Bot-authored PR: excluded from numerator AND denominator; its reviewer
      // must not appear in the load table.
      makePR({
        number: 5,
        author: "dependabot[bot]",
        isBotAuthor: true,
        mergedAt: "2026-05-14T00:00:00Z",
        reviewers: ["bob"],
        timeToFirstReviewHours: 1,
      }),
      // Out-of-window PR: contributes nothing.
      makePR({
        number: 6,
        author: "eve",
        mergedAt: "2026-01-05T00:00:00Z",
        reviewers: ["zed"],
        timeToFirstReviewHours: 9,
      }),
    ]);

    const result = computeReviewStats(makeOrg([repo]));

    expect(result.hasData).toBe(true);
    expect(result.totalPRs).toBe(4); // PRs 1–4
    expect(result.reviewedPRs).toBe(3); // PRs 1, 2, 4
    expect(result.reviewCoverage).toBe(0.75);

    // First-review sample [2,4,6]: median 4; p90 = 4 + (6-4)*0.8 = 5.6.
    expect(result.medianTimeToFirstReviewHours).toBe(4);
    expect(result.p90TimeToFirstReviewHours).toBe(5.6);

    // bob reviewed PRs 1 & 4; carol reviewed PRs 1 & 2. Bot/copilot logins and
    // the out-of-window reviewer "zed" are excluded. Total reviews = 4.
    expect(result.reviewers).toEqual([
      { login: "bob", prsReviewed: 2, loadShare: 0.5 },
      { login: "carol", prsReviewed: 2, loadShare: 0.5 },
    ]);
    expect(result.topReviewerShare).toBe(0.5);
  });

  it("counts a reviewer once per PR even if listed twice", () => {
    const repo = makeRepo("org/a", [
      makePR({ number: 1, mergedAt: "2026-06-01T00:00:00Z", reviewers: ["bob", "bob"] }),
    ]);
    const result = computeReviewStats(makeOrg([repo]));
    expect(result.reviewers).toEqual([{ login: "bob", prsReviewed: 1, loadShare: 1 }]);
    expect(result.topReviewerShare).toBe(1);
  });

  it("excludes zero-hour first-review times from the latency sample", () => {
    const repo = makeRepo("org/a", [
      makePR({
        number: 1,
        mergedAt: "2026-06-01T00:00:00Z",
        reviewers: ["bob"],
        timeToFirstReviewHours: 0,
      }),
      makePR({
        number: 2,
        mergedAt: "2026-06-02T00:00:00Z",
        reviewers: ["bob"],
        timeToFirstReviewHours: 8,
      }),
    ]);
    const result = computeReviewStats(makeOrg([repo]));
    expect(result.medianTimeToFirstReviewHours).toBe(8);
    expect(result.p90TimeToFirstReviewHours).toBe(8);
  });

  it("rounds load shares to 4 decimals and sorts by prsReviewed desc then login asc", () => {
    const repo = makeRepo("org/a", [
      makePR({ number: 1, mergedAt: "2026-06-01T00:00:00Z", reviewers: ["zoe", "amy"] }),
      makePR({ number: 2, mergedAt: "2026-06-02T00:00:00Z", reviewers: ["zoe"] }),
    ]);
    const result = computeReviewStats(makeOrg([repo]));

    // zoe: 2 PRs, amy: 1 PR, total 3 → shares 2/3 and 1/3.
    expect(result.reviewers).toEqual([
      { login: "zoe", prsReviewed: 2, loadShare: 0.6667 },
      { login: "amy", prsReviewed: 1, loadShare: 0.3333 },
    ]);
    expect(result.topReviewerShare).toBe(0.6667);
  });

  it("breaks prsReviewed ties by login ascending", () => {
    const repo = makeRepo("org/a", [
      makePR({ number: 1, mergedAt: "2026-06-01T00:00:00Z", reviewers: ["zoe", "amy", "mid"] }),
    ]);
    const result = computeReviewStats(makeOrg([repo]));
    expect(result.reviewers.map((r) => r.login)).toEqual(["amy", "mid", "zoe"]);
  });

  it("returns hasData:false when the window holds only bot-authored PRs", () => {
    const repo = makeRepo("org/a", [
      makePR({
        number: 1,
        author: "dependabot[bot]",
        isBotAuthor: true,
        mergedAt: "2026-06-01T00:00:00Z",
        reviewers: ["bob"],
      }),
    ]);
    const result = computeReviewStats(makeOrg([repo]));
    expect(result.hasData).toBe(false);
    expect(result.totalPRs).toBe(0);
    expect(result.reviewCoverage).toBe(0);
    expect(result.reviewers).toEqual([]);
    expect(result.topReviewerShare).toBe(0);
  });

  it("keeps AI-adjacent human-style logins like copilot-pull-request-reviewer", () => {
    // Only exact-lowercase "copilot" and bot-pattern logins are excluded;
    // "copilot-pull-request-reviewer" matches neither rule.
    const repo = makeRepo("org/a", [
      makePR({
        number: 1,
        mergedAt: "2026-06-01T00:00:00Z",
        reviewers: ["copilot-pull-request-reviewer", "COPILOT", "bot-account"],
      }),
    ]);
    const result = computeReviewStats(makeOrg([repo]));
    expect(result.reviewers.map((r) => r.login)).toEqual(["copilot-pull-request-reviewer"]);
  });

  it("treats a PR with reviewers undefined as unreviewed but still in the denominator", () => {
    const repo = makeRepo("org/a", [
      makePR({ number: 1, mergedAt: "2026-06-01T00:00:00Z", reviewers: undefined }),
      makePR({ number: 2, mergedAt: "2026-06-02T00:00:00Z", reviewers: ["bob"] }),
    ]);
    const result = computeReviewStats(makeOrg([repo]));
    expect(result.totalPRs).toBe(2);
    expect(result.reviewedPRs).toBe(1);
    expect(result.reviewCoverage).toBe(0.5);
  });

  it("applies window filtering: PR just inside counts, just outside does not", () => {
    const now = new Date("2026-07-13T00:00:00Z");
    const repo = makeRepo("org/a", [
      makePR({ number: 1, mergedAt: "2026-06-13T00:00:00Z", reviewers: ["bob"] }), // exactly at start
      makePR({ number: 2, mergedAt: "2026-06-12T23:59:59Z", reviewers: ["carol"] }), // 1s before
    ]);
    const result = computeReviewStats(makeOrg([repo]), { windowDays: 30, now });
    expect(result.totalPRs).toBe(1);
    expect(result.reviewers.map((r) => r.login)).toEqual(["bob"]);
  });

  it("includes all history when windowDays is very large", () => {
    const repo = makeRepo("org/a", [
      makePR({ number: 1, mergedAt: "2001-03-04T00:00:00Z", reviewers: ["bob"] }),
    ]);
    const result = computeReviewStats(makeOrg([repo]), { windowDays: 36500 });
    expect(result.totalPRs).toBe(1);
    expect(result.reviewedPRs).toBe(1);
  });

  it("is deterministic: defaults to collectedAt and honors options.now", () => {
    const org = makeOrg([
      makeRepo("org/a", [
        makePR({ number: 1, mergedAt: "2020-05-01T00:00:00Z", reviewers: ["bob"] }),
      ]),
    ]);
    // Window ends at collectedAt (2026-07-13), so the 2020 PR is invisible…
    expect(computeReviewStats(org).totalPRs).toBe(0);
    // …until `now` is pinned back to 2020.
    const shifted = computeReviewStats(org, { now: new Date("2020-06-01T00:00:00Z") });
    expect(shifted.totalPRs).toBe(1);
    expect(shifted.reviewers).toEqual([{ login: "bob", prsReviewed: 1, loadShare: 1 }]);
  });
});
