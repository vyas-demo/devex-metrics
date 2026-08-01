/**
 * Team-target configuration.
 *
 * Loads optional team-set thresholds from `devex.config.json` (see
 * `devex.config.example.json` at the repo root) and evaluates them against
 * the already-computed DORA, code-review, and repo-health metrics. Pure
 * derivations — no API calls; the only side effect is reading the config
 * file and warning about invalid entries.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  DoraMetrics,
  HealthReport,
  ReviewStats,
  RollupConfig,
  RollupTarget,
  TargetEvaluation,
  TargetsConfig,
} from "./types.js";

/** The metric inputs a target evaluation is checked against. */
export interface TargetInputs {
  /** Computed DORA metrics (`computeDoraMetrics`). */
  dora: DoraMetrics;
  /** Computed code-review analytics (`computeReviewStats`). */
  review: ReviewStats;
  /** Computed repo-health report (`computeHealthReport`). */
  health: HealthReport;
}

type TargetKey = keyof TargetsConfig["targets"];

/** Whether a target is an upper bound (max) or a lower bound (min). */
type TargetKind = "max" | "min";

/** Hours with one decimal, e.g. "24.0h". */
function formatHours(value: number): string {
  return `${value.toFixed(1)}h`;
}

/** Ratio as a percentage with at most one decimal, e.g. "80%" or "12.5%". */
function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

/** Plain number with at most one decimal, e.g. "70" or "1.5". */
function formatPlain(value: number): string {
  return `${Math.round(value * 10) / 10}`;
}

/** Deploys per week, e.g. "1.5/week". */
function formatPerWeek(value: number): string {
  return `${formatPlain(value)}/week`;
}

/**
 * One target definition: how to validate its configured value and how to
 * evaluate it against the computed metrics. Listed in the canonical key
 * order, which also fixes the order of `evaluateTargets` results.
 */
interface TargetSpec {
  key: TargetKey;
  id: string;
  label: string;
  kind: TargetKind;
  /** Inclusive validation range for the configured value. */
  min: number;
  max: number;
  /** Human description of the valid range, used in warnings. */
  range: string;
  format: (value: number) => string;
  /** Pull the observed value and its data-availability flag from the inputs. */
  extract: (inputs: TargetInputs) => { actual: number; hasData: boolean };
}

const TARGET_SPECS: readonly TargetSpec[] = [
  {
    key: "maxMedianCycleHours",
    id: "max-median-cycle-hours",
    label: "Median cycle time",
    kind: "max",
    min: Number.MIN_VALUE,
    max: Number.MAX_VALUE,
    range: "a number > 0",
    format: formatHours,
    extract: ({ dora }) => ({
      actual: dora.leadTimeHours.value,
      hasData: dora.leadTimeHours.hasData,
    }),
  },
  {
    key: "minReviewCoverage",
    id: "min-review-coverage",
    label: "Review coverage",
    kind: "min",
    min: 0,
    max: 1,
    range: "a ratio in [0,1]",
    format: formatPercent,
    extract: ({ review }) => ({
      actual: review.reviewCoverage,
      hasData: review.hasData && review.totalPRs > 0,
    }),
  },
  {
    key: "maxChangeFailureRate",
    id: "max-change-failure-rate",
    label: "Change failure rate",
    kind: "max",
    min: 0,
    max: 1,
    range: "a ratio in [0,1]",
    format: formatPercent,
    extract: ({ dora }) => ({
      actual: dora.changeFailureRate.value,
      hasData: dora.changeFailureRate.hasData,
    }),
  },
  {
    key: "minDeploysPerWeek",
    id: "min-deploys-per-week",
    label: "Deploy frequency",
    kind: "min",
    min: Number.MIN_VALUE,
    max: Number.MAX_VALUE,
    range: "a number > 0",
    format: formatPerWeek,
    extract: ({ dora }) => ({
      actual: dora.deployFrequencyPerWeek.value,
      hasData: dora.deployFrequencyPerWeek.hasData,
    }),
  },
  {
    key: "maxP90FirstReviewHours",
    id: "max-p90-first-review-hours",
    label: "p90 time to first review",
    kind: "max",
    min: Number.MIN_VALUE,
    max: Number.MAX_VALUE,
    range: "a number > 0",
    format: formatHours,
    extract: ({ review }) => ({
      actual: review.p90TimeToFirstReviewHours,
      hasData: review.hasData && review.p90TimeToFirstReviewHours > 0,
    }),
  },
  {
    key: "minAvgHealthScore",
    id: "min-avg-health-score",
    label: "Average health score",
    kind: "min",
    min: Number.MIN_VALUE,
    max: Number.MAX_VALUE,
    range: "a number > 0",
    format: formatPlain,
    extract: ({ health }) => ({
      actual: health.avgScore,
      hasData: health.hasData,
    }),
  },
];

