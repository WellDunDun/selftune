import { createHash } from "node:crypto";

import {
  suggestInstallerAgents,
  type AgentDetectionObservation,
  type AgentSuggestion,
  type InstallerAgent,
  type InstallerScope,
} from "@selftune/runtime/installer";

const DESKTOP_INSTALL_HANDOFF = /^selftune:\/\/install\/([A-Za-z0-9_-]{43})$/u;
const PENDING_TOKEN_TTL_MS = 3 * 60 * 1_000;
const MAX_PENDING_TOKENS = 4;

export interface DesktopInstallHandoff {
  readonly token: string;
}

/** Deep links carry one opaque authority and no other data. */
export function parseDesktopInstallHandoff(input: string): DesktopInstallHandoff | null {
  if (input.length > 96) return null;
  const match = DESKTOP_INSTALL_HANDOFF.exec(input);
  return match?.[1] === undefined ? null : { token: match[1] };
}

type ContributorSignalDisclosure =
  | {
      readonly _tag: "signals_unavailable";
      readonly signalDisclosureSha256: string;
      readonly signalRecipientOrganizationId: null;
      readonly allowedFields: readonly [];
      readonly capability: "not_capable";
      readonly defaultState: "off";
      readonly contributorConsent: "not_applicable";
      readonly enabled: false;
    }
  | {
      readonly _tag: "capable_default_off";
      readonly signalDisclosureSha256: string;
      readonly signalRecipientOrganizationId: string;
      readonly allowedFields: ReadonlyArray<"trigger" | "grade" | "miss_category">;
      readonly capability: "capable";
      readonly defaultState: "off";
      readonly contributorConsent: "not_granted";
      readonly enabled: false;
    }
  | {
      readonly _tag: "capable_consented";
      readonly signalDisclosureSha256: string;
      readonly signalRecipientOrganizationId: string;
      readonly allowedFields: ReadonlyArray<"trigger" | "grade" | "miss_category">;
      readonly capability: "capable";
      readonly defaultState: "off";
      readonly contributorConsent: "granted";
      readonly enabled: true;
    };

/** Exact server-owned preview. Local observations are added beside, never inside, this value. */
export interface DesktopRecipientPreview {
  readonly invitationId: string;
  readonly shareId: string;
  readonly distributionId: string;
  readonly sealedObjectId: string;
  readonly packagedSha256: string;
  readonly termsDisclosureSha256: string;
  readonly termsAcceptance: "accepted";
  readonly contributorSignals: ContributorSignalDisclosure;
  readonly installLifecycleReporting?: {
    readonly _tag: "installed_status";
    readonly lifecycleDisclosureSha256: string;
    readonly consent: "not_granted";
    readonly senderVisibleInstalledStatus: "disabled";
  };
  readonly status: "preview";
  readonly expiresAt: string;
  readonly supportedTargetAgents: ReadonlyArray<InstallerAgent>;
  readonly targetAgentSelectionRequired: true;
  readonly scopeChoices: readonly ["project", "global"];
  readonly scopeSelectionRequired: true;
  readonly installModeDefault: "copy";
  readonly conflictPolicyChoices: readonly ["prompt", "replace", "keep_both"];
  readonly conflictPolicyDefault: "prompt";
  readonly customPathPolicy: "unsupported_v1";
  readonly automaticDesktopInstall: "not_authorized";
  readonly automaticSkillInstall: "not_authorized";
}

export type DesktopPreviewResolution =
  | { readonly status: "preview"; readonly preview: DesktopRecipientPreview }
  | { readonly status: "unauthenticated" }
  | {
      readonly status: "error";
      readonly code: "expired" | "replay" | "forbidden" | "invalid" | "unavailable";
      readonly message: string;
    };

export type DesktopInstallBootstrapPublicState =
  | { readonly status: "idle" }
  | { readonly status: "pending"; readonly resume: "preview" }
  | { readonly status: "unavailable"; readonly reason: "untrusted_build" };

