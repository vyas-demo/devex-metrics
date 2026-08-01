/**
 * Core types for devex-metrics data collection.
 */

/** Top-level metrics for an org or user. */
export interface OrgMetrics {
  /**
   * Cache schema version. Compared against `CURRENT_SCHEMA_VERSION` in
   * `cache.ts` when loading cached data. Absent in pre-versioning fixtures.
   */
  schemaVersion?: number;
  /** GitHub org or user login name. */
  owner: string;
  /** Whether target is an organization or user. */
  ownerType: "org" | "user";
  /** Optional repository selection within the owner/user scope. */
  targetRepo?: string;
  /** ISO-8601 timestamp when data was collected. */
  collectedAt: string;
  /** Total number of repositories. */
  repoCount: number;
  /** Per-repo metrics. */
  repos: RepoMetrics[];
  /** Weekly activity trends aggregated across all repos (last ~2 years). */
  weeklyTrends?: WeeklyTrendPoint[];
  /** Requested Copilot report scope used to validate same-day cache reuse. */
  copilotUsageScope?: string;
  /** Copilot usage metrics from the current GitHub Copilot usage metrics report APIs. */
  copilotUsage?: CopilotUsageMetrics;
}

/** Aggregated metrics for a single repository. */
export interface RepoMetrics {
  name: string;
  fullName: string;
  /** ISO-8601 date when the repository was last pushed to. */
  pushedAt?: string;
  /** ISO-8601 timestamp when metrics for this repo were last collected. */
  collectedAt?: string;
  /** Issue counts by state. */
  issues: IssueCounts;
  /** Weekly activity trends for this repository (last ~2 years). */
  weeklyTrends?: WeeklyTrendPoint[];
  /** Pull request counts by state. */
  pullRequests: PullRequestCounts;
  /** Detailed PR metrics (sampled from recently closed PRs). */
  pullRequestDetails: PullRequestDetail[];
  /**
   * Enriched timeline of the last ~1 000 merged PRs (up to 10 pages × 100).
   * Includes author, timing, and issue-ref data extracted from the cheap
   * pulls.list call (no per-PR detail fetches).
   */
  mergedPRTimeline?: MergedPRSummary[];
  /** Per-repo Copilot adoption summary. */
  copilotAdoption?: CopilotAdoption;
  /** Lead-time data for issues referenced by merged PRs. */
  issueLeadTimes?: IssueLeadTime[];
  /** Unique committers in the default branch (last 90 days). */
  committerCount: number;
  /** Unique PR reviewers (last 90 days). */
  reviewerCount: number;
  /** Unique contributors (union of committers and reviewers, last 90 days). */
  contributorCount: number;
  /** Number of repositories that depend on this repo (from dependency graph). */
  dependentCount: number;
  /** Copilot agent (coding agent) task metrics for this repository. */
  copilotAgentMetrics?: CopilotAgentMetrics;
  /** Deployment and release events (last ~2 years, up to 100 each). */
  deployments?: DeploymentEvent[];
  /** Revert events derived from the merged-PR timeline. */
  reverts?: RevertEvent[];
  /** Labeled incident issues (last ~2 years, up to 100). */
  incidents?: IncidentEvent[];
}

export interface IssueCounts {
  open: number;
  closed: number;
}

export interface PullRequestCounts {
  open: number;
  closed: number;
  merged: number;
}

/** Detailed metrics for an individual pull request. */
export interface PullRequestDetail {
  number: number;
  title: string;
  state: string;
  /** ISO-8601 timestamp when the PR was created. */
  createdAt: string;
  /** GitHub login of the PR author. */
  author: string;
  /** True when the PR was authored by any AI tool (Copilot, Claude, or Codex). */
  isCopilotAuthored: boolean;
  /** Which AI tool authored this PR ('copilot', 'claude', or 'codex'); undefined for human/other-bot authors. */
  aiAuthorType?: "copilot" | "claude" | "codex";
  /** True when the PR received a review from copilot[bot] (Copilot Review). */
  hasCopilotReview: boolean;
  linesAdded: number;
  linesDeleted: number;
  commentCount: number;
  commitCount: number;
  /** Total GitHub Actions minutes consumed by check-suites on this PR (0 if unavailable). */
  actionsMinutes: number;
  /** Hours from PR created to PR merged (undefined if not merged). */
  timeToMergeHours?: number;
  /** ISO-8601 date when the PR was merged. */
  mergedAt?: string;
}

/** Lightweight timeline entry for each merged PR (from paginated pulls.list). */
export interface MergedPRSummary {
  /** PR number. */
  number: number;
  /** ISO-8601 timestamp when the PR was created. */
  createdAt: string;
  /** ISO-8601 timestamp when the PR was merged. */
  mergedAt: string;
  /** GitHub login of the PR author. */
  author: string;
  /** True when PR author is a bot (dependabot[bot], copilot[bot], etc.). */
  isBotAuthor: boolean;
  /** True when PR was authored by any AI tool (Copilot, Claude, or Codex). */
  isCopilotAuthored: boolean;
  /** Which AI tool authored this PR ('copilot', 'claude', or 'codex'); undefined for human/other-bot authors. */
  aiAuthorType?: "copilot" | "claude" | "codex";
  /** Hours from PR created to PR merged. */
  timeToMergeHours: number;
  /** Issue numbers referenced via "Fixes #N" / "Closes #N" in the PR body. */
  closesIssues: number[];
  /**
   * Lines added by this PR. Populated when the timeline is sourced from
   * GraphQL (which exposes additions/deletions on the PR node for free);
   * undefined when sourced from the REST fallback path, which only paginates
   * `pulls.list` and does not fetch per-PR detail.
   */
  linesAdded?: number;
  /** Lines deleted by this PR. See `linesAdded` for source caveats. */
  linesDeleted?: number;
  /**
   * True when the PR is a revert (title follows GitHub's `Revert "…"`
   * convention). Used as the change-failure signal for DORA metrics.
   */
  isRevert?: boolean;
  /**
   * Hours from PR creation to the first submitted review by someone other
   * than the PR author. Undefined when the PR received no such review or
   * when the timeline was sourced from the REST fallback path.
   */
  timeToFirstReviewHours?: number;
  /**
   * Logins that submitted at least one review on this PR (excluding the PR
   * author). Only populated on the GraphQL path; used for reviewer-load
   * analytics.
   */
  reviewers?: string[];
}

