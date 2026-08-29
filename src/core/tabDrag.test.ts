import { describe, expect, it } from "vitest";
import { shouldReleaseDraggedTab } from "./tabDrag";

describe("tab drag completion", () => {
  it("releases only an uncancelled drag that missed every drop target", () => {
    expect(shouldReleaseDraggedTab(false, false)).toBe(true);
    expect(shouldReleaseDraggedTab(true, false)).toBe(false);
    expect(shouldReleaseDraggedTab(false, true)).toBe(false);
  });
});
