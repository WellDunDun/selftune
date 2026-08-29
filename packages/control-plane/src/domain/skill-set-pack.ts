import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const SKILL_SET_PACK_PROTOCOL = "selftune.skill-set-pack.v1" as const;
export const SKILL_SET_PACK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const SKILL_SET_PACK_DESKTOP_HOST = "pack" as const;

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const PackToken = Schema.String.check(Schema.isPattern(SKILL_SET_PACK_TOKEN_PATTERN));

export const SkillSetPackMode = Schema.Literals(["reusable_unlisted", "private_single_claim"]);
export type SkillSetPackMode = typeof SkillSetPackMode.Type;

export class SkillSetPackPreview extends Schema.Class<SkillSetPackPreview>("SkillSetPackPreview")({
  protocol: Schema.Literal(SKILL_SET_PACK_PROTOCOL),
  packId: Schema.String,
  artifactId: Schema.String,
  name: Schema.String,
  description: Schema.String,
  skillSetRevisionSha256: Sha256,
  objectSha256: Sha256,
  mode: SkillSetPackMode,
  expiresAt: Schema.String,
  requiresSignIn: Schema.Boolean,
  components: Schema.Array(
    Schema.Struct({
      logicalSkillId: Schema.String,
      licenseExpression: Schema.String,
    }),
  ),
}) {}

export const SkillSetPackStatus = Schema.Literals(["active", "claimed", "expired", "revoked"]);
export type SkillSetPackStatus = typeof SkillSetPackStatus.Type;

export class SkillSetPackManagementItem extends Schema.Class<SkillSetPackManagementItem>(
  "SkillSetPackManagementItem",
)({
  packId: Schema.String,
  artifactId: Schema.String,
  name: Schema.String,
  description: Schema.String,
  mode: SkillSetPackMode,
  status: SkillSetPackStatus,
  packUrl: Schema.NullOr(Schema.String),
  expiresAt: Schema.String,
  createdAt: Schema.String,
  claimedAt: Schema.NullOr(Schema.String),
  revokedAt: Schema.NullOr(Schema.String),
  skillSetRevisionSha256: Sha256,
  objectSha256: Sha256,
  componentCount: Schema.Number,
}) {}

export class SkillSetPackManagementList extends Schema.Class<SkillSetPackManagementList>(
  "SkillSetPackManagementList",
)({
  packs: Schema.Array(SkillSetPackManagementItem),
}) {}

export class SkillSetPackUrlError extends Schema.TaggedErrorClass<SkillSetPackUrlError>()(
  "SkillSetPackUrlError",
  { message: Schema.String },
) {}

function invalidUrl(message: string): SkillSetPackUrlError {
  return SkillSetPackUrlError.make({ message });
}

/**
 * Accepts only the branded `/p/<256-bit-base64url-token>` surface. The caller
 * remains responsible for deciding which origins are trusted before fetching.
 */
export const parseSkillSetPackUrl = Effect.fn("SkillSetPack.parseUrl")(function* (value: string) {
  const url = yield* Effect.try({
    try: () => new URL(value),
    catch: () => invalidUrl("Enter a valid absolute Skill Set Pack URL."),
  });
  if (url.username || url.password || url.search || url.hash) {
    return yield* invalidUrl(
      "Pack URLs cannot contain credentials, query parameters, or fragments.",
    );
  }
  const match = /^\/p\/([A-Za-z0-9_-]{43})\/?$/.exec(url.pathname);
  if (!match) return yield* invalidUrl("Pack URLs must use /p/<opaque-id>.");
  const token = yield* Schema.decodeUnknownEffect(PackToken)(match[1]).pipe(
    Effect.mapError(() => invalidUrl("The Pack identifier is invalid.")),
  );
  return {
    url,
    token,
    previewUrl: new URL(`/api/v1/public/packs/${token}`, url.origin),
    contentUrl: new URL(`/api/v1/public/packs/${token}/content`, url.origin),
  };
});

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" as const;

