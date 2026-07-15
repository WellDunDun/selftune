import { parseArgs } from "node:util";

import { defaultSyncPreferences } from "@selftune/control-plane";

import { cliMain as listLibrary } from "./library-catalog.js";
import { loadRemoteLibraryConfig, saveRemoteLibraryConfig } from "./remote-library-config.js";
import { createRemoteLibraryHandle } from "./remote-library-runtime.js";
import {
  diagnoseRemote,
  exportRemoteLibrary,
  previewRemoteLibrarySync,
  restoreRemoteLibrary,
  syncRemoteLibrary,
} from "./remote-library-sync.js";
import { CLIError } from "./utils/cli-error.js";
import {
  draftSynthesisCandidate,
  evaluateSynthesisCandidate,
  loadCandidateSnapshot,
  releaseSynthesisCandidate,
  reviewSynthesisCandidate,
  scanSynthesisCandidates,
} from "./synthesis.js";

function usage(): string {
  return `selftune library — Reconcile and back up the local-first Skill Library

Usage:
  selftune library
  selftune library configure --url <remote-url> --api-key <device-key>
  selftune library preview
  selftune library sync
  selftune library status
  selftune library diagnostics
  selftune library export --output <backup.json>
  selftune library restore --target <clean-config-directory>
  selftune library synthesize scan
  selftune library synthesize list
  selftune library synthesize review --candidate-id <id> --action <accept|reject|snooze|edit> --reason <text>
  selftune library synthesize draft --candidate-id <id> [--output-dir <directory>]
  selftune library synthesize evaluate --candidate-id <id>
  selftune library synthesize release --candidate-id <id>`;
}

export async function cliMain(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      url: { type: "string" },
      "api-key": { type: "string" },
      output: { type: "string" },
      target: { type: "string" },
      "candidate-id": { type: "string" },
      action: { type: "string" },
      reason: { type: "string" },
      "snooze-until": { type: "string" },
      "output-dir": { type: "string" },
      title: { type: "string" },
      summary: { type: "string" },
    },
  });
  const command = positionals[0] ?? "list";
  if (values.help) {
    console.log(usage());
    return;
  }
  if (command === "list") {
    await listLibrary();
    return;
  }
  if (command === "synthesize") {
    const action = positionals[1] ?? "list";
    if (action === "scan") {
      console.log(JSON.stringify(await scanSynthesisCandidates(), null, 2));
      return;
    }
    if (action === "list") {
      console.log(JSON.stringify(loadCandidateSnapshot(), null, 2));
      return;
    }
    const candidateId = values["candidate-id"]?.trim();
    if (!candidateId) throw new CLIError("--candidate-id is required.", "MISSING_FLAG");
    if (action === "review") {
      const decision = values.action;
      if (!decision || !["accept", "reject", "snooze", "edit"].includes(decision)) {
        throw new CLIError("--action must be accept, reject, snooze, or edit.", "INVALID_FLAG");
      }
      if (!values.reason?.trim()) {
        throw new CLIError("--reason is required for decision history.", "MISSING_FLAG");
      }
      console.log(
        JSON.stringify(
          await reviewSynthesisCandidate({
            candidateId,
            action: decision as "accept" | "reject" | "snooze" | "edit",
            reason: values.reason,
            snoozedUntil: values["snooze-until"],
            title: values.title,
            summary: values.summary,
          }),
          null,
          2,
        ),
      );
      return;
    }
    if (action === "draft") {
      console.log(
        JSON.stringify(await draftSynthesisCandidate(candidateId, values["output-dir"]), null, 2),
      );
      return;
    }
    if (action === "evaluate") {
      console.log(JSON.stringify(await evaluateSynthesisCandidate(candidateId), null, 2));
      return;
    }
    if (action === "release") {
      console.log(JSON.stringify(await releaseSynthesisCandidate(candidateId), null, 2));
      return;
    }
    throw new CLIError(`Unknown synthesize action: ${action}`, "INVALID_FLAG", usage());
  }
  if (command === "configure") {
    if (!values.url) throw new CLIError("--url is required.", "MISSING_FLAG");
    if (!values["api-key"]) throw new CLIError("--api-key is required.", "MISSING_FLAG");
    const saved = saveRemoteLibraryConfig({
      url: values.url,
      apiKey: values["api-key"],
      preferences: defaultSyncPreferences,
    });
    console.log(
      JSON.stringify({ configured: true, url: saved.url, preferences: saved.preferences }, null, 2),
    );
    return;
  }

  const config = loadRemoteLibraryConfig();
  if (command === "preview") {
    console.log(
      JSON.stringify(await previewRemoteLibrarySync({ preferences: config.preferences }), null, 2),
    );
    return;
  }
  const handle = createRemoteLibraryHandle({ baseUrl: config.url, apiKey: config.apiKey });
  try {
    if (command === "sync") {
      console.log(
        JSON.stringify(
          await syncRemoteLibrary({ handle, preferences: config.preferences }),
          null,
          2,
        ),
      );
      return;
    }
    if (command === "status") {
      const [capabilities, head, diagnostics] = await Promise.all([
        handle.capabilities(),
        handle.head(),
        handle.diagnostics(),
      ]);
      console.log(JSON.stringify({ url: config.url, capabilities, head, diagnostics }, null, 2));
      return;
    }
    if (command === "diagnostics") {
      console.log(JSON.stringify(await diagnoseRemote(handle), null, 2));
      return;
    }
    if (command === "export") {
      if (!values.output) throw new CLIError("--output is required.", "MISSING_FLAG");
      console.log(
        JSON.stringify(await exportRemoteLibrary({ handle, outputPath: values.output }), null, 2),
      );
      return;
    }
    if (command === "restore") {
      if (!values.target) throw new CLIError("--target is required.", "MISSING_FLAG");
      console.log(
        JSON.stringify(await restoreRemoteLibrary({ handle, targetRoot: values.target }), null, 2),
      );
      return;
    }
    throw new CLIError(`Unknown library command: ${command}`, "INVALID_FLAG", usage());
  } finally {
    await handle.dispose();
  }
}
