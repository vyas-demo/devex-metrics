import { getOctokit } from "../github-client.js";
import type {
  CopilotAiAdoptionPhase,
  CopilotAiAdoptionPhaseImpact,
  CopilotBillingSettings,
  CopilotCodeReviewUsage,
  CopilotUsageBreakdown,
  CopilotUsageCliMetrics,
  CopilotUsageCounters,
  CopilotUsageDailyTotal,
  CopilotUsageIdeVersionMetrics,
  CopilotUsageMetrics,
  CopilotPullRequestActivity,
  CopilotRepositoryUsageMetrics,
  CopilotReviewCommentTypeBreakdown,
  CopilotUsageTotals,
  CopilotUsageUserMetrics,
} from "../types.js";

const COPILOT_USAGE_API_VERSION = "2026-03-10";

type OctokitRequester = {
  request: (
    route: string,
    options?: Record<string, unknown>,
  ) => Promise<{ status?: number; data: unknown }>;
};

type UsageScope = "organization" | "enterprise";

interface ReportLinks {
  downloadLinks: string[];
  reportStartDay?: string;
  reportEndDay?: string;
  reportDay?: string;
}

interface SeatInfo {
  login: string;
  createdAt?: string;
  updatedAt?: string;
  pendingCancellationDate?: string;
  lastActivityAt?: string;
  lastActivityEditor?: string;
  lastAuthenticatedAt?: string;
  planType?: string;
}

interface BillingSummary {
  settings?: CopilotBillingSettings;
}

interface UserAccumulator extends CopilotUsageCounters {
  login: string;
  userId?: string;
  days: Set<string>;
  aiAdoptionPhase?: CopilotAiAdoptionPhase;
  aiAdoptionPhaseDay?: string;
  teams: Set<string>;
  usedChat: boolean;
  usedAgent: boolean;
  usedCli: boolean;
  usedCodeReviewActive: boolean;
  usedCodeReviewPassive: boolean;
  cli: CopilotUsageCliMetrics;
  lastKnownIdeVersion?: string;
  lastKnownPluginVersion?: string;
  lastKnownPlugin?: string;
  lastKnownVersionSampledAt?: string;
  seat?: SeatInfo;
}

interface BreakdownAccumulator extends CopilotUsageCounters {
  name: string;
  userKeys: Set<string>;
  feature?: string;
  ide?: string;
  language?: string;
  model?: string;
  isCustomModel?: boolean;
  customModelTrainingDate?: string;
}

interface IdeVersionAccumulator {
  ide: string;
  ideVersion?: string;
  plugin?: string;
  pluginVersion?: string;
  sampledAt?: string;
  userKeys: Set<string>;
}

interface UsageRoutes {
  scope: UsageScope;
  scopeName: string;
  params: Record<string, unknown>;
  usersRoute: string;
  aggregateRoute: string;
  repositoriesRoute: string;
}

interface DownloadedReport {
  links: ReportLinks;
  rows: unknown[];
}

/**
 * Collect Copilot usage metrics from the current report-download APIs.
 *
 * The legacy inline Copilot metrics endpoints were shut down in 2026. The new
 * APIs return short-lived download links to JSON/NDJSON report files; this
 * collector fetches the latest 28-day organization users report, the matching
 * organization aggregate report, repository-level PR activity, and Copilot
 * seat activity when the token can read it.
 */
export async function collectCopilotUsageMetrics(
  owner: string,
  ownerType: "org" | "user",
): Promise<CopilotUsageMetrics | null> {
  const routes = buildUsageRoutes(owner, ownerType);
  if (!routes) return null;

  const octokit = asRequester(await getOctokit());
  const usersLinks = await getReportLinks(
    octokit,
    routes.usersRoute,
    routes.params,
    `${routes.scope} users usage metrics`,
  );
  if (!usersLinks) return null;
  if (!usersLinks.reportStartDay || !usersLinks.reportEndDay) {
    console.warn("  ⚠ copilot-usage: users report is missing its required 28-day window");
    return null;
  }

  const userRows = await downloadReportRows(usersLinks.downloadLinks);
  const reportEndDay = usersLinks.reportEndDay;
  const [aggregateReport, rawRepositoryReport, seats, billing] = await Promise.all([
    collectOptionalReport(
      octokit,
      routes.aggregateRoute,
      routes.params,
      `${routes.scope} usage metrics`,
    ),
    reportEndDay
      ? collectOptionalReport(
          octokit,
          routes.repositoriesRoute,
          { ...routes.params, day: reportEndDay },
          `${routes.scope} repository usage metrics`,
        )
      : Promise.resolve(null),
    routes.scope === "organization" ? collectSeatAssignments(octokit, owner) : Promise.resolve(new Map<string, SeatInfo>()),
    routes.scope === "organization" ? collectBillingSummary(octokit, owner) : Promise.resolve({}),
  ]);
  const alignedAggregateReport = alignAggregateReport(aggregateReport, usersLinks);
  const repositoryReport = alignRepositoryReport(rawRepositoryReport, reportEndDay);

  return normalizeCopilotUsageMetrics({
    scope: routes.scope,
    scopeName: routes.scopeName,
    reportStartDay: usersLinks.reportStartDay,
    reportEndDay,
    userRows,
    dailyRows: alignedAggregateReport?.rows ?? [],
    repositoryReport,
    seats,
    billing,
  });
}

function buildUsageRoutes(owner: string, ownerType: "org" | "user"): UsageRoutes | null {
  const enterprise = process.env.COPILOT_USAGE_ENTERPRISE?.trim();
  if (enterprise) {
    return {
      scope: "enterprise",
      scopeName: enterprise,
      params: { enterprise },
      usersRoute: "GET /enterprises/{enterprise}/copilot/metrics/reports/users-28-day/latest",
      aggregateRoute: "GET /enterprises/{enterprise}/copilot/metrics/reports/enterprise-28-day/latest",
      repositoriesRoute: "GET /enterprises/{enterprise}/copilot/metrics/reports/repos-1-day",
    };
  }
  if (ownerType !== "org") return null;
  return {
    scope: "organization",
    scopeName: owner,
    params: { org: owner },
    usersRoute: "GET /orgs/{org}/copilot/metrics/reports/users-28-day/latest",
    aggregateRoute: "GET /orgs/{org}/copilot/metrics/reports/organization-28-day/latest",
    repositoriesRoute: "GET /orgs/{org}/copilot/metrics/reports/repos-1-day",
  };
}