// ── DORA & delivery types ─────────────────────────────────────────────────────

/** A deployment-like event (GitHub deployment or release) for a repository. */
export interface DeploymentEvent {
  /** ISO-8601 timestamp when the deployment/release was created. */
  createdAt: string;
  /** Where the event came from. */
  source: "deployment" | "release";
  /** Deployment environment (deployments only), e.g. "production". */
  environment?: string;
  /** Latest deployment status state when available, e.g. "success". */
  state?: string;
  /** Release tag name (releases only). */
  tagName?: string;
}

/**
 * A labeled incident issue used as a real change-failure / MTTR signal.
 * Collected from issues carrying an incident label (configurable via
 * `incidentLabels` in devex.config.json; sensible defaults otherwise).
 */
export interface IncidentEvent {
  /** Issue number. */
  number: number;
  /** ISO-8601 timestamp when the incident issue was opened. */
  createdAt: string;
  /** ISO-8601 timestamp when it was closed; undefined while still open. */
  closedAt?: string;
  /** Hours from opened to closed; undefined while still open. */
  resolutionHours?: number;
  /** Label names that matched the incident label set. */
  labels: string[];
}

/** A revert event linking a revert PR to the PR it reverted when resolvable. */
export interface RevertEvent {
  /** PR number of the revert. */
  revertPRNumber: number;
  /** ISO-8601 timestamp when the revert PR was merged. */
  revertMergedAt: string;
  /** PR number of the reverted change when it could be matched by title. */
  originalPRNumber?: number;
  /** ISO-8601 merge timestamp of the reverted change when matched. */
  originalMergedAt?: string;
  /** Hours from the original merge to the revert merge (restore-time proxy). */
  restoreHours?: number;
}

/** Per-repo Copilot adoption summary. */
export interface CopilotAdoption {
  /** Number of merged PRs authored by any AI tool (Copilot, Claude, or Codex). */
  copilotAuthoredPRs: number;
  /** Number of detailed PRs that received a Copilot review. */
  copilotReviewedPRs: number;
  /** Total merged PRs in the timeline (denominator for authored %). */
  totalMergedPRs: number;
  /** Total detailed PRs sampled (denominator for reviewed %). */
  totalDetailedPRs: number;
}

/** Lead-time data for an issue resolved by a merged PR. */
export interface IssueLeadTime {
  /** The issue number. */
  issueNumber: number;
  /** ISO-8601 timestamp when the issue was created. */
  issueCreatedAt: string;
  /** The PR number that closed this issue. */
  prNumber: number;
  /** ISO-8601 timestamp when the closing PR was merged. */
  prMergedAt: string;
  /** Hours from issue creation to PR merge. */
  leadTimeHours: number;
}

/** One data point in a weekly activity trend series. */
export interface WeeklyTrendPoint {
  /** ISO week label, e.g. "2024-W03". */
  week: string;
  prsOpened: number;
  prsMerged: number;
  issuesOpened: number;
  issuesClosed: number;
  /** Total lines added across all merged PRs in this week. */
  linesAdded: number;
  /** Total lines deleted across all merged PRs in this week. */
  linesDeleted: number;
}

// ── Engineering intelligence (per-developer & AI-impact analytics) ───────────

/**
 * Aggregated engineering metrics for a single developer, derived from the
 * merged-PR timelines across all repos in the collection window. Purely
 * computed — no additional API calls beyond what `collect` already gathers.
 */
export interface DeveloperStats {
  /** GitHub login of the developer. */
  login: string;
  /** True when the login is a bot account (dependabot[bot], etc.). */
  isBot: boolean;
  /** Merged PRs authored by this developer in the window. */
  mergedPRs: number;
  /** Total lines added across their merged PRs (0 when line data unavailable). */
  linesAdded: number;
  /** Total lines deleted across their merged PRs (0 when line data unavailable). */
  linesDeleted: number;
  /** linesAdded + linesDeleted. */
  linesChanged: number;
  /** Median PR size (lines changed) over merged PRs with line data. */
  medianPRSizeLines: number;
  /** Median hours from PR created to merged over their merged PRs. */
  medianCycleHours: number;
  /** Distinct repositories this developer merged PRs into. */
  reposContributed: number;
  /**
   * Calibrated output measure: each merged PR contributes
   * clamp(log2(1 + linesChanged / 32), 0.25, 4) work units, so a ~32-line PR
   * ≈ 1 unit and a giant PR cannot dominate. PRs without line data count 1.
   */
  workUnits: number;
  /** ISO-8601 timestamp of their earliest merge in the window. */
  firstMergedAt?: string;
  /** ISO-8601 timestamp of their latest merge in the window. */
  lastMergedAt?: string;
}

/** Percentile benchmark set for a metric across the developer population. */
export interface Benchmark {
  /** Median (50th percentile) — the typical developer. */
  p50: number;
  /** 90th percentile — the "top 10%" threshold. */
  p90: number;
  /** 99th percentile — the "top 1%" threshold. */
  p99: number;
  /** Maximum observed value. */
  max: number;
}

/** Cycle time and size for one AI authoring tool. */
export interface AiToolImpact {
  /** Tool name ('copilot', 'claude', 'codex'). */
  tool: string;
  /** Merged PRs authored by this tool. */
  mergedPRs: number;
  /** Median hours from created to merged for this tool's PRs. */
  medianCycleHours: number;
  /** Median lines changed for this tool's PRs (0 when line data unavailable). */
  medianPRSize: number;
}

