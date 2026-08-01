import { collect } from "./collect.js";
import { generateReport } from "./report.js";
import { buildTargetKey } from "./cache.js";
import { loadTargetsConfig, TARGETS_CONFIG_FILENAME } from "./targets.js";
import { loadRollupMetrics } from "./rollup.js";
import * as fs from "node:fs";
import * as path from "node:path";

export { collect } from "./collect.js";

/**
 * Collect every target of the configured rollup sequentially, then merge
 * their caches and write a combined Markdown report to
 * `data/<rollup-name>-report.md`. Exits 1 with a clear error when no config
 * or no valid rollup entry exists, or when nothing could be merged.
 */
async function runRollup(): Promise<void> {
  const config = loadTargetsConfig();
  if (!config) {
    console.error(
      `--rollup requires a ${TARGETS_CONFIG_FILENAME} in the working directory ` +
      `with a "rollup" entry (see devex.config.example.json).`
    );
    process.exit(1);
  }
  if (!config.rollup) {
    console.error(
      `${TARGETS_CONFIG_FILENAME} has no valid "rollup" entry; add one with a ` +
      `name and a targets array (see devex.config.example.json).`
    );
    process.exit(1);
  }

  const rollup = config.rollup;
  for (const target of rollup.targets) {
    const label = target.repo
      ? `${target.owner}/${target.repo} (${target.ownerType})`
      : `${target.owner} (${target.ownerType})`;
    console.log(`\n=== Collecting rollup target: ${label} ===`);
    await collect(target.owner, target.ownerType, { repo: target.repo });
  }

  const merged = loadRollupMetrics(rollup);
  if (!merged) {
    console.error(`Rollup "${rollup.name}" produced no data; nothing to report.`);
    process.exit(1);
  }

  const report = generateReport(merged);
  const reportPath = path.resolve(process.cwd(), "data", `${rollup.name}-report.md`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, report);
  console.log(`\nRollup report written to ${reportPath}`);
  console.log(`Build the merged dashboard with: node dist/build-pages.js --rollup`);
}

/**
 * CLI entry-point.
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxx node dist/index.js <owner> [org|user] [repo]
 *   GITHUB_TOKEN=ghp_xxx node dist/index.js --rollup
 */
async function main(): Promise<void> {
  if (process.argv[2] === "--rollup") {
    await runRollup();
    return;
  }

  const owner = process.argv[2];
  const ownerType = process.argv[3] ?? "org";
  const repo = process.argv[4];

  if (!owner) {
    console.error("Usage: devex-metrics <owner> [org|user] [repo] | devex-metrics --rollup");
    process.exit(1);
  }

  if (ownerType !== "org" && ownerType !== "user") {
    console.error(`Invalid owner type: "${ownerType}". Must be 'org' or 'user'.`);
    process.exit(1);
  }

  const typedOwnerType = ownerType as "org" | "user";
  const targetKey = buildTargetKey(owner, typedOwnerType, repo);
  const metrics = await collect(owner, typedOwnerType, { repo });
  const report = generateReport(metrics);
  const reportPath = path.resolve(process.cwd(), "data", `${targetKey}-report.md`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, report);
  console.log(`\nReport written to ${reportPath}`);

  // Also write JSON
  const jsonPath = path.resolve(process.cwd(), "data", `${targetKey}.json`);
  console.log(`JSON data cached at ${jsonPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
