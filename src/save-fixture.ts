import { collect } from "./collect.js";
import { buildTargetKey, loadFixture, saveFixture } from "./cache.js";

/**
 * Collect metrics and save as a fixture file for local development.
 *
 * By default, skips collection if the fixture was already collected today.
 * Set FORCE_REFRESH=true or pass --force to always fetch fresh data.
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxx node dist/save-fixture.js <owner> [org|user] [repo] [--force]
 *
 * After running:
 *   git add data/<owner>.fixture.json
 *   git commit -m "chore: update <owner> fixture data"
 */
async function main(): Promise<void> {
  const owner = process.argv[2];
  const ownerType = process.argv[3] ?? "org";
  const repoArg = process.argv[4] === "--force" ? undefined : process.argv[4];

  if (!owner) {
    console.error("Usage: save-fixture <owner> [org|user] [repo] [--force]");
    process.exit(1);
  }

  if (ownerType !== "org" && ownerType !== "user") {
    console.error(`Invalid owner type: "${ownerType}". Must be 'org' or 'user'.`);
    process.exit(1);
  }

  const typedOwnerType = ownerType as "org" | "user";
  const targetKey = buildTargetKey(owner, typedOwnerType, repoArg);

  const forceRefresh =
    process.env.FORCE_REFRESH === "true" ||
    process.argv.includes("--force");

  if (!forceRefresh) {
    const existing = loadFixture(targetKey);
    const todayStr = new Date().toISOString().slice(0, 10);
    if (existing?.collectedAt?.slice(0, 10) === todayStr) {
      console.log(
        `Fixture for ${owner} is already from today (${existing.collectedAt}). Skipping refresh.\n` +
        `Use --force or set FORCE_REFRESH=true to collect anyway.`
      );
      return;
    }
  }

  console.log(
    forceRefresh
      ? `Fetching fresh metrics for ${targetKey} (forced)…`
      : `Fetching fresh metrics for ${targetKey} (no fixture for today yet)…`
  );
  const metrics = await collect(owner, typedOwnerType, { skipCache: true, repo: repoArg });

  saveFixture(targetKey, metrics);

  console.log(`\n  Commit this file to share data across all worktrees:\n`);
  console.log(`  git add data/${targetKey}.fixture.json`);
  console.log(`  git commit -m "chore: update ${targetKey} fixture data"`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
