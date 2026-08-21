import { describe, expect, it } from "vitest";
import { addWindow, newGroup, reorderTab, ungroupWindow } from "./groups";
import type { WindowInfo } from "./model";

const window = (id: string): WindowInfo => ({ id, processId: 1, appId: "app", appName: "App", title: id, frame: { x: 0, y: 0, width: 100, height: 100 }, displayId: "primary", state: "normal" });
describe("groups", () => {
  it("retains a one-tab group and removes only on explicit final ungroup", () => {
    const group = newGroup(window("one"));
    expect(group.tabs).toHaveLength(1);
    expect(ungroupWindow(group, "one")).toBeNull();
  });
  it("does not add the same runtime window twice", () => {
    const group = newGroup(window("one"));
    expect(addWindow(group, window("one")).tabs).toHaveLength(1);
  });
  it("reorders tabs without changing the active tab", () => {
    const group = addWindow(newGroup(window("one")), window("two"));
    const moved = reorderTab(group, group.tabs[1].id, group.tabs[0].id);
    expect(moved.tabs.map((tab) => tab.runtimeWindowId)).toEqual(["two", "one"]);
    expect(moved.activeTabId).toBe(group.activeTabId);
  });
});