/** Comparison of AI-authored vs human-authored contribution. */
export interface AiImpactStats {
  /** Merged PRs authored by any AI tool. */
  aiMergedPRs: number;
  /** Merged PRs authored by humans (non-bot, non-AI). */
  humanMergedPRs: number;
  /** aiMergedPRs / (aiMergedPRs + humanMergedPRs); 0 when no data. */
  aiShare: number;
  /** Median cycle hours for AI-authored PRs. */
  aiMedianCycleHours: number;
  /** Median cycle hours for human-authored PRs. */
  humanMedianCycleHours: number;
  /** Median lines changed for AI-authored PRs. */
  aiMedianPRSize: number;
  /** Median lines changed for human-authored PRs. */
  humanMedianPRSize: number;
  /** Per-tool breakdown, sorted by mergedPRs desc. */
  byTool: AiToolImpact[];
}

/**
 * Team-wide engineering intelligence: a per-developer leaderboard plus
 * percentile benchmarks and an AI-impact comparison. Mirrors the
 * "output per engineer with percentile benchmarking" model.
 */
export interface EngineeringIntelligence {
  /** True when at least one merged PR with an identifiable author was found. */
  hasData: boolean;
  /** Per-developer stats, sorted by mergedPRs desc. Excludes bots. */
  developers: DeveloperStats[];
  /** Distinct non-bot developers with at least one merged PR. */
  contributorCount: number;
  /** Total merged PRs analyzed (human authors only). */
  totalMergedPRs: number;
  /** Benchmark of merged-PR counts across developers. */
  throughputBenchmark: Benchmark;
  /** Benchmark of per-developer median cycle hours. */
  cycleTimeBenchmark: Benchmark;
  /** Benchmark of per-developer median PR size (lines changed). */
  prSizeBenchmark: Benchmark;
  /** Benchmark of per-developer calibrated work units. */
  workUnitsBenchmark: Benchmark;
  /** AI vs human contribution comparison. */
  aiImpact: AiImpactStats;
}

// ── DORA & review-analytics computed types ────────────────────────────────────

/** DORA performance tier per dora.dev benchmark thresholds. */
export type DoraTier = "elite" | "high" | "medium" | "low";

/** One DORA metric with its value and benchmark tier. */
export interface DoraMetric {
  /** Metric value (unit depends on the metric; 0/undefined-safe). */
  value: number;
  /** Benchmark tier, undefined when there is no data to classify. */
  tier?: DoraTier;
  /** True when the underlying signal had at least one data point. */
  hasData: boolean;
}

/**
 * DORA metrics computed from merged-PR, deployment, and revert signals.
 * Deploy frequency uses deployments/releases; lead time uses PR
 * created→merged as the change proxy; change-failure rate and MTTR use
 * revert PRs as the failure signal.
 */
export interface DoraMetrics {
  /** True when any of the four metrics has data. */
  hasData: boolean;
  /** Days covered by the analysis window. */
  windowDays: number;
  /** Deploys per week (deployments + releases). */
  deployFrequencyPerWeek: DoraMetric;
  /** Median hours from PR created to merged. */
  leadTimeHours: DoraMetric;
  /** Revert PRs / merged PRs, as a ratio in [0,1]. */
  changeFailureRate: DoraMetric;
  /** Median hours from original merge to revert merge (restore proxy). */
  mttrHours: DoraMetric;
  /** Total deploy-like events in the window. */
  totalDeploys: number;
  /** Total merged PRs in the window (CFR denominator). */
  totalMergedPRs: number;
  /** Total revert PRs in the window (CFR numerator when using reverts). */
  totalReverts: number;
  /**
   * Which signal fed change-failure rate and MTTR: labeled incident issues
   * (when the org has any) or revert-PR proxies. Absent in data computed
   * before incident collection existed — treat as "reverts".
   */
  failureSignal?: "incidents" | "reverts";
  /** Incidents opened in the window (CFR numerator when using incidents). */
  totalIncidents?: number;
}

/** Review activity for one reviewer across the merged-PR timeline. */
export interface ReviewerStats {
  /** Reviewer login. */
  login: string;
  /** Distinct merged PRs this login reviewed. */
  prsReviewed: number;
  /** Share of all reviewed PRs this login covered, in [0,1]. */
  loadShare: number;
}

/** Code-review analytics computed from the merged-PR timeline. */
export interface ReviewStats {
  /** True when at least one PR had review data. */
  hasData: boolean;
  /** Merged PRs that received at least one review. */
  reviewedPRs: number;
  /** Merged PRs with review data available (denominator). */
  totalPRs: number;
  /** reviewedPRs / totalPRs in [0,1]. */
  reviewCoverage: number;
  /** Median hours from PR created to first review. */
  medianTimeToFirstReviewHours: number;
  /** p90 hours from PR created to first review. */
  p90TimeToFirstReviewHours: number;
  /** Per-reviewer load, sorted by prsReviewed desc. Excludes bots. */
  reviewers: ReviewerStats[];
  /** Share of all reviews carried by the single busiest reviewer, in [0,1]. */
  topReviewerShare: number;
}

// ── Insights engine (automated findings) ─────────────────────────────────────

/** Severity level of an automatically generated insight. */
export type InsightSeverity = "critical" | "warning" | "info" | "positive";

/** One automatically generated, evidence-backed finding. */
export interface Insight {
  /** Stable detector id, e.g. "review-bottleneck". */
  id: string;
  severity: InsightSeverity;
  /** Short headline, e.g. "Review load concentrated on one person". */
  title: string;
  /** Evidence-backed detail with concrete numbers. */
  detail: string;
  /** Actionable next step; omitted for purely informational insights. */
  recommendation?: string;
  /** Repo fullName when the insight is scoped to a single repository. */
  repo?: string;
}

/** Result of running all insight detectors over collected metrics. */
export interface InsightsSummary {
  /** True when at least one detector had enough data to run. */
  hasData: boolean;
  /** Insights sorted by severity (critical → warning → info → positive). */
  insights: Insight[];
  /** Count of insights per severity. */
  counts: Record<InsightSeverity, number>;
}

// ── Repo health scores ────────────────────────────────────────────────────────

/** One weighted component of a repository health score. */
export interface HealthComponent {
  /** Component id, e.g. "activity", "review-coverage". */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Component score 0–100; undefined when the underlying signal has no data. */
  score?: number;
  /** Relative weight used when combining components with data. */
  weight: number;
  /** One-line explanation of the score with its evidence. */
  detail: string;
}

