export type PreviewTabKind = "preview" | "browser";

/**
 * Match the native loopback policy with URL parsing, including .localhost,
 * every 127/8 address, IPv6 loopback, and explicit unspecified bind hosts.
 */
export function isExternalPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost")) return true;
    if (host === "::1" || host === "::" || host === "0.0.0.0") return true;
    const octets = host.split(".");
    if (octets.length !== 4) return false;
    const numbers = octets.map((octet) => Number(octet));
    return numbers.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
      && numbers[0] === 127;
  } catch {
    return false;
  }
}

/**
 * Keep project files in a same-origin iframe, but route every localhost server
 * through the native Preview Browser where bounded Computer Use is available.
 */
export function previewTabKindForEntry(
  value: string,
  requestedKind: PreviewTabKind = "preview",
): PreviewTabKind {
  return requestedKind === "browser" || isExternalPreviewUrl(value)
    ? "browser"
    : "preview";
}
