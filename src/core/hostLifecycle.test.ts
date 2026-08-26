import { describe, expect, it } from "vitest";
import { reconcileGroupHosts } from "./hostLifecycle";

describe("controller host lifecycle", () => {
  const workspace = (ids: string[], activeGroupId = ids[0]) => ({ groups: ids.map((id) => ({ id, name: id, tabs: [], displayId: "display", frame: { x: 0, y: 0, width: 1, height: 1 } })), activeGroupId });
  it("maintains exactly one stable native host per group, independent of activeGroupId", () => {
    expect(reconcileGroupHosts([], workspace(["A", "B"]))).toEqual({ open: ["A", "B"], close: [] });
    expect(reconcileGroupHosts(["A", "B"], workspace(["A", "B"], "B"))).toEqual({ open: [], close: [] });
    expect(reconcileGroupHosts(["A", "B"], workspace(["B"], "B"))).toEqual({ open: [], close: ["A"] });
  });
});