/** Letter grade derived from a 0–100 health score. */
export type HealthGrade = "A" | "B" | "C" | "D" | "F";

/** Composite health assessment for one repository. */
export interface RepoHealth {
  /** Repository fullName (owner/name). */
  fullName: string;
  /** Weighted composite score 0–100 over components with data. */
  score: number;
  /** Letter grade: A ≥85, B ≥70, C ≥55, D ≥40, F otherwise. */
  grade: HealthGrade;
  /** Individual scored components. */
  components: HealthComponent[];
  /** True when score < 55 (grade D or worse) and the repo shows activity. */
  needsAttention: boolean;
}

/** Health scores across all repositories. */
export interface HealthReport {
  /** True when at least one repo could be scored. */
  hasData: boolean;
  /** Per-repo health, sorted by score ascending (worst first). */
  repos: RepoHealth[];
  /** Mean composite score across scored repos. */
  avgScore: number;
}

// ── Collaboration network ─────────────────────────────────────────────────────

/** One directed author→reviewer edge in the collaboration graph. */
export interface CollaborationEdge {
  /** PR author login. */
  author: string;
  /** Reviewer login. */
  reviewer: string;
  /** Merged PRs by this author reviewed by this reviewer. */
  prCount: number;
}

/** Author-concentration (bus factor) data for one repository. */
export interface RepoBusFactor {
  /** Repository fullName. */
  fullName: string;
  /** Smallest number of authors covering ≥50% of merged PRs. */
  busFactor: number;
  /** Share of merged PRs by the single most prolific author, in [0,1]. */
  topAuthorShare: number;
  /** Merged human-authored PRs analyzed. */
  mergedPRs: number;
}

/** Collaboration-network analytics computed from merged-PR review data. */
export interface CollaborationStats {
  /** True when at least one human-authored merged PR was found. */
  hasData: boolean;
  /** Strongest author→reviewer edges, sorted by prCount desc. */
  edges: CollaborationEdge[];
  /** Gini coefficient over reviewer load, in [0,1] (1 = fully concentrated). */
  reviewerGini: number;
  /** Per-repo author concentration, sorted by busFactor asc (riskiest first). */
  busFactors: RepoBusFactor[];
  /** Human contributors whose merged PRs all landed in a single repo (min 3 PRs). */
  siloedContributors: string[];
  /** Distinct human PR authors seen. */
  distinctAuthors: number;
  /** Distinct human reviewers seen. */
  distinctReviewers: number;
}

// ── History snapshots & deltas (Phase 2: memory) ─────────────────────────────

/**
 * Compact daily rollup of key metrics, appended to a per-target history file
 * on every collection so the dashboard can show real week-over-week deltas
 * instead of re-deriving trends from PR timestamps alone.
 */
export interface HistorySnapshot {
  /** ISO-8601 date (YYYY-MM-DD) this snapshot represents. */
  date: string;
  /** ISO-8601 timestamp of the collection that produced it. */
  collectedAt: string;
  /** Total repositories. */
  repoCount: number;
  /** Open issues across all repos. */
  openIssues: number;
  /** Open PRs across all repos. */
  openPRs: number;
  /** Merged PRs in the trailing 30 days. */
  mergedPRs30d: number;
  /** Median hours created→merged over the trailing 30 days (0 = no data). */
  medianCycleHours30d: number;
  /** Review coverage ratio over the trailing 30 days, in [0,1]. */
  reviewCoverage30d: number;
  /** Distinct human developers with ≥1 merged PR (full window). */
  contributorCount: number;
  /** Mean composite repo health score (0–100). */
  avgHealthScore: number;
  /** Repos flagged needs-attention by the health report. */
  needsAttentionCount: number;
  /** AI share of merged PRs (full window), in [0,1]. */
  aiShare: number;
  /** Deploy-like events in the trailing 30 days. */
  deploys30d: number;
  /** Revert PRs in the trailing 30 days. */
  reverts30d: number;
  /** Copilot active users when usage data was collected. */
  copilotActiveUsers?: number;
}

/** Shape of the on-disk per-target history file (`data/<key>-history.json`). */
export interface HistoryFile {
  /** History file schema version (independent of the cache schema). */
  schemaVersion: number;
  /** Cache target key this history belongs to. */
  targetKey: string;
  /** Snapshots in ascending date order; ring-buffer trimmed. */
  snapshots: HistorySnapshot[];
}

/** Change in one metric between the latest snapshot and a baseline snapshot. */
export interface MetricDelta {
  /** Metric id, e.g. "mergedPRs30d". */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Latest value. */
  current: number;
  /** Baseline value. */
  previous: number;
  /** current − previous. */
  delta: number;
  /** delta / previous; undefined when previous is 0. */
  pctChange?: number;
  /** Which direction is an improvement for this metric. */
  goodDirection: "up" | "down";
}

/** Deltas of the latest snapshot vs a ~7-day-old baseline snapshot. */
export interface HistoryDeltas {
  /** True when a usable baseline snapshot existed. */
  hasData: boolean;
  /** Date of the baseline snapshot compared against. */
  baselineDate?: string;
  /** Days between latest and baseline snapshots. */
  daysSpanned?: number;
  /** Per-metric deltas (only metrics present in both snapshots). */
  deltas: MetricDelta[];
}

// ── Delivery forecast (Phase 2: foresight) ────────────────────────────────────

/** Forecast for delivering one target count of merged PRs. */
export interface ForecastTarget {
  /** Number of merged PRs forecast. */
  prCount: number;
  /** Weeks needed at 50% confidence. */
  p50Weeks: number;
  /** Weeks needed at 85% confidence. */
  p85Weeks: number;
  /** Weeks needed at 95% confidence. */
  p95Weeks: number;
  /** ISO-8601 date (YYYY-MM-DD) of the 50% confidence completion. */
  p50Date: string;
  /** ISO-8601 date of the 85% confidence completion. */
  p85Date: string;
  /** ISO-8601 date of the 95% confidence completion. */
  p95Date: string;
}

