import { invoke } from "@tauri-apps/api/core";
import type { DisplayInfo, Rect, WindowId, WindowInfo } from "../core/model";

export interface WindowBackend {
  listWindows(): Promise<WindowInfo[]>;
  listDisplays(): Promise<DisplayInfo[]>;
  getForegroundWindow(): Promise<WindowId | null>;
  activate(id: WindowId): Promise<void>;
  restore(id: WindowId): Promise<void>;
  getFrame(id: WindowId): Promise<Rect>;
  setFrame(id: WindowId, frame: Rect): Promise<void>;
  closeWindow(id: WindowId): Promise<void>;
  openGroupHost(groupId: string): Promise<void>;
  syncGroupHost(groupId: string, windowIds: WindowId[], activeId: WindowId | null, frame: Rect): Promise<void>;
  closeGroupHost(groupId: string): Promise<void>;
  raiseGroupHost(groupId: string): Promise<void>;
  showGroupMenu(groupId: string, items: Array<{ id: string; label: string; enabled: boolean }>): Promise<void>;
  setTrayPresets(presets: Array<{ id: string; name: string }>): Promise<void>;
}

export type NativeWindowEvent = { kind: "focused" | "destroyed" | "minimized" | "restored" | "drag-start" | "drag-end" | "frame-settled"; id: WindowId; target?: WindowId; frame?: Rect };

export const windowBackend: WindowBackend = {
  listWindows: () => invoke("list_windows"),
  listDisplays: () => invoke("list_displays"),
  getForegroundWindow: () => invoke("get_foreground_window"),
  activate: (id) => invoke("activate_window", { id }),
  restore: (id) => invoke("restore_window", { id }),
  getFrame: (id) => invoke("get_window_frame", { id }),
  setFrame: (id, frame) => invoke("set_window_frame", { id, frame }),
  closeWindow: (id) => invoke("close_window", { id }),
  openGroupHost: (groupId) => invoke("open_group_host", { groupId }),
  syncGroupHost: (groupId, windowIds, activeId, frame) => invoke("sync_group_host", { groupId, windowIds, activeId, frame }),
  closeGroupHost: (groupId) => invoke("close_group_host", { groupId }),
  raiseGroupHost: (groupId) => invoke("raise_group_host", { groupId }),
  showGroupMenu: (groupId, items) => invoke("show_group_menu", { groupId, items }),
  setTrayPresets: (presets) => invoke("set_tray_presets", { presets }),
};
