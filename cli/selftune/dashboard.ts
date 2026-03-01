/**
 * selftune dashboard — Exports JSONL data into a standalone HTML viewer.
 *
 * Usage:
 *   selftune dashboard              — Open dashboard in default browser
 *   selftune dashboard --export     — Export data-embedded HTML to stdout
 *   selftune dashboard --out FILE   — Write data-embedded HTML to FILE
 *   selftune dashboard --serve      — Start live dashboard server (default port 3141)
 *   selftune dashboard --serve --port 8080 — Start on custom port
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { EVOLUTION_AUDIT_LOG, QUERY_LOG, SKILL_LOG, TELEMETRY_LOG } from "./constants.js";
import { getLastDeployedProposal, readAuditTrail } from "./evolution/audit.js";
import { computeMonitoringSnapshot } from "./monitoring/watch.js";
import type {
  EvolutionAuditEntry,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "./types.js";
import { readJsonl } from "./utils/jsonl.js";

function findViewerHTML(): string {
  // Try relative to this module first (works for both dev and installed)
  const candidates = [
    join(dirname(import.meta.dir), "..", "dashboard", "index.html"),
    join(dirname(import.meta.dir), "dashboard", "index.html"),
    resolve("dashboard", "index.html"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error("Could not find dashboard/index.html. Ensure it exists in the selftune repo.");
}

function buildEmbeddedHTML(): string {
  const template = readFileSync(findViewerHTML(), "utf-8");

  const telemetry = readJsonl<SessionTelemetryRecord>(TELEMETRY_LOG);
  const skills = readJsonl<SkillUsageRecord>(SKILL_LOG);
  const queries = readJsonl<QueryLogRecord>(QUERY_LOG);
  const evolution = readJsonl<EvolutionAuditEntry>(EVOLUTION_AUDIT_LOG);

  const totalRecords = telemetry.length + skills.length + queries.length + evolution.length;

  if (totalRecords === 0) {
    console.error("No log data found. Run some sessions first.");
    console.error(`  Checked: ${TELEMETRY_LOG}`);
    console.error(`           ${SKILL_LOG}`);
    console.error(`           ${QUERY_LOG}`);
    console.error(`           ${EVOLUTION_AUDIT_LOG}`);
    process.exit(1);
  }

  // Compute per-skill monitoring snapshots
  const skillNames = [...new Set(skills.map((r) => r.skill_name))];
  const snapshots: Record<string, ReturnType<typeof computeMonitoringSnapshot>> = {};
  for (const name of skillNames) {
    const lastDeployed = getLastDeployedProposal(name);
    const baselinePassRate = lastDeployed?.eval_snapshot?.pass_rate ?? 0.5;
    snapshots[name] = computeMonitoringSnapshot(
      name,
      telemetry,
      skills,
      queries,
      telemetry.length,
      baselinePassRate,
    );
  }

  // Compute unmatched queries
  const triggeredQueries = new Set(
    skills.filter((r) => r.triggered).map((r) => r.query.toLowerCase().trim()),
  );
  const unmatched = queries
    .filter((q) => !triggeredQueries.has(q.query.toLowerCase().trim()))
    .map((q) => ({
      timestamp: q.timestamp,
      session_id: q.session_id,
      query: q.query,
    }));

  // Compute pending proposals
  const auditTrail = readAuditTrail();
  const proposalStatus: Record<string, string[]> = {};
  for (const e of auditTrail) {
    if (!proposalStatus[e.proposal_id]) proposalStatus[e.proposal_id] = [];
    proposalStatus[e.proposal_id].push(e.action);
  }
  // Deduplicate by proposal_id: one entry per pending proposal
  const terminalActions = new Set(["deployed", "rejected", "rolled_back"]);
  const seenProposals = new Set<string>();
  const pendingProposals = auditTrail.filter((e) => {
    if (e.action !== "created" && e.action !== "validated") return false;
    if (seenProposals.has(e.proposal_id)) return false;
    const actions = proposalStatus[e.proposal_id] || [];
    const isPending = !actions.some((a: string) => terminalActions.has(a));
    if (isPending) seenProposals.add(e.proposal_id);
    return isPending;
  });

  const data = {
    telemetry,
    skills,
    queries,
    evolution,
    computed: {
      snapshots,
      unmatched,
      pendingProposals,
    },
  };

  // Inject embedded data right before </body>
  // Escape </script> sequences to prevent XSS via embedded JSON
  const safeJson = JSON.stringify(data).replace(/<\/script>/gi, "<\\/script>");
  const dataScript = `<script id="embedded-data" type="application/json">${safeJson}</script>`;
  return template.replace("</body>", `${dataScript}\n</body>`);
}

export async function cliMain(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`selftune dashboard — Visual data dashboard

Usage:
  selftune dashboard                        Open dashboard in default browser
  selftune dashboard --export               Export data-embedded HTML to stdout
  selftune dashboard --out FILE             Write data-embedded HTML to FILE
  selftune dashboard --serve                Start live dashboard server (port 3141)
  selftune dashboard --serve --port 8080    Start on custom port`);
    process.exit(0);
  }

  if (args.includes("--serve")) {
    const portIdx = args.indexOf("--port");
    const port = portIdx !== -1 ? Number.parseInt(args[portIdx + 1], 10) : undefined;
    const { startDashboardServer } = await import("./dashboard-server.js");
    await startDashboardServer({ port, openBrowser: true });
    return;
  }

  if (args.includes("--export")) {
    process.stdout.write(buildEmbeddedHTML());
    return;
  }

  const outIdx = args.indexOf("--out");
  if (outIdx !== -1) {
    const outPath = args[outIdx + 1];
    if (!outPath) {
      console.error("--out requires a file path argument");
      process.exit(1);
    }
    const html = buildEmbeddedHTML();
    writeFileSync(outPath, html, "utf-8");
    console.log(`Dashboard written to ${outPath}`);
    return;
  }

  // Default: write to temp file and open in browser
  const tmpDir = join(homedir(), ".selftune");
  if (!existsSync(tmpDir)) {
    mkdirSync(tmpDir, { recursive: true });
  }
  const tmpPath = join(tmpDir, "dashboard.html");
  const html = buildEmbeddedHTML();
  writeFileSync(tmpPath, html, "utf-8");

  console.log(`Dashboard saved to ${tmpPath}`);
  console.log("Opening in browser...");

  try {
    const platform = process.platform;
    const cmd = platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : null;
    if (!cmd) throw new Error("Unsupported platform");
    const proc = Bun.spawn([cmd, tmpPath], { stdio: ["ignore", "ignore", "ignore"] });
    await proc.exited;
    if (proc.exitCode !== 0) throw new Error(`Failed to launch ${cmd}`);
  } catch {
    console.log(`Open manually: file://${tmpPath}`);
  }
  process.exit(0);
}
