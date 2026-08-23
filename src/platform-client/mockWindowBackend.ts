import type { DisplayInfo, Rect, WindowId, WindowInfo } from "../core/model";
import type { WindowBackend } from "./windowBackend";

/** In-memory platform adapter for core/UI integration tests. */
export class MockWindowBackend implements WindowBackend {
  readonly groupHosts = new Set<string>();
  constructor(public windows: WindowInfo[] = [], public displays: DisplayInfo[] = []) {}

  async listWindows() { return this.windows; }
  async listDisplays() { return this.displays; }
  async getForegroundWindow(): Promise<WindowId | null> { return this.windows[0]?.id ?? null; }
  async activate(_id: WindowId) {}
  async restore(_id: WindowId) {}
  async getFrame(id: WindowId): Promise<Rect> {
    const frame = this.windows.find((window) => window.id === id)?.frame;
    if (!frame) throw new Error("window not found");
    return frame;
  }
  async setFrame(id: WindowId, frame: Rect) { this.windows = this.windows.map((window) => window.id === id ? { ...window, frame } : window); }
  async openGroupHost(groupId: string) { this.groupHosts.add(groupId); }
  async closeGroupHost(groupId: string) { this.groupHosts.delete(groupId); }
  async setTrayPresets(_presets: Array<{ id: string; name: string }>) {}
}