/** Monte-Carlo delivery forecast built from weekly merge throughput. */
export interface DeliveryForecast {
  /** True when enough throughput history existed to simulate. */
  hasData: boolean;
  /** Completed weeks sampled from. */
  sampleWeeks: number;
  /** Median weekly merged-PR throughput of the sample. */
  medianWeeklyThroughput: number;
  /** Forecasts per PR-count target, ascending by prCount. */
  targets: ForecastTarget[];
}

// ── Team targets (Phase 2: goals) ─────────────────────────────────────────────

/** One collection target inside a multi-owner rollup. */
export interface RollupTarget {
  /** GitHub org or user login. */
  owner: string;
  /** Whether the owner is an organization or user. */
  ownerType: "org" | "user";
  /** Optional repo scope within the owner (name or owner/repo). */
  repo?: string;
}

/** Multi-owner rollup configuration: one dashboard across several targets. */
export interface RollupConfig {
  /** Display name and cache key for the merged view. */
  name: string;
  /** Targets whose per-owner caches are merged. Each must be collected first. */
  targets: RollupTarget[];
}

/** Optional team-set thresholds loaded from `devex.config.json`. */
export interface TargetsConfig {
  /**
   * Issue label names treated as incidents for DORA CFR/MTTR (matched
   * case-insensitively). Defaults to incident/outage/sev1/sev2/
   * production-incident when omitted.
   */
  incidentLabels?: string[];
  /** Multi-owner rollup definition consumed by the --rollup CLI mode. */
  rollup?: RollupConfig;
  targets: {
    /** Median PR cycle time must stay under this many hours. */
    maxMedianCycleHours?: number;
    /** Review coverage must be at least this ratio, in [0,1]. */
    minReviewCoverage?: number;
    /** Change-failure rate must stay under this ratio, in [0,1]. */
    maxChangeFailureRate?: number;
    /** Deploy frequency must be at least this many per week. */
    minDeploysPerWeek?: number;
    /** p90 time to first review must stay under this many hours. */
    maxP90FirstReviewHours?: number;
    /** Average repo health score must be at least this value (0–100). */
    minAvgHealthScore?: number;
  };
}

/** Result of evaluating one configured target against current metrics. */
export interface TargetEvaluation {
  /** Target id, e.g. "max-median-cycle-hours". */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Configured threshold. */
  target: number;
  /** Observed value. */
  actual: number;
  /** True when the target is met. */
  met: boolean;
  /** True when the underlying signal had data to evaluate. */
  hasData: boolean;
  /** One-line evidence sentence. */
  detail: string;
}

/** Shape of the on-disk cache file. */
export interface CacheEnvelope {
  /** ISO-8601 date (YYYY-MM-DD) the data was collected. */
  date: string;
  data: OrgMetrics;
}

// ── Copilot Agent (coding agent / cloud agent) types ──────────────────────────

/** An individual session within a Copilot agent task. */
export interface CopilotAgentSession {
  /** Session UUID. */
  id: string;
  /** Session state (e.g. "completed", "failed", "in_progress"). */
  state: string;
  /**
   * Detected session source.
   * `cloud-agent` when the session has a non-empty model string or a `usage`
   * field (Copilot coding agent / cloud agent).
   * `cli-remote` otherwise (Copilot CLI / remote session).
   */
  source: "cloud-agent" | "cli-remote";
  /** Branch the session worked on. */
  headRef?: string;
  /** Base branch the session branched from. */
  baseRef?: string;
  /** Model identifier with the "sweagent-capi:" prefix stripped. */
  model?: string;
  /** ISO-8601 timestamp when the session was created. */
  createdAt: string;
  /** ISO-8601 timestamp when the session completed (terminal states only). */
  completedAt?: string;
  /** Credits consumed (cloud-agent sessions only, if reported by the API). */
  usageCredits?: number;
  /** Credit type (e.g. "premium"). */
  usageType?: string;
  /** Error message if the session failed. */
  errorMessage?: string;
  /** Hours from `createdAt` to `completedAt` (undefined when not completed). */
  durationHours?: number;
}

/** A Copilot agent task. One task can spawn multiple sessions. */
export interface CopilotAgentTask {
  /** Task UUID. */
  id: string;
  /** Human-readable task name (typically the user prompt summary). */
  name: string;
  /** Task state (e.g. "completed", "failed", "in_progress"). */
  state: string;
  /** ISO-8601 timestamp when the task was created. */
  createdAt: string;
  /** ISO-8601 timestamp when the task was last updated. */
  updatedAt: string;
  /** URL to the task in the GitHub UI. */
  htmlUrl: string;
  /** Sessions that ran as part of this task. */
  sessions: CopilotAgentSession[];
  /** PR numbers produced by this task (resolved from task artifacts). */
  prNumbers: number[];
}

/** Aggregated Copilot agent metrics for a single repository. */
export interface CopilotAgentMetrics {
  /** Total agent tasks in the collection window. */
  totalTasks: number;
  /** Tasks in the `completed` terminal state. */
  completedTasks: number;
  /** Tasks in the `failed` terminal state. */
  failedTasks: number;
  /** Tasks in the `cancelled` terminal state. */
  cancelledTasks: number;
  /** Tasks in the `timed_out` terminal state. */
  timedOutTasks: number;
  /** Tasks currently in an active state (in_progress / queued / idle / waiting_for_user). */
  activeTasksCount: number;
  /** Total sessions across all tasks. */
  totalSessions: number;
  /** Sessions identified as Copilot cloud agent sessions. */
  cloudAgentSessions: number;
  /** Sessions identified as Copilot CLI / remote sessions. */
  cliRemoteSessions: number;
  /** Sum of credits consumed across all cloud-agent sessions. */
  totalCreditsUsed: number;
  /** Average duration in hours for sessions that have completed. */
  avgCompletedSessionHours?: number;
  /** ISO-8601 timestamp of the most recently created task in this window. */
  lastTaskAt?: string;
  /** Number of distinct PRs produced by agent tasks. */
  agentCreatedPRs: number;
  /** Total GitHub Actions check-run minutes consumed on PRs created by agent tasks. */
  agentActionsMinutes: number;
}

