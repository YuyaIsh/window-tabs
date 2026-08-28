import type { DisplayInfo, Rect } from "./model";

export const TAB_BAR_OFFSET = 64;
export const MIN_TAB_BAR_WIDTH = 240;
export const MAX_TAB_BAR_WIDTH = 960;

/** Calculates a tab-bar position in virtual-desktop coordinates. */
export function calculateTabBarFrame(frame: Rect, display?: DisplayInfo): Rect {
  const top = display ? Math.max(display.workArea.y, frame.y - TAB_BAR_OFFSET) : frame.y - TAB_BAR_OFFSET;
  return { x: frame.x, y: top, width: Math.min(MAX_TAB_BAR_WIDTH, Math.max(MIN_TAB_BAR_WIDTH, frame.width)), height: 120 };
}
