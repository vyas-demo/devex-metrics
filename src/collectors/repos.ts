import { getOctokit } from "../github-client.js";

export interface CollectReposOptions {
  /** Optional repo name or fullName filter. */
  repo?: string;
}

interface RepoSummary {
  name: string;
  fullName: string;
  pushedAt: string;
}

interface ContributedRepoResponse {
  user: {
    repositoriesContributedTo: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        name: string;
        nameWithOwner: string;
        pushedAt: string | null;
        owner: { __typename: string };
      }>;
    };
  } | null;
}

const CONTRIBUTED_REPOS_QUERY = `
  query UserContributedRepos($login: String!, $cursor: String) {
    user(login: $login) {
      repositoriesContributedTo(
        first: 100
        after: $cursor
        includeUserRepositories: false
        contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          name
          nameWithOwner
          pushedAt
          owner { __typename }
        }
      }
    }
  }
`;

function toRepoSummary(repo: { name: string; full_name: string; pushed_at?: string | null }): RepoSummary {
  return {
    name: repo.name,
    fullName: repo.full_name,
    pushedAt: repo.pushed_at ?? "",
  };
}

function matchesRepoFilter(repo: RepoSummary, repoFilter?: string): boolean {
  if (!repoFilter) return true;
  return repo.fullName.toLowerCase() === repoFilter.toLowerCase() || repo.name.toLowerCase() === repoFilter.toLowerCase();
}

async function collectContributedOrgRepos(owner: string): Promise<RepoSummary[]> {
  const octokit = await getOctokit();
  const repos: RepoSummary[] = [];
  let cursor: string | null = null;

  while (true) {
    let response: ContributedRepoResponse;
    try {
      response = await octokit.graphql<ContributedRepoResponse>(CONTRIBUTED_REPOS_QUERY, {
        login: owner,
        cursor,
      });
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 403 || status === 404) {
        return repos;
      }
      console.warn(`  ⚠ repos: could not load contributed org repos for ${owner}: ${String(err)}`);
      return repos;
    }

    const contributed = response?.user?.repositoriesContributedTo;
    if (!contributed) {
      return repos;
    }

    for (const repo of contributed.nodes) {
      if (repo.owner.__typename !== "Organization") continue;
      repos.push({
        name: repo.name,
        fullName: repo.nameWithOwner,
        pushedAt: repo.pushedAt ?? "",
      });
    }

    if (!contributed.pageInfo.hasNextPage || contributed.pageInfo.endCursor === null) {
      return repos;
    }
    cursor = contributed.pageInfo.endCursor;
  }
}

/**
 * Fetch all repos for an org or user.
 * Returns basic repo info used by downstream collectors.
 */
export async function collectRepos(
  owner: string,
  ownerType: "org" | "user",
  options: CollectReposOptions = {}
): Promise<RepoSummary[]> {
  const octokit = await getOctokit();
  const repoMap = new Map<string, RepoSummary>();

  const pushRepo = (repo: RepoSummary) => {
    if (!matchesRepoFilter(repo, options.repo)) return;
    repoMap.set(repo.fullName.toLowerCase(), repo);
  };

  if (ownerType === "org") {
    for await (const response of octokit.paginate.iterator(
      octokit.rest.repos.listForOrg,
      { org: owner, per_page: 100, type: "all" }
    )) {
      for (const repo of response.data) {
        pushRepo(toRepoSummary(repo));
      }
    }
  } else {
    // GET /users/{username}/repos only returns repos where the user is an
    // explicit per-repo collaborator — it misses org repos accessible purely
    // via org membership (even public ones). When the token belongs to the
    // same user we're collecting for, use GET /user/repos instead, which
    // includes repos reachable through org membership.
    let useAuthEndpoint = false;
    try {
      const { data: authUser } = await octokit.rest.users.getAuthenticated();
      useAuthEndpoint = authUser.login.toLowerCase() === owner.toLowerCase();
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status !== 401 && status !== 403) {
        // Unexpected error — log and fall back gracefully
        console.warn(`  ⚠ repos: could not determine authenticated user, falling back to public list: ${String(err)}`);
      }
      // 401/403 means the token has no user context (e.g. GitHub App) — silent fallback
    }

    if (useAuthEndpoint) {
      for await (const response of octokit.paginate.iterator(
        octokit.rest.repos.listForAuthenticatedUser,
        { per_page: 100, type: "all", affiliation: "owner,collaborator,organization_member" }
      )) {
        for (const repo of response.data) {
          pushRepo(toRepoSummary(repo));
        }
      }
    } else {
      for await (const response of octokit.paginate.iterator(
        octokit.rest.repos.listForUser,
        { username: owner, per_page: 100, type: "all" }
      )) {
        for (const repo of response.data) {
          pushRepo(toRepoSummary(repo));
        }
      }
    }

    for (const repo of await collectContributedOrgRepos(owner)) {
      pushRepo(repo);
    }
  }
  return [...repoMap.values()];
}