/** Shape of the per-repo agent cache file (`data/agents-{owner}-{repo}.json`). */
export interface CopilotAgentRepoCache {
  /** Cache schema version. Bump in agent-cache.ts when the stored shape changes. */
  schemaVersion: number;
  /** Repository owner. */
  owner: string;
  /** Repository name. */
  repo: string;
  /** ISO-8601 timestamp of last active-tasks refresh. */
  activeRefreshedAt: string;
  /**
   * Tasks in terminal states (completed / failed / cancelled / timed_out).
   * These are cached permanently — terminal task data is immutable.
   */
  terminalTasks: CopilotAgentTask[];
  /** Tasks in active states — replaced on each fresh collection. */
  activeTasks: CopilotAgentTask[];
  /**
   * Cached GitHub Actions check-run minutes per PR number (string key).
   * Only closed/merged PRs are cached here; open PRs are refetched each run.
   */
  perPRActionsMinutes?: Record<string, number>;
}

// ── Copilot usage metrics report types ──────────────────────────────────────

/** Aggregated counter set shared by Copilot usage summaries. */
export interface CopilotUsageCounters {
  /** Number of explicit user prompts sent to Copilot. */
  userInitiatedInteractions: number;
  /** Number of generated Copilot output events. */
  codeGenerations: number;
  /** Number of accepted Copilot suggestions or generated blocks. */
  codeAcceptances: number;
  /** Lines Copilot suggested adding. */
  locSuggestedToAdd: number;
  /** Lines Copilot suggested deleting. */
  locSuggestedToDelete: number;
  /** Lines added to the editor from Copilot activity. */
  locAdded: number;
  /** Lines deleted from the editor from Copilot activity. */
  locDeleted: number;
  /** Acceptance rate as a percentage, derived from acceptances / generations. */
  acceptanceRate: number;
}

/** CLI-specific Copilot usage counters. */
export interface CopilotUsageCliMetrics {
  /** Number of distinct Copilot CLI sessions. */
  sessionCount: number;
  /** Number of Copilot CLI requests, including follow-up agentic calls. */
  requestCount: number;
  /** Number of user prompts, commands, or queries in Copilot CLI. */
  promptCount: number;
  /** Prompt tokens sent to Copilot CLI. */
  promptTokens: number;
  /** Output tokens generated by Copilot CLI. */
  outputTokens: number;
  /** Average prompt + output tokens per CLI request. */
  avgTokensPerRequest: number;
  /** Most recent Copilot CLI version detected. */
  lastKnownCliVersion?: string;
  /** Timestamp when the CLI version sample was captured. */
  lastKnownCliVersionSampledAt?: string;
}

/** Copilot pull request metrics reported by the usage metrics API. */
export interface CopilotPullRequestActivity {
  /** Pull requests created on the reporting day/window. */
  totalCreated: number;
  /** Pull requests reviewed on the reporting day/window. */
  totalReviewed: number;
  /** Pull requests merged on the reporting day/window. */
  totalMerged: number;
  /** Median minutes from PR creation to merge, or null when no qualifying PR was merged. */
  medianMinutesToMerge: number | null;
  /** Pull request review suggestions generated by all authors. */
  totalSuggestions: number;
  /** Pull request review suggestions applied by users. */
  totalAppliedSuggestions: number;
  /** Pull requests created by Copilot. */
  totalCreatedByCopilot: number;
  /** Pull requests reviewed by Copilot code review. */
  totalReviewedByCopilot: number;
  /** Copilot-created pull requests merged during the reporting day/window. */
  totalMergedCreatedByCopilot: number;
  /** Pull requests merged after Copilot code review during the reporting day/window. */
  totalMergedReviewedByCopilot: number;
  /** Median minutes to merge for Copilot-authored PRs, or null when unavailable. */
  medianMinutesToMergeCopilotAuthored: number | null;
  /** Median minutes to merge for Copilot-reviewed PRs, or null when unavailable. */
  medianMinutesToMergeCopilotReviewed: number | null;
  /** Pull request review suggestions generated by Copilot. */
  totalCopilotSuggestions: number;
  /** Copilot review suggestions applied by users. */
  totalCopilotAppliedSuggestions: number;
  /** Copilot review suggestions grouped by API comment type. */
  copilotSuggestionsByCommentType: CopilotReviewCommentTypeBreakdown[];
}

/** GitHub's rolling 28-day Copilot adoption classification for one user. */
export interface CopilotAiAdoptionPhase {
  /** Numeric phase identifier assigned by GitHub. */
  phaseNumber: number;
  /** API phase label, such as No Cohort or Phase 3. */
  phase: string;
  /** Version of GitHub's phase-classification model. */
  version: string;
}

/** Delivery activity associated with one Copilot adoption phase. */
export interface CopilotAiAdoptionPhaseImpact {
  /** Numeric phase identifier assigned by GitHub. */
  phaseNumber: number;
  /** API phase label, such as No Cohort or Phase 3. */
  phase: string;
  /** Users represented by this phase on the aggregate report day. */
  totalEngagedUsers: number;
  /** Average user-initiated Copilot interactions per user. */
  avgUserInitiatedInteractions: number;
  /** Average code-generation activities per user. */
  avgCodeGenerationActivities: number;
  /** Average code-acceptance activities per user. */
  avgCodeAcceptanceActivities: number;
  /** Average lines added per user. */
  avgLocAdded: number;
  /** Average lines deleted per user. */
  avgLocDeleted: number;
  /** Average pull requests reviewed per user. */
  avgPullRequestsReviewed: number;
  /** Average pull requests created per user. */
  avgPullRequestsCreated: number;
  /** Average pull requests merged per user. */
  avgPullRequestsMerged: number;
  /** Total pull requests merged by users in this phase. */
  totalPullRequestsMerged: number;
  /** Average of per-user median minutes to merge. */
  avgPullRequestsMedianMinutesToMerge: number;
  /** Average minutes from pull-request creation to first review when reported. */
  avgPullRequestsMinutesToReview?: number;
  /** Average pull-request review cycles when reported. */
  avgPullRequestsReviewCycles?: number;
}

