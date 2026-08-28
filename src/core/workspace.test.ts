import { describe, expect, it } from "vitest";
import { newGroup } from "./groups";
import type { WindowInfo } from "./model";
import { activeGroup, addGroup, assignWindowToTab, detachTab, dissolveGroup, emptyWorkspace, moveTabToGroup, reconnectWorkspace, removeClosedWindow, selectGroup, updateActiveGroup } from "./workspace";

const window = (id: string): WindowInfo => ({ id, processId: 1, appId: "app.exe", appName: "App", title: id, frame: { x: 0, y: 0, width: 100, height: 100 }, displayId: "primary", state: "normal" });

describe("workspace", () => {
  it("keeps independent groups and activates the requested one", () => {
    const one = newGroup(window("one"));
    const two = newGroup(window("two"));
    const workspace = selectGroup(addGroup(addGroup(emptyWorkspace(), one), two), one.id);
    expect(activeGroup(workspace)?.id).toBe(one.id);
    expect(workspace.groups).toHaveLength(2);
  });
  it("removes only the active group", () => {
    const one = newGroup(window("one"));
    const two = newGroup(window("two"));
    const workspace = updateActiveGroup(addGroup(addGroup(emptyWorkspace(), one), two), () => null);
    expect(workspace.groups.map((group) => group.id)).toEqual([one.id]);
  });
  it("moves and detaches a tab without dropping another group", () => {
    const one = newGroup(window("one"));
    const two = newGroup(window("two"));
    const withMoved = moveTabToGroup(addGroup(addGroup(emptyWorkspace(), one), two), one.id, one.tabs[0].id, two.id);
    expect(activeGroup(withMoved)?.tabs).toHaveLength(2);
    const detached = detachTab(withMoved, two.id, one.tabs[0].id);
    expect(detached.groups).toHaveLength(2);
    expect(activeGroup(detached)?.tabs).toHaveLength(1);
  });
  it("does not allow a preset to claim a window already used by another group", () => {
    const current = newGroup(window("one"));
    const workspace = { groups: [current, { id: "preset", presetId: "preset", name: "Preset", tabs: [{ id: "preset-tab", name: "Other", rule: { platformHints: { windows: { executable: "app.exe" } } }, status: "unresolved" as const }], displayId: "primary", frame: { x: 0, y: 0, width: 1, height: 1 } }], activeGroupId: current.id };
    const next = reconnectWorkspace(workspace, [window("one")]);
    expect(next.groups[1].tabs[0].status).toBe("unresolved");
  });
  it("rejects a new group that reuses a connected runtime window", () => {
    const first = newGroup(window("one"));
    const duplicate = newGroup(window("one"));
    const next = addGroup(addGroup(emptyWorkspace(), first), duplicate);
    expect(next.groups).toEqual([first]);
  });
  it("does not manually assign a window already owned by another group", () => {
    const owned = newGroup(window("one"));
    const waiting = { id: "waiting", presetId: "preset", name: "Waiting", tabs: [{ id: "tab", name: "Tab", status: "unresolved" as const }], displayId: "primary", frame: { x: 0, y: 0, width: 1, height: 1 } };
    const next = assignWindowToTab(addGroup(addGroup(emptyWorkspace(), owned), waiting), waiting.id, "tab", window("one"));
    expect(next.groups.find((group) => group.id === waiting.id)?.tabs[0].runtimeWindowId).toBeUndefined();
  });
  it("dissolves a one-tab group only through the explicit command", () => {
    const group = newGroup(window("one"));
    expect(dissolveGroup(addGroup(emptyWorkspace(), group), group.id).groups).toHaveLength(0);
  });
  it("selects a surviving tab when the active runtime window closes", () => {
    const first = newGroup(window("one"));
    const secondTab = newGroup(window("two")).tabs[0];
    const group = { ...first, tabs: [...first.tabs, secondTab] };
    const next = removeClosedWindow(addGroup(emptyWorkspace(), group), "one");
    expect(next.groups[0].tabs.map((tab) => tab.runtimeWindowId)).toEqual(["two"]);
    expect(next.groups[0].activeTabId).toBe(secondTab.id);
  });
});
