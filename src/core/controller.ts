import { addWindow, newGroup, reorderTab, selectTab, ungroupWindow } from "./groups";
import type { WindowInfo } from "./model";
import { addGroup, detachTab, dissolveGroup, groupForWindow, moveTabToGroup, type Workspace } from "./workspace";

export type WorkspaceCommand =
  | { type: "select-tab"; groupId: string; tabId: string }
  | { type: "reorder-tab"; groupId: string; sourceTabId: string; destinationTabId: string }
  | { type: "move-tab"; sourceGroupId: string; tabId: string; destinationGroupId: string }
  | { type: "detach-tab"; groupId: string; tabId: string }
  | { type: "release-tab"; groupId: string; tabId: string }
  | { type: "ungroup"; groupId: string; windowId: string };

/** The only reducer used by the authoritative host for secondary-host commands. */
export function applyWorkspaceCommand(workspace: Workspace, command: WorkspaceCommand): Workspace {
  switch (command.type) {
    case "select-tab": return { ...workspace, groups: workspace.groups.map((group) => group.id === command.groupId ? selectTab(group, command.tabId) : group), activeGroupId: command.groupId };
    case "reorder-tab": return { ...workspace, groups: workspace.groups.map((group) => group.id === command.groupId ? reorderTab(group, command.sourceTabId, command.destinationTabId) : group) };
    case "move-tab": return moveTabToGroup(workspace, command.sourceGroupId, command.tabId, command.destinationGroupId);
    case "detach-tab": return detachTab(workspace, command.groupId, command.tabId);
    case "release-tab": {
      const group = workspace.groups.find((item) => item.id === command.groupId);
      const tab = group?.tabs.find((item) => item.id === command.tabId);
      if (!group || !tab?.runtimeWindowId) return workspace;
      if (group.tabs.length === 1) return dissolveGroup(workspace, group.id);
      const next = ungroupWindow(group, tab.runtimeWindowId);
      return next ? { ...workspace, groups: workspace.groups.map((item) => item.id === group.id ? next : item) } : workspace;
    }
    case "ungroup": return { ...workspace, groups: workspace.groups.flatMap((group) => group.id === command.groupId ? (() => { const next = ungroupWindow(group, command.windowId); return next ? [next] : []; })() : [group]) };
  }
}

/** Idempotent native-drop reducer: duplicate delivery cannot create duplicate groups. */
export function applyNativeDrop(workspace: Workspace, source: WindowInfo, target: WindowInfo): Workspace {
  const sourceOwner = groupForWindow(workspace, source.id);
  const targetOwner = groupForWindow(workspace, target.id);
  if (!sourceOwner && !targetOwner) return addGroup(workspace, addWindow(newGroup(target), source));
  if (sourceOwner && !targetOwner) return { ...workspace, groups: workspace.groups.map((group) => group.id === sourceOwner.id ? addWindow(group, target) : group), activeGroupId: sourceOwner.id };
  if (!sourceOwner && targetOwner) return { ...workspace, groups: workspace.groups.map((group) => group.id === targetOwner.id ? addWindow(group, source) : group), activeGroupId: targetOwner.id };
  if (sourceOwner && targetOwner && sourceOwner.id !== targetOwner.id) {
    const tab = sourceOwner.tabs.find((item) => item.runtimeWindowId === source.id);
    return tab ? moveTabToGroup(workspace, sourceOwner.id, tab.id, targetOwner.id) : workspace;
  }
  return workspace;
}
