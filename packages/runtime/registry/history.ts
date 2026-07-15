/**
 * selftune registry history — Show version timeline for a skill.
 */

import { registryRequest } from "./client.js";

export async function cliMain() {
  const args = process.argv.slice(2);
  const name = args.find((a) => !a.startsWith("--"));

  if (!name) {
    console.error(JSON.stringify({ error: "Usage: selftune registry history <name>" }));
    process.exit(1);
  }

  const listResult = await registryRequest<{ entries: Array<{ id: string }> }>(
    "GET",
    `?name=${encodeURIComponent(name)}`,
  );
  if (!listResult.success || !listResult.data?.entries?.length) {
    console.error(JSON.stringify({ error: `Skill '${name}' not found in registry` }));
    process.exit(1);
  }

  const entryId = listResult.data.entries[0].id;
  const result = await registryRequest<{
    versions: Array<{
      version: string;
      is_current: boolean;
      rolled_back: boolean;
      aggregate_pass_rate: number | null;
      aggregate_sessions: number;
      change_summary: string | null;
      pushed_at: string;
    }>;
  }>("GET", `/${entryId}/versions`);

  if (!result.success) {
    console.error(JSON.stringify({ error: result.error }));
    process.exit(1);
  }

  const versions = result.data?.versions || [];
  const timeline = versions.map((v) => ({
    version: v.version,
    status: v.is_current ? "current" : v.rolled_back ? "rolled_back" : "previous",
    pass_rate: v.aggregate_pass_rate,
    sessions: v.aggregate_sessions,
    summary: v.change_summary,
    pushed_at: v.pushed_at,
  }));

  console.log(JSON.stringify({ name, versions: timeline }));
}
