import { describe, expect, it } from "vitest";
import { shouldApplySettledFrame } from "./frameSync";

describe("settled frame coalescing", () => {
  it("accepts one Snap/restore location event per debounce window", () => {
    const events = new Map<string, number>();
    expect(shouldApplySettledFrame(events, "window", 1_000)).toBe(true);
    expect(shouldApplySettledFrame(events, "window", 1_149)).toBe(false);
    expect(shouldApplySettledFrame(events, "window", 1_150)).toBe(true);
  });
});
