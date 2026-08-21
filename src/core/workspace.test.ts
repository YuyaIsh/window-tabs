import { describe, expect, it } from "vitest";
import { newGroup } from "./groups";
import type { WindowInfo } from "./model";
import { activeGroup, addGroup, detachTab, emptyWorkspace, moveTabToGroup, selectGroup, updateActiveGroup } from "./workspace";

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
});
