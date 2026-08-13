export type PreviewTabKind = "preview" | "browser";

/** URLs served by a project's local development server need native browser control. */
export function isExternalPreviewUrl(value: string): boolean {
  const trimmed = value.trim();
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(trimmed);
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Pull a visitable http(s) address out of a Computer Use prompt so Preview can
 * open a Browser tab immediately. Whole-sentence prompts are never treated as
 * a search query.
 */
export function extractPreviewBrowserUrlFromPrompt(value: string): string | null {
  const text = String(value || "").trim();
  if (!text) return null;

  const explicit = text.match(/https?:\/\/[^\s<>"'()]+/i);
  if (explicit) {
    return safeHttpUrl(explicit[0].replace(/[.,;:!?]+$/g, ""));
  }

  const domain = text.match(
    /\b(?:www\.)?[a-z0-9][a-z0-9-]*\.(?:com|org|net|io|dev|app|ai|tv|co|gg|me|info|edu|gov|uk|us|ph)(?:\/[^\s<>"'()]*)?/i,
  );
  if (!domain) return null;
  return safeHttpUrl(`https://${domain[0].replace(/[.,;:!?]+$/g, "")}`);
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
