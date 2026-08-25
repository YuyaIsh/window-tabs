import { describe, expect, it } from "vitest";
import { matchWindow, reconnectGroup } from "./matching";
import { displayHint, groupToPreset, resolveDisplay, resolvePresetGeometry } from "./presets";
import type { Preset, TabGroup, WindowInfo } from "./model";

const window = (id: string, title = "Editor"): WindowInfo => ({ id, processId: 1, appId: "code.exe", appName: "Code", title, frame: { x: 0, y: 0, width: 1, height: 1 }, displayId: "primary", state: "normal" });

describe("preset persistence model", () => {
  it("does not persist runtime window ids", () => {
    const group: TabGroup = { id: "group", name: "Work", tabs: [{ id: "tab", name: "Editor", runtimeWindowId: "0x123", status: "connected" }], displayId: "primary", frame: { x: 0, y: 0, width: 1, height: 1 } };
    expect(JSON.stringify(groupToPreset(group, { id: "RUNTIME-HMONITOR", name: "DISPLAY1", primary: true, workArea: { x: 0, y: 0, width: 100, height: 100 } }))).not.toContain("0x123");
  });

  it("connects only an unambiguous match", () => {
    const rule = { platformHints: { windows: { executable: "code.exe" } } };
    expect(matchWindow(rule, [window("one")]).kind).toBe("connected");
    const ambiguous = matchWindow(rule, [window("one"), window("two")]);
    expect(ambiguous).toEqual({ kind: "unresolved", candidates: [window("one"), window("two")] });
  });
  it("does not reconnect the same window to two preset tabs", () => {
    const group: TabGroup = { id: "group", name: "Work", presetId: "preset", displayId: "primary", frame: { x: 0, y: 0, width: 1, height: 1 }, tabs: [{ id: "one", name: "One", rule: { platformHints: { windows: { executable: "code.exe" } } }, status: "unresolved" }, { id: "two", name: "Two", rule: { platformHints: { windows: { executable: "code.exe" } } }, status: "unresolved" }] };
    const reconnected = reconnectGroup(group, [window("one")]);
    expect(reconnected.tabs.map((tab) => tab.status)).toEqual(["connected", "unresolved"]);
  });
  it("uses explicit executable path and class hints to disambiguate", () => {
    const rule = { platformHints: { windows: { executable: "code.exe", executablePath: "C:\\Tools\\Code.exe", className: "CodeWindow" } } };
    const matching = { ...window("one"), executablePath: "c:\\tools\\code.exe", className: "CodeWindow" };
    const differentClass = { ...matching, id: "two", className: "OtherWindow" };
    expect(matchWindow(rule, [matching, differentClass])).toEqual({ kind: "connected", window: matching });
  });
  it("persists a display hint rather than a runtime display id", () => {
    const hint = displayHint({ id: "RUNTIME-HMONITOR", name: "DISPLAY1", primary: false, workArea: { x: 0, y: 0, width: 1920, height: 1080 } });
    expect(JSON.stringify(hint)).not.toContain("RUNTIME-HMONITOR");
    expect(resolveDisplay(hint, [{ id: "new-runtime", name: "DISPLAY1", primary: false, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }])?.id).toBe("new-runtime");
  });
  it("restores preset geometry on the resolved display", () => {
    const preset: Preset = { schemaVersion: 1, id: "preset", name: "Work", tabs: [], display: { name: "DISPLAY2", primary: false, workArea: { width: 100, height: 100 } }, frame: { x: .1, y: .2, width: .5, height: .4 }, updatedAt: "2026-01-01T00:00:00Z" };
    expect(resolvePresetGeometry(preset, [{ id: "runtime-2", name: "DISPLAY2", primary: false, workArea: { x: 1000, y: 10, width: 200, height: 300 } }])).toEqual({ display: { id: "runtime-2", name: "DISPLAY2", primary: false, workArea: { x: 1000, y: 10, width: 200, height: 300 } }, frame: { x: 1020, y: 70, width: 100, height: 120 } });
  });
  it("uses a geometry-matching secondary before an arbitrary secondary", () => {
    const displays = [
      { id: "left", name: "LEFT", primary: false, workArea: { x: -1600, y: 0, width: 1600, height: 900 } },
      { id: "right", name: "RIGHT", primary: false, workArea: { x: 1920, y: 0, width: 2560, height: 1440 } },
      { id: "primary", name: "PRIMARY", primary: true, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    ];
    expect(resolveDisplay({ primary: false, workArea: { width: 2560, height: 1440 } }, displays)?.id).toBe("right");
  });
});
