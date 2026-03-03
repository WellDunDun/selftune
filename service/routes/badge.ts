/**
 * GET /badge/:skillName -- Dynamic SVG badge for a skill.
 *
 * Returns shields.io flat-style SVG from aggregated community data.
 * Unknown skills get a gray "no data" SVG (never broken images).
 */

import { renderBadgeSvg, formatBadgeOutput } from "../../cli/selftune/badge/badge-svg.js";
import type { BadgeData, BadgeFormat } from "../../cli/selftune/badge/badge-data.js";
import { aggregatedToBadgeData } from "../aggregation/compute-badge.js";
import type { Store } from "../storage/store.js";
import type { ServiceConfig } from "../config.js";

const NO_DATA_BADGE: BadgeData = {
  label: "Skill Health",
  passRate: null,
  trend: "unknown",
  status: "NO DATA",
  color: "#9f9f9f",
  message: "no data",
};

export function handleBadgeRoute(
  url: URL,
  store: Store,
  config: ServiceConfig,
): Response {
  const skillName = decodeURIComponent(url.pathname.slice("/badge/".length));
  const format = (url.searchParams.get("format") as BadgeFormat) ?? "svg";

  const aggregation = store.getAggregation(skillName);
  const badgeData = aggregation ? aggregatedToBadgeData(aggregation) : NO_DATA_BADGE;

  const cacheHeader = `public, max-age=${config.badgeCacheMaxAge}, stale-while-revalidate=86400`;

  if (format === "markdown" || format === "url") {
    const output = formatBadgeOutput(badgeData, skillName, format);
    return new Response(output, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": cacheHeader,
      },
    });
  }

  const svg = renderBadgeSvg(badgeData);
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": cacheHeader,
    },
  });
}
