/**
 * SVG renderer and format router for selftune skill health badges.
 *
 * Generates shields.io flat-style SVG badges using template literals.
 * Uses a per-character width table for Verdana 11px text width estimation.
 * Zero external dependencies, pure functions only.
 */

import type { BadgeData, BadgeFormat } from "./badge-data.js";

// ---------------------------------------------------------------------------
// Character width table (Verdana 11px)
// ---------------------------------------------------------------------------

const CHAR_WIDTHS: Record<string, number> = {
  " ": 3.3,
  "!": 3.3,
  "%": 7.3,
  "(": 3.6,
  ")": 3.6,
  "+": 7.3,
  "-": 3.9,
  ".": 3.3,
  "/": 3.6,
  "0": 6.6,
  "1": 6.6,
  "2": 6.6,
  "3": 6.6,
  "4": 6.6,
  "5": 6.6,
  "6": 6.6,
  "7": 6.6,
  "8": 6.6,
  "9": 6.6,
  ":": 3.3,
  A: 7.5,
  B: 7.5,
  C: 7.2,
  D: 7.8,
  E: 6.8,
  F: 6.3,
  G: 7.8,
  H: 7.8,
  I: 3.0,
  J: 5.0,
  K: 7.2,
  L: 6.2,
  M: 8.9,
  N: 7.8,
  O: 7.8,
  P: 6.6,
  Q: 7.8,
  R: 7.2,
  S: 7.2,
  T: 6.5,
  U: 7.8,
  V: 7.2,
  W: 10.0,
  X: 6.8,
  Y: 6.5,
  Z: 6.8,
  a: 6.2,
  b: 6.6,
  c: 5.6,
  d: 6.6,
  e: 6.2,
  f: 3.6,
  g: 6.6,
  h: 6.6,
  i: 2.8,
  j: 2.8,
  k: 6.2,
  l: 2.8,
  m: 10.0,
  n: 6.6,
  o: 6.6,
  p: 6.6,
  q: 6.6,
  r: 3.9,
  s: 5.6,
  t: 3.6,
  u: 6.6,
  v: 6.2,
  w: 8.9,
  x: 5.9,
  y: 5.9,
  z: 5.6,
  "\u2191": 6.6,
  "\u2193": 6.6,
  "\u2192": 6.6,
};

const DEFAULT_CHAR_WIDTH = 6.8;

// ---------------------------------------------------------------------------
// Logo constants
// ---------------------------------------------------------------------------

const LOGO_SIZE = 14;
const LOGO_PAD = 3; // gap between logo and text
const LOGO_EXTRA = LOGO_SIZE + LOGO_PAD; // 17px added to label section

