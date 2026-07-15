import { execFileSync } from "node:child_process";

export function resolveLoginShellPath(): string {
  const fallback = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  if (process.platform === "win32") return fallback;
  const shell = process.env.SHELL ?? "/bin/zsh";
  try {
    const value = execFileSync(shell, ["-lc", 'printf %s "$PATH"'], {
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}
