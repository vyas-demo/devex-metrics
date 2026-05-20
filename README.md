# devex-metrics

**Website:** GitHub Pages deployment for this dashboard. For an organization-owned repo, the site URL is `https://<org>.github.io/devex-metrics/`.

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

Data is cached as JSON in `data/<target>.json` and only refreshed once per day. In GitHub Actions, the default collection target is `METRICS_OWNER` when set, otherwise the repository owner.

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

## Running in GitHub Actions

A workflow is included at `.github/workflows/collect-metrics.yml`. By default it collects the repository owner as an organization; manual runs or repository variables can override the owner, owner type, or repository.

Optional repository variables:

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `METRICS_OWNER` | Repository owner | GitHub org or user to collect |
| `METRICS_OWNER_TYPE` | `org` | Either `org` or `user` |
| `METRICS_REPO` | empty | Optional repo name or `owner/repo` scope |

### Option A – Personal Access Token

1. Create a **GitHub OAuth App** or **Personal Access Token** with `repo` and `read:org` scopes.
2. Add it as a repository secret named `METRICS_GITHUB_TOKEN`.
3. Optionally add `COPILOT_AGENT_TOKEN` as a fine-grained PAT with the "Agent tasks" repository permission to include Copilot agent metrics.

### Option B – GitHub App (recommended)

Using a GitHub App provides fine-grained permissions and higher rate limits.

1. [Create a GitHub App](https://docs.github.com/en/apps/creating-github-apps) with the required repository permissions (e.g. `Issues: read`, `Pull requests: read`, `Contents: read`).
2. Install the app on the target organisation or repositories.
3. Add the **App ID** as a repository variable named `APP_ID`.
4. Add the **App private key** (PEM) as a repository secret named `APP_PRIVATE_KEY`.
5. Optionally add `COPILOT_AGENT_TOKEN` as a fine-grained PAT with the "Agent tasks" repository permission to include Copilot agent metrics.

The installation ID is retrieved automatically at runtime.

### Deploying

1. Enable **GitHub Pages** in your repo settings (set source to *GitHub Actions*).
2. The workflow runs daily at 06:00 UTC. It:
   - Restores the previous day's cached data from `actions/cache`
   - Collects only new / changed metrics (skips if cached data is still fresh)
   - Saves the updated cache for the next run
   - Builds an HTML dashboard and deploys it to GitHub Pages
3. You can also trigger it manually via *Actions → Collect DevEx Metrics → Run workflow*.

No data is committed to the main branch — the cache lives in GitHub Actions and the report is published via GitHub Pages.

## Project structure

```
src/
  index.ts              # CLI entry point & orchestrator
  build-pages.ts        # Generates HTML site for GitHub Pages
  types.ts              # TypeScript interfaces
  github-client.ts      # Octokit singleton wrapper
  cache.ts              # JSON file-based daily cache
  report.ts             # Markdown report generator
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
