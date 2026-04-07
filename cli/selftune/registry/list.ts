/**
 * selftune registry list — Show all published entries in the org.
 */

import { registryRequest } from "./client.js";

export async function cliMain() {
  const result = await registryRequest<{
    entries: Array<{
      name: string;
      entry_type: string;
      description: string | null;
      current_version?: { version: string };
      pass_rate: number | null;
      eval_count: number;
    }>;
  }>("GET", "");

  if (!result.success) {
    console.error(JSON.stringify({ error: result.error }));
    process.exit(1);
  }

  const entries = result.data?.entries || [];
  if (entries.length === 0) {
    console.log(
      JSON.stringify({
        message: "No entries in registry. Use 'selftune registry push' to publish a skill.",
      }),
    );
    return;
  }

  const table = entries.map((e) => ({
    name: e.name,
    type: e.entry_type,
    version: e.current_version?.version || "—",
    pass_rate: e.pass_rate,
    eval_count: e.eval_count,
    description: e.description,
  }));

  console.log(JSON.stringify({ entries: table, total: entries.length }));
}
