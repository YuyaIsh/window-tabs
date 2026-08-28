import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { LogicalSize, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { newGroup, selectTab, ungroupWindow } from "./core/groups";
import { calculateTabBarFrame, TAB_BAR_OFFSET } from "./core/geometry";
import { applyNativeDrop, applyWorkspaceCommand } from "./core/controller";
import { reconnectGroupExcluding } from "./core/matching";
import { diagnostics, recordDiagnostic } from "./core/diagnostics";
import { reconcileGroupHosts } from "./core/hostLifecycle";
import { assignmentPickerContext, closedPickerContext, groupPickerContext, newGroupPickerContext, type PickerContext } from "./core/pickerContext";
import { groupToPreset, loadPresets, resolvePresetGeometry, savePresets, upsertPreset } from "./core/presets";
import { ownsUpdater, UpdateController, type UpdateState } from "./core/updater";
import { addGroup, addWindowToGroup, assignWindowToTab, detachTab, dissolveGroup, emptyWorkspace, groupForWindow, moveTabToGroup, selectGroup } from "./core/workspace";
import type { DisplayInfo, Preset, TabGroup, WindowInfo } from "./core/model";
import type { NativeWindowEvent } from "./platform-client/windowBackend";
import { windowBackend } from "./platform-client/windowBackend";
import "./styles.css";

const fromPreset = (preset: Preset, displayId: string): TabGroup => ({ id: crypto.randomUUID(), presetId: preset.id, name: preset.name, displayId, frame: preset.frame, tabs: preset.tabs.map((tab) => ({ ...tab, status: "unresolved" })) });
const hostGroupId = new URLSearchParams(window.location.search).get("group") ?? undefined;
const isController = ownsUpdater(hostGroupId);
const COMPACT_HEIGHT = 120;
const OVERLAY_HEIGHT = 640;
const RELEASES_URL = "https://github.com/YuyaIsh/window-tabs/releases";
type ControllerCommand =
  | { type: "open-picker"; groupId?: string; creatingGroup?: boolean }
  | { type: "open-preset-manager" }
  | { type: "add-window"; groupId?: string; windowId: string; assigningTabId?: string; creatingGroup: boolean }
  | { type: "select-tab"; groupId: string; tabId: string }
  | { type: "reorder-tab"; groupId: string; sourceTabId: string; destinationTabId: string }
  | { type: "detach-tab"; groupId: string; tabId: string }
  | { type: "release-tab"; groupId: string; tabId: string }
  | { type: "ungroup"; groupId: string; windowId: string }
  | { type: "focus-group"; groupId: string }
  | { type: "move-tab"; groupId: string; tabId: string; destinationGroupId: string }
  | { type: "move-display"; groupId: string; direction: 1 | -1 }
  | { type: "save-preset"; groupId: string }
  | { type: "rename-tab"; groupId: string; tabId: string }
  | { type: "delete-preset"; presetId: string }
  | { type: "set-preset-matcher"; presetId: string; tabIndex: number; titlePattern: string }
  | { type: "apply-preset"; presetId: string }
  | { type: "host-moved"; groupId: string; x: number; y: number }
  | { type: "dissolve-group"; groupId: string };

const pinBarTo = async (frame: WindowInfo["frame"], display?: DisplayInfo) => {
  if (isController) return;
  const appWindow = getCurrentWindow();
  const bar = calculateTabBarFrame(frame, display);
  await appWindow.setSize(new PhysicalSize(bar.width, COMPACT_HEIGHT));
  await appWindow.setPosition(new PhysicalPosition(bar.x, bar.y));
};
const normalizeFrame = (frame: WindowInfo["frame"], display: DisplayInfo | undefined) => !display ? { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } : { x: (frame.x - display.workArea.x) / display.workArea.width, y: (frame.y - display.workArea.y) / display.workArea.height, width: frame.width / display.workArea.width, height: frame.height / display.workArea.height };
const denormalizeFrame = (frame: TabGroup["frame"], display: DisplayInfo): WindowInfo["frame"] => ({ x: Math.round(display.workArea.x + display.workArea.width * frame.x), y: Math.round(display.workArea.y + display.workArea.height * frame.y), width: Math.round(display.workArea.width * frame.width), height: Math.round(display.workArea.height * frame.height) });
const displayForFrame = (frame: WindowInfo["frame"], displays: DisplayInfo[]) => {
  const centerX = frame.x + frame.width / 2;
  const centerY = frame.y + frame.height / 2;
  return displays.find((display) => centerX >= display.workArea.x && centerX < display.workArea.x + display.workArea.width && centerY >= display.workArea.y && centerY < display.workArea.y + display.workArea.height) ?? displays.find((display) => display.primary);
};

function App() {
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [workspace, setWorkspace] = useState(emptyWorkspace);
  const [presets, setPresets] = useState<Preset[]>(() => loadPresets());
  const [picker, setPicker] = useState(false);
  const [pickerContext, setPickerContext] = useState<PickerContext>(closedPickerContext);
  const [controllerPresetManager, setPresetManager] = useState(false);
  // Secondary hosts may forward this request, but never render the controller overlay.
  const presetManager = isController && controllerPresetManager;
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState>({ status: "idle" });
  const [menuOpen, setMenuOpen] = useState(false);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [tabDragSession, setTabDragSession] = useState<{ sourceGroupId: string; tabId: string } | null>(null);
  const [nativeDragId, setNativeDragId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingFrameMutations = useRef(new Map<string, number>());
  const settledFrameTimers = useRef(new Map<string, number>());
  const missingWindowPolls = useRef(new Map<string, number>());
  const workspaceChannel = useRef<BroadcastChannel | null>(null);
  const workspaceRef = useRef(workspace);
  const windowsRef = useRef(windows);
  const displaysRef = useRef(displays);
  const presetsRef = useRef(presets);
  const workspaceSynced = useRef(!hostGroupId);
  const suppressWorkspaceBroadcast = useRef(false);
  const hostedGroupIds = useRef(new Set<string>());
  const tabDragSessionRef = useRef<typeof tabDragSession>(null);
  const tabDragCancelled = useRef(false);
  const controllerCommandHandler = useRef<(command: ControllerCommand) => void>();
  const updater = useRef(isController ? new UpdateController() : null);
  // The controller never renders a group bar. Every group is represented by
  // its own `?group=<id>` native host, independently of activeGroupId.
  const group = hostGroupId ? workspace.groups.find((item) => item.id === hostGroupId) ?? null : null;
  const setFrame = async (id: string, frame: WindowInfo["frame"]) => {
    pendingFrameMutations.current.set(id, Date.now() + 1_000);
    try { await windowBackend.setFrame(id, frame); }
    catch (reason) { const message = reason instanceof Error ? reason.message : "ウィンドウの配置を更新できませんでした。"; pendingFrameMutations.current.delete(id); recordDiagnostic("error", message); setError(message); }
  };
  const sendCommand = (command: ControllerCommand) => workspaceChannel.current?.postMessage({ type: "controller-command", command });
  const applyUpdateState = (state: UpdateState) => {
    setUpdateState(state);
    if (state.status === "available") setUpdateOpen(true);
    if (state.status === "error" && state.error) recordDiagnostic("error", `Update: ${state.error}`);
  };
  const checkForUpdates = (manual: boolean) => {
    if (!isController || !updater.current) return;
    if (manual) setUpdateOpen(true);
    void updater.current.check(applyUpdateState);
  };

  const refresh = async () => {
    try {
      const [nextWindows, nextDisplays] = await Promise.all([windowBackend.listWindows(), windowBackend.listDisplays()]);
      setWindows(nextWindows); setDisplays(nextDisplays); setError(null);
      return { windows: nextWindows, displays: nextDisplays };
    }
    catch (reason) {
      const message = reason instanceof Error ? reason.message : "ウィンドウ一覧を取得できませんでした。";
      recordDiagnostic("error", message); setError(message);
      return { windows: windowsRef.current, displays: displaysRef.current };
    }
  };
  const startNewGroup = () => {
    if (!isController) {
      sendCommand({ type: "open-picker", creatingGroup: true });
      return;
    }
    setPickerContext(newGroupPickerContext()); void refresh(); setPicker(true);
  };
  const focusGroup = (groupId: string) => {
    if (!isController) { sendCommand({ type: "focus-group", groupId }); return; }
    const next = selectGroup(workspace, groupId);
    const targetGroup = next.groups.find((item) => item.id === groupId);
    const targetTab = targetGroup?.tabs.find((tab) => tab.id === targetGroup.activeTabId) ?? targetGroup?.tabs.find((tab) => tab.runtimeWindowId);
    setWorkspace(next); setMenuOpen(false);
    const targetWindowId = targetTab?.runtimeWindowId;
    if (targetWindowId) void (async () => {
      try {
        if (targetTab?.status === "minimized") await windowBackend.restore(targetWindowId);
        await windowBackend.activate(targetWindowId);
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : "ウィンドウを前面化できませんでした。";
        recordDiagnostic("error", message); setError(message);
      }
    })();
  };

  useEffect(() => { if (isController) void refresh(); }, []);
  useEffect(() => {
    if (!isController) return;
    const timer = window.setTimeout(() => checkForUpdates(false), 1_500);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    const channel = new BroadcastChannel("window-tabs-workspace");
    workspaceChannel.current = channel;
    channel.onmessage = ({ data }) => {
      if (data?.type === "workspace-request" && isController) channel.postMessage({ type: "workspace-snapshot", workspace: workspaceRef.current, windows: windowsRef.current, displays: displaysRef.current, presets: presetsRef.current });
      if (data?.type === "workspace-snapshot" && !isController && data.workspace) { workspaceSynced.current = true; suppressWorkspaceBroadcast.current = true; setWorkspace(data.workspace); if (Array.isArray(data.windows)) setWindows(data.windows); if (Array.isArray(data.displays)) setDisplays(data.displays); if (Array.isArray(data.presets)) setPresets(data.presets); }
      if (data?.type === "controller-command" && isController) controllerCommandHandler.current?.(data.command);
      if (data?.type === "tab-drag-start") {
        const next = { sourceGroupId: data.groupId, tabId: data.tabId };
        tabDragCancelled.current = false; tabDragSessionRef.current = next; setTabDragSession(next);
      }
      if (data?.type === "tab-drag-end") { tabDragSessionRef.current = null; setTabDragSession(null); }
    };
    if (hostGroupId) channel.postMessage({ type: "workspace-request" });
    return () => channel.close();
  }, []);
  useEffect(() => {
    workspaceRef.current = workspace;
    windowsRef.current = windows;
    displaysRef.current = displays;
    presetsRef.current = presets;
    if (!isController || !workspaceSynced.current) return;
    if (suppressWorkspaceBroadcast.current) { suppressWorkspaceBroadcast.current = false; return; }
    workspaceChannel.current?.postMessage({ type: "workspace-snapshot", workspace, windows: windowsRef.current, displays: displaysRef.current, presets });
  }, [workspace, windows, displays, presets]);
  useEffect(() => {
    if (!isController) return;
    const lifecycle = reconcileGroupHosts(hostedGroupIds.current, workspace);
    for (const groupId of lifecycle.open) void windowBackend.openGroupHost(groupId);
    for (const groupId of lifecycle.close) void windowBackend.closeGroupHost(groupId);
    hostedGroupIds.current = new Set(workspace.groups.map((item) => item.id));
  }, [workspace.groups]);
  useEffect(() => {
    if (!isController) return;
    const controllerWindow = getCurrentWindow();
    if (picker || presetManager || diagnosticsOpen || updateOpen) void controllerWindow.show().then(() => controllerWindow.setFocus());
    else void controllerWindow.hide();
  }, [picker, presetManager, diagnosticsOpen, updateOpen]);
  useEffect(() => {
    const overlayOpen = picker || presetManager || diagnosticsOpen || updateOpen;
    if (overlayOpen) { void getCurrentWindow().setSize(new LogicalSize(720, OVERLAY_HEIGHT)); return; }
    if (group) {
      const display = displays.find((item) => item.id === group.displayId) ?? displays.find((item) => item.primary);
      if (display) { void pinBarTo(denormalizeFrame(group.frame, display), display); return; }
    }
    const connected = group?.tabs.map((tab) => tab.runtimeWindowId).find(Boolean);
    const windowInfo = windows.find((item) => item.id === connected);
    if (windowInfo) { void pinBarTo(windowInfo.frame, displays.find((item) => item.id === windowInfo.displayId)); return; }
    void getCurrentWindow().setSize(new LogicalSize(720, COMPACT_HEIGHT));
  }, [group, picker, presetManager, diagnosticsOpen, updateOpen, windows, displays]);
  useEffect(() => {
    if (!hostGroupId || !group) return;
    const display = displays.find((item) => item.id === group.displayId) ?? displays.find((item) => item.primary);
    if (display) void pinBarTo(denormalizeFrame(group.frame, display), display);
  }, [group?.id, hostGroupId, windows]);
  useEffect(() => {
    if (!isController) return;
    const primary = displays.find((display) => display.primary);
    if (!primary) return;
    const missing = workspace.groups.filter((item) => !displays.some((display) => display.id === item.displayId));
    if (!missing.length) return;
    for (const item of missing) {
      const frame = denormalizeFrame(item.frame, primary);
      for (const tab of item.tabs) if (tab.runtimeWindowId) void setFrame(tab.runtimeWindowId, frame);
      if (item.id === group?.id) void pinBarTo(frame);
    }
    setWorkspace((current) => ({ ...current, groups: current.groups.map((item) => !displays.some((display) => display.id === item.displayId) ? { ...item, displayId: primary.id } : item) }));
  }, [displays, workspace.groups, group?.id]);
  useEffect(() => {
    let dispose: (() => void) | undefined;
    void getCurrentWindow().onMoved(({ payload }) => {
      if (!group) return;
      if (!isController) { sendCommand({ type: "host-moved", groupId: group.id, x: payload.x, y: payload.y }); return; }
      const frame = { x: payload.x, y: payload.y + TAB_BAR_OFFSET, width: Math.max(1, Math.round(group.frame.width * (displays.find((display) => display.id === group.displayId)?.workArea.width ?? 1))), height: Math.max(1, Math.round(group.frame.height * (displays.find((display) => display.id === group.displayId)?.workArea.height ?? 1))) };
      const display = displayForFrame(frame, displays);
      if (!display) return;
      const destination = denormalizeFrame({ ...normalizeFrame(frame, display), width: group.frame.width, height: group.frame.height }, display);
      for (const tab of group.tabs) if (tab.runtimeWindowId) void setFrame(tab.runtimeWindowId, destination);
      setWorkspace((current) => ({ ...current, groups: current.groups.map((item) => item.id === group.id ? { ...item, displayId: display.id, frame: normalizeFrame(destination, display) } : item) }));
    }).then((unlisten) => { dispose = unlisten; });
    return () => dispose?.();
  }, [group, displays]);
  useEffect(() => {
    if (!isController) return;
    savePresets(presets);
    void windowBackend.setTrayPresets(presets.map(({ id, name }) => ({ id, name }))).catch(() => undefined);
  }, [presets]);
  useEffect(() => {
    if (!isController) return;
    const unsubscribe = listen("launcher:new-group", startNewGroup);
    return () => { void unsubscribe.then((dispose) => dispose()); };
  }, [workspace]);
  useEffect(() => {
    if (!isController) return;
    const unsubscribe = listen("launcher:open-presets", () => { setMenuOpen(false); setPresetManager(true); });
    return () => { void unsubscribe.then((dispose) => dispose()); };
  }, []);
  useEffect(() => {
    if (!isController) return;
    const unsubscribe = listen("launcher:check-updates", () => checkForUpdates(true));
    return () => { void unsubscribe.then((dispose) => dispose()); };
  }, []);
  useEffect(() => {
    if (!isController) return;
    const unsubscribe = listen<string>("launcher:apply-preset", ({ payload }) => {
      const preset = presets.find((item) => item.id === payload);
      if (preset) void applyPreset(preset);
    });
    return () => { void unsubscribe.then((dispose) => dispose()); };
  }, [presets, workspace, displays, windows]);
  useEffect(() => {
    if (!isController) return;
    const unsubscribe = listen<NativeWindowEvent>("window-event", ({ payload }) => {
      if (payload.kind === "focused") setWorkspace((current) => {
        const owner = groupForWindow(current, payload.id);
        const tabId = owner?.tabs.find((tab) => tab.runtimeWindowId === payload.id)?.id;
        return owner && tabId ? { ...current, groups: current.groups.map((item) => item.id === owner.id ? selectTab(item, tabId) : item), activeGroupId: owner.id } : current;
      });
      if (payload.kind === "drag-start") setNativeDragId(payload.id);
      if (payload.kind === "minimized" || payload.kind === "restored") setWorkspace((current) => ({ ...current, groups: current.groups.map((item) => ({ ...item, tabs: item.tabs.map((tab) => tab.runtimeWindowId === payload.id ? { ...tab, status: payload.kind === "minimized" ? "minimized" : "connected" } : tab) })) }));
      if (payload.kind === "destroyed") setWorkspace((current) => {
        const groups = current.groups.map((item) => item.presetId ? { ...item, tabs: item.tabs.map((tab) => tab.runtimeWindowId === payload.id ? { ...tab, runtimeWindowId: undefined, status: "unresolved" as const } : tab) } : { ...item, tabs: item.tabs.filter((tab) => tab.runtimeWindowId !== payload.id) }).filter((item) => item.tabs.length > 0);
        return { groups, activeGroupId: groups.some((item) => item.id === current.activeGroupId) ? current.activeGroupId : groups[0]?.id };
      });
      if (payload.kind === "frame-settled" && payload.frame) {
        const previous = settledFrameTimers.current.get(payload.id);
        if (previous) window.clearTimeout(previous);
        const frame = payload.frame;
        const timer = window.setTimeout(() => setWorkspace((current) => {
          const now = Date.now();
          const until = pendingFrameMutations.current.get(payload.id);
          if (until && until >= now) { pendingFrameMutations.current.delete(payload.id); return current; }
          const owner = groupForWindow(current, payload.id);
          if (!owner || owner.activeTabId !== owner.tabs.find((tab) => tab.runtimeWindowId === payload.id)?.id) return current;
          for (const tab of owner.tabs) if (tab.runtimeWindowId && tab.runtimeWindowId !== payload.id) void setFrame(tab.runtimeWindowId, frame);
          const display = displayForFrame(frame, displays);
          if (owner.id === workspaceRef.current.activeGroupId) void pinBarTo(frame, display);
          return { ...current, groups: current.groups.map((item) => item.id === owner.id ? { ...item, displayId: display?.id ?? item.displayId, frame: normalizeFrame(frame, display) } : item) };
        }), 150);
        settledFrameTimers.current.set(payload.id, timer);
      }
      if (payload.kind === "drag-end" && payload.target) setWorkspace((current) => {
        const source = windows.find((window) => window.id === payload.id); const target = windows.find((window) => window.id === payload.target);
        if (!source || !target) return current;
        const next = applyNativeDrop(current, source, target);
        const owner = groupForWindow(next, source.id) ?? groupForWindow(next, target.id);
        const display = (owner && displays.find((item) => item.id === owner.displayId)) ?? displays.find((item) => item.primary);
        const frame = owner && display ? denormalizeFrame(owner.frame, display) : source.frame;
        for (const tab of owner?.tabs ?? []) if (tab.runtimeWindowId) void setFrame(tab.runtimeWindowId, frame);
        return next;
      });
      if (payload.kind === "drag-end") setNativeDragId(null);
    });
    return () => { void unsubscribe.then((dispose) => dispose()); };
  }, [displays, windows]);
  useEffect(() => {
    if (!isController) return;
    const timer = window.setInterval(() => { void Promise.all([windowBackend.listWindows(), windowBackend.listDisplays()]).then(([currentWindows, currentDisplays]) => {
      const available = new Set(currentWindows.map((item) => item.id)); setWindows(currentWindows); setDisplays(currentDisplays);
      setWorkspace((current) => {
        const occupied = new Set(current.groups.filter((item) => !item.presetId).flatMap((item) => item.tabs.map((tab) => tab.runtimeWindowId).filter((id): id is string => Boolean(id))));
        const groups = current.groups.map((item) => {
          if (item.presetId) {
            const next = reconnectGroupExcluding(item, currentWindows, occupied);
            for (const tab of next.tabs) if (tab.runtimeWindowId) occupied.add(tab.runtimeWindowId);
            const display = currentDisplays.find((display) => display.id === next.displayId) ?? currentDisplays.find((display) => display.primary);
            if (display) for (const tab of next.tabs) {
              const previous = item.tabs.find((candidate) => candidate.id === tab.id);
              if (!previous?.runtimeWindowId && tab.runtimeWindowId) void setFrame(tab.runtimeWindowId, denormalizeFrame(next.frame, display));
            }
            return next;
          }
          const tabs = item.tabs.flatMap((tab) => {
            if (!tab.runtimeWindowId || available.has(tab.runtimeWindowId)) { if (tab.runtimeWindowId) missingWindowPolls.current.delete(tab.runtimeWindowId); return [tab]; }
            const misses = (missingWindowPolls.current.get(tab.runtimeWindowId) ?? 0) + 1;
            missingWindowPolls.current.set(tab.runtimeWindowId, misses);
            return misses < 3 ? [tab] : [];
          });
          return { ...item, tabs };
        }).filter((item) => item.tabs.length > 0);
        return { groups, activeGroupId: groups.some((item) => item.id === current.activeGroupId) ? current.activeGroupId : groups[0]?.id };
      });
    }).catch(() => undefined); }, 2000);
    return () => window.clearInterval(timer);
  }, []);
  const connectedIds = useMemo(() => new Set(workspace.groups.flatMap((item) => item.tabs.map((tab) => tab.runtimeWindowId).filter(Boolean))), [workspace]);

  const select = async (tabId: string, groupId = group?.id) => {
    if (!groupId) return;
    if (!isController) { sendCommand({ type: "select-tab", groupId, tabId }); return; }
    const selectedGroup = workspaceRef.current.groups.find((item) => item.id === groupId);
    if (!selectedGroup) return;
    const next = selectTab(selectedGroup, tabId);
    setWorkspace((current) => applyWorkspaceCommand(current, { type: "select-tab", groupId, tabId }));
    const target = next.tabs.find((tab) => tab.id === tabId);
    if (!target?.runtimeWindowId) { setPickerContext(assignmentPickerContext(groupId, tabId)); void refresh(); setPicker(true); return; }
    try { if (target.status === "minimized") await windowBackend.restore(target.runtimeWindowId); await windowBackend.activate(target.runtimeWindowId); }
    catch (reason) { const message = reason instanceof Error ? reason.message : "ウィンドウを前面化できませんでした。"; recordDiagnostic("error", message); setError(message); }
  };
  const add = async (windowInfo: WindowInfo, targetGroupId?: string, targetAssigningTabId?: string, targetCreatingGroup = false) => {
    if (!isController) {
      sendCommand({ type: "add-window", groupId: targetGroupId, windowId: windowInfo.id, assigningTabId: targetAssigningTabId ?? undefined, creatingGroup: targetCreatingGroup });
      setPickerContext(closedPickerContext()); setPicker(false); return;
    }
    const targetGroup = targetGroupId ? workspaceRef.current.groups.find((item) => item.id === targetGroupId) : undefined;
    if (targetAssigningTabId && targetGroup) {
      const display = displaysRef.current.find((item) => item.id === targetGroup.displayId) ?? displaysRef.current.find((item) => item.primary);
      if (!groupForWindow(workspaceRef.current, windowInfo.id)) {
        if (display) await setFrame(windowInfo.id, denormalizeFrame(targetGroup.frame, display));
        setWorkspace((current) => assignWindowToTab(current, targetGroup.id, targetAssigningTabId, windowInfo));
      }
      setPickerContext(closedPickerContext()); setPicker(false); return;
    }
    if (targetGroup && !targetCreatingGroup) {
      if (groupForWindow(workspaceRef.current, windowInfo.id)) return;
      const anchorId = targetGroup.activeTabId ? targetGroup.tabs.find((tab) => tab.id === targetGroup.activeTabId)?.runtimeWindowId : targetGroup.tabs[0]?.runtimeWindowId;
      const anchor = windows.find((item) => item.id === anchorId);
      if (anchor && anchor.id !== windowInfo.id) { await setFrame(windowInfo.id, anchor.frame); await pinBarTo(anchor.frame); }
      setWorkspace((current) => addWindowToGroup(current, targetGroup.id, windowInfo));
    } else {
      await pinBarTo(windowInfo.frame, displays.find((display) => display.id === windowInfo.displayId));
      const created = newGroup(windowInfo, normalizeFrame(windowInfo.frame, displays.find((display) => display.id === windowInfo.displayId)));
      setWorkspace((current) => addGroup(current, created));
    }
    setPickerContext(closedPickerContext()); setPicker(false);
  };
  const saveCurrentPreset = (groupId = group?.id) => {
    if (!groupId) return;
    if (!isController) { sendCommand({ type: "save-preset", groupId }); return; }
    const target = workspaceRef.current.groups.find((item) => item.id === groupId);
    if (!target) return;
    const name = window.prompt("プリセット名", target.name)?.trim(); if (!name) return;
    const active = target.tabs.find((tab) => tab.id === target.activeTabId);
    const titlePattern = active ? window.prompt("選択タブのタイトル正規表現（任意。空欄なら実行ファイルだけで安全に照合）", active.rule?.titlePattern ?? "")?.trim() : "";
    const nextGroup = active ? { ...target, tabs: target.tabs.map((tab) => tab.id === active.id ? { ...tab, rule: { ...tab.rule, titlePattern: titlePattern || undefined } } : tab) } : target;
    const preset = groupToPreset(nextGroup, displays.find((display) => display.id === nextGroup.displayId), name);
    setPresets((current) => upsertPreset(current, preset));
    setWorkspace((current) => ({ ...current, groups: current.groups.map((item) => item.id === groupId ? { ...nextGroup, name, presetId: preset.id } : item) }));
    setMenuOpen(false);
  };
  const moveGroupDisplay = async (direction: 1 | -1, groupId = group?.id) => {
    if (!groupId || displays.length < 2) return;
    if (!isController) { sendCommand({ type: "move-display", groupId, direction }); return; }
    const target = workspaceRef.current.groups.find((item) => item.id === groupId);
    if (!target) return;
    const current = Math.max(0, displays.findIndex((display) => display.id === target.displayId));
    const destination = displays[(current + direction + displays.length) % displays.length];
    const frame = denormalizeFrame(target.frame, destination);
    await Promise.all(target.tabs.flatMap((tab) => tab.runtimeWindowId ? [setFrame(tab.runtimeWindowId, frame)] : []));
    await pinBarTo(frame);
    setWorkspace((currentWorkspace) => ({ ...currentWorkspace, groups: currentWorkspace.groups.map((item) => item.id === groupId ? { ...item, displayId: destination.id } : item) }));
  };
  const moveTab = async (sourceGroupId: string, tabId: string, destinationGroupId: string) => {
    const source = workspaceRef.current.groups.find((item) => item.id === sourceGroupId);
    const destination = workspaceRef.current.groups.find((item) => item.id === destinationGroupId);
    const tab = source?.tabs.find((item) => item.id === tabId);
    const display = destination && (displaysRef.current.find((item) => item.id === destination.displayId) ?? displaysRef.current.find((item) => item.primary));
    if (!source || !destination || !tab || !display) return;
    if (tab.runtimeWindowId) await setFrame(tab.runtimeWindowId, denormalizeFrame(destination.frame, display));
    setWorkspace((current) => moveTabToGroup(current, sourceGroupId, tabId, destinationGroupId));
  };
  const moveSelectedTab = (destinationGroupId: string) => {
    if (!group?.activeTabId) return;
    if (!isController) { sendCommand({ type: "move-tab", groupId: group.id, tabId: group.activeTabId, destinationGroupId }); return; }
    void moveTab(group.id, group.activeTabId, destinationGroupId); setMenuOpen(false);
  };
  const detachSelectedTab = () => {
    if (!group?.activeTabId) return;
    if (!isController) { sendCommand({ type: "detach-tab", groupId: group.id, tabId: group.activeTabId }); return; }
    const next = detachTab(workspace, group.id, group.activeTabId!);
    const sourceSurvives = group.tabs.length > 1;
    const remainingActive = sourceSurvives ? group.id : workspace.groups.find((item) => item.id !== group.id)?.id;
    setWorkspace({ ...next, activeGroupId: remainingActive ?? next.activeGroupId });
    setMenuOpen(false);
  };
  const endTabDrag = () => {
    tabDragSessionRef.current = null;
    workspaceChannel.current?.postMessage({ type: "tab-drag-end" });
    setDraggingTabId(null); setTabDragSession(null);
  };
  const releaseDraggedTab = (sourceGroupId: string, tabId: string) => {
    if (!workspaceRef.current.groups.some((item) => item.id === sourceGroupId && item.tabs.some((tab) => tab.id === tabId))) return;
    if (isController) setWorkspace((current) => applyWorkspaceCommand(current, { type: "release-tab", groupId: sourceGroupId, tabId }));
    else sendCommand({ type: "release-tab", groupId: sourceGroupId, tabId });
    endTabDrag();
  };
  const beginTabDrag = (sourceGroupId: string, tabId: string) => {
    const drag = { sourceGroupId, tabId };
    tabDragCancelled.current = false; tabDragSessionRef.current = drag;
    setDraggingTabId(tabId); setTabDragSession(drag);
    workspaceChannel.current?.postMessage({ type: "tab-drag-start", groupId: sourceGroupId, tabId });
  };
  const dropTabOn = (destinationTabId: string) => {
    const drag = tabDragSessionRef.current;
    if (!drag || !group) return;
    if (drag.sourceGroupId === group.id) {
      if (isController) setWorkspace((current) => applyWorkspaceCommand(current, { type: "reorder-tab", groupId: group.id, sourceTabId: drag.tabId, destinationTabId }));
      else sendCommand({ type: "reorder-tab", groupId: group.id, sourceTabId: drag.tabId, destinationTabId });
    }
    else if (isController) void moveTab(drag.sourceGroupId, drag.tabId, group.id);
    else sendCommand({ type: "move-tab", groupId: drag.sourceGroupId, tabId: drag.tabId, destinationGroupId: group.id });
    endTabDrag();
  };
  const dropTabOnGroup = () => {
    const drag = tabDragSessionRef.current;
    if (!drag || !group) return;
    // Every part of a group host is an inside drop zone. A same-group drop on
    // its empty area is intentionally a no-op; another host receives the tab.
    if (drag.sourceGroupId !== group.id) {
      if (isController) void moveTab(drag.sourceGroupId, drag.tabId, group.id);
      else sendCommand({ type: "move-tab", groupId: drag.sourceGroupId, tabId: drag.tabId, destinationGroupId: group.id });
    }
    endTabDrag();
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && tabDragSessionRef.current) tabDragCancelled.current = true;
    };
    const onDragEnd = () => {
      window.setTimeout(() => {
        const drag = tabDragSessionRef.current;
        if (drag && !tabDragCancelled.current) releaseDraggedTab(drag.sourceGroupId, drag.tabId);
        else if (drag) endTabDrag();
        tabDragCancelled.current = false;
      }, 150);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("dragend", onDragEnd, true);
    return () => { window.removeEventListener("keydown", onKeyDown, true); window.removeEventListener("dragend", onDragEnd, true); };
  }, [workspace]);
  const renameSelectedTab = (groupId = group?.id, tabId = group?.activeTabId) => {
    if (!groupId || !tabId) return;
    if (!isController) { sendCommand({ type: "rename-tab", groupId, tabId }); return; }
    const target = workspaceRef.current.groups.find((item) => item.id === groupId);
    const tab = target?.tabs.find((item) => item.id === tabId);
    const name = tab && window.prompt("タブ名", tab.name)?.trim();
    if (name) setWorkspace((current) => ({ ...current, groups: current.groups.map((item) => item.id === groupId ? { ...item, tabs: item.tabs.map((candidate) => candidate.id === tab!.id ? { ...candidate, name } : candidate) } : item) }));
    setMenuOpen(false);
  };
  const applyPreset = async (preset: Preset) => {
    if (!isController) { sendCommand({ type: "apply-preset", presetId: preset.id }); return; }
    const refreshed = await refresh(); const geometry = resolvePresetGeometry(preset, refreshed.displays); const draft = fromPreset(preset, geometry.display?.id ?? refreshed.displays.find((item) => item.primary)?.id ?? "primary");
    const occupied = new Set(workspaceRef.current.groups.flatMap((item) => item.tabs.map((tab) => tab.runtimeWindowId).filter((id): id is string => Boolean(id))));
    const next = reconnectGroupExcluding(draft, refreshed.windows, occupied);
    const frame = geometry.frame;
    for (const tab of next.tabs) if (tab.runtimeWindowId && frame) await setFrame(tab.runtimeWindowId, frame);
    if (frame) await pinBarTo(frame);
    setWorkspace((current) => addGroup(current, next));
    setMenuOpen(false); setPresetManager(false);
  };
  const ungroup = (windowId: string | undefined) => {
    if (!windowId || !group) return;
    if (!isController) { sendCommand({ type: "ungroup", groupId: group.id, windowId }); return; }
    setWorkspace((current) => ({ ...current, groups: current.groups.map((item) => item.id === group.id ? ungroupWindow(item, windowId) ?? item : item) }));
  };
  const deletePreset = (presetId: string) => {
    if (!isController) { sendCommand({ type: "delete-preset", presetId }); return; }
    setPresets((current) => current.filter((preset) => preset.id !== presetId));
  };
  const dissolveActiveGroup = () => {
    if (!group) return;
    if (!isController) { sendCommand({ type: "dissolve-group", groupId: group.id }); return; }
    setWorkspace((current) => dissolveGroup(current, group.id));
    setMenuOpen(false);
  };
  const editPresetMatcher = (preset: Preset) => {
    const tabNumber = Number(window.prompt(`条件を編集するタブ番号 (1-${preset.tabs.length})`, "1"));
    if (!Number.isInteger(tabNumber) || tabNumber < 1 || tabNumber > preset.tabs.length) return;
    const tab = preset.tabs[tabNumber - 1];
    const titlePattern = window.prompt(`${tab.name} のタイトル正規表現（空欄で解除）`, tab.rule?.titlePattern ?? "");
    if (titlePattern === null) return;
    const command = { type: "set-preset-matcher" as const, presetId: preset.id, tabIndex: tabNumber - 1, titlePattern: titlePattern.trim() };
    if (!isController) { sendCommand(command); return; }
    setPresets((current) => current.map((item) => item.id !== command.presetId ? item : { ...item, tabs: item.tabs.map((candidate, index) => index === command.tabIndex ? { ...candidate, rule: { ...candidate.rule, titlePattern: command.titlePattern || undefined } } : candidate), updatedAt: new Date().toISOString() }));
  };
  controllerCommandHandler.current = (command) => {
    const current = workspaceRef.current;
    switch (command.type) {
      case "open-picker":
        setWorkspace((state) => command.groupId ? selectGroup(state, command.groupId) : state);
        setPickerContext(command.creatingGroup ? newGroupPickerContext() : command.groupId ? groupPickerContext(command.groupId) : closedPickerContext()); void refresh(); setPicker(true); break;
      case "open-preset-manager": setMenuOpen(false); setPresetManager(true); break;
      case "add-window": {
        const windowInfo = windowsRef.current.find((item) => item.id === command.windowId);
        if (windowInfo) void add(windowInfo, command.groupId, command.assigningTabId, command.creatingGroup);
        break;
      }
      case "select-tab": void select(command.tabId, command.groupId); break;
      case "focus-group": focusGroup(command.groupId); break;
      case "reorder-tab": setWorkspace((state) => applyWorkspaceCommand(state, { type: "reorder-tab", groupId: command.groupId, sourceTabId: command.sourceTabId, destinationTabId: command.destinationTabId })); break;
      case "move-tab": void moveTab(command.groupId, command.tabId, command.destinationGroupId); break;
      case "release-tab": setWorkspace((state) => applyWorkspaceCommand(state, { type: "release-tab", groupId: command.groupId, tabId: command.tabId })); break;
      case "ungroup": setWorkspace((state) => applyWorkspaceCommand(state, { type: "ungroup", groupId: command.groupId, windowId: command.windowId })); break;
      case "detach-tab": {
        const next = applyWorkspaceCommand(current, { type: "detach-tab", groupId: command.groupId, tabId: command.tabId });
        setWorkspace(next); break;
      }
      case "apply-preset": { const preset = presets.find((item) => item.id === command.presetId); if (preset) void applyPreset(preset); break; }
      case "host-moved": {
        const target = current.groups.find((item) => item.id === command.groupId);
        if (!target) break;
        const oldDisplay = displays.find((item) => item.id === target.displayId);
        const frame = { x: command.x, y: command.y + TAB_BAR_OFFSET, width: Math.max(1, Math.round(target.frame.width * (oldDisplay?.workArea.width ?? 1))), height: Math.max(1, Math.round(target.frame.height * (oldDisplay?.workArea.height ?? 1))) };
        const display = displayForFrame(frame, displays);
        if (!display) break;
        const nextFrame = normalizeFrame(frame, display);
        const destination = denormalizeFrame(nextFrame, display);
        for (const tab of target.tabs) if (tab.runtimeWindowId) void setFrame(tab.runtimeWindowId, destination);
        setWorkspace((state) => ({ ...state, groups: state.groups.map((item) => item.id === target.id ? { ...item, displayId: display.id, frame: nextFrame } : item) }));
        break;
      }
      case "dissolve-group": setWorkspace((state) => dissolveGroup(state, command.groupId)); break;
      case "move-display": {
        const target = current.groups.find((item) => item.id === command.groupId);
        if (target) void moveGroupDisplay(command.direction, target.id);
        break;
      }
      case "save-preset": {
        const target = current.groups.find((item) => item.id === command.groupId);
        if (target) saveCurrentPreset(target.id);
        break;
      }
      case "rename-tab": {
        const target = current.groups.find((item) => item.id === command.groupId);
        if (target) renameSelectedTab(target.id, command.tabId);
        break;
      }
      case "delete-preset": setPresets((state) => state.filter((preset) => preset.id !== command.presetId)); break;
      case "set-preset-matcher": setPresets((state) => state.map((preset) => preset.id !== command.presetId ? preset : { ...preset, tabs: preset.tabs.map((tab, index) => index === command.tabIndex ? { ...tab, rule: { ...tab.rule, titlePattern: command.titlePattern || undefined } } : tab), updatedAt: new Date().toISOString() })); break;
    }
  };

  return <main>
    <section className={nativeDragId ? "tabbar native-drag" : "tabbar"} aria-label="window-tabs" data-tauri-drag-region onDragOver={(event) => event.preventDefault()} onDrop={dropTabOnGroup}>
      <div className="group-menu"><button className="group-name" onClick={() => setMenuOpen((value) => !value)}>{group?.name ?? "新しいグループ"} <span>⌄</span></button>
        {menuOpen && <div className="menu" role="menu"><button onClick={startNewGroup}>新しいグループ</button><button disabled={!group} onClick={() => saveCurrentPreset()}>現在のグループを保存…</button><button disabled={!group?.activeTabId} onClick={() => renameSelectedTab()}>選択タブの名前を変更…</button><button disabled={!group || displays.length < 2} onClick={() => void moveGroupDisplay(-1)}>前の画面へ</button><button disabled={!group || displays.length < 2} onClick={() => void moveGroupDisplay(1)}>次の画面へ</button><button disabled={!group?.activeTabId} onClick={detachSelectedTab}>選択タブを新しいグループへ</button><button className="danger" disabled={!group} onClick={dissolveActiveGroup}>グループを解除</button><button onClick={() => { setMenuOpen(false); setPresetManager(true); if (!isController) sendCommand({ type: "open-preset-manager" }); }}>プリセットを管理…</button><button onClick={() => { setMenuOpen(false); setDiagnosticsOpen(true); }}>診断ログを表示…</button>{workspace.groups.length > 1 && <div className="menu-label">開いているグループ</div>}{workspace.groups.filter((item) => item.id !== group?.id).map((item) => <button key={item.id} onClick={() => focusGroup(item.id)}>{item.name}<small>{item.tabs.length} タブ</small></button>)}{group && workspace.groups.filter((item) => item.id !== group.id).length > 0 && <><div className="menu-label">選択タブを移動</div>{workspace.groups.filter((item) => item.id !== group.id).map((item) => <button key={`move-${item.id}`} onClick={() => moveSelectedTab(item.id)}>→ {item.name}<small>{item.tabs.length} タブ</small></button>)}</>}{presets.length > 0 && <div className="menu-label">保存済みプリセット</div>}{presets.map((preset) => <button key={preset.id} onClick={() => void applyPreset(preset)}>{preset.name}<small>{preset.tabs.length} タブ</small></button>)}</div>}
      </div>
      <div className="tabs">{group?.tabs.map((tab) => <div key={tab.id} className="tab-wrap" draggable onDragStart={() => group && beginTabDrag(group.id, tab.id)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.stopPropagation(); dropTabOn(tab.id); }}><button className={tab.id === group.activeTabId ? "tab active" : "tab"} onClick={() => void select(tab.id)} title={tab.status === "unresolved" ? "未接続" : tab.name}>{tab.status === "unresolved" && <i>○</i>}{tab.name}</button><button className="remove" aria-label={`${tab.name} をグループから外す`} onClick={() => ungroup(tab.runtimeWindowId)}>×</button></div>)}{(draggingTabId || tabDragSession) && <button className="detach-drop" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.stopPropagation(); const drag = tabDragSessionRef.current; if (drag) releaseDraggedTab(drag.sourceGroupId, drag.tabId); }}>解除</button>}</div>
      <button className="add" aria-label="ウィンドウを追加" onClick={() => { if (!isController) sendCommand({ type: "open-picker", groupId: group?.id }); else { setPickerContext(closedPickerContext()); void refresh(); setPicker(true); } }}>＋</button>
    </section>
    <p className="hint">{error ?? (nativeDragId ? "Ctrl を押したまま別の実ウィンドウへドロップすると、同じグループにまとめます。" : group ? `${workspace.groups.length} グループ中 ${workspace.groups.findIndex((item) => item.id === group.id) + 1}番目 · タブを選択して実ウィンドウを切り替えます。` : "＋ から開いているウィンドウを選んでグループを作成します。")}</p>
    {picker && <div className="overlay" role="dialog" aria-modal="true" aria-label="ウィンドウを追加"><section className="picker"><header><div><p className="eyebrow">OPEN WINDOWS</p><h1>{pickerContext.assigningTabId ? "候補ウィンドウを割り当て" : "ウィンドウを追加"}</h1></div><button aria-label="閉じる" onClick={() => { setPickerContext(closedPickerContext()); setPicker(false); }}>×</button></header><div className="window-list">{windows.filter((windowInfo) => !connectedIds.has(windowInfo.id)).map((windowInfo) => <button key={windowInfo.id} onClick={() => void add(windowInfo, pickerContext.groupId, pickerContext.assigningTabId, pickerContext.creatingGroup)}><span className="app-mark">{windowInfo.appName.slice(0, 1).toUpperCase()}</span><span><strong>{windowInfo.title || "無題のウィンドウ"}</strong><small>{windowInfo.appName}</small></span></button>)}{windows.length === 0 && <p className="empty">追加できるウィンドウがありません。</p>}</div></section></div>}
    {presetManager && <div className="overlay" role="dialog" aria-modal="true" aria-label="プリセットを管理"><section className="picker preset-manager"><header><div><p className="eyebrow">SAVED LAYOUTS</p><h1>プリセットを管理</h1></div><button aria-label="閉じる" onClick={() => setPresetManager(false)}>×</button></header><div className="preset-list">{presets.map((preset) => <article key={preset.id}><div><strong>{preset.name}</strong><small>{preset.tabs.length} タブ · 最終更新 {new Date(preset.updatedAt).toLocaleString()}</small></div><div><button className="secondary" onClick={() => void applyPreset(preset)}>適用</button><button className="secondary" onClick={() => editPresetMatcher(preset)}>条件…</button><button className="danger" onClick={() => deletePreset(preset.id)}>削除</button></div></article>)}{presets.length === 0 && <p className="empty">保存済みプリセットはありません。グループ名メニューから保存できます。</p>}</div></section></div>}
    {diagnosticsOpen && <div className="overlay" role="dialog" aria-modal="true" aria-label="診断ログ"><section className="picker preset-manager"><header><div><p className="eyebrow">DIAGNOSTICS</p><h1>診断ログ</h1></div><button aria-label="閉じる" onClick={() => setDiagnosticsOpen(false)}>×</button></header><div className="preset-list">{diagnostics().map((entry, index) => <article key={`${entry.at}-${index}`}><div><strong>{entry.level.toUpperCase()}</strong><small>{entry.at} · {entry.message}</small></div></article>)}{diagnostics().length === 0 && <p className="empty">このセッションではエラーは記録されていません。</p>}</div></section></div>}
    {updateOpen && <div className="overlay" role="dialog" aria-modal="true" aria-label="更新"><section className="picker preset-manager"><header><div><p className="eyebrow">APPLICATION UPDATE</p><h1>window-tabs の更新</h1></div><button aria-label="閉じる" onClick={() => setUpdateOpen(false)}>×</button></header><div className="update-panel">
      {updateState.status === "checking" && <p>更新を確認しています…</p>}
      {updateState.status === "up-to-date" && <p>最新バージョンを使用しています。</p>}
      {updateState.status === "available" && <><p><strong>{updateState.version}</strong> が利用できます。</p>{updateState.notes && <p className="update-notes">{updateState.notes}</p>}<button onClick={() => updater.current && void updater.current.download(applyUpdateState)}>更新をダウンロード</button></>}
      {updateState.status === "downloading" && <p>署名付き更新をダウンロードしています…</p>}
      {updateState.status === "ready" && <><p>{updateState.version} のダウンロードが完了しました。インストールすると window-tabs を再起動します。</p><button onClick={() => updater.current && void updater.current.installAndRelaunch(applyUpdateState)}>インストールして再起動</button></>}
      {updateState.status === "installing" && <p>更新をインストールしています…</p>}
      {updateState.status === "error" && <><p className="error">更新できませんでした。現在のバージョンはそのまま使用できます。</p><p className="update-notes">{updateState.error}</p><button className="secondary" onClick={() => void openUrl(RELEASES_URL)}>Releaseページを開く</button></>}
      {updateState.status === "idle" && <button onClick={() => checkForUpdates(true)}>更新を確認</button>}
    </div></section></div>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
