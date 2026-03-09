/**
 * Badge data computation for selftune skill health badges.
 *
 * Maps SkillStatus into display-ready BadgeData with color coding,
 * trend arrows, and formatted messages. Pure functions, zero deps.
 */

import type { SkillStatus, StatusResult } from "../status.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BadgeData {
  label: string;
  passRate: number | null;
  trend: "up" | "down" | "stable" | "unknown";
  status: "HEALTHY" | "WARNING" | "CRITICAL" | "UNGRADED" | "UNKNOWN";
  color: string;
  message: string;
}

export type BadgeFormat = "svg" | "markdown" | "url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BADGE_THRESHOLDS = {
  /** Above this → green */
  GREEN: 0.8,
  /** At or above this → yellow; below → red */
  YELLOW: 0.6,
} as const;

export const BADGE_COLORS = {
  GREEN: "#4c1",
  YELLOW: "#dfb317",
  RED: "#e05d44",
  GRAY: "#9f9f9f",
} as const;

export const TREND_ARROWS: Record<BadgeData["trend"], string> = {
  up: "\u2191",
  down: "\u2193",
  stable: "\u2192",
  unknown: "",
};

// ---------------------------------------------------------------------------
// computeBadgeData
// ---------------------------------------------------------------------------

/**
 * Convert a SkillStatus into display-ready badge data.
 *
 * Color thresholds:
 *  - green  (#4c1)    passRate > 0.8
 *  - yellow (#dfb317) passRate 0.6 - 0.8 (inclusive)
 *  - red    (#e05d44) passRate < 0.6
 *  - gray   (#9f9f9f) passRate is null (no data)
 */
export function computeBadgeData(skill: SkillStatus): BadgeData {
  const { passRate, trend, status } = skill;

  let color: string;
  let message: string;

  if (passRate === null) {
    color = BADGE_COLORS.GRAY;
    message = "no data";
  } else {
    if (passRate > BADGE_THRESHOLDS.GREEN) {
      color = BADGE_COLORS.GREEN;
    } else if (passRate >= BADGE_THRESHOLDS.YELLOW) {
      color = BADGE_COLORS.YELLOW;
    } else {
      color = BADGE_COLORS.RED;
    }

    const pct = `${Math.round(passRate * 100)}%`;
    const arrow = TREND_ARROWS[trend];
    message = arrow ? `${pct} ${arrow}` : pct;
  }

  return {
    label: "Skill Health",
    passRate,
    trend,
    status,
    color,
    message,
  };
}

// ---------------------------------------------------------------------------
// findSkillBadgeData
// ---------------------------------------------------------------------------

/**
 * Find a skill by name in a StatusResult and return its BadgeData,
 * or null if the skill is not found.
 */
export function findSkillBadgeData(result: StatusResult, name: string): BadgeData | null {
  const skill = result.skills.find((s) => s.name === name);
  if (!skill) return null;
  return computeBadgeData(skill);
}
