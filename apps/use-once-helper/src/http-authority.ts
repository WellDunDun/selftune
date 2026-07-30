import { randomUUID } from "node:crypto";

import type {
  SealedObjectDelivery,
  UseOnceAuthorityClient,
  UseOnceConsumption,
  UseOncePreview,
} from "./contracts";
import { USE_ONCE_AUTHORITY_PATHS } from "./contracts";
import { UseOnceHelperError } from "./errors";
import {
  MAXIMUM_HELPER_PACKAGE_BYTES,
  validateConsumption,
  validateDelivery,
  validatePreview,
} from "./validation";

export const PINNED_USE_ONCE_AUTHORITY_ORIGIN = "https://cloud.selftune.dev";
const ALLOWED_AUTHORITY_HOSTS = new Set(["cloud.selftune.dev"]);
const PACKAGE_CONTENT_TYPE = "application/vnd.selftune.portable-package+json";
const MAXIMUM_JSON_RESPONSE_BYTES = 256 * 1024;
const AUTHORITY_TIMEOUT_MILLISECONDS = 15_000;

type AuthorityFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface PinnedUseOnceAuthorityClientOptions {
  /** Test seam only. Production composition always uses globalThis.fetch. */
  readonly fetch?: AuthorityFetch;
  readonly now?: () => Date;
  readonly requestId?: () => string;
  readonly timeoutMilliseconds?: number;
}

function authorityOrigin(): URL {
  let origin: URL;
  try {
    origin = new URL(PINNED_USE_ONCE_AUTHORITY_ORIGIN);
  } catch (cause) {
    throw new UseOnceHelperError(
      "AUTHORITY_SEAM_UNAVAILABLE",
      "The signed helper authority pin is unavailable.",
      cause,
    );
  }
  if (
    origin.protocol !== "https:" ||
    !ALLOWED_AUTHORITY_HOSTS.has(origin.hostname) ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.port !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new UseOnceHelperError(
      "AUTHORITY_SEAM_UNAVAILABLE",
      "The signed helper authority pin is not an allowlisted HTTPS origin.",
    );
  }
  return origin;
}

function endpoint(origin: URL, path: string, query?: URLSearchParams): URL {
  const url = new URL(path, origin);
  if (url.origin !== origin.origin)
    throw new UseOnceHelperError("AUTHORITY_SEAM_UNAVAILABLE", "Authority path escaped its pin.");
  if (query !== undefined) url.search = query.toString();
  return url;
}

function responseError(status: number): UseOnceHelperError {
  if (status === 409)
    return new UseOnceHelperError("AUTHORITY_REPLAY", "This use-once authority was already used.");
  if (status === 410)
    return new UseOnceHelperError("AUTHORITY_EXPIRED", "This use-once authority expired.");
  if (status === 401 || status === 403)
    return new UseOnceHelperError("AUTHORITY_DENIED", "The use-once authority was denied.");
  return new UseOnceHelperError(
    "AUTHORITY_REQUEST_FAILED",
    `The use-once authority returned status ${status}.`,
  );
}