/** Latest-day summary used to present Copilot adoption and delivery associations. */
export interface CopilotAdoptionImpactSummary {
  /** Aggregate report day represented by this snapshot. */
  day: string;
  /** Adoption phases reported for the snapshot day. */
  phases: CopilotAiAdoptionPhaseImpact[];
  /** Users across all reported phases. */
  totalUsers: number;
  /** Users in Phase 1 or higher. */
  engagedUsers: number;
  /** Share of reported users in Phase 1 or higher, in [0,1]. */
  engagedShare: number;
  /** User-weighted average merged PRs for Phase 1 or higher. */
  engagedAvgPullRequestsMerged?: number;
  /** User-weighted average merged PRs for the passive cohort. */
  passiveAvgPullRequestsMerged?: number;
  /** Engaged average divided by passive average when both are defined and non-zero. */
  mergedPullRequestAssociation?: number;
}

/** Daily pull-request activity for one repository from the Copilot usage API. */
export interface CopilotRepositoryUsageMetrics {
  /** Report day in YYYY-MM-DD format. */
  day: string;
  /** Enterprise identifier when the organization belongs to an enterprise. */
  enterpriseId?: string;
  /** Organization identifier reported by GitHub. */
  organizationId: string;
  /** Repository identifier reported by GitHub. */
  repoId: string;
  /** Repository owner login. */
  owner: string;
  /** Repository name. */
  name: string;
  /** Owner-qualified repository name. */
  fullName: string;
  /** API visibility value, such as PRIVATE, INTERNAL, or PUBLIC. */
  visibility: string;
  /** Pull-request and Copilot-review activity for the report day. */
  pullRequests: CopilotPullRequestActivity;
}

/** Latest available daily repository-level Copilot usage report. */
export interface CopilotRepositoryUsageReport {
  /** Day represented by the repository report. */
  reportDay: string;
  /** Repositories with pull-request activity on the report day. */
  repositories: CopilotRepositoryUsageMetrics[];
}

/** Copilot review suggestion counts for one API comment type. */
export interface CopilotReviewCommentTypeBreakdown {
  /** Comment type assigned by Copilot code review, e.g. security or bug_risk. */
  commentType: string;
  /** Copilot suggestions generated for this comment type. */
  totalCopilotSuggestions: number;
  /** Copilot suggestions applied for this comment type. */
  totalCopilotAppliedSuggestions: number;
}

/** Trailing active/passive Copilot code review user counts. */
export interface CopilotCodeReviewUsage {
  /** Active Copilot code review users on the report day. */
  dailyActiveUsers: number;
  /** Passive Copilot code review users on the report day. */
  dailyPassiveUsers: number;
  /** Active Copilot code review users in the trailing 7-day window. */
  weeklyActiveUsers: number;
  /** Passive Copilot code review users in the trailing 7-day window. */
  weeklyPassiveUsers: number;
  /** Active Copilot code review users in the trailing 28-day window. */
  monthlyActiveUsers: number;
  /** Passive Copilot code review users in the trailing 28-day window. */
  monthlyPassiveUsers: number;
}

/** Organization Copilot billing and policy settings when available. */
export interface CopilotBillingSettings {
  /** Assigned Copilot seats. */
  assignedSeats: number;
  /** Seats added in the current billing cycle. */
  addedThisCycle: number;
  /** Seats with pending invitations. */
  pendingInvitation: number;
  /** Seats pending cancellation. */
  pendingCancellation: number;
  /** Seats active in the current billing cycle. */
  activeThisCycle: number;
  /** Seats inactive in the current billing cycle. */
  inactiveThisCycle: number;
  /** Seat assignment policy, e.g. assign_all or assign_selected. */
  seatManagementSetting?: string;
  /** IDE chat policy state. */
  ideChat?: string;
  /** GitHub.com chat policy state. */
  platformChat?: string;
  /** Copilot CLI policy state. */
  cli?: string;
  /** Public code suggestions policy state. */
  publicCodeSuggestions?: string;
  /** Copilot plan type. */
  planType?: string;
}

/** Top-level Copilot usage totals for the report window. */
export interface CopilotUsageTotals extends CopilotUsageCounters {
  /** Users represented in the report or seat list. */
  totalUsers: number;
  /** Users with any Copilot activity in the report window. */
  activeUsers: number;
  /** Users who used IDE chat in the report window. */
  chatUsers: number;
  /** Users who used IDE agent mode in the report window. */
  agentUsers: number;
  /** Users who used Copilot CLI in the report window. */
  cliUsers: number;
  /** Users who actively engaged with Copilot code review. */
  codeReviewActiveUsers: number;
  /** Users who passively received Copilot code review. */
  codeReviewPassiveUsers: number;
  /** Assigned Copilot seats reported by the user management API. */
  assignedSeats: number;
  /** Assigned seats with recent activity from the seat API. */
  seatsActiveThisCycle: number;
}

/** A named Copilot usage breakdown row (feature, IDE, language, model, or team). */
export interface CopilotUsageBreakdown extends CopilotUsageCounters {
  /** Display name for the breakdown bucket. */
  name: string;
  /** Number of distinct users contributing to this bucket when available. */
  users: number;
  /** Copilot feature represented by this bucket when available. */
  feature?: string;
  /** IDE represented by this bucket when available. */
  ide?: string;
  /** Programming language represented by this bucket when available. */
  language?: string;
  /** Model represented by this bucket when available. */
  model?: string;
  /** Whether the model is a custom model. */
  isCustomModel?: boolean;
  /** Training date for a custom model. */
  customModelTrainingDate?: string;
}

/** IDE/plugin version coverage row inferred from usage breakdown metadata. */
export interface CopilotUsageIdeVersionMetrics {
  /** IDE name. */
  ide: string;
  /** Last known IDE version. */
  ideVersion?: string;
  /** Copilot plugin or extension name. */
  plugin?: string;
  /** Last known Copilot plugin or extension version. */
  pluginVersion?: string;
  /** Latest sample timestamp seen for this IDE/plugin/version tuple. */
  sampledAt?: string;
  /** Distinct users represented by this tuple. */
  users: number;
}

