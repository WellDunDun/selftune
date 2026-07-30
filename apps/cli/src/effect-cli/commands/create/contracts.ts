import type * as Effect from "effect/Effect";

import type { CLIError } from "@selftune/runtime/utils/cli-error";

export interface CreateInitInput {
  readonly name?: string;
  readonly description?: string;
  readonly outputDir?: string;
  readonly force: boolean;
  readonly json: boolean;
}

export interface CreateStatusInput {
  readonly skillPath?: string;
  readonly json: boolean;
}

export interface CreateScaffoldInput {
  readonly fromWorkflow?: string;
  readonly outputDir?: string;
  readonly skillName?: string;
  readonly description?: string;
  readonly write: boolean;
  readonly force: boolean;
  readonly json: boolean;
  readonly minOccurrences?: string;
  readonly skill?: string;
}

export interface CreateEvaluationInput {
  readonly skillPath?: string;
  readonly mode: string;
  readonly agent?: string;
  readonly evalSetPath?: string;
  readonly json: boolean;
}

export interface CreateReportInput {
  readonly skillPath?: string;
  readonly agent?: string;
  readonly evalSetPath?: string;
  readonly json: boolean;
}

export interface CreatePublishInput {
  readonly skillPath?: string;
  readonly watch: boolean;
  readonly ignoreWatchAlerts: boolean;
  readonly json: boolean;
}

export interface CreateCommandActions {
  readonly init: (input: CreateInitInput) => Effect.Effect<void, CLIError>;
  readonly status: (input: CreateStatusInput) => Effect.Effect<void, CLIError>;
  readonly scaffold: (input: CreateScaffoldInput) => Effect.Effect<void, CLIError>;
  readonly check: (input: CreateStatusInput) => Effect.Effect<void, CLIError>;
  readonly replay: (input: CreateEvaluationInput) => Effect.Effect<void, CLIError>;
  readonly baseline: (input: CreateEvaluationInput) => Effect.Effect<void, CLIError>;
  readonly report: (input: CreateReportInput) => Effect.Effect<void, CLIError>;
  readonly publish: (input: CreatePublishInput) => Effect.Effect<void, CLIError>;
}
