import { getOctokit } from "../github-client.js";
import type { IncidentEvent } from "../types.js";

/** Shape of the GraphQL response for the labeled-incidents query. */
interface IncidentsResponse {
  repository: {
    issues: {
      nodes: Array<{
        number: number;
        createdAt: string;
        closedAt: string | null;
        labels: { nodes: Array<{ name: string } | null> } | null;
      } | null>;
    };
  } | null;
}

const INCIDENTS_QUERY = `
  query RepoIncidents($owner: String!, $name: String!, $labels: [String!]) {
    repository(owner: $owner, name: $name) {
      issues(labels: $labels, first: 100, orderBy: {field: CREATED_AT, direction: DESC}) {
        nodes {
          number
          createdAt
          closedAt
          labels(first: 10) { nodes { name } }
        }
      }
    }
  }
`;

/**
 * Issue labels treated as incidents when no `incidentLabels` list is
 * configured in `devex.config.json`. Matched case-insensitively.
 */
export const DEFAULT_INCIDENT_LABELS = [
  "incident",
  "outage",
  "sev1",
  "sev2",
  "production-incident",
];

/**
 * Collect labeled incident issues for a repository via a single GraphQL
 * query (no pagination — newest 100).
 *
 * Issues carrying ANY of the given labels (or `DEFAULT_INCIDENT_LABELS`
 * when omitted) count as incidents — GitHub's `labels:` filter is an OR.
 * Issues older than ~2 years are dropped; the result is sorted by
 * createdAt ascending. `resolutionHours` is set for closed incidents and
 * the `labels` array keeps only the issue labels that case-insensitively
 * match the incident label set.
 *
 * Returns null on 404 (repo not found), 403 (access denied), transient 5xx
 * errors, or an empty response — this is a nice-to-have signal, so we never
 * retry. Re-throws other errors.
 */
export async function collectIncidents(
  owner: string,
  repo: string,
  labels?: string[]
): Promise<IncidentEvent[] | null> {
  const octokit = await getOctokit();
  const incidentLabels =
    labels && labels.length > 0 ? labels : DEFAULT_INCIDENT_LABELS;
  const cutoff = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000); // ~2 years

  let response: IncidentsResponse;
  try {
    response = await octokit.graphql<IncidentsResponse>(INCIDENTS_QUERY, {
      owner,
      name: repo,
      labels: incidentLabels,
    });
  } catch (err: unknown) {
    if (isGraphQLNotFoundOrForbidden(err)) {
      if (hasGraphQLForbiddenError(err)) {
        console.warn(`  ⚠ incidents: skipping ${owner}/${repo}: access denied (403)`);
      }
      return null;
    }
    if (isTransientServerError(err)) {
      console.warn(`  ⚠ incidents: skipping ${owner}/${repo}: transient server error (5xx)`);
      return null;
    }
    throw err;
  }

  if (!response?.repository) {
    console.warn(`  ⚠ incidents: empty response for ${owner}/${repo}`);
    return null;
  }

  const labelSet = new Set(incidentLabels.map((label) => label.toLowerCase()));
  const events: IncidentEvent[] = [];

  for (const node of response.repository.issues.nodes ?? []) {
    if (!node) continue;
    if (new Date(node.createdAt) < cutoff) continue;
    const matchedLabels = (node.labels?.nodes ?? [])
      .filter((label): label is { name: string } => label !== null)
      .map((label) => label.name)
      .filter((name) => labelSet.has(name.toLowerCase()));
    const closedAt = node.closedAt ?? undefined;
    const resolutionHours =
      closedAt !== undefined
        ? Math.round(
            ((new Date(closedAt).getTime() - new Date(node.createdAt).getTime()) /
              3_600_000) *
              100
          ) / 100
        : undefined;
    events.push({
      number: node.number,
      createdAt: node.createdAt,
      closedAt,
      resolutionHours,
      labels: matchedLabels,
    });
  }

  return events.sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1));
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
