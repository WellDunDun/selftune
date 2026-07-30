const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

export function developmentRendererProxyUrl(
  isPackaged: boolean,
  rendererUrl: string | undefined,
): string | null {
  if (isPackaged || rendererUrl === undefined) return null;

  try {
    const parsed = new URL(rendererUrl);
    return parsed.protocol === "http:" && LOOPBACK_HOSTNAMES.has(parsed.hostname)
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}
