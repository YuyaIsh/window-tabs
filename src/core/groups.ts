import type { NormalizedFrame, TabEntry, TabGroup, WindowId, WindowInfo } from "./model";

const id = () => crypto.randomUUID();

const entryFor = (window: WindowInfo): TabEntry => ({
  id: id(),
  name: window.title || window.appName,
  runtimeWindowId: window.id,
  status: window.state === "minimized" ? "minimized" : "connected",
  rule: {
    platformHints: {
      windows: {
        executable: window.appId,
        executablePath: window.executablePath,
        className: window.className,
      },
    },
  },
});

export function newGroup(window: WindowInfo, frame: NormalizedFrame = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }): TabGroup {
  const tab = entryFor(window);
  return { id: id(), name: "新しいグループ", tabs: [tab], activeTabId: tab.id, displayId: window.displayId, frame };
}

export function addWindow(group: TabGroup, window: WindowInfo): TabGroup {
  if (group.tabs.some((tab) => tab.runtimeWindowId === window.id)) return group;
  const tab = entryFor(window);
  return { ...group, tabs: [...group.tabs, tab], activeTabId: tab.id };
}

export function selectTab(group: TabGroup, tabId: string): TabGroup {
  return group.tabs.some((tab) => tab.id === tabId) ? { ...group, activeTabId: tabId } : group;
}

export function reorderTab(group: TabGroup, sourceTabId: string, destinationTabId: string): TabGroup {
  const source = group.tabs.findIndex((tab) => tab.id === sourceTabId);
  const destination = group.tabs.findIndex((tab) => tab.id === destinationTabId);
  if (source < 0 || destination < 0 || source === destination) return group;
  const tabs = [...group.tabs];
  const [tab] = tabs.splice(source, 1);
  tabs.splice(destination, 0, tab);
  return { ...group, tabs };
}

export function ungroupWindow(group: TabGroup, windowId: WindowId): TabGroup | null {
  // The ordinary tab remove affordance must not implicitly destroy a one-tab
  // group. Full dissolution is an explicit workspace command.
  if (group.tabs.length <= 1 && group.tabs.some((tab) => tab.runtimeWindowId === windowId)) return group;
  const tabs = group.tabs.filter((tab) => tab.runtimeWindowId !== windowId);
  if (!tabs.length) return null;
  return { ...group, tabs, activeTabId: tabs.some((tab) => tab.id === group.activeTabId) ? group.activeTabId : tabs[0].id };
}
