import type { DisplayInfo, Rect } from "./model";

export const TAB_BAR_OFFSET = 64;

/** Calculates a tab-bar position in virtual-desktop coordinates. */
export function calculateTabBarFrame(frame: Rect, display?: DisplayInfo): Rect {
  const top = display ? Math.max(display.workArea.y, frame.y - TAB_BAR_OFFSET) : frame.y - TAB_BAR_OFFSET;
  return { x: frame.x, y: top, width: Math.min(960, Math.max(480, frame.width)), height: 120 };
}
