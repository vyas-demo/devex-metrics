import { describe, it, expect, afterEach, vi } from "vitest";
import { setOctokit, resetOctokit } from "../github-client.js";
import { Octokit } from "@octokit/rest";
import { collectIncidents, DEFAULT_INCIDENT_LABELS } from "./incidents.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

type IssueNode = {
  number: number;
  createdAt: string;
  closedAt: string | null;
  labels: { nodes: Array<{ name: string } | null> } | null;
};

/** ISO timestamp `days` days before now. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Build an issue node with sensible defaults. */
function issue(
  number: number,
  createdAt: string,
  closedAt: string | null = null,
  labelNames: string[] = ["incident"]
): IssueNode {
  return {
    number,
    createdAt,
    closedAt,
    labels: { nodes: labelNames.map((name) => ({ name })) },
  };
}

function makeResponse(issues: Array<IssueNode | null>) {
  return { repository: { issues: { nodes: issues } } };
}

function buildMockOctokit(
  response: unknown,
  capture?: { vars?: Record<string, unknown> }
): Octokit {
  const graphql = async (_query: string, vars: Record<string, unknown>) => {
    if (capture) capture.vars = vars;
    if (response instanceof Error) throw response;
    return response;
  };
  return { graphql } as unknown as Octokit;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("collectIncidents", () => {
  afterEach(() => {
    resetOctokit();
    vi.restoreAllMocks();
  });

  it("maps open and closed incidents and sorts by createdAt ascending", async () => {
    setOctokit(
      buildMockOctokit(
        makeResponse([
          // Open incident, newest.
          issue(30, "2026-07-01T00:00:00Z", null, ["outage"]),
          // Closed incident, 4.5 hours to resolve.
          issue(20, "2026-06-01T00:00:00Z", "2026-06-01T04:30:00Z", ["incident"]),
          // Closed incident, oldest, 100 minutes → 1.67h after rounding.
          issue(10, "2026-05-01T00:00:00Z", "2026-05-01T01:40:00Z", ["sev1"]),
        ])
      )
    );

    const result = await collectIncidents("owner", "repo");
    expect(result).not.toBeNull();
    expect(result).toHaveLength(3);
    // Ascending by createdAt: #10, #20, #30.
    expect(result!.map((e) => e.number)).toEqual([10, 20, 30]);
    expect(result![0]).toEqual({
      number: 10,
      createdAt: "2026-05-01T00:00:00Z",
      closedAt: "2026-05-01T01:40:00Z",
      resolutionHours: 1.67, // rounded to 2 decimals
      labels: ["sev1"],
    });
    expect(result![1].resolutionHours).toBe(4.5);
    // Open incident has no closedAt/resolutionHours.
    expect(result![2].closedAt).toBeUndefined();
    expect(result![2].resolutionHours).toBeUndefined();
    expect(result![2].labels).toEqual(["outage"]);
  });

  it("keeps only labels matching the incident set, case-insensitively", async () => {
    setOctokit(
      buildMockOctokit(
        makeResponse([
          issue(1, daysAgo(3), null, ["INCIDENT", "bug", "Sev1", "needs-triage"]),
        ])
      )
    );

    const result = await collectIncidents("owner", "repo");
    expect(result).toHaveLength(1);
    // Original casing preserved; non-incident labels dropped defensively.
    expect(result![0].labels).toEqual(["INCIDENT", "Sev1"]);
  });

  it("skips null issue nodes and tolerates a missing labels field", async () => {
    setOctokit(
      buildMockOctokit(
        makeResponse([
          null,
          { number: 5, createdAt: daysAgo(2), closedAt: null, labels: null },
        ])
      )
    );

    const result = await collectIncidents("owner", "repo");
    expect(result).toHaveLength(1);
    expect(result![0].number).toBe(5);
    expect(result![0].labels).toEqual([]);
  });

  it("passes custom labels through to the query variables", async () => {
    const capture: { vars?: Record<string, unknown> } = {};
    setOctokit(buildMockOctokit(makeResponse([]), capture));

    await collectIncidents("owner", "repo", ["p0", "oncall-page"]);
    expect(capture.vars).toMatchObject({
      owner: "owner",
      name: "repo",
      labels: ["p0", "oncall-page"],
    });
  });

  it("falls back to DEFAULT_INCIDENT_LABELS when no labels are given", async () => {
    const capture: { vars?: Record<string, unknown> } = {};
    setOctokit(buildMockOctokit(makeResponse([]), capture));

    await collectIncidents("owner", "repo");
    expect(capture.vars).toMatchObject({ labels: DEFAULT_INCIDENT_LABELS });
    expect(DEFAULT_INCIDENT_LABELS).toEqual([
      "incident",
      "outage",
      "sev1",
      "sev2",
      "production-incident",
    ]);
  });

  it("falls back to DEFAULT_INCIDENT_LABELS when an empty labels list is given", async () => {
    const capture: { vars?: Record<string, unknown> } = {};
    setOctokit(buildMockOctokit(makeResponse([]), capture));

    await collectIncidents("owner", "repo", []);
    expect(capture.vars).toMatchObject({ labels: DEFAULT_INCIDENT_LABELS });
  });

  it("drops incidents older than ~2 years (730 days)", async () => {
    setOctokit(
      buildMockOctokit(
        makeResponse([
          issue(2, daysAgo(10)),
          issue(1, daysAgo(800), daysAgo(799)),
        ])
      )
    );

    const result = await collectIncidents("owner", "repo");
    expect(result).toHaveLength(1);
    expect(result![0].number).toBe(2);
  });

  it("returns null on a NOT_FOUND GraphQL error", async () => {
    const err = Object.assign(new Error("Not found"), {
      errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }],
    });
    setOctokit(buildMockOctokit(err));

    const result = await collectIncidents("owner", "missing-repo");
    expect(result).toBeNull();
  });

  it("returns null on HTTP 404 error", async () => {
    const err = Object.assign(new Error("Not found"), { status: 404 });
    setOctokit(buildMockOctokit(err));

    expect(await collectIncidents("owner", "repo")).toBeNull();
  });

  it("returns null and warns on a FORBIDDEN GraphQL error", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = Object.assign(new Error("Forbidden"), {
      errors: [{ type: "FORBIDDEN", message: "forbidden" }],
    });
    setOctokit(buildMockOctokit(err));

    const result = await collectIncidents("owner", "private-repo");
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("403"));
  });

  it("returns null and warns on a transient 5xx error without retrying", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const graphql = async () => {
      calls++;
      throw Object.assign(new Error("Bad gateway"), { status: 502 });
    };
    setOctokit({ graphql } as unknown as Octokit);

    const result = await collectIncidents("owner", "repo");
    expect(result).toBeNull();
    expect(calls).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("transient"));
  });

  it("re-throws non-transient, non-404/403 errors", async () => {
    const err = Object.assign(new Error("Bad request"), { status: 400 });
    setOctokit(buildMockOctokit(err));

    await expect(collectIncidents("owner", "repo")).rejects.toMatchObject({ status: 400 });
  });

  it("returns null and warns when the repository field is missing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    setOctokit(buildMockOctokit({ repository: null }));

    expect(await collectIncidents("owner", "repo")).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("empty response"));
  });

  it("returns [] for a repo with no labeled incidents", async () => {
    setOctokit(buildMockOctokit(makeResponse([])));

    const result = await collectIncidents("owner", "repo");
    expect(result).toEqual([]);
  });
});
