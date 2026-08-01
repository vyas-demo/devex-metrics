import { afterEach, describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { resetOctokit, setOctokit } from "../github-client.js";
import { collectCopilotUsageMetrics, parseCopilotUsageReport } from "./copilot-usage.js";

describe("copilot usage collector", () => {
  afterEach(() => {
    resetOctokit();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("parses JSON arrays, JSON objects, and NDJSON report payloads", () => {
    expect(parseCopilotUsageReport('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseCopilotUsageReport('{"a":1}')).toEqual([{ a: 1 }]);
    expect(parseCopilotUsageReport('{"a":1}\n{"a":2}')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("downloads and normalizes per-user Copilot usage reports", async () => {
    const request = vi.fn(async (route: string, options?: Record<string, unknown>) => {
      if (route === "GET /orgs/{org}/copilot/metrics/reports/users-28-day/latest") {
        return {
          status: 200,
          data: {
            report_start_day: "2026-04-01",
            report_end_day: "2026-04-28",
            download_links: ["https://reports.example/users"],
          },
        };
      }
      if (route === "GET /orgs/{org}/copilot/metrics/reports/organization-28-day/latest") {
        return {
          status: 200,
          data: {
            report_start_day: "2026-04-01",
            report_end_day: "2026-04-28",
            download_links: ["https://reports.example/org"],
          },
        };
      }
      if (route === "GET /orgs/{org}/copilot/metrics/reports/repos-1-day") {
        expect(options?.day).toBe("2026-04-28");
        return {
          status: 200,
          data: {
            report_day: "2026-04-28",
            download_links: [
              "https://reports.example/repos-part-1",
              "https://reports.example/repos-part-2",
            ],
          },
        };
      }
      if (route === "GET /orgs/{org}/copilot/billing/seats") {
        return {
          status: 200,
          data: {
            seats: [
              {
                assignee: { login: "alice" },
                last_activity_at: "2026-04-28T10:00:00Z",
                last_activity_editor: "vscode",
                last_authenticated_at: "2026-04-27T10:00:00Z",
                plan_type: "business",
              },
              {
                assignee: { login: "carol" },
                last_activity_at: "2026-04-20T10:00:00Z",
                last_activity_editor: "jetbrains",
                plan_type: "business",
              },
            ],
          },
        };
      }
      if (route === "GET /orgs/{org}/copilot/billing") {
        return {
          status: 200,
          data: {
            seat_breakdown: {
              total: 3,
              added_this_cycle: 1,
              pending_invitation: 0,
              pending_cancellation: 1,
              active_this_cycle: 2,
              inactive_this_cycle: 1,
            },
            seat_management_setting: "assign_selected",
            ide_chat: "enabled",
            platform_chat: "enabled",
            cli: "enabled",
            public_code_suggestions: "block",
            plan_type: "business",
          },
        };
      }
      throw new Error(`Unexpected route ${route}`);
    });

    setOctokit({ request } as unknown as Octokit);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () => reportPayload(url),
    })));

    const result = await collectCopilotUsageMetrics("my-org", "org");

    expect(result).not.toBeNull();
    expect(result?.scope).toBe("organization");
    expect(result?.reportStartDay).toBe("2026-04-01");
    expect(result?.reportEndDay).toBe("2026-04-28");
    expect(result?.totals.totalUsers).toBe(3);
    expect(result?.totals.activeUsers).toBe(2);
    expect(result?.totals.assignedSeats).toBe(3);
    expect(result?.totals.seatsActiveThisCycle).toBe(2);
    expect(result?.totals.userInitiatedInteractions).toBe(15);
    expect(result?.totals.acceptanceRate).toBe(50);
    expect(result?.billing).toMatchObject({ assignedSeats: 3, inactiveThisCycle: 1, publicCodeSuggestions: "block" });
    expect(result?.cli).toMatchObject({ sessionCount: 2, requestCount: 3, promptCount: 2, promptTokens: 300, outputTokens: 900 });
    expect(result?.pullRequests).toMatchObject({ totalCreated: 2, totalReviewedByCopilot: 1, totalCopilotAppliedSuggestions: 1 });
    expect(result?.codeReview).toMatchObject({ monthlyActiveUsers: 1, monthlyPassiveUsers: 1 });
    expect(result?.byFeature[0]).toMatchObject({ name: "chat", users: 1, userInitiatedInteractions: 10 });
    expect(result?.byIde[0]).toMatchObject({ name: "vscode", users: 1 });
    expect(result?.byLanguage[0]).toMatchObject({ name: "typescript", users: 1 });
    expect(result?.byModel[0]).toMatchObject({ name: "gpt-5.4", users: 1, isCustomModel: false });
    expect(result?.byLanguageFeature[0]).toMatchObject({ language: "typescript", feature: "chat_panel_agent_mode" });
    expect(result?.byModelFeature[0]).toMatchObject({ model: "gpt-5.4", feature: "chat_panel_agent_mode" });
    expect(result?.ideVersions[0]).toMatchObject({ ide: "vscode", ideVersion: "1.104.0", pluginVersion: "0.31.0", users: 1 });
    expect(result?.byTeam).toEqual([]);
    expect(result?.dailyTotals[0]).toMatchObject({ day: "2026-04-28", dailyActiveUsers: 2 });
    expect(result?.dailyTotals[0].pullRequests).toMatchObject({ totalCreatedByCopilot: 1 });
    expect(result?.dailyTotals[0].cli.requestCount).toBe(3);
    expect(result?.dailyTotals[0].aiAdoptionPhases).toEqual([
      expect.objectContaining({ phaseNumber: 0, phase: "No Cohort", totalEngagedUsers: 1, avgPullRequestsMerged: 1 }),
      expect.objectContaining({ phaseNumber: 3, phase: "Phase 3", totalEngagedUsers: 1, avgPullRequestsMerged: 3 }),
    ]);
    expect(result?.repositoryReport).toMatchObject({
      reportDay: "2026-04-28",
      repositories: [
        {
          repoId: "101",
          fullName: "my-org/api",
          visibility: "PRIVATE",
          pullRequests: { totalCreatedByCopilot: 2, totalReviewedByCopilot: 1 },
        },
        {
          repoId: "102",
          fullName: "my-org/web",
          visibility: "INTERNAL",
          pullRequests: { totalCreatedByCopilot: 0, totalReviewedByCopilot: 2 },
        },
      ],
    });
    expect(result?.repositoryReportStatus).toBe("available");

    const alice = result?.users.find((user) => user.login === "alice");
    expect(alice).toMatchObject({
      activeDays: 1,
      aiAdoptionPhase: { phaseNumber: 3, phase: "Phase 3", version: "2026-07" },
      teams: [],
      usedChat: true,
      usedAgent: true,
      lastActivityEditor: "vscode",
      lastKnownIdeVersion: "1.104.0",
      lastKnownPluginVersion: "0.31.0",
    });
    expect(alice).not.toHaveProperty("days");
    expect(alice).not.toHaveProperty("seat");
    expect(result?.byFeature[0]).not.toHaveProperty("userKeys");
    const carol = result?.users.find((user) => user.login === "carol");
    expect(carol).toMatchObject({ activeDays: 0, lastActivityEditor: "jetbrains" });
    const bob = result?.users.find((user) => user.login === "bob");
    expect(bob?.cli).toMatchObject({ requestCount: 3, lastKnownCliVersion: "1.0.8" });
  });

  it("returns null when the users report endpoint is unavailable", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    setOctokit({
      request: vi.fn(async () => {
        throw { status: 403 };
      }),
    } as unknown as Octokit);

    await expect(collectCopilotUsageMetrics("my-org", "org")).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("copilot-usage"));
  });

  it("surfaces validation errors from report endpoints", async () => {
    setOctokit({
      request: vi.fn(async () => {
        throw { status: 422 };
      }),
    } as unknown as Octokit);

    await expect(collectCopilotUsageMetrics("my-org", "org")).rejects.toEqual({ status: 422 });
  });

  it("does not expose partial repository reports or mismatched row days", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = vi.fn(async (route: string) => {
      if (route === "GET /orgs/{org}/copilot/metrics/reports/users-28-day/latest") {
        return {
          status: 200,
          data: {
            report_start_day: "2026-04-01",
            report_end_day: "2026-04-28",
            download_links: ["https://reports.example/users"],
          },
        };
      }
      if (route === "GET /orgs/{org}/copilot/metrics/reports/organization-28-day/latest") {
        return { status: 204, data: {} };
      }
      if (route === "GET /orgs/{org}/copilot/metrics/reports/repos-1-day") {
        return {
          status: 200,
          data: {
            report_day: "2026-04-28",
            download_links: ["https://reports.example/repos-part-1", "https://reports.example/failing-part"],
          },
        };
      }
      if (route === "GET /orgs/{org}/copilot/billing/seats") return { status: 200, data: { seats: [] } };
      if (route === "GET /orgs/{org}/copilot/billing") return { status: 404, data: {} };
      throw new Error(`Unexpected route ${route}`);
    });
    setOctokit({ request } as unknown as Octokit);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/failing-part")
      ? { ok: false, status: 500, text: async () => "" }
      : { ok: true, status: 200, text: async () => reportPayload(url) }));

    const result = await collectCopilotUsageMetrics("my-org", "org");

    expect(result?.repositoryReport).toBeUndefined();
    expect(result?.repositoryReportStatus).toBe("unavailable");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("incomplete organization repository usage metrics"));
  });

  it("does not publish repository rows whose day mismatches the report envelope", async () => {
    const request = vi.fn(async (route: string) => {
      if (route === "GET /orgs/{org}/copilot/metrics/reports/users-28-day/latest") {
        return {
          status: 200,
          data: {
            report_start_day: "2026-04-01",
            report_end_day: "2026-04-28",
            download_links: ["https://reports.example/users"],
          },
        };
      }
      if (route === "GET /orgs/{org}/copilot/metrics/reports/organization-28-day/latest") return { status: 204, data: {} };
      if (route === "GET /orgs/{org}/copilot/metrics/reports/repos-1-day") {
        return {
          status: 200,
          data: { report_day: "2026-04-28", download_links: ["https://reports.example/repos-wrong-day"] },
        };
      }
      if (route === "GET /orgs/{org}/copilot/billing/seats") return { status: 200, data: { seats: [] } };
      if (route === "GET /orgs/{org}/copilot/billing") return { status: 404, data: {} };
      throw new Error(`Unexpected route ${route}`);
    });
    setOctokit({ request } as unknown as Octokit);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () => url.endsWith("/repos-wrong-day")
        ? JSON.stringify({ ...JSON.parse(reportPayload("https://reports.example/repos-part-1")), day: "2026-04-27" })
        : reportPayload(url),
    })));

    const result = await collectCopilotUsageMetrics("my-org", "org");

    expect(result?.repositoryReport).toBeUndefined();
    expect(result?.repositoryReportStatus).toBe("unavailable");
  });

  it("does not publish a partial adoption distribution when a phase row is malformed", async () => {
    const request = vi.fn(async (route: string) => {
      if (route === "GET /orgs/{org}/copilot/metrics/reports/users-28-day/latest") {
        return {
          status: 200,
          data: {
            report_start_day: "2026-04-01",
            report_end_day: "2026-04-28",
            download_links: ["https://reports.example/users"],
          },
        };
      }
      if (route === "GET /orgs/{org}/copilot/metrics/reports/organization-28-day/latest") {
        return {
          status: 200,
          data: {
            report_start_day: "2026-04-01",
            report_end_day: "2026-04-28",
            download_links: ["https://reports.example/malformed-org"],
          },
        };
      }
      if (route === "GET /orgs/{org}/copilot/metrics/reports/repos-1-day") return { status: 204, data: {} };
      if (route === "GET /orgs/{org}/copilot/billing/seats") return { status: 200, data: { seats: [] } };
      if (route === "GET /orgs/{org}/copilot/billing") return { status: 404, data: {} };
      throw new Error(`Unexpected route ${route}`);
    });
    setOctokit({ request } as unknown as Octokit);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (!url.endsWith("/malformed-org")) {
        return { ok: true, status: 200, text: async () => reportPayload(url) };
      }
      const rows = JSON.parse(reportPayload("https://reports.example/org"));
      delete rows[0].day_totals[0].totals_by_ai_adoption_phase[1].total_pull_requests_merged;
      return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
    }));

    const result = await collectCopilotUsageMetrics("my-org", "org");

    expect(result?.dailyTotals[0].aiAdoptionPhases).toBeUndefined();
  });

  it("can collect enterprise-scoped usage reports when configured", async () => {
    vi.stubEnv("COPILOT_USAGE_ENTERPRISE", "my-enterprise");
    const request = vi.fn(async (route: string) => {
      if (route === "GET /enterprises/{enterprise}/copilot/metrics/reports/users-28-day/latest") {
        return {
          status: 200,
          data: {
            report_start_day: "2026-04-01",
            report_end_day: "2026-04-28",
            download_links: ["https://reports.example/enterprise-users"],
          },
        };
      }
      if (route === "GET /enterprises/{enterprise}/copilot/metrics/reports/enterprise-28-day/latest") {
        return { status: 204, data: {} };
      }
      if (route === "GET /enterprises/{enterprise}/copilot/metrics/reports/repos-1-day") {
        return { status: 204, data: {} };
      }
      throw new Error(`Unexpected enterprise route ${route}`);
    });
    setOctokit({ request } as unknown as Octokit);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        {
          user_id: 1,
          user_login: "enterprise-user",
          user_initiated_interaction_count: 4,
          code_generation_activity_count: 2,
          code_acceptance_activity_count: 1,
        },
      ]),
    })));

    const result = await collectCopilotUsageMetrics("owner-org", "org");

    expect(result?.scope).toBe("enterprise");
    expect(result?.scopeName).toBe("my-enterprise");
    expect(result?.users[0].login).toBe("enterprise-user");
    expect(request).not.toHaveBeenCalledWith(
      "GET /orgs/{org}/copilot/billing/seats",
      expect.anything(),
    );
  });
});

