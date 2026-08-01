import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { evaluateTargets, loadTargetsConfig } from "./targets.js";
import type {
  DoraMetrics,
  HealthReport,
  ReviewStats,
  TargetsConfig,
} from "./types.js";
import type { TargetInputs } from "./targets.js";

// ── Fixture factories ──────────────────────────────────────────────────────────

/** Build a DoraMetrics with sensible defaults; override what a test cares about. */
function makeDora(overrides: Partial<DoraMetrics> = {}): DoraMetrics {
  return {
    hasData: true,
    windowDays: 90,
    deployFrequencyPerWeek: { value: 2, tier: "high", hasData: true },
    leadTimeHours: { value: 20, tier: "elite", hasData: true },
    changeFailureRate: { value: 0.05, tier: "elite", hasData: true },
    mttrHours: { value: 5, tier: "high", hasData: true },
    totalDeploys: 26,
    totalMergedPRs: 100,
    totalReverts: 5,
    ...overrides,
  };
}

/** Build a ReviewStats with sensible defaults; override what a test cares about. */
function makeReview(overrides: Partial<ReviewStats> = {}): ReviewStats {
  return {
    hasData: true,
    reviewedPRs: 80,
    totalPRs: 100,
    reviewCoverage: 0.8,
    medianTimeToFirstReviewHours: 4,
    p90TimeToFirstReviewHours: 30,
    reviewers: [],
    topReviewerShare: 0.5,
    ...overrides,
  };
}

/** Build a HealthReport with sensible defaults; override what a test cares about. */
function makeHealth(overrides: Partial<HealthReport> = {}): HealthReport {
  return { hasData: true, repos: [], avgScore: 75, ...overrides };
}

/** Bundle the three metric fixtures into TargetInputs. */
function makeInputs(overrides: Partial<TargetInputs> = {}): TargetInputs {
  return {
    dora: makeDora(),
    review: makeReview(),
    health: makeHealth(),
    ...overrides,
  };
}

/** A config with all six targets set. */
function fullConfig(): TargetsConfig {
  return {
    targets: {
      maxMedianCycleHours: 24,
      minReviewCoverage: 0.8,
      maxChangeFailureRate: 0.1,
      minDeploysPerWeek: 1,
      maxP90FirstReviewHours: 48,
      minAvgHealthScore: 70,
    },
  };
}

/** A config with a single target set. */
function oneTarget(
  key: keyof TargetsConfig["targets"],
  value: number
): TargetsConfig {
  return { targets: { [key]: value } };
}

// ── loadTargetsConfig ──────────────────────────────────────────────────────────

