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
    const frame = { x: 0.2, y: 0.3, width: 0.5, height: 0.6 };
    const first = applyNativeDrop(emptyWorkspace(), window("one"), window("two"), frame);
    const second = applyNativeDrop(first, window("one"), window("two"));
    expect(second.groups).toHaveLength(1);
    expect(second.groups[0].frame).toEqual(frame);
    expect(second.groups[0].tabs.map((tab) => tab.runtimeWindowId)).toEqual(["two", "one"]);
  });
  it("releases a dropped-outside tab but leaves cancellation command-free", () => {
    const first = newGroup(window("one"));
    const second = { ...first, tabs: [...first.tabs, { ...newGroup(window("two")).tabs[0] }] };
    const current = addGroup(emptyWorkspace(), second);
    const released = applyWorkspaceCommand(current, { type: "release-tab", groupId: second.id, tabId: second.tabs[0].id });
    expect(released.groups[0].tabs.map((tab) => tab.runtimeWindowId)).toEqual(["two"]);
    // Esc/cancellation sends no command, so the authoritative workspace stays unchanged.
    expect(current.groups[0].tabs).toHaveLength(2);
  });
  it("dissolves a one-tab group when that tab is released outside every host", () => {
    const group = newGroup(window("one"));
    const current = addGroup(emptyWorkspace(), group);
    expect(applyWorkspaceCommand(current, { type: "release-tab", groupId: group.id, tabId: group.tabs[0].id }).groups).toHaveLength(0);
  });
  it("moves a tab to the destination group when dropped on its bar", () => {
    const source = newGroup(window("one"));
    const destination = newGroup(window("two"));
    const current = addGroup(addGroup(emptyWorkspace(), source), destination);
    const next = applyWorkspaceCommand(current, { type: "move-tab", sourceGroupId: source.id, tabId: source.tabs[0].id, destinationGroupId: destination.id });
    expect(next.groups).toHaveLength(1);
    expect(next.groups[0].tabs.map((tab) => tab.runtimeWindowId)).toEqual(["two", "one"]);
  });
});
