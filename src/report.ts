import type { OrgMetrics, RepoMetrics, CopilotAdoption, CopilotAgentMetrics, CopilotUsageMetrics, DoraMetric, InsightSeverity, InsightsSummary, CollaborationStats, HealthReport, TargetEvaluation } from "./types.js";
import { computeEngineeringIntelligence } from "./developer-stats.js";
import { computeDoraMetrics, computeReviewStats } from "./dora.js";
import { computeHealthReport } from "./health.js";
import { computeCollaborationStats } from "./collaboration.js";
import { computeInsights } from "./insights.js";
import { loadTargetsConfig, evaluateTargets } from "./targets.js";
import { computeDeliveryForecast } from "./forecast.js";
import { loadHistory, computeHistoryDeltas } from "./history.js";
import { buildTargetKey } from "./cache.js";
import {
  computeCopilotAdoptionImpact,
  copilotAdoptionPhaseLabel,
  sortCopilotRepositoryUsage,
} from "./copilot-impact.js";

/**
 * Produce a human-readable Markdown report from collected metrics.
 */
export function generateReport(metrics: OrgMetrics): string {
  const lines: string[] = [];
  const titleTarget = metrics.targetRepo ?? metrics.owner;

  lines.push(`# DevEx Metrics – ${titleTarget}`);
  lines.push("");
  lines.push(
    `> Collected at ${metrics.collectedAt} · ` +
      `Owner type: **${metrics.ownerType}**`
  );
  if (metrics.targetRepo) {
    lines.push(`> Selected repository: **${metrics.targetRepo}**`);
  }
  lines.push("");

  const intel = computeEngineeringIntelligence(metrics);
  const health = computeHealthReport(metrics);
  const collaboration = computeCollaborationStats(metrics);
  const dora = computeDoraMetrics(metrics);
  const review = computeReviewStats(metrics);
  const targetsConfig = loadTargetsConfig();
  const targets = targetsConfig
    ? evaluateTargets(targetsConfig, { dora, review, health })
    : undefined;
  const insightsSummary = computeInsights(metrics, {
    intel,
    dora,
    review,
    health,
    collaboration,
    targets,
  });
  appendInsightsSection(lines, insightsSummary);
  appendDeltasSection(lines, metrics);

  // -- Summary --
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| ------ | ----- |`);
  lines.push(`| Repositories | ${metrics.repoCount} |`);

  const totals = aggregate(metrics.repos);
  lines.push(`| Open issues | ${totals.openIssues} |`);
  lines.push(`| Closed issues | ${totals.closedIssues} |`);
  lines.push(`| Open PRs | ${totals.openPRs} |`);
  lines.push(`| Merged PRs | ${totals.mergedPRs} |`);
  lines.push(`| Closed (unmerged) PRs | ${totals.closedPRs} |`);
  lines.push(`| Unique committers (90 d) | ${totals.committers} |`);
  lines.push(`| Unique reviewers (90 d) | ${totals.reviewers} |`);

  // Copilot adoption summary
  const copilotTotals = aggregateCopilot(metrics.repos);
  if (copilotTotals.totalMergedPRs > 0) {
    const authoredPct = ((copilotTotals.copilotAuthoredPRs / copilotTotals.totalMergedPRs) * 100).toFixed(1);
    lines.push(`| Copilot-authored PRs | ${copilotTotals.copilotAuthoredPRs} (${authoredPct}%) |`);
  }
  if (copilotTotals.totalDetailedPRs > 0) {
    const reviewedPct = ((copilotTotals.copilotReviewedPRs / copilotTotals.totalDetailedPRs) * 100).toFixed(1);
    lines.push(`| Copilot-reviewed PRs | ${copilotTotals.copilotReviewedPRs} (${reviewedPct}%) |`);
  }

  // Copilot agent tasks summary
  const agentTotals = aggregateAgentMetrics(metrics.repos);
  if (agentTotals.totalTasks > 0) {
    lines.push(`| Copilot agent tasks | ${agentTotals.totalTasks} |`);
    lines.push(`| Agent tasks completed | ${agentTotals.completedTasks} |`);
    lines.push(`| Agent tasks failed | ${agentTotals.failedTasks} |`);
    lines.push(`| Agent sessions | ${agentTotals.totalSessions} (${agentTotals.cloudAgentSessions} cloud / ${agentTotals.cliRemoteSessions} CLI) |`);
    if (agentTotals.totalCreditsUsed > 0) {
      lines.push(`| Agent credits used | ${agentTotals.totalCreditsUsed.toFixed(1)} |`);
    }
    if (agentTotals.agentCreatedPRs > 0) {
      lines.push(`| PRs created by agent | ${agentTotals.agentCreatedPRs} |`);
    }
    if (agentTotals.agentActionsMinutes > 0) {
      lines.push(`| Agent PR Actions minutes | ${agentTotals.agentActionsMinutes.toFixed(1)} |`);
    }
  }

  if (metrics.copilotUsage) {
    const usage = metrics.copilotUsage;
    lines.push(`| Copilot active users | ${usage.totals.activeUsers} / ${usage.totals.totalUsers} |`);
    if (usage.totals.assignedSeats > 0) {
      lines.push(`| Copilot assigned seats | ${usage.totals.assignedSeats} |`);
    }
    lines.push(`| Copilot acceptance rate | ${usage.totals.acceptanceRate.toFixed(1)}% |`);
    lines.push(`| Copilot interactions | ${formatNumber(usage.totals.userInitiatedInteractions)} |`);
    lines.push(`| Copilot LOC added/deleted | +${formatNumber(usage.totals.locAdded)} / -${formatNumber(usage.totals.locDeleted)} |`);
    if (usage.cli.requestCount > 0) {
      lines.push(`| Copilot CLI requests | ${formatNumber(usage.cli.requestCount)} |`);
    }
    if (usage.pullRequests.totalCreated > 0 || usage.pullRequests.totalReviewed > 0) {
      lines.push(`| Copilot API PR activity | ${usage.pullRequests.totalCreatedByCopilot} created · ${usage.pullRequests.totalReviewedByCopilot} reviewed |`);
    }
  }

  // Median cycle time
  const allCycleTimes = metrics.repos.flatMap(
    (r) => (r.mergedPRTimeline ?? []).map((p) => p.timeToMergeHours),
  );
  if (allCycleTimes.length > 0) {
    const medianHrs = median(allCycleTimes);
    lines.push(`| Median cycle time | ${formatDuration(medianHrs)} |`);
  }

  lines.push("");

  const developerInsights = buildDeveloperInsights(metrics);
  if (developerInsights.hasData) {
    lines.push("## Developer Insights");
    lines.push("");
    lines.push("| Signal | Value |");
    lines.push("| ------ | ----- |");
    if (developerInsights.prThroughputPerWeek > 0) {
      lines.push(`| PR throughput | ${developerInsights.prThroughputPerWeek.toFixed(1)} merged PRs/week |`);
    }
    if (developerInsights.prFlowRatio > 0) {
      lines.push(`| PR flow ratio | ${(developerInsights.prFlowRatio * 100).toFixed(1)}% merged vs opened |`);
    }
    if (developerInsights.issueClosureRatio > 0) {
      lines.push(`| Issue closure ratio | ${(developerInsights.issueClosureRatio * 100).toFixed(1)}% closed vs opened |`);
    }
    if (developerInsights.medianCycleHours > 0) {
      lines.push(`| Median PR cycle time | ${formatDuration(developerInsights.medianCycleHours)} |`);
    }
    if (developerInsights.cyclePredictabilityRatio > 0) {
      lines.push(`| Cycle predictability (p75 / p50) | ${developerInsights.cyclePredictabilityRatio.toFixed(2)}x |`);
    }
    if (developerInsights.medianIssueLeadTimeHours > 0) {
      lines.push(`| Median issue lead time | ${formatDuration(developerInsights.medianIssueLeadTimeHours)} |`);
    }
    if (developerInsights.medianPRSize > 0) {
      lines.push(`| Median PR size | ${formatNumber(developerInsights.medianPRSize)} lines changed |`);
    }
    lines.push("");
  }

  if (intel.hasData) {
    lines.push("## Engineering Intelligence");
    lines.push("");
    lines.push("Derived from the merged-PR window per developer across all repositories.");
    lines.push("");

    // Team benchmarks (Median / Top 10% / Top 1%).
    lines.push("### Team benchmarks");
    lines.push("");
    lines.push("| Metric | Median (p50) | Top 10% (p90) | Top 1% (p99) |");
    lines.push("| ------ | ------------ | ------------- | ------------ |");
    lines.push(
      `| Merged PRs per developer | ${formatNumber(intel.throughputBenchmark.p50)} | ${formatNumber(intel.throughputBenchmark.p90)} | ${formatNumber(intel.throughputBenchmark.p99)} |`,
    );
    lines.push(
      `| Median cycle time (lower is better) | ${formatDuration(intel.cycleTimeBenchmark.p50)} | ${formatDuration(intel.cycleTimeBenchmark.p90)} | ${formatDuration(intel.cycleTimeBenchmark.p99)} |`,
    );
    lines.push(
      `| Median PR size (lines) | ${formatNumber(intel.prSizeBenchmark.p50)} | ${formatNumber(intel.prSizeBenchmark.p90)} | ${formatNumber(intel.prSizeBenchmark.p99)} |`,
    );
    lines.push(
      `| Work units per developer | ${intel.workUnitsBenchmark.p50.toFixed(1)} | ${intel.workUnitsBenchmark.p90.toFixed(1)} | ${intel.workUnitsBenchmark.p99.toFixed(1)} |`,
    );
    lines.push("");
    lines.push(
      "Work units are a calibrated output measure: each merged PR contributes log-scaled, clamped credit (~32-line PR ≈ 1 unit, capped at 4), so giant lockfile PRs and one-line fixes don't distort output comparisons.",
    );
    lines.push("");

    // Top developers.
    if (intel.developers.length > 0) {
      lines.push("### Top developers");
      lines.push("");
      lines.push("| Developer | Merged PRs | Work units | Lines changed | Median PR size | Median cycle time | Repos |");
      lines.push("| --------- | ---------- | ---------- | ------------- | -------------- | ----------------- | ----- |");
      for (const dev of intel.developers.slice(0, 10)) {
        lines.push(
          `| ${escapeMarkdownTable(dev.login)} | ${formatNumber(dev.mergedPRs)} | ${dev.workUnits.toFixed(1)} | ${formatNumber(dev.linesChanged)} | ${formatNumber(dev.medianPRSizeLines)} | ${formatDuration(dev.medianCycleHours)} | ${formatNumber(dev.reposContributed)} |`,
        );
      }
      if (intel.developers.length > 10) {
        lines.push("");
        lines.push(`…and ${intel.developers.length - 10} more`);
      }
      lines.push("");
    }

    // AI vs human impact.
    if (intel.aiImpact.aiMergedPRs > 0) {
      const ai = intel.aiImpact;
      lines.push("### AI vs human impact");
      lines.push("");
      lines.push("| Cohort | Merged PRs | Median cycle time | Median PR size |");
      lines.push("| ------ | ---------- | ----------------- | -------------- |");
      lines.push(
        `| AI-authored | ${formatNumber(ai.aiMergedPRs)} | ${formatDuration(ai.aiMedianCycleHours)} | ${formatNumber(ai.aiMedianPRSize)} |`,
      );
      lines.push(
        `| Human-authored | ${formatNumber(ai.humanMergedPRs)} | ${formatDuration(ai.humanMedianCycleHours)} | ${formatNumber(ai.humanMedianPRSize)} |`,
      );
      lines.push("");
      lines.push(`AI share of merged PRs: ${(ai.aiShare * 100).toFixed(1)}%`);
      lines.push("");

      if (ai.byTool.length > 0) {
        lines.push("| Tool | Merged PRs | Median cycle time | Median PR size |");
        lines.push("| ---- | ---------- | ----------------- | -------------- |");
        for (const tool of ai.byTool) {
          const toolName = tool.tool.charAt(0).toUpperCase() + tool.tool.slice(1);
          lines.push(
            `| ${escapeMarkdownTable(toolName)} | ${formatNumber(tool.mergedPRs)} | ${formatDuration(tool.medianCycleHours)} | ${formatNumber(tool.medianPRSize)} |`,
          );
        }
        lines.push("");
      }
    }
  }

  appendDoraSection(lines, metrics);
  appendForecastSection(lines, metrics);
  if (targets && targets.length > 0) {
    appendTargetsSection(lines, targets);
  }
  appendCodeReviewSection(lines, metrics);
  appendCollaborationSection(lines, collaboration);
  appendHealthSection(lines, health);

  if (metrics.copilotUsage) {
    appendCopilotUsageSection(lines, metrics.copilotUsage);
  }

  // -- Per-repo --
  lines.push("## Repositories");
  lines.push("");
  for (const repo of metrics.repos) {
    lines.push(`### ${repo.fullName}`);
    lines.push("");
    if (repo.pushedAt) {
      lines.push(`Last pushed: ${repo.pushedAt.slice(0, 10)}`);
    }
    lines.push(
      `Issues: ${repo.issues.open} open / ${repo.issues.closed} closed`
    );
    lines.push(
      `PRs: ${repo.pullRequests.open} open / ${repo.pullRequests.merged} merged / ${repo.pullRequests.closed} closed`
    );
    lines.push(
      `Contributors: ${repo.committerCount} committers · ${repo.reviewerCount} reviewers`
    );
    lines.push(`Dependents: ${repo.dependentCount}`);
    lines.push("");

    // Copilot agent metrics for this repo
    if (repo.copilotAgentMetrics && repo.copilotAgentMetrics.totalTasks > 0) {
      const am = repo.copilotAgentMetrics;
      lines.push("**Copilot Agent (30-day window)**");
      lines.push("");
      lines.push(`| Metric | Value |`);
      lines.push(`| ------ | ----- |`);
      lines.push(`| Total tasks | ${am.totalTasks} |`);
      lines.push(`| Completed | ${am.completedTasks} |`);
      if (am.failedTasks > 0) lines.push(`| Failed | ${am.failedTasks} |`);
      if (am.cancelledTasks > 0) lines.push(`| Cancelled | ${am.cancelledTasks} |`);
      if (am.activeTasksCount > 0) lines.push(`| Active | ${am.activeTasksCount} |`);
      lines.push(`| Sessions | ${am.totalSessions} |`);
      if (am.cloudAgentSessions > 0)
        lines.push(`| Cloud agent sessions | ${am.cloudAgentSessions} |`);
      if (am.totalCreditsUsed > 0)
        lines.push(`| Credits used | ${am.totalCreditsUsed.toFixed(1)} |`);
      if (am.avgCompletedSessionHours !== undefined)
        lines.push(`| Avg session duration | ${formatDuration(am.avgCompletedSessionHours)} |`);
      if (am.agentCreatedPRs > 0)
        lines.push(`| PRs created | ${am.agentCreatedPRs} |`);
      if (am.agentActionsMinutes > 0)
        lines.push(`| Actions minutes (agent PRs) | ${am.agentActionsMinutes.toFixed(1)} |`);
      lines.push("");
    }

    if (repo.pullRequestDetails.length > 0) {
      const sortedPRs = [...repo.pullRequestDetails].sort((a, b) => {
        if (!a.mergedAt && !b.mergedAt) return 0;
        if (!a.mergedAt) return 1;
        if (!b.mergedAt) return -1;
        return b.mergedAt.localeCompare(a.mergedAt);
      });
      lines.push(
        "| PR | Merged | Lines +/- | Comments | Commits | Actions min |"
      );
      lines.push(
        "| -- | ------ | --------- | -------- | ------- | ----------- |"
      );
      for (const pr of sortedPRs) {
        const mergedDate = pr.mergedAt ? pr.mergedAt.slice(0, 10) : "";
        lines.push(
          `| #${pr.number} ${pr.title} | ${mergedDate} | +${pr.linesAdded}/-${pr.linesDeleted} | ${pr.commentCount} | ${pr.commitCount} | ${pr.actionsMinutes} |`
        );
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

/* ---- helpers ---- */

/** Capitalized tier name for a DORA metric, or an en dash when unclassified. */
function doraTierCell(metric: DoraMetric): string {
  return metric.tier ? metric.tier.charAt(0).toUpperCase() + metric.tier.slice(1) : "–";
}

function appendDoraSection(lines: string[], metrics: OrgMetrics): void {
  const dora = computeDoraMetrics(metrics);
  if (!dora.hasData) return;

  lines.push("## DORA Metrics");
  lines.push("");
  const usesIncidents = dora.failureSignal === "incidents";
  lines.push(
    `Trailing ${dora.windowDays}-day window. A merged PR counts as a change (deploy proxy); ` +
      (usesIncidents
        ? `failures come from labeled incident issues (real signal).`
        : `a revert PR counts as a change failure (proxy — label incidents to upgrade this signal).`),
  );
  lines.push("");
  lines.push("| Metric | Value | Tier |");
  lines.push("| ------ | ----- | ---- |");
  const df = dora.deployFrequencyPerWeek;
  lines.push(
    `| Deploy frequency | ${df.hasData ? `${df.value.toFixed(1)} / week` : "–"} | ${doraTierCell(df)} |`,
  );
  const lt = dora.leadTimeHours;
  lines.push(
    `| Lead time for changes | ${lt.hasData ? formatDuration(lt.value) : "–"} | ${doraTierCell(lt)} |`,
  );
  const cfr = dora.changeFailureRate;
  lines.push(
    `| Change failure rate | ${cfr.hasData ? `${(cfr.value * 100).toFixed(1)}%` : "–"} | ${doraTierCell(cfr)} |`,
  );
  const mttr = dora.mttrHours;
  lines.push(
    `| Time to restore | ${mttr.hasData ? formatDuration(mttr.value) : "–"} | ${doraTierCell(mttr)} |`,
  );
  lines.push("");
  const failureCounts = usesIncidents
    ? `${dora.totalIncidents ?? 0} incidents · ${dora.totalReverts} reverts`
    : `${dora.totalReverts} reverts`;
  lines.push(
    `${dora.totalDeploys} deploys · ${dora.totalMergedPRs} merged PRs · ${failureCounts} in window`,
  );
  lines.push("");
}

function appendCodeReviewSection(lines: string[], metrics: OrgMetrics): void {
  const review = computeReviewStats(metrics);
  if (!review.hasData) return;

  lines.push("## Code Review");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| ------ | ----- |");
  lines.push(`| Review coverage | ${(review.reviewCoverage * 100).toFixed(1)}% (${review.reviewedPRs} of ${review.totalPRs} PRs) |`);
  lines.push(
    `| Median time to first review | ${review.medianTimeToFirstReviewHours > 0 ? formatDuration(review.medianTimeToFirstReviewHours) : "–"} |`,
  );
  lines.push(
    `| p90 time to first review | ${review.p90TimeToFirstReviewHours > 0 ? formatDuration(review.p90TimeToFirstReviewHours) : "–"} |`,
  );
  lines.push("");

  if (review.reviewers.length > 0) {
    lines.push("### Reviewer load");
    lines.push("");
    lines.push("| Reviewer | PRs reviewed | Load share |");
    lines.push("| -------- | ------------ | ---------- |");
    for (const reviewer of review.reviewers.slice(0, 10)) {
      lines.push(
        `| ${escapeMarkdownTable(reviewer.login)} | ${formatNumber(reviewer.prsReviewed)} | ${(reviewer.loadShare * 100).toFixed(1)}% |`,
      );
    }
    if (review.reviewers.length > 10) {
      lines.push("");
      lines.push(`…and ${review.reviewers.length - 10} more`);
    }
    lines.push("");

    if (review.topReviewerShare > 0.5) {
      const top = review.reviewers[0];
      lines.push(
        `⚠ Review load is concentrated: ${escapeMarkdownTable(top.login)} carries ${(top.loadShare * 100).toFixed(1)}% of reviews.`,
      );
      lines.push("");
    }
  }
}

/** Display label for an insight severity, ordered worst-first. */
const INSIGHT_SEVERITY_LABELS: Record<InsightSeverity, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
  positive: "Positive",
};

function appendInsightsSection(lines: string[], summary: InsightsSummary): void {
  if (!summary.hasData || summary.insights.length === 0) return;

  lines.push("## Key Insights");
  lines.push("");
  const counts = (Object.keys(INSIGHT_SEVERITY_LABELS) as InsightSeverity[])
    .filter((sev) => summary.counts[sev] > 0)
    .map((sev) => `${summary.counts[sev]} ${INSIGHT_SEVERITY_LABELS[sev].toLowerCase()}`)
    .join(" · ");
  lines.push(`${summary.insights.length} automated findings: ${counts}`);
  lines.push("");
  for (const insight of summary.insights) {
    const scope = insight.repo ? ` _(${escapeMarkdownTable(insight.repo)})_` : "";
    lines.push(
      `- **${INSIGHT_SEVERITY_LABELS[insight.severity]} — ${escapeMarkdownTable(insight.title)}.**${scope} ${insight.detail}`,
    );
    if (insight.recommendation) {
      lines.push(`  - Recommendation: ${insight.recommendation}`);
    }
  }
  lines.push("");
}

/**
 * Week-over-week movement from the persisted snapshot history. Silent when no
 * usable baseline snapshot exists yet (history accumulates one per collection
 * day).
 */
function appendDeltasSection(lines: string[], metrics: OrgMetrics): void {
  const targetKey = buildTargetKey(metrics.owner, metrics.ownerType, metrics.targetRepo);
  const deltas = computeHistoryDeltas(loadHistory(targetKey));
  if (!deltas.hasData || deltas.deltas.length === 0) return;

  lines.push("## What Changed");
  lines.push("");
  lines.push(`Compared to the ${deltas.baselineDate} snapshot (${deltas.daysSpanned} days ago).`);
  lines.push("");
  lines.push("| Metric | Now | Change |");
  lines.push("| ------ | --- | ------ |");
  for (const d of deltas.deltas) {
    const isRatio = d.id === "reviewCoverage30d" || d.id === "aiShare";
    const isHours = d.id === "medianCycleHours30d";
    const fmt = (v: number): string =>
      isRatio ? `${(v * 100).toFixed(1)}%` : isHours ? formatDuration(v) : formatNumber(Math.round(v * 10) / 10);
    if (d.delta === 0) {
      lines.push(`| ${d.label} | ${fmt(d.current)} | – unchanged |`);
      continue;
    }
    const arrow = d.delta > 0 ? "▲" : "▼";
    const good = (d.delta > 0) === (d.goodDirection === "up") ? "" : " (worse)";
    const pct = d.pctChange !== undefined ? ` (${d.pctChange > 0 ? "+" : ""}${(d.pctChange * 100).toFixed(1)}%)` : "";
    const signed = `${d.delta > 0 ? "+" : "−"}${fmt(Math.abs(d.delta))}`;
    lines.push(`| ${d.label} | ${fmt(d.current)} | ${arrow} ${signed}${pct}${good} |`);
  }
  lines.push("");
}

function appendForecastSection(lines: string[], metrics: OrgMetrics): void {
  const forecast = computeDeliveryForecast(metrics);
  if (!forecast.hasData || forecast.targets.length === 0) return;

  lines.push("## Delivery Forecast");
  lines.push("");
  lines.push(
    `Monte-Carlo simulation over the last ${forecast.sampleWeeks} completed weeks of merge throughput ` +
      `(median ${formatNumber(forecast.medianWeeklyThroughput)} merged PRs/week).`,
  );
  lines.push("");
  lines.push("| Deliver next… | 50% confidence | 85% confidence | 95% confidence |");
  lines.push("| ------------- | -------------- | -------------- | -------------- |");
  for (const target of forecast.targets) {
    lines.push(
      `| ${target.prCount} PRs | ${target.p50Date} (${target.p50Weeks}w) | ${target.p85Date} (${target.p85Weeks}w) | ${target.p95Date} (${target.p95Weeks}w) |`,
    );
  }
  lines.push("");
}

function appendTargetsSection(lines: string[], targets: TargetEvaluation[]): void {
  lines.push("## Team Targets");
  lines.push("");
  lines.push("Thresholds configured in `devex.config.json`.");
  lines.push("");
  lines.push("| Target | Status | Detail |");
  lines.push("| ------ | ------ | ------ |");
  for (const target of targets) {
    const status = !target.hasData ? "– no data" : target.met ? "✓ met" : "✗ missed";
    lines.push(
      `| ${escapeMarkdownTable(target.label)} | ${status} | ${escapeMarkdownTable(target.detail)} |`,
    );
  }
  lines.push("");
}

function appendCollaborationSection(lines: string[], collaboration: CollaborationStats): void {
  if (!collaboration.hasData) return;

  lines.push("## Collaboration Network");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| ------ | ----- |");
  lines.push(`| Distinct authors | ${collaboration.distinctAuthors} |`);
  lines.push(`| Distinct reviewers | ${collaboration.distinctReviewers} |`);
  lines.push(`| Review-load concentration (Gini) | ${collaboration.reviewerGini.toFixed(2)} |`);
  if (collaboration.siloedContributors.length > 0) {
    lines.push(`| Single-repo contributors (≥3 PRs) | ${collaboration.siloedContributors.length} |`);
  }
  lines.push("");

  if (collaboration.busFactors.length > 0) {
    lines.push("### Ownership concentration (bus factor)");
    lines.push("");
    lines.push("| Repository | Bus factor | Top author share | Merged PRs |");
    lines.push("| ---------- | ---------- | ---------------- | ---------- |");
    for (const repo of collaboration.busFactors.slice(0, 10)) {
      lines.push(
        `| ${escapeMarkdownTable(repo.fullName)} | ${repo.busFactor} | ${(repo.topAuthorShare * 100).toFixed(0)}% | ${repo.mergedPRs} |`,
      );
    }
    lines.push("");
  }

  if (collaboration.edges.length > 0) {
    lines.push("### Strongest review relationships");
    lines.push("");
    lines.push("| Author | Reviewer | PRs |");
    lines.push("| ------ | -------- | --- |");
    for (const edge of collaboration.edges.slice(0, 10)) {
      lines.push(
        `| ${escapeMarkdownTable(edge.author)} | ${escapeMarkdownTable(edge.reviewer)} | ${edge.prCount} |`,
      );
    }
    lines.push("");
  }
}

function appendHealthSection(lines: string[], health: HealthReport): void {
  if (!health.hasData) return;

  lines.push("## Repository Health");
  lines.push("");
  lines.push(
    `Composite 0–100 score from activity, review coverage, cycle time, change failure, contributor redundancy, and issue backlog. Average: **${health.avgScore}**.`,
  );
  lines.push("");
  lines.push("| Repository | Score | Grade | Weakest signal |");
  lines.push("| ---------- | ----- | ----- | -------------- |");
  for (const repo of health.repos.slice(0, 15)) {
    const scored = repo.components.filter((c) => c.score !== undefined);
    const weakest = scored.length > 0
      ? scored.reduce((a, b) => ((a.score ?? 0) <= (b.score ?? 0) ? a : b))
      : undefined;
    const attention = repo.needsAttention ? " ⚠" : "";
    lines.push(
      `| ${escapeMarkdownTable(repo.fullName)} | ${repo.score}${attention} | ${repo.grade} | ${weakest ? `${weakest.label}: ${escapeMarkdownTable(weakest.detail)}` : "–"} |`,
    );
  }
  if (health.repos.length > 15) {
    lines.push("");
    lines.push(`…and ${health.repos.length - 15} more`);
  }
  lines.push("");
}

function appendCopilotUsageSection(lines: string[], usage: CopilotUsageMetrics): void {
  lines.push("## Copilot Usage");
  lines.push("");
  const range = usage.reportStartDay && usage.reportEndDay
    ? `${usage.reportStartDay} to ${usage.reportEndDay}`
    : "latest report window";
  lines.push(`Scope: **${usage.scopeName}** (${usage.scope}) · fixed 28-day window: ${range} · collected ${usage.collectedAt}`);
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| ------ | ----- |");
  lines.push(`| Active users | ${usage.totals.activeUsers} / ${usage.totals.totalUsers} |`);
  if (usage.totals.assignedSeats > 0) {
    lines.push(`| Assigned seats | ${usage.totals.assignedSeats} |`);
    lines.push(`| Seats active this cycle | ${usage.totals.seatsActiveThisCycle} |`);
  }
  lines.push(`| Acceptance rate | ${usage.totals.acceptanceRate.toFixed(1)}% |`);
  lines.push(`| User initiated interactions | ${formatNumber(usage.totals.userInitiatedInteractions)} |`);
  lines.push(`| Code generations / acceptances | ${formatNumber(usage.totals.codeGenerations)} / ${formatNumber(usage.totals.codeAcceptances)} |`);
  lines.push(`| Lines added / deleted | +${formatNumber(usage.totals.locAdded)} / -${formatNumber(usage.totals.locDeleted)} |`);
  lines.push(`| Chat / agent / CLI users | ${usage.totals.chatUsers} / ${usage.totals.agentUsers} / ${usage.totals.cliUsers} |`);
  if (usage.codeReview.monthlyActiveUsers > 0 || usage.codeReview.monthlyPassiveUsers > 0) {
    lines.push(`| Code review active / passive users | ${usage.codeReview.monthlyActiveUsers} / ${usage.codeReview.monthlyPassiveUsers} |`);
  }
  if (usage.cli.requestCount > 0) {
    lines.push(`| CLI sessions / requests / prompts | ${formatNumber(usage.cli.sessionCount)} / ${formatNumber(usage.cli.requestCount)} / ${formatNumber(usage.cli.promptCount)} |`);
    lines.push(`| CLI prompt / output tokens | ${formatNumber(usage.cli.promptTokens)} / ${formatNumber(usage.cli.outputTokens)} |`);
  }
  lines.push("");

  appendCopilotAdoptionImpact(lines, usage);
  appendCopilotRepositoryUsage(lines, usage);

  if (usage.billing) {
    lines.push("### Seats and Policies");
    lines.push("");
    lines.push("| Setting | Value |");
    lines.push("| ------- | ----- |");
    lines.push(`| Seats added / pending cancel / inactive | ${usage.billing.addedThisCycle} / ${usage.billing.pendingCancellation} / ${usage.billing.inactiveThisCycle} |`);
    if (usage.billing.seatManagementSetting) lines.push(`| Seat management | ${usage.billing.seatManagementSetting} |`);
    if (usage.billing.ideChat || usage.billing.platformChat || usage.billing.cli) {
      lines.push(`| IDE chat / GitHub chat / CLI | ${usage.billing.ideChat ?? "-"} / ${usage.billing.platformChat ?? "-"} / ${usage.billing.cli ?? "-"} |`);
    }
    if (usage.billing.publicCodeSuggestions) lines.push(`| Public code suggestions | ${usage.billing.publicCodeSuggestions} |`);
    lines.push("");
  }

  if (usage.pullRequests.totalCreated > 0 || usage.pullRequests.totalReviewed > 0 || usage.pullRequests.totalSuggestions > 0) {
    lines.push("### Pull Request Activity");
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("| ------ | ----- |");
    lines.push(`| Created / reviewed / merged | ${usage.pullRequests.totalCreated} / ${usage.pullRequests.totalReviewed} / ${usage.pullRequests.totalMerged} |`);
    lines.push(`| Created / reviewed by Copilot | ${usage.pullRequests.totalCreatedByCopilot} / ${usage.pullRequests.totalReviewedByCopilot} |`);
    lines.push(`| Copilot-created / Copilot-reviewed merged | ${usage.pullRequests.totalMergedCreatedByCopilot} / ${usage.pullRequests.totalMergedReviewedByCopilot} |`);
    if (usage.pullRequests.medianMinutesToMerge !== null && usage.pullRequests.medianMinutesToMerge > 0) {
      lines.push(`| Median of daily merge-time medians | ${formatMinutes(usage.pullRequests.medianMinutesToMerge)} |`);
    }
    lines.push(`| Review suggestions applied | ${usage.pullRequests.totalAppliedSuggestions} / ${usage.pullRequests.totalSuggestions} |`);
    lines.push(`| Copilot suggestions applied | ${usage.pullRequests.totalCopilotAppliedSuggestions} / ${usage.pullRequests.totalCopilotSuggestions} |`);
    lines.push("");
  }

  if (usage.byFeature.length > 0) {
    lines.push("### Feature Mix");
    lines.push("");
    lines.push("| Feature | Users | Interactions | LOC added | Acceptance |");
    lines.push("| ------- | ----- | ------------ | --------- | ---------- |");
    for (const feature of usage.byFeature.slice(0, 10)) {
      lines.push(
        `| ${escapeMarkdownTable(feature.name)} | ${feature.users} | ${formatNumber(feature.userInitiatedInteractions)} | ${formatNumber(feature.locAdded)} | ${feature.acceptanceRate.toFixed(1)}% |`,
      );
    }
    lines.push("");
  }

  appendBreakdown(lines, "IDE Mix", usage.byIde, "IDE");
  appendBreakdown(lines, "Language Mix", usage.byLanguage, "Language");
  appendBreakdown(lines, "Model Mix", usage.byModel, "Model");
  appendBreakdown(lines, "Language / Model Mix", usage.byLanguageModel, "Bucket");

  if (usage.ideVersions.length > 0) {
    lines.push("### IDE and Plugin Coverage");
    lines.push("");
    lines.push("| IDE | IDE version | Plugin | Plugin version | Users | Sampled |");
    lines.push("| --- | ----------- | ------ | -------------- | ----- | ------- |");
    for (const row of usage.ideVersions.slice(0, 10)) {
      lines.push(`| ${escapeMarkdownTable(row.ide)} | ${escapeMarkdownTable(row.ideVersion ?? "-")} | ${escapeMarkdownTable(row.plugin ?? "-")} | ${escapeMarkdownTable(row.pluginVersion ?? "-")} | ${row.users} | ${row.sampledAt?.slice(0, 10) ?? "-"} |`);
    }
    lines.push("");
  }

  if (usage.users.length > 0) {
    lines.push("### Per-User Usage");
    lines.push("");
    lines.push("| User | Adoption phase | Report rows | Interactions | Gen / Accept | Acceptance | LOC +/- | Surfaces | Last activity |");
    lines.push("| ---- | -------------- | ----------- | ------------ | ------------ | ---------- | ------- | -------- | ------------- |");
    for (const user of usage.users.slice(0, 50)) {
      const surfaces = [
        user.usedChat ? "chat" : undefined,
        user.usedAgent ? "agent" : undefined,
        user.usedCli ? "CLI" : undefined,
        user.usedCodeReviewActive || user.usedCodeReviewPassive ? "review" : undefined,
      ].filter((value): value is string => value !== undefined).join(", ") || "-";
      const phase = user.aiAdoptionPhase
        ? (user.aiAdoptionPhase.phaseNumber === 0 ? "Passive users" : user.aiAdoptionPhase.phase)
        : "-";
      lines.push(
        `| ${escapeMarkdownTable(user.login)} | ${escapeMarkdownTable(phase)} | ${user.activeDays} | ${formatNumber(user.userInitiatedInteractions)} | ${formatNumber(user.codeGenerations)} / ${formatNumber(user.codeAcceptances)} | ${user.acceptanceRate.toFixed(1)}% | +${formatNumber(user.locAdded)} / -${formatNumber(user.locDeleted)} | ${surfaces} | ${user.lastActivityAt?.slice(0, 10) ?? user.lastUsageDay ?? "-"} |`,
      );
    }
    lines.push("");
  }
}

function appendCopilotAdoptionImpact(lines: string[], usage: CopilotUsageMetrics): void {
  const impact = computeCopilotAdoptionImpact(usage);
  if (!impact) return;

  lines.push("### Adoption Depth and Delivery Association");
  lines.push("");
  lines.push(
    `Trailing 28-day snapshot as of **${impact.day}**. GitHub recalculates phases daily; Passive users is the API's No Cohort phase for licensed users who did not meet the two-active-day threshold.`,
  );
  lines.push("");
  lines.push(`**Phase 1+ share:** ${(impact.engagedShare * 100).toFixed(1)}% (${impact.engagedUsers} of ${impact.totalUsers} licensed cohort users)`);
  if (impact.mergedPullRequestAssociation !== undefined) {
    lines.push("");
    lines.push(
      `Users in Phase 1 or higher averaged **${impact.mergedPullRequestAssociation.toFixed(2)}×** as many merged PRs per user over the trailing 28 days as passive users. This is an association, not a causal productivity estimate.`,
    );
  }
  lines.push("");
  lines.push("| Phase | Users | Share | Merged PRs / user (28 d) | Avg of user median merge time |");
  lines.push("| ----- | ----- | ----- | --------------------- | ----------------------------- |");
  for (const phase of impact.phases) {
    const share = impact.totalUsers > 0 ? phase.totalEngagedUsers / impact.totalUsers : 0;
    lines.push(
      `| ${escapeMarkdownTable(copilotAdoptionPhaseLabel(phase))} | ${phase.totalEngagedUsers} | ${(share * 100).toFixed(1)}% | ${phase.avgPullRequestsMerged.toFixed(2)} | ${phase.totalPullRequestsMerged > 0 ? formatMinutes(phase.avgPullRequestsMedianMinutesToMerge) : "Unavailable"} |`,
    );
  }
  lines.push("");
}

function appendCopilotRepositoryUsage(lines: string[], usage: CopilotUsageMetrics): void {
  const report = usage.repositoryReport;
  if (!report) {
    if (usage.repositoryReportStatus === "unavailable") {
      lines.push("### Latest Repository PR Activity");
      lines.push("");
      lines.push("Repository-level Copilot PR activity was unavailable for this collection run.");
      lines.push("");
    }
    return;
  }

  const repositories = sortCopilotRepositoryUsage(report.repositories);
  lines.push("### Latest Repository PR Activity");
  lines.push("");
  lines.push(
    `Report day: **${report.reportDay}**. GitHub returns only repositories with pull-request activity that day; an absent repository does not mean zero Copilot usage.`,
  );
  lines.push("");
  if (repositories.length === 0) {
    lines.push("No repository rows were returned for this available report.");
    lines.push("");
    return;
  }
  lines.push("| Repository | Visibility | Created / reviewed / merged | Copilot-created / reviewed | Copilot-associated merges | Median merge time |");
  lines.push("| ---------- | ---------- | --------------------------- | -------------------------- | ------------------------- | ----------------- |");
  for (const repository of repositories.slice(0, 20)) {
    const pullRequests = repository.pullRequests;
    lines.push(
      `| ${escapeMarkdownTable(repository.fullName)} | ${escapeMarkdownTable(repository.visibility.toLowerCase())} | ${pullRequests.totalCreated} / ${pullRequests.totalReviewed} / ${pullRequests.totalMerged} | ${pullRequests.totalCreatedByCopilot} / ${pullRequests.totalReviewedByCopilot} | ${pullRequests.totalMergedCreatedByCopilot} authored / ${pullRequests.totalMergedReviewedByCopilot} reviewed | ${pullRequests.medianMinutesToMerge === null ? "Unavailable" : formatMinutes(pullRequests.medianMinutesToMerge)} |`,
    );
  }
  if (repositories.length > 20) {
    lines.push("");
    lines.push(`Showing 20 of ${repositories.length} repositories with PR activity.`);
  }
  lines.push("");
}

function appendBreakdown(
  lines: string[],
  title: string,
  rows: Array<{ name: string; users: number; userInitiatedInteractions: number; locAdded: number; acceptanceRate: number }>,
  label: string,
): void {
  if (rows.length === 0) return;
  lines.push(`### ${title}`);
  lines.push("");
  lines.push(`| ${label} | Users | Interactions | LOC added | Acceptance |`);
  lines.push(`| ${"-".repeat(label.length)} | ----- | ------------ | --------- | ---------- |`);
  for (const row of rows.slice(0, 10)) {
    lines.push(`| ${escapeMarkdownTable(row.name)} | ${row.users} | ${formatNumber(row.userInitiatedInteractions)} | ${formatNumber(row.locAdded)} | ${row.acceptanceRate.toFixed(1)}% |`);
  }
  lines.push("");
}

function aggregate(repos: RepoMetrics[]) {
  let openIssues = 0;
  let closedIssues = 0;
  let openPRs = 0;
  let mergedPRs = 0;
  let closedPRs = 0;
  let committers = 0;
  let reviewers = 0;

  for (const r of repos) {
    openIssues += r.issues.open;
    closedIssues += r.issues.closed;
    openPRs += r.pullRequests.open;
    mergedPRs += r.pullRequests.merged;
    closedPRs += r.pullRequests.closed;
    committers += r.committerCount;
    reviewers += r.reviewerCount;
  }
  return {
    openIssues,
    closedIssues,
    openPRs,
    mergedPRs,
    closedPRs,
    committers,
    reviewers,
  };
}

function aggregateCopilot(repos: RepoMetrics[]): CopilotAdoption {
  let copilotAuthoredPRs = 0;
  let copilotReviewedPRs = 0;
  let totalMergedPRs = 0;
  let totalDetailedPRs = 0;

  for (const r of repos) {
    if (r.copilotAdoption) {
      copilotAuthoredPRs += r.copilotAdoption.copilotAuthoredPRs;
      copilotReviewedPRs += r.copilotAdoption.copilotReviewedPRs;
      totalMergedPRs += r.copilotAdoption.totalMergedPRs;
      totalDetailedPRs += r.copilotAdoption.totalDetailedPRs;
    }
  }
  return { copilotAuthoredPRs, copilotReviewedPRs, totalMergedPRs, totalDetailedPRs };
}

function aggregateAgentMetrics(repos: RepoMetrics[]): CopilotAgentMetrics {
  let totalTasks = 0, completedTasks = 0, failedTasks = 0, cancelledTasks = 0,
    timedOutTasks = 0, activeTasksCount = 0, totalSessions = 0,
    cloudAgentSessions = 0, cliRemoteSessions = 0, totalCreditsUsed = 0,
    agentCreatedPRs = 0, agentActionsMinutes = 0;

  for (const r of repos) {
    if (!r.copilotAgentMetrics) continue;
    const a = r.copilotAgentMetrics;
    totalTasks += a.totalTasks;
    completedTasks += a.completedTasks;
    failedTasks += a.failedTasks;
    cancelledTasks += a.cancelledTasks;
    timedOutTasks += a.timedOutTasks;
    activeTasksCount += a.activeTasksCount;
    totalSessions += a.totalSessions;
    cloudAgentSessions += a.cloudAgentSessions;
    cliRemoteSessions += a.cliRemoteSessions;
    totalCreditsUsed += a.totalCreditsUsed;
    agentCreatedPRs += a.agentCreatedPRs;
    agentActionsMinutes += a.agentActionsMinutes ?? 0;
  }
  return {
    totalTasks,
    completedTasks,
    failedTasks,
    cancelledTasks,
    timedOutTasks,
    activeTasksCount,
    totalSessions,
    cloudAgentSessions,
    cliRemoteSessions,
    totalCreditsUsed: Math.round(totalCreditsUsed * 100) / 100,
    agentCreatedPRs,
    agentActionsMinutes: Math.round(agentActionsMinutes * 100) / 100,
  };
}

function buildDeveloperInsights(metrics: OrgMetrics): {
  hasData: boolean;
  prThroughputPerWeek: number;
  prFlowRatio: number;
  issueClosureRatio: number;
  medianCycleHours: number;
  cyclePredictabilityRatio: number;
  medianIssueLeadTimeHours: number;
  medianPRSize: number;
} {
  const cycleHours = metrics.repos
    .flatMap((repo) => (repo.mergedPRTimeline ?? []).map((pr) => pr.timeToMergeHours))
    .filter((hours) => hours > 0);
  const cycleMedian = median(cycleHours);
  const cycleP75 = percentile(cycleHours, 0.75);

  const issueLeadTimes = metrics.repos
    .flatMap((repo) => (repo.issueLeadTimes ?? []).map((lead) => lead.leadTimeHours))
    .filter((hours) => hours > 0);

  const prSizes = metrics.repos
    .flatMap((repo) => {
      const fromTimeline = (repo.mergedPRTimeline ?? [])
        .map((pr) => (pr.linesAdded ?? 0) + (pr.linesDeleted ?? 0))
        .filter((size) => size > 0);
      if (fromTimeline.length > 0) return fromTimeline;
      return repo.pullRequestDetails
        .map((pr) => pr.linesAdded + pr.linesDeleted)
        .filter((size) => size > 0);
    });

  const weekly = metrics.weeklyTrends ?? [];
  const mergedPRs = weekly.reduce((sum, week) => sum + (week.prsMerged ?? 0), 0);
  const openedPRs = weekly.reduce((sum, week) => sum + (week.prsOpened ?? 0), 0);
  const openedIssues = weekly.reduce((sum, week) => sum + (week.issuesOpened ?? 0), 0);
  const closedIssues = weekly.reduce((sum, week) => sum + (week.issuesClosed ?? 0), 0);
  const activeWeeks = weekly.filter((week) => (week.prsOpened ?? 0) > 0 || (week.prsMerged ?? 0) > 0).length;

  const prThroughputPerWeek = activeWeeks > 0 ? mergedPRs / activeWeeks : 0;
  const prFlowRatio = openedPRs > 0 ? mergedPRs / openedPRs : 0;
  const issueClosureRatio = openedIssues > 0 ? closedIssues / openedIssues : 0;
  const cyclePredictabilityRatio = cycleMedian > 0 && cycleP75 > 0 ? cycleP75 / cycleMedian : 0;
  const medianIssueLeadTimeHours = median(issueLeadTimes);
  const medianPRSize = median(prSizes);

  return {
    hasData:
      prThroughputPerWeek > 0 ||
      prFlowRatio > 0 ||
      issueClosureRatio > 0 ||
      cycleMedian > 0 ||
      medianIssueLeadTimeHours > 0 ||
      medianPRSize > 0,
    prThroughputPerWeek,
    prFlowRatio,
    issueClosureRatio,
    medianCycleHours: cycleMedian,
    cyclePredictabilityRatio,
    medianIssueLeadTimeHours,
    medianPRSize,
  };
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * Math.min(Math.max(ratio, 0), 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

function median(values: number[]): number {  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatDuration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  const days = hours / 24;
  return `${days.toFixed(1)}d`;
}

function formatMinutes(minutes: number): string {
  return formatDuration(minutes / 60);
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function escapeMarkdownTable(value: string): string {
  return value.replace(/\|/g, "\\|");
}