function reportPayload(url: string): string {
  if (url.endsWith("/users")) {
    return JSON.stringify([
      {
        user_id: 1,
        user_login: "alice",
        day: "2026-04-28",
        user_initiated_interaction_count: 10,
        code_generation_activity_count: 8,
        code_acceptance_activity_count: 4,
        loc_suggested_to_add_sum: 30,
        loc_suggested_to_delete_sum: 4,
        loc_added_sum: 20,
        loc_deleted_sum: 2,
        used_chat: true,
        used_agent: true,
        used_copilot_code_review_active: true,
        ai_adoption_phase: {
          phase_number: 3,
          phase: "Phase 3",
          version: "2026-07",
        },
        totals_by_ide: [
          {
            ide: "vscode",
            user_initiated_interaction_count: 10,
            code_generation_activity_count: 8,
            code_acceptance_activity_count: 4,
            loc_added_sum: 20,
            last_known_ide_version: { ide_version: "1.104.0", sampled_at: "2026-04-28T09:00:00Z" },
            last_known_plugin_version: { plugin: "copilot", plugin_version: "0.31.0", sampled_at: "2026-04-28T09:00:00Z" },
          },
        ],
        totals_by_feature: [
          {
            feature: "chat",
            user_initiated_interaction_count: 10,
            code_generation_activity_count: 8,
            code_acceptance_activity_count: 4,
            loc_added_sum: 20,
          },
        ],
        totals_by_language_feature: [
          {
            language: "typescript",
            feature: "chat_panel_agent_mode",
            user_initiated_interaction_count: 10,
            code_generation_activity_count: 8,
            code_acceptance_activity_count: 4,
            loc_added_sum: 20,
          },
        ],
        totals_by_language_model: [
          {
            language: "typescript",
            model: "gpt-5.4",
            is_custom_model: false,
            user_initiated_interaction_count: 10,
            code_generation_activity_count: 8,
            code_acceptance_activity_count: 4,
            loc_added_sum: 20,
          },
        ],
        totals_by_model_feature: [
          {
            model: "gpt-5.4",
            feature: "chat_panel_agent_mode",
            is_custom_model: false,
            user_initiated_interaction_count: 10,
            code_generation_activity_count: 8,
            code_acceptance_activity_count: 4,
            loc_added_sum: 20,
          },
        ],
      },
      {
        user_id: 2,
        user_login: "bob",
        day: "2026-04-28",
        user_initiated_interaction_count: 5,
        code_generation_activity_count: 2,
        code_acceptance_activity_count: 1,
        loc_added_sum: 7,
        loc_deleted_sum: 1,
        used_cli: true,
        used_copilot_code_review_passive: true,
        ai_adoption_phase: {
          phase_number: 0,
          phase: "No Cohort",
          version: "2026-07",
        },
        totals_by_cli: {
          session_count: 2,
          request_count: 3,
          prompt_count: 2,
          token_usage: {
            prompt_tokens_sum: 300,
            output_tokens_sum: 900,
            avg_tokens_per_request: 400,
          },
          last_known_cli_version: {
            cli_version: "1.0.8",
            sampled_at: "2026-04-28T10:00:00Z",
          },
        },
      },
    ]);
  }
  if (url.endsWith("/org")) {
    return JSON.stringify([
      {
        day_totals: [
          {
            day: "2026-04-28",
            daily_active_users: 2,
            weekly_active_users: 2,
            monthly_active_users: 2,
            daily_active_chat_users: 1,
            daily_active_agent_users: 1,
            user_initiated_interaction_count: 15,
            daily_active_cli_users: 1,
            daily_active_copilot_code_review_users: 1,
            daily_passive_copilot_code_review_users: 1,
            weekly_active_copilot_code_review_users: 1,
            weekly_passive_copilot_code_review_users: 1,
            monthly_active_copilot_code_review_users: 1,
            monthly_passive_copilot_code_review_users: 1,
            totals_by_cli: {
              session_count: 2,
              request_count: 3,
              prompt_count: 2,
              token_usage: { prompt_tokens_sum: 300, output_tokens_sum: 900 },
            },
            pull_requests: {
              total_created: 2,
              total_reviewed: 1,
              total_merged: 1,
              median_minutes_to_merge: 90,
              total_suggestions: 2,
              total_applied_suggestions: 1,
              total_created_by_copilot: 1,
              total_reviewed_by_copilot: 1,
              total_merged_created_by_copilot: 1,
              total_merged_reviewed_by_copilot: 1,
              median_minutes_to_merge_copilot_authored: 60,
              median_minutes_to_merge_copilot_reviewed: 90,
              total_copilot_suggestions: 2,
              total_copilot_applied_suggestions: 1,
              copilot_suggestions_by_comment_type: [
                { comment_type: "bug_risk", total_copilot_suggestions: 2, total_copilot_applied_suggestions: 1 },
              ],
            },
            totals_by_ai_adoption_phase: [
              {
                phase: "No Cohort",
                phase_number: 0,
                total_engaged_users: 1,
                avg_user_initiated_interactions: 5,
                avg_code_generation_activities: 2,
                avg_code_acceptance_activities: 1,
                avg_loc_added: 7,
                avg_loc_deleted: 1,
                avg_pull_requests_reviewed: 1,
                avg_pull_requests_created: 1,
                avg_pull_requests_merged: 1,
                total_pull_requests_merged: 1,
                avg_pull_requests_median_minutes_to_merge: 120,
              },
              {
                phase: "Phase 3",
                phase_number: 3,
                total_engaged_users: 1,
                avg_user_initiated_interactions: 10,
                avg_code_generation_activities: 8,
                avg_code_acceptance_activities: 4,
                avg_loc_added: 20,
                avg_loc_deleted: 2,
                avg_pull_requests_reviewed: 4,
                avg_pull_requests_created: 3,
                avg_pull_requests_merged: 3,
                total_pull_requests_merged: 3,
                avg_pull_requests_median_minutes_to_merge: 60,
                avg_pull_requests_minutes_to_review: 15,
                avg_pull_requests_review_cycles: 1.5,
              },
            ],
          },
        ],
      },
    ]);
  }
  if (url.endsWith("/repos-part-1")) {
    return JSON.stringify({
      day: "2026-04-28",
      enterprise_id: "",
      organization_id: "50",
      repo_id: 101,
      repo_owner_name: "my-org",
      repo_name: "api",
      repo_visibility: "PRIVATE",
      pull_requests: {
        total_created: 3,
        total_reviewed: 2,
        total_merged: 2,
        median_minutes_to_merge: 80,
        total_suggestions: 3,
        total_applied_suggestions: 2,
        total_created_by_copilot: 2,
        total_reviewed_by_copilot: 1,
        total_merged_created_by_copilot: 1,
        total_merged_reviewed_by_copilot: 1,
        total_copilot_suggestions: 3,
        total_copilot_applied_suggestions: 2,
        copilot_suggestions_by_comment_type: [],
      },
    });
  }
  if (url.endsWith("/repos-part-2")) {
    return JSON.stringify({
      day: "2026-04-28",
      enterprise_id: "",
      organization_id: "50",
      repo_id: 102,
      repo_owner_name: "my-org",
      repo_name: "web",
      repo_visibility: "INTERNAL",
      pull_requests: {
        total_created: 1,
        total_reviewed: 2,
        total_merged: 1,
        median_minutes_to_merge: null,
        total_suggestions: 4,
        total_applied_suggestions: 1,
        total_created_by_copilot: 0,
        total_reviewed_by_copilot: 2,
        total_merged_created_by_copilot: 0,
        total_merged_reviewed_by_copilot: 1,
        total_copilot_suggestions: 4,
        total_copilot_applied_suggestions: 1,
        copilot_suggestions_by_comment_type: [],
      },
    });
  }
  throw new Error(`Unexpected report url ${url}`);
}