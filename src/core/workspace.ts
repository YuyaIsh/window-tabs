import { reconnectGroupExcluding } from "./matching";
import type { TabEntry, TabGroup, WindowId, WindowInfo } from "./model";
import { addWindow } from "./groups";

export type Workspace = { groups: TabGroup[]; activeGroupId?: string };

export const emptyWorkspace = (): Workspace => ({ groups: [] });

export function activeGroup(workspace: Workspace): TabGroup | null {
  return workspace.groups.find((group) => group.id === workspace.activeGroupId) ?? null;
}

export function updateActiveGroup(workspace: Workspace, update: (group: TabGroup | null) => TabGroup | null): Workspace {
  const current = activeGroup(workspace);
  const next = update(current);
  if (!current) return next ? { groups: [...workspace.groups, next], activeGroupId: next.id } : workspace;
  if (!next) {
    const groups = workspace.groups.filter((group) => group.id !== current.id);
    return { groups, activeGroupId: groups[0]?.id };
  }
  return { ...workspace, groups: workspace.groups.map((group) => group.id === current.id ? next : group) };
}

export function addGroup(workspace: Workspace, group: TabGroup): Workspace {
  const occupied = new Set(workspace.groups.flatMap((item) => item.tabs.map((tab) => tab.runtimeWindowId).filter(Boolean)));
  if (workspace.groups.some((item) => item.id === group.id) || group.tabs.some((tab) => tab.runtimeWindowId && occupied.has(tab.runtimeWindowId))) return workspace;
  return { groups: [...workspace.groups, group], activeGroupId: group.id };
}

/** Authoritative transition for adding a real window to an existing group. */
export function addWindowToGroup(workspace: Workspace, groupId: string, window: WindowInfo): Workspace {
  if (groupForWindow(workspace, window.id)) return workspace;
  const group = workspace.groups.find((item) => item.id === groupId);
  if (!group) return workspace;
  return { ...workspace, groups: workspace.groups.map((item) => item.id === groupId ? addWindow(item, window) : item), activeGroupId: groupId };
}

/** Connects an unresolved preset tab while preserving global WindowId ownership. */
export function assignWindowToTab(workspace: Workspace, groupId: string, tabId: string, window: WindowInfo): Workspace {
  if (groupForWindow(workspace, window.id)) return workspace;
  const group = workspace.groups.find((item) => item.id === groupId);
  const tab = group?.tabs.find((item) => item.id === tabId);
  if (!group || !tab || tab.runtimeWindowId) return workspace;
  return { ...workspace, groups: workspace.groups.map((item) => item.id === groupId ? { ...item, activeTabId: tabId, tabs: item.tabs.map((candidate) => candidate.id === tabId ? { ...candidate, runtimeWindowId: window.id, status: window.state === "minimized" ? "minimized" : "connected" } : candidate) } : item), activeGroupId: groupId };
}

export function selectGroup(workspace: Workspace, groupId: string): Workspace {
  return workspace.groups.some((group) => group.id === groupId) ? { ...workspace, activeGroupId: groupId } : workspace;
}

/** Explicitly dissolve a group; unlike tab removal this may remove the last tab. */
export function dissolveGroup(workspace: Workspace, groupId: string): Workspace {
  const groups = workspace.groups.filter((group) => group.id !== groupId);
  return { groups, activeGroupId: groups.some((group) => group.id === workspace.activeGroupId) ? workspace.activeGroupId : groups[0]?.id };
}

export function groupForWindow(workspace: Workspace, windowId: WindowId): TabGroup | null {
  return workspace.groups.find((group) => group.tabs.some((tab) => tab.runtimeWindowId === windowId)) ?? null;
}

export function moveTabToGroup(workspace: Workspace, sourceGroupId: string, tabId: string, destinationGroupId: string): Workspace {
  if (sourceGroupId === destinationGroupId) return workspace;
  const source = workspace.groups.find((group) => group.id === sourceGroupId);
  const destination = workspace.groups.find((group) => group.id === destinationGroupId);
  const tab = source?.tabs.find((item) => item.id === tabId);
  if (!source || !destination || !tab || destination.tabs.some((item) => item.runtimeWindowId && item.runtimeWindowId === tab.runtimeWindowId)) return workspace;
  const sourceTabs = source.tabs.filter((item) => item.id !== tabId);
  const nextGroups = workspace.groups.flatMap((group) => {
    if (group.id === source.id) return sourceTabs.length ? [{ ...group, tabs: sourceTabs, activeTabId: source.activeTabId === tabId ? sourceTabs[0].id : source.activeTabId }] : [];
    if (group.id === destination.id) return [{ ...group, tabs: [...group.tabs, tab], activeTabId: tab.id }];
    return [group];
  });
  return { groups: nextGroups, activeGroupId: destination.id };
}

export function detachTab(workspace: Workspace, sourceGroupId: string, tabId: string): Workspace {
  const source = workspace.groups.find((group) => group.id === sourceGroupId);
  const tab = source?.tabs.find((item) => item.id === tabId);
  if (!source || !tab) return workspace;
  const detached: TabGroup = { id: crypto.randomUUID(), name: tab.name, tabs: [tab], activeTabId: tab.id, displayId: source.displayId, frame: source.frame };
  const sourceTabs = source.tabs.filter((item) => item.id !== tabId);
  const groups = workspace.groups.flatMap((group) => group.id !== source.id ? [group] : sourceTabs.length ? [{ ...source, tabs: sourceTabs, activeTabId: source.activeTabId === tabId ? sourceTabs[0].id : source.activeTabId }] : []).concat(detached);
  return { groups, activeGroupId: detached.id };
}

/** Reconnect preset groups in order while maintaining global WindowId ownership. */
export function reconnectWorkspace(workspace: Workspace, windows: WindowInfo[]): Workspace {
  const claimed = new Set<string>();
  const groups = workspace.groups.flatMap((group) => {
    if (group.presetId) {
      const next = reconnectGroupExcluding(group, windows, claimed);
      for (const tab of next.tabs) if (tab.runtimeWindowId) claimed.add(tab.runtimeWindowId);
      return [next];
    }
    const tabs = group.tabs.filter((tab) => {
      if (!tab.runtimeWindowId) return true;
      if (claimed.has(tab.runtimeWindowId)) return false;
      claimed.add(tab.runtimeWindowId);
      return true;
    });
    return tabs.length ? [{ ...group, tabs, activeTabId: tabs.some((tab) => tab.id === group.activeTabId) ? group.activeTabId : tabs[0]?.id }] : [];
  });
  return { groups, activeGroupId: groups.some((group) => group.id === workspace.activeGroupId) ? workspace.activeGroupId : groups[0]?.id };
}