const LOGO_SVG_BASE64 =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTAiIGhlaWdodD0iMjUwIiB2aWV3Qm94PSIwIDAgMjUwIDI1MCIgZmlsbD0ibm9uZSI+CjxwYXRoIGQ9Ik0gMTkwLjE2LDMxLjQ5IEMgMTg3LjkxLDI5Ljg4IDE4NC41MSwzMi4xOSAxODUuODgsMzUuMTYgQyAxODYuMzEsMzYuMTEgMTg3LjA4LDM2LjU0IDE4Ny43MSwzNy4wMSBDIDIxOC43NSw1OS44NiAyMzcuNjMsOTIuNzEgMjM3LjYzLDEyOC44MiBDIDIzNy42MywxNzUuOTkgMjA1LjEyLDIxOC41NiAxNTMuODIsMjM0LjY5IEMgMTQ5Ljg5LDIzNS45MyAxNTAuOTEsMjQxLjcxIDE1NC45MSwyNDAuNjYgQyAyMDUuOTgsMjI2Ljk2IDI0My4wMSwxODEuOTQgMjQzLDEyOC40NSBDIDI0Mi45OSw5MC44NyAyMjMuNDcsNTYuMTggMTkwLjE2LDMxLjQ5IFoiIGZpbGw9IiNmZmYiLz4KPHBhdGggZD0iTSAxMjUuMTksMjQzLjkxIEMgMTM4LjA4LDI0My45MSAxNDcuMTgsMjM2LjQ0IDE1MS4yMSwyMjUuMDEgQyAxOTMuNzIsMjE3Ljc5IDIyNi45OCwxODQuMDIgMjI2Ljk4LDE0MC44MSBDIDIyNi45OCwxMjEuMTcgMjE5LjgyLDEwMy43OCAyMDkuOTMsODcuMDQgQyAxOTEuNDIsNTUuNDUgMTY1LjE1LDM0LjcyIDExNy43MSwyOC42NSBDIDExMi45MSwyOC4wNCAxMTMuNzcsMzQuMzUgMTE3LjE5LDM0LjgyIEMgMTYxLjY3LDM5LjMzIDE4NS44NCw1Ni43MSAyMDMuNzYsODYuNDIgQyAyMTMuODcsMTAzLjY4IDIyMC42OCwxMTkuNjEgMjIwLjY4LDE0MC44MSBDIDIyMC42OCwxNzkuOTYgMTkwLjgxLDIxMS45NSAxNDguNzEsMjE5LjE2IEMgMTQ3LjExLDIxOS40NyAxNDYuMjcsMjIwLjMyIDE0NS45MiwyMjEuOCBDIDE0Mi45NSwyMzEuMTEgMTM1LjcyLDIzOC4wMiAxMjUuMTksMjM3LjY2IEMgNjQuNDgsMjM3LjY2IDExLjY3LDE5MS42MSAxMS42NywxMjcuNTEgQyAxMS42Nyw3OS42MSA0NC44MiwzNi4zOCA5My44OSwyNy43NyBMIDk0LjExLDI3LjczIEwgOTQuMzgsMjYuNjQgQyA5Ny4wNCwxNi42MSAxMDQuNTcsMTEuODIgMTE0LjE5LDExLjgyIEMgMTM0LjEyLDEzLjM2IDE1Mi45MSwxOC4xNSAxNzAuNDgsMjYuMDggQyAxNzEuOTIsMjYuNzggMTczLjgxLDI3LjA5IDE3NC43NiwyNS41OSBDIDE3Ni4wNSwyMy43MiAxNzUuMzEsMjEuMDcgMTczLjAxLDIwLjM0IEMgMTU0Ljc4LDExLjk2IDEzNy4yMSw3LjE3IDExNC40Nyw2IEggMTEzLjUyIEMgMTAxLjkxLDYgOTMuNDYsMTIuMTYgODkuNDksMjEuNzggQyA0Mi4zNiwzMS4yNiA2LjE3LDc0Ljc2IDYuMTcsMTI4LjA4IEMgNi4xNywxOTAuMDUgNTcuOTIsMjQzLjkxIDEyNS4xOSwyNDMuOTEgWiIgZmlsbD0iI2ZmZiIvPgo8cGF0aCBkPSJNIDkzLjY3LDQwLjY0IEMgMTAwLjUxLDUyLjA3IDEwOS41NCw1MS4zMyAxMTQuMDUsNTIuMTcgQyAxMjguNzIsNTMuOTEgMTQxLjQ4LDU1Ljc4IDE1Ny4zOCw2Mi4xNiBDIDE2Mi43Miw2NC40NyAxNjIuMjksNTguMTkgMTU5LjE4LDU3LjAxIEMgMTQ1LjExLDUxLjMzIDEzMi40OCw0OS43OSAxMTEuMzEsNDcuNDggQyAxMDEuODMsNDYuMjkgOTUuNDUsNDEuMTggOTMuNzUsMzIuODEgQyA1NS4yMSwzOS40NiAyMi4wNiw3Mi4xNyAyMi4wNiwxMTIuNDggQyAyMi4wNiwxMzEuOTggMzAuMzYsMTQ5LjgyIDQzLjI2LDE2NC40OSBDIDQ2LjIzLDE2Ny41OSA1MC4xOSwxNjQuMTMgNDguMzIsMTYxLjAyIEMgMzYuMjEsMTQ1LjU0IDI4LjQyLDEyOS43OCAyOC40MiwxMTIuNCBDIDI4LjQyLDc5LjExIDU0LjkxLDQ4LjM2IDg5LjkxLDQwLjM2IEMgOTAuNzYsNDAuMTUgOTEuMDQsMzkuODcgOTEuNjIsNDAuMDEgQyA5Mi42Miw0MC4wMSA5My4wNCwzOS42NSA5My42Nyw0MC42NCBaIiBmaWxsPSIjZmZmIi8+CjxwYXRoIGQ9Ik0gMTUyLjcyLDgyLjc3IEMgMTI2LjYxLDgyLjc3IDExMy4wNyw5OS40NCAxMDMuMDEsMTE5LjMzIEMgMTAwLjU2LDEyMy4zNiAxMDMuNzQsMTI1LjAzIDEwNS42MSwxMjMuOTIgQyAxMDcuMTUsMTIzLjIyIDEwNy44OSwxMjEuMDUgMTA4LjczLDExOS42MSBDIDExOC4yMiwxMDIuMTYgMTMwLjMzLDg4LjU2IDE1Mi43Miw4OC41NiBDIDE4MS42Miw4OC41NiAyMDEuOTEsMTE2LjAxIDIwMS45MSwxNDcuMzEgQyAyMDEuOTEsMTc1LjEyIDE4My40NywxOTkuOTYgMTUyLjUxLDIwNS43NSBDIDE1MS44NCwyMDUuOTYgMTUxLjYzLDIwNi4wMyAxNTEuNTYsMjA1LjU0IEMgMTQ3Ljc0LDE5NS4zNyAxMzkuMzYsMTg4LjE1IDEyOC4wNywxODYuNDggQyAxMTMuMiwxODQuMjQgMTAxLjIzLDE4Mi4zNiA4My44LDE3Ni44MSBDIDc5LjMsMTc1LjQ4IDc3LjkxLDE4Mi4zNiA4Mi40MSwxODMuMDkgQyA5Ny4yMSwxODcuNDYgMTA4LjA5LDE4OS40NyAxMjYuMjUsMTkyLjY1IEMgMTM2Ljc4LDE5NC4zMSAxNDUuNDEsMjAxLjcxIDE0Ny4xMSwyMTAuOTUgQyAxNDcuNzQsMjEzLjA1IDE0OS4xMywyMTMuNDEgMTUwLjE1LDIxMy4yNiBDIDE4My43NSwyMDguNjEgMjA4LjI2LDE4MC45MyAyMDguMjYsMTQ3LjI0IEMgMjA4LjI2LDExNS4wNiAxODYuOTQsODIuNzcgMTUyLjcyLDgyLjc3IFoiIGZpbGw9IiNmZmYiLz4KPHBhdGggZD0iTSAxMjkuNzcsMTA1LjIxIEMgMTIyLjkzLDExMi4wNSAxMTguOTcsMTIyLjczIDExMy43NywxMzAuNDEgQyAxMTEuMzEsMTMzLjQ1IDExNC41NiwxMzYuNjMgMTE3LjQ2LDEzNC40NiBDIDEyMy43NSwxMjYuMjMgMTI3LjQzLDExNS42MiAxMzUuMTUsMTA4LjcxIEMgMTM4LjIyLDEwNS44MSAxMzQuNzMsMTAxLjA5IDEyOS43NywxMDUuMjEgWiIgZmlsbD0iI2ZmZiIvPgo8cGF0aCBkPSJNIDEzNi43OCwxMjAuMzEgQyAxMjcuNzEsMTM2LjcxIDEyMC4xMiwxNTQuOTEgOTMuNzQsMTU0LjkxIEMgNjYuMDcsMTU0LjkxIDQ3Ljc2LDEyOC41MyA0Ny43NiwxMDQuNzggQyA0Ny43Niw4NC40NyA1OC41Nyw2Ni4wOCA3Ny42Niw1Ni4yNSBDIDgyLjIzLDU0LjIxIDc5Ljg1LDQ3Ljc2IDc1LjM0LDQ5LjkzIEMgNTQuNzcsNTkuNzIgNDIuMDEsODAuMTEgNDIuMDEsMTA0LjcxIEMgNDIuMDEsMTMxLjc3IDYxLjg2LDE2MS4zMSA5My42NywxNjEuMzEgQyAxMTQuNzcsMTYxLjMxIDEyOC45MSwxNDcuMjQgMTM5Ljg2LDEyNC4wNiBDIDE0Mi43NiwxMjAuNDUgMTM5LjE1LDExNy43MyAxMzYuNzgsMTIwLjMxIFoiIGZpbGw9IiNmZmYiLz4KPHBhdGggZD0iTSAzMC43MywxNTQuNyBDIDI3Ljc2LDE1Mi45NyAyMy44NywxNTUuOTMgMjUuNDEsMTU4Ljc2IEMgNDEuNzMsMTg4LjM2IDY4Ljk0LDE5OS43OSAxMDUuNzUsMjA2LjQxIEMgMTEyLjI1LDIwNy42NiAxMjIuMDcsMjA4Ljc1IDEyMy40NiwyMDkuMDMgQyAxMjguMDcsMjA5Ljk1IDEyOC4wNywyMjAuMTggMTIxLjc4LDIyMC4xOCBDIDEwNy42NCwyMTguOTQgOTIuMDYsMjE1Ljk4IDc2LjIzLDIxMS4zMyBDIDcyLjEzLDIxMC4yNCA3MS4wNCwyMTYuNjkgNzUuMjcsMjE3LjY0IEMgOTAuNDEsMjIyLjIyIDEwMy45NSwyMjQuNzQgMTIwLjQ3LDIyNi41NCBDIDEzMy43MywyMjYuNTQgMTM2LjU2LDIwOS4wMyAxMjYuMDMsMjAzLjM4IEMgMTIzLjc1LDIwMi4xMyAxMjIuNzMsMjAyLjU2IDExMi4wNCwyMDAuNzYgQyA3OC4wOSwxOTUuMDQgNTQuMDYsMTg4Ljk4IDMyLjEyLDE1NS42NSBDIDMxLjc3LDE1NS4yMyAzMS4yOCwxNTQuOTEgMzAuNzMsMTU0LjcgWiIgZmlsbD0iI2ZmZiIvPgo8L3N2Zz4=";

