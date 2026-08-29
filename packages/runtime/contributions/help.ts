export const CONTRIBUTIONS_HELP = `selftune contributions — Manage creator-directed sharing preferences

Usage:
  selftune contributions
  selftune contributions status
  selftune contributions preview <skill>
  selftune contributions approve <skill>
  selftune contributions revoke <skill>
  selftune contributions default <ask|always|never>
  selftune contributions upload [--dry-run] [--retry-failed] [--limit <n>] [--endpoint <url>] [--api-key <key>]
  selftune contributions reset

Purpose:
  Tracks local opt-in / opt-out state for creator-directed contribution
  flows discovered from installed skills. This is separate from:
    selftune contribute   Community export bundle
    selftune alpha upload Personal cloud upload cycle

Uploads:
  Approved skills stage privacy-safe relay rows locally during sync.
  Use 'selftune contributions upload' to flush those staged rows to the
  creator-directed relay endpoint.`;

export function formatContributionsUploadHelp(endpoint: string): string {
  return `selftune contributions upload — Flush staged creator-directed relay signals

Usage:
  selftune contributions upload [--dry-run] [--retry-failed] [--limit <n>] [--endpoint <url>] [--api-key <key>]

Options:
  --dry-run         Preview how many staged signals would upload
  --retry-failed    Requeue previously failed rows before attempting upload
  --limit <n>       Max number of staged rows to attempt (default: 50)
  --endpoint <url>  Creator-operated relay endpoint${endpoint ? ` (default: ${endpoint})` : ""}
  --api-key <key>   Creator relay credential`;
}

export const CONTRIBUTIONS_UPLOAD_HELP = formatContributionsUploadHelp(CONTRIBUTION_RELAY_ENDPOINT);
import { CONTRIBUTION_RELAY_ENDPOINT } from "../constants.js";