function encodeAsciiBase64Url(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 3) {
    const first = value.charCodeAt(index);
    const second = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
    const third = index + 2 < value.length ? value.charCodeAt(index + 2) : 0;
    if (first > 0x7f || second > 0x7f || third > 0x7f) {
      throw invalidUrl("Pack origins must contain only ASCII characters.");
    }
    const combined = (first << 16) | (second << 8) | third;
    output += BASE64URL_ALPHABET[(combined >>> 18) & 63];
    output += BASE64URL_ALPHABET[(combined >>> 12) & 63];
    if (index + 1 < value.length) output += BASE64URL_ALPHABET[(combined >>> 6) & 63];
    if (index + 2 < value.length) output += BASE64URL_ALPHABET[combined & 63];
  }
  return output;
}

/** The desktop handoff contains only a normalized origin and the opaque Pack token. */
export function skillSetPackDesktopUrl(packUrl: string): string {
  const url = new URL(packUrl);
  const token = /^\/p\/([A-Za-z0-9_-]{43})$/.exec(url.pathname)?.[1];
  if (
    !token ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw invalidUrl("Cannot create a Desktop handoff for an invalid Pack URL.");
  }
  return `selftune://${SKILL_SET_PACK_DESKTOP_HOST}/${encodeAsciiBase64Url(url.origin)}/${token}`;
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function compactRevision(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function readableExpiry(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${new Intl.DateTimeFormat("en", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date)} UTC`;
}

/** Shared no-build landing page used by Cloud and one-container self-host. */
export function renderSkillSetPackLandingPage(input: {
  readonly packUrl: string;
  readonly preview: SkillSetPackPreview;
}): string {
  const preview = input.preview;
  const safeName = htmlEscape(preview.name);
  const safeDescription = htmlEscape(preview.description);
  const safePackUrl = htmlEscape(input.packUrl);
  const safeDesktopUrl = htmlEscape(skillSetPackDesktopUrl(input.packUrl));
  const expiry = htmlEscape(preview.expiresAt);
  const expiryLabel = htmlEscape(readableExpiry(preview.expiresAt));
  const accessLabel =
    preview.mode === "private_single_claim" ? "Single-use private link" : "Reusable unlisted link";
  const componentRows = preview.components
    .map(
      (component) =>
        `<li><span>${htmlEscape(component.logicalSkillId)}</span><strong>${htmlEscape(component.licenseExpression)}</strong></li>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="robots" content="noindex,nofollow">
<meta property="og:title" content="${safeName} · SelfTune Pack"><meta property="og:description" content="${safeDescription}">
<title>${safeName} · SelfTune Pack</title><style>
:root{font-family:Geist,"Avenir Next",ui-sans-serif,system-ui,sans-serif;color:#18181b;background:#f4f4f2;font-synthesis:none}*{box-sizing:border-box}body{margin:0;min-height:100dvh;background:radial-gradient(circle at 85% 8%,#dce8df 0,transparent 31rem),#f4f4f2;color:#20211f}.shell{width:min(1120px,calc(100% - 32px));margin:0 auto;padding:28px 0 56px}.brand{display:flex;align-items:center;gap:10px;color:#343731;font-size:14px;font-weight:650;letter-spacing:-.01em}.mark{display:grid;width:30px;height:30px;place-items:center;border-radius:9px;background:#24352a;color:#fff}.hero{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(280px,.65fr);gap:clamp(32px,7vw,92px);align-items:start;padding:clamp(64px,10vw,128px) 0 56px}.eyebrow{margin:0 0 18px;color:#496052;font:600 12px/1.2 ui-monospace,SFMono-Regular,monospace;letter-spacing:.12em;text-transform:uppercase}h1{max-width:760px;margin:0;font-size:clamp(42px,7vw,78px);line-height:.96;letter-spacing:-.055em;font-weight:680}h1 span{color:#687169}.lede{max-width:62ch;margin:28px 0 0;color:#5d625b;font-size:18px;line-height:1.65}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:32px}.button{display:inline-flex;min-height:46px;align-items:center;justify-content:center;border:1px solid #24352a;border-radius:12px;padding:0 18px;background:#24352a;color:#fff;font-weight:650;text-decoration:none;transition:transform .2s ease,background .2s ease}.button:hover{background:#304737}.button:active{transform:translateY(1px)}button.button{background:transparent;color:#24352a;cursor:pointer}.fact{border-top:1px solid #cfd3cd;padding:17px 0}.fact:first-child{border-top:0}.fact small{display:block;margin-bottom:6px;color:#767c74;font-size:12px;text-transform:uppercase;letter-spacing:.08em}.fact strong{font-size:14px;font-weight:620}.revision{font-family:ui-monospace,SFMono-Regular,monospace}.contents{display:grid;grid-template-columns:minmax(220px,.55fr) minmax(0,1.45fr);gap:clamp(28px,6vw,82px);border-top:1px solid #cfd3cd;padding-top:44px}.contents h2{margin:0;font-size:28px;letter-spacing:-.035em}.contents p{color:#686d66;line-height:1.55}.skills{list-style:none;margin:0;padding:0;border-top:1px solid #cfd3cd}.skills li{display:flex;align-items:center;justify-content:space-between;gap:20px;border-bottom:1px solid #cfd3cd;padding:16px 4px}.skills span{font-weight:580}.skills strong{color:#55705e;font:600 12px/1.2 ui-monospace,SFMono-Regular,monospace}.notice{margin-top:34px;border-left:3px solid #698273;padding:4px 0 4px 17px;color:#62675f;font-size:13px;line-height:1.55}.copy-status{align-self:center;color:#55705e;font-size:13px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:760px){.shell{width:min(100% - 24px,680px);padding-top:18px}.hero,.contents{grid-template-columns:1fr}.hero{padding:56px 0 40px;gap:42px}h1{font-size:clamp(40px,13vw,58px)}.lede{font-size:16px}.actions{display:grid}.button{width:100%}.skills li{align-items:flex-start;flex-direction:column;gap:7px}}
</style></head><body><main class="shell"><div class="brand"><span class="mark">S</span>SelfTune Pack</div><section class="hero"><div><p class="eyebrow">Verified Skill Set revision</p><h1>${safeName}<span>.</span></h1><p class="lede">${safeDescription || "A portable collection of skills, pinned to one immutable revision."}</p><div class="actions"><a class="button" href="${safeDesktopUrl}">Open in SelfTune Desktop</a><button class="button" id="copy" type="button" data-url="${safePackUrl}">Copy Pack link</button><span class="copy-status" id="copy-status" aria-live="polite"></span></div><p class="notice">Desktop opens a review first. No files are installed until you confirm the included skills and license terms.</p></div><aside aria-label="Pack details"><div class="fact"><small>Access</small><strong>${accessLabel}</strong></div><div class="fact"><small>Included skills</small><strong>${preview.components.length}</strong></div><div class="fact"><small>Revision</small><strong class="revision" title="${htmlEscape(preview.skillSetRevisionSha256)}">${htmlEscape(compactRevision(preview.skillSetRevisionSha256))}</strong></div><div class="fact"><small>Expires</small><strong><time datetime="${expiry}">${expiryLabel}</time></strong></div></aside></section><section class="contents"><div><p class="eyebrow">Review before import</p><h2>What is inside</h2><p>Each component carries explicit license metadata and is verified against the sealed Pack object.</p></div><ul class="skills">${componentRows}</ul></section></main><script>
const button=document.getElementById("copy"),status=document.getElementById("copy-status");button?.addEventListener("click",async()=>{try{await navigator.clipboard.writeText(button.dataset.url||"");status.textContent="Link copied"}catch{status.textContent="Copy was blocked by this browser"}});
</script></body></html>`;
}
