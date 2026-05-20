import { loadCache, loadRawCache, isWithinHours, saveCache, CURRENT_SCHEMA_VERSION, buildTargetKey } from "./cache.js";
import {
  collectRepos,
  collectIssueCounts,
  collectIssueLeadTimes,
  collectPullRequestCounts,
  collectPullRequestDetails,
  collectMergedPRTimeline,
  computeCopilotAdoption,
  collectContributors,
  collectDependentCount,
  collectWeeklyTrends,
  collectRepoGraphQL,
  buildPullRequestCounts,
  buildMergedPRTimeline,
  collectPullRequestDetailsFromNodes,
  extractReviewerLogins,
  collectCopilotAgentMetrics,
} from "./collectors/index.js";
import type { GraphQLPRNode } from "./collectors/index.js";
import type { OrgMetrics, RepoMetrics } from "./types.js";

export interface CollectOptions {
  /** Skip all cached/fixture data and force a fresh API fetch. */
  skipCache?: boolean;
  /** Optional repository name or fullName filter. */
  repo?: string;
  /**
   * Maximum age in hours before a per-repo cache entry is considered stale
   * and re-fetched. Defaults to 8 hours. Only applies when skipCache is false.
   */
  maxRepoAgeHours?: number;
}

const DEFAULT_MAX_REPO_AGE_HOURS = 8;

/**
 * Collect metrics for every repo owned by `owner`.
 */
