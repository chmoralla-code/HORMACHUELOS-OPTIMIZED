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

/** “Open the website” means the local project preview, not a public URL. */
export function promptWantsLocalWebsite(value: string): boolean {
  const prompt = String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!prompt) return false;
  if (/https?:\/\//.test(prompt) && !/\blocalhost\b|\b127\.0\.0\.1\b/.test(prompt)) {
    return false;
  }
  return (
    /\b(open|show|launch|start|preview|view|load|bring up)\b.{0,48}\b(the\s+)?(website|web site|webapp|web app|site|preview)\b/.test(
      prompt,
    ) || /\b(open|show|go to|visit)\b.{0,24}\blocalhost\b/.test(prompt)
  );
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
