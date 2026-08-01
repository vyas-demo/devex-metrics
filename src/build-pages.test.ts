import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { JSDOM } from "jsdom";
import { CURRENT_SCHEMA_VERSION } from "./cache.js";
import { HISTORY_SCHEMA_VERSION } from "./history.js";
import type { CacheEnvelope } from "./types.js";

describe("build-pages", () => {
  const dataDir = path.resolve(process.cwd(), "data");
  const siteDir = path.resolve(process.cwd(), "_site");
  const cacheFile = path.join(dataDir, "test-pages-owner.json");

  beforeEach(() => {
    fs.mkdirSync(dataDir, { recursive: true });
    const envelope: CacheEnvelope = {
      date: "2026-03-28",
      data: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        owner: "test-pages-owner",
        ownerType: "org",
        collectedAt: "2026-03-28T12:00:00Z",
        repoCount: 1,
        repos: [
          {
            name: "repo-a",
            fullName: "test-pages-owner/repo-a",
            issues: { open: 2, closed: 5 },
            pullRequests: { open: 1, closed: 0, merged: 3 },
            pullRequestDetails: [],
            committerCount: 2,
            reviewerCount: 1,
            contributorCount: 3,
            dependentCount: 0,
          },
        ],
      },
    };
    fs.writeFileSync(cacheFile, JSON.stringify(envelope));
  });

  afterEach(() => {
    if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
    if (fs.existsSync(siteDir)) {
      fs.rmSync(siteDir, { recursive: true });
    }
  });

  it("should generate an HTML index page", () => {
    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const indexPath = path.join(siteDir, "index.html");
    expect(fs.existsSync(indexPath)).toBe(true);
    const html = fs.readFileSync(indexPath, "utf-8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("test-pages-owner");
    expect(html).toContain("DevEx Metrics");
    expect(html).not.toContain("github-corner");
    expect(html).not.toContain("View source on GitHub");
  });

  it("should escape chart data for the inline script context", () => {
    const envelope = JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as CacheEnvelope;
    const hostileName = '</script><script id="injected">window.injected=true</script>';
    envelope.data.repos[0].name = hostileName;
    envelope.data.repos[0].fullName = `test-pages-owner/${hostileName}`;
    fs.writeFileSync(cacheFile, JSON.stringify(envelope));

    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");
    const payloadMatch = html.match(/var CHART_DATA=(.*);\n/);

    expect(payloadMatch).not.toBeNull();
    expect(payloadMatch?.[1]).not.toContain("</script>");
    expect(payloadMatch?.[1]).toContain("\\u003c/script\\u003e");
    expect(JSON.parse(payloadMatch?.[1] ?? "{}").repoNames).toContain(hostileName);
    expect(new JSDOM(html).window.document.getElementById("injected")).toBeNull();
  });

  it("should generate a data.json file", () => {
    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const dataPath = path.join(siteDir, "data.json");
    expect(fs.existsSync(dataPath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
    expect(data.owner).toBe("test-pages-owner");
    expect(data.repoCount).toBe(1);
  });

  it("should generate a report.md file", () => {
    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const mdPath = path.join(siteDir, "report.md");
    expect(fs.existsSync(mdPath)).toBe(true);
    const md = fs.readFileSync(mdPath, "utf-8");
    expect(md).toContain("# DevEx Metrics");
  });

  it("should include branch and workflow run link in footer when env vars are set", () => {
    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GITHUB_REF_NAME: "main",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "test-org/test-repo",
        GITHUB_RUN_ID: "12345",
      },
    });
    const html = fs.readFileSync(
      path.join(siteDir, "index.html"),
      "utf-8"
    );
    expect(html).toContain("Deployed from branch");
    expect(html).toContain("main");
    expect(html).toContain(
      "https://github.com/test-org/test-repo/actions/runs/12345"
    );
    expect(html).toContain("workflow run");
  });

  it("should not include deployment info in footer when env vars are absent", () => {
    const env = { ...process.env };
    delete env.GITHUB_REF_NAME;
    delete env.GITHUB_SERVER_URL;
    delete env.GITHUB_REPOSITORY;
    delete env.GITHUB_RUN_ID;

    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
      env,
    });
    const html = fs.readFileSync(
      path.join(siteDir, "index.html"),
      "utf-8"
    );
    expect(html).not.toContain("Deployed from branch");
    expect(html).not.toContain("workflow run");
  });

  it("should embed setupGroups and computeAge in the JS", () => {
    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");
    expect(html).toContain("setupGroups");
    expect(html).toContain("computeAge");
    expect(html).toContain("utcDaysSince");
    expect(html).toContain("grp-month");
    expect(html).toContain("grp-older");
  });

  it("should include data-pushed attribute on repo cards", () => {
    const envelope: CacheEnvelope = {
      date: "2026-03-28",
      data: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        owner: "test-pages-owner",
        ownerType: "org",
        collectedAt: "2026-03-28T12:00:00Z",
        repoCount: 1,
        repos: [
          {
            name: "repo-a",
            fullName: "test-pages-owner/repo-a",
            pushedAt: "2025-01-15T10:00:00Z",
            issues: { open: 2, closed: 5 },
            pullRequests: { open: 1, closed: 0, merged: 3 },
            pullRequestDetails: [],
            committerCount: 2,
            reviewerCount: 1,
            contributorCount: 3,
            dependentCount: 0,
          },
        ],
      },
    };
    fs.writeFileSync(cacheFile, JSON.stringify(envelope));

    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");
    expect(html).toContain('data-pushed="2025-01-15T10:00:00Z"');
    expect(html).toContain("bdg-age");
  });

  it("should include Merged column in PR table and sort PRs descending by mergedAt", () => {
    const envelope: CacheEnvelope = {
      date: "2026-03-28",
      data: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        owner: "test-pages-owner",
        ownerType: "org",
        collectedAt: "2026-03-28T12:00:00Z",
        repoCount: 1,
        repos: [
          {
            name: "repo-a",
            fullName: "test-pages-owner/repo-a",
            pushedAt: "2026-03-20T10:00:00Z",
            issues: { open: 2, closed: 5 },
            pullRequests: { open: 1, closed: 0, merged: 3 },
            pullRequestDetails: [
              {
                number: 10,
                title: "Older PR",
                state: "merged",
                mergedAt: "2026-01-01T00:00:00Z",
                linesAdded: 10,
                linesDeleted: 5,
                commentCount: 1,
                commitCount: 1,
                actionsMinutes: 1,
              },
              {
                number: 20,
                title: "Newer PR",
                state: "merged",
                mergedAt: "2026-03-01T00:00:00Z",
                linesAdded: 20,
                linesDeleted: 2,
                commentCount: 2,
                commitCount: 2,
                actionsMinutes: 2,
              },
            ],
            committerCount: 2,
            reviewerCount: 1,
            contributorCount: 3,
            dependentCount: 0,
          },
        ],
      },
    };
    fs.writeFileSync(cacheFile, JSON.stringify(envelope));

    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");
    expect(html).toContain("<th>Merged</th>");
    expect(html).toContain("2026-03-01");
    expect(html).toContain("2026-01-01");
    // Newer PR (#20) should appear before older PR (#10) in the HTML
    const pos20 = html.indexOf("#20 Newer PR");
    const pos10 = html.indexOf("#10 Older PR");
    expect(pos20).toBeLessThan(pos10);
  });

  it("should render trend chart canvases when weeklyTrends data is present", () => {
    // Re-write the cache file with weeklyTrends data
    const envelopeWithTrends: CacheEnvelope = {
      date: "2026-03-28",
      data: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        owner: "test-pages-owner",
        ownerType: "org",
        collectedAt: "2026-03-28T12:00:00Z",
        repoCount: 1,
        repos: [
          {
            name: "repo-a",
            fullName: "test-pages-owner/repo-a",
            issues: { open: 2, closed: 5 },
            pullRequests: { open: 1, closed: 0, merged: 3 },
            pullRequestDetails: [],
            committerCount: 2,
            reviewerCount: 1,
            contributorCount: 3,
            dependentCount: 0,
          },
        ],
        weeklyTrends: [
          { week: "2026-W11", prsOpened: 1, prsMerged: 1, issuesOpened: 2, issuesClosed: 1, linesAdded: 200, linesDeleted: 50 },
        ],
      },
    };
    fs.writeFileSync(cacheFile, JSON.stringify(envelopeWithTrends));

    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");
    expect(html).toContain('id="chartPRTrends"');
    expect(html).toContain('id="chartIssueTrends"');
    expect(html).toContain('id="chartPRSizeTrends"');
    expect(html).toContain("PR Trends");
    expect(html).toContain("Issue Trends");
    expect(html).toContain("PR Size Trends");
  });

  it("should default the Last 30 Days filter button as active", () => {
    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");
    // Last 30 Days button should be active, All Time should not
    expect(html).toContain('class="filter-btn active" data-period="30days"');
    expect(html).not.toContain('class="filter-btn active" data-period="all"');
  });

  it("should call applyFilter on DOMContentLoaded with 30days default", () => {
    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");
    expect(html).toContain('applyFilter("30days")');
  });

  it("should include KPI element IDs for dynamic filter updates", () => {
    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");
    expect(html).toContain('id="kpiIssueVal"');
    expect(html).toContain('id="kpiIssueLbl"');
    expect(html).toContain('id="kpiIssueSub"');
    expect(html).toContain('id="kpiPRVal"');
    expect(html).toContain('id="kpiPRLbl"');
    expect(html).toContain('id="kpiPRSub"');
    expect(html).toContain("Developer Insights");
    expect(html).toContain('id="insightVelocityVal"');
    expect(html).toContain('id="insightPrFlowVal"');
    expect(html).toContain('id="insightIssueFlowVal"');
    expect(html).toContain('id="insightCyclePredictabilityVal"');
    expect(html).toContain('id="insightLeadTimeVal"');
    expect(html).toContain('id="insightPrSizeVal"');
  });

  it("should build successfully without trend charts when weeklyTrends is absent", () => {
    // The beforeEach fixture has no weeklyTrends — build-pages must not crash.
    expect(() =>
      execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
        cwd: process.cwd(),
      })
    ).not.toThrow();
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");
    expect(html).toContain("<!DOCTYPE html>");
    // Trend canvases are still in the HTML (always rendered); Chart.js guards
    // the actual rendering in JS when weeklyTrends is empty.
    expect(html).toContain('id="chartPRTrends"');
    expect(html).toContain('id="chartIssueTrends"');
    expect(html).toContain('id="chartPRSizeTrends"');
  });

  it("sums per-repo Lines +/- across the full mergedPRTimeline, not just the 10 detailed PRs", () => {
    const envelope: CacheEnvelope = {
      date: "2026-03-28",
      data: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        owner: "test-pages-owner",
        ownerType: "org",
        collectedAt: "2026-03-28T12:00:00Z",
        repoCount: 1,
        repos: [
          {
            name: "repo-a",
            fullName: "test-pages-owner/repo-a",
            issues: { open: 0, closed: 0 },
            pullRequests: { open: 0, closed: 0, merged: 5 },
            pullRequestDetails: [
              {
                number: 1,
                title: "Latest",
                state: "merged",
                createdAt: "2026-03-01T00:00:00Z",
                author: "alice",
                isCopilotAuthored: false,
                hasCopilotReview: false,
                mergedAt: "2026-03-02T00:00:00Z",
                linesAdded: 100,
                linesDeleted: 10,
                commentCount: 0,
                commitCount: 1,
                actionsMinutes: 0,
              },
            ],
            mergedPRTimeline: [
              { number: 1, createdAt: "2026-03-01T00:00:00Z", mergedAt: "2026-03-02T00:00:00Z", author: "alice", isBotAuthor: false, isCopilotAuthored: false, timeToMergeHours: 24, closesIssues: [], linesAdded: 100, linesDeleted: 10 },
              { number: 2, createdAt: "2026-02-01T00:00:00Z", mergedAt: "2026-02-02T00:00:00Z", author: "alice", isBotAuthor: false, isCopilotAuthored: false, timeToMergeHours: 24, closesIssues: [], linesAdded: 200, linesDeleted: 20 },
              { number: 3, createdAt: "2026-01-01T00:00:00Z", mergedAt: "2026-01-02T00:00:00Z", author: "alice", isBotAuthor: false, isCopilotAuthored: false, timeToMergeHours: 24, closesIssues: [], linesAdded: 300, linesDeleted: 30 },
            ],
            committerCount: 1,
            reviewerCount: 0,
            contributorCount: 1,
            dependentCount: 0,
          },
        ],
      },
    };
    fs.writeFileSync(cacheFile, JSON.stringify(envelope));
    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");
    // Sum across timeline: 100+200+300 added, 10+20+30 deleted.
    expect(html).toContain('data-lines-added="600"');
    expect(html).toContain('data-lines-deleted="60"');
  });

  it("falls back to pullRequestDetails for Lines +/- when timeline lacks line counts", () => {
    const envelope: CacheEnvelope = {
      date: "2026-03-28",
      data: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        owner: "test-pages-owner",
        ownerType: "org",
        collectedAt: "2026-03-28T12:00:00Z",
        repoCount: 1,
        repos: [
          {
            name: "repo-a",
            fullName: "test-pages-owner/repo-a",
            issues: { open: 0, closed: 0 },
            pullRequests: { open: 0, closed: 0, merged: 1 },
            pullRequestDetails: [
              {
                number: 1, title: "x", state: "merged",
                createdAt: "2026-03-01T00:00:00Z", author: "a",
                isCopilotAuthored: false, hasCopilotReview: false,
                mergedAt: "2026-03-02T00:00:00Z",
                linesAdded: 42, linesDeleted: 7,
                commentCount: 0, commitCount: 1, actionsMinutes: 0,
              },
            ],
            // Timeline present but without linesAdded/linesDeleted (REST fallback)
            mergedPRTimeline: [
              { number: 1, createdAt: "2026-03-01T00:00:00Z", mergedAt: "2026-03-02T00:00:00Z", author: "a", isBotAuthor: false, isCopilotAuthored: false, timeToMergeHours: 24, closesIssues: [] },
            ],
            committerCount: 1, reviewerCount: 0, contributorCount: 1, dependentCount: 0,
          },
        ],
      },
    };
    fs.writeFileSync(cacheFile, JSON.stringify(envelope));
    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");
    expect(html).toContain('data-lines-added="42"');
    expect(html).toContain('data-lines-deleted="7"');
  });

  it("normalizes missing linesAdded/linesDeleted to 0 for old cached data", () => {
    // Simulate old cached data where weeklyTrends lacks the new fields
    const oldEnvelope: CacheEnvelope = {
      date: "2026-03-28",
      data: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        owner: "test-pages-owner",
        ownerType: "org",
        collectedAt: "2026-03-28T12:00:00Z",
        repoCount: 1,
        repos: [
          {
            name: "repo-a",
            fullName: "test-pages-owner/repo-a",
            issues: { open: 1, closed: 2 },
            pullRequests: { open: 0, closed: 0, merged: 1 },
            pullRequestDetails: [],
            committerCount: 1,
            reviewerCount: 0,
            contributorCount: 1,
            dependentCount: 0,
          },
        ],
        weeklyTrends: [
          { week: "2026-W10", prsOpened: 2, prsMerged: 1, issuesOpened: 3, issuesClosed: 2 } as unknown as import("./types.js").WeeklyTrendPoint,
        ],
      },
    };
    fs.writeFileSync(cacheFile, JSON.stringify(oldEnvelope));

    expect(() =>
      execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
        cwd: process.cwd(),
      })
    ).not.toThrow();

    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");
    // Normalized values should appear as 0 in the chart payload
    expect(html).toContain('"linesAdded":0');
    expect(html).toContain('"linesDeleted":0');
  });

  it("detail rows survive sort/filter — accordion opens after sorting", () => {
    // Regression: filterAndSort removed detail rows from the DOM and then called
    // document.getElementById() to find them — but detached nodes can't be found
    // that way, so the detail rows were permanently lost after the first sort.
    const envelope: CacheEnvelope = {
      date: "2026-03-28",
      data: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        owner: "test-pages-owner",
        ownerType: "org",
        collectedAt: "2026-03-28T12:00:00Z",
        repoCount: 2,
        repos: [
          {
            name: "repo-a",
            fullName: "test-pages-owner/repo-a",
            pushedAt: "2026-03-27T10:00:00Z",
            issues: { open: 5, closed: 3 },
            pullRequests: { open: 2, closed: 0, merged: 4 },
            pullRequestDetails: [],
            committerCount: 3,
            reviewerCount: 2,
            contributorCount: 4,
            dependentCount: 1,
          },
          {
            name: "repo-b",
            fullName: "test-pages-owner/repo-b",
            pushedAt: "2026-03-26T10:00:00Z",
            issues: { open: 1, closed: 8 },
            pullRequests: { open: 0, closed: 1, merged: 2 },
            pullRequestDetails: [],
            committerCount: 1,
            reviewerCount: 0,
            contributorCount: 1,
            dependentCount: 0,
          },
        ],
      },
    };
    fs.writeFileSync(cacheFile, JSON.stringify(envelope));

    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");

    const dom = new JSDOM(html, { runScripts: "dangerously" });
    const { window } = dom;
    const document = window.document;

    // Fire DOMContentLoaded so setupGroups / setupControls run
    document.dispatchEvent(new window.Event("DOMContentLoaded"));

    // Simulate a sort by changing the select value and dispatching "change"
    const sortSelect = document.getElementById("repoSort") as HTMLSelectElement;
    expect(sortSelect).not.toBeNull();
    sortSelect.value = "openIssues";
    sortSelect.dispatchEvent(new window.Event("change"));

    // After sort, every detail row should still be in the document
    const dataRows = Array.from(
      document.querySelectorAll<HTMLElement>("tr.repo-row")
    );
    expect(dataRows.length).toBe(2);

    for (const row of dataRows) {
      const repoId = row.dataset.repoId!;
      const detailRow = document.getElementById(`detail-${repoId}`);
      expect(detailRow).not.toBeNull();

      // Simulate clicking the expand button
      const btn = row.querySelector<HTMLElement>(".repo-expand-btn");
      expect(btn).not.toBeNull();
      btn!.click();

      // Detail row should now be visible (hidden removed, no display:none)
      expect(detailRow!.hidden).toBe(false);
      expect(detailRow!.style.display).not.toBe("none");
    }
  });

  it("should fall back to fixture file when no daily cache is present", () => {
    const fixtureFile = path.join(dataDir, "test-pages-owner.fixture.json");
    // Remove the daily cache so only the fixture is available
    if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
    try {
      const fixtureData = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        owner: "test-pages-owner",
        ownerType: "org",
        collectedAt: "2026-03-28T08:00:00Z",
        repoCount: 1,
        repos: [
          {
            name: "fixture-repo",
            fullName: "test-pages-owner/fixture-repo",
            issues: { open: 1, closed: 2 },
            pullRequests: { open: 0, closed: 0, merged: 1 },
            pullRequestDetails: [],
            committerCount: 1,
            reviewerCount: 0,
            contributorCount: 1,
            dependentCount: 0,
          },
        ],
      };
      fs.writeFileSync(fixtureFile, JSON.stringify(fixtureData));

      execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
        cwd: process.cwd(),
      });

      const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");
      expect(html).toContain("test-pages-owner");
      expect(html).toContain("fixture-repo");
    } finally {
      if (fs.existsSync(fixtureFile)) fs.unlinkSync(fixtureFile);
    }
  });

  it("should exit with error when fixture has a stale schema version", () => {
    const fixtureFile = path.join(dataDir, "test-pages-owner.fixture.json");
    if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
    try {
      const staleFixture = {
        schemaVersion: 1,
        owner: "test-pages-owner",
        ownerType: "org",
        collectedAt: "2026-03-28T08:00:00Z",
        repoCount: 1,
        repos: [],
      };
      fs.writeFileSync(fixtureFile, JSON.stringify(staleFixture));

      expect(() =>
        execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
          cwd: process.cwd(),
        })
      ).toThrow();
    } finally {
      if (fs.existsSync(fixtureFile)) fs.unlinkSync(fixtureFile);
    }
  });

  it("should exit with error when cache file has a stale schema version", () => {
    const staleEnvelope = {
      date: "2026-03-28",
      data: {
        schemaVersion: 1,
        owner: "test-pages-owner",
        ownerType: "org",
        collectedAt: "2026-03-28T12:00:00Z",
        repoCount: 0,
        repos: [],
      },
    };
    fs.writeFileSync(cacheFile, JSON.stringify(staleEnvelope));

    expect(() =>
      execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
        cwd: process.cwd(),
      })
    ).toThrow();
  });

  it("should initialise KPI panels with 30-day values to prevent load-time flicker", () => {
    // collectedAt = 2026-04-01T12:00:00Z → 30d cutoff = 2026-03-02T12:00:00Z
    // W09 Monday = 2026-02-23 → before cutoff (excluded)
    // W11 Monday = 2026-03-09 → after cutoff (included)
    // W13 Monday = 2026-03-23 → after cutoff (included)
    const envelope: CacheEnvelope = {
      date: "2026-04-01",
      data: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        owner: "test-pages-owner",
        ownerType: "org",
        collectedAt: "2026-04-01T12:00:00Z",
        repoCount: 1,
        repos: [
          {
            name: "repo-a",
            fullName: "test-pages-owner/repo-a",
            // All-time totals deliberately differ from 30d values
            issues: { open: 15, closed: 20 },
            pullRequests: { open: 3, closed: 2, merged: 10 },
            pullRequestDetails: [],
            mergedPRTimeline: [
              // Before cutoff — must NOT appear in 30d KPIs
              { number: 1, createdAt: "2026-01-14T00:00:00Z", mergedAt: "2026-01-15T00:00:00Z", author: "dev", isBotAuthor: false, isCopilotAuthored: false, timeToMergeHours: 100, closesIssues: [] },
              // After cutoff — must appear in 30d KPIs
              { number: 2, createdAt: "2026-03-14T00:00:00Z", mergedAt: "2026-03-15T00:00:00Z", author: "dev", isBotAuthor: false, isCopilotAuthored: false, timeToMergeHours: 24, closesIssues: [] },
              { number: 3, createdAt: "2026-03-24T00:00:00Z", mergedAt: "2026-03-25T00:00:00Z", author: "dev", isBotAuthor: false, isCopilotAuthored: false, timeToMergeHours: 48, closesIssues: [] },
            ],
            committerCount: 2,
            reviewerCount: 1,
            contributorCount: 3,
            dependentCount: 0,
          },
        ],
        weeklyTrends: [
          // Excluded (before cutoff)
          { week: "2026-W09", prsOpened: 5, prsMerged: 4, issuesOpened: 10, issuesClosed: 8, linesAdded: 100, linesDeleted: 40 },
          // Included (after cutoff): issuesOpened=5, issuesClosed=3, prsOpened=4
          { week: "2026-W11", prsOpened: 4, prsMerged: 3, issuesOpened: 5, issuesClosed: 3, linesAdded: 80, linesDeleted: 20 },
          // Included: issuesOpened=3, issuesClosed=2, prsOpened=2
          { week: "2026-W13", prsOpened: 2, prsMerged: 2, issuesOpened: 3, issuesClosed: 2, linesAdded: 50, linesDeleted: 10 },
        ],
      },
    };
    fs.writeFileSync(cacheFile, JSON.stringify(envelope));

    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");

    // Parse without running JS to check the server-rendered initial values
    const dom = new JSDOM(html);
    const document = dom.window.document;

    // 30d issuesOpened = 5 + 3 = 8; issuesClosed = 3 + 2 = 5
    expect(document.getElementById("kpiIssueVal")?.textContent).toBe("8");
    expect(document.getElementById("kpiIssueLbl")?.textContent).toBe("Issues Opened");
    expect(document.getElementById("kpiIssueSub")?.textContent).toBe("5 closed");

    // 30d prsMerged = 2 (PR#2 and PR#3); prsOpened = 4 + 2 = 6
    expect(document.getElementById("kpiPRVal")?.textContent).toBe("2");
    expect(document.getElementById("kpiPRSub")?.textContent).toBe("6 opened");

    // 30d cycle time: median([24, 48]) = 36h → formats as "1.5days" (36 ≥ 24h)
    expect(document.getElementById("kpiCycleVal")?.textContent).toBe("1.5days");

    // Sanity-check: all-time values must NOT appear in these elements
    expect(document.getElementById("kpiIssueVal")?.textContent).not.toBe("15");
    expect(document.getElementById("kpiPRVal")?.textContent).not.toBe("10");
  });

  it("should include repoWeeklyTrends in the CHART_DATA payload when repos have per-repo trends", () => {
    const envelope: CacheEnvelope = {
      date: "2026-03-28",
      data: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        owner: "test-pages-owner",
        ownerType: "org",
        collectedAt: "2026-03-28T12:00:00Z",
        repoCount: 1,
        repos: [
          {
            name: "repo-a",
            fullName: "test-pages-owner/repo-a",
            issues: { open: 2, closed: 5 },
            pullRequests: { open: 1, closed: 0, merged: 3 },
            pullRequestDetails: [],
            committerCount: 2,
            reviewerCount: 1,
            contributorCount: 3,
            dependentCount: 0,
            weeklyTrends: [
              { week: "2026-W12", prsOpened: 1, prsMerged: 1, issuesOpened: 4, issuesClosed: 2, linesAdded: 20, linesDeleted: 5 },
            ],
          },
        ],
      },
    };
    fs.writeFileSync(cacheFile, JSON.stringify(envelope));

    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");

    // repoWeeklyTrends should be embedded in the payload with all trend fields
    expect(html).toContain('"repoWeeklyTrends"');
    expect(html).toContain('"repo-a"');
    expect(html).toContain('"issuesOpened":4');
    expect(html).toContain('"issuesClosed":2');
    // PR and line data should also appear in the repo trend payload so the
    // "Opened" dataset can be shown when a single repo is selected.
    expect(html).toContain('"prsOpened":1');
    expect(html).toContain('"prsMerged":1');
    expect(html).toContain('"linesAdded":20');
    expect(html).toContain('"linesDeleted":5');
    const dom = new JSDOM(html);
    expect(dom.window.document.querySelector(".trends-org-note")).toBeNull();
  });

  it("should render Agent Tasks KPI card and chart canvases", () => {
    const envelope: CacheEnvelope = {
      date: "2026-03-28",
      data: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        owner: "test-pages-owner",
        ownerType: "org",
        collectedAt: "2026-03-28T12:00:00Z",
        repoCount: 1,
        repos: [
          {
            name: "repo-a",
            fullName: "test-pages-owner/repo-a",
            issues: { open: 2, closed: 5 },
            pullRequests: { open: 1, closed: 0, merged: 3 },
            pullRequestDetails: [],
            committerCount: 2,
            reviewerCount: 1,
            contributorCount: 3,
            dependentCount: 0,
            copilotAgentMetrics: {
              totalTasks: 5,
              completedTasks: 3,
              failedTasks: 1,
              cancelledTasks: 0,
              timedOutTasks: 0,
              activeTasksCount: 1,
              totalSessions: 8,
              cloudAgentSessions: 6,
              cliRemoteSessions: 2,
              totalCreditsUsed: 12.5,
              avgCompletedSessionHours: 0.75,
              agentCreatedPRs: 3,
            },
          },
        ],
      },
    };
    fs.writeFileSync(cacheFile, JSON.stringify(envelope));

    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");

    // KPI card elements
    expect(html).toContain('id="kpiAgentVal"');
    expect(html).toContain('id="kpiAgentSub"');
    expect(html).toContain("Agent Tasks (30d)");
    // KPI should show total task count and summary
    expect(html).toContain(">5<");
    expect(html).toContain("3 completed");
    expect(html).toContain("3 PRs");

    // New chart canvases
    expect(html).toContain('id="chartCopilotPRTrend"');
    expect(html).toContain('id="chartAgentTasks"');
    expect(html).toContain("Copilot-authored PRs merged per week");
    expect(html).toContain("Agent Tasks by Repository");
  });

  it("should render Copilot usage KPI, charts, and per-user table", () => {
    const envelope: CacheEnvelope = {
      date: "2026-04-29",
      data: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        owner: "test-pages-owner",
        ownerType: "org",
        collectedAt: "2026-04-29T12:00:00Z",
        repoCount: 1,
        repos: [
          {
            name: "repo-a",
            fullName: "test-pages-owner/repo-a",
            issues: { open: 0, closed: 0 },
            pullRequests: { open: 0, closed: 0, merged: 0 },
            pullRequestDetails: [],
            committerCount: 1,
            reviewerCount: 1,
            contributorCount: 1,
            dependentCount: 0,
          },
        ],
        copilotUsage: {
          scope: "organization",
          scopeName: "test-pages-owner",
          reportStartDay: "2026-04-01",
          reportEndDay: "2026-04-28",
          collectedAt: "2026-04-29T00:00:00Z",
          totals: {
            totalUsers: 2,
            activeUsers: 1,
            chatUsers: 1,
            agentUsers: 1,
            cliUsers: 0,
            codeReviewActiveUsers: 0,
            codeReviewPassiveUsers: 0,
            assignedSeats: 2,
            seatsActiveThisCycle: 1,
            userInitiatedInteractions: 12,
            codeGenerations: 8,
            codeAcceptances: 4,
            locSuggestedToAdd: 40,
            locSuggestedToDelete: 2,
            locAdded: 25,
            locDeleted: 1,
            acceptanceRate: 50,
          },
          billing: {
            assignedSeats: 2,
            addedThisCycle: 1,
            pendingInvitation: 0,
            pendingCancellation: 0,
            activeThisCycle: 1,
            inactiveThisCycle: 1,
            seatManagementSetting: "assign_selected",
            ideChat: "enabled",
            platformChat: "enabled",
            cli: "enabled",
            publicCodeSuggestions: "block",
            planType: "business",
          },
          cli: {
            sessionCount: 1,
            requestCount: 3,
            promptCount: 2,
            promptTokens: 100,
            outputTokens: 300,
            avgTokensPerRequest: 133.33,
            lastKnownCliVersion: "1.0.8",
          },
          pullRequests: {
            totalCreated: 2,
            totalReviewed: 1,
            totalMerged: 1,
            medianMinutesToMerge: 90,
            totalSuggestions: 2,
            totalAppliedSuggestions: 1,
            totalCreatedByCopilot: 1,
            totalReviewedByCopilot: 1,
            totalMergedCreatedByCopilot: 1,
            totalMergedReviewedByCopilot: 1,
            medianMinutesToMergeCopilotAuthored: 90,
            medianMinutesToMergeCopilotReviewed: 90,
            totalCopilotSuggestions: 2,
            totalCopilotAppliedSuggestions: 1,
            copilotSuggestionsByCommentType: [
              { commentType: "bug_risk", totalCopilotSuggestions: 2, totalCopilotAppliedSuggestions: 1 },
            ],
          },
          codeReview: {
            dailyActiveUsers: 1,
            dailyPassiveUsers: 0,
            weeklyActiveUsers: 1,
            weeklyPassiveUsers: 0,
            monthlyActiveUsers: 1,
            monthlyPassiveUsers: 0,
          },
          repositoryReport: {
            reportDay: "2026-04-28",
            repositories: [
              {
                day: "2026-04-28",
                organizationId: "10",
                repoId: "101",
                owner: "test-pages-owner",
                name: "repo-a",
                fullName: "test-pages-owner/repo-a",
                visibility: "PRIVATE",
                pullRequests: {
                  totalCreated: 3,
                  totalReviewed: 2,
                  totalMerged: 2,
                  medianMinutesToMerge: null,
                  totalSuggestions: 3,
                  totalAppliedSuggestions: 2,
                  totalCreatedByCopilot: 2,
                  totalReviewedByCopilot: 1,
                  totalMergedCreatedByCopilot: 1,
                  totalMergedReviewedByCopilot: 1,
                  medianMinutesToMergeCopilotAuthored: 60,
                  medianMinutesToMergeCopilotReviewed: 80,
                  totalCopilotSuggestions: 3,
                  totalCopilotAppliedSuggestions: 2,
                  copilotSuggestionsByCommentType: [],
                },
              },
            ],
          },
          users: [
            {
              login: "alice",
              userId: "1",
              activeDays: 2,
              lastUsageDay: "2026-04-28",
              aiAdoptionPhase: { phaseNumber: 3, phase: "Phase 3", version: "2026-07" },
              teams: ["platform"],
              usedChat: true,
              usedAgent: true,
              usedCli: false,
              usedCodeReviewActive: false,
              usedCodeReviewPassive: false,
              cli: undefined,
              lastKnownIdeVersion: "1.104.0",
              lastKnownPluginVersion: "0.31.0",
              lastActivityAt: "2026-04-28T10:00:00Z",
              lastActivityEditor: "vscode",
              userInitiatedInteractions: 12,
              codeGenerations: 8,
              codeAcceptances: 4,
              locSuggestedToAdd: 40,
              locSuggestedToDelete: 2,
              locAdded: 25,
              locDeleted: 1,
              acceptanceRate: 50,
            },
            {
              login: "bob",
              activeDays: 0,
              teams: [],
              usedChat: false,
              usedAgent: false,
              usedCli: false,
              usedCodeReviewActive: false,
              usedCodeReviewPassive: false,
              userInitiatedInteractions: 0,
              codeGenerations: 0,
              codeAcceptances: 0,
              locSuggestedToAdd: 0,
              locSuggestedToDelete: 0,
              locAdded: 0,
              locDeleted: 0,
              acceptanceRate: 0,
            },
          ],
          dailyTotals: [
            {
              day: "2026-04-28",
              dailyActiveUsers: 1,
              weeklyActiveUsers: 1,
              monthlyActiveUsers: 1,
              dailyActiveCliUsers: 0,
              dailyActiveChatUsers: 1,
              dailyActiveAgentUsers: 1,
              weeklyActiveChatUsers: 1,
              weeklyActiveAgentUsers: 1,
              monthlyActiveChatUsers: 1,
              monthlyActiveAgentUsers: 1,
              codeReview: {
                dailyActiveUsers: 1,
                dailyPassiveUsers: 0,
                weeklyActiveUsers: 1,
                weeklyPassiveUsers: 0,
                monthlyActiveUsers: 1,
                monthlyPassiveUsers: 0,
              },
              cli: {
                sessionCount: 1,
                requestCount: 3,
                promptCount: 2,
                promptTokens: 100,
                outputTokens: 300,
                avgTokensPerRequest: 133.33,
              },
              pullRequests: {
                totalCreated: 2,
                totalReviewed: 1,
                totalMerged: 1,
                medianMinutesToMerge: 90,
                totalSuggestions: 2,
                totalAppliedSuggestions: 1,
                totalCreatedByCopilot: 1,
                totalReviewedByCopilot: 1,
                totalMergedCreatedByCopilot: 1,
                totalMergedReviewedByCopilot: 1,
                medianMinutesToMergeCopilotAuthored: 90,
                medianMinutesToMergeCopilotReviewed: 90,
                totalCopilotSuggestions: 2,
                totalCopilotAppliedSuggestions: 1,
                copilotSuggestionsByCommentType: [
                  { commentType: "bug_risk", totalCopilotSuggestions: 2, totalCopilotAppliedSuggestions: 1 },
                ],
              },
              aiAdoptionPhases: [
                {
                  phaseNumber: 0,
                  phase: "No Cohort",
                  totalEngagedUsers: 1,
                  avgUserInitiatedInteractions: 0,
                  avgCodeGenerationActivities: 0,
                  avgCodeAcceptanceActivities: 0,
                  avgLocAdded: 0,
                  avgLocDeleted: 0,
                  avgPullRequestsReviewed: 1,
                  avgPullRequestsCreated: 1,
                  avgPullRequestsMerged: 1,
                  totalPullRequestsMerged: 1,
                  avgPullRequestsMedianMinutesToMerge: 120,
                },
                {
                  phaseNumber: 3,
                  phase: "Phase 3",
                  totalEngagedUsers: 1,
                  avgUserInitiatedInteractions: 12,
                  avgCodeGenerationActivities: 8,
                  avgCodeAcceptanceActivities: 4,
                  avgLocAdded: 25,
                  avgLocDeleted: 1,
                  avgPullRequestsReviewed: 3,
                  avgPullRequestsCreated: 3,
                  avgPullRequestsMerged: 3,
                  totalPullRequestsMerged: 3,
                  avgPullRequestsMedianMinutesToMerge: 60,
                },
              ],
              userInitiatedInteractions: 12,
              codeGenerations: 8,
              codeAcceptances: 4,
              locSuggestedToAdd: 40,
              locSuggestedToDelete: 2,
              locAdded: 25,
              locDeleted: 1,
              acceptanceRate: 50,
            },
          ],
          byFeature: [
            {
              name: "chat",
              users: 1,
              userInitiatedInteractions: 12,
              codeGenerations: 8,
              codeAcceptances: 4,
              locSuggestedToAdd: 40,
              locSuggestedToDelete: 2,
              locAdded: 25,
              locDeleted: 1,
              acceptanceRate: 50,
            },
          ],
          byIde: [
            { name: "vscode", users: 1, ide: "vscode", userInitiatedInteractions: 12, codeGenerations: 8, codeAcceptances: 4, locSuggestedToAdd: 40, locSuggestedToDelete: 2, locAdded: 25, locDeleted: 1, acceptanceRate: 50 },
          ],
          byLanguage: [
            { name: "typescript", users: 1, language: "typescript", userInitiatedInteractions: 12, codeGenerations: 8, codeAcceptances: 4, locSuggestedToAdd: 40, locSuggestedToDelete: 2, locAdded: 25, locDeleted: 1, acceptanceRate: 50 },
          ],
          byModel: [
            { name: "gpt-5.4", users: 1, model: "gpt-5.4", isCustomModel: false, userInitiatedInteractions: 12, codeGenerations: 8, codeAcceptances: 4, locSuggestedToAdd: 40, locSuggestedToDelete: 2, locAdded: 25, locDeleted: 1, acceptanceRate: 50 },
          ],
          byTeam: [
            { name: "platform", users: 1, userInitiatedInteractions: 12, codeGenerations: 8, codeAcceptances: 4, locSuggestedToAdd: 40, locSuggestedToDelete: 2, locAdded: 25, locDeleted: 1, acceptanceRate: 50 },
          ],
          byLanguageFeature: [
            { name: "typescript / chat_panel_agent_mode", users: 1, language: "typescript", feature: "chat_panel_agent_mode", userInitiatedInteractions: 12, codeGenerations: 8, codeAcceptances: 4, locSuggestedToAdd: 40, locSuggestedToDelete: 2, locAdded: 25, locDeleted: 1, acceptanceRate: 50 },
          ],
          byLanguageModel: [
            { name: "typescript / gpt-5.4", users: 1, language: "typescript", model: "gpt-5.4", isCustomModel: false, userInitiatedInteractions: 12, codeGenerations: 8, codeAcceptances: 4, locSuggestedToAdd: 40, locSuggestedToDelete: 2, locAdded: 25, locDeleted: 1, acceptanceRate: 50 },
          ],
          byModelFeature: [
            { name: "gpt-5.4 / chat_panel_agent_mode", users: 1, model: "gpt-5.4", feature: "chat_panel_agent_mode", isCustomModel: false, userInitiatedInteractions: 12, codeGenerations: 8, codeAcceptances: 4, locSuggestedToAdd: 40, locSuggestedToDelete: 2, locAdded: 25, locDeleted: 1, acceptanceRate: 50 },
          ],
          ideVersions: [
            { ide: "vscode", ideVersion: "1.104.0", plugin: "copilot", pluginVersion: "0.31.0", sampledAt: "2026-04-28T10:00:00Z", users: 1 },
          ],
        },
      },
    };
    fs.writeFileSync(cacheFile, JSON.stringify(envelope));

    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");

    expect(html).toContain("Copilot Users");
    expect(html).toContain("Copilot Usage by Feature");
    expect(html).toContain("Copilot Language Mix");
    expect(html).toContain("Copilot Model Mix");
    expect(html).toContain("Copilot PR Activity from Usage API");
    expect(html).toContain("Seats & Policies");
    expect(html).toContain("IDE Versions");
    expect(html).toContain("Language / Model");
    expect(html).toContain("Review Suggestion Types");
    expect(html).toContain("Adoption depth and delivery association");
    expect(html).toContain("3.00&times;");
    expect(html).toContain("Passive users");
    expect(html).toContain('aria-label="Copilot adoption phase distribution:');
    expect(html).toContain("Repository PR activity");
    expect(html).toContain("test-pages-owner/repo-a");
    expect(html).toContain("Cloud agent activity");
    expect(html).toContain("Code review activity");
    expect(html).toContain("Missing repositories are not zero-usage rows");
    expect(html).toContain("Unavailable");
    expect(html).toContain('id="chartCopilotUsageDaily"');
    expect(html).toContain('id="chartCopilotUsageCli"');
    expect(html).toContain('id="chartCopilotCodeReview"');
    expect(html).toContain('id="chartCopilotPrActivity"');
    expect(html).toContain("Copilot Usage");
    expect(html).toContain("alice");
    expect(html).toContain("bob");
    expect(html).toContain("Adoption Phase");
    expect(html).not.toContain("&amp;ndash;");
    expect(html).toContain('"copilotUsage"');
    expect(html).toContain('"dailyActiveUsers":1');
    expect(html).toContain('id="copilotUsageSearch"');
    expect(html).toContain('id="copilotUsageSurface"');
    expect(html).toContain('id="copilotUsageSort"');
    expect(html).toContain('class="usage-th-sortable"');

    const dom = new JSDOM(html, { runScripts: "dangerously" });
    const { window } = dom;
    const document = window.document;
    document.dispatchEvent(new window.Event("DOMContentLoaded"));

    const rows = Array.from(document.querySelectorAll<HTMLElement>("tr.usage-row"));
    expect(rows).toHaveLength(2);
    expect(rows[0].dataset.login).toBe("alice");
    expect(rows[0].dataset.surface).toContain("chat");
    expect(rows[0].dataset.surface).toContain("agent");

    const search = document.getElementById("copilotUsageSearch") as HTMLInputElement;
    search.value = "Phase 3";
    search.dispatchEvent(new window.Event("input"));
    expect(document.getElementById("copilotUsageShown")?.textContent).toBe("1");
    expect(rows.find((row) => row.dataset.login === "alice")?.style.display).not.toBe("none");
    expect(rows.find((row) => row.dataset.login === "bob")?.style.display).toBe("none");

    search.value = "";
    const surface = document.getElementById("copilotUsageSurface") as HTMLSelectElement;
    surface.value = "agent";
    surface.dispatchEvent(new window.Event("change"));
    expect(document.getElementById("copilotUsageShown")?.textContent).toBe("1");
    expect(rows.find((row) => row.dataset.login === "alice")?.style.display).not.toBe("none");
    expect(rows.find((row) => row.dataset.login === "bob")?.style.display).toBe("none");
  });

  it("should add data-agent-tasks attribute and Agent Tasks column to repo table", () => {
    const envelope: CacheEnvelope = {
      date: "2026-03-28",
      data: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        owner: "test-pages-owner",
        ownerType: "org",
        collectedAt: "2026-03-28T12:00:00Z",
        repoCount: 2,
        repos: [
          {
            name: "repo-with-agent",
            fullName: "test-pages-owner/repo-with-agent",
            issues: { open: 1, closed: 2 },
            pullRequests: { open: 0, closed: 0, merged: 1 },
            pullRequestDetails: [],
            committerCount: 1,
            reviewerCount: 0,
            contributorCount: 1,
            dependentCount: 0,
            copilotAgentMetrics: {
              totalTasks: 7,
              completedTasks: 3,
              failedTasks: 2,
              cancelledTasks: 1,
              timedOutTasks: 1,
              activeTasksCount: 0,
              totalSessions: 10,
              cloudAgentSessions: 10,
              cliRemoteSessions: 0,
              totalCreditsUsed: 20.0,
              agentCreatedPRs: 5,
            },
          },
          {
            name: "repo-no-agent",
            fullName: "test-pages-owner/repo-no-agent",
            issues: { open: 0, closed: 1 },
            pullRequests: { open: 0, closed: 0, merged: 0 },
            pullRequestDetails: [],
            committerCount: 1,
            reviewerCount: 0,
            contributorCount: 1,
            dependentCount: 0,
          },
        ],
      },
    };
    fs.writeFileSync(cacheFile, JSON.stringify(envelope));

    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");

    // Column header should be present
    expect(html).toContain("Agent Tasks");
    expect(html).toContain('data-sort="agentTasks"');
    expect(html).toContain('<option value="agentTasks">');

    // data-agent-tasks attribute on repo rows
    expect(html).toContain('data-agent-tasks="7"');
    expect(html).toContain('data-agent-tasks="0"');

    // detail row should use colspan=9
    expect(html).toContain('colspan="9"');

    // group header rows should use colspan=9
    expect(html).toContain('colspan="9" class="grp-hdr-cell"');

    // CHART_DATA should include agent byRepo data
    expect(html).toContain('"repo-with-agent"');
    expect(html).toContain('"totalTasks":7');

    // CHART_DATA should include owner for constructing GitHub task URLs
    expect(html).toContain('"owner":"test-pages-owner"');

    // Chart click handler should navigate to /agents for the repo (bar click and label click)
    expect(html).toContain("/agents");
    expect(html).toContain("CHART_DATA.owner");
    // Y-axis label click detection should be present
    expect(html).toContain("yAxis.getPixelForTick");

    // Extended detail fields should be present for repo with agent data
    expect(html).toContain("Cancelled");
    expect(html).toContain("Timed out");

    const dom = new JSDOM(html);
    const doc = dom.window.document;
    // Repo with agent tasks should show count in table cell
    const repoRow = Array.from(doc.querySelectorAll<HTMLElement>("tr.repo-row")).find(
      r => r.dataset.repoName === "repo-with-agent"
    );
    expect(repoRow).toBeDefined();
    expect(repoRow!.dataset.agentTasks).toBe("7");
  });

  /**
   * Minimal envelope with a merged-PR timeline rich enough to light up the
   * Insights, Health, Team, and Collaboration sections: 12 human-authored
   * merged PRs (alice x8, bob x4) in the last two weeks before collectedAt.
   * With `withReviewers`, PRs carry GraphQL-style reviewer arrays (2 of 12
   * reviewed by bob → low review coverage); without it the timeline mimics
   * the REST fallback path (no `reviewers` at all).
   */
  function analyticsEnvelope(opts?: { withReviewers?: boolean }): CacheEnvelope {
    const withReviewers = opts?.withReviewers ?? true;
    const timeline = Array.from({ length: 12 }, (_, i) => ({
      number: i + 1,
      createdAt: `2026-03-${String(15 + i).padStart(2, "0")}T00:00:00Z`,
      mergedAt: `2026-03-${String(16 + i).padStart(2, "0")}T00:00:00Z`,
      author: i < 8 ? "alice" : "bob",
      isBotAuthor: false,
      isCopilotAuthored: false,
      timeToMergeHours: 24,
      closesIssues: [],
      ...(withReviewers ? { reviewers: i < 2 ? ["bob"] : [] } : {}),
    }));
    return {
      date: "2026-03-28",
      data: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        owner: "test-pages-owner",
        ownerType: "org",
        collectedAt: "2026-03-28T12:00:00Z",
        repoCount: 1,
        repos: [
          {
            name: "repo-a",
            fullName: "test-pages-owner/repo-a",
            pushedAt: "2026-03-27T00:00:00Z",
            issues: { open: 2, closed: 5 },
            pullRequests: { open: 1, closed: 0, merged: 12 },
            pullRequestDetails: [],
            mergedPRTimeline: timeline,
            committerCount: 2,
            reviewerCount: 1,
            contributorCount: 2,
            dependentCount: 0,
          },
        ],
      },
    };
  }

  it("renders the Insights section first with severity chips when detectors fire", () => {
    fs.writeFileSync(cacheFile, JSON.stringify(analyticsEnvelope()));
    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");

    expect(html).toContain('<section class="sec" id="insights"');
    expect(html).toContain('href="#insights"');
    expect(html).toContain("Automated findings from the full collection window");
    // 2 of 12 PRs reviewed → the low-review-coverage detector fires critical.
    expect(html).toContain("Low code-review coverage");
    expect(html).toContain('class="insight-chip chip-critical"');
    // alice merged 8 of 12 PRs → bus-factor warning.
    expect(html).toContain("Bus factor of 1");
    expect(html).toContain('class="insight-chip chip-warning"');
    expect(html).toContain("Recommendation:");

    // Insights is the first section: it must precede Overview in the HTML.
    const posInsights = html.indexOf('id="insights"');
    const posOverview = html.indexOf('id="overview"');
    expect(posInsights).toBeGreaterThan(-1);
    expect(posInsights).toBeLessThan(posOverview);
  });

  it("omits the Insights section when no detectors fire", () => {
    // The default beforeEach fixture has no merged-PR timeline, so no
    // insight detector has enough data to fire.
    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");
    expect(html).not.toContain('<section class="sec" id="insights"');
    expect(html).not.toContain('href="#insights"');
  });

  it("renders the Health section with per-repo scores and grades", () => {
    fs.writeFileSync(cacheFile, JSON.stringify(analyticsEnvelope()));
    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");

    expect(html).toContain('<section class="sec" id="health"');
    expect(html).toContain('href="#health"');
    expect(html).toContain("Average Health Score");
    expect(html).toContain("Repos Needing Attention");
    // Sortable header hooks for setupHealthControls.
    expect(html).toContain('data-health-sort="score"');
    expect(html).toContain('data-health-sort="name"');
    expect(html).toContain("setupHealthControls");
    // Component columns from health.ts scorer order.
    expect(html).toContain("Review coverage");
    expect(html).toContain("Contributor redundancy");
    // Deterministic composite for this fixture: activity 100, review 17,
    // cycle 100, change failure 100, redundancy 55, backlog 86 → 78 → B.
    expect(html).toContain('data-score="78"');
    expect(html).toContain('<td class="health-grade">B</td>');

    const dom = new JSDOM(html);
    const row = dom.window.document.querySelector<HTMLElement>("tr.health-row");
    expect(row).not.toBeNull();
    expect(row!.dataset.name).toBe("test-pages-owner/repo-a");
  });

  it("sorts every Health field in both directions with highest scores first", () => {
    const envelope = analyticsEnvelope();
    envelope.data.repos = [
      {
        ...envelope.data.repos[0],
        name: "zeta",
        fullName: "test-pages-owner/zeta",
        pushedAt: "2026-03-27T00:00:00Z",
        issues: { open: 0, closed: 10 },
        mergedPRTimeline: [],
      },
      {
        ...envelope.data.repos[0],
        name: "alpha",
        fullName: "test-pages-owner/alpha",
        pushedAt: "2026-03-27T00:00:00Z",
        issues: { open: 8, closed: 2 },
        mergedPRTimeline: [],
      },
      {
        ...envelope.data.repos[0],
        name: "beta",
        fullName: "test-pages-owner/beta",
        pushedAt: "2025-01-01T00:00:00Z",
        issues: { open: 0, closed: 0 },
        mergedPRTimeline: [],
      },
    ];
    envelope.data.repoCount = envelope.data.repos.length;
    fs.writeFileSync(cacheFile, JSON.stringify(envelope));
    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });

    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");
    const dom = new JSDOM(html, { runScripts: "dangerously" });
    const { document } = dom.window;
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));

    const headers = Array.from(
      document.querySelectorAll<HTMLElement>(".health-table th")
    );
    expect(headers).toHaveLength(9);
    expect(headers.every((header) => header.classList.contains("health-th-sortable"))).toBe(true);

    const rowNames = () =>
      Array.from(document.querySelectorAll<HTMLElement>("tr.health-row")).map(
        (row) => row.dataset.name
      );
    const header = (key: string) =>
      document.querySelector<HTMLElement>(`[data-health-sort="${key}"]`)!;

    expect(header("score").getAttribute("aria-sort")).toBe("descending");
    expect(rowNames()).toEqual([
      "test-pages-owner/zeta",
      "test-pages-owner/alpha",
      "test-pages-owner/beta",
    ]);

    header("score").click();
    expect(header("score").getAttribute("aria-sort")).toBe("ascending");
    expect(rowNames()).toEqual([
      "test-pages-owner/beta",
      "test-pages-owner/alpha",
      "test-pages-owner/zeta",
    ]);

    header("name").click();
    expect(rowNames()).toEqual([
      "test-pages-owner/alpha",
      "test-pages-owner/beta",
      "test-pages-owner/zeta",
    ]);
    header("name").click();
    expect(rowNames()).toEqual([
      "test-pages-owner/zeta",
      "test-pages-owner/beta",
      "test-pages-owner/alpha",
    ]);

    header("grade").click();
    expect(rowNames()).toEqual([
      "test-pages-owner/zeta",
      "test-pages-owner/alpha",
      "test-pages-owner/beta",
    ]);
    header("grade").click();
    expect(rowNames()).toEqual([
      "test-pages-owner/beta",
      "test-pages-owner/alpha",
      "test-pages-owner/zeta",
    ]);

    header("c5").click();
    expect(rowNames()).toEqual([
      "test-pages-owner/zeta",
      "test-pages-owner/alpha",
      "test-pages-owner/beta",
    ]);
    header("c5").click();
    expect(rowNames()).toEqual([
      "test-pages-owner/alpha",
      "test-pages-owner/zeta",
      "test-pages-owner/beta",
    ]);

    for (const sortableHeader of headers) {
      sortableHeader.click();
      const firstDirection = sortableHeader.getAttribute("aria-sort");
      expect(["ascending", "descending"]).toContain(firstDirection);
      sortableHeader.click();
      expect(sortableHeader.getAttribute("aria-sort")).toBe(
        firstDirection === "ascending" ? "descending" : "ascending"
      );
    }
  });

  it("includes the Work units leaderboard column and benchmark row", () => {
    fs.writeFileSync(cacheFile, JSON.stringify(analyticsEnvelope()));
    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");

    expect(html).toContain('data-intel-sort="units"');
    expect(html).toContain("Work Units");
    expect(html).toContain("Work units per developer");
    // PRs without line data count 1 work unit each: alice 8.0, bob 4.0.
    expect(html).toContain('data-units="8.0"');
    expect(html).toContain('data-units="4.0"');
  });

  it("renders collaboration tables including review relationships when reviewer data exists", () => {
    fs.writeFileSync(cacheFile, JSON.stringify(analyticsEnvelope()));
    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");

    expect(html).toContain("Distinct Authors");
    expect(html).toContain("Review-Load Gini");
    expect(html).toContain("Siloed Contributors");
    expect(html).toContain("Ownership Concentration");
    // alice authored 8 of 12 merged PRs → bus factor 1, top share 66.7%.
    expect(html).toContain('<td class="col-num">66.7%</td>');
    // bob reviewed 2 of alice's PRs → a strongest-relationship edge.
    expect(html).toContain("Strongest Review Relationships");
    expect(html).toContain("<tr><td>alice</td><td>bob</td>");
    expect(html).toContain("Bus factor = smallest set of authors");
  });

  it("omits the review-relationships table on the REST path (no reviewer data)", () => {
    fs.writeFileSync(
      cacheFile,
      JSON.stringify(analyticsEnvelope({ withReviewers: false }))
    );
    expect(() =>
      execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
        cwd: process.cwd(),
      })
    ).not.toThrow();
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");

    // Bus factors derive from authors alone, so ownership still renders...
    expect(html).toContain('<section class="sec" id="team"');
    expect(html).toContain("Ownership Concentration");
    // ...but there are no author→reviewer edges without reviewer data.
    expect(html).not.toContain("Strongest Review Relationships");
    // Health must render with the review component degraded, not crash.
    expect(html).toContain('<section class="sec" id="health"');
    expect(html).toContain("No review data in timeline (REST-sourced)");
  });

  it("renders the Delivery Forecast block when enough completed weeks of trends exist", () => {
    const envelope = analyticsEnvelope();
    // collectedAt 2026-03-28 falls in ISO week 2026-W13, so W13 is the
    // in-progress week (excluded from the sample) and W08–W12 are the five
    // completed weeks the simulation draws from.
    envelope.data.weeklyTrends = [
      { week: "2026-W08", prsOpened: 6, prsMerged: 5, issuesOpened: 2, issuesClosed: 1, linesAdded: 100, linesDeleted: 20 },
      { week: "2026-W09", prsOpened: 4, prsMerged: 3, issuesOpened: 2, issuesClosed: 1, linesAdded: 90, linesDeleted: 15 },
      { week: "2026-W10", prsOpened: 5, prsMerged: 6, issuesOpened: 2, issuesClosed: 1, linesAdded: 120, linesDeleted: 30 },
      { week: "2026-W11", prsOpened: 3, prsMerged: 2, issuesOpened: 2, issuesClosed: 1, linesAdded: 60, linesDeleted: 10 },
      { week: "2026-W12", prsOpened: 4, prsMerged: 4, issuesOpened: 2, issuesClosed: 1, linesAdded: 80, linesDeleted: 25 },
      { week: "2026-W13", prsOpened: 1, prsMerged: 1, issuesOpened: 0, issuesClosed: 0, linesAdded: 10, linesDeleted: 2 },
    ];
    fs.writeFileSync(cacheFile, JSON.stringify(envelope));

    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");

    expect(html).toContain("Delivery Forecast");
    expect(html).toContain("Monte-Carlo over the last 5 completed weeks");
    expect(html).toContain("median 4 merged PRs/week");
    expect(html).toContain("Deliver next");
    expect(html).toContain("50% confidence");
    expect(html).toContain("95% confidence");
    // Rows render "<date> (<w>w)" cells for each default target (10/25/50 PRs).
    expect(html).toContain("10 PRs");
    expect(html).toContain("50 PRs");
    expect(html).toMatch(/\d{4}-\d{2}-\d{2} \(\d+w\)/);
  });

  it("omits the Delivery Forecast block without weekly trend data", () => {
    // The default beforeEach fixture has no weeklyTrends.
    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");
    expect(html).not.toContain("Delivery Forecast");
    expect(html).not.toContain('aria-label="Delivery forecast"');
  });

  it("renders the Team Targets block when devex.config.json exists in the cwd", () => {
    const configPath = path.resolve(process.cwd(), "devex.config.json");
    // Preserve any pre-existing config so the test never clobbers real state.
    const previous = fs.existsSync(configPath)
      ? fs.readFileSync(configPath, "utf-8")
      : undefined;
    try {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          targets: { maxMedianCycleHours: 24, minReviewCoverage: 0.8 },
        })
      );
      fs.writeFileSync(cacheFile, JSON.stringify(analyticsEnvelope()));

      execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
        cwd: process.cwd(),
      });
      const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");

      expect(html).toContain("Team Targets");
      expect(html).toContain("Thresholds from devex.config.json");
      // Cycle time is exactly 24h vs target ≤ 24h → met (inclusive bound).
      expect(html).toContain('<span class="insight-chip chip-positive">Met</span>');
      expect(html).toContain("Median cycle time");
      // Review coverage 2/12 ≈ 16.7% vs target ≥ 80% → missed.
      expect(html).toContain('<span class="insight-chip chip-critical">Missed</span>');
      expect(html).toContain("Review coverage");
      // Target evaluations also flow into the Insights section.
      expect(html).toContain("1 team target missed");
    } finally {
      if (previous !== undefined) fs.writeFileSync(configPath, previous);
      else if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    }
  });

  it("omits the Team Targets block when no devex.config.json exists", () => {
    fs.writeFileSync(cacheFile, JSON.stringify(analyticsEnvelope()));
    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");
    expect(html).not.toContain("Team Targets");
    expect(html).not.toContain('aria-label="Team targets"');
  });

  it("renders week-over-week delta chips when snapshot history exists", () => {
    const historyFile = path.join(dataDir, "test-pages-owner-history.json");
    try {
      fs.writeFileSync(
        historyFile,
        JSON.stringify({
          schemaVersion: HISTORY_SCHEMA_VERSION,
          targetKey: "test-pages-owner",
          snapshots: [
            {
              date: "2026-03-21",
              collectedAt: "2026-03-21T12:00:00Z",
              repoCount: 1,
              openIssues: 5,
              openPRs: 2,
              mergedPRs30d: 8,
              medianCycleHours30d: 30,
              reviewCoverage30d: 0.5,
              contributorCount: 2,
              avgHealthScore: 70,
              needsAttentionCount: 1,
              aiShare: 0.1,
              deploys30d: 3,
              reverts30d: 1,
            },
            {
              date: "2026-03-28",
              collectedAt: "2026-03-28T12:00:00Z",
              repoCount: 1,
              openIssues: 2,
              openPRs: 1,
              mergedPRs30d: 12,
              medianCycleHours30d: 24,
              reviewCoverage30d: 0.6,
              contributorCount: 2,
              avgHealthScore: 78,
              needsAttentionCount: 0,
              aiShare: 0.1,
              deploys30d: 3,
              reverts30d: 0,
            },
          ],
        })
      );

      execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
        cwd: process.cwd(),
      });
      const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");

      // Baseline caption near the Overview title.
      expect(html).toContain("Changes vs the 2026-03-21 snapshot (7d ago)");
      // Chip strip under the KPI tiles.
      expect(html).toContain('class="delta-strip"');
      // mergedPRs30d 8 → 12: up is good → green chip with an up arrow.
      expect(html).toContain("Merged PRs (30d)");
      expect(html).toContain('class="delta-chip delta-good"');
      expect(html).toContain("&#9650; +4");
      // medianCycleHours30d 30 → 24: down is good → good chip, hours unit.
      expect(html).toContain("&#9660; &minus;6h");
      // reviewCoverage30d 0.5 → 0.6 formats as percentage points.
      expect(html).toContain("+10.0pp");
      // aiShare unchanged → muted flat chip.
      expect(html).toContain('class="delta-chip delta-flat"');
      expect(html).toContain("&plusmn;0");
    } finally {
      if (fs.existsSync(historyFile)) fs.unlinkSync(historyFile);
    }
  });

  it("omits delta chips and caption when no snapshot history exists", () => {
    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");
    expect(html).not.toContain('class="delta-strip"');
    expect(html).not.toContain("Changes vs the");
  });

  it("writes shields.io badge endpoint files with grade and tier colors", () => {
    fs.writeFileSync(cacheFile, JSON.stringify(analyticsEnvelope()));
    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });

    // Composite health for this fixture is 78 → grade B → green.
    const healthBadge = JSON.parse(
      fs.readFileSync(path.join(siteDir, "badge-health.json"), "utf-8")
    );
    expect(healthBadge).toEqual({
      schemaVersion: 1,
      label: "devex health",
      message: "78 (B)",
      color: "green",
    });

    // All 12 PRs merged in 24h → median lead time 24h → "high" tier.
    const doraBadge = JSON.parse(
      fs.readFileSync(path.join(siteDir, "badge-dora.json"), "utf-8")
    );
    expect(doraBadge.schemaVersion).toBe(1);
    expect(doraBadge.label).toBe("DORA lead time");
    expect(doraBadge.message).toMatch(/· high$/);
    expect(doraBadge.color).toBe("green");

    // 12 merged PRs inside the 30-day window ending at collectedAt.
    const throughputBadge = JSON.parse(
      fs.readFileSync(path.join(siteDir, "badge-throughput.json"), "utf-8")
    );
    expect(throughputBadge).toEqual({
      schemaVersion: 1,
      label: "merged PRs (30d)",
      message: "12",
      color: "blue",
    });
  });

  it("writes no-data fallback badges when the target has no repos", () => {
    const envelope: CacheEnvelope = {
      date: "2026-03-28",
      data: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        owner: "test-pages-owner",
        ownerType: "org",
        collectedAt: "2026-03-28T12:00:00Z",
        repoCount: 0,
        repos: [],
      },
    };
    fs.writeFileSync(cacheFile, JSON.stringify(envelope));
    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });

    const healthBadge = JSON.parse(
      fs.readFileSync(path.join(siteDir, "badge-health.json"), "utf-8")
    );
    expect(healthBadge).toEqual({
      schemaVersion: 1,
      label: "devex health",
      message: "no data",
      color: "lightgrey",
    });
    const doraBadge = JSON.parse(
      fs.readFileSync(path.join(siteDir, "badge-dora.json"), "utf-8")
    );
    expect(doraBadge.message).toBe("no data");
    expect(doraBadge.color).toBe("lightgrey");
    const throughputBadge = JSON.parse(
      fs.readFileSync(path.join(siteDir, "badge-throughput.json"), "utf-8")
    );
    expect(throughputBadge.message).toBe("0");
    expect(throughputBadge.color).toBe("blue");
  });

  it("labels the DORA failure signal as incidents and ships repoIncidents when incidents exist", () => {
    const envelope = analyticsEnvelope();
    envelope.data.repos[0].incidents = [
      {
        number: 101,
        createdAt: "2026-03-20T00:00:00Z",
        closedAt: "2026-03-20T06:00:00Z",
        resolutionHours: 6,
        labels: ["incident"],
      },
      { number: 102, createdAt: "2026-03-25T00:00:00Z", labels: ["outage"] },
    ];
    fs.writeFileSync(cacheFile, JSON.stringify(envelope));
    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");

    // Caption flips to the incident signal (both incidents opened in-window).
    expect(html).toContain('<span id="doraSignalNote">failure = labeled incident (2 in window)</span>');
    // The revert wording only survives in the client JS fallback branch, not
    // in the server-rendered caption span.
    expect(html).not.toContain('<span id="doraSignalNote">failure = reverted merge</span>');
    // CFR/MTTR tile sub-lines use incident wording too.
    expect(html).toContain("2 incidents / 12 merged");
    expect(html).toContain("median of 1 incidents");
    // Client filter mirror gets the per-repo incident arrays.
    expect(html).toContain('"repoIncidents":{"repo-a"');
    expect(html).toContain('"resolutionHours":6');
  });

  it("keeps the revert failure-signal wording when no repo has incidents", () => {
    fs.writeFileSync(cacheFile, JSON.stringify(analyticsEnvelope()));
    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");
    expect(html).toContain('<span id="doraSignalNote">failure = reverted merge</span>');
    // The incident wording only survives in the client JS incident branch,
    // not in the server-rendered caption span.
    expect(html).not.toContain('<span id="doraSignalNote">failure = labeled incident');
    expect(html).toContain('"repoIncidents":{}');
  });

  it("should show – for repos with no agent data in Agent Tasks column", () => {
    execFileSync("node", ["dist/build-pages.js", "test-pages-owner"], {
      cwd: process.cwd(),
    });
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf-8");
    // The default fixture has no copilotAgentMetrics, so should show dash
    expect(html).toContain('data-agent-tasks="0"');
    // KPI shows – when no agent data
    expect(html).toContain('id="kpiAgentVal"');
    const dom = new JSDOM(html);
    expect(dom.window.document.getElementById("kpiAgentVal")?.textContent).toBe("–");
  });
});

