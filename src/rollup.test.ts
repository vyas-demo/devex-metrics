import { describe, it, expect, afterEach, vi } from "vitest";
import { mergeOrgMetrics, loadRollupMetrics } from "./rollup.js";
import { buildTargetKey, loadRawCache, CURRENT_SCHEMA_VERSION } from "./cache.js";
import type {
  CopilotUsageMetrics,
  OrgMetrics,
  RepoMetrics,
  RollupConfig,
} from "./types.js";

vi.mock("./cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cache.js")>();
  return { ...actual, loadRawCache: vi.fn() };
});

// ── Fixture factories ──────────────────────────────────────────────────────────

/** Build a RepoMetrics with sensible defaults; override what a test cares about. */
function makeRepo(overrides: Partial<RepoMetrics> = {}): RepoMetrics {
  return {
    name: "repo-a",
    fullName: "acme/repo-a",
    issues: { open: 1, closed: 2 },
    pullRequests: { open: 1, closed: 0, merged: 3 },
    pullRequestDetails: [],
    committerCount: 1,
    reviewerCount: 1,
    contributorCount: 2,
    dependentCount: 0,
    ...overrides,
  };
}

/** Build an OrgMetrics with sensible defaults; override what a test cares about. */
function makeOrg(overrides: Partial<OrgMetrics> = {}): OrgMetrics {
  const repos = overrides.repos ?? [makeRepo()];
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    owner: "acme",
    ownerType: "org",
    collectedAt: "2026-07-01T00:00:00Z",
    repoCount: repos.length,
    repos,
    ...overrides,
  };
}

/** Minimal CopilotUsageMetrics stub — merge logic never looks inside it. */
function makeUsage(scopeName: string): CopilotUsageMetrics {
  return { scope: "organization", scopeName } as CopilotUsageMetrics;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// ── mergeOrgMetrics ────────────────────────────────────────────────────────────

describe("mergeOrgMetrics", () => {
  it("throws on empty inputs", () => {
    expect(() => mergeOrgMetrics([], "combined")).toThrow(/at least one/);
  });

  it("stamps name, ownerType org, current schema version, and no targetRepo", () => {
    const merged = mergeOrgMetrics([makeOrg()], "combined");
    expect(merged.owner).toBe("combined");
    expect(merged.ownerType).toBe("org");
    expect(merged.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(merged.targetRepo).toBeUndefined();
  });

  it("uses the maximum collectedAt across inputs", () => {
    const merged = mergeOrgMetrics(
      [
        makeOrg({ collectedAt: "2026-07-01T00:00:00Z" }),
        makeOrg({ owner: "labs", collectedAt: "2026-07-03T12:00:00Z" }),
        makeOrg({ owner: "misc", collectedAt: "2026-06-30T00:00:00Z" }),
      ],
      "combined"
    );
    expect(merged.collectedAt).toBe("2026-07-03T12:00:00Z");
  });

  it("concatenates repos across inputs and sets repoCount to the merged length", () => {
    const merged = mergeOrgMetrics(
      [
        makeOrg({ repos: [makeRepo({ fullName: "acme/a", name: "a" })] }),
        makeOrg({
          owner: "labs",
          repos: [
            makeRepo({ fullName: "labs/b", name: "b" }),
            makeRepo({ fullName: "labs/c", name: "c" }),
          ],
        }),
      ],
      "combined"
    );
    expect(merged.repos.map((r) => r.fullName)).toEqual(["acme/a", "labs/b", "labs/c"]);
    expect(merged.repoCount).toBe(3);
  });

  it("dedupes repos by fullName keeping the newer collectedAt", () => {
    const older = makeRepo({ fullName: "acme/shared", collectedAt: "2026-07-01T00:00:00Z", dependentCount: 1 });
    const newer = makeRepo({ fullName: "acme/shared", collectedAt: "2026-07-02T00:00:00Z", dependentCount: 9 });
    const merged = mergeOrgMetrics(
      [makeOrg({ repos: [older] }), makeOrg({ owner: "labs", repos: [newer] })],
      "combined"
    );
    expect(merged.repos).toHaveLength(1);
    expect(merged.repos[0].dependentCount).toBe(9);
    expect(merged.repoCount).toBe(1);

    // Order-independent: newer entry wins even when seen first.
    const reversed = mergeOrgMetrics(
      [makeOrg({ repos: [newer] }), makeOrg({ owner: "labs", repos: [older] })],
      "combined"
    );
    expect(reversed.repos[0].dependentCount).toBe(9);
  });

  it("a repo entry missing collectedAt loses to one that has it", () => {
    const dated = makeRepo({ fullName: "acme/shared", collectedAt: "2026-07-01T00:00:00Z", dependentCount: 5 });
    const undated = makeRepo({ fullName: "acme/shared", dependentCount: 7 });
    const merged = mergeOrgMetrics(
      [makeOrg({ repos: [undated] }), makeOrg({ owner: "labs", repos: [dated] })],
      "combined"
    );
    expect(merged.repos[0].dependentCount).toBe(5);

    // Both missing: the first-seen entry is kept.
    const bothMissing = mergeOrgMetrics(
      [
        makeOrg({ repos: [makeRepo({ fullName: "acme/shared", dependentCount: 1 })] }),
        makeOrg({ owner: "labs", repos: [makeRepo({ fullName: "acme/shared", dependentCount: 2 })] }),
      ],
      "combined"
    );
    expect(bothMissing.repos[0].dependentCount).toBe(1);
  });

  it("unions weekly trends by week, summing all numeric fields, sorted ascending", () => {
    const merged = mergeOrgMetrics(
      [
        makeOrg({
          weeklyTrends: [
            { week: "2026-W20", prsOpened: 1, prsMerged: 2, issuesOpened: 3, issuesClosed: 4, linesAdded: 10, linesDeleted: 1 },
            { week: "2026-W22", prsOpened: 5, prsMerged: 6, issuesOpened: 7, issuesClosed: 8, linesAdded: 20, linesDeleted: 2 },
          ],
        }),
        makeOrg({
          owner: "labs",
          weeklyTrends: [
            { week: "2026-W22", prsOpened: 1, prsMerged: 1, issuesOpened: 1, issuesClosed: 1, linesAdded: 5, linesDeleted: 5 },
            { week: "2026-W19", prsOpened: 9, prsMerged: 9, issuesOpened: 9, issuesClosed: 9, linesAdded: 90, linesDeleted: 9 },
          ],
        }),
      ],
      "combined"
    );
    expect(merged.weeklyTrends).toEqual([
      { week: "2026-W19", prsOpened: 9, prsMerged: 9, issuesOpened: 9, issuesClosed: 9, linesAdded: 90, linesDeleted: 9 },
      { week: "2026-W20", prsOpened: 1, prsMerged: 2, issuesOpened: 3, issuesClosed: 4, linesAdded: 10, linesDeleted: 1 },
      { week: "2026-W22", prsOpened: 6, prsMerged: 7, issuesOpened: 8, issuesClosed: 9, linesAdded: 25, linesDeleted: 7 },
    ]);
  });

  it("leaves weeklyTrends undefined when no input has trends", () => {
    const merged = mergeOrgMetrics([makeOrg(), makeOrg({ owner: "labs" })], "combined");
    expect(merged.weeklyTrends).toBeUndefined();
  });

  it("omits copilotUsage when no input has usage data", () => {
    const merged = mergeOrgMetrics([makeOrg(), makeOrg({ owner: "labs" })], "combined");
    expect(merged.copilotUsage).toBeUndefined();
  });

  it("includes copilotUsage when exactly one input has it", () => {
    const usage = makeUsage("acme");
    const merged = mergeOrgMetrics(
      [makeOrg({ copilotUsage: usage }), makeOrg({ owner: "labs" })],
      "combined"
    );
    expect(merged.copilotUsage).toBe(usage);
  });

  it("drops copilotUsage with a warning when two or more inputs have it", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const merged = mergeOrgMetrics(
      [
        makeOrg({ copilotUsage: makeUsage("acme") }),
        makeOrg({ owner: "labs", copilotUsage: makeUsage("labs") }),
      ],
      "combined"
    );
    expect(merged.copilotUsage).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("double-count"));
  });
});

