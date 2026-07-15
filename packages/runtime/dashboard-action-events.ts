import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { DASHBOARD_ACTION_STREAM_LOG } from "./constants.js";
import type {
  DashboardActionEvent,
  DashboardActionMetrics,
  DashboardActionName,
  DashboardActionProgress,
} from "./dashboard-contract.js";

const ACTION_EVENT_ID_ENV = "SELFTUNE_DASHBOARD_ACTION_EVENT_ID";
const ACTION_NAME_ENV = "SELFTUNE_DASHBOARD_ACTION_NAME";
const ACTION_SKILL_NAME_ENV = "SELFTUNE_DASHBOARD_ACTION_SKILL_NAME";
const ACTION_SKILL_PATH_ENV = "SELFTUNE_DASHBOARD_ACTION_SKILL_PATH";

export interface DashboardActionContext {
  eventId: string;
  action: DashboardActionName;
  skillName: string | null;
  skillPath: string | null;
}

let currentContext: DashboardActionContext | null = null;

function appendDashboardActionEvent(event: DashboardActionEvent): void {
  try {
    const path = process.env.SELFTUNE_DASHBOARD_ACTION_STREAM_LOG || DASHBOARD_ACTION_STREAM_LOG;
    const parent = dirname(path);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    appendFileSync(path, `${JSON.stringify(event)}\n`, "utf-8");
  } catch {
    // fail-open: dashboard instrumentation must never block the real CLI
  }
}

function isDashboardActionName(value: string | undefined): value is DashboardActionName {
  return (
    value === "create-check" ||
    value === "report-package" ||
    value === "generate-evals" ||
    value === "generate-unit-tests" ||
    value === "replay-dry-run" ||
    value === "measure-baseline" ||
    value === "deploy-candidate" ||
    value === "watch" ||
    value === "orchestrate" ||
    value === "rollback" ||
    value === "search-run"
  );
}

function readContextFromEnv(): DashboardActionContext | null {
  const eventId = process.env[ACTION_EVENT_ID_ENV];
  const action = process.env[ACTION_NAME_ENV];
  if (!eventId || !action || !isDashboardActionName(action)) return null;

  return {
    eventId,
    action,
    skillName: process.env[ACTION_SKILL_NAME_ENV] ?? null,
    skillPath: process.env[ACTION_SKILL_PATH_ENV] ?? null,
  };
}

export function setCurrentDashboardActionContext(context: DashboardActionContext | null): void {
  currentContext = context;
}

export function getCurrentDashboardActionContext(): DashboardActionContext | null {
  return currentContext ?? readContextFromEnv();
}

export function dashboardActionContextEnv(
  context: DashboardActionContext | null,
): Record<string, string> {
  if (!context) return {};

  const env: Record<string, string> = {
    [ACTION_EVENT_ID_ENV]: context.eventId,
    [ACTION_NAME_ENV]: context.action,
  };
  if (context.skillName) env[ACTION_SKILL_NAME_ENV] = context.skillName;
  if (context.skillPath) env[ACTION_SKILL_PATH_ENV] = context.skillPath;
  return env;
}

export function emitDashboardActionMetrics(metrics: DashboardActionMetrics): void {
  const context = getCurrentDashboardActionContext();
  if (!context) return;

  appendDashboardActionEvent({
    event_id: context.eventId,
    action: context.action,
    stage: "metrics",
    skill_name: context.skillName,
    skill_path: context.skillPath,
    ts: Date.now(),
    metrics,
  });
}

export function emitDashboardActionProgress(progress: DashboardActionProgress): void {
  const context = getCurrentDashboardActionContext();
  if (!context) return;

  appendDashboardActionEvent({
    event_id: context.eventId,
    action: context.action,
    stage: "progress",
    skill_name: context.skillName,
    skill_path: context.skillPath,
    ts: Date.now(),
    progress,
  });
}

export { appendDashboardActionEvent };