describe("build-pages --rollup", () => {
  const dataDir = path.resolve(process.cwd(), "data");
  const siteDir = path.resolve(process.cwd(), "_site");
  const configPath = path.resolve(process.cwd(), "devex.config.json");

  /** Minimal schema-current envelope for one fake rollup owner. */
  function ownerEnvelope(owner: string, repoName: string): CacheEnvelope {
    return {
      date: "2026-03-28",
      data: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        owner,
        ownerType: "org",
        collectedAt: "2026-03-28T12:00:00Z",
        repoCount: 1,
        repos: [
          {
            name: repoName,
            fullName: `${owner}/${repoName}`,
            issues: { open: 1, closed: 2 },
            pullRequests: { open: 1, closed: 0, merged: 3 },
            pullRequestDetails: [],
            committerCount: 1,
            reviewerCount: 1,
            contributorCount: 2,
            dependentCount: 0,
          },
        ],
      },
    };
  }

  it("builds one merged dashboard named after the rollup config", () => {
    const rollupName = "rollup-merged-test";
    const cacheX = path.join(dataDir, "rollup-owner-x.json");
    const cacheY = path.join(dataDir, "rollup-owner-y.json");
    const historyFile = path.join(dataDir, `${rollupName}-history.json`);
    // Preserve any pre-existing config so the test never clobbers real state.
    const previousConfig = fs.existsSync(configPath)
      ? fs.readFileSync(configPath, "utf-8")
      : undefined;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(cacheX, JSON.stringify(ownerEnvelope("rollup-owner-x", "repo-x")));
      fs.writeFileSync(cacheY, JSON.stringify(ownerEnvelope("rollup-owner-y", "repo-y")));
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          rollup: {
            name: rollupName,
            targets: [
              { owner: "rollup-owner-x", ownerType: "org" },
              { owner: "rollup-owner-y", ownerType: "org" },
            ],
          },
        })
      );

      execFileSync("node", ["dist/build-pages.js", "--rollup"], {
        cwd: process.cwd(),
      });

      const indexPath = path.join(siteDir, "index.html");
      expect(fs.existsSync(indexPath)).toBe(true);
      const html = fs.readFileSync(indexPath, "utf-8");

      // The masthead names the merged dashboard after the rollup.
      const dom = new JSDOM(html);
      const masthead = dom.window.document.querySelector(".masthead-owner");
      expect(masthead?.textContent).toBe(rollupName);

      // Repo rows from both owners are merged into one table.
      expect(html).toContain("repo-x");
      expect(html).toContain("repo-y");
      const rows = Array.from(
        dom.window.document.querySelectorAll<HTMLElement>("tr.repo-row")
      );
      expect(rows.map((row) => row.dataset.repoName).sort()).toEqual([
        "repo-x",
        "repo-y",
      ]);

      // data.json exposes the merged metrics, not a single owner's.
      const data = JSON.parse(
        fs.readFileSync(path.join(siteDir, "data.json"), "utf-8")
      );
      expect(data.owner).toBe(rollupName);
      expect(data.repoCount).toBe(2);

      // The rollup got its own history snapshot for future deltas.
      expect(fs.existsSync(historyFile)).toBe(true);
      const history = JSON.parse(fs.readFileSync(historyFile, "utf-8"));
      expect(history.targetKey).toBe(rollupName);
      expect(history.snapshots).toHaveLength(1);
    } finally {
      if (previousConfig !== undefined) fs.writeFileSync(configPath, previousConfig);
      else if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
      if (fs.existsSync(cacheX)) fs.unlinkSync(cacheX);
      if (fs.existsSync(cacheY)) fs.unlinkSync(cacheY);
      if (fs.existsSync(historyFile)) fs.unlinkSync(historyFile);
      if (fs.existsSync(siteDir)) fs.rmSync(siteDir, { recursive: true });
    }
  });

  it("exits 1 with a clear error when no devex.config.json exists", () => {
    // Preserve and remove any real config so the failure path is exercised.
    const previousConfig = fs.existsSync(configPath)
      ? fs.readFileSync(configPath, "utf-8")
      : undefined;
    try {
      if (previousConfig !== undefined) fs.unlinkSync(configPath);

      let error: unknown;
      try {
        execFileSync("node", ["dist/build-pages.js", "--rollup"], {
          cwd: process.cwd(),
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeDefined();
      const failure = error as { status: number | null; stderr: Buffer };
      expect(failure.status).toBe(1);
      expect(String(failure.stderr)).toContain("devex.config.json");
      expect(String(failure.stderr)).toContain("rollup");
    } finally {
      if (previousConfig !== undefined) fs.writeFileSync(configPath, previousConfig);
      if (fs.existsSync(siteDir)) fs.rmSync(siteDir, { recursive: true });
    }
  });
});
