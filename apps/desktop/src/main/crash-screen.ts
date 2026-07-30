import { SELFTUNE_LOGO_SVG, SELFTUNE_THEME } from "./brand";

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
    <title>SelfTune Recovery</title>
    <style>
      :root { color-scheme: light; --bg: ${SELFTUNE_THEME.background}; --panel: ${SELFTUNE_THEME.popover}; --panel-2: ${SELFTUNE_THEME.card}; --line: color-mix(in srgb, ${SELFTUNE_THEME.border} 45%, transparent); --line-strong: ${SELFTUNE_THEME.border}; --text: ${SELFTUNE_THEME.foreground}; --muted: ${SELFTUNE_THEME.mutedForeground}; --primary: ${SELFTUNE_THEME.primary}; --primary-hover: color-mix(in srgb, ${SELFTUNE_THEME.primary} 88%, white); --primary-text: ${SELFTUNE_THEME.primaryForeground}; --danger: ${SELFTUNE_THEME.destructive}; }
      * { box-sizing: border-box; }
      html, body { height: 100%; }
      body { margin: 0; display: grid; place-items: center; padding: 40px 32px; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; -webkit-app-region: drag; user-select: none; }
      main { width: min(560px, 100%); background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 32px; box-shadow: 0 24px 64px rgba(23, 24, 22, 0.1), 0 2px 8px rgba(23, 24, 22, 0.06); -webkit-app-region: no-drag; animation: rise 280ms cubic-bezier(0.23, 1, 0.32, 1) both; }
      @keyframes rise { from { opacity: 0; transform: translateY(8px) scale(0.99); } }
      .mark { width: 40px; height: 40px; color: var(--primary); filter: drop-shadow(0 4px 14px rgba(23, 24, 22, 0.14)); }
      .mark svg { display: block; width: 100%; height: 100%; }
      h1 { margin: 16px 0 8px; font-size: 19px; font-weight: 650; letter-spacing: -0.01em; line-height: 1.3; }
      p.lede { margin: 0; color: var(--muted); font-size: 13.5px; line-height: 1.6; }
      details { margin-top: 18px; color: var(--muted); font-size: 12px; }
      summary { cursor: pointer; padding: 4px 0; border-radius: 4px; outline: none; }
      summary:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
      pre { margin: 10px 0 0; max-height: 180px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 12px; font: 11.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; user-select: text; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 24px; }
      button { appearance: none; min-height: 34px; border-radius: 8px; border: 1px solid var(--line); padding: 0 14px; background: var(--panel-2); color: var(--text); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; transition: transform 120ms ease-out, background-color 150ms ease, border-color 150ms ease, opacity 150ms ease; }
      button:hover { border-color: var(--line-strong); }
      button:active { transform: scale(0.98); }
      button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
      button.primary { background: var(--primary); border-color: transparent; color: var(--primary-text); font-weight: 650; }
      button.primary:hover { background: var(--primary-hover); }
      button.danger { color: var(--danger); }
      button.danger:hover { background: color-mix(in srgb, var(--danger) 10%, transparent); border-color: color-mix(in srgb, var(--danger) 35%, transparent); }
      button:disabled { opacity: 0.55; cursor: default; transform: none; }
      #status { display: flex; align-items: center; gap: 8px; min-height: 20px; margin: 18px 0 0; font-size: 12px; color: var(--muted); }
      .spinner { display: inline-block; width: 12px; height: 12px; flex: none; border-radius: 50%; border: 2px solid var(--line-strong); border-top-color: var(--primary); animation: spin 700ms linear infinite; }
      .spinner[hidden] { display: none; }
      @keyframes spin { to { transform: rotate(1turn); } }
      @media (prefers-reduced-motion: reduce) { main { animation: none; } .spinner { animation-duration: 1.4s; } }
    </style>
  </head>
  <body>
    <main>
      <div class="mark">${SELFTUNE_LOGO_SVG}</div>
      <h1>The local SelfTune service is unavailable</h1>
      <p class="lede">Your skills and history remain on this Mac. Restart the service first; reset is only for a damaged local database and always creates a backup.</p>
      <details><summary>Technical detail</summary><pre id="detail"></pre></details>
      <div class="actions">
        <button class="primary" id="restart">Restart Service</button>
        <button id="update">Check for Updates</button>
        <button id="diagnostics">Export Diagnostics</button>
        <button class="danger" id="reset">Reset Local Data</button>
      </div>
      <p id="status"><span class="spinner" id="spin" hidden></span><span id="status-text">${options.reported ? "Automatic error reporting is enabled. Diagnostic exports stay on this Mac until you choose to share them." : "Automatic error reporting is off. Diagnostic exports stay on this Mac until you choose to share them."}</span></p>
    </main>
    <script>
      document.getElementById("detail").textContent = ${detail};
      const spin = document.getElementById("spin");
      const statusText = document.getElementById("status-text");
      const buttons = Array.from(document.querySelectorAll("button"));
      const run = async (label, action) => {
        buttons.forEach((button) => { button.disabled = true; });
        spin.hidden = false;
        statusText.textContent = label;
        try { await action(); }
        catch (error) { statusText.textContent = error instanceof Error ? error.message : "The recovery action failed."; }
        finally {
          spin.hidden = true;
          buttons.forEach((button) => { button.disabled = false; });
        }
      };
      document.getElementById("restart").addEventListener("click", () => run("Restarting local service...", () => window.selftuneDesktop.restartService()));
      document.getElementById("update").addEventListener("click", () => run("Checking for updates...", () => window.selftuneDesktop.checkForUpdates()));
      document.getElementById("diagnostics").addEventListener("click", () => run("Exporting diagnostics...", () => window.selftuneDesktop.exportDiagnostics()));
      document.getElementById("reset").addEventListener("click", () => run("Backing up and resetting local state...", () => window.selftuneDesktop.resetLocalState()));
    </script>
  </body>
</html>`;
}
