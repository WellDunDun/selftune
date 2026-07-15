import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  applySkillSet,
  createSkillSet,
  deriveSkillSetFromProject,
  exportPortableSkillSet,
  importPortableSkillSet,
  listSkillSetRevisions,
  listSkillSetReceipts,
  listSkillSets,
  planSkillSet,
  rollbackSkillSet,
  updateSkillSet,
  type SkillSetHarnessId,
} from "./skill-sets.js";
import { CLIError, handleCLIError } from "./utils/cli-error.js";

const HELP = `selftune sets - Reusable project skill configurations

Usage:
  selftune sets list [--json]
  selftune sets create --name <name> --harness <id> --skill-path <path> [options]
  selftune sets update --set <id> --parent-revision <hash> --harness <id> --skill-path <path> [options]
  selftune sets derive --name <name> --project <path> --harness <id> [options]
  selftune sets history --set <id> [--json]
  selftune sets export --set <id> --project <path> [--output <path>]
  selftune sets import --manifest <path> [--json]
  selftune sets plan --set <id> --project <path> [--json]
  selftune sets apply --set <id> --project <path> [--json]
  selftune sets receipts [--json]
  selftune sets rollback --receipt <id> [--json]

Create options:
  --name <name>          Human-readable Skill Set name
  --description <text>  Optional purpose or project-archetype description
  --harness <id>        Repeat for codex, claude_code, opencode, openclaw, or pi
  --skill-path <path>   Repeat for each package directory or SKILL.md

Apply is conflict-blocking and idempotent. Rollback removes only receipt-owned paths.`;

function requireString(value: string | undefined, flag: string, nextCommand: string): string {
  if (!value?.trim()) {
    throw new CLIError(`${flag} is required.`, "MISSING_FLAG", nextCommand);
  }
  return value.trim();
}

function printResult(value: unknown, json: boolean, message: string): void {
  if (json || !process.stdout.isTTY) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(message);
}

function packagePathFromInput(value: string): string {
  const path = resolve(value);
  return basename(path).toUpperCase() === "SKILL.MD" ? dirname(path) : path;
}

