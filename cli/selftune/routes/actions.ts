/**
 * Route handler: POST /api/actions/{watch,evolve,rollback}
 *
 * Triggers selftune CLI commands as child processes and returns the result.
 */

import { join } from "node:path";

export type ActionRunner = (
  command: string,
  args: string[],
) => Promise<{ success: boolean; output: string; error: string | null }>;

export async function runAction(
  command: string,
  args: string[],
): Promise<{ success: boolean; output: string; error: string | null }> {
  try {
    const indexPath = join(import.meta.dir, "..", "index.ts");
    const proc = Bun.spawn(["bun", "run", indexPath, command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return { success: false, output: stdout, error: stderr || `Exit code ${exitCode}` };
    }
    return { success: true, output: stdout, error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, output: "", error: message };
  }
}

export async function handleAction(
  action: string,
  body: Record<string, unknown>,
  executeAction: ActionRunner = runAction,
): Promise<Response> {
  if (action === "watch" || action === "evolve") {
    const skill = body.skill as string | undefined;
    const skillPath = body.skillPath as string | undefined;
    if (!skill || !skillPath) {
      return Response.json(
        { success: false, error: "Missing required fields: skill, skillPath" },
        { status: 400 },
      );
    }
    const args = ["--skill", skill, "--skill-path", skillPath, "--sync-first"];
    const result = await executeAction(action, args);
    return Response.json(result);
  }

  if (action === "rollback") {
    const skill = body.skill as string | undefined;
    const skillPath = body.skillPath as string | undefined;
    const proposalId = body.proposalId as string | undefined;
    if (!skill || !skillPath || !proposalId) {
      return Response.json(
        { success: false, error: "Missing required fields: skill, skillPath, proposalId" },
        { status: 400 },
      );
    }
    const args = ["--skill", skill, "--skill-path", skillPath, "--proposal-id", proposalId];
    const result = await executeAction(action, args);
    return Response.json(result);
  }

  return Response.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
}
