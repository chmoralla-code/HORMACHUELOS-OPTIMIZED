/** Keep the native Preview Browser off the sash so drag can start and continue. */
export const PREVIEW_RESIZE_GUTTER = 12;

export type PreviewResizeRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type PreviewResizeBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function previewBrowserBoundsFromRect(
  rect: PreviewResizeRect,
  stacked: boolean,
): PreviewResizeBounds | null {
  if (rect.width < 2 || rect.height < 2 || rect.left < 0 || rect.top < 0) return null;
  if (stacked) {
    const height = rect.height - PREVIEW_RESIZE_GUTTER;
    if (height < 2) return null;
    return { x: rect.left, y: rect.top + PREVIEW_RESIZE_GUTTER, width: rect.width, height };
  }
  const width = rect.width - PREVIEW_RESIZE_GUTTER;
  if (width < 2) return null;
  return { x: rect.left + PREVIEW_RESIZE_GUTTER, y: rect.top, width, height: rect.height };
}
