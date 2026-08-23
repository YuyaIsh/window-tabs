import type { TabEntry, TabGroup, WindowInfo, WindowMatchRule } from "./model";

export type MatchResult =
  | { kind: "connected"; window: WindowInfo }
  | { kind: "unresolved"; candidates: WindowInfo[] };

export function matchWindow(rule: WindowMatchRule | undefined, windows: WindowInfo[]): MatchResult {
  if (!rule) return { kind: "unresolved", candidates: [] };
  const candidates = windows.filter((window) => matchesRule(rule, window));
  return candidates.length === 1 ? { kind: "connected", window: candidates[0] } : { kind: "unresolved", candidates };
}

export function reconnectTab(tab: TabEntry, windows: WindowInfo[]): TabEntry {
  const result = matchWindow(tab.rule, windows);
  if (result.kind === "connected") return { ...tab, runtimeWindowId: result.window.id, status: result.window.state === "minimized" ? "minimized" : "connected" };
  return { ...tab, runtimeWindowId: undefined, status: "unresolved" };
}

export function reconnectGroup(group: TabGroup, windows: WindowInfo[]): TabGroup {
  return reconnectGroupExcluding(group, windows, new Set());
}

/** Reconnect a group without ever claiming a runtime window owned by another group. */
export function reconnectGroupExcluding(group: TabGroup, windows: WindowInfo[], occupied: ReadonlySet<string>): TabGroup {
  const byId = new Map(windows.map((window) => [window.id, window]));
  const used = new Set<string>(occupied);
  const tabs = group.tabs.map((tab) => {
    const existing = tab.runtimeWindowId ? byId.get(tab.runtimeWindowId) : undefined;
    if (existing && !used.has(existing.id)) { used.add(existing.id); return { ...tab, status: existing.state === "minimized" ? "minimized" as const : "connected" as const }; }
    const result = matchWindow(tab.rule, windows.filter((window) => !used.has(window.id)));
    if (result.kind === "connected") { used.add(result.window.id); return { ...tab, runtimeWindowId: result.window.id, status: result.window.state === "minimized" ? "minimized" as const : "connected" as const }; }
    return { ...tab, runtimeWindowId: undefined, status: "unresolved" as const };
  });
  return { ...group, tabs, activeTabId: tabs.some((tab) => tab.id === group.activeTabId) ? group.activeTabId : tabs.find((tab) => tab.status !== "unresolved")?.id };
}

function matchesRule(rule: WindowMatchRule, window: WindowInfo): boolean {
  const hint = rule.platformHints?.windows;
  if (hint?.executable && window.appId !== hint.executable) return false;
  if (hint?.executablePath && window.executablePath?.toLocaleLowerCase() !== hint.executablePath.toLocaleLowerCase()) return false;
  if (hint?.className && window.className !== hint.className) return false;
  if (rule.titlePattern) {
    try {
      if (!new RegExp(rule.titlePattern, "i").test(window.title)) return false;
    } catch {
      return false;
    }
  }
  return Boolean(hint?.executable || hint?.executablePath || hint?.className || rule.titlePattern);
}
