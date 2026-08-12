export type PreviewScrollPosition = {
  x: number;
  y: number;
  maxX: number;
  maxY: number;
};

export type PreviewScrollCandidate<T> = {
  target: T;
  position: PreviewScrollPosition;
};

const SCROLL_EPSILON = 1;

function axisCanMove(current: number, maximum: number, delta: number): boolean {
  if (delta > 0) return current < maximum - SCROLL_EPSILON;
  if (delta < 0) return current > SCROLL_EPSILON;
  return false;
}

/**
 * Return whether a scroll position has room in at least one requested axis.
 * A nested container at its boundary can therefore hand the scroll to an
 * outer container, matching normal wheel-scroll chaining.
 */
export function previewScrollCanMove(
  position: PreviewScrollPosition,
  deltaX: number,
  deltaY: number,
): boolean {
  return axisCanMove(position.x, position.maxX, deltaX)
    || axisCanMove(position.y, position.maxY, deltaY);
}

/**
 * Candidates are ordered from the element under the AI cursor out to the page.
 * Explicit targets, coordinates, and cursor scrolling all chain to the first
 * ancestor that can move, matching normal wheel behavior at pane boundaries.
 */
export function choosePreviewScrollCandidate<T>(
  candidates: Array<PreviewScrollCandidate<T>>,
  deltaX: number,
  deltaY: number,
  _lockNearest: boolean,
): PreviewScrollCandidate<T> | null {
  if (candidates.length === 0) return null;
  return candidates.find((candidate) =>
    previewScrollCanMove(candidate.position, deltaX, deltaY)
  ) ?? candidates[0];
}

export function previewScrollMoved(
  before: PreviewScrollPosition,
  after: PreviewScrollPosition,
): boolean {
  return Math.abs(after.x - before.x) > SCROLL_EPSILON
    || Math.abs(after.y - before.y) > SCROLL_EPSILON;
}
