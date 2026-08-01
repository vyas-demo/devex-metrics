/**
 * Per-developer engineering intelligence.
 *
 * Pure, side-effect-free derivations from the `mergedPRTimeline` data that
 * `collect` already gathers for every repo. Produces a per-developer
 * leaderboard, percentile benchmarks (the "Median / Top 10% / Top 1%" model),
 * and an AI-vs-human contribution comparison — with no additional API calls.
 */
import type {
  OrgMetrics,
  MergedPRSummary,
  DeveloperStats,
  Benchmark,
  AiImpactStats,
  AiToolImpact,
  EngineeringIntelligence,
} from "./types.js";

/** Linear-interpolated percentile of a numeric sample. Empty → 0. */
export function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * Math.min(Math.max(ratio, 0), 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/** Median of a numeric sample. Empty → 0. */
export function median(values: number[]): number {
  return percentile(values, 0.5);
}

/** Build a p50/p90/p99/max benchmark from a numeric sample. */
export function benchmark(values: number[]): Benchmark {
  return {
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    p99: percentile(values, 0.99),
    max: values.length > 0 ? Math.max(...values) : 0,
  };
}

/** Lines changed for a merged-PR summary, or undefined when line data is absent. */
function prSize(pr: MergedPRSummary): number | undefined {
  if (pr.linesAdded === undefined && pr.linesDeleted === undefined) return undefined;
  return (pr.linesAdded ?? 0) + (pr.linesDeleted ?? 0);
}

/**
 * Defensive bot detection for logins whose upstream `isBotAuthor` flag is
 * missing (e.g. `step-security-bot`, which has no `[bot]` suffix). Applied on
 * top of the collected flag so bots are classified consistently everywhere —
 * both excluded from the human leaderboard and from `humanMergedPRs`.
 */
export function isLikelyBot(login: string): boolean {
  const l = login.toLowerCase();
  return /\[bot\]$/.test(l) || /-bot$/.test(l) || /^bot-/.test(l);
}

/** How a merged PR is attributed for the human-vs-AI split. */
export type Attribution = "ai" | "bot" | "human";

export function attribute(pr: MergedPRSummary): Attribution {
  if (pr.isCopilotAuthored) return "ai";
  if (pr.isBotAuthor || isLikelyBot(pr.author)) return "bot";
  return "human";
}

/**
 * Calibrated work units contributed by one merged PR of the given size.
 * A ~32-line change ≈ 1 unit; the log2 curve rewards additional size with
 * diminishing returns and the [0.25, 4] clamp stops a single lockfile-style
 * mega-PR (or a one-character fix) from distorting per-developer output.
 * PRs without line data count as exactly 1 unit.
 */
export function prWorkUnits(size: number | undefined): number {
  if (size === undefined) return 1;
  return Math.min(4, Math.max(0.25, Math.log2(1 + size / 32)));
}

/** Accumulator used while folding merged PRs into per-developer buckets. */
interface DevAccumulator {
  login: string;
  isBot: boolean;
  cycleHours: number[];
  sizes: number[];
  linesAdded: number;
  linesDeleted: number;
  workUnits: number;
  repos: Set<string>;
  firstMergedAt?: string;
  lastMergedAt?: string;
}

/**
 * Compute team-wide engineering intelligence from collected org metrics.
 *
 * Only merged PRs with a non-empty author are considered. Bot-authored PRs are
 * tracked but excluded from the human developer leaderboard and benchmarks;
 * AI-tool-authored PRs (Copilot/Claude/Codex) feed the AI-impact comparison.
 */
export function computeEngineeringIntelligence(
  metrics: OrgMetrics
): EngineeringIntelligence {
  const byDev = new Map<string, DevAccumulator>();

  // AI-vs-human sample collectors.
  const aiCycle: number[] = [];
  const humanCycle: number[] = [];
  const aiSizes: number[] = [];
  const humanSizes: number[] = [];
  let aiMergedPRs = 0;
  let humanMergedPRs = 0;
  const byToolAcc = new Map<string, { cycle: number[]; sizes: number[]; count: number }>();

  // Raw merged-PR count per human developer (the authoritative throughput
  // number; cycle/size samples can drop PRs with cycle==0 or missing line data,
  // so they must not be the source of the count).
  const prCountByDev = new Map<string, number>();

  for (const repo of metrics.repos) {
    for (const pr of repo.mergedPRTimeline ?? []) {
      const login = pr.author?.trim();
      if (!login) continue;

      const size = prSize(pr);
      const cycle = pr.timeToMergeHours;
      const kind = attribute(pr);

      // AI-vs-human split. Bots (that are not AI tools) are attributed to
      // neither cohort — they are infrastructure noise, not contribution.
      if (kind === "ai") {
        aiMergedPRs++;
        if (cycle > 0) aiCycle.push(cycle);
        if (size !== undefined) aiSizes.push(size);
        const tool = pr.aiAuthorType ?? "copilot";
        const acc = byToolAcc.get(tool) ?? { cycle: [], sizes: [], count: 0 };
        acc.count++;
        if (cycle > 0) acc.cycle.push(cycle);
        if (size !== undefined) acc.sizes.push(size);
        byToolAcc.set(tool, acc);
        continue;
      }
      if (kind === "bot") continue;

      // Human author → contributes to the developer leaderboard.
      humanMergedPRs++;
      if (cycle > 0) humanCycle.push(cycle);
      if (size !== undefined) humanSizes.push(size);
      prCountByDev.set(login, (prCountByDev.get(login) ?? 0) + 1);

      const acc =
        byDev.get(login) ??
        {
          login,
          isBot: false,
          cycleHours: [],
          sizes: [],
          linesAdded: 0,
          linesDeleted: 0,
          workUnits: 0,
          repos: new Set<string>(),
        } satisfies DevAccumulator;

      if (cycle > 0) acc.cycleHours.push(cycle);
      if (size !== undefined) acc.sizes.push(size);
      acc.linesAdded += pr.linesAdded ?? 0;
      acc.linesDeleted += pr.linesDeleted ?? 0;
      acc.workUnits += prWorkUnits(size);
      acc.repos.add(repo.fullName);
      if (!acc.firstMergedAt || pr.mergedAt < acc.firstMergedAt) acc.firstMergedAt = pr.mergedAt;
      if (!acc.lastMergedAt || pr.mergedAt > acc.lastMergedAt) acc.lastMergedAt = pr.mergedAt;
      byDev.set(login, acc);
    }
  }

  const developers: DeveloperStats[] = [...byDev.values()].map((acc) => ({
    login: acc.login,
    isBot: acc.isBot,
    mergedPRs: prCountByDev.get(acc.login) ?? 0,
    linesAdded: acc.linesAdded,
    linesDeleted: acc.linesDeleted,
    linesChanged: acc.linesAdded + acc.linesDeleted,
    medianPRSizeLines: median(acc.sizes),
    medianCycleHours: median(acc.cycleHours),
    reposContributed: acc.repos.size,
    workUnits: acc.workUnits,
    firstMergedAt: acc.firstMergedAt,
    lastMergedAt: acc.lastMergedAt,
  }));

  developers.sort((a, b) => b.mergedPRs - a.mergedPRs || a.login.localeCompare(b.login));

  const throughputBenchmark = benchmark(developers.map((d) => d.mergedPRs));
  const cycleTimeBenchmark = benchmark(
    developers.map((d) => d.medianCycleHours).filter((h) => h > 0)
  );
  const prSizeBenchmark = benchmark(
    developers.map((d) => d.medianPRSizeLines).filter((s) => s > 0)
  );
  const workUnitsBenchmark = benchmark(developers.map((d) => d.workUnits));

  const byTool: AiToolImpact[] = [...byToolAcc.entries()]
    .map(([tool, acc]) => ({
      tool,
      mergedPRs: acc.count,
      medianCycleHours: median(acc.cycle),
      medianPRSize: median(acc.sizes),
    }))
    .sort((a, b) => b.mergedPRs - a.mergedPRs);

  const aiImpact: AiImpactStats = {
    aiMergedPRs,
    humanMergedPRs,
    aiShare:
      aiMergedPRs + humanMergedPRs > 0
        ? aiMergedPRs / (aiMergedPRs + humanMergedPRs)
        : 0,
    aiMedianCycleHours: median(aiCycle),
    humanMedianCycleHours: median(humanCycle),
    aiMedianPRSize: median(aiSizes),
    humanMedianPRSize: median(humanSizes),
    byTool,
  };

  return {
    hasData: developers.length > 0 || aiMergedPRs > 0,
    developers,
    contributorCount: developers.length,
    totalMergedPRs: humanMergedPRs,
    throughputBenchmark,
    cycleTimeBenchmark,
    prSizeBenchmark,
    workUnitsBenchmark,
    aiImpact,
  };
}
