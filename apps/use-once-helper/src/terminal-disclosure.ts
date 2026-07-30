import { createInterface } from "node:readline/promises";

import type { DisclosurePort } from "./contracts";

const ESCAPE = 0x1b;
const BELL = 0x07;

/**
 * Strip complete ANSI CSI and OSC sequences in one forward pass.
 *
 * Incomplete sequences remain in the returned string so the caller's control
 * character pass can neutralize their introducer without discarding ordinary
 * text. Each scanner either advances beyond a complete sequence or stops at
 * the first byte that cannot belong to it, keeping total work linear.
 */
function stripAnsiSequences(value: string): string {
  const chunks: string[] = [];
  let plainStart = 0;
  let index = 0;
  let noOscTerminatorRemaining = false;

  while (index < value.length) {
    if (value.charCodeAt(index) !== ESCAPE || index + 1 >= value.length) {
      index += 1;
      continue;
    }

    const introducer = value.charCodeAt(index + 1);
    if (introducer === 0x5b) {
      // CSI: ESC [ parameter-bytes intermediate-bytes final-byte
      let cursor = index + 2;
      while (cursor < value.length) {
        const code = value.charCodeAt(cursor);
        if (code < 0x30 || code > 0x3f) break;
        cursor += 1;
      }
      while (cursor < value.length) {
        const code = value.charCodeAt(cursor);
        if (code < 0x20 || code > 0x2f) break;
        cursor += 1;
      }

      const finalByte = cursor < value.length ? value.charCodeAt(cursor) : -1;
      if (finalByte >= 0x40 && finalByte <= 0x7e) {
        chunks.push(value.slice(plainStart, index));
        index = cursor + 1;
        plainStart = index;
        continue;
      }

      // The scanned parameter/intermediate prefix cannot contain another ESC,
      // so resume at the first invalid byte without rescanning that prefix.
      index = cursor;
      continue;
    }

    if (introducer === 0x5d) {
      // OSC: ESC ] payload (BEL | ESC \). Preserve the previous sanitizer's
      // greedy behavior: the first BEL wins, otherwise the last ST wins.
      if (noOscTerminatorRemaining) {
        index += 2;
        continue;
      }
      let cursor = index + 2;
      let sequenceEnd = -1;
      let lastStringTerminatorEnd = -1;
      while (cursor < value.length) {
        const code = value.charCodeAt(cursor);
        if (code === BELL) {
          sequenceEnd = cursor + 1;
          break;
        }
        if (code === ESCAPE && cursor + 1 < value.length && value.charCodeAt(cursor + 1) === 0x5c) {
          lastStringTerminatorEnd = cursor + 2;
          cursor += 2;
          continue;
        }
        cursor += 1;
      }
      if (sequenceEnd === -1) sequenceEnd = lastStringTerminatorEnd;

      if (sequenceEnd !== -1) {
        chunks.push(value.slice(plainStart, index));
        index = sequenceEnd;
        plainStart = index;
        continue;
      }

      // No later OSC introducer can complete without also completing this one.
      noOscTerminatorRemaining = true;
      index += 2;
      continue;
    }

    index += 1;
  }

  if (chunks.length === 0) return value;
  chunks.push(value.slice(plainStart));
  return chunks.join("");
}

export interface InteractiveTerminalPort {
  readonly interactive: boolean;
  write(line: string): void;
  readLine(prompt: string): Promise<string>;
}

export const nodeInteractiveTerminal: InteractiveTerminalPort = {
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  write(line) {
    process.stdout.write(`${line}\n`);
  },
  async readLine(prompt) {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await terminal.question(prompt);
    } finally {
      terminal.close();
    }
  },
};

function display(value: string | null, maximumCharacters = 4_096): string {
  if (value === null) return "not provided";
  // Authority metadata is untrusted terminal text. Strip C0/C1, ANSI,
  // bidirectional/format, and Unicode line controls, then enforce the boundary.
  const withoutAnsi = stripAnsiSequences(value);
  return withoutAnsi.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").slice(0, maximumCharacters);
}

export function makeTerminalDisclosure(terminal: InteractiveTerminalPort): DisclosurePort {
  return {
    async show(disclosure) {
      const { preview } = disclosure;
      const signals = preview.helperContributorSignals;
      terminal.write(
        `Skill: ${display(preview.package.displayName)} ${display(preview.package.version)}`,
      );
      terminal.write(`Package format: ${preview.package.format}`);
      terminal.write(`Package SHA-256: ${preview.packagedSha256}`);
      terminal.write(`Publisher: ${display(preview.publisher.name)}`);
      terminal.write(
        `Rights holder: ${display(preview.rightsHolder.name)} (${preview.rightsHolder.kind})`,
      );
      terminal.write(`License: ${display(preview.license.expression)} (${preview.license.kind})`);
      terminal.write(`License evidence SHA-256: ${preview.license.licenseEvidenceSha256}`);
      terminal.write(
        `Bundled terms: ${disclosure.bundledTerms === null ? "not bundled" : `${display(disclosure.bundledTerms.path)} (${disclosure.bundledTerms.sha256})`}`,
      );
      if (disclosure.bundledTerms !== null) {
        terminal.write("--- verified bundled terms ---");
        terminal.write(display(disclosure.bundledTerms.content, 64 * 1024));
        terminal.write("--- end verified bundled terms ---");
      }
      terminal.write(`Terms: ${display(preview.terms.summary)}`);
      terminal.write(
        `Terms identity: ${preview.terms.disclosureSha256}; ${preview.terms.issueAcceptance}`,
      );
      terminal.write(`Provenance kind: ${preview.provenance.kind}`);
      terminal.write(`Provenance repository: ${display(preview.provenance.sourceRepository)}`);
      terminal.write(`Provenance ref: ${display(preview.provenance.sourceRef)}`);
      terminal.write(`Provenance tree hash: ${display(preview.provenance.sourceTreeHash)}`);
      terminal.write(
        `Share contributor disclosure: ${preview.contributorSignals.signalDisclosureSha256}; ${preview.contributorSignals._tag}`,
      );
      terminal.write(
        `Share contributor recipient: ${display(preview.contributorSignals.signalRecipientOrganizationId)}; fields: ${preview.contributorSignals.allowedFields.join(",") || "none"}`,
      );
      terminal.write(
        `Share contributor policy: ${preview.contributorSignals.capability}; default ${preview.contributorSignals.defaultState}; consent ${preview.contributorSignals.contributorConsent}; enabled ${String(preview.contributorSignals.enabled)}`,
      );
      terminal.write(
        `Helper contributor disclosure: ${signals.signalDisclosureSha256}; ${signals._tag}; fields: ${signals.allowedFields.join(",") || "none"}`,
      );
      terminal.write(
        `Helper contributor policy: default ${signals.defaultState}; trusted telemetry ${signals.trustedTelemetry}`,
      );
      terminal.write(
        `Used-once lifecycle disclosure: ${preview.lifecycleReporting.lifecycleDisclosureSha256}; consent ${preview.lifecycleReporting.consent}; sender status ${preview.lifecycleReporting.senderVisibleUsedOnceStatus}`,
      );
      terminal.write("Persistence: temporary files only; no skill install or local receipt");
    },
    async confirm(disclosure) {
      if (!terminal.interactive) return null;
      const answer = await terminal.readLine(
        'Type "USE ONCE" to accept the disclosed terms and run this skill once: ',
      );
      if (answer !== "USE ONCE") return null;
      return {
        termsDisclosureSha256: disclosure.preview.terms.disclosureSha256,
        termsAcceptance: "accepted",
        executionConsent: "granted",
      };
    },
  };
}
