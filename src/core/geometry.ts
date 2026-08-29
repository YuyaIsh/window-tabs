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

/** Keeps a managed window inside its destination work area after the tab bar is inserted above it. */
export function fitFrameToWorkArea(frame: Rect, display: DisplayInfo): Rect {
  const right = display.workArea.x + display.workArea.width;
  const bottom = display.workArea.y + display.workArea.height;
  const x = Math.min(Math.max(frame.x, display.workArea.x), right - 1);
  const y = Math.min(Math.max(frame.y, display.workArea.y), bottom - 1);
  return {
    x,
    y,
    width: Math.max(1, Math.min(frame.width, right - x)),
    height: Math.max(1, Math.min(frame.height, bottom - y)),
  };
}