/** Per-user Copilot usage summary for the report window. */
export interface CopilotUsageUserMetrics extends CopilotUsageCounters {
  /** GitHub login. */
  login: string;
  /** GitHub user id as reported by the usage API. */
  userId?: string;
  /** Days in the report window with activity for this user. */
  activeDays: number;
  /** Most recent report day for this user's usage row. */
  lastUsageDay?: string;
  /** GitHub's rolling Copilot adoption phase for this user when reported. */
  aiAdoptionPhase?: CopilotAiAdoptionPhase;
  /** Team slugs joined from the user-teams report when available. */
  teams: string[];
  /** True when the user used IDE chat during the report window. */
  usedChat: boolean;
  /** True when the user used IDE agent mode during the report window. */
  usedAgent: boolean;
  /** True when the user used Copilot CLI during the report window. */
  usedCli: boolean;
  /** True when the user actively engaged with Copilot code review. */
  usedCodeReviewActive: boolean;
  /** True when the user passively received Copilot code review. */
  usedCodeReviewPassive: boolean;
  /** CLI-specific usage for this user. */
  cli?: CopilotUsageCliMetrics;
  /** Most recent IDE version observed in usage report breakdowns. */
  lastKnownIdeVersion?: string;
  /** Most recent Copilot plugin or extension version observed in usage report breakdowns. */
  lastKnownPluginVersion?: string;
  /** Name of the Copilot plugin or extension when reported. */
  lastKnownPlugin?: string;
  /** ISO-8601 timestamp when the Copilot seat was assigned. */
  seatCreatedAt?: string;
  /** ISO-8601 timestamp when the Copilot seat was last updated. */
  seatUpdatedAt?: string;
  /** ISO-8601 date when the seat is pending cancellation. */
  pendingCancellationDate?: string;
  /** Last Copilot activity timestamp from the seat API. */
  lastActivityAt?: string;
  /** Last editor/surface from the seat API. */
  lastActivityEditor?: string;
  /** Last authentication timestamp from the seat API. */
  lastAuthenticatedAt?: string;
  /** Copilot plan type for the seat. */
  planType?: string;
}

/** Daily Copilot usage total from the organization or enterprise aggregate report. */
export interface CopilotUsageDailyTotal extends CopilotUsageCounters {
  /** Report day in YYYY-MM-DD format. */
  day: string;
  /** Daily active users for the scope. */
  dailyActiveUsers: number;
  /** Trailing weekly active users for the scope. */
  weeklyActiveUsers: number;
  /** Trailing monthly active users for the scope. */
  monthlyActiveUsers: number;
  /** Daily active CLI users for the scope. */
  dailyActiveCliUsers: number;
  /** Daily active IDE chat users for the scope. */
  dailyActiveChatUsers: number;
  /** Daily active IDE agent users for the scope. */
  dailyActiveAgentUsers: number;
  /** Trailing weekly active IDE chat users for the scope. */
  weeklyActiveChatUsers: number;
  /** Trailing weekly active IDE agent users for the scope. */
  weeklyActiveAgentUsers: number;
  /** Trailing monthly active IDE chat users for the scope. */
  monthlyActiveChatUsers: number;
  /** Trailing monthly active IDE agent users for the scope. */
  monthlyActiveAgentUsers: number;
  /** Copilot code review active/passive user counts for this day. */
  codeReview: CopilotCodeReviewUsage;
  /** CLI metrics for this day. */
  cli: CopilotUsageCliMetrics;
  /** Pull request activity metrics for this day. */
  pullRequests: CopilotPullRequestActivity;
  /** Delivery activity grouped by GitHub's Copilot adoption phases. */
  aiAdoptionPhases?: CopilotAiAdoptionPhaseImpact[];
}

/** Copilot usage metrics collected from the latest report APIs. */
export interface CopilotUsageMetrics {
  /** Report scope currently represented by this object. */
  scope: "organization" | "enterprise";
  /** Organization login or enterprise slug for the report scope. */
  scopeName: string;
  /** First day included in the usage report window. */
  reportStartDay?: string;
  /** Last day included in the usage report window. */
  reportEndDay?: string;
  /** ISO-8601 timestamp when these usage metrics were collected. */
  collectedAt: string;
  /** Aggregated totals over the user report rows. */
  totals: CopilotUsageTotals;
  /** Organization billing and policy settings when available. */
  billing?: CopilotBillingSettings;
  /** CLI-specific totals over the report window. */
  cli: CopilotUsageCliMetrics;
  /** Pull request activity totals over the report window. */
  pullRequests: CopilotPullRequestActivity;
  /** Latest trailing active/passive Copilot code review counts. */
  codeReview: CopilotCodeReviewUsage;
  /** Latest available daily repository-level pull-request activity report. */
  repositoryReport?: CopilotRepositoryUsageReport;
  /** Availability of repository-level metrics for this collection run. */
  repositoryReportStatus?: "available" | "unavailable";
  /** Per-user usage rows for the report window. */
  users: CopilotUsageUserMetrics[];
  /** Daily aggregate totals from the organization or enterprise report. */
  dailyTotals: CopilotUsageDailyTotal[];
  /** Usage counters grouped by feature. */
  byFeature: CopilotUsageBreakdown[];
  /** Usage counters grouped by IDE. */
  byIde: CopilotUsageBreakdown[];
  /** Usage counters grouped by language. */
  byLanguage: CopilotUsageBreakdown[];
  /** Usage counters grouped by model. */
  byModel: CopilotUsageBreakdown[];
  /** Usage counters grouped by team slug when user-team data is available. */
  byTeam: CopilotUsageBreakdown[];
  /** Usage counters grouped by language and feature. */
  byLanguageFeature: CopilotUsageBreakdown[];
  /** Usage counters grouped by language and model. */
  byLanguageModel: CopilotUsageBreakdown[];
  /** Usage counters grouped by model and feature. */
  byModelFeature: CopilotUsageBreakdown[];
  /** IDE/plugin version coverage rows inferred from usage breakdowns. */
  ideVersions: CopilotUsageIdeVersionMetrics[];
}
