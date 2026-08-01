# devex-metrics

**Website:** GitHub Pages deployment for this dashboard. If the repository is hosted under `vyas-demo`, the site URL is `https://vyas-demo.github.io/devex-metrics/`.

DevEx reporting and dashboarding for GitHub repositories, organizations, and users.

## What it does

Collects developer-experience metrics for a GitHub **organization**, **user**, or a selected **repository** and produces a Markdown report plus a JSON cache file. Metrics include:

| Metric | Scope |
| ------ | ----- |
| Number of repositories | org / user / selected repo |
| Open / closed issues | per repo |
| Open / merged / closed pull requests | per repo |
| Lines added / deleted per PR | per PR |
| Comments & commits per PR | per PR |
| Estimated GitHub Actions minutes per PR | per PR |
| Unique committers (last 90 days) | per repo |
| Unique reviewers (last 90 days) | per repo |
| Dependent repository count | per repo |
| Developer insights: velocity, flow ratios, cycle predictability, issue lead time, median PR size | org / user / selected repo |
| Engineering intelligence: per-developer leaderboard, percentile benchmarks, calibrated work units, AI-vs-human impact | org / user / selected repo |
| Automated insights: evidence-backed findings & recommendations (review bottlenecks, cycle-time regressions, bus-factor risk, …) | org / user / selected repo |
| Repository health scores: composite 0–100 grade from activity, review coverage, cycle time, change failure, redundancy, backlog | per repo |
| Collaboration network: author↔reviewer graph, review-load concentration (Gini), bus factor, knowledge silos | org / user |
| DORA metrics: deploy frequency, lead time, change-failure rate, MTTR with dora.dev benchmark tiers | org / user / selected repo |
| Copilot usage metrics, feature mix, and per-user reports | org |
| Copilot CLI, code review, PR activity, model/language/IDE mix | org / enterprise |

Data is cached as JSON in `data/<target>.json` and only refreshed once per day.

## Quick start

```bash
# Install dependencies
npm install

# Build
npm run build

# Run with a personal access token (replace <owner> with a GitHub org or username)
GITHUB_TOKEN=ghp_xxx node dist/index.js <owner> [org|user] [repo]

# Or run with a GitHub App
APP_ID=12345 APP_PRIVATE_KEY="$(cat private-key.pem)" node dist/index.js <owner> [org|user] [repo]
```

Examples:

```bash
# Whole org
node dist/index.js microsoft org

# Whole user, including public org-owned repos they contribute to
node dist/index.js torvalds user

# One repo within an org or owner scope
node dist/index.js microsoft org typescript

# One contributed org-owned repo while targeting a user
node dist/index.js some-user user big-org/platform-repo
```

For `user` mode, the collector includes the user's own repositories plus public org-owned repositories they have contributed to.

The report is written to `data/<target>-report.md`, where `<target>` is the owner for owner-wide runs and a repo-specific cache key for repo-targeted runs.

The generated report and dashboard include a **Developer Insights** section that summarizes delivery velocity and flow health (PR throughput, PR/issue flow ratios, cycle-time predictability, issue lead time, and median PR size). These insights respond to period and repository filters in the dashboard.

## Running in GitHub Actions

A workflow is included at `.github/workflows/collect-metrics.yml`. It is configured to collect the `vyas-demo` organization by default; repository variables or workflow inputs can override the owner, owner type, or repository.

Optional repository variables:

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `METRICS_OWNER` | `vyas-demo` | GitHub org or user to collect |
| `METRICS_OWNER_TYPE` | `org` | Either `org` or `user` |
| `METRICS_REPO` | empty | Optional repo name or `owner/repo` scope |
| `COPILOT_USAGE_ENTERPRISE` | empty | Optional enterprise slug for enterprise-scoped Copilot usage reports |

### Option A – Personal Access Token

1. Create a **GitHub OAuth App** or **Personal Access Token** with `repo` and `read:org` scopes.
2. Add it as a repository secret named `METRICS_GITHUB_TOKEN`.
3. To include Copilot usage metrics, make sure the token can read organization Copilot metrics. Classic PATs can use `read:org`; fine-grained tokens need the equivalent organization Copilot metrics read permission.
4. Optionally add Copilot billing/seats read permission (`manage_billing:copilot` for classic PATs, or the equivalent fine-grained permission) to enrich per-user rows with assigned-seat and last-activity data.
5. Optionally add `COPILOT_AGENT_TOKEN` as a fine-grained PAT with the "Agent tasks" repository permission to include Copilot agent metrics.

### Option B – GitHub App (recommended)

Using a GitHub App provides fine-grained permissions and higher rate limits.

