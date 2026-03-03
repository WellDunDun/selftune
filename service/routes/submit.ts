/**
 * POST /api/submit -- Accept contribution bundle submissions.
 *
 * Validates the bundle, checks rate limits, stores the submission,
 * and triggers re-aggregation for the skill.
 */

import { createHash } from "node:crypto";
import { aggregateSkillData } from "../aggregation/aggregate.js";
import type { ServiceConfig } from "../config.js";
import type { Store } from "../storage/store.js";
import { extractSkillName, validateBundle } from "../validation/validate-bundle.js";

/**
 * Hash an IP address with a daily rotating salt for privacy.
 */
function hashIp(ip: string): string {
  const dailySalt = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return createHash("sha256").update(`${ip}:${dailySalt}`).digest("hex");
}

export async function handleSubmitRoute(
  req: Request,
  store: Store,
  config: ServiceConfig,
): Promise<Response> {
  // Check content length
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > config.maxPayloadBytes) {
    return Response.json(
      { error: `Payload too large. Max ${config.maxPayloadBytes} bytes.` },
      { status: 413 },
    );
  }

  // Parse body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Validate
  const validation = validateBundle(body);
  if (!validation.valid) {
    return Response.json(
      { error: "Validation failed", details: validation.errors },
      { status: 400 },
    );
  }

  const bundle = body as Record<string, unknown>;
  const skillName = extractSkillName(bundle);
  const contributorId = bundle.contributor_id as string;

  // Rate limit check
  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? req.headers.get("x-real-ip")
    ?? "unknown";
  const ipHash = hashIp(clientIp);

  const recentCount = store.countRecentSubmissions(ipHash, 1);
  if (recentCount >= config.rateLimit.maxPerHour) {
    return Response.json(
      { error: "Rate limit exceeded. Max 10 submissions per hour." },
      { status: 429 },
    );
  }

  // Store submission
  const bundleJson = JSON.stringify(body);
  const schemaVersion = (bundle.schema_version as string) ?? "1.0";
  store.insertSubmission(skillName, contributorId, bundleJson, ipHash, schemaVersion);
  store.logAudit("submission", `New submission for ${skillName} from ${contributorId.slice(0, 8)}...`);

  // Re-aggregate for this skill
  const submissions = store.getSubmissionsBySkill(skillName);
  const aggregated = aggregateSkillData(skillName, submissions);
  store.upsertAggregation(aggregated);
  store.logAudit("aggregation", `Re-aggregated ${skillName}: ${(aggregated.weighted_pass_rate * 100).toFixed(1)}% pass rate`);

  return Response.json(
    {
      status: "accepted",
      skill_name: skillName,
      badge_url: `/badge/${encodeURIComponent(skillName)}`,
      report_url: `/report/${encodeURIComponent(skillName)}`,
    },
    { status: 201 },
  );
}