/** Parse a Copilot usage report file body as JSON array, JSON object, or NDJSON. */
export function parseCopilotUsageReport(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as unknown);
  }
}

function asRequester(octokit: Awaited<ReturnType<typeof getOctokit>>): OctokitRequester {
  return octokit as unknown as OctokitRequester;
}

async function getReportLinks(
  octokit: OctokitRequester,
  route: string,
  params: Record<string, unknown>,
  label: string,
): Promise<ReportLinks | null> {
  try {
    const response = await octokit.request(route, {
      ...params,
      headers: {
        "X-GitHub-Api-Version": COPILOT_USAGE_API_VERSION,
        accept: "application/vnd.github+json",
      },
    });
    if (response.status === 204) return null;
    if (!isRecord(response.data)) return null;

    const downloadLinks = requiredStringArray(response.data, "download_links");
    if (!downloadLinks) return null;
    return {
      downloadLinks,
      reportStartDay: optionalString(response.data.report_start_day),
      reportEndDay: optionalString(response.data.report_end_day),
      reportDay: optionalString(response.data.report_day),
    };
  } catch (err: unknown) {
    const status = getStatus(err);
    if (status === 204 || status === 403 || status === 404) {
      console.warn(
        `  ⚠ copilot-usage: skipping ${label}: ${status} ` +
          `(check Copilot usage metrics policy and token permissions)`,
      );
      return null;
    }
    throw err;
  }
}

function alignAggregateReport(
  report: DownloadedReport | null,
  usersLinks: ReportLinks,
): DownloadedReport | null {
  if (!report) return null;
  if (
    !usersLinks.reportStartDay ||
    !usersLinks.reportEndDay ||
    report.links.reportStartDay !== usersLinks.reportStartDay ||
    report.links.reportEndDay !== usersLinks.reportEndDay
  ) {
    console.warn("  ⚠ copilot-usage: aggregate report window does not match users report; skipping aggregate metrics");
    return null;
  }
  return report;
}

function alignRepositoryReport(
  report: DownloadedReport | null,
  requestedDay: string | undefined,
): DownloadedReport | null {
  if (!report) return null;
  if (!requestedDay || report.links.reportDay !== requestedDay) {
    console.warn("  ⚠ copilot-usage: repository report day does not match requested usage day; skipping repository metrics");
    return null;
  }
  return report;
}

async function collectOptionalReport(
  octokit: OctokitRequester,
  route: string,
  params: Record<string, unknown>,
  label: string,
): Promise<DownloadedReport | null> {
  const links = await getReportLinks(octokit, route, params, label);
  if (!links) return null;
  try {
    return { links, rows: await downloadReportRows(links.downloadLinks) };
  } catch {
    console.warn(`  ⚠ copilot-usage: skipping incomplete ${label}`);
    return null;
  }
}

async function downloadReportRows(downloadLinks: string[]): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (const url of downloadLinks) {
    const response = await fetch(url, {
      headers: { accept: "application/json, application/x-ndjson" },
    });
    if (!response.ok) {
      throw new Error(`Failed to download Copilot usage report file (${response.status})`);
    }
    rows.push(...parseCopilotUsageReport(await response.text()));
  }
  return rows;
}

async function collectSeatAssignments(
  octokit: OctokitRequester,
  org: string,
): Promise<Map<string, SeatInfo>> {
  const seats = new Map<string, SeatInfo>();
  try {
    let page = 1;
    while (true) {
      const response = await octokit.request("GET /orgs/{org}/copilot/billing/seats", {
        org,
        page,
        per_page: 100,
        headers: {
          "X-GitHub-Api-Version": COPILOT_USAGE_API_VERSION,
          accept: "application/vnd.github+json",
        },
      });
      if (!isRecord(response.data)) break;
      const rawSeats = getRecordArray(response.data, "seats");
      for (const rawSeat of rawSeats) {
        const assignee = getRecord(rawSeat, "assignee");
        const login = assignee ? optionalString(assignee.login) : undefined;
        if (!login) continue;
        seats.set(login.toLowerCase(), {
          login,
          createdAt: optionalString(rawSeat.created_at),
          updatedAt: optionalString(rawSeat.updated_at),
          pendingCancellationDate: optionalString(rawSeat.pending_cancellation_date),
          lastActivityAt: optionalString(rawSeat.last_activity_at),
          lastActivityEditor: optionalString(rawSeat.last_activity_editor),
          lastAuthenticatedAt: optionalString(rawSeat.last_authenticated_at),
          planType: optionalString(rawSeat.plan_type),
        });
      }
      if (rawSeats.length < 100) break;
      page++;
    }
  } catch (err: unknown) {
    const status = getStatus(err);
    if (status === 403 || status === 404 || status === 422) {
      console.warn(`  ⚠ copilot-usage: seat enrichment unavailable (${status})`);
      return seats;
    }
    throw err;
  }
  return seats;
}

async function collectBillingSummary(
  octokit: OctokitRequester,
  org: string,
): Promise<BillingSummary> {
  try {
    const response = await octokit.request("GET /orgs/{org}/copilot/billing", {
      org,
      headers: {
        "X-GitHub-Api-Version": COPILOT_USAGE_API_VERSION,
        accept: "application/vnd.github+json",
      },
    });
    if (!isRecord(response.data)) return {};
    const breakdown = getRecord(response.data, "seat_breakdown");
    return {
      settings: {
        assignedSeats: breakdown ? numberFrom(breakdown.total) : 0,
        addedThisCycle: breakdown ? numberFrom(breakdown.added_this_cycle) : 0,
        pendingInvitation: breakdown ? numberFrom(breakdown.pending_invitation) : 0,
        pendingCancellation: breakdown ? numberFrom(breakdown.pending_cancellation) : 0,
        activeThisCycle: breakdown ? numberFrom(breakdown.active_this_cycle) : 0,
        inactiveThisCycle: breakdown ? numberFrom(breakdown.inactive_this_cycle) : 0,
        seatManagementSetting: optionalString(response.data.seat_management_setting),
        ideChat: optionalString(response.data.ide_chat),
        platformChat: optionalString(response.data.platform_chat),
        cli: optionalString(response.data.cli),
        publicCodeSuggestions: optionalString(response.data.public_code_suggestions),
        planType: optionalString(response.data.plan_type),
      },
    };
  } catch (err: unknown) {
    const status = getStatus(err);
    if (status === 403 || status === 404 || status === 422) return {};
    throw err;
  }
}

