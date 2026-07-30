import { runAutoActivateHook } from "@selftune/harness-claude-code/hooks/auto-activate";
import { runCommitTrackHook } from "@selftune/harness-claude-code/hooks/commit-track";
import {
  CLAUDE_HOOK_NAMES,
  type ClaudeHookName,
} from "@selftune/harness-claude-code/hooks/daemon-forward";
import { runEvolutionGuardHook } from "@selftune/harness-claude-code/hooks/evolution-guard";
import {
  SILENT_HOOK_SUCCESS,
  type HookExecutionResult,
} from "@selftune/harness-claude-code/hooks/execution-result";
import { runPromptLogHook } from "@selftune/harness-claude-code/hooks/prompt-log";
import { runSessionStopHook } from "@selftune/harness-claude-code/hooks/session-stop";
import { runSkillChangeGuardHook } from "@selftune/harness-claude-code/hooks/skill-change-guard";
import { runSkillEditCaptureHook } from "@selftune/harness-claude-code/hooks/skill-edit-capture";
import { runSkillEvalHook } from "@selftune/harness-claude-code/hooks/skill-eval";

const MAX_HOOK_BODY_BYTES = 2 * 1024 * 1024;
const SHARED_SESSION_QUEUE = "__selftune_shared_session__";
const SYNCHRONOUS_HOOKS: ReadonlySet<ClaudeHookName> = new Set([
  "auto-activate",
  "skill-change-guard",
  "evolution-guard",
  "skill-edit-capture",
]);
const KNOWN_HOOKS: ReadonlySet<string> = new Set(CLAUDE_HOOK_NAMES);

export type HookRunner = (rawStdin: string) => Promise<HookExecutionResult>;
export type HookRunners = Readonly<Record<ClaudeHookName, HookRunner>>;

const DEFAULT_HOOK_RUNNERS: HookRunners = {
  "prompt-log": runPromptLogHook,
  "auto-activate": runAutoActivateHook,
  "skill-change-guard": runSkillChangeGuardHook,
  "evolution-guard": runEvolutionGuardHook,
  "skill-edit-capture": runSkillEditCaptureHook,
  "skill-eval": runSkillEvalHook,
  "commit-track": runCommitTrackHook,
  "session-stop": runSessionStopHook,
};

class BodyTooLargeError extends Error {}

async function readHookBody(request: Request): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_HOOK_BODY_BYTES) {
      throw new BodyTooLargeError();
    }
  }

  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let rawStdin = "";
  let receivedBytes = 0;
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- request streams must be consumed sequentially
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > MAX_HOOK_BODY_BYTES) {
      // oxlint-disable-next-line no-await-in-loop -- cancel the active reader before rejecting
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    rawStdin += decoder.decode(value, { stream: true });
  }
  return rawStdin + decoder.decode();
}

function sessionQueueKey(rawStdin: string): string {
  try {
    const payload: unknown = JSON.parse(rawStdin);
    if (
      typeof payload === "object" &&
      payload !== null &&
      "session_id" in payload &&
      typeof payload.session_id === "string" &&
      payload.session_id.length > 0
    ) {
      return `session:${payload.session_id}`;
    }
  } catch {
    // Malformed hook input remains fail-open and uses the shared serial queue.
  }
  return SHARED_SESSION_QUEUE;
}

class SessionHookQueue {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly logError: (message: string) => void) {}

  admit(sessionKey: string, hookName: ClaudeHookName, task: () => Promise<void>): void {
    const previous =
      this.chains.get(sessionKey) ??
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    const current = previous
      .catch(() => undefined)
      .then(task)
      .catch((error: unknown) => {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        this.logError(`SelfTune queued hook ${hookName} failed: ${message}\n`);
      })
      .finally(() => {
        if (this.chains.get(sessionKey) === current) this.chains.delete(sessionKey);
      });
    this.chains.set(sessionKey, current);
  }

  async waitForIdle(): Promise<void> {
    while (this.chains.size > 0) {
      // oxlint-disable-next-line no-await-in-loop -- new admissions can extend the queue while draining
      await Promise.all(this.chains.values());
    }
  }
}

export interface HookRouteOptions {
  readonly runners?: Partial<HookRunners>;
  readonly logError?: (message: string) => void;
}

export interface HookRoutes {
  readonly handle: (request: Request, url: URL) => Promise<Response | null>;
  readonly waitForIdle: () => Promise<void>;
}

export function createHookRoutes(options: HookRouteOptions = {}): HookRoutes {
  const runners: HookRunners = { ...DEFAULT_HOOK_RUNNERS, ...options.runners };
  const logError = options.logError ?? ((message: string) => process.stderr.write(message));
  const queue = new SessionHookQueue(logError);

  const handle = async (request: Request, url: URL): Promise<Response | null> => {
    const match = url.pathname.match(/^\/api\/hooks\/([^/]+)$/);
    if (!match || request.method !== "POST") return null;
    const hookName = match[1];
    if (!hookName || !KNOWN_HOOKS.has(hookName)) {
      return Response.json({ error: { code: "HOOK_NOT_FOUND" } }, { status: 404 });
    }

    let rawStdin: string;
    try {
      rawStdin = await readHookBody(request);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return Response.json({ error: { code: "HOOK_BODY_TOO_LARGE" } }, { status: 413 });
      }
      throw error;
    }

    const typedHookName = hookName as ClaudeHookName;
    const runner = runners[typedHookName];
    if (SYNCHRONOUS_HOOKS.has(typedHookName)) {
      try {
        return Response.json(await runner(rawStdin));
      } catch (error) {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        logError(`SelfTune synchronous hook ${typedHookName} failed: ${message}\n`);
        return Response.json(SILENT_HOOK_SUCCESS);
      }
    }

    queue.admit(sessionQueueKey(rawStdin), typedHookName, async () => {
      const result = await runner(rawStdin);
      if (result.stderr) logError(result.stderr);
      if (result.exit_code !== 0) {
        logError(`SelfTune queued hook ${typedHookName} returned exit code ${result.exit_code}.\n`);
      }
    });
    return Response.json({ accepted: true }, { status: 202 });
  };

  return { handle, waitForIdle: () => queue.waitForIdle() };
}
