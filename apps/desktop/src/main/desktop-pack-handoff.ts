const PACK_HANDOFF = /^selftune:\/\/pack\/([A-Za-z0-9_-]{1,684})\/([A-Za-z0-9_-]{43})$/u;

export interface DesktopPackHandoff {
  readonly packUrl: string;
}

function decodeOrigin(value: string): string | null {
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) return null;
    const origin = bytes.toString("ascii");
    if (!bytes.equals(Buffer.from(origin, "ascii"))) return null;
    const url = new URL(origin);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin !== origin
    ) {
      return null;
    }
    return origin;
  } catch {
    return null;
  }
}

/** Deep links carry only one normalized Pack origin and its opaque authority token. */
export function parseDesktopPackHandoff(input: string): DesktopPackHandoff | null {
  if (input.length > 800) return null;
  const match = PACK_HANDOFF.exec(input);
  if (!match?.[1] || !match[2]) return null;
  const origin = decodeOrigin(match[1]);
  return origin ? { packUrl: `${origin}/p/${match[2]}` } : null;
}