export async function collect(
  owner: string,
  ownerType: "org" | "user",
  options: CollectOptions = {}
): Promise<OrgMetrics> {
  const maxAgeHours = options.maxRepoAgeHours ?? DEFAULT_MAX_REPO_AGE_HOURS;
  const cacheKey = buildTargetKey(owner, ownerType, options.repo);

  if (!options.skipCache) {
    const cached = loadCache(cacheKey);
    if (cached) {
      console.log(`Using cached data for ${cacheKey} (collected ${cached.collectedAt})`);
      return cached;
    }
  }

  console.log(`Collecting fresh metrics for ${owner} (${ownerType})${options.repo ? ` repo=${options.repo}` : ""}…`);

  // Build a lookup map from any existing (potentially stale) cache so we can
  // reuse per-repo data that is still within maxAgeHours.
  const cachedRepoMap = new Map<string, RepoMetrics>();
  if (!options.skipCache) {
    const raw = loadRawCache(cacheKey);
    if (raw) {
      for (const repo of raw.repos) {
        cachedRepoMap.set(repo.fullName, repo);
      }
    }
  }

  const repoList = await collectRepos(owner, ownerType, { repo: options.repo });
  console.log(`Found ${repoList.length} repositories`);

  const repos: RepoMetrics[] = [];
  let freshCount = 0;
  // Collects pre-fetched GraphQL PR nodes per repo for the trends collector.
  const prDataByRepo = new Map<string, GraphQLPRNode[]>();

  for (const { fullName, pushedAt } of repoList) {
    // Reuse per-repo data if it is recent enough.
    if (!options.skipCache) {
      const cached = cachedRepoMap.get(fullName);
      if (cached && isWithinHours(cached.collectedAt, maxAgeHours)) {
        console.log(`  → ${fullName} (cached)`);
        repos.push(cached);
        continue;
      }
    }

    console.log(`  → ${fullName}`);
    freshCount++;

    const slashIndex = fullName.indexOf("/");
    if (slashIndex <= 0 || slashIndex === fullName.length - 1) {
      console.warn(`  ⚠ Skipping repo with unexpected fullName format: ${fullName}`);
      continue;
    }
    const repoOwner = fullName.slice(0, slashIndex);
    const repoName = fullName.slice(slashIndex + 1);

    // Try the GraphQL path first (1-2 calls vs ~100 REST calls per repo).
    const graphqlData = await collectRepoGraphQL(repoOwner, repoName);

    let issues, prCounts, prDetails, mergedPRTimeline, contributors, dependentCount;

    if (graphqlData !== null) {
      // Fast path: derive most data from the pre-fetched GraphQL result.
      issues = {
        open: graphqlData.openIssueCount,
        closed: graphqlData.closedIssueCount,
      };
      prCounts = buildPullRequestCounts(graphqlData);
      mergedPRTimeline = buildMergedPRTimeline(graphqlData.prNodes);
      prDetails = await collectPullRequestDetailsFromNodes(
        repoOwner,
        repoName,
        graphqlData.prNodes
      );
      const reviewerLogins = extractReviewerLogins(graphqlData.prNodes);
      const results = await Promise.allSettled([
        collectContributors(repoOwner, repoName, reviewerLogins),
        collectDependentCount(repoOwner, repoName),
      ]);
      contributors = results[0].status === "fulfilled" ? results[0].value : { committerCount: 0, reviewerCount: 0, contributorCount: 0 };
      dependentCount = results[1].status === "fulfilled" ? results[1].value : 0;
      if (results[0].status === "rejected") {
        console.warn(`  ⚠ ${fullName}: failed to collect contributors: ${String((results[0] as PromiseRejectedResult).reason)}`);
      }
      if (results[1].status === "rejected") {
        console.warn(`  ⚠ ${fullName}: failed to collect dependent count: ${String((results[1] as PromiseRejectedResult).reason)}`);
      }
      // Store PR nodes for the trends collector (avoids pulls.get detail fetches).
      prDataByRepo.set(fullName, graphqlData.prNodes);
    } else {
      // Fallback: full REST path (GraphQL returned null = not found/forbidden).
      const results = await Promise.allSettled([
        collectIssueCounts(repoOwner, repoName),
        collectPullRequestCounts(repoOwner, repoName),
        collectPullRequestDetails(repoOwner, repoName),
        collectMergedPRTimeline(repoOwner, repoName),
        collectContributors(repoOwner, repoName),
        collectDependentCount(repoOwner, repoName),
      ]);
      issues = results[0].status === "fulfilled" ? results[0].value : { open: 0, closed: 0 };
      prCounts = results[1].status === "fulfilled" ? results[1].value : { open: 0, closed: 0, merged: 0 };
      prDetails = results[2].status === "fulfilled" ? results[2].value : [];
      mergedPRTimeline = results[3].status === "fulfilled" ? results[3].value : [];
      contributors = results[4].status === "fulfilled" ? results[4].value : { committerCount: 0, reviewerCount: 0, contributorCount: 0 };
      dependentCount = results[5].status === "fulfilled" ? results[5].value : 0;
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === "rejected") {
          const collectors = ["issues", "prs", "pr-details", "pr-timeline", "contributors", "dependents"];
          console.warn(`  ⚠ ${fullName}: failed to collect ${collectors[i]}: ${String((results[i] as PromiseRejectedResult).reason)}`);
        }
      }
    }

    // Fetch issue lead times for PRs that reference issues
    const issueLeadTimes = await collectIssueLeadTimes(
      repoOwner,
      repoName,
      mergedPRTimeline,
    );

    const copilotAdoption = computeCopilotAdoption(mergedPRTimeline, prDetails);

    // Collect Copilot agent metrics (heavy, per-repo; uses its own cache).
    const copilotAgentMetrics =
      (await collectCopilotAgentMetrics(repoOwner, repoName)) ?? undefined;

    repos.push({
      name: repoName,
      fullName,
      pushedAt,
      collectedAt: new Date().toISOString(),
      issues,
      pullRequests: prCounts,
      pullRequestDetails: prDetails,
      mergedPRTimeline,
      copilotAdoption,
      issueLeadTimes,
      committerCount: contributors.committerCount,
      reviewerCount: contributors.reviewerCount,
      contributorCount: contributors.contributorCount,
      dependentCount,
      copilotAgentMetrics,
    });
  }

  // Reuse cached weekly trends if every repo came from cache and all repos
  // already have per-repo weeklyTrends (i.e. cache was built with this version).
  let weeklyTrends = loadRawCache(cacheKey)?.weeklyTrends;
  const missingRepoTrends = repos.some((r) => !Array.isArray(r.weeklyTrends));
  if (freshCount > 0 || !weeklyTrends || missingRepoTrends) {
    console.log(`Collecting weekly trends… (${freshCount} repos refreshed)`);
    const trendRepos = repos.map((r) => {
      const slash = r.fullName.indexOf("/");
      return { owner: r.fullName.slice(0, slash), name: r.name };
    });
    const result = await collectWeeklyTrends(trendRepos, 104, 200, prDataByRepo);
    weeklyTrends = result.orgTrends;
    for (const repo of repos) {
      repo.weeklyTrends = result.repoTrends.get(repo.fullName) ?? [];
    }
  } else {
    console.log(`Reusing cached weekly trends (all ${repos.length} repos were fresh)`);
  }

  const metrics: OrgMetrics = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    owner,
    ownerType,
    targetRepo: options.repo,
    collectedAt: new Date().toISOString(),
    repoCount: repos.length,
    repos,
    weeklyTrends,
  };

  saveCache(cacheKey, metrics);
  return metrics;
}
