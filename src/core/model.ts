export type WindowId = string;
export type DisplayId = string;

export type Rect = { x: number; y: number; width: number; height: number };
export type DisplayInfo = { id: DisplayId; workArea: Rect; primary: boolean };
export type WindowState = "normal" | "minimized" | "maximized" | "unknown";

export type WindowInfo = {
  id: WindowId;
  processId: number;
  appId: string;
  appName: string;
  /** Platform-provided identity hints; never persisted as runtime handles. */
  executablePath?: string;
  className?: string;
  title: string;
  frame: Rect;
  displayId: DisplayId;
  state: WindowState;
};

export type WindowsMatchHint = { executable?: string; executablePath?: string; className?: string };
export type WindowMatchRule = {
  titlePattern?: string;
  documentHint?: string;
  platformHints?: { windows?: WindowsMatchHint; macos?: { bundleId?: string; accessibilityIdentifier?: string } };
};

export type TabStatus = "connected" | "unresolved" | "minimized";
export type TabEntry = { id: string; name: string; rule?: WindowMatchRule; runtimeWindowId?: WindowId; status: TabStatus };
export type NormalizedFrame = { x: number; y: number; width: number; height: number };
export type TabGroup = { id: string; name: string; presetId?: string; tabs: TabEntry[]; activeTabId?: string; displayId: DisplayId; frame: NormalizedFrame };

export type PresetTab = Pick<TabEntry, "id" | "name" | "rule">;
export type Preset = {
  schemaVersion: 1;
  id: string;
  name: string;
  tabs: PresetTab[];
  displayId: DisplayId;
  frame: NormalizedFrame;
  updatedAt: string;
};
