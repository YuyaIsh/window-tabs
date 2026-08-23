import { describe, expect, it } from "vitest";
import { MockWindowBackend } from "./mockWindowBackend";

describe("MockWindowBackend", () => {
  it("moves only the requested runtime window", async () => {
    const backend = new MockWindowBackend([{ id: "one", processId: 1, appId: "app", appName: "App", title: "One", frame: { x: 0, y: 0, width: 10, height: 10 }, displayId: "primary", state: "normal" }]);
    await backend.setFrame("one", { x: 20, y: 30, width: 40, height: 50 });
    expect((await backend.listWindows())[0].frame).toEqual({ x: 20, y: 30, width: 40, height: 50 });
  });
  it("removes a closed group host from the platform adapter", async () => {
    const backend = new MockWindowBackend();
    await backend.openGroupHost("group-a");
    await backend.closeGroupHost("group-a");
    expect(backend.groupHosts).not.toContain("group-a");
  });
});