/** Name of the config file looked up in the working directory. */
export const TARGETS_CONFIG_FILENAME = "devex.config.json";

/**
 * Validate the optional top-level `incidentLabels` field: an array of
 * non-empty label-name strings (whitespace-trimmed). Returns undefined when
 * the field is absent, not an array (with a warning), or has no valid
 * entries; invalid entries are warned about and dropped.
 */
function parseIncidentLabels(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    console.warn(
      `${TARGETS_CONFIG_FILENAME}: "incidentLabels" must be an array of label names; ignoring it.`
    );
    return undefined;
  }

  const labels: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") {
      console.warn(
        `${TARGETS_CONFIG_FILENAME}: invalid entry in incidentLabels ` +
          `(${JSON.stringify(entry)}); expected a non-empty string. Dropping it.`
      );
      continue;
    }
    labels.push(entry.trim());
  }

  return labels.length > 0 ? labels : undefined;
}

/**
 * Validate one entry of `rollup.targets`: an object with a non-empty-string
 * `owner`, an `ownerType` of exactly "org" or "user", and an optional
 * non-empty-string `repo`. Returns undefined (with a warning) for invalid
 * entries; string fields are whitespace-trimmed.
 */
function parseRollupTarget(entry: unknown): RollupTarget | undefined {
  const invalid = (): undefined => {
    console.warn(
      `${TARGETS_CONFIG_FILENAME}: invalid entry in rollup.targets ` +
        `(${JSON.stringify(entry)}); expected { owner, ownerType: "org"|"user", repo? }. ` +
        `Dropping it.`
    );
    return undefined;
  };

  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return invalid();
  }
  const raw = entry as Record<string, unknown>;

  const owner = typeof raw.owner === "string" ? raw.owner.trim() : "";
  if (owner === "") return invalid();

  const ownerType = raw.ownerType;
  if (ownerType !== "org" && ownerType !== "user") return invalid();

  if (raw.repo === undefined) return { owner, ownerType };
  const repo = typeof raw.repo === "string" ? raw.repo.trim() : "";
  if (repo === "") return invalid();
  return { owner, ownerType, repo };
}

/**
 * Validate the optional top-level `rollup` field: an object with a
 * non-empty-string `name` (whitespace-trimmed) and a `targets` array with at
 * least one valid entry (see `parseRollupTarget`). Returns undefined when
 * the field is absent; an invalid overall shape, name, or empty/exhausted
 * target list drops the whole rollup with a warning.
 */
function parseRollup(value: unknown): RollupConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    console.warn(
      `${TARGETS_CONFIG_FILENAME}: "rollup" must be an object with name and targets; ignoring it.`
    );
    return undefined;
  }
  const raw = value as Record<string, unknown>;

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name === "") {
    console.warn(
      `${TARGETS_CONFIG_FILENAME}: rollup.name must be a non-empty string; ignoring the rollup.`
    );
    return undefined;
  }

  if (!Array.isArray(raw.targets)) {
    console.warn(
      `${TARGETS_CONFIG_FILENAME}: rollup.targets must be an array; ignoring the rollup.`
    );
    return undefined;
  }

  const targets: RollupTarget[] = [];
  for (const entry of raw.targets) {
    const target = parseRollupTarget(entry);
    if (target) targets.push(target);
  }

  if (targets.length === 0) {
    console.warn(
      `${TARGETS_CONFIG_FILENAME}: rollup has no valid targets; ignoring the rollup.`
    );
    return undefined;
  }

  return { name, targets };
}

