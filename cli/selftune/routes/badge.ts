/**
 * Route handler: GET /badge/:name
 *
 * Returns a skill health badge in SVG, markdown, or URL format.
 */

import type { BadgeData } from "../badge/badge-data.js";
import { findSkillBadgeData } from "../badge/badge-data.js";
import type { BadgeFormat } from "../badge/badge-svg.js";
import { formatBadgeOutput, renderBadgeSvg } from "../badge/badge-svg.js";
import type { StatusResult } from "../status.js";

export function handleBadge(
  statusResult: StatusResult,
  skillName: string,
  format: BadgeFormat,
): Response {
  const badgeData = findSkillBadgeData(statusResult, skillName);

  if (!badgeData) {
    // Return a gray "not found" badge (format-aware)
    const notFoundData: BadgeData = {
      label: "Skill Health",
      passRate: null,
      trend: "unknown",
      status: "UNKNOWN",
      color: "#9f9f9f",
      message: "not found",
    };
    if (format === "markdown" || format === "url") {
      const output = formatBadgeOutput(notFoundData, skillName, format);
      return new Response(output, {
        status: 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache, no-store",
        },
      });
    }
    const svg = renderBadgeSvg(notFoundData);
    return new Response(svg, {
      status: 404,
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "no-cache, no-store",
      },
    });
  }

  if (format === "markdown" || format === "url") {
    const output = formatBadgeOutput(badgeData, skillName, format);
    return new Response(output, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-store",
      },
    });
  }

  const svg = renderBadgeSvg(badgeData);
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "no-cache, no-store",
    },
  });
}
