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

  // 10px padding on each side of text
  const labelWidth = Math.round(labelTextWidth + 20);
  const valueWidth = Math.round(valueTextWidth + 20);
  const totalWidth = labelWidth + 1 + valueWidth; // 1px gap

  const labelX = labelWidth / 2;
  const valueX = labelWidth + 1 + valueWidth / 2;

  const height = 20;
  const labelColor = "#555";
  const valueColor = data.color;

  const escapedLabel = escapeXml(labelText);
  const escapedValue = escapeXml(valueText);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height}" role="img" aria-label="${escapedLabel}: ${escapedValue}">
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
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelX}" y="15" fill="#010101" fill-opacity=".3">${escapedLabel}</text>
    <text x="${labelX}" y="14">${escapedLabel}</text>
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
