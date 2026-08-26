import type { DisplayHint, DisplayInfo, Preset, Rect, TabGroup } from "./model";

const storageKey = "window-tabs.presets.v1";

export function displayHint(display: DisplayInfo | undefined): DisplayHint {
  return { name: display?.name, primary: display?.primary ?? true, workArea: { width: display?.workArea.width ?? 0, height: display?.workArea.height ?? 0 } };
}

export function resolveDisplay(hint: DisplayHint, displays: DisplayInfo[]): DisplayInfo | undefined {
  const sameSize = (display: DisplayInfo) => display.workArea.width === hint.workArea.width && display.workArea.height === hint.workArea.height;
  return displays.find((display) => hint.name && display.name === hint.name)
    ?? displays.find((display) => display.primary === hint.primary && sameSize(display))
    ?? displays.find(sameSize)
    ?? displays.find((display) => display.primary === hint.primary)
    ?? displays.find((display) => display.primary)
    ?? displays[0];
}

export function resolvePresetGeometry(preset: Pick<Preset, "display" | "frame">, displays: DisplayInfo[]): { display?: DisplayInfo; frame?: Rect } {
  const display = resolveDisplay(preset.display, displays);
  if (!display) return {};
  return {
    display,
    frame: {
      x: Math.round(display.workArea.x + display.workArea.width * preset.frame.x),
      y: Math.round(display.workArea.y + display.workArea.height * preset.frame.y),
      width: Math.round(display.workArea.width * preset.frame.width),
      height: Math.round(display.workArea.height * preset.frame.height),
    },
  };
}

export function groupToPreset(group: TabGroup, display: DisplayInfo | undefined, name = group.name): Preset {
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name,
    tabs: group.tabs.map(({ id, name: tabName, rule }) => ({ id, name: tabName, rule })),
    display: displayHint(display),
    frame: group.frame,
    updatedAt: new Date().toISOString(),
  };
}

export function loadPresets(storage: Pick<Storage, "getItem"> = localStorage): Preset[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(storageKey) ?? "[]");
    return Array.isArray(parsed) ? parsed.map(migratePreset).filter(isPreset) : [];
  } catch {
    return [];
  }
}

function migratePreset(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const preset = value as Partial<Preset> & { displayId?: unknown };
  // Old local records may contain a runtime HMONITOR-derived displayId. Drop it
  // during migration instead of carrying that runtime handle forward.
  return preset.display ? preset : { ...preset, display: { primary: true, workArea: { width: 0, height: 0 } } };
}

export function savePresets(presets: Preset[], storage: Pick<Storage, "setItem"> = localStorage): void {
  storage.setItem(storageKey, JSON.stringify(presets));
}

export function upsertPreset(presets: Preset[], preset: Preset): Preset[] {
  return [...presets.filter((item) => item.id !== preset.id), preset];
}

function isPreset(value: unknown): value is Preset {
  if (!value || typeof value !== "object") return false;
  const preset = value as Partial<Preset>;
  return preset.schemaVersion === 1 && typeof preset.id === "string" && typeof preset.name === "string" && Array.isArray(preset.tabs) && !!preset.display && typeof preset.display === "object";
}