function normalizeCopilotUsageMetrics(input: {
  scope: UsageScope;
  scopeName: string;
  reportStartDay?: string;
  reportEndDay?: string;
  userRows: unknown[];
  dailyRows: unknown[];
  repositoryReport: DownloadedReport | null;
  seats: Map<string, SeatInfo>;
  billing: BillingSummary;
}): CopilotUsageMetrics {
  const users = new Map<string, UserAccumulator>();
  const featureBreakdowns = new Map<string, BreakdownAccumulator>();
  const ideBreakdowns = new Map<string, BreakdownAccumulator>();
  const languageBreakdowns = new Map<string, BreakdownAccumulator>();
  const modelBreakdowns = new Map<string, BreakdownAccumulator>();
  const languageFeatureBreakdowns = new Map<string, BreakdownAccumulator>();
  const languageModelBreakdowns = new Map<string, BreakdownAccumulator>();
  const modelFeatureBreakdowns = new Map<string, BreakdownAccumulator>();
  const ideVersions = new Map<string, IdeVersionAccumulator>();

  for (const rawRow of input.userRows) {
    if (!isRecord(rawRow)) continue;
    const user = userFromRow(rawRow);
    const day = optionalString(rawRow.day) ?? optionalString(rawRow.day_partition);
    const primaryKey = userKeys(user.login, user.userId)[0];
    const accumulator = getUserAccumulator(users, user.login, user.userId);
    const adoptionPhase = parseAiAdoptionPhase(rawRow);
    if (
      adoptionPhase &&
      (!accumulator.aiAdoptionPhase || (day ?? "") >= (accumulator.aiAdoptionPhaseDay ?? ""))
    ) {
      accumulator.aiAdoptionPhase = adoptionPhase;
      accumulator.aiAdoptionPhaseDay = day;
    }
    addCounters(accumulator, readCounters(rawRow));
    accumulator.usedChat ||= toBoolean(rawRow.used_chat);
    accumulator.usedAgent ||= toBoolean(rawRow.used_agent);
    accumulator.usedCli ||= toBoolean(rawRow.used_cli);
    accumulator.usedCodeReviewActive ||= toBoolean(rawRow.used_copilot_code_review_active);
    accumulator.usedCodeReviewPassive ||= toBoolean(rawRow.used_copilot_code_review_passive);
    mergeCliMetrics(accumulator.cli, readCliMetrics(rawRow));
    if (day) accumulator.days.add(day);

    const featureRows = getRecordArray(rawRow, "totals_by_feature");
    const languageFeatureRows = getRecordArray(rawRow, "totals_by_language_feature");
    const languageModelRows = getRecordArray(rawRow, "totals_by_language_model");
    const modelFeatureRows = getRecordArray(rawRow, "totals_by_model_feature");

    for (const row of featureRows) {
      const feature = optionalString(row.feature) ?? "unknown";
      addBreakdown(featureBreakdowns, feature, row, primaryKey, { feature });
    }
    for (const row of getRecordArray(rawRow, "totals_by_ide")) {
      const ide = optionalString(row.ide) ?? "unknown";
      addBreakdown(ideBreakdowns, ide, row, primaryKey, { ide });
      addIdeVersion(ideVersions, ide, row, primaryKey);
      updateUserVersion(accumulator, row);
    }
    for (const row of languageFeatureRows) {
      const language = optionalString(row.language) ?? "unknown";
      const feature = optionalString(row.feature) ?? "unknown";
      addBreakdown(languageBreakdowns, language, row, primaryKey, { language });
      addBreakdown(languageFeatureBreakdowns, `${language} / ${feature}`, row, primaryKey, { language, feature });
    }
    for (const row of languageModelRows) {
      const language = optionalString(row.language) ?? "unknown";
      const model = optionalString(row.model) ?? "unknown";
      addBreakdown(languageModelBreakdowns, `${language} / ${model}`, row, primaryKey, {
        language,
        model,
        isCustomModel: optionalBoolean(row.is_custom_model),
        customModelTrainingDate: optionalString(row.custom_model_training_date),
      });
      if (languageFeatureRows.length === 0) {
        addBreakdown(languageBreakdowns, language, row, primaryKey, { language });
      }
    }
    for (const row of modelFeatureRows) {
      const model = optionalString(row.model) ?? "unknown";
      const feature = optionalString(row.feature) ?? "unknown";
      const modelMeta = {
        model,
        feature,
        isCustomModel: optionalBoolean(row.is_custom_model),
        customModelTrainingDate: optionalString(row.custom_model_training_date),
      };
      addBreakdown(modelBreakdowns, model, row, primaryKey, modelMeta);
      addBreakdown(modelFeatureBreakdowns, `${model} / ${feature}`, row, primaryKey, modelMeta);
    }
    if (featureRows.length === 0) {
      for (const row of [...languageFeatureRows, ...modelFeatureRows]) {
        const feature = optionalString(row.feature) ?? "unknown";
        addBreakdown(featureBreakdowns, feature, row, primaryKey, { feature });
      }
    }
    if (modelFeatureRows.length === 0) {
      for (const row of languageModelRows) {
        const model = optionalString(row.model) ?? "unknown";
        addBreakdown(modelBreakdowns, model, row, primaryKey, {
          model,
          isCustomModel: optionalBoolean(row.is_custom_model),
          customModelTrainingDate: optionalString(row.custom_model_training_date),
        });
      }
    }
  }

  for (const seat of input.seats.values()) {
    const accumulator = getUserAccumulator(users, seat.login);
    accumulator.seat = seat;
  }

  const userSummaries = Array.from(new Set(users.values()))
    .map(toUserMetrics)
    .sort((a, b) =>
      b.userInitiatedInteractions - a.userInitiatedInteractions ||
      b.locAdded - a.locAdded ||
      a.login.localeCompare(b.login, undefined, { sensitivity: "base" }),
    );
  const dailyTotals = parseDailyTotals(input.dailyRows);
  const userCliTotals = aggregateCliMetrics(userSummaries.map((user) => user.cli));
  const dailyCliTotals = aggregateCliMetrics(dailyTotals.map((row) => row.cli));
  const repositoryRows = input.repositoryReport?.links.reportDay
    ? parseRepositoryUsageRows(
        input.repositoryReport.rows,
        input.repositoryReport.links.reportDay,
      )
    : undefined;

  return {
    scope: input.scope,
    scopeName: input.scopeName,
    reportStartDay: input.reportStartDay,
    reportEndDay: input.reportEndDay,
    collectedAt: new Date().toISOString(),
    totals: buildTotals(userSummaries, input.seats, input.billing),
    billing: input.billing.settings,
    cli: hasCliUsage(userCliTotals) ? userCliTotals : dailyCliTotals,
    pullRequests: aggregatePullRequests(dailyTotals.map((row) => row.pullRequests)),
    codeReview: latestCodeReview(dailyTotals),
    repositoryReport: input.repositoryReport && repositoryRows
      ? {
          reportDay: input.repositoryReport.links.reportDay ?? "",
          repositories: repositoryRows,
        }
      : undefined,
    repositoryReportStatus: input.repositoryReport && repositoryRows ? "available" : "unavailable",
    users: userSummaries,
    dailyTotals,
    byFeature: toBreakdowns(featureBreakdowns),
    byIde: toBreakdowns(ideBreakdowns),
    byLanguage: toBreakdowns(languageBreakdowns),
    byModel: toBreakdowns(modelBreakdowns),
    byTeam: buildTeamBreakdowns(userSummaries),
    byLanguageFeature: toBreakdowns(languageFeatureBreakdowns),
    byLanguageModel: toBreakdowns(languageModelBreakdowns),
    byModelFeature: toBreakdowns(modelFeatureBreakdowns),
    ideVersions: toIdeVersions(ideVersions),
  };
}