// ── loadRollupMetrics ──────────────────────────────────────────────────────────

describe("loadRollupMetrics", () => {
  const config: RollupConfig = {
    name: "acme-all",
    targets: [
      { owner: "acme", ownerType: "org" },
      { owner: "acme-labs", ownerType: "org" },
    ],
  };

  it("merges the caches of all targets when every cache loads", () => {
    const byKey: Record<string, OrgMetrics> = {
      acme: makeOrg({ repos: [makeRepo({ fullName: "acme/a", name: "a" })] }),
      "acme-labs": makeOrg({
        owner: "acme-labs",
        collectedAt: "2026-07-05T00:00:00Z",
        repos: [makeRepo({ fullName: "acme-labs/b", name: "b" })],
      }),
    };
    vi.mocked(loadRawCache).mockImplementation((key) => byKey[key] ?? null);

    const merged = loadRollupMetrics(config);
    expect(merged).not.toBeNull();
    expect(merged!.owner).toBe("acme-all");
    expect(merged!.repoCount).toBe(2);
    expect(merged!.collectedAt).toBe("2026-07-05T00:00:00Z");
    expect(loadRawCache).toHaveBeenCalledWith(buildTargetKey("acme", "org", undefined));
    expect(loadRawCache).toHaveBeenCalledWith(buildTargetKey("acme-labs", "org", undefined));
  });

  it("skips missing caches with a warning naming the target and merges the rest", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(loadRawCache).mockImplementation((key) =>
      key === "acme" ? makeOrg() : null
    );

    const merged = loadRollupMetrics(config);
    expect(merged).not.toBeNull();
    expect(merged!.owner).toBe("acme-all");
    expect(merged!.repoCount).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("acme-labs"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Collect it first"));
  });

  it("returns null with a warning when no target cache loads", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(loadRawCache).mockReturnValue(null);

    expect(loadRollupMetrics(config)).toBeNull();
    // One warning per missing target plus the final none-loaded warning.
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenLastCalledWith(
      expect.stringContaining("none of the 2 configured")
    );
  });

  it("builds repo-scoped cache keys for targets with a repo", () => {
    vi.mocked(loadRawCache).mockReturnValue(makeOrg());
    const scoped: RollupConfig = {
      name: "scoped",
      targets: [{ owner: "acme", ownerType: "user", repo: "big-org/platform" }],
    };
    loadRollupMetrics(scoped);
    expect(loadRawCache).toHaveBeenCalledWith(
      buildTargetKey("acme", "user", "big-org/platform")
    );
  });
});