1. [Create a GitHub App](https://docs.github.com/en/apps/creating-github-apps) with the required repository permissions (e.g. `Issues: read`, `Pull requests: read`, `Contents: read`) and organization permissions (`Members: read`; `Organization Copilot metrics: read` when collecting Copilot usage).
2. Install the app on the target organisation or repositories.
3. Add the **App ID** as a repository variable named `APP_ID`.
4. Add the **App private key** (PEM) as a repository secret named `APP_PRIVATE_KEY`.
5. Optionally add `COPILOT_AGENT_TOKEN` as a fine-grained PAT with the "Agent tasks" repository permission to include Copilot agent metrics.

The installation ID is retrieved automatically at runtime.

### Copilot usage reports

For organization targets, devex-metrics uses the current Copilot usage metrics report APIs instead of the retired legacy metrics endpoints. Set `COPILOT_USAGE_ENTERPRISE` to an enterprise slug to collect enterprise-scoped Copilot usage reports instead of organization-scoped reports. GitHub returns short-lived `download_links`; the collector downloads and normalizes those report files into:

- org-level Copilot usage totals and daily activity
- per-user Copilot usage rows
- feature, IDE, language, model, and team breakdowns when available
- CLI sessions, requests, token counts, and latest CLI versions
- official Copilot pull request activity, code review users, and review suggestion application counts
- IDE/plugin version coverage and Copilot billing or policy settings when available
- optional assigned-seat and last-activity enrichment from Copilot billing/seat APIs

The HTML dashboard includes searchable, filterable, and sortable Copilot per-user reports. GitHub may return `204`, `403`, or `404` when reports are not enabled, not yet available, or the token lacks permission. In those cases the workflow skips Copilot usage gracefully and still publishes the rest of the dashboard. Copilot usage data is normally delayed by up to two full UTC days.

Team rollups are joined from the user-team report for the report end day. For historically exact rolling team reports, use the daily `users-1-day` and `user-teams-1-day` endpoints for each day in the window and join each day before aggregating, because team membership can change over time.

### Deploying

1. Enable **GitHub Pages** in your repo settings (set source to *GitHub Actions*).
2. The workflow runs daily at 06:00 UTC. It:
   - Restores the previous day's cached data from `actions/cache`
   - Collects only new / changed metrics (skips if cached data is still fresh)
   - Saves the updated cache for the next run
   - Builds an HTML dashboard and deploys it to GitHub Pages
3. You can also trigger it manually via *Actions → Collect DevEx Metrics → Run workflow*.

No data is committed to the main branch — the cache lives in GitHub Actions and the report is published via GitHub Pages.

### Status badges

Each Pages deploy also publishes three [shields.io endpoint](https://shields.io/badges/endpoint-badge) sources next to the dashboard:

- `badge-health.json` — average repository health score and letter grade
- `badge-dora.json` — DORA lead time for changes with its benchmark tier
- `badge-throughput.json` — merged PRs in the last 30 days

Embed them in any README via the shields endpoint badge, replacing `<pages-url>` with your dashboard URL:

```markdown
![DevEx health](https://img.shields.io/endpoint?url=<pages-url>/badge-health.json)
![DORA lead time](https://img.shields.io/endpoint?url=<pages-url>/badge-dora.json)
![Merged PRs](https://img.shields.io/endpoint?url=<pages-url>/badge-throughput.json)
```

### Slack digest (optional)

To have each daily run post the Key Insights summary to a Slack channel:

1. [Create a Slack incoming webhook](https://api.slack.com/messaging/webhooks) for the target channel.
2. Add the webhook URL as a repository secret named `SLACK_WEBHOOK_URL`.
3. Optionally add a repository variable named `PAGES_URL` with the dashboard URL — the digest then links to it.

The workflow posts the same insights shown in the dashboard's Key Insights section (severity, headline, evidence, and recommendation). If the secret is not configured, the digest step is skipped and the rest of the workflow is unaffected.

### Multi-org rollups

To publish one merged dashboard across several orgs or users, add a `rollup` entry to `devex.config.json` (see `devex.config.example.json`):

```json
{
  "rollup": {
    "name": "acme-all",
    "targets": [
      { "owner": "acme", "ownerType": "org" },
      { "owner": "acme-labs", "ownerType": "org" }
    ]
  }
}
```

Then collect each owner and build the merged site:

```bash
# Collect every rollup target in one go (sequentially)…
node dist/index.js --rollup

# …or collect each owner yourself
node dist/index.js acme org
node dist/index.js acme-labs org

# Build one merged dashboard named after the rollup (here: acme-all)
node dist/build-pages.js --rollup
```

`node dist/index.js --rollup` also writes a combined Markdown report to `data/<name>-report.md`. The merged view concatenates the repos of all targets (deduplicating by full name), sums weekly trends, and keeps its own history file so the rollup dashboard gets week-over-week deltas.

Notes:

- Every target must have a fresh, schema-current cache in `data/` — targets without one are skipped with a warning, so collect each owner first.
- Copilot usage metrics are included only when exactly **one** target has them; usage reports from multiple scopes can cover overlapping user populations, so merging their counters would double-count and the rollup drops them instead.

## Project structure

```
src/
  index.ts              # CLI entry point & orchestrator
  build-pages.ts        # Generates HTML site for GitHub Pages
  types.ts              # TypeScript interfaces
  github-client.ts      # Octokit singleton wrapper
  cache.ts              # JSON file-based daily cache
  report.ts             # Markdown report generator
  developer-stats.ts    # Engineering intelligence (leaderboard, benchmarks, work units, AI impact)
  dora.ts               # DORA metrics + code-review analytics
  health.ts             # Composite repository health scores
  collaboration.ts      # Reviewer graph, bus factor, knowledge silos
  insights.ts           # Automated findings & recommendations engine
  collectors/
    repos.ts            # List repositories
    issues.ts           # Issue counts
    pull-requests.ts    # PR counts & detailed PR metrics
    contributors.ts     # Committer & reviewer counts
    dependents.ts       # Dependent repo count
data/                   # Local cache (gitignored; persisted via actions/cache in CI)
_site/                  # Generated GitHub Pages site (gitignored)
.github/workflows/
  collect-metrics.yml   # Scheduled GitHub Actions workflow
```

## Testing

```bash
npm test
```

## License

[CC0 1.0 Universal](LICENSE)
