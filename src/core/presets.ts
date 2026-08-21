import type { Preset, TabGroup } from "./model";

const storageKey = "window-tabs.presets.v1";

export function groupToPreset(group: TabGroup, name = group.name): Preset {
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name,
    tabs: group.tabs.map(({ id, name: tabName, rule }) => ({ id, name: tabName, rule })),
    displayId: group.displayId,
    frame: group.frame,
    updatedAt: new Date().toISOString(),
  };
}

export function loadPresets(storage: Pick<Storage, "getItem"> = localStorage): Preset[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(storageKey) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isPreset) : [];
  } catch {
    return [];
  }
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
  return preset.schemaVersion === 1 && typeof preset.id === "string" && typeof preset.name === "string" && Array.isArray(preset.tabs);
}