function assertSuccessfulResponse(response: Response): void {
  if (response.redirected || response.type === "opaqueredirect" || response.status >= 300) {
    throw responseError(response.status);
  }
  if (response.status < 200 || response.status >= 300) throw responseError(response.status);
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  /* oxlint-disable no-await-in-loop -- a bounded response stream must be consumed sequentially. */
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new UseOnceHelperError(
          "INVALID_AUTHORITY_RESPONSE",
          "The authority response exceeded its byte limit.",
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  /* oxlint-enable no-await-in-loop */
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json"))
    throw new UseOnceHelperError(
      "INVALID_AUTHORITY_RESPONSE",
      "The authority response was not JSON.",
    );
  const bytes = await readBoundedBody(response, MAXIMUM_JSON_RESPONSE_BYTES);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (cause) {
    throw new UseOnceHelperError(
      "INVALID_AUTHORITY_RESPONSE",
      "The authority returned invalid JSON.",
      cause,
    );
  }
}

async function fetchWithTimeout(
  fetchImplementation: AuthorityFetch,
  url: URL,
  init: RequestInit,
  externalSignal: AbortSignal | undefined,
  timeoutMilliseconds: number,
): Promise<Response> {
  externalSignal?.throwIfAborted();
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Authority request timed out", "TimeoutError")),
    timeoutMilliseconds,
  );
  try {
    return await fetchImplementation(url, {
      ...init,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
  } catch (cause) {
    if (controller.signal.aborted) {
      if (externalSignal?.aborted) throw externalSignal.reason;
      throw new UseOnceHelperError(
        "AUTHORITY_REQUEST_FAILED",
        "The use-once authority request timed out.",
        controller.signal.reason,
      );
    }
    throw new UseOnceHelperError(
      "AUTHORITY_REQUEST_FAILED",
      "The use-once authority request failed.",
      cause,
    );
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

function jsonRequest(body: object): RequestInit {
  return {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function exactContentHeaders(response: Response, preview: UseOncePreview): number {
  const expected = new Map<string, string>([
    ["cache-control", "no-store, private"],
    ["pragma", "no-cache"],
    ["etag", `"${preview.packagedSha256}"`],
    ["x-selftune-content-sha256", preview.packagedSha256],
    ["x-selftune-use-once-issue-id", preview.issueId],
    ["x-selftune-invitation-id", preview.invitationId],
    ["x-selftune-share-id", preview.shareId],
    ["x-selftune-distribution-id", preview.distributionId],
    ["x-selftune-sealed-object-id", preview.sealedObjectId],
    ["x-selftune-supported-agent", preview.supportedAgent],
  ]);
  for (const [header, value] of expected) {
    if (response.headers.get(header) !== value)
      throw new UseOnceHelperError(
        "INVALID_AUTHORITY_RESPONSE",
        `The sealed-object ${header} binding changed.`,
      );
  }
  if (response.headers.get("content-type") !== PACKAGE_CONTENT_TYPE)
    throw new UseOnceHelperError(
      "INVALID_AUTHORITY_RESPONSE",
      "The sealed-object content type changed.",
    );
  const rawLength = response.headers.get("content-length");
  if (rawLength === null || !/^(?:0|[1-9][0-9]*)$/.test(rawLength))
    throw new UseOnceHelperError(
      "INVALID_AUTHORITY_RESPONSE",
      "The sealed-object content length is invalid.",
    );
  const contentLength = Number(rawLength);
  if (!Number.isSafeInteger(contentLength) || contentLength > MAXIMUM_HELPER_PACKAGE_BYTES)
    throw new UseOnceHelperError("PACKAGE_INVALID", "Sealed package exceeds the 25 MiB limit.");
  return contentLength;
}

export function makePinnedUseOnceAuthorityClient(
  options: PinnedUseOnceAuthorityClientOptions = {},
): UseOnceAuthorityClient {
  const origin = authorityOrigin();
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const nextRequestId = options.requestId ?? randomUUID;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? AUTHORITY_TIMEOUT_MILLISECONDS;
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0)
    throw new UseOnceHelperError(
      "AUTHORITY_SEAM_UNAVAILABLE",
      "The helper authority timeout pin is invalid.",
    );

  return {
    async preview(input): Promise<UseOncePreview> {
      const response = await fetchWithTimeout(
        fetchImplementation,
        endpoint(origin, USE_ONCE_AUTHORITY_PATHS.preview),
        jsonRequest({
          handoffToken: input.handoffToken,
          supportedAgent: input.supportedAgent,
        }),
        input.signal,
        timeoutMilliseconds,
      );
      assertSuccessfulResponse(response);
      return validatePreview(await readJson(response), input.supportedAgent, now());
    },

    async retrievePreviewObject(input): Promise<SealedObjectDelivery> {
      const response = await fetchWithTimeout(
        fetchImplementation,
        endpoint(
          origin,
          USE_ONCE_AUTHORITY_PATHS.content(input.preview.issueId),
          new URLSearchParams({ supportedAgent: input.preview.supportedAgent }),
        ),
        {
          method: "GET",
          headers: {
            accept: PACKAGE_CONTENT_TYPE,
            authorization: `Bearer ${input.handoffToken}`,
          },
        },
        input.signal,
        timeoutMilliseconds,
      );
      assertSuccessfulResponse(response);
      const contentLength = exactContentHeaders(response, input.preview);
      const bytes = await readBoundedBody(response, MAXIMUM_HELPER_PACKAGE_BYTES);
      if (bytes.byteLength !== contentLength)
        throw new UseOnceHelperError(
          "INVALID_AUTHORITY_RESPONSE",
          "The sealed-object body length changed.",
        );
      return validateDelivery(
        {
          issueId: input.preview.issueId,
          invitationId: input.preview.invitationId,
          shareId: input.preview.shareId,
          distributionId: input.preview.distributionId,
          sealedObjectId: input.preview.sealedObjectId,
          packagedSha256: input.preview.packagedSha256,
          contentType: PACKAGE_CONTENT_TYPE,
          contentLength,
          contentSha256: response.headers.get("x-selftune-content-sha256"),
          bytes,
        },
        input.preview,
      );
    },

    async consume(input): Promise<UseOnceConsumption> {
      const requestId = nextRequestId();
      const response = await fetchWithTimeout(
        fetchImplementation,
        endpoint(origin, USE_ONCE_AUTHORITY_PATHS.consume),
        jsonRequest({
          requestId,
          handoffToken: input.handoffToken,
          expectedIssueId: input.preview.issueId,
          expectedInvitationId: input.preview.invitationId,
          expectedShareId: input.preview.shareId,
          expectedDistributionId: input.preview.distributionId,
          expectedSealedObjectId: input.preview.sealedObjectId,
          expectedPackagedSha256: input.preview.packagedSha256,
          supportedAgent: input.preview.supportedAgent,
          termsDisclosureSha256: input.confirmation.termsDisclosureSha256,
          termsAcceptance: input.confirmation.termsAcceptance,
          contributorSignals: input.preview.contributorSignals,
          lifecycleReporting: input.preview.lifecycleReporting,
          executionConsent: input.confirmation.executionConsent,
        }),
        input.signal,
        timeoutMilliseconds,
      );
      assertSuccessfulResponse(response);
      const value = await readJson(response);
      const consumption = validateConsumption(value, input.preview, now());
      if (consumption.requestId !== requestId)
        throw new UseOnceHelperError(
          "INVALID_AUTHORITY_RESPONSE",
          "The consumption request binding changed.",
        );
      return consumption;
    },
  };
}
