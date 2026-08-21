import type { TabEntry, TabGroup, WindowId } from "./model";

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
  return { groups: [...workspace.groups, group], activeGroupId: group.id };
}

export function selectGroup(workspace: Workspace, groupId: string): Workspace {
  return workspace.groups.some((group) => group.id === groupId) ? { ...workspace, activeGroupId: groupId } : workspace;
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
