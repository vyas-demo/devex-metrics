/**
 * Monte-Carlo delivery forecasting.
 *
 * Pure, side-effect-free derivation from the org-level `weeklyTrends` data
 * that `collect` already gathers. Resamples historical weekly merged-PR
 * throughput to answer "how many weeks until we land N more PRs?" at 50%,
 * 85%, and 95% confidence — no additional API calls, no wall-clock reads.
 */
import type {
  OrgMetrics,
  WeeklyTrendPoint,
  DeliveryForecast,
  ForecastTarget,
} from "./types.js";
import { median, percentile } from "./developer-stats.js";

/** Options for {@link computeDeliveryForecast}. */
export interface ForecastOptions {
  /** PR-count targets to forecast. Default [10, 25, 50]. */
  targets?: number[];
  /** Completed weeks to sample from the tail of the trend. Default 12. */
  sampleWeeks?: number;
  /** Monte-Carlo iterations. Default 5000. */
  iterations?: number;
  /** PRNG seed for reproducibility. Default 42. */
  seed?: number;
  /** ISO timestamp treated as "now". Default metrics.collectedAt. */
  now?: string;
}

/** Minimum completed weeks required to run a simulation. */
const MIN_SAMPLE_WEEKS = 4;

/** Safety cap on simulated weeks per iteration (unreachable given total>0). */
const MAX_SIM_WEEKS = 520;

/** Milliseconds in one week. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Return the ISO 8601 week label ("YYYY-Www") for a UTC date.
 *
 * Replicated from `toIsoWeekLabel` in `src/collectors/trends.ts` so this
 * pure compute module does not pull in the collectors' Octokit dependency
 * chain. Uses the same Thursday-anchored algorithm: the ISO year of a week
 * is the year that contains that week's Thursday.
 */
export function isoWeekLabel(date: Date): string {
  // Work entirely in UTC to avoid local-timezone drift.
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  // ISO day-of-week: Mon=1 … Sun=7
  const dow = d.getUTCDay() || 7;
  // Shift to the Thursday of the same ISO week.
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const year = d.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const weekNum = Math.ceil(
    ((d.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7
  );
  return `${year}-W${String(weekNum).padStart(2, "0")}`;
}

/**
 * mulberry32 — a tiny, fast, seedable 32-bit PRNG returning floats in [0, 1).
 * Used instead of Math.random so forecasts are reproducible for a given seed.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Date-only ISO string (YYYY-MM-DD) of `nowMs` plus `weeks` × 7 days. */
function weeksFromNowDate(nowMs: number, weeks: number): string {
  return new Date(nowMs + weeks * WEEK_MS).toISOString().slice(0, 10);
}

/** The empty forecast returned whenever there is not enough history. */
function emptyForecast(): DeliveryForecast {
  return { hasData: false, sampleWeeks: 0, medianWeeklyThroughput: 0, targets: [] };
}

/**
 * Compute a Monte-Carlo delivery forecast from org-level weekly throughput.
 *
 * The sample is the last `sampleWeeks` completed ISO weeks of
 * `metrics.weeklyTrends` (the current partial week — the trend point whose
 * label matches the ISO week of `now` — is excluded; zero-merge weeks stay
 * in, since they are real throughput). Each iteration repeatedly draws a
 * uniformly random week from the sample and accumulates its `prsMerged`
 * until the target is reached; p50/p85/p95 over the iteration week counts
 * (rounded up to whole weeks) give the confidence levels, and projected
 * completion dates are `now` + weeks × 7 days.
 *
 * Returns `hasData: false` when there are no weekly trends, fewer than 4
 * completed sampled weeks, or the sample contains zero merged PRs in total.
 */
export function computeDeliveryForecast(
  metrics: OrgMetrics,
  options: ForecastOptions = {}
): DeliveryForecast {
  const {
    targets = [10, 25, 50],
    sampleWeeks = 12,
    iterations = 5000,
    seed = 42,
    now = metrics.collectedAt,
  } = options;

  const trends: WeeklyTrendPoint[] = metrics.weeklyTrends ?? [];
  if (trends.length === 0) return emptyForecast();

  const nowMs = Date.parse(now);
  const currentWeek = isoWeekLabel(new Date(nowMs));

  // Completed weeks only: drop the current (partial) ISO week, keep the tail.
  const sample = trends
    .filter((point) => point.week !== currentWeek)
    .slice(-sampleWeeks)
    .map((point) => point.prsMerged);

  if (sample.length < MIN_SAMPLE_WEEKS) return emptyForecast();
  const totalMerged = sample.reduce((sum, merged) => sum + merged, 0);
  if (totalMerged === 0) return emptyForecast();

  const rand = mulberry32(seed);

  // Clean targets: positive only, deduplicated, ascending.
  const prCounts = [...new Set(targets.filter((t) => t > 0))].sort((a, b) => a - b);

  const forecastTargets: ForecastTarget[] = prCounts.map((prCount) => {
    const weeksNeeded: number[] = [];
    for (let i = 0; i < iterations; i++) {
      let delivered = 0;
      let weeks = 0;
      while (delivered < prCount && weeks < MAX_SIM_WEEKS) {
        delivered += sample[Math.floor(rand() * sample.length)];
        weeks++;
      }
      weeksNeeded.push(weeks);
    }
    const p50Weeks = Math.ceil(percentile(weeksNeeded, 0.5));
    const p85Weeks = Math.ceil(percentile(weeksNeeded, 0.85));
    const p95Weeks = Math.ceil(percentile(weeksNeeded, 0.95));
    return {
      prCount,
      p50Weeks,
      p85Weeks,
      p95Weeks,
      p50Date: weeksFromNowDate(nowMs, p50Weeks),
      p85Date: weeksFromNowDate(nowMs, p85Weeks),
      p95Date: weeksFromNowDate(nowMs, p95Weeks),
    };
  });

  return {
    hasData: true,
    sampleWeeks: sample.length,
    medianWeeklyThroughput: median(sample),
    targets: forecastTargets,
  };
}
