import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { discoverLegacyCorrectionSignalPage } from "@selftune/runtime/correction-study/legacy-signal-discovery";

const databasePath = process.env.SELFTUNE_DB_PATH ?? join(homedir(), ".selftune", "selftune.db");

if (!existsSync(databasePath)) {
  throw new Error(`SelfTune database does not exist: ${databasePath}`);
}

// This command opens the production database read-only and never invokes migrations or persistence.
const database = new Database(databasePath, { readonly: true });
try {
  const count = database
    .query<{ readonly count: number }, []>(
      "SELECT COUNT(*) AS count FROM improvement_signals WHERE signal_type = 'correction'",
    )
    .get()?.count;
  const page = discoverLegacyCorrectionSignalPage(database, { limit: 128 });
  // oxlint-disable-next-line no-console -- This read-only CLI emits one machine-readable result.
  console.log(
    JSON.stringify({
      mode: "read-only",
      correction_rows: count ?? 0,
      discovered_first_page: page.items.length,
      next_page_available: page.next_cursor !== null,
    }),
  );
} finally {
  database.close();
}
