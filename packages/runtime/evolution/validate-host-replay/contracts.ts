import type { DashboardActionMetrics } from "../../dashboard-contract.js";
import type { RoutingReplayFixture } from "../../types.js";

export interface ReplayWorkspace {
  rootDir: string;
  skillRegistryDir: string;
  targetSkillPath: string;
  competingSkillPaths: string[];
  allowedReadRoots: string[];
}

export type RuntimeReplayContentTarget = "routing" | "description" | "body";

export type RuntimeReplayReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface RuntimeReplayInvokerInput {
  query: string;
  platform: RoutingReplayFixture["platform"];
  workspaceRoot: string;
  skillRegistryDir: string;
  targetSkillName: string;
  targetSkillPath: string;
  competingSkillPaths: string[];
  model?: string;
  reasoningEffort?: RuntimeReplayReasoningEffort;
}

export interface RuntimeReplayObservation {
  triggeredSkillNames: string[];
  readSkillPaths: string[];
  rawOutput: string;
  sessionId?: string;
  runtimeError?: string;
  metrics?: DashboardActionMetrics;
}

export type RuntimeReplayInvoker = (
  input: RuntimeReplayInvokerInput,
) => Promise<RuntimeReplayObservation>;
