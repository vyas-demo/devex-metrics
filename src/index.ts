import { collect } from "./collect.js";
import { generateReport } from "./report.js";
import { buildTargetKey } from "./cache.js";
import * as fs from "node:fs";
import * as path from "node:path";

export { collect } from "./collect.js";

/**
 * CLI entry-point.
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxx node dist/index.js <owner> [org|user] [repo]
 */
async function main(): Promise<void> {
  const owner = process.argv[2];
  const ownerType = process.argv[3] ?? "org";
  const repo = process.argv[4];

  if (!owner) {
    console.error("Usage: devex-metrics <owner> [org|user] [repo]");
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
