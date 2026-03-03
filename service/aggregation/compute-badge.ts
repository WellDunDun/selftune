/**
 * Adapter: converts AggregatedSkillData into BadgeData for SVG rendering.
 *
 * Bridges the service aggregation layer with the existing CLI badge renderer.
 */

import type { BadgeData } from "../../cli/selftune/badge/badge-data.js";
import type { AggregatedSkillData } from "../types.js";

const COLOR_GREEN = "#4c1";
const COLOR_YELLOW = "#dfb317";
const COLOR_RED = "#e05d44";
const COLOR_GRAY = "#9f9f9f";

const TREND_ARROWS: Record<string, string> = {
  up: "\u2191",
  down: "\u2193",
  stable: "\u2192",
  unknown: "",
};

/**
 * Convert aggregated community data into display-ready BadgeData.
 *
 * Color thresholds mirror cli/selftune/badge/badge-data.ts:
 *  - green  (#4c1)    passRate > 0.8
 *  - yellow (#dfb317) passRate 0.6 - 0.8
 *  - red    (#e05d44) passRate < 0.6
 *  - gray   (#9f9f9f) no data
 */
export function aggregatedToBadgeData(data: AggregatedSkillData): BadgeData {
  if (data.status === "NO DATA" || data.session_count === 0) {
    return {
      label: "Skill Health",
      passRate: null,
      trend: "unknown",
      status: "NO DATA",
      color: COLOR_GRAY,
      message: "no data",
    };
  }

  const passRate = data.weighted_pass_rate;
  let color: string;
  if (passRate > 0.8) {
    color = COLOR_GREEN;
  } else if (passRate >= 0.6) {
    color = COLOR_YELLOW;
  } else {
    color = COLOR_RED;
  }

  const pct = `${Math.round(passRate * 100)}%`;
  const arrow = TREND_ARROWS[data.trend] ?? "";
  const message = arrow ? `${pct} ${arrow}` : pct;

  return {
    label: "Skill Health",
    passRate,
    trend: data.trend,
    status: data.status,
    color,
    message,
  };
}
