import { describe, expect, it } from "vitest";
import { matchWindow, reconnectGroup } from "./matching";
import { groupToPreset } from "./presets";
import type { TabGroup, WindowInfo } from "./model";

const window = (id: string, title = "Editor"): WindowInfo => ({ id, processId: 1, appId: "code.exe", appName: "Code", title, frame: { x: 0, y: 0, width: 1, height: 1 }, displayId: "primary", state: "normal" });

describe("preset persistence model", () => {
  it("does not persist runtime window ids", () => {
    const group: TabGroup = { id: "group", name: "Work", tabs: [{ id: "tab", name: "Editor", runtimeWindowId: "0x123", status: "connected" }], displayId: "primary", frame: { x: 0, y: 0, width: 1, height: 1 } };
    expect(JSON.stringify(groupToPreset(group))).not.toContain("0x123");
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
});
