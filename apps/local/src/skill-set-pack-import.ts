import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  MAXIMUM_PORTABLE_SKILL_SET_ENVELOPE_BYTES,
  parseSkillSetPackUrl,
  SkillSetPackPreview,
} from "@selftune/control-plane";
import { importPortableSkillSetPack, type SkillSetManifest } from "@selftune/library";
import { remoteLibrarySettings } from "@selftune/runtime/remote-library/config";

const CLOUD_PACK_ORIGIN = "https://cloud.selftune.dev";
const MAXIMUM_PACK_PREVIEW_BYTES = 256 * 1024;

function allowedPackOrigins(configRoot: string): ReadonlySet<string> {
  const configured = remoteLibrarySettings(configRoot).url;
  const origins = new Set<string>([CLOUD_PACK_ORIGIN]);
  if (configured) origins.add(new URL(configured).origin);
  return origins;
}

async function resolvedPackUrl(value: string, configRoot: string) {
  const parsed = await Effect.runPromise(parseSkillSetPackUrl(value.trim()));
  if (!allowedPackOrigins(configRoot).has(parsed.url.origin)) {
    throw new Error(
      "This Pack origin is not trusted. Connect that self-host server in Settings first.",
    );
  }
  return parsed;
}

async function fetchBounded(url: URL, accept: string): Promise<Response> {
  const response = await fetch(url, {
    headers: { accept },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Pack request failed with HTTP ${response.status}.`);
  return response;
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error("The Pack response exceeds SelfTune's size limit.");
  }
  if (!response.body) throw new Error("The Pack response body is missing.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error("The Pack response exceeds SelfTune's size limit.");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function previewSkillSetPack(
  packUrl: string,
  configRoot: string,
): Promise<{ readonly packUrl: string; readonly preview: SkillSetPackPreview }> {
  const parsed = await resolvedPackUrl(packUrl, configRoot);
  const response = await fetchBounded(parsed.previewUrl, "application/json");
  const previewBytes = await readBoundedBody(response, MAXIMUM_PACK_PREVIEW_BYTES);
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(previewBytes));
  const preview = await Effect.runPromise(
    Schema.decodeUnknownEffect(SkillSetPackPreview)(value, {
      errors: "all",
      onExcessProperty: "error",
    }),
  );
  return { packUrl: parsed.url.href, preview };
}

export async function importSkillSetPack(input: {
  readonly packUrl: string;
  readonly expectedObjectSha256: string;
  readonly configRoot: string;
}): Promise<{
  readonly manifest: SkillSetManifest;
  readonly sourceRevisionSha256: string;
  readonly objectSha256: string;
}> {
  const { packUrl, preview } = await previewSkillSetPack(input.packUrl, input.configRoot);
  if (preview.objectSha256 !== input.expectedObjectSha256) {
    throw new Error("The Pack changed after preview. Review it again before importing.");
  }
  const parsed = await resolvedPackUrl(packUrl, input.configRoot);
  const response = await fetchBounded(
    parsed.contentUrl,
    "application/vnd.selftune.portable-skill-set+json;version=1",
  );
  const bytes = await readBoundedBody(response, MAXIMUM_PORTABLE_SKILL_SET_ENVELOPE_BYTES);
  if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_PORTABLE_SKILL_SET_ENVELOPE_BYTES) {
    throw new Error("The Pack content size is invalid.");
  }
  const objectSha256 = createHash("sha256").update(bytes).digest("hex");
  const responseSha256 = response.headers.get("x-selftune-content-sha256");
  if (objectSha256 !== preview.objectSha256 || responseSha256 !== preview.objectSha256) {
    throw new Error("The downloaded Pack does not match the reviewed immutable object.");
  }
  const imported = importPortableSkillSetPack(bytes, { configRoot: input.configRoot });
  if (
    imported.sourceRevisionSha256 !== preview.skillSetRevisionSha256 ||
    imported.objectSha256 !== preview.objectSha256
  ) {
    throw new Error("The imported Pack identity does not match its preview.");
  }
  return imported;
}
