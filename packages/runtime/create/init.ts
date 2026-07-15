import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { PUBLIC_COMMAND_SURFACES, renderCommandHelp } from "../command-surface.js";
import { CLIError, handleCLIError } from "../utils/cli-error.js";
import {
  buildCreateSkillDraft,
  formatCreateSkillDraft,
  slugifyCreateSkillName,
  type CreateSkillDraft,
} from "./templates.js";

export interface CreateSkillInitResult extends CreateSkillDraft {
  overwritten: boolean;
  written_paths: string[];
}

export function writeCreateSkillDraft(
  draft: CreateSkillDraft,
  options: { force?: boolean } = {},
): CreateSkillInitResult {
  const alreadyExists = existsSync(draft.skill_dir);
  if (alreadyExists && options.force !== true) {
    throw new CLIError(
      `Refusing to overwrite existing skill package at ${draft.skill_dir}.`,
      "FILE_EXISTS",
      "Re-run with --force to overwrite the scaffold files.",
    );
  }

  for (const directory of draft.directories) {
    mkdirSync(directory, { recursive: true });
  }

  for (const file of draft.files) {
    writeFileSync(file.absolute_path, file.content, "utf-8");
  }

  return {
    ...draft,
    overwritten: alreadyExists,
    written_paths: draft.files.map((file) => file.absolute_path),
  };
}

function formatInitResult(result: CreateSkillInitResult): string {
  return [
    formatCreateSkillDraft(result),
    "",
    `Initialized: ${result.skill_dir}`,
    result.overwritten ? "Mode: overwrite" : "Mode: new package",
    "Next step: replace the placeholders in SKILL.md and workflows/default.md before distribution.",
  ].join("\n");
}

export async function cliMain(): Promise<void> {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      description: { type: "string" },
      "output-dir": { type: "string" },
      force: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(renderCommandHelp(PUBLIC_COMMAND_SURFACES.createInit));
    process.exit(0);
  }

  if (!values.name?.trim()) {
    throw new CLIError(
      "--name <name> is required",
      "MISSING_FLAG",
      "selftune create init --name <name> --description <text>",
    );
  }

  if (!values.description?.trim()) {
    throw new CLIError(
      "--description <text> is required",
      "MISSING_FLAG",
      "selftune create init --name <name> --description <text>",
    );
  }

  if (!slugifyCreateSkillName(values.name)) {
    throw new CLIError(
      "--name must contain at least one letter or number",
      "INVALID_FLAG",
      "selftune create init --name <name> --description <text>",
    );
  }

  const draft = buildCreateSkillDraft({
    name: values.name,
    description: values.description,
    outputDir: values["output-dir"],
  });
  const result = writeCreateSkillDraft(draft, { force: values.force });

  if (values.json || !process.stdout.isTTY) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatInitResult(result));
}

if (import.meta.main) {
  cliMain().catch(handleCLIError);
}
