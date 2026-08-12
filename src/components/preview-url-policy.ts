export type PreviewTabKind = "preview" | "browser";

/** URLs served by a project's local development server need native browser control. */
export function isExternalPreviewUrl(value: string): boolean {
  const trimmed = value.trim();
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(trimmed);
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
