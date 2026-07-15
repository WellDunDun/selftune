export interface CrashScreenOptions {
  readonly detail: string;
  readonly reported: boolean;
}

function escapedJson(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function runtimeCrashHtml(options: CrashScreenOptions): string {
  const detail = escapedJson(options.detail);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SelfTune recovery</title>
    <style>
      :root { color-scheme: dark; --bg: #101214; --panel: #171a1e; --line: #30343a; --text: #f4f5f6; --muted: #a8adb5; --accent: #57b88a; --danger: #ee8178; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { width: min(520px, 100%); border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 28px; }
      .mark { width: 38px; height: 38px; display: grid; place-items: center; border: 1px solid var(--line); border-radius: 7px; font-weight: 700; color: var(--accent); }
      h1 { margin: 20px 0 8px; font-size: 20px; line-height: 1.25; letter-spacing: 0; }
      p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.55; }
      details { margin-top: 18px; color: var(--muted); font-size: 12px; }
      pre { white-space: pre-wrap; overflow-wrap: anywhere; border-left: 2px solid var(--line); padding-left: 12px; line-height: 1.5; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 24px; }
      button { min-height: 36px; border-radius: 6px; border: 1px solid var(--line); padding: 0 13px; background: transparent; color: var(--text); font: inherit; font-size: 13px; cursor: pointer; }
      button.primary { border-color: var(--accent); background: var(--accent); color: #0b1711; font-weight: 650; }
      button.danger { color: var(--danger); }
      button:disabled { opacity: 0.5; cursor: default; }
      #status { min-height: 22px; margin-top: 16px; font-size: 12px; }
    </style>
  </head>
  <body>
    <main>
      <div class="mark">ST</div>
      <h1>The local SelfTune service is unavailable</h1>
      <p>Your skills and history remain on this Mac. Restart the service first; reset is only for a damaged local database and always creates a backup.</p>
      <details><summary>Technical detail</summary><pre id="detail"></pre></details>
      <div class="actions">
        <button class="primary" id="restart">Restart Service</button>
        <button id="update">Check for Updates</button>
        <button id="diagnostics">Export Diagnostics</button>
        <button class="danger" id="reset">Reset Local Data</button>
      </div>
      <p id="status">${options.reported ? "Automatic error reporting is enabled. Diagnostic exports stay on this Mac until you choose to share them." : "Automatic error reporting is off. Diagnostic exports stay on this Mac until you choose to share them."}</p>
    </main>
    <script>
      document.getElementById("detail").textContent = ${detail};
      const status = document.getElementById("status");
      const buttons = Array.from(document.querySelectorAll("button"));
      const run = async (label, action) => {
        buttons.forEach((button) => { button.disabled = true; });
        status.textContent = label;
        try { await action(); }
        catch (error) { status.textContent = error instanceof Error ? error.message : "The recovery action failed."; }
        finally { buttons.forEach((button) => { button.disabled = false; }); }
      };
      document.getElementById("restart").addEventListener("click", () => run("Restarting local service...", () => window.selftuneDesktop.restartService()));
      document.getElementById("update").addEventListener("click", () => run("Checking for updates...", () => window.selftuneDesktop.checkForUpdates()));
      document.getElementById("diagnostics").addEventListener("click", () => run("Exporting diagnostics...", () => window.selftuneDesktop.exportDiagnostics()));
      document.getElementById("reset").addEventListener("click", () => run("Backing up and resetting local state...", () => window.selftuneDesktop.resetLocalState()));
    </script>
  </body>
</html>`;
}