/**
 * Load and validate the team config from `devex.config.json` in `dir`
 * (default: `process.cwd()`).
 *
 * Returns null when the file is absent, unparseable (with a warning), or
 * nothing valid survives validation — a config is valid when it has at least
 * one valid target, a non-empty valid `incidentLabels` list, or a valid
 * `rollup`. Each known target key is kept only when its value is a finite
 * number in a sensible range (ratios in [0,1], everything else > 0); invalid
 * values are warned about and dropped. Unknown keys are ignored. The
 * returned object always has `targets` (possibly empty) and includes
 * `incidentLabels`/`rollup` only when they validated.
 */
export function loadTargetsConfig(dir?: string): TargetsConfig | null {
  const filePath = path.join(dir ?? process.cwd(), TARGETS_CONFIG_FILENAME);
  if (!fs.existsSync(filePath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (error) {
    console.warn(
      `${TARGETS_CONFIG_FILENAME}: unparseable JSON at ${filePath}; ignoring targets. ` +
        `(${error instanceof Error ? error.message : String(error)})`
    );
    return null;
  }

  const root =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};

  const rawTargets = root.targets;
  let raw: Record<string, unknown> = {};
  if (typeof rawTargets !== "object" || rawTargets === null || Array.isArray(rawTargets)) {
    console.warn(
      `${TARGETS_CONFIG_FILENAME}: "targets" must be an object; ignoring targets.`
    );
  } else {
    raw = rawTargets as Record<string, unknown>;
  }

  const targets: TargetsConfig["targets"] = {};
  let validCount = 0;
  for (const spec of TARGET_SPECS) {
    const value = raw[spec.key];
    if (value === undefined) continue;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < spec.min ||
      value > spec.max
    ) {
      console.warn(
        `${TARGETS_CONFIG_FILENAME}: invalid value for targets.${spec.key} ` +
          `(${JSON.stringify(value)}); expected ${spec.range}. Dropping it.`
      );
      continue;
    }
    targets[spec.key] = value;
    validCount++;
  }

  const incidentLabels = parseIncidentLabels(root.incidentLabels);
  const rollup = parseRollup(root.rollup);

  if (validCount === 0 && !incidentLabels && !rollup) return null;
  const config: TargetsConfig = { targets };
  if (incidentLabels) config.incidentLabels = incidentLabels;
  if (rollup) config.rollup = rollup;
  return config;
}

/**
 * Evaluate every configured target against the computed metrics.
 *
 * Returns one `TargetEvaluation` per configured target, in the canonical key
 * order (cycle time, review coverage, change-failure rate, deploy frequency,
 * p90 first review, health score). Bounds are inclusive: a max target is met
 * when actual ≤ target and a min target when actual ≥ target. When the
 * underlying signal has no data the target is reported unmet with the detail
 * "no data to evaluate".
 */
export function evaluateTargets(
  config: TargetsConfig,
  inputs: TargetInputs
): TargetEvaluation[] {
  const evaluations: TargetEvaluation[] = [];

  for (const spec of TARGET_SPECS) {
    const target = config.targets[spec.key];
    if (target === undefined) continue;

    const { actual, hasData } = spec.extract(inputs);
    if (!hasData) {
      evaluations.push({
        id: spec.id,
        label: spec.label,
        target,
        actual,
        met: false,
        hasData: false,
        detail: "no data to evaluate",
      });
      continue;
    }

    const met = spec.kind === "max" ? actual <= target : actual >= target;
    const comparator = spec.kind === "max" ? "≤" : "≥";
    evaluations.push({
      id: spec.id,
      label: spec.label,
      target,
      actual,
      met,
      hasData: true,
      detail:
        `${spec.label} is ${spec.format(actual)} vs target ` +
        `${comparator} ${spec.format(target)}`,
    });
  }

  return evaluations;
}
