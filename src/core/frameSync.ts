import type { WindowId } from "./model";

/**
 * Accept only the first settled-frame notification in a short burst. Windows
 * emits several location-change notifications for a single Snap/restore.
 */
export function shouldApplySettledFrame(
  lastAppliedAt: Map<WindowId, number>,
  windowId: WindowId,
  now: number,
  coalesceMs = 150,
): boolean {
  const previous = lastAppliedAt.get(windowId);
  if (previous !== undefined && now - previous < coalesceMs) return false;
  lastAppliedAt.set(windowId, now);
  return true;
}
