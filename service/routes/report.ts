/**
 * GET /report/:skillName -- HTML skill health report page.
 */

import type { Store } from "../storage/store.js";
import { renderReportHTML } from "../report/report-html.js";

export function handleReportRoute(url: URL, store: Store): Response {
  const skillName = decodeURIComponent(url.pathname.slice("/report/".length));
  const aggregation = store.getAggregation(skillName);

  if (!aggregation) {
    return new Response("Skill not found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const html = renderReportHTML(aggregation);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
