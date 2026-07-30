#!/usr/bin/env bun

import { parseArgs } from "node:util";

import { handleCLIError } from "../utils/cli-error.js";
import { CONTRIBUTE_HELP } from "./help.js";
import {
  formatContributeResult,
  runContribute,
  type FormattedContributeResult,
  type RunContributeOptions,
} from "./program.js";

export {
  formatContributeResult,
  runContribute,
  submitContributionToGitHub,
  submitContributionToService,
  type ContributeProgramDependencies,
  type ContributeResult,
  type ContributionSubmissionAttempt,
  type FormattedContributeResult,
  type RunContributeOptions,
} from "./program.js";

export { CONTRIBUTE_HELP } from "./help.js";

function printFormattedResult(result: FormattedContributeResult): void {
  for (const line of result.stdout) process.stdout.write(`${line}\n`);
  for (const line of result.stderr) process.stderr.write(`${line}\n`);
}

export async function cliMain(): Promise<void> {
  const { values } = parseArgs({
    options: {
      skill: { type: "string", default: "selftune" },
      output: { type: "string" },
      preview: { type: "boolean", default: false },
      sanitize: { type: "string", default: "conservative" },
      since: { type: "string" },
      submit: { type: "boolean", default: false },
      endpoint: { type: "string" },
      github: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(`${CONTRIBUTE_HELP}\n`);
    return;
  }

  const options: RunContributeOptions = {
    skillName: values.skill,
    outputPath: values.output,
    preview: values.preview,
    sanitizationLevel: values.sanitize,
    since: values.since,
    submit: values.submit,
    endpoint: values.endpoint,
    github: values.github,
  };
  const result = await runContribute(options);
  printFormattedResult(formatContributeResult(result));
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

if (import.meta.main) {
  cliMain().catch(handleCLIError);
}