// ---------------------------------------------------------------------------
// Text width estimation
// ---------------------------------------------------------------------------

function measureText(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += CHAR_WIDTHS[ch] ?? DEFAULT_CHAR_WIDTH;
  }
  return width;
}

// ---------------------------------------------------------------------------
// SVG escaping
// ---------------------------------------------------------------------------

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// renderBadgeSvg
// ---------------------------------------------------------------------------

/**
 * Render a shields.io flat-style SVG badge from BadgeData.
 *
 * Layout: [label (gray #555)] [value (colored)]
 * Each half has 10px padding on each side, 1px gap between halves.
 */
export function renderBadgeSvg(data: BadgeData): string {
  const labelText = data.label;
  const valueText = data.message;

  const labelTextWidth = measureText(labelText);
  const valueTextWidth = measureText(valueText);

  // 10px padding on each side of text + logo space in label
  const labelWidth = Math.round(labelTextWidth + 20 + LOGO_EXTRA);
  const valueWidth = Math.round(valueTextWidth + 20);
  const totalWidth = labelWidth + 1 + valueWidth; // 1px gap

  const labelTextX = (labelWidth + LOGO_EXTRA) / 2;
  const valueX = labelWidth + 1 + valueWidth / 2;

  const height = 20;
  const labelColor = "#555";
  const valueColor = data.color;

  const escapedLabel = escapeXml(labelText);
  const escapedValue = escapeXml(valueText);

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${totalWidth}" height="${height}" role="img" aria-label="${escapedLabel}: ${escapedValue}">
  <linearGradient id="b" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="a">
    <rect width="${totalWidth}" height="${height}" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#a)">
    <rect width="${labelWidth}" height="${height}" fill="${labelColor}"/>
    <rect x="${labelWidth + 1}" width="${valueWidth}" height="${height}" fill="${valueColor}"/>
    <rect width="${totalWidth}" height="${height}" fill="url(#b)"/>
  </g>
  <image x="3" y="3" width="${LOGO_SIZE}" height="${LOGO_SIZE}" xlink:href="${LOGO_SVG_BASE64}"/>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelTextX}" y="15" fill="#010101" fill-opacity=".3">${escapedLabel}</text>
    <text x="${labelTextX}" y="14">${escapedLabel}</text>
    <text x="${valueX}" y="15" fill="#010101" fill-opacity=".3">${escapedValue}</text>
    <text x="${valueX}" y="14">${escapedValue}</text>
  </g>
</svg>`;
}

// ---------------------------------------------------------------------------
// formatBadgeOutput
// ---------------------------------------------------------------------------

/**
 * Route badge data to the requested output format.
 *
 * - "svg"      local SVG string via renderBadgeSvg
 * - "markdown" shields.io markdown image link
 * - "url"      shields.io badge URL
 */
export function formatBadgeOutput(data: BadgeData, skillName: string, format: BadgeFormat): string {
  if (format === "svg") {
    return renderBadgeSvg(data);
  }

  const label = encodeURIComponent(data.label);
  const message = encodeURIComponent(data.message);
  const color = data.color.replace("#", "");
  const url = `https://img.shields.io/badge/${label}-${message}-${color}`;

  if (format === "markdown") {
    return `![Skill Health: ${skillName}](${url})`;
  }

  return url;
}