function userFromRow(row: Record<string, unknown>): { login: string; userId?: string } {
  const userId = optionalString(row.user_id) ?? optionalNumber(row.user_id)?.toString();
  const login = optionalString(row.user_login) ?? (userId ? `user-${userId}` : "unknown");
  return { login, userId };
}

function getUserAccumulator(
  users: Map<string, UserAccumulator>,
  login: string,
  userId?: string,
): UserAccumulator {
  const existing = userKeys(login, userId)
    .map((key) => users.get(key))
    .find((user) => user !== undefined);
  if (existing) {
    if (!existing.userId && userId) existing.userId = userId;
    return existing;
  }

  const accumulator: UserAccumulator = {
    ...emptyCounters(),
    login,
    userId,
    days: new Set(),
    teams: new Set(),
    usedChat: false,
    usedAgent: false,
    usedCli: false,
    usedCodeReviewActive: false,
    usedCodeReviewPassive: false,
    cli: emptyCliMetrics(),
  };
  for (const key of userKeys(login, userId)) users.set(key, accumulator);
  return accumulator;
}

function toUserMetrics(user: UserAccumulator): CopilotUsageUserMetrics {
  const counters = withAcceptanceRate(copyCounters(user));
  const sortedDays = Array.from(user.days).sort();
  return {
    ...counters,
    login: user.login,
    userId: user.userId,
    activeDays: sortedDays.length > 0 ? sortedDays.length : hasCounterActivity(counters) ? 1 : 0,
    lastUsageDay: sortedDays[sortedDays.length - 1],
    aiAdoptionPhase: user.aiAdoptionPhase,
    teams: Array.from(user.teams).sort((a, b) => a.localeCompare(b)),
    usedChat: user.usedChat,
    usedAgent: user.usedAgent,
    usedCli: user.usedCli,
    usedCodeReviewActive: user.usedCodeReviewActive,
    usedCodeReviewPassive: user.usedCodeReviewPassive,
    cli: hasCliUsage(user.cli) ? user.cli : undefined,
    lastKnownIdeVersion: user.lastKnownIdeVersion,
    lastKnownPluginVersion: user.lastKnownPluginVersion,
    lastKnownPlugin: user.lastKnownPlugin,
    seatCreatedAt: user.seat?.createdAt,
    seatUpdatedAt: user.seat?.updatedAt,
    pendingCancellationDate: user.seat?.pendingCancellationDate,
    lastActivityAt: user.seat?.lastActivityAt,
    lastActivityEditor: user.seat?.lastActivityEditor,
    lastAuthenticatedAt: user.seat?.lastAuthenticatedAt,
    planType: user.seat?.planType,
  };
}

function buildTotals(
  users: CopilotUsageUserMetrics[],
  seats: Map<string, SeatInfo>,
  billing: BillingSummary,
): CopilotUsageTotals {
  const totals: CopilotUsageTotals = {
    ...emptyCounters(),
    totalUsers: users.length,
    activeUsers: users.filter(hasUsage).length,
    chatUsers: users.filter((user) => user.usedChat).length,
    agentUsers: users.filter((user) => user.usedAgent).length,
    cliUsers: users.filter((user) => user.usedCli).length,
    codeReviewActiveUsers: users.filter((user) => user.usedCodeReviewActive).length,
    codeReviewPassiveUsers: users.filter((user) => user.usedCodeReviewPassive).length,
    assignedSeats: billing.settings?.assignedSeats ?? seats.size,
    seatsActiveThisCycle:
      billing.settings?.activeThisCycle ?? Array.from(seats.values()).filter((seat) => seat.lastActivityAt).length,
  };
  for (const user of users) addCounters(totals, user);
  return withAcceptanceRate(totals) as CopilotUsageTotals;
}

function buildTeamBreakdowns(users: CopilotUsageUserMetrics[]): CopilotUsageBreakdown[] {
  const teams = new Map<string, BreakdownAccumulator>();
  for (const user of users) {
    for (const team of user.teams) addBreakdown(teams, team, user, user.login.toLowerCase());
  }
  return toBreakdowns(teams);
}

function latestCodeReview(rows: CopilotUsageDailyTotal[]): CopilotCodeReviewUsage {
  const latest = [...rows].sort((a, b) => b.day.localeCompare(a.day))[0];
  return latest?.codeReview ?? emptyCodeReviewUsage();
}

function aggregateCliMetrics(metrics: Array<CopilotUsageCliMetrics | undefined>): CopilotUsageCliMetrics {
  const total = emptyCliMetrics();
  for (const item of metrics) {
    if (item) mergeCliMetrics(total, item);
  }
  return finalizeCliMetrics(total);
}

