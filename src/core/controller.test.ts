import { describe, expect, it } from "vitest";
import { applyNativeDrop, applyWorkspaceCommand } from "./controller";
import { newGroup } from "./groups";
import type { WindowInfo } from "./model";
import { addGroup, emptyWorkspace } from "./workspace";

const window = (id: string): WindowInfo => ({ id, processId: 1, appId: "app.exe", appName: "App", title: id, frame: { x: 0, y: 0, width: 100, height: 100 }, displayId: "display", state: "normal" });

describe("controller reducer", () => {
  it("applies a secondary-host command once through the controller", () => {
    const group = newGroup(window("one"));
    const next = applyWorkspaceCommand(addGroup(emptyWorkspace(), group), { type: "select-tab", groupId: group.id, tabId: group.tabs[0].id });
    expect(next.activeGroupId).toBe(group.id);
    expect(next.groups).toHaveLength(1);
  });
  it("does not create duplicate groups when the same native drop is delivered twice", () => {
    const first = applyNativeDrop(emptyWorkspace(), window("one"), window("two"));
    const second = applyNativeDrop(first, window("one"), window("two"));
    expect(second.groups).toHaveLength(1);
    expect(second.groups[0].tabs.map((tab) => tab.runtimeWindowId)).toEqual(["two", "one"]);
  });
});
