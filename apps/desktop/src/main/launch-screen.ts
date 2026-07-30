import { SELFTUNE_LOGO_SVG, SELFTUNE_THEME } from "./brand";

export function runtimeLaunchHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SelfTune</title>
    <style>
      :root { color-scheme: light; --bg: ${SELFTUNE_THEME.background}; --line: ${SELFTUNE_THEME.border}; --text: ${SELFTUNE_THEME.foreground}; --muted: ${SELFTUNE_THEME.mutedForeground}; --primary: ${SELFTUNE_THEME.primary}; }
      * { box-sizing: border-box; }
      html, body { height: 100%; }
      body { margin: 0; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; -webkit-app-region: drag; user-select: none; }
      .stage { display: flex; flex-direction: column; align-items: center; animation: rise 320ms cubic-bezier(0.23, 1, 0.32, 1) both; }
      @keyframes rise { from { opacity: 0; transform: translateY(6px); } }
      .mark { width: 64px; height: 64px; color: var(--primary); filter: drop-shadow(0 8px 24px rgba(23, 24, 22, 0.16)); }
      .mark svg { display: block; width: 100%; height: 100%; }
      h1 { margin: 18px 0 0; font-size: 22px; font-weight: 700; letter-spacing: -0.02em; color: var(--primary); }
      p { margin: 8px 0 0; color: var(--muted); font-size: 13px; }
      .bar { position: relative; width: 180px; height: 3px; margin-top: 26px; overflow: hidden; border-radius: 999px; background: color-mix(in srgb, var(--line) 45%, transparent); }
      .bar::after { content: ""; position: absolute; top: 0; left: 0; width: 40%; height: 100%; border-radius: inherit; background: var(--primary); transform: translateX(-100%); animation: slide 1150ms cubic-bezier(0.65, 0, 0.35, 1) infinite; }
      @keyframes slide { to { transform: translateX(250%); } }
      @media (prefers-reduced-motion: reduce) { .stage { animation: none; } .bar::after { animation-duration: 2.4s; } }
    </style>
  </head>
  <body>
    <div class="stage">
      <div class="mark">${SELFTUNE_LOGO_SVG}</div>
      <h1>selftune</h1>
      <p>Starting the local service...</p>
      <div class="bar" role="progressbar" aria-label="Starting the local SelfTune service"></div>
    </div>
  </body>
</html>`;
}
