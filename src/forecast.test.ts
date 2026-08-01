import { describe, it, expect } from "vitest";
import { computeDeliveryForecast, isoWeekLabel } from "./forecast.js";
import type { OrgMetrics, WeeklyTrendPoint } from "./types.js";

// ── Fixture factories ──────────────────────────────────────────────────────────

/**
 * "Now" in every fixture (= collectedAt). 2026-07-13 is the Monday of ISO
 * week 2026-W29, so W29 is the current (partial) week and W28 is the most
 * recent completed week.
 */
const NOW_ISO = "2026-07-13T00:00:00Z";
const NOW_WEEK = "2026-W29";

/** Build a WeeklyTrendPoint where only `week` and `prsMerged` matter. */
function makePoint(week: string, prsMerged: number): WeeklyTrendPoint {
  return {
    week,
    prsOpened: prsMerged,
    prsMerged,
    issuesOpened: 0,
    issuesClosed: 0,
    linesAdded: 0,
    linesDeleted: 0,
  };
}

/**
 * Build a trend series of consecutive 2026 ISO weeks ending at `lastWeek`
 * (default W28, the last completed week before NOW_ISO), one point per entry
 * of `merged`.
 */
function makeTrends(merged: number[], lastWeek = 28): WeeklyTrendPoint[] {
  return merged.map((prsMerged, i) => {
    const weekNum = lastWeek - merged.length + 1 + i;
    return makePoint(`2026-W${String(weekNum).padStart(2, "0")}`, prsMerged);
  });
}

/** Build an OrgMetrics with the given weeklyTrends, collected at NOW_ISO. */
function makeOrg(
  weeklyTrends?: WeeklyTrendPoint[],
  collectedAt = NOW_ISO
): OrgMetrics {
  return {
    owner: "org",
    ownerType: "org",
    collectedAt,
    repoCount: 0,
    repos: [],
    weeklyTrends,
  };
}

const EMPTY_FORECAST = {
  hasData: false,
  sampleWeeks: 0,
  medianWeeklyThroughput: 0,
  targets: [],
};

/** 12 completed weeks at a constant 5 merged PRs/week. */
const CONSTANT_5 = makeTrends(Array.from({ length: 12 }, () => 5));

/** 12 completed weeks with varied throughput (total 57, includes zero weeks). */
const VARIED = makeTrends([0, 2, 9, 1, 7, 3, 12, 0, 5, 8, 4, 6]);

// ── isoWeekLabel (sanity for the fixtures) ─────────────────────────────────────

describe("isoWeekLabel", () => {
  it("labels the fixture 'now' as 2026-W29", () => {
    expect(isoWeekLabel(new Date(Date.parse(NOW_ISO)))).toBe(NOW_WEEK);
  });
});

// ── computeDeliveryForecast ────────────────────────────────────────────────────

