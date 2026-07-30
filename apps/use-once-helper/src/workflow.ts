import { createHash } from "node:crypto";

import { decodeCanonicalPortablePackageBundleV2 } from "@selftune/control-plane/domain";
import * as Effect from "effect/Effect";

import { buildAgentInvocation } from "./agents";
import type {
  AgentExecutionPort,
  DisclosurePort,
  SupportedAgent,
  UseOnceAuthorityClient,
  UseOncePreview,
  UseOnceWorkspacePort,
  VerifiedUseOnceDisclosure,
} from "./contracts";
import { UseOnceHelperError } from "./errors";
import {
  validateConsumption,
  validateDelivery,
  validateHandoffToken,
  validatePreview,
} from "./validation";

export interface RunUseOnceDependencies {
  readonly authority: UseOnceAuthorityClient;
  readonly disclosure: DisclosurePort;
  readonly workspace: UseOnceWorkspacePort;
  readonly agentExecution: AgentExecutionPort;
  readonly now?: () => Date;
}

export interface RunUseOnceInput {
  readonly handoffToken: string;
  readonly supportedAgent: SupportedAgent;
  readonly signal?: AbortSignal;
}

export interface RunUseOnceResult {
  readonly status: "used_once";
  readonly issueId: string;
  readonly lifecycleReported: boolean;
  readonly contributorSignalsEmitted: "none";
}

export const MAXIMUM_BUNDLED_TERMS_DISCLOSURE_BYTES = 64 * 1024;

function verifyBundledTerms(
  files: readonly { readonly path: string; readonly content: Uint8Array }[],
  bundledTerms: UseOncePreview["license"]["bundledTerms"],
): VerifiedUseOnceDisclosure["bundledTerms"] {
  if (bundledTerms === null) return null;
  const file = files.find((candidate) => candidate.path === bundledTerms.path);
  if (
    file === undefined ||
    createHash("sha256").update(file.content).digest("hex") !== bundledTerms.sha256
  )
    throw new UseOnceHelperError(
      "PACKAGE_INVALID",
      "Bundled license terms do not match the inspected package evidence.",
    );
  if (file.content.byteLength > MAXIMUM_BUNDLED_TERMS_DISCLOSURE_BYTES)
    throw new UseOnceHelperError(
      "PACKAGE_INVALID",
      "Bundled license terms exceed the 64 KiB interactive disclosure limit.",
    );
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(file.content);
  } catch (cause) {
    throw new UseOnceHelperError(
      "PACKAGE_INVALID",
      "Bundled license terms are not valid UTF-8 text.",
      cause,
    );
  }
  return { ...bundledTerms, content };
}

/**
 * One attempt means one consume, one delivery, and at most one agent spawn.
 * Callers must never retry this function after consumption.
 */
export async function runUseOnce(
  input: RunUseOnceInput,
  dependencies: RunUseOnceDependencies,
): Promise<RunUseOnceResult> {
  const token = validateHandoffToken(input.handoffToken);
  const now = dependencies.now ?? (() => new Date());
  input.signal?.throwIfAborted();
  await dependencies.workspace.recoverStale();

  const preview = validatePreview(
    await dependencies.authority.preview({
      handoffToken: token,
      supportedAgent: input.supportedAgent,
      signal: input.signal,
    }),
    input.supportedAgent,
    now(),
  );
  const delivery = validateDelivery(
    await dependencies.authority.retrievePreviewObject({
      handoffToken: token,
      preview,
      signal: input.signal,
    }),
    preview,
  );
  const bundle = await Effect.runPromise(
    decodeCanonicalPortablePackageBundleV2(delivery.bytes).pipe(
      Effect.mapError(
        (cause) =>
          new UseOnceHelperError("PACKAGE_INVALID", "The sealed package is invalid.", cause),
      ),
    ),
  );
  const disclosure: VerifiedUseOnceDisclosure = {
    preview,
    bundledTerms: verifyBundledTerms(bundle.files, preview.license.bundledTerms),
  };
  await dependencies.disclosure.show(disclosure);
  const confirmation = await dependencies.disclosure.confirm(disclosure);
  if (
    confirmation === null ||
    confirmation.termsAcceptance !== "accepted" ||
    confirmation.executionConsent !== "granted" ||
    confirmation.termsDisclosureSha256 !== preview.terms.disclosureSha256
  ) {
    throw new UseOnceHelperError("TERMS_REFUSED", "Terms and execution were not confirmed.");
  }

  input.signal?.throwIfAborted();
  const staged = await dependencies.workspace.stage({ files: bundle.files });
  try {
    input.signal?.throwIfAborted();
    const consumeInput = {
      handoffToken: token,
      preview,
      confirmation,
      signal: input.signal,
    } as const;
    input.signal?.throwIfAborted();
    const consumption = validateConsumption(
      await dependencies.authority.consume(consumeInput),
      preview,
      now(),
    );
    await dependencies.agentExecution.execute(
      buildAgentInvocation(input.supportedAgent, staged.skillDirectory),
      input.signal ?? new AbortController().signal,
    );
    return {
      status: "used_once",
      issueId: consumption.issueId,
      lifecycleReported: consumption.lifecycleReporting.consent === "granted",
      contributorSignalsEmitted: "none",
    };
  } finally {
    await staged.cleanup();
  }
}
