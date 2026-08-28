import type { DisplayInfo, Rect } from "./model";

export const TAB_BAR_LOGICAL_HEIGHT = 48;

/** Calculates a tab-bar position in virtual-desktop coordinates. */
export function calculateTabBarFrame(
  frame: Rect,
  physicalHeight = TAB_BAR_LOGICAL_HEIGHT,
  display?: DisplayInfo,
): Rect {
  const top = display ? Math.max(display.workArea.y, frame.y - physicalHeight) : frame.y - physicalHeight;
  return { x: frame.x, y: top, width: Math.max(1, frame.width), height: physicalHeight };
}