function mergeCliMetrics(target: CopilotUsageCliMetrics, source: CopilotUsageCliMetrics): void {
  target.sessionCount += source.sessionCount;
  target.requestCount += source.requestCount;
  target.promptCount += source.promptCount;
  target.promptTokens += source.promptTokens;
  target.outputTokens += source.outputTokens;
  const targetSample = target.lastKnownCliVersionSampledAt ?? "";
  const sourceSample = source.lastKnownCliVersionSampledAt ?? "";
  if (source.lastKnownCliVersion && sourceSample >= targetSample) {
    target.lastKnownCliVersion = source.lastKnownCliVersion;
    target.lastKnownCliVersionSampledAt = source.lastKnownCliVersionSampledAt;
  }
  target.avgTokensPerRequest = cliAvgTokens(target);
}

function finalizeCliMetrics(metrics: CopilotUsageCliMetrics): CopilotUsageCliMetrics {
  return { ...metrics, avgTokensPerRequest: cliAvgTokens(metrics) };
}

function cliAvgTokens(metrics: CopilotUsageCliMetrics): number {
  if (metrics.requestCount <= 0) return 0;
  return Math.round(((metrics.promptTokens + metrics.outputTokens) / metrics.requestCount) * 100) / 100;
}

function hasCliUsage(metrics: CopilotUsageCliMetrics): boolean {
  return metrics.sessionCount > 0 || metrics.requestCount > 0 || metrics.promptCount > 0;
}

function emptyCliMetrics(): CopilotUsageCliMetrics {
  return {
    sessionCount: 0,
    requestCount: 0,
    promptCount: 0,
    promptTokens: 0,
    outputTokens: 0,
    avgTokensPerRequest: 0,
  };
}

function readCliMetrics(row: Record<string, unknown>): CopilotUsageCliMetrics {
  const rawCli = getRecord(row, "totals_by_cli");
  if (!rawCli) return emptyCliMetrics();
  const tokenUsage = getRecord(rawCli, "token_usage");
  const version = getRecord(rawCli, "last_known_cli_version");
  const metrics: CopilotUsageCliMetrics = {
    sessionCount: numberFrom(rawCli.session_count),
    requestCount: numberFrom(rawCli.request_count),
    promptCount: numberFrom(rawCli.prompt_count),
    promptTokens: tokenUsage ? numberFrom(tokenUsage.prompt_tokens_sum) : 0,
    outputTokens: tokenUsage ? numberFrom(tokenUsage.output_tokens_sum) : 0,
    avgTokensPerRequest: tokenUsage ? numberFrom(tokenUsage.avg_tokens_per_request) : 0,
    lastKnownCliVersion: version ? optionalString(version.cli_version) : undefined,
    lastKnownCliVersionSampledAt: version ? optionalString(version.sampled_at) : undefined,
  };
  return metrics.avgTokensPerRequest > 0 ? metrics : finalizeCliMetrics(metrics);
}

function emptyCodeReviewUsage(): CopilotCodeReviewUsage {
  return {
    dailyActiveUsers: 0,
    dailyPassiveUsers: 0,
    weeklyActiveUsers: 0,
    weeklyPassiveUsers: 0,
    monthlyActiveUsers: 0,
    monthlyPassiveUsers: 0,
  };
}

function readCodeReviewUsage(row: Record<string, unknown>): CopilotCodeReviewUsage {
  return {
    dailyActiveUsers: numberFrom(row.daily_active_copilot_code_review_users),
    dailyPassiveUsers: numberFrom(row.daily_passive_copilot_code_review_users),
    weeklyActiveUsers: numberFrom(row.weekly_active_copilot_code_review_users),
    weeklyPassiveUsers: numberFrom(row.weekly_passive_copilot_code_review_users),
    monthlyActiveUsers: numberFrom(row.monthly_active_copilot_code_review_users),
    monthlyPassiveUsers: numberFrom(row.monthly_passive_copilot_code_review_users),
  };
}

function emptyPullRequestActivity(): CopilotPullRequestActivity {
  return {
    totalCreated: 0,
    totalReviewed: 0,
    totalMerged: 0,
    medianMinutesToMerge: null,
    totalSuggestions: 0,
    totalAppliedSuggestions: 0,
    totalCreatedByCopilot: 0,
    totalReviewedByCopilot: 0,
    totalMergedCreatedByCopilot: 0,
    totalMergedReviewedByCopilot: 0,
    medianMinutesToMergeCopilotAuthored: null,
    medianMinutesToMergeCopilotReviewed: null,
    totalCopilotSuggestions: 0,
    totalCopilotAppliedSuggestions: 0,
    copilotSuggestionsByCommentType: [],
  };
}

function readPullRequestActivity(row: Record<string, unknown>): CopilotPullRequestActivity {
  const pullRequests = getRecord(row, "pull_requests");
  if (!pullRequests) return emptyPullRequestActivity();
  return {
    totalCreated: numberFrom(pullRequests.total_created),
    totalReviewed: numberFrom(pullRequests.total_reviewed),
    totalMerged: numberFrom(pullRequests.total_merged),
    medianMinutesToMerge: nullableNumberFrom(pullRequests.median_minutes_to_merge),
    totalSuggestions: numberFrom(pullRequests.total_suggestions),
    totalAppliedSuggestions: numberFrom(pullRequests.total_applied_suggestions),
    totalCreatedByCopilot: numberFrom(pullRequests.total_created_by_copilot),
    totalReviewedByCopilot: numberFrom(pullRequests.total_reviewed_by_copilot),
    totalMergedCreatedByCopilot: numberFrom(pullRequests.total_merged_created_by_copilot),
    totalMergedReviewedByCopilot: numberFrom(pullRequests.total_merged_reviewed_by_copilot),
    medianMinutesToMergeCopilotAuthored: nullableNumberFrom(pullRequests.median_minutes_to_merge_copilot_authored),
    medianMinutesToMergeCopilotReviewed: nullableNumberFrom(pullRequests.median_minutes_to_merge_copilot_reviewed),
    totalCopilotSuggestions: numberFrom(pullRequests.total_copilot_suggestions),
    totalCopilotAppliedSuggestions: numberFrom(pullRequests.total_copilot_applied_suggestions),
    copilotSuggestionsByCommentType: parseCommentTypeBreakdowns(pullRequests),
  };
}

function parseCommentTypeBreakdowns(row: Record<string, unknown>): CopilotReviewCommentTypeBreakdown[] {
  return getRecordArray(row, "copilot_suggestions_by_comment_type")
    .map((entry) => ({
      commentType: optionalString(entry.comment_type) ?? "unknown",
      totalCopilotSuggestions: numberFrom(entry.total_copilot_suggestions),
      totalCopilotAppliedSuggestions: numberFrom(entry.total_copilot_applied_suggestions),
    }))
    .sort((a, b) => b.totalCopilotSuggestions - a.totalCopilotSuggestions || a.commentType.localeCompare(b.commentType));
}