describe("computeDeliveryForecast", () => {
  it("returns hasData:false when weeklyTrends is missing or empty", () => {
    expect(computeDeliveryForecast(makeOrg(undefined))).toEqual(EMPTY_FORECAST);
    expect(computeDeliveryForecast(makeOrg([]))).toEqual(EMPTY_FORECAST);
  });

  it("returns hasData:false with fewer than 4 completed weeks", () => {
    const result = computeDeliveryForecast(makeOrg(makeTrends([5, 5, 5])));
    expect(result).toEqual(EMPTY_FORECAST);
  });

  it("does not let the current partial week satisfy the 4-week minimum", () => {
    // 3 completed weeks + the current W29 point: still only 3 sampled weeks.
    const trends = [...makeTrends([5, 5, 5]), makePoint(NOW_WEEK, 9)];
    expect(computeDeliveryForecast(makeOrg(trends))).toEqual(EMPTY_FORECAST);
  });

  it("returns hasData:false when the sample has zero total merged PRs", () => {
    const zeros = makeTrends(Array.from({ length: 12 }, () => 0));
    expect(computeDeliveryForecast(makeOrg(zeros))).toEqual(EMPTY_FORECAST);
  });

  it("forecasts exactly 2 weeks at every percentile for constant throughput", () => {
    const result = computeDeliveryForecast(makeOrg(CONSTANT_5), { targets: [10] });

    expect(result.hasData).toBe(true);
    expect(result.sampleWeeks).toBe(12);
    expect(result.medianWeeklyThroughput).toBe(5);
    expect(result.targets).toEqual([
      {
        prCount: 10,
        p50Weeks: 2,
        p85Weeks: 2,
        p95Weeks: 2,
        // Every draw yields 5 → always 2 weeks → now + 14 days.
        p50Date: "2026-07-27",
        p85Date: "2026-07-27",
        p95Date: "2026-07-27",
      },
    ]);
  });

  it("defaults to targets [10, 25, 50], ascending by prCount", () => {
    const result = computeDeliveryForecast(makeOrg(CONSTANT_5));

    expect(result.targets.map((t) => t.prCount)).toEqual([10, 25, 50]);
    // Constant 5/week → exact week counts for every target.
    expect(result.targets.map((t) => t.p95Weeks)).toEqual([2, 5, 10]);
    // 50 PRs → 10 weeks → 2026-07-13 + 70 days.
    expect(result.targets[2].p50Date).toBe("2026-09-21");
  });

  it("keeps p95 ≥ p85 ≥ p50 for a higher-variance sample", () => {
    const result = computeDeliveryForecast(makeOrg(VARIED), { targets: [25] });

    expect(result.hasData).toBe(true);
    const [target] = result.targets;
    expect(target.p50Weeks).toBeGreaterThanOrEqual(1);
    expect(target.p85Weeks).toBeGreaterThanOrEqual(target.p50Weeks);
    expect(target.p95Weeks).toBeGreaterThanOrEqual(target.p85Weeks);
    // Dates are derived from the week counts, so they must be ordered too.
    expect(target.p85Date >= target.p50Date).toBe(true);
    expect(target.p95Date >= target.p85Date).toBe(true);
  });

  it("is deterministic: same seed gives deep-equal results across calls", () => {
    const org = makeOrg(VARIED);
    const first = computeDeliveryForecast(org, { seed: 7 });
    const second = computeDeliveryForecast(org, { seed: 7 });
    expect(second).toEqual(first);

    // A different seed is also self-consistent (it may or may not differ
    // from seed 7 — only reproducibility is guaranteed).
    const otherA = computeDeliveryForecast(org, { seed: 1234 });
    const otherB = computeDeliveryForecast(org, { seed: 1234 });
    expect(otherB).toEqual(otherA);
    expect(otherA.hasData).toBe(true);
  });

  it("excludes the current partial ISO week from the sample", () => {
    const base = computeDeliveryForecast(makeOrg(VARIED));
    const withPartial = computeDeliveryForecast(
      makeOrg([...VARIED, makePoint(NOW_WEEK, 999)])
    );
    // A 999-PR partial week would drastically change the forecast if sampled.
    expect(withPartial).toEqual(base);
  });

  it("keeps zero-merge completed weeks in the sample", () => {
    // [0,0,0,10]: zero weeks are real throughput, so reaching 10 PRs takes
    // more than 1 week at p95 (a run of zero draws stretches the simulation).
    const result = computeDeliveryForecast(makeOrg(makeTrends([0, 0, 0, 10])), {
      targets: [10],
    });
    expect(result.hasData).toBe(true);
    expect(result.sampleWeeks).toBe(4);
    expect(result.targets[0].p95Weeks).toBeGreaterThan(1);
  });

  it("samples only the tail sampleWeeks of the completed weeks", () => {
    // Older 100-PR weeks must be truncated away, leaving six constant-5 weeks.
    const trends = makeTrends([100, 100, 100, 100, 100, 100, 5, 5, 5, 5, 5, 5]);
    const result = computeDeliveryForecast(makeOrg(trends), {
      sampleWeeks: 6,
      targets: [10],
    });

    expect(result.sampleWeeks).toBe(6);
    expect(result.medianWeeklyThroughput).toBe(5);
    // If any 100-PR week leaked in, some iteration would finish in 1 week.
    expect(result.targets[0]).toMatchObject({
      p50Weeks: 2,
      p85Weeks: 2,
      p95Weeks: 2,
    });
  });

  it("reports the actual sample length when history is shorter than sampleWeeks", () => {
    const result = computeDeliveryForecast(makeOrg(makeTrends([5, 5, 5, 5, 5])));
    expect(result.sampleWeeks).toBe(5);
    expect(result.hasData).toBe(true);
  });

  it("sorts, deduplicates, and drops non-positive custom targets", () => {
    const result = computeDeliveryForecast(makeOrg(CONSTANT_5), {
      targets: [50, 10, 10, 0, -5, 25],
    });
    expect(result.targets.map((t) => t.prCount)).toEqual([10, 25, 50]);
  });

  it("returns an empty targets list (but hasData:true) when all targets are non-positive", () => {
    const result = computeDeliveryForecast(makeOrg(CONSTANT_5), {
      targets: [0, -1],
    });
    expect(result.hasData).toBe(true);
    expect(result.targets).toEqual([]);
  });

  it("honors options.now for both week exclusion and projected dates", () => {
    // now = Monday of 2026-W30: W29 becomes a completed week and W30 is the
    // partial week to exclude.
    const now = "2026-07-20T00:00:00Z";
    const trends = [
      ...makeTrends([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5], 28),
      makePoint("2026-W29", 5),
      makePoint("2026-W30", 999), // current partial week relative to `now`
    ];
    const result = computeDeliveryForecast(makeOrg(trends), {
      now,
      targets: [10],
    });

    expect(result.sampleWeeks).toBe(12);
    expect(result.medianWeeklyThroughput).toBe(5);
    // Constant 5/week → 2 weeks → 2026-07-20 + 14 days.
    expect(result.targets[0].p50Date).toBe("2026-08-03");
    expect(result.targets[0].p95Date).toBe("2026-08-03");
  });
});