export async function cliMain(): Promise<void> {
  const [subcommand, ...args] = process.argv.slice(2);
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(HELP);
    return;
  }

  if (subcommand === "list" || subcommand === "receipts") {
    const { values } = parseArgs({
      args,
      options: {
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });
    if (values.help) {
      console.log(HELP);
      return;
    }
    const result = subcommand === "list" ? listSkillSets() : listSkillSetReceipts();
    printResult(
      result,
      values.json,
      result.length === 0
        ? `No Skill ${subcommand === "list" ? "Sets" : "Set receipts"} found.`
        : result
            .map((entry) =>
              "name" in entry
                ? `${entry.set_id}: ${entry.name} (${entry.skills.length} skills)`
                : `${entry.receipt_id}: ${entry.set_name} (${entry.status})`,
            )
            .join("\n"),
    );
    return;
  }

  if (subcommand === "create") {
    const { values } = parseArgs({
      args,
      options: {
        name: { type: "string" },
        description: { type: "string" },
        harness: { type: "string", multiple: true },
        "skill-path": { type: "string", multiple: true },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });
    if (values.help) {
      console.log(HELP);
      return;
    }
    const name = requireString(values.name, "--name", "selftune sets create --help");
    const harnesses = (values.harness ?? []) as SkillSetHarnessId[];
    const skillPaths = values["skill-path"] ?? [];
    const manifest = createSkillSet({
      name,
      description: values.description,
      harnesses,
      skills: skillPaths.map((inputPath) => {
        const packagePath = packagePathFromInput(inputPath);
        return { name: basename(packagePath), package_path: packagePath };
      }),
    });
    printResult(
      manifest,
      values.json,
      `Created Skill Set "${manifest.name}" with ${manifest.skills.length} pinned skill${manifest.skills.length === 1 ? "" : "s"}.`,
    );
    return;
  }

  if (subcommand === "update") {
    const { values } = parseArgs({
      args,
      options: {
        set: { type: "string" },
        "parent-revision": { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        harness: { type: "string", multiple: true },
        "skill-path": { type: "string", multiple: true },
        json: { type: "boolean", default: false },
      },
      strict: true,
    });
    const setId = requireString(values.set, "--set", "selftune sets update --help");
    const parentRevision = requireString(
      values["parent-revision"],
      "--parent-revision",
      "selftune sets history --set <id> --json",
    );
    const manifest = updateSkillSet(setId, {
      name: values.name,
      description: values.description,
      harnesses: (values.harness ?? []) as SkillSetHarnessId[],
      skills: (values["skill-path"] ?? []).map((inputPath) => {
        const packagePath = packagePathFromInput(inputPath);
        return { name: basename(packagePath), package_path: packagePath };
      }),
      parent_revision_hash: parentRevision,
    });
    printResult(
      manifest,
      values.json,
      `Updated Skill Set "${manifest.name}" to v${manifest.revision}.`,
    );
    return;
  }

  if (subcommand === "derive") {
    const { values } = parseArgs({
      args,
      options: {
        name: { type: "string" },
        description: { type: "string" },
        project: { type: "string" },
        harness: { type: "string", multiple: true },
        json: { type: "boolean", default: false },
      },
      strict: true,
    });
    const manifest = deriveSkillSetFromProject({
      name: requireString(values.name, "--name", "selftune sets derive --help"),
      description: values.description,
      project_root: requireString(values.project, "--project", "selftune sets derive --help"),
      harnesses: (values.harness ?? []) as SkillSetHarnessId[],
    });
    printResult(
      manifest,
      values.json,
      `Captured ${manifest.skills.length} project skills in "${manifest.name}".`,
    );
    return;
  }

  if (subcommand === "history") {
    const { values } = parseArgs({
      args,
      options: { set: { type: "string" }, json: { type: "boolean", default: false } },
      strict: true,
    });
    const setId = requireString(values.set, "--set", "selftune sets history --help");
    const revisions = listSkillSetRevisions(setId);
    printResult(
      revisions,
      values.json,
      revisions
        .map((revision) => `v${revision.revision} ${revision.revision_hash.slice(0, 12)}`)
        .join("\n"),
    );
    return;
  }

  if (subcommand === "export") {
    const { values } = parseArgs({
      args,
      options: {
        set: { type: "string" },
        project: { type: "string" },
        output: { type: "string" },
      },
      strict: true,
    });
    const setId = requireString(values.set, "--set", "selftune sets export --help");
    const project = requireString(values.project, "--project", "selftune sets export --help");
    console.log(exportPortableSkillSet(setId, project, { outputPath: values.output }));
    return;
  }

  if (subcommand === "import") {
    const { values } = parseArgs({
      args,
      options: {
        manifest: { type: "string" },
        json: { type: "boolean", default: false },
      },
      strict: true,
    });
    const manifest = importPortableSkillSet(
      requireString(values.manifest, "--manifest", "selftune sets import --help"),
    );
    printResult(manifest, values.json, `Imported Skill Set "${manifest.name}".`);
    return;
  }

  if (subcommand === "plan" || subcommand === "apply") {
    const { values } = parseArgs({
      args,
      options: {
        set: { type: "string" },
        project: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });
    if (values.help) {
      console.log(HELP);
      return;
    }
    const setId = requireString(values.set, "--set", `selftune sets ${subcommand} --help`);
    const projectRoot = requireString(
      values.project,
      "--project",
      `selftune sets ${subcommand} --help`,
    );
    if (subcommand === "plan") {
      const plan = planSkillSet({ set_id: setId, project_root: projectRoot });
      printResult(
        plan,
        values.json,
        `${plan.set_name}: ${plan.creates} create, ${plan.unchanged} unchanged, ${plan.conflicts} conflict${plan.conflicts === 1 ? "" : "s"}.`,
      );
      return;
    }
    const receipt = applySkillSet({ set_id: setId, project_root: projectRoot });
    printResult(
      receipt,
      values.json,
      receipt.status === "unchanged"
        ? `Skill Set "${receipt.set_name}" is already applied.`
        : `Applied Skill Set "${receipt.set_name}". Receipt: ${receipt.receipt_id}`,
    );
    return;
  }

  if (subcommand === "rollback") {
    const { values } = parseArgs({
      args,
      options: {
        receipt: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });
    if (values.help) {
      console.log(HELP);
      return;
    }
    const receiptId = requireString(values.receipt, "--receipt", "selftune sets rollback --help");
    const receipt = rollbackSkillSet(receiptId);
    printResult(
      receipt,
      values.json,
      `Rolled back Skill Set "${receipt.set_name}" from ${receipt.project_root}.`,
    );
    return;
  }

  throw new CLIError(
    `Unknown sets subcommand: ${subcommand}`,
    "UNKNOWN_COMMAND",
    "selftune sets --help",
  );
}

if (import.meta.main) {
  cliMain().catch(handleCLIError);
}
