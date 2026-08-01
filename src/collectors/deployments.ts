import { getOctokit } from "../github-client.js";
import type { DeploymentEvent } from "../types.js";

/** Shape of the GraphQL response for the deployments/releases query. */
interface DeploymentsResponse {
  repository: {
    deployments: {
      nodes: Array<{
        createdAt: string;
        environment: string | null;
        latestStatus: { state: string } | null;
      } | null>;
    };
    releases: {
      nodes: Array<{
        createdAt: string;
        tagName: string | null;
        isPrerelease: boolean;
      } | null>;
    };
  } | null;
}

const DEPLOYMENTS_QUERY = `
  query RepoDeployments($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      deployments(first: 100, orderBy: {field: CREATED_AT, direction: DESC}) {
        nodes { createdAt environment latestStatus { state } }
      }
      releases(first: 100, orderBy: {field: CREATED_AT, direction: DESC}) {
        nodes { createdAt tagName isPrerelease }
      }
    }
  }
`;

/**
 * Deployment status states that count as a real deploy. `inactive` means the
 * deployment succeeded and was later superseded by a newer one — still a
 * deploy. Failed/in-flight states (error, failure, pending, queued,
 * in_progress, waiting) are excluded.
 */
const SUCCESSFUL_DEPLOY_STATES = new Set(["success", "active", "inactive"]);

/**
 * Collect deployment and release events for a repository via a single
 * GraphQL query (no pagination — newest 100 of each).
 *
 * Deployments are filtered to successful-ish ones (or those with no status);
 * prereleases are skipped. Events older than ~2 years are dropped. The
 * merged array is sorted by createdAt descending.
 *
 * Returns null on 404 (repo not found), 403 (access denied), transient 5xx
 * errors, or an empty response — this is a nice-to-have signal, so we never
 * retry. Re-throws other errors.
 */
export async function collectDeployments(
  owner: string,
  repo: string
): Promise<DeploymentEvent[] | null> {
  const octokit = await getOctokit();
  const cutoff = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000); // ~2 years

  let response: DeploymentsResponse;
  try {
    response = await octokit.graphql<DeploymentsResponse>(DEPLOYMENTS_QUERY, {
      owner,
      name: repo,
    });
  } catch (err: unknown) {
    if (isGraphQLNotFoundOrForbidden(err)) {
      if (hasGraphQLForbiddenError(err)) {
        console.warn(`  ⚠ deployments: skipping ${owner}/${repo}: access denied (403)`);
      }
      return null;
    }
    if (isTransientServerError(err)) {
      console.warn(`  ⚠ deployments: skipping ${owner}/${repo}: transient server error (5xx)`);
      return null;
    }
    throw err;
  }

  if (!response?.repository) {
    console.warn(`  ⚠ deployments: empty response for ${owner}/${repo}`);
    return null;
  }

  const events: DeploymentEvent[] = [];

  for (const node of response.repository.deployments.nodes ?? []) {
    if (!node) continue;
    if (new Date(node.createdAt) < cutoff) continue;
    const state = node.latestStatus?.state
      ? node.latestStatus.state.toLowerCase()
      : undefined;
    if (state !== undefined && !SUCCESSFUL_DEPLOY_STATES.has(state)) continue;
    events.push({
      createdAt: node.createdAt,
      source: "deployment",
      environment: node.environment ?? undefined,
      state,
    });
  }

  for (const node of response.repository.releases.nodes ?? []) {
    if (!node || node.isPrerelease) continue;
    if (new Date(node.createdAt) < cutoff) continue;
    events.push({
      createdAt: node.createdAt,
      source: "release",
      tagName: node.tagName ?? undefined,
    });
  }

  return events.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
}

/** Return true for transient server-side HTTP errors (5xx). */
function isTransientServerError(err: unknown): boolean {
  const httpError = err as { status?: number };
  return typeof httpError.status === "number" && httpError.status >= 500 && httpError.status < 600;
}

/** Check if a GraphQL error indicates the resource was not found or is forbidden. */
function isGraphQLNotFoundOrForbidden(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Octokit GraphQL throws GraphqlResponseError for server-side errors
  const graphqlError = err as { errors?: Array<{ type?: string; message?: string }> };
  if (graphqlError.errors) {
    return graphqlError.errors.some(
      (e) =>
        e.type === "NOT_FOUND" ||
        e.type === "FORBIDDEN" ||
        e.message?.toLowerCase().includes("not found") ||
        e.message?.toLowerCase().includes("forbidden") ||
        e.message?.toLowerCase().includes("could not resolve")
    );
  }
  // HTTP-level 403/404 on the GraphQL endpoint
  const httpError = err as { status?: number };
  return httpError.status === 404 || httpError.status === 403;
}

/** Check if the error is specifically a forbidden (403) type. */
function hasGraphQLForbiddenError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const graphqlError = err as { errors?: Array<{ type?: string; message?: string }>; status?: number };
  if (graphqlError.status === 403) return true;
  if (graphqlError.errors) {
    return graphqlError.errors.some(
      (e) =>
        e.type === "FORBIDDEN" ||
        e.message?.toLowerCase().includes("forbidden")
    );
  }
  return false;
}
