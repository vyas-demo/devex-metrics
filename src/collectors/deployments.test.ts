import { describe, it, expect, afterEach, vi } from "vitest";
import { setOctokit, resetOctokit } from "../github-client.js";
import { Octokit } from "@octokit/rest";
import { collectDeployments } from "./deployments.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

type DeploymentNode = {
  createdAt: string;
  environment: string | null;
  latestStatus: { state: string } | null;
};

type ReleaseNode = {
  createdAt: string;
  tagName: string | null;
  isPrerelease: boolean;
};

/** ISO timestamp `days` days before now. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeResponse(opts: {
  deployments?: Array<DeploymentNode | null>;
  releases?: Array<ReleaseNode | null>;
}) {
  return {
    repository: {
      deployments: { nodes: opts.deployments ?? [] },
      releases: { nodes: opts.releases ?? [] },
    },
  };
}

function buildMockOctokit(response: unknown): Octokit {
  const graphql = async (_query: string, _vars: unknown) => {
    if (response instanceof Error) throw response;
    return response;
  };
  return { graphql } as unknown as Octokit;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("collectDeployments", () => {
  afterEach(() => {
    resetOctokit();
    vi.restoreAllMocks();
  });

  it("maps deployments and releases and sorts by createdAt descending", async () => {
    setOctokit(
      buildMockOctokit(
        makeResponse({
          deployments: [
            { createdAt: daysAgo(1), environment: "production", latestStatus: { state: "SUCCESS" } },
            { createdAt: daysAgo(5), environment: "staging", latestStatus: { state: "ACTIVE" } },
          ],
          releases: [
            { createdAt: daysAgo(3), tagName: "v1.2.0", isPrerelease: false },
          ],
        })
      )
    );

    const result = await collectDeployments("owner", "repo");
    expect(result).not.toBeNull();
    expect(result).toHaveLength(3);
    // Sorted newest first: deployment(1d), release(3d), deployment(5d)
    expect(result!.map((e) => e.source)).toEqual(["deployment", "release", "deployment"]);
    expect(result![0]).toEqual({
      createdAt: result![0].createdAt,
      source: "deployment",
      environment: "production",
      state: "success", // lowercased from SUCCESS
    });
    expect(result![1]).toEqual({
      createdAt: result![1].createdAt,
      source: "release",
      tagName: "v1.2.0",
    });
    expect(result![2].environment).toBe("staging");
    expect(result![2].state).toBe("active");
  });

  it("keeps deployments with no latestStatus (state undefined)", async () => {
    setOctokit(
      buildMockOctokit(
        makeResponse({
          deployments: [
            { createdAt: daysAgo(2), environment: "prod", latestStatus: null },
          ],
        })
      )
    );

    const result = await collectDeployments("owner", "repo");
    expect(result).toHaveLength(1);
    expect(result![0].state).toBeUndefined();
    expect(result![0].environment).toBe("prod");
  });

  it("keeps inactive (superseded) deployments but drops failed/in-flight states", async () => {
    setOctokit(
      buildMockOctokit(
        makeResponse({
          deployments: [
            { createdAt: daysAgo(1), environment: "prod", latestStatus: { state: "INACTIVE" } },
            { createdAt: daysAgo(2), environment: "prod", latestStatus: { state: "ERROR" } },
            { createdAt: daysAgo(3), environment: "prod", latestStatus: { state: "FAILURE" } },
            { createdAt: daysAgo(4), environment: "prod", latestStatus: { state: "PENDING" } },
            { createdAt: daysAgo(5), environment: "prod", latestStatus: { state: "QUEUED" } },
            { createdAt: daysAgo(6), environment: "prod", latestStatus: { state: "IN_PROGRESS" } },
            { createdAt: daysAgo(7), environment: "prod", latestStatus: { state: "WAITING" } },
          ],
        })
      )
    );

    const result = await collectDeployments("owner", "repo");
    expect(result).toHaveLength(1);
    expect(result![0].state).toBe("inactive");
  });

  it("skips prereleases", async () => {
    setOctokit(
      buildMockOctokit(
        makeResponse({
          releases: [
            { createdAt: daysAgo(1), tagName: "v2.0.0-rc.1", isPrerelease: true },
            { createdAt: daysAgo(2), tagName: "v1.9.0", isPrerelease: false },
          ],
        })
      )
    );

    const result = await collectDeployments("owner", "repo");
    expect(result).toHaveLength(1);
    expect(result![0].tagName).toBe("v1.9.0");
  });

  it("drops events older than ~2 years (730 days)", async () => {
    setOctokit(
      buildMockOctokit(
        makeResponse({
          deployments: [
            { createdAt: daysAgo(10), environment: "prod", latestStatus: { state: "SUCCESS" } },
            { createdAt: daysAgo(800), environment: "prod", latestStatus: { state: "SUCCESS" } },
          ],
          releases: [
            { createdAt: daysAgo(20), tagName: "v1.0.0", isPrerelease: false },
            { createdAt: daysAgo(900), tagName: "v0.1.0", isPrerelease: false },
          ],
        })
      )
    );

    const result = await collectDeployments("owner", "repo");
    expect(result).toHaveLength(2);
    expect(result!.map((e) => e.source).sort()).toEqual(["deployment", "release"]);
  });

  it("returns null on a NOT_FOUND GraphQL error", async () => {
    const err = Object.assign(new Error("Not found"), {
      errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }],
    });
    setOctokit(buildMockOctokit(err));

    const result = await collectDeployments("owner", "missing-repo");
    expect(result).toBeNull();
  });

  it("returns null on HTTP 404 error", async () => {
    const err = Object.assign(new Error("Not found"), { status: 404 });
    setOctokit(buildMockOctokit(err));

    expect(await collectDeployments("owner", "repo")).toBeNull();
  });

  it("returns null and warns on a FORBIDDEN GraphQL error", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = Object.assign(new Error("Forbidden"), {
      errors: [{ type: "FORBIDDEN", message: "forbidden" }],
    });
    setOctokit(buildMockOctokit(err));

    const result = await collectDeployments("owner", "private-repo");
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

    const result = await collectDeployments("owner", "repo");
    expect(result).toBeNull();
    expect(calls).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("transient"));
  });

  it("re-throws non-transient, non-404/403 errors", async () => {
    const err = Object.assign(new Error("Bad request"), { status: 400 });
    setOctokit(buildMockOctokit(err));

    await expect(collectDeployments("owner", "repo")).rejects.toMatchObject({ status: 400 });
  });

  it("returns null and warns when the repository field is missing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    setOctokit(buildMockOctokit({ repository: null }));

    expect(await collectDeployments("owner", "repo")).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("empty response"));
  });

  it("returns [] for a repo with no deployments or releases", async () => {
    setOctokit(buildMockOctokit(makeResponse({})));

    const result = await collectDeployments("owner", "repo");
    expect(result).toEqual([]);
  });
});
