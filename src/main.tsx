import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { LogicalSize, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { addWindow, newGroup, reorderTab, selectTab, ungroupWindow } from "./core/groups";
import { reconnectGroup } from "./core/matching";
import { diagnostics, recordDiagnostic } from "./core/diagnostics";
import { groupToPreset, loadPresets, savePresets, upsertPreset } from "./core/presets";
import { activeGroup, addGroup, detachTab, emptyWorkspace, groupForWindow, moveTabToGroup, selectGroup, updateActiveGroup } from "./core/workspace";
import type { DisplayInfo, Preset, TabGroup, WindowInfo } from "./core/model";
import type { NativeWindowEvent } from "./platform-client/windowBackend";
import { windowBackend } from "./platform-client/windowBackend";
import "./styles.css";

const fromPreset = (preset: Preset): TabGroup => ({ id: crypto.randomUUID(), presetId: preset.id, name: preset.name, displayId: preset.displayId, frame: preset.frame, tabs: preset.tabs.map((tab) => ({ ...tab, status: "unresolved" })) });
const hostGroupId = new URLSearchParams(window.location.search).get("group") ?? undefined;

const pinBarTo = async (frame: WindowInfo["frame"]) => {
  const appWindow = getCurrentWindow();
  await appWindow.setSize(new PhysicalSize(Math.min(960, Math.max(480, frame.width)), 120));
  await appWindow.setPosition(new PhysicalPosition(frame.x, Math.max(0, frame.y - 64)));
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
  const [presetManager, setPresetManager] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [nativeDragId, setNativeDragId] = useState<string | null>(null);
  const [assigningTabId, setAssigningTabId] = useState<string | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingFrameMutations = useRef(new Map<string, number>());
  const lastFrameSettled = useRef(new Map<string, number>());
  const missingWindowPolls = useRef(new Map<string, number>());
  const workspaceChannel = useRef<BroadcastChannel | null>(null);
  const workspaceRef = useRef(workspace);
  const workspaceSynced = useRef(!hostGroupId);
  const suppressWorkspaceBroadcast = useRef(false);
  const group = hostGroupId ? workspace.groups.find((item) => item.id === hostGroupId) ?? null : activeGroup(workspace);
  const updateGroup = (update: (current: TabGroup | null) => TabGroup | null) => setWorkspace((current) => {
    if (!hostGroupId) return updateActiveGroup(current, update);
    const target = current.groups.find((item) => item.id === hostGroupId) ?? null;
    const next = update(target);
    if (!target) return next ? { ...current, groups: [...current.groups, next] } : current;
    return next ? { ...current, groups: current.groups.map((item) => item.id === target.id ? next : item) } : { ...current, groups: current.groups.filter((item) => item.id !== target.id) };
  });
  const setFrame = async (id: string, frame: WindowInfo["frame"]) => {
    pendingFrameMutations.current.set(id, Date.now() + 1_000);
    try { await windowBackend.setFrame(id, frame); }
    catch (reason) { const message = reason instanceof Error ? reason.message : "ウィンドウの配置を更新できませんでした。"; pendingFrameMutations.current.delete(id); recordDiagnostic("error", message); setError(message); }
  };

  const refresh = async () => {
    try { const [next, nextDisplays] = await Promise.all([windowBackend.listWindows(), windowBackend.listDisplays()]); setWindows(next); setDisplays(nextDisplays); setError(null); return next; }
    catch (reason) { const message = reason instanceof Error ? reason.message : "ウィンドウ一覧を取得できませんでした。"; recordDiagnostic("error", message); setError(message); return []; }
  };
  const startNewGroup = () => { setCreatingGroup(true); setAssigningTabId(null); void refresh(); setPicker(true); };
  const focusGroup = (groupId: string) => {
    const next = selectGroup(workspace, groupId);
    const target = activeGroup(next)?.tabs.find((tab) => tab.runtimeWindowId)?.runtimeWindowId;
    const info = windows.find((window) => window.id === target);
    setWorkspace(next); setMenuOpen(false);
    if (hostGroupId !== groupId) void windowBackend.openGroupHost(groupId);
    if (info) void pinBarTo(info.frame);
  };

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    const channel = new BroadcastChannel("window-tabs-workspace");
    workspaceChannel.current = channel;
    channel.onmessage = ({ data }) => {
      if (data?.type === "workspace-request" && !hostGroupId) channel.postMessage({ type: "workspace", workspace: workspaceRef.current });
      if (data?.type === "workspace" && data.workspace) { workspaceSynced.current = true; suppressWorkspaceBroadcast.current = true; setWorkspace(data.workspace); }
    };
    if (hostGroupId) channel.postMessage({ type: "workspace-request" });
    return () => channel.close();
  }, []);
  useEffect(() => {
    workspaceRef.current = workspace;
    if (!workspaceSynced.current) return;
    if (suppressWorkspaceBroadcast.current) { suppressWorkspaceBroadcast.current = false; return; }
    workspaceChannel.current?.postMessage({ type: "workspace", workspace });
  }, [workspace]);
  useEffect(() => { if (picker || presetManager) void getCurrentWindow().setSize(new LogicalSize(720, 640)); else if (!group) void getCurrentWindow().setSize(new LogicalSize(720, 120)); }, [group, picker, presetManager]);
  useEffect(() => {
    if (!hostGroupId || !group) return;
    const windowInfo = windows.find((item) => group.tabs.some((tab) => tab.runtimeWindowId === item.id));
    if (windowInfo) void pinBarTo(windowInfo.frame);
  }, [group?.id, hostGroupId, windows]);
  useEffect(() => {
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
      const frame = { x: payload.x, y: payload.y + 64, width: Math.max(1, Math.round(group.frame.width * (displays.find((display) => display.id === group.displayId)?.workArea.width ?? 1))), height: Math.max(1, Math.round(group.frame.height * (displays.find((display) => display.id === group.displayId)?.workArea.height ?? 1))) };
      const display = displayForFrame(frame, displays);
      if (!display) return;
      const destination = denormalizeFrame({ ...normalizeFrame(frame, display), width: group.frame.width, height: group.frame.height }, display);
      for (const tab of group.tabs) if (tab.runtimeWindowId) void setFrame(tab.runtimeWindowId, destination);
      updateGroup((item) => item ? { ...item, displayId: display.id, frame: normalizeFrame(destination, display) } : item);
    }).then((unlisten) => { dispose = unlisten; });
    return () => dispose?.();
  }, [group, displays]);
  useEffect(() => {
    savePresets(presets);
    void windowBackend.setTrayPresets(presets.map(({ id, name }) => ({ id, name }))).catch(() => undefined);
  }, [presets]);
  useEffect(() => {
    const unsubscribe = listen("launcher:new-group", startNewGroup);
    return () => { void unsubscribe.then((dispose) => dispose()); };
  }, [workspace]);
  useEffect(() => {
    const unsubscribe = listen("launcher:open-presets", () => { setMenuOpen(false); setPresetManager(true); });
    return () => { void unsubscribe.then((dispose) => dispose()); };
  }, []);
  useEffect(() => {
    const unsubscribe = listen<string>("launcher:apply-preset", ({ payload }) => {
      const preset = presets.find((item) => item.id === payload);
      if (preset) void applyPreset(preset);
    });
    return () => { void unsubscribe.then((dispose) => dispose()); };
  }, [presets, workspace, displays, windows]);
  useEffect(() => {
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
      if (payload.kind === "frame-settled" && payload.frame) setWorkspace((current) => {
        const last = lastFrameSettled.current.get(payload.id) ?? 0;
        if (Date.now() - last < 150) return current;
        lastFrameSettled.current.set(payload.id, Date.now());
        const until = pendingFrameMutations.current.get(payload.id);
        if (until && until >= Date.now()) { pendingFrameMutations.current.delete(payload.id); return current; }
        const owner = groupForWindow(current, payload.id);
        if (!owner || owner.activeTabId !== owner.tabs.find((tab) => tab.runtimeWindowId === payload.id)?.id) return current;
        for (const tab of owner.tabs) if (tab.runtimeWindowId && tab.runtimeWindowId !== payload.id) void setFrame(tab.runtimeWindowId, payload.frame!);
        const display = displayForFrame(payload.frame!, displays);
        return { ...current, groups: current.groups.map((item) => item.id === owner.id ? { ...item, displayId: display?.id ?? item.displayId, frame: normalizeFrame(payload.frame!, display) } : item) };
      });
      if (payload.kind === "drag-end" && payload.target) setWorkspace((current) => {
        const source = windows.find((window) => window.id === payload.id); const target = windows.find((window) => window.id === payload.target);
        if (!source || !target) return current;
        const sourceOwner = groupForWindow(current, source.id);
        const targetOwner = groupForWindow(current, target.id);
        if (!sourceOwner && !targetOwner) return addGroup(current, addWindow(newGroup(target), source));
        if (sourceOwner && !targetOwner) {
          void setFrame(target.id, source.frame);
          return { ...current, groups: current.groups.map((item) => item.id === sourceOwner.id ? addWindow(item, target) : item), activeGroupId: sourceOwner.id };
        }
        if (!sourceOwner && targetOwner) {
          void setFrame(source.id, target.frame);
          return { ...current, groups: current.groups.map((item) => item.id === targetOwner.id ? addWindow(item, source) : item), activeGroupId: targetOwner.id };
        }
        if (sourceOwner && targetOwner && sourceOwner.id !== targetOwner.id) {
          const sourceTab = sourceOwner.tabs.find((tab) => tab.runtimeWindowId === source.id);
          if (sourceTab) { void setFrame(source.id, target.frame); return moveTabToGroup(current, sourceOwner.id, sourceTab.id, targetOwner.id); }
        }
        return current;
      });
      if (payload.kind === "drag-end") setNativeDragId(null);
    });
    return () => { void unsubscribe.then((dispose) => dispose()); };
  }, [displays, windows]);
  useEffect(() => {
    const timer = window.setInterval(() => { void Promise.all([windowBackend.listWindows(), windowBackend.listDisplays()]).then(([currentWindows, currentDisplays]) => {
      const available = new Set(currentWindows.map((item) => item.id)); setWindows(currentWindows); setDisplays(currentDisplays);
      setWorkspace((current) => {
        const groups = current.groups.map((item) => {
          if (item.presetId) return reconnectGroup(item, currentWindows);
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

  const select = async (tabId: string) => {
    if (!group) return;
    const next = selectTab(group, tabId); updateGroup(() => next);
    const target = next.tabs.find((tab) => tab.id === tabId);
    if (!target?.runtimeWindowId) { setAssigningTabId(tabId); void refresh(); setPicker(true); return; }
    try { if (target.status === "minimized") await windowBackend.restore(target.runtimeWindowId); await windowBackend.activate(target.runtimeWindowId); }
    catch (reason) { const message = reason instanceof Error ? reason.message : "ウィンドウを前面化できませんでした。"; recordDiagnostic("error", message); setError(message); }
  };
  const add = async (windowInfo: WindowInfo) => {
    if (assigningTabId) { updateGroup((current) => current ? { ...current, activeTabId: assigningTabId, tabs: current.tabs.map((tab) => tab.id === assigningTabId ? { ...tab, runtimeWindowId: windowInfo.id, status: windowInfo.state === "minimized" ? "minimized" : "connected" } : tab) } : current); setAssigningTabId(null); setPicker(false); return; }
    if (group && !creatingGroup) {
      const anchorId = group.activeTabId ? group.tabs.find((tab) => tab.id === group.activeTabId)?.runtimeWindowId : group.tabs[0]?.runtimeWindowId;
      const anchor = windows.find((item) => item.id === anchorId);
      if (anchor && anchor.id !== windowInfo.id) { await setFrame(windowInfo.id, anchor.frame); await pinBarTo(anchor.frame); }
      updateGroup((current) => current ? addWindow(current, windowInfo) : current);
    } else {
      await pinBarTo(windowInfo.frame);
      const created = newGroup(windowInfo, normalizeFrame(windowInfo.frame, displays.find((display) => display.id === windowInfo.displayId)));
      const alreadyHasGroup = workspace.groups.length > 0;
      setWorkspace((current) => alreadyHasGroup ? { ...current, groups: [...current.groups, created] } : addGroup(current, created));
      if (alreadyHasGroup) void windowBackend.openGroupHost(created.id);
    }
    setCreatingGroup(false); setPicker(false);
  };
  const saveCurrentPreset = () => {
    if (!group) return;
    const name = window.prompt("プリセット名", group.name)?.trim(); if (!name) return;
    const active = group.tabs.find((tab) => tab.id === group.activeTabId);
    const titlePattern = active ? window.prompt("選択タブのタイトル正規表現（任意。空欄なら実行ファイルだけで安全に照合）", active.rule?.titlePattern ?? "")?.trim() : "";
    const nextGroup = active ? { ...group, tabs: group.tabs.map((tab) => tab.id === active.id ? { ...tab, rule: { ...tab.rule, titlePattern: titlePattern || undefined } } : tab) } : group;
    const preset = groupToPreset(nextGroup, name); setPresets((current) => upsertPreset(current, preset)); updateGroup(() => ({ ...nextGroup, name, presetId: preset.id })); setMenuOpen(false);
  };
  const moveGroupDisplay = async (direction: 1 | -1) => {
    if (!group || displays.length < 2) return;
    const current = Math.max(0, displays.findIndex((display) => display.id === group.displayId));
    const destination = displays[(current + direction + displays.length) % displays.length];
    const frame = denormalizeFrame(group.frame, destination);
    await Promise.all(group.tabs.flatMap((tab) => tab.runtimeWindowId ? [setFrame(tab.runtimeWindowId, frame)] : []));
    await pinBarTo(frame);
    updateGroup((item) => item ? { ...item, displayId: destination.id } : item);
  };
  const moveSelectedTab = (destinationGroupId: string) => {
    if (!group?.activeTabId) return;
    setWorkspace((current) => moveTabToGroup(current, group.id, group.activeTabId!, destinationGroupId)); setMenuOpen(false);
  };
  const detachSelectedTab = () => {
    if (!group?.activeTabId) return;
    const next = detachTab(workspace, group.id, group.activeTabId!);
    const detached = next.groups.find((item) => !workspace.groups.some((before) => before.id === item.id));
    const sourceSurvives = group.tabs.length > 1;
    const remainingActive = sourceSurvives ? group.id : workspace.groups.find((item) => item.id !== group.id)?.id;
    setWorkspace({ ...next, activeGroupId: remainingActive ?? next.activeGroupId });
    if (detached && (sourceSurvives || workspace.groups.length > 1)) void windowBackend.openGroupHost(detached.id);
    setMenuOpen(false);
  };
  const detachDraggedTab = (tabId: string) => {
    if (!group) return;
    const next = detachTab(workspace, group.id, tabId);
    const detached = next.groups.find((item) => !workspace.groups.some((before) => before.id === item.id));
    setWorkspace(next);
    if (detached && group.tabs.length > 1) void windowBackend.openGroupHost(detached.id);
    setDraggingTabId(null);
  };
  const renameSelectedTab = () => {
    if (!group?.activeTabId) return;
    const tab = group.tabs.find((item) => item.id === group.activeTabId);
    const name = tab && window.prompt("タブ名", tab.name)?.trim();
    if (name) updateGroup((current) => current ? { ...current, tabs: current.tabs.map((item) => item.id === tab!.id ? { ...item, name } : item) } : current);
    setMenuOpen(false);
  };
  const applyPreset = async (preset: Preset) => {
    const currentWindows = await refresh(); const next = reconnectGroup(fromPreset(preset), currentWindows); const alreadyHasGroup = workspace.groups.length > 0;
    setWorkspace((current) => alreadyHasGroup ? { ...current, groups: [...current.groups, next] } : addGroup(current, next));
    if (alreadyHasGroup) void windowBackend.openGroupHost(next.id); setMenuOpen(false); setPresetManager(false);
  };
  const ungroup = (windowId: string | undefined) => { if (windowId) updateGroup((current) => current ? ungroupWindow(current, windowId) : current); };
  const deletePreset = (presetId: string) => setPresets((current) => current.filter((preset) => preset.id !== presetId));
  const editPresetMatcher = (preset: Preset) => {
    const tabNumber = Number(window.prompt(`条件を編集するタブ番号 (1-${preset.tabs.length})`, "1"));
    if (!Number.isInteger(tabNumber) || tabNumber < 1 || tabNumber > preset.tabs.length) return;
    const tab = preset.tabs[tabNumber - 1];
    const titlePattern = window.prompt(`${tab.name} のタイトル正規表現（空欄で解除）`, tab.rule?.titlePattern ?? "");
    if (titlePattern === null) return;
    setPresets((current) => current.map((item) => item.id !== preset.id ? item : { ...item, tabs: item.tabs.map((candidate, index) => index === tabNumber - 1 ? { ...candidate, rule: { ...candidate.rule, titlePattern: titlePattern.trim() || undefined } } : candidate), updatedAt: new Date().toISOString() }));
  };

  return <main>
    <section className={nativeDragId ? "tabbar native-drag" : "tabbar"} aria-label="window-tabs" data-tauri-drag-region>
      <div className="group-menu"><button className="group-name" onClick={() => setMenuOpen((value) => !value)}>{group?.name ?? "新しいグループ"} <span>⌄</span></button>
        {menuOpen && <div className="menu" role="menu"><button onClick={startNewGroup}>新しいグループ</button><button disabled={!group} onClick={saveCurrentPreset}>現在のグループを保存…</button><button disabled={!group?.activeTabId} onClick={renameSelectedTab}>選択タブの名前を変更…</button><button disabled={!group || displays.length < 2} onClick={() => void moveGroupDisplay(-1)}>前の画面へ</button><button disabled={!group || displays.length < 2} onClick={() => void moveGroupDisplay(1)}>次の画面へ</button><button disabled={!group?.activeTabId} onClick={detachSelectedTab}>選択タブを新しいグループへ</button><button onClick={() => { setMenuOpen(false); setPresetManager(true); }}>プリセットを管理…</button><button onClick={() => { setMenuOpen(false); setDiagnosticsOpen(true); }}>診断ログを表示…</button>{workspace.groups.length > 1 && <div className="menu-label">開いているグループ</div>}{workspace.groups.filter((item) => item.id !== group?.id).map((item) => <button key={item.id} onClick={() => focusGroup(item.id)}>{item.name}<small>{item.tabs.length} タブ</small></button>)}{group && workspace.groups.filter((item) => item.id !== group.id).length > 0 && <><div className="menu-label">選択タブを移動</div>{workspace.groups.filter((item) => item.id !== group.id).map((item) => <button key={`move-${item.id}`} onClick={() => moveSelectedTab(item.id)}>→ {item.name}<small>{item.tabs.length} タブ</small></button>)}</>}{presets.length > 0 && <div className="menu-label">保存済みプリセット</div>}{presets.map((preset) => <button key={preset.id} onClick={() => void applyPreset(preset)}>{preset.name}<small>{preset.tabs.length} タブ</small></button>)}</div>}
      </div>
      <div className="tabs">{group?.tabs.map((tab) => <div key={tab.id} className="tab-wrap" draggable onDragStart={() => setDraggingTabId(tab.id)} onDragEnd={() => setDraggingTabId(null)} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (draggingTabId) updateGroup((current) => current ? reorderTab(current, draggingTabId, tab.id) : current); }}><button className={tab.id === group.activeTabId ? "tab active" : "tab"} onClick={() => void select(tab.id)} title={tab.status === "unresolved" ? "未接続" : tab.name}>{tab.status === "unresolved" && <i>○</i>}{tab.name}</button><button className="remove" aria-label={`${tab.name} をグループから外す`} onClick={() => ungroup(tab.runtimeWindowId)}>×</button></div>)}{draggingTabId && <button className="detach-drop" onDragOver={(event) => event.preventDefault()} onDrop={() => detachDraggedTab(draggingTabId)}>新規</button>}</div>
      <button className="add" aria-label="ウィンドウを追加" onClick={() => { setAssigningTabId(null); void refresh(); setPicker(true); }}>＋</button>
    </section>
    <p className="hint">{error ?? (nativeDragId ? "Ctrl を押したまま別の実ウィンドウへドロップすると、同じグループにまとめます。" : group ? `${workspace.groups.length} グループ中 ${workspace.groups.findIndex((item) => item.id === group.id) + 1}番目 · タブを選択して実ウィンドウを切り替えます。` : "＋ から開いているウィンドウを選んでグループを作成します。")}</p>
    {picker && <div className="overlay" role="dialog" aria-modal="true" aria-label="ウィンドウを追加"><section className="picker"><header><div><p className="eyebrow">OPEN WINDOWS</p><h1>{assigningTabId ? "候補ウィンドウを割り当て" : "ウィンドウを追加"}</h1></div><button aria-label="閉じる" onClick={() => { setAssigningTabId(null); setPicker(false); }}>×</button></header><div className="window-list">{windows.filter((windowInfo) => !connectedIds.has(windowInfo.id)).map((windowInfo) => <button key={windowInfo.id} onClick={() => void add(windowInfo)}><span className="app-mark">{windowInfo.appName.slice(0, 1).toUpperCase()}</span><span><strong>{windowInfo.title || "無題のウィンドウ"}</strong><small>{windowInfo.appName}</small></span></button>)}{windows.length === 0 && <p className="empty">追加できるウィンドウがありません。</p>}</div></section></div>}
    {presetManager && <div className="overlay" role="dialog" aria-modal="true" aria-label="プリセットを管理"><section className="picker preset-manager"><header><div><p className="eyebrow">SAVED LAYOUTS</p><h1>プリセットを管理</h1></div><button aria-label="閉じる" onClick={() => setPresetManager(false)}>×</button></header><div className="preset-list">{presets.map((preset) => <article key={preset.id}><div><strong>{preset.name}</strong><small>{preset.tabs.length} タブ · 最終更新 {new Date(preset.updatedAt).toLocaleString()}</small></div><div><button className="secondary" onClick={() => void applyPreset(preset)}>適用</button><button className="secondary" onClick={() => editPresetMatcher(preset)}>条件…</button><button className="danger" onClick={() => deletePreset(preset.id)}>削除</button></div></article>)}{presets.length === 0 && <p className="empty">保存済みプリセットはありません。グループ名メニューから保存できます。</p>}</div></section></div>}
    {diagnosticsOpen && <div className="overlay" role="dialog" aria-modal="true" aria-label="診断ログ"><section className="picker preset-manager"><header><div><p className="eyebrow">DIAGNOSTICS</p><h1>診断ログ</h1></div><button aria-label="閉じる" onClick={() => setDiagnosticsOpen(false)}>×</button></header><div className="preset-list">{diagnostics().map((entry, index) => <article key={`${entry.at}-${index}`}><div><strong>{entry.level.toUpperCase()}</strong><small>{entry.at} · {entry.message}</small></div></article>)}{diagnostics().length === 0 && <p className="empty">このセッションではエラーは記録されていません。</p>}</div></section></div>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