describe("loadTargetsConfig", () => {
  let dir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "devex-targets-test-"));
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Write `content` as devex.config.json in the scratch dir. */
  function writeConfig(content: string): void {
    fs.writeFileSync(path.join(dir, "devex.config.json"), content);
  }

  it("returns null when the file is absent (no warning)", () => {
    expect(loadTargetsConfig(dir)).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns null and warns on unparseable JSON", () => {
    writeConfig("{ not json !!!");
    expect(loadTargetsConfig(dir)).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("returns null and warns when targets is missing", () => {
    writeConfig(JSON.stringify({ somethingElse: true }));
    expect(loadTargetsConfig(dir)).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("returns null and warns when targets is not an object", () => {
    writeConfig(JSON.stringify({ targets: [1, 2, 3] }));
    expect(loadTargetsConfig(dir)).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("round-trips a fully valid config", () => {
    const config = fullConfig();
    writeConfig(JSON.stringify(config));
    expect(loadTargetsConfig(dir)).toEqual(config);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("drops out-of-range and non-numeric values with a warning, keeping the rest", () => {
    writeConfig(
      JSON.stringify({
        targets: {
          maxMedianCycleHours: -5, // must be > 0
          minReviewCoverage: 1.5, // ratio must be ≤ 1
          maxChangeFailureRate: "0.1", // not a number
          minDeploysPerWeek: 0, // must be > 0
          maxP90FirstReviewHours: null, // not a number
          minAvgHealthScore: 70, // valid
        },
      })
    );
    expect(loadTargetsConfig(dir)).toEqual({
      targets: { minAvgHealthScore: 70 },
    });
    expect(warnSpy).toHaveBeenCalledTimes(5);
  });

  it("drops non-finite numeric values", () => {
    // JSON cannot express Infinity/NaN, but 1e999 parses to Infinity.
    writeConfig('{ "targets": { "maxMedianCycleHours": 1e999, "minAvgHealthScore": 70 } }');
    expect(loadTargetsConfig(dir)).toEqual({
      targets: { minAvgHealthScore: 70 },
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("accepts ratio boundaries 0 and 1", () => {
    writeConfig(
      JSON.stringify({ targets: { minReviewCoverage: 0, maxChangeFailureRate: 1 } })
    );
    expect(loadTargetsConfig(dir)).toEqual({
      targets: { minReviewCoverage: 0, maxChangeFailureRate: 1 },
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns null when every configured value is invalid", () => {
    writeConfig(
      JSON.stringify({
        targets: { maxMedianCycleHours: 0, minReviewCoverage: 2 },
      })
    );
    expect(loadTargetsConfig(dir)).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("ignores unknown keys without warning", () => {
    writeConfig(
      JSON.stringify({
        targets: { maxMedianCycleHours: 24, futureMetric: 99, typoKey: "x" },
      })
    );
    expect(loadTargetsConfig(dir)).toEqual({
      targets: { maxMedianCycleHours: 24 },
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns null when targets is an empty object", () => {
    writeConfig(JSON.stringify({ targets: {} }));
    expect(loadTargetsConfig(dir)).toBeNull();
  });

  it("loads a config with only incidentLabels (no targets) as non-null", () => {
    writeConfig(JSON.stringify({ incidentLabels: ["incident", "outage"] }));
    expect(loadTargetsConfig(dir)).toEqual({
      targets: {},
      incidentLabels: ["incident", "outage"],
    });
    // Still warns once about the missing/invalid targets object.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("trims incidentLabels entries and drops invalid ones with a warning", () => {
    writeConfig(
      JSON.stringify({
        targets: { minAvgHealthScore: 70 },
        incidentLabels: ["incident", "", 42, "  sev1  ", null],
      })
    );
    expect(loadTargetsConfig(dir)).toEqual({
      targets: { minAvgHealthScore: 70 },
      incidentLabels: ["incident", "sev1"],
    });
    expect(warnSpy).toHaveBeenCalledTimes(3); // "", 42, null
  });

  it("warns and drops incidentLabels when it is not an array", () => {
    writeConfig(
      JSON.stringify({ targets: { minAvgHealthScore: 70 }, incidentLabels: "incident" })
    );
    expect(loadTargetsConfig(dir)).toEqual({ targets: { minAvgHealthScore: 70 } });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("incidentLabels"));
  });

  it("returns null when incidentLabels has no valid entries and no target is valid", () => {
    writeConfig(JSON.stringify({ targets: {}, incidentLabels: ["", 1] }));
    expect(loadTargetsConfig(dir)).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(2); // one per invalid entry
  });

  it("omits incidentLabels from the result when the field is absent", () => {
    writeConfig(JSON.stringify({ targets: { minAvgHealthScore: 70 } }));
    const loaded = loadTargetsConfig(dir);
    expect(loaded).toEqual({ targets: { minAvgHealthScore: 70 } });
    expect(loaded).not.toHaveProperty("incidentLabels");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("loads the committed devex.config.example.json with all six targets", () => {
    // vitest runs from the repo root, so the example lives at cwd.
    const example = fs.readFileSync(
      path.resolve(process.cwd(), "devex.config.example.json"),
      "utf-8"
    );
    writeConfig(example);
    const loaded = loadTargetsConfig(dir);
    expect(loaded).not.toBeNull();
    expect(Object.keys(loaded!.targets)).toEqual([
      "maxMedianCycleHours",
      "minReviewCoverage",
      "maxChangeFailureRate",
      "minDeploysPerWeek",
      "maxP90FirstReviewHours",
      "minAvgHealthScore",
    ]);
    expect(loaded!.incidentLabels).toEqual(["incident", "outage", "sev1"]);
    expect(loaded!.rollup).toEqual({
      name: "acme-all",
      targets: [
        { owner: "acme", ownerType: "org" },
        { owner: "acme-labs", ownerType: "org" },
      ],
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // ── rollup parsing ───────────────────────────────────────────────────────────

  it("loads a valid rollup alongside targets", () => {
    writeConfig(
      JSON.stringify({
        targets: { minAvgHealthScore: 70 },
        rollup: {
          name: "  combined  ",
          targets: [
            { owner: " acme ", ownerType: "org" },
            { owner: "someone", ownerType: "user", repo: " tool " },
          ],
        },
      })
    );
    expect(loadTargetsConfig(dir)).toEqual({
      targets: { minAvgHealthScore: 70 },
      rollup: {
        name: "combined",
        targets: [
          { owner: "acme", ownerType: "org" },
          { owner: "someone", ownerType: "user", repo: "tool" },
        ],
      },
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("loads a rollup-only config (no targets or incidentLabels) as non-null", () => {
    writeConfig(
      JSON.stringify({
        rollup: { name: "all", targets: [{ owner: "acme", ownerType: "org" }] },
      })
    );
    const loaded = loadTargetsConfig(dir);
    expect(loaded).toEqual({
      targets: {},
      rollup: { name: "all", targets: [{ owner: "acme", ownerType: "org" }] },
    });
    // Still warns once about the missing/invalid targets object.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("omits rollup from the result when the field is absent", () => {
    writeConfig(JSON.stringify({ targets: { minAvgHealthScore: 70 } }));
    const loaded = loadTargetsConfig(dir);
    expect(loaded).not.toHaveProperty("rollup");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns and drops the rollup when it is not an object", () => {
    writeConfig(
      JSON.stringify({ targets: { minAvgHealthScore: 70 }, rollup: ["acme"] })
    );
    const loaded = loadTargetsConfig(dir);
    expect(loaded).toEqual({ targets: { minAvgHealthScore: 70 } });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"rollup"'));
  });

  it("warns and drops the rollup when the name is missing or blank", () => {
    writeConfig(
      JSON.stringify({
        targets: { minAvgHealthScore: 70 },
        rollup: { name: "   ", targets: [{ owner: "acme", ownerType: "org" }] },
      })
    );
    expect(loadTargetsConfig(dir)).toEqual({ targets: { minAvgHealthScore: 70 } });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("rollup.name"));
  });

  it("warns and drops the rollup when targets is not an array or is empty", () => {
    writeConfig(
      JSON.stringify({
        targets: { minAvgHealthScore: 70 },
        rollup: { name: "all", targets: {} },
      })
    );
    expect(loadTargetsConfig(dir)).toEqual({ targets: { minAvgHealthScore: 70 } });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("rollup.targets"));

    warnSpy.mockClear();
    writeConfig(
      JSON.stringify({
        targets: { minAvgHealthScore: 70 },
        rollup: { name: "all", targets: [] },
      })
    );
    expect(loadTargetsConfig(dir)).toEqual({ targets: { minAvgHealthScore: 70 } });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no valid targets"));
  });

  it("drops invalid rollup target entries with warns, keeping the valid ones", () => {
    writeConfig(
      JSON.stringify({
        targets: { minAvgHealthScore: 70 },
        rollup: {
          name: "all",
          targets: [
            { owner: "acme", ownerType: "org" }, // valid
            { owner: "bad", ownerType: "team" }, // bad ownerType
            { owner: "", ownerType: "org" }, // blank owner
            { ownerType: "user" }, // missing owner
            { owner: "x", ownerType: "org", repo: "  " }, // blank repo
            "not-an-object",
          ],
        },
      })
    );
    expect(loadTargetsConfig(dir)).toEqual({
      targets: { minAvgHealthScore: 70 },
      rollup: { name: "all", targets: [{ owner: "acme", ownerType: "org" }] },
    });
    expect(warnSpy).toHaveBeenCalledTimes(5); // one per invalid entry
  });

  it("returns null when the rollup is invalid and nothing else is configured", () => {
    writeConfig(JSON.stringify({ rollup: { name: "all", targets: [] } }));
    expect(loadTargetsConfig(dir)).toBeNull();
    // One warn for missing targets object, one for the empty rollup.
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});

// ── evaluateTargets ────────────────────────────────────────────────────────────

describe("evaluateTargets", () => {
  it("returns one evaluation per configured target, in canonical key order", () => {
    const results = evaluateTargets(fullConfig(), makeInputs());
    expect(results.map((r) => r.id)).toEqual([
      "max-median-cycle-hours",
      "min-review-coverage",
      "max-change-failure-rate",
      "min-deploys-per-week",
      "max-p90-first-review-hours",
      "min-avg-health-score",
    ]);
    expect(results.map((r) => r.label)).toEqual([
      "Median cycle time",
      "Review coverage",
      "Change failure rate",
      "Deploy frequency",
      "p90 time to first review",
      "Average health score",
    ]);
  });

  it("includes only configured targets", () => {
    const results = evaluateTargets(
      { targets: { minAvgHealthScore: 70, maxMedianCycleHours: 24 } },
      makeInputs()
    );
    // Canonical order, not config-literal order.
    expect(results.map((r) => r.id)).toEqual([
      "max-median-cycle-hours",
      "min-avg-health-score",
    ]);
  });

  describe("max-median-cycle-hours", () => {
    it("is met at the boundary (actual == target)", () => {
      const inputs = makeInputs({
        dora: makeDora({ leadTimeHours: { value: 24, tier: "high", hasData: true } }),
      });
      const [result] = evaluateTargets(oneTarget("maxMedianCycleHours", 24), inputs);
      expect(result).toEqual({
        id: "max-median-cycle-hours",
        label: "Median cycle time",
        target: 24,
        actual: 24,
        met: true,
        hasData: true,
        detail: "Median cycle time is 24.0h vs target ≤ 24.0h",
      });
    });

    it("is unmet just above the target", () => {
      const inputs = makeInputs({
        dora: makeDora({ leadTimeHours: { value: 24.1, tier: "high", hasData: true } }),
      });
      const [result] = evaluateTargets(oneTarget("maxMedianCycleHours", 24), inputs);
      expect(result.met).toBe(false);
      expect(result.actual).toBe(24.1);
    });

    it("reports no data when leadTimeHours.hasData is false", () => {
      const inputs = makeInputs({
        dora: makeDora({ leadTimeHours: { value: 0, hasData: false } }),
      });
      const [result] = evaluateTargets(oneTarget("maxMedianCycleHours", 24), inputs);
      expect(result.met).toBe(false);
      expect(result.hasData).toBe(false);
      expect(result.detail).toBe("no data to evaluate");
    });
  });

  describe("min-review-coverage", () => {
    it("is met at the boundary (actual == target)", () => {
      const inputs = makeInputs({ review: makeReview({ reviewCoverage: 0.8 }) });
      const [result] = evaluateTargets(oneTarget("minReviewCoverage", 0.8), inputs);
      expect(result.met).toBe(true);
      expect(result.detail).toBe("Review coverage is 80% vs target ≥ 80%");
    });

    it("is unmet just below the target", () => {
      const inputs = makeInputs({ review: makeReview({ reviewCoverage: 0.79 }) });
      const [result] = evaluateTargets(oneTarget("minReviewCoverage", 0.8), inputs);
      expect(result.met).toBe(false);
      expect(result.detail).toBe("Review coverage is 79% vs target ≥ 80%");
    });

    it("reports no data when review.hasData is false", () => {
      const inputs = makeInputs({ review: makeReview({ hasData: false }) });
      const [result] = evaluateTargets(oneTarget("minReviewCoverage", 0.8), inputs);
      expect(result.met).toBe(false);
      expect(result.hasData).toBe(false);
      expect(result.detail).toBe("no data to evaluate");
    });

    it("reports no data when totalPRs is 0 even if review.hasData is true", () => {
      const inputs = makeInputs({
        review: makeReview({ hasData: true, totalPRs: 0, reviewedPRs: 0 }),
      });
      const [result] = evaluateTargets(oneTarget("minReviewCoverage", 0.8), inputs);
      expect(result.hasData).toBe(false);
      expect(result.met).toBe(false);
    });
  });

  describe("max-change-failure-rate", () => {
    it("is met at the boundary (actual == target)", () => {
      const inputs = makeInputs({
        dora: makeDora({ changeFailureRate: { value: 0.1, tier: "high", hasData: true } }),
      });
      const [result] = evaluateTargets(oneTarget("maxChangeFailureRate", 0.1), inputs);
      expect(result.met).toBe(true);
      expect(result.detail).toBe("Change failure rate is 10% vs target ≤ 10%");
    });

    it("is unmet just above the target", () => {
      const inputs = makeInputs({
        dora: makeDora({ changeFailureRate: { value: 0.11, tier: "medium", hasData: true } }),
      });
      const [result] = evaluateTargets(oneTarget("maxChangeFailureRate", 0.1), inputs);
      expect(result.met).toBe(false);
    });

    it("reports no data when changeFailureRate.hasData is false", () => {
      const inputs = makeInputs({
        dora: makeDora({ changeFailureRate: { value: 0, hasData: false } }),
      });
      const [result] = evaluateTargets(oneTarget("maxChangeFailureRate", 0.1), inputs);
      expect(result.met).toBe(false);
      expect(result.hasData).toBe(false);
      expect(result.detail).toBe("no data to evaluate");
    });
  });

  describe("min-deploys-per-week", () => {
    it("is met at the boundary (actual == target)", () => {
      const inputs = makeInputs({
        dora: makeDora({ deployFrequencyPerWeek: { value: 1, tier: "high", hasData: true } }),
      });
      const [result] = evaluateTargets(oneTarget("minDeploysPerWeek", 1), inputs);
      expect(result.met).toBe(true);
      expect(result.detail).toBe("Deploy frequency is 1/week vs target ≥ 1/week");
    });

    it("is unmet just below the target", () => {
      const inputs = makeInputs({
        dora: makeDora({ deployFrequencyPerWeek: { value: 0.9, tier: "medium", hasData: true } }),
      });
      const [result] = evaluateTargets(oneTarget("minDeploysPerWeek", 1), inputs);
      expect(result.met).toBe(false);
    });

    it("reports no data when deployFrequencyPerWeek.hasData is false", () => {
      const inputs = makeInputs({
        dora: makeDora({ deployFrequencyPerWeek: { value: 0, hasData: false } }),
      });
      const [result] = evaluateTargets(oneTarget("minDeploysPerWeek", 1), inputs);
      expect(result.met).toBe(false);
      expect(result.hasData).toBe(false);
      expect(result.detail).toBe("no data to evaluate");
    });
  });

  describe("max-p90-first-review-hours", () => {
    it("is met at the boundary (actual == target)", () => {
      const inputs = makeInputs({
        review: makeReview({ p90TimeToFirstReviewHours: 48 }),
      });
      const [result] = evaluateTargets(oneTarget("maxP90FirstReviewHours", 48), inputs);
      expect(result.met).toBe(true);
      expect(result.detail).toBe("p90 time to first review is 48.0h vs target ≤ 48.0h");
    });

    it("is unmet just above the target", () => {
      const inputs = makeInputs({
        review: makeReview({ p90TimeToFirstReviewHours: 48.5 }),
      });
      const [result] = evaluateTargets(oneTarget("maxP90FirstReviewHours", 48), inputs);
      expect(result.met).toBe(false);
    });

    it("reports no data when review.hasData is false", () => {
      const inputs = makeInputs({
        review: makeReview({ hasData: false, p90TimeToFirstReviewHours: 10 }),
      });
      const [result] = evaluateTargets(oneTarget("maxP90FirstReviewHours", 48), inputs);
      expect(result.hasData).toBe(false);
      expect(result.met).toBe(false);
      expect(result.detail).toBe("no data to evaluate");
    });

    it("reports no data when p90 is 0 even if review.hasData is true", () => {
      const inputs = makeInputs({
        review: makeReview({ hasData: true, p90TimeToFirstReviewHours: 0 }),
      });
      const [result] = evaluateTargets(oneTarget("maxP90FirstReviewHours", 48), inputs);
      expect(result.hasData).toBe(false);
      expect(result.met).toBe(false);
    });
  });

  describe("min-avg-health-score", () => {
    it("is met at the boundary (actual == target)", () => {
      const inputs = makeInputs({ health: makeHealth({ avgScore: 70 }) });
      const [result] = evaluateTargets(oneTarget("minAvgHealthScore", 70), inputs);
      expect(result.met).toBe(true);
      expect(result.detail).toBe("Average health score is 70 vs target ≥ 70");
    });

    it("is unmet just below the target", () => {
      const inputs = makeInputs({ health: makeHealth({ avgScore: 69 }) });
      const [result] = evaluateTargets(oneTarget("minAvgHealthScore", 70), inputs);
      expect(result.met).toBe(false);
    });

    it("reports no data when health.hasData is false", () => {
      const inputs = makeInputs({
        health: makeHealth({ hasData: false, avgScore: 0 }),
      });
      const [result] = evaluateTargets(oneTarget("minAvgHealthScore", 70), inputs);
      expect(result.met).toBe(false);
      expect(result.hasData).toBe(false);
      expect(result.detail).toBe("no data to evaluate");
    });
  });

  it("marks all six unmet with no-data details when every signal is absent", () => {
    const inputs: TargetInputs = {
      dora: makeDora({
        hasData: false,
        deployFrequencyPerWeek: { value: 0, hasData: false },
        leadTimeHours: { value: 0, hasData: false },
        changeFailureRate: { value: 0, hasData: false },
        mttrHours: { value: 0, hasData: false },
        totalDeploys: 0,
        totalMergedPRs: 0,
        totalReverts: 0,
      }),
      review: makeReview({
        hasData: false,
        reviewedPRs: 0,
        totalPRs: 0,
        reviewCoverage: 0,
        p90TimeToFirstReviewHours: 0,
      }),
      health: makeHealth({ hasData: false, avgScore: 0 }),
    };
    const results = evaluateTargets(fullConfig(), inputs);
    expect(results).toHaveLength(6);
    for (const result of results) {
      expect(result.met).toBe(false);
      expect(result.hasData).toBe(false);
      expect(result.detail).toBe("no data to evaluate");
    }
  });

  it("evaluates the full happy path: all six targets met", () => {
    // Defaults: cycle 20h ≤ 24h, coverage 0.8 ≥ 0.8, CFR 0.05 ≤ 0.1,
    // deploys 2/wk ≥ 1/wk, p90 30h ≤ 48h, health 75 ≥ 70.
    const results = evaluateTargets(fullConfig(), makeInputs());
    expect(results).toHaveLength(6);
    for (const result of results) {
      expect(result.met).toBe(true);
      expect(result.hasData).toBe(true);
    }
  });

  it("returns an empty array for a config with no targets set", () => {
    expect(evaluateTargets({ targets: {} }, makeInputs())).toEqual([]);
  });
});
