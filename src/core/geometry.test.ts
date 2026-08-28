import { describe, expect, it } from "vitest";
import { calculateTabBarFrame } from "./geometry";

describe("tab bar geometry", () => {
  it("keeps negative virtual-desktop coordinates and clamps only to the display work area", () => {
    const display = { id: "above", primary: false, workArea: { x: -1920, y: -1080, width: 1920, height: 1080 } };
    expect(calculateTabBarFrame({ x: -1200, y: -1000, width: 800, height: 600 }, 72, display)).toMatchObject({ x: -1200, y: -1072 });
    expect(calculateTabBarFrame({ x: -1200, y: -1070, width: 800, height: 600 }, 72, display)).toMatchObject({ y: -1080 });
  });

  it("matches the managed window width and uses the measured physical height", () => {
    expect(calculateTabBarFrame({ x: 10, y: 100, width: 120, height: 600 }, 60)).toEqual({ x: 10, y: 40, width: 120, height: 60 });
  });
});
