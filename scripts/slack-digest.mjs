#!/usr/bin/env node
/**
 * Posts the Key Insights summary for a collected target to a Slack channel
 * via an incoming webhook (Block Kit payload).
 *
 * Usage: node scripts/slack-digest.mjs <owner> [org|user] [repo]
 *
 * Requires `npm run build` first (imports from dist/) and cached data in
 * data/ for the target. If SLACK_WEBHOOK_URL is unset the script is a
 * graceful no-op so the workflow step can run unconditionally.
 */
import { buildTargetKey, loadRawCache } from "../dist/cache.js";
import { computeEngineeringIntelligence } from "../dist/developer-stats.js";
import { computeDoraMetrics, computeReviewStats } from "../dist/dora.js";
import { computeHealthReport } from "../dist/health.js";
import { computeCollaborationStats } from "../dist/collaboration.js";
import { computeInsights } from "../dist/insights.js";

const MAX_INSIGHTS = 10;

/** @type {Record<string, string>} Severity marker per insight severity. */
const SEVERITY_MARKER = {
  critical: "🔴",
  warning: "🟠",
  info: "🔵",
  positive: "🟢",
};

async function main() {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log("SLACK_WEBHOOK_URL is not set — skipping Slack digest.");
    return;
  }

  const [owner, ownerTypeArg, repo] = process.argv.slice(2);
  if (!owner) {
    console.error("Usage: node scripts/slack-digest.mjs <owner> [org|user] [repo]");
    process.exit(1);
  }
  const ownerType = ownerTypeArg === "org" ? "org" : "user";

  const targetKey = buildTargetKey(owner, ownerType, repo || undefined);
  const metrics = loadRawCache(targetKey);
  if (!metrics) {
    console.error(`No cached metrics found for target "${targetKey}" — run collection first.`);
    process.exit(1);
  }

  const intel = computeEngineeringIntelligence(metrics);
  const health = computeHealthReport(metrics);
  const collaboration = computeCollaborationStats(metrics);
  const summary = computeInsights(metrics, {
    intel,
    dora: computeDoraMetrics(metrics),
    review: computeReviewStats(metrics),
    health,
    collaboration,
  });

  const payload = buildPayload(owner, metrics, summary);
  console.log(
    `Posting Slack digest for ${targetKey}: ${summary.insights.length} insight(s), ` +
      `${payload.blocks.length} block(s).`
  );

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.error(`Slack webhook returned ${response.status}: ${body}`);
    process.exit(1);
  }
  console.log(`Slack digest posted for ${targetKey} (${summary.insights.length} insights).`);
}

/**
 * Build the Slack Block Kit payload for an insights summary.
 * @param {string} owner
 * @param {{ collectedAt: string }} metrics
 * @param {{ insights: Array<{severity: string, title: string, detail: string, recommendation?: string}>, counts: Record<string, number> }} summary
 */
function buildPayload(owner, metrics, summary) {
  const collectedDate = String(metrics.collectedAt ?? "").slice(0, 10) || "unknown date";
  const countParts = ["critical", "warning", "info", "positive"]
    .filter((severity) => (summary.counts[severity] ?? 0) > 0)
    .map((severity) => `${summary.counts[severity]} ${severity}`);
  const countsText = countParts.length > 0 ? countParts.join(" · ") : "no findings";

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `DevEx digest — ${owner}`, emoji: true },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `Collected ${collectedDate} · ${countsText}` }],
    },
  ];

  if (summary.insights.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "No findings this week." },
    });
  } else {
    for (const insight of summary.insights.slice(0, MAX_INSIGHTS)) {
      const marker = SEVERITY_MARKER[insight.severity] ?? "🔵";
      let text = `${marker} *${insight.title}*\n${insight.detail}`;
      if (insight.recommendation) {
        text += `\n_${insight.recommendation}_`;
      }
      blocks.push({ type: "section", text: { type: "mrkdwn", text } });
    }
  }

  if (process.env.PAGES_URL) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `<${process.env.PAGES_URL}|View the full dashboard>` }],
    });
  }

  return { blocks };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