function aggregatePullRequests(items: CopilotPullRequestActivity[]): CopilotPullRequestActivity {
  const total = emptyPullRequestActivity();
  const medians = { all: [] as number[], authored: [] as number[], reviewed: [] as number[] };
  const byType = new Map<string, CopilotReviewCommentTypeBreakdown>();
  for (const item of items) {
    total.totalCreated += item.totalCreated;
    total.totalReviewed += item.totalReviewed;
    total.totalMerged += item.totalMerged;
    total.totalSuggestions += item.totalSuggestions;
    total.totalAppliedSuggestions += item.totalAppliedSuggestions;
    total.totalCreatedByCopilot += item.totalCreatedByCopilot;
    total.totalReviewedByCopilot += item.totalReviewedByCopilot;
    total.totalMergedCreatedByCopilot += item.totalMergedCreatedByCopilot;
    total.totalMergedReviewedByCopilot += item.totalMergedReviewedByCopilot;
    total.totalCopilotSuggestions += item.totalCopilotSuggestions;
    total.totalCopilotAppliedSuggestions += item.totalCopilotAppliedSuggestions;
    if (item.medianMinutesToMerge !== null) medians.all.push(item.medianMinutesToMerge);
    if (item.medianMinutesToMergeCopilotAuthored !== null) medians.authored.push(item.medianMinutesToMergeCopilotAuthored);
    if (item.medianMinutesToMergeCopilotReviewed !== null) medians.reviewed.push(item.medianMinutesToMergeCopilotReviewed);
    for (const commentType of item.copilotSuggestionsByCommentType) {
      const existing = byType.get(commentType.commentType) ?? {
        commentType: commentType.commentType,
        totalCopilotSuggestions: 0,
        totalCopilotAppliedSuggestions: 0,
      };
      existing.totalCopilotSuggestions += commentType.totalCopilotSuggestions;
      existing.totalCopilotAppliedSuggestions += commentType.totalCopilotAppliedSuggestions;
      byType.set(commentType.commentType, existing);
    }
  }
  total.medianMinutesToMerge = median(medians.all);
  total.medianMinutesToMergeCopilotAuthored = median(medians.authored);
  total.medianMinutesToMergeCopilotReviewed = median(medians.reviewed);
  total.copilotSuggestionsByCommentType = Array.from(byType.values())
    .sort((a, b) => b.totalCopilotSuggestions - a.totalCopilotSuggestions || a.commentType.localeCompare(b.commentType));
  return total;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(value * 100) / 100;
}

function parseDailyTotals(rows: unknown[]): CopilotUsageDailyTotal[] {
  const dailyRows: Record<string, unknown>[] = [];
  for (const rawRow of rows) {
    if (!isRecord(rawRow)) continue;
    const nested = getRecordArray(rawRow, "day_totals");
    if (nested.length > 0) dailyRows.push(...nested);
    else dailyRows.push(rawRow);
  }

  return dailyRows
    .map((row) => {
      const counters = withAcceptanceRate(readCounters(row));
      return {
        ...counters,
        day: optionalString(row.day) ?? "",
        dailyActiveUsers: numberFrom(row.daily_active_users),
        weeklyActiveUsers: numberFrom(row.weekly_active_users),
        monthlyActiveUsers: numberFrom(row.monthly_active_users),
        dailyActiveCliUsers: numberFrom(row.daily_active_cli_users),
        dailyActiveChatUsers: numberFrom(row.daily_active_chat_users),
        dailyActiveAgentUsers: numberFrom(row.daily_active_agent_users),
        weeklyActiveChatUsers: numberFrom(row.weekly_active_chat_users),
        weeklyActiveAgentUsers: numberFrom(row.weekly_active_agent_users),
        monthlyActiveChatUsers: numberFrom(row.monthly_active_chat_users),
        monthlyActiveAgentUsers: numberFrom(row.monthly_active_agent_users),
        codeReview: readCodeReviewUsage(row),
        cli: readCliMetrics(row),
        pullRequests: readPullRequestActivity(row),
        aiAdoptionPhases: parseAiAdoptionPhaseImpacts(row),
      };
    })
    .filter((row) => row.day.length > 0)
    .sort((a, b) => a.day.localeCompare(b.day));
}

function parseAiAdoptionPhase(row: Record<string, unknown>): CopilotAiAdoptionPhase | undefined {
  const rawPhase = getRecord(row, "ai_adoption_phase");
  if (!rawPhase) return undefined;
  const phaseNumber = optionalNumber(rawPhase.phase_number);
  const phase = optionalString(rawPhase.phase);
  const version = optionalString(rawPhase.version);
  return phaseNumber !== undefined && phase && version
    ? { phaseNumber, phase, version }
    : undefined;
}

