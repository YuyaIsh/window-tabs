import { describe, expect, it } from "vitest";
import { calculateTabBarFrame, MIN_TAB_BAR_WIDTH } from "./geometry";

describe("tab bar geometry", () => {
  it("keeps negative virtual-desktop coordinates and clamps only to the display work area", () => {
    const display = { id: "above", primary: false, workArea: { x: -1920, y: -1080, width: 1920, height: 1080 } };
    expect(calculateTabBarFrame({ x: -1200, y: -1000, width: 800, height: 600 }, display)).toMatchObject({ x: -1200, y: -1064 });
    expect(calculateTabBarFrame({ x: -1200, y: -1070, width: 800, height: 600 }, display)).toMatchObject({ y: -1080 });
  });

  it("keeps the host usable without making a narrow managed window excessively wide", () => {
    expect(calculateTabBarFrame({ x: 10, y: 100, width: 120, height: 600 })).toMatchObject({ width: MIN_TAB_BAR_WIDTH });
  });
});
