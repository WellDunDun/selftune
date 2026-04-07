/**
 * selftune registry rollback — Rollback a skill to a previous version.
 */

import { registryRequest } from "./client.js";

export async function cliMain() {
  const args = process.argv.slice(2);
  const name = args.find((a) => !a.startsWith("--"));
  const toVersion = args.find((a) => a.startsWith("--to="))?.slice("--to=".length);
  const reason = args.find((a) => a.startsWith("--reason="))?.slice("--reason=".length);

  if (!name) {
    console.error(
      JSON.stringify({
        error: "Usage: selftune registry rollback <name> [--to=version] [--reason=text]",
      }),
    );
    process.exit(1);
  }

  // Find entry
  const listResult = await registryRequest<{ entries: Array<{ id: string; name: string }> }>(
    "GET",
    `?name=${encodeURIComponent(name)}`,
  );
  if (!listResult.success || !listResult.data?.entries?.length) {
    console.error(JSON.stringify({ error: `Skill '${name}' not found in registry` }));
    process.exit(1);
  }

  const entryId = listResult.data.entries[0].id;
  const result = await registryRequest("POST", `/${entryId}/rollback`, {
    body: { target_version: toVersion, reason },
  });

  if (result.success) {
    console.log(
      JSON.stringify({
        success: true,
        name,
        message: "Rolled back. Run 'selftune registry sync' to update local installations.",
      }),
    );
  } else {
    console.error(JSON.stringify({ error: result.error }));
    process.exit(1);
  }
}