function parseAiAdoptionPhaseImpacts(
  row: Record<string, unknown>,
): CopilotAiAdoptionPhaseImpact[] | undefined {
  const candidate = row.totals_by_ai_adoption_phase;
  if (candidate === undefined) return undefined;
  if (!Array.isArray(candidate) || candidate.length === 0 || !candidate.every(isRecord)) {
    return undefined;
  }
  const phases: CopilotAiAdoptionPhaseImpact[] = [];
  for (const rawPhase of candidate) {
    const phaseNumber = optionalNumber(rawPhase.phase_number);
    const phase = optionalString(rawPhase.phase);
    const requiredValues = [
      rawPhase.total_engaged_users,
      rawPhase.avg_user_initiated_interactions,
      rawPhase.avg_code_generation_activities,
      rawPhase.avg_code_acceptance_activities,
      rawPhase.avg_loc_added,
      rawPhase.avg_loc_deleted,
      rawPhase.avg_pull_requests_reviewed,
      rawPhase.avg_pull_requests_created,
      rawPhase.avg_pull_requests_merged,
      rawPhase.total_pull_requests_merged,
      rawPhase.avg_pull_requests_median_minutes_to_merge,
    ];
    if (
      phaseNumber === undefined ||
      !phase ||
      requiredValues.some((value) => optionalNumber(value) === undefined)
    ) return undefined;
    phases.push({
      phaseNumber,
      phase,
      totalEngagedUsers: optionalNumber(rawPhase.total_engaged_users)!,
      avgUserInitiatedInteractions: optionalNumber(rawPhase.avg_user_initiated_interactions)!,
      avgCodeGenerationActivities: optionalNumber(rawPhase.avg_code_generation_activities)!,
      avgCodeAcceptanceActivities: optionalNumber(rawPhase.avg_code_acceptance_activities)!,
      avgLocAdded: optionalNumber(rawPhase.avg_loc_added)!,
      avgLocDeleted: optionalNumber(rawPhase.avg_loc_deleted)!,
      avgPullRequestsReviewed: optionalNumber(rawPhase.avg_pull_requests_reviewed)!,
      avgPullRequestsCreated: optionalNumber(rawPhase.avg_pull_requests_created)!,
      avgPullRequestsMerged: optionalNumber(rawPhase.avg_pull_requests_merged)!,
      totalPullRequestsMerged: optionalNumber(rawPhase.total_pull_requests_merged)!,
      avgPullRequestsMedianMinutesToMerge: optionalNumber(
        rawPhase.avg_pull_requests_median_minutes_to_merge,
      )!,
      avgPullRequestsMinutesToReview: optionalNumber(
        rawPhase.avg_pull_requests_minutes_to_review,
      ),
      avgPullRequestsReviewCycles: optionalNumber(
        rawPhase.avg_pull_requests_review_cycles,
      ),
    });
  }
  phases.sort((a, b) => a.phaseNumber - b.phaseNumber);
  return phases.length > 0 ? phases : undefined;
}

function parseRepositoryUsageRows(
  rows: unknown[],
  reportDay: string,
): CopilotRepositoryUsageMetrics[] | undefined {
  const parsed: CopilotRepositoryUsageMetrics[] = [];
  for (const rawRow of rows) {
    if (!isRecord(rawRow)) return undefined;
    const day = optionalString(rawRow.day);
    const organizationId = identifierFrom(rawRow.organization_id);
    const repoId = identifierFrom(rawRow.repo_id);
    const owner = optionalString(rawRow.repo_owner_name);
    const name = optionalString(rawRow.repo_name);
    const visibility = optionalString(rawRow.repo_visibility);
    const pullRequests = getRecord(rawRow, "pull_requests");
    if (day !== reportDay || !organizationId || !repoId || !owner || !name || !visibility || !pullRequests) {
      return undefined;
    }
    const requiredPullRequestValues = [
      pullRequests.total_created,
      pullRequests.total_reviewed,
      pullRequests.total_merged,
      pullRequests.total_suggestions,
      pullRequests.total_applied_suggestions,
      pullRequests.total_created_by_copilot,
      pullRequests.total_reviewed_by_copilot,
      pullRequests.total_merged_created_by_copilot,
      pullRequests.total_merged_reviewed_by_copilot,
      pullRequests.total_copilot_suggestions,
      pullRequests.total_copilot_applied_suggestions,
    ];
    if (
      requiredPullRequestValues.some((value) => optionalNumber(value) === undefined) ||
      !Array.isArray(pullRequests.copilot_suggestions_by_comment_type)
    ) return undefined;
    parsed.push({
      day,
      enterpriseId: identifierFrom(rawRow.enterprise_id),
      organizationId,
      repoId,
      owner,
      name,
      fullName: `${owner}/${name}`,
      visibility,
      pullRequests: readPullRequestActivity(rawRow),
    });
  }
  return parsed.sort((a, b) => a.fullName.localeCompare(b.fullName, undefined, { sensitivity: "base" }));
}

function addBreakdown(
  map: Map<string, BreakdownAccumulator>,
  name: string,
  row: Record<string, unknown> | CopilotUsageCounters,
  userKeyValue: string,
  metadata: Partial<Pick<BreakdownAccumulator, "feature" | "ide" | "language" | "model" | "isCustomModel" | "customModelTrainingDate">> = {},
): void {
  const key = name.toLowerCase();
  const existing = map.get(key) ?? {
    ...emptyCounters(),
    name,
    userKeys: new Set<string>(),
    ...metadata,
  };
  Object.assign(existing, Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined)));
  addCounters(existing, row);
  existing.userKeys.add(userKeyValue);
  map.set(key, existing);
}

function toBreakdowns(map: Map<string, BreakdownAccumulator>): CopilotUsageBreakdown[] {
  return Array.from(map.values())
    .map((entry) => ({
      ...withAcceptanceRate(copyCounters(entry)),
      name: entry.name,
      users: entry.userKeys.size,
      feature: entry.feature,
      ide: entry.ide,
      language: entry.language,
      model: entry.model,
      isCustomModel: entry.isCustomModel,
      customModelTrainingDate: entry.customModelTrainingDate,
    }))
    .sort((a, b) =>
      b.userInitiatedInteractions - a.userInitiatedInteractions ||
      b.locAdded - a.locAdded ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
}

function addIdeVersion(
  map: Map<string, IdeVersionAccumulator>,
  ide: string,
  row: Record<string, unknown>,
  userKeyValue: string,
): void {
  const ideVersion = readIdeVersion(row);
  const pluginVersion = readPluginVersion(row);
  if (!ideVersion.version && !pluginVersion.version) return;
  const key = [ide, ideVersion.version ?? "", pluginVersion.plugin ?? "", pluginVersion.version ?? ""].join("\0");
  const existing = map.get(key) ?? {
    ide,
    ideVersion: ideVersion.version,
    plugin: pluginVersion.plugin,
    pluginVersion: pluginVersion.version,
    sampledAt: latestString(ideVersion.sampledAt, pluginVersion.sampledAt),
    userKeys: new Set<string>(),
  };
  existing.sampledAt = latestString(existing.sampledAt, ideVersion.sampledAt, pluginVersion.sampledAt);
  existing.userKeys.add(userKeyValue);
  map.set(key, existing);
}

function toIdeVersions(map: Map<string, IdeVersionAccumulator>): CopilotUsageIdeVersionMetrics[] {
  return Array.from(map.values())
    .map((entry) => ({
      ide: entry.ide,
      ideVersion: entry.ideVersion,
      plugin: entry.plugin,
      pluginVersion: entry.pluginVersion,
      sampledAt: entry.sampledAt,
      users: entry.userKeys.size,
    }))
    .sort((a, b) => b.users - a.users || a.ide.localeCompare(b.ide));
}

function updateUserVersion(user: UserAccumulator, row: Record<string, unknown>): void {
  const ideVersion = readIdeVersion(row);
  const pluginVersion = readPluginVersion(row);
  const sampledAt = latestString(ideVersion.sampledAt, pluginVersion.sampledAt);
  if (!sampledAt && (user.lastKnownIdeVersion || user.lastKnownPluginVersion)) return;
  if ((sampledAt ?? "") < (user.lastKnownVersionSampledAt ?? "")) return;
  if (ideVersion.version) user.lastKnownIdeVersion = ideVersion.version;
  if (pluginVersion.version) user.lastKnownPluginVersion = pluginVersion.version;
  if (pluginVersion.plugin) user.lastKnownPlugin = pluginVersion.plugin;
  if (sampledAt) user.lastKnownVersionSampledAt = sampledAt;
}

function readIdeVersion(row: Record<string, unknown>): { version?: string; sampledAt?: string } {
  const raw = getRecord(row, "last_known_ide_version");
  return raw
    ? { version: optionalString(raw.ide_version), sampledAt: optionalString(raw.sampled_at) }
    : {};
}

function readPluginVersion(row: Record<string, unknown>): { plugin?: string; version?: string; sampledAt?: string } {
  const raw = getRecord(row, "last_known_plugin_version");
  return raw
    ? {
        plugin: optionalString(raw.plugin),
        version: optionalString(raw.plugin_version),
        sampledAt: optionalString(raw.sampled_at),
      }
    : {};
}

function latestString(...values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => value !== undefined).sort().at(-1);
}