export type DesktopInstallBootstrapPreviewResult =
  | { readonly status: "idle" }
  | {
      readonly status: "login_required";
      readonly pending: false;
      readonly resume: "reopen_install_link";
    }
  | {
      readonly status: "ready";
      readonly remote: DesktopRecipientPreview;
      readonly local: {
        readonly agentSuggestions: ReadonlyArray<AgentSuggestion>;
        readonly scopeChoices: readonly ["project", "global"];
        readonly selectedAgents: readonly [];
        readonly selectedScope: InstallerScope | null;
        readonly installMode: "copy";
        readonly confirmationRequired: true;
      };
    }
  | {
      readonly status: "error";
      readonly code: "expired" | "replay" | "forbidden" | "invalid" | "unavailable";
      readonly message: string;
    };

export interface DesktopInstallBootstrapController {
  readonly destroy: () => void;
  readonly ingestArgv: (argv: ReadonlyArray<string>) => DesktopInstallHandoffIngestResult;
  readonly ingestUrl: (url: string) => DesktopInstallHandoffIngestResult;
  readonly preview: () => Promise<DesktopInstallBootstrapPreviewResult>;
  readonly publicState: () => DesktopInstallBootstrapPublicState;
}

export type DesktopInstallHandoffIngestResult =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly reason: "duplicate" | "invalid" | "multiple" | "queue_full" | "untrusted_build";
    };

export interface DesktopInstallBootstrapDependencies {
  readonly trustedBuild: boolean;
  readonly resolvePreview: (token: string) => Promise<DesktopPreviewResolution>;
  readonly detectAgents: () => Promise<ReadonlyArray<AgentDetectionObservation>>;
  readonly now?: () => number;
  readonly schedule?: (delayMilliseconds: number, callback: () => void) => () => void;
}

interface PendingHandoff {
  token: string;
  readonly digest: string;
  readonly expiresAt: number;
  cancelTimer: (() => void) | null;
}

interface ReplayMarker {
  readonly digest: string;
  readonly expiresAt: number;
}

function defaultSchedule(delayMilliseconds: number, callback: () => void): () => void {
  const timer = setTimeout(callback, delayMilliseconds);
  return () => clearTimeout(timer);
}

function visibleErrorMessage(message: string, token: string): string {
  const redacted = token ? message.replaceAll(token, "[redacted]") : message;
  return redacted.slice(0, 240) || "Desktop install preview failed.";
}

function tokenDigest(token: string): string {
  return createHash("sha256").update("selftune:desktop-bootstrap:v1:").update(token).digest("hex");
}