function emptyCounters(): CopilotUsageCounters {
  return {
    userInitiatedInteractions: 0,
    codeGenerations: 0,
    codeAcceptances: 0,
    locSuggestedToAdd: 0,
    locSuggestedToDelete: 0,
    locAdded: 0,
    locDeleted: 0,
    acceptanceRate: 0,
  };
}

function copyCounters(counters: CopilotUsageCounters): CopilotUsageCounters {
  return {
    userInitiatedInteractions: counters.userInitiatedInteractions,
    codeGenerations: counters.codeGenerations,
    codeAcceptances: counters.codeAcceptances,
    locSuggestedToAdd: counters.locSuggestedToAdd,
    locSuggestedToDelete: counters.locSuggestedToDelete,
    locAdded: counters.locAdded,
    locDeleted: counters.locDeleted,
    acceptanceRate: counters.acceptanceRate,
  };
}

function readCounters(row: Record<string, unknown>): CopilotUsageCounters {
  return {
    userInitiatedInteractions: numberFrom(row.user_initiated_interaction_count),
    codeGenerations: numberFrom(row.code_generation_activity_count),
    codeAcceptances: numberFrom(row.code_acceptance_activity_count),
    locSuggestedToAdd: numberFrom(row.loc_suggested_to_add_sum),
    locSuggestedToDelete: numberFrom(row.loc_suggested_to_delete_sum),
    locAdded: numberFrom(row.loc_added_sum),
    locDeleted: numberFrom(row.loc_deleted_sum),
    acceptanceRate: 0,
  };
}

function addCounters(target: CopilotUsageCounters, source: Record<string, unknown> | CopilotUsageCounters): void {
  const counters = isCounterShape(source) ? source : readCounters(source);
  target.userInitiatedInteractions += counters.userInitiatedInteractions;
  target.codeGenerations += counters.codeGenerations;
  target.codeAcceptances += counters.codeAcceptances;
  target.locSuggestedToAdd += counters.locSuggestedToAdd;
  target.locSuggestedToDelete += counters.locSuggestedToDelete;
  target.locAdded += counters.locAdded;
  target.locDeleted += counters.locDeleted;
  target.acceptanceRate = acceptanceRate(target);
}

function withAcceptanceRate<T extends CopilotUsageCounters>(counters: T): T {
  return { ...counters, acceptanceRate: acceptanceRate(counters) };
}

function acceptanceRate(counters: CopilotUsageCounters): number {
  if (counters.codeGenerations <= 0) return 0;
  return Math.round((counters.codeAcceptances / counters.codeGenerations) * 10_000) / 100;
}

function isCounterShape(value: Record<string, unknown> | CopilotUsageCounters): value is CopilotUsageCounters {
  return "userInitiatedInteractions" in value;
}

function hasUsage(user: CopilotUsageUserMetrics): boolean {
  return (
    user.activeDays > 0 ||
    user.userInitiatedInteractions > 0 ||
    user.codeGenerations > 0 ||
    user.codeAcceptances > 0 ||
    user.locAdded > 0 ||
    user.locDeleted > 0 ||
    user.usedChat ||
    user.usedAgent ||
    user.usedCli ||
    user.usedCodeReviewActive ||
    user.usedCodeReviewPassive
  );
}

function hasCounterActivity(counters: CopilotUsageCounters): boolean {
  return (
    counters.userInitiatedInteractions > 0 ||
    counters.codeGenerations > 0 ||
    counters.codeAcceptances > 0 ||
    counters.locAdded > 0 ||
    counters.locDeleted > 0 ||
    counters.locSuggestedToAdd > 0 ||
    counters.locSuggestedToDelete > 0
  );
}

function userKeys(login: string, userId?: string): string[] {
  const keys = [`login:${login.toLowerCase()}`];
  if (userId) keys.unshift(`id:${userId}`);
  return keys;
}

function getStatus(err: unknown): number | undefined {
  return isRecord(err) ? optionalNumber(err.status) : undefined;
}

function getRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const candidate = value[key];
  return isRecord(candidate) ? candidate : undefined;
}

function getRecordArray(value: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const candidate = value[key];
  return Array.isArray(candidate) ? candidate.filter(isRecord) : [];
}

function requiredStringArray(value: Record<string, unknown>, key: string): string[] | undefined {
  const candidate = value[key];
  if (
    !Array.isArray(candidate) ||
    candidate.length === 0 ||
    !candidate.every((item): item is string => typeof item === "string" && item.length > 0)
  ) {
    return undefined;
  }
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function nullableNumberFrom(value: unknown): number | null {
  return optionalNumber(value) ?? null;
}

function identifierFrom(value: unknown): string | undefined {
  return optionalString(value) ?? optionalNumber(value)?.toString();
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return undefined;
}

function numberFrom(value: unknown): number {
  return optionalNumber(value) ?? 0;
}

function toBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}