export function createDesktopInstallBootstrapController(
  dependencies: DesktopInstallBootstrapDependencies,
): DesktopInstallBootstrapController {
  const now = dependencies.now ?? Date.now;
  const schedule = dependencies.schedule ?? defaultSchedule;
  const queue: PendingHandoff[] = [];
  const replayMarkers: ReplayMarker[] = [];
  let destroyed = false;
  let previewInFlight: Promise<DesktopInstallBootstrapPreviewResult> | null = null;

  function prune(): void {
    const current = now();
    while (queue[0] && queue[0].expiresAt <= current) {
      removePending(queue[0].digest, true);
    }
    for (let index = replayMarkers.length - 1; index >= 0; index -= 1) {
      if (replayMarkers[index]!.expiresAt <= current) replayMarkers.splice(index, 1);
    }
  }

  function rememberReplay(digest: string, expiresAt: number): void {
    const previous = replayMarkers.findIndex((marker) => marker.digest === digest);
    if (previous !== -1) replayMarkers.splice(previous, 1);
    replayMarkers.push({ digest, expiresAt });
    while (replayMarkers.length > MAX_PENDING_TOKENS) replayMarkers.shift();
  }

  function removePending(digest: string, remember: boolean): void {
    const index = queue.findIndex((pending) => pending.digest === digest);
    if (index === -1) return;
    const [pending] = queue.splice(index, 1);
    pending?.cancelTimer?.();
    if (pending) {
      pending.cancelTimer = null;
      pending.token = "";
    }
    if (remember && pending) rememberReplay(pending.digest, pending.expiresAt);
  }

  function scheduleExpiry(pending: PendingHandoff): void {
    pending.cancelTimer = schedule(Math.max(0, pending.expiresAt - now()), () => {
      pending.cancelTimer = null;
      if (pending.expiresAt > now()) {
        scheduleExpiry(pending);
        return;
      }
      removePending(pending.digest, true);
    });
  }

  function ingestUrl(url: string): DesktopInstallHandoffIngestResult {
    if (destroyed || !dependencies.trustedBuild) {
      return { accepted: false, reason: "untrusted_build" };
    }
    prune();
    const handoff = parseDesktopInstallHandoff(url);
    if (!handoff) return { accepted: false, reason: "invalid" };
    const digest = tokenDigest(handoff.token);
    if (
      queue.some((pending) => pending.digest === digest) ||
      replayMarkers.some((marker) => marker.digest === digest)
    ) {
      return { accepted: false, reason: "duplicate" };
    }
    if (queue.length >= MAX_PENDING_TOKENS) return { accepted: false, reason: "queue_full" };

    const expiresAt = now() + PENDING_TOKEN_TTL_MS;
    const pending: PendingHandoff = {
      token: handoff.token,
      digest,
      expiresAt,
      cancelTimer: null,
    };
    queue.push(pending);
    scheduleExpiry(pending);
    return { accepted: true };
  }

  function ingestArgv(argv: ReadonlyArray<string>): DesktopInstallHandoffIngestResult {
    const urls = argv.filter((argument) => argument.toLowerCase().startsWith("selftune:"));
    if (urls.length === 0) return { accepted: false, reason: "invalid" };
    if (urls.length !== 1) return { accepted: false, reason: "multiple" };
    return ingestUrl(urls[0]!);
  }

  async function previewInternal(): Promise<DesktopInstallBootstrapPreviewResult> {
    if (!dependencies.trustedBuild) {
      return {
        status: "error",
        code: "unavailable",
        message: "Install handoffs require an official signed SelfTune Desktop build.",
      };
    }
    prune();
    const pending = queue[0];
    if (!pending) return { status: "idle" };

    let resolution: DesktopPreviewResolution;
    try {
      resolution = await dependencies.resolvePreview(pending.token);
    } catch {
      removePending(pending.digest, true);
      return {
        status: "error",
        code: "unavailable",
        message: "Install preview is unavailable.",
      };
    }
    if (destroyed) return { status: "idle" };
    if (!queue.some((candidate) => candidate.digest === pending.digest)) {
      return { status: "error", code: "expired", message: "This install handoff has expired." };
    }
    if (resolution.status === "unauthenticated") {
      removePending(pending.digest, false);
      return { status: "login_required", pending: false, resume: "reopen_install_link" };
    }

    if (resolution.status === "error") {
      const message = visibleErrorMessage(resolution.message, pending.token);
      removePending(pending.digest, true);
      return {
        status: "error",
        code: resolution.code,
        message,
      };
    }

    removePending(pending.digest, true);

    try {
      const supported = new Set(resolution.preview.supportedTargetAgents);
      const agentSuggestions = suggestInstallerAgents(await dependencies.detectAgents()).filter(
        ({ agent }) => supported.has(agent),
      );
      return {
        status: "ready",
        remote: resolution.preview,
        local: {
          agentSuggestions,
          scopeChoices: resolution.preview.scopeChoices,
          selectedAgents: [],
          selectedScope: null,
          installMode: "copy",
          confirmationRequired: true,
        },
      };
    } catch {
      return {
        status: "error",
        code: "unavailable",
        message: "Local agent detection is unavailable.",
      };
    }
  }

  function preview(): Promise<DesktopInstallBootstrapPreviewResult> {
    if (previewInFlight) return previewInFlight;
    previewInFlight = previewInternal().finally(() => {
      previewInFlight = null;
    });
    return previewInFlight;
  }

  return {
    destroy() {
      destroyed = true;
      while (queue[0]) removePending(queue[0].digest, false);
      replayMarkers.splice(0);
    },
    ingestArgv,
    ingestUrl,
    preview,
    publicState() {
      if (!dependencies.trustedBuild) {
        return { status: "unavailable", reason: "untrusted_build" };
      }
      prune();
      return queue.length === 0 ? { status: "idle" } : { status: "pending", resume: "preview" };
    },
  };
}
