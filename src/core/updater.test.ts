import { describe, expect, it, vi } from "vitest";
import { canCheckForUpdate, ownsUpdater, UPDATE_CHECK_COOLDOWN_MS, UpdateController, type UpdateRuntime } from "./updater";

function runtime(update: Awaited<ReturnType<UpdateRuntime["check"]>> = null): UpdateRuntime {
  return { check: vi.fn().mockResolvedValue(update) };
}

describe("controller-owned updater", () => {
  it("assigns updater ownership only to the controller host", () => {
    expect(ownsUpdater(undefined)).toBe(true);
    expect(ownsUpdater("group-1")).toBe(false);
  });

  it("rate limits checks in one process", async () => {
    let now = 1_000;
    const adapter = runtime();
    const controller = new UpdateController(adapter, () => now);
    await controller.check(() => undefined);
    now += UPDATE_CHECK_COOLDOWN_MS - 1;
    await controller.check(() => undefined);
    expect(adapter.check).toHaveBeenCalledTimes(1);
    now += 1;
    await controller.check(() => undefined);
    expect(adapter.check).toHaveBeenCalledTimes(2);
    expect(canCheckForUpdate(now, now)).toBe(false);
  });

  it("reports no update without installing", async () => {
    const adapter = runtime();
    const controller = new UpdateController(adapter);
    const states: string[] = [];
    await controller.check((state) => states.push(state.status));
    expect(states).toEqual(["checking", "up-to-date"]);
  });

  it("requires separate user calls before download and install", async () => {
    const update = { currentVersion: "0.1.0", version: "0.2.0", notes: "notes", download: vi.fn().mockResolvedValue(undefined), install: vi.fn().mockResolvedValue(undefined) };
    const adapter = runtime(update);
    const controller = new UpdateController(adapter);
    await controller.check(() => undefined);
    expect(controller.snapshot().status).toBe("available");
    expect(update.download).not.toHaveBeenCalled();
    expect(update.install).not.toHaveBeenCalled();
    await controller.download(() => undefined);
    expect(controller.snapshot().status).toBe("ready");
    expect(update.install).not.toHaveBeenCalled();
    await controller.install(() => undefined);
    expect(update.install).toHaveBeenCalledOnce();
  });

  it("keeps update failures non-fatal", async () => {
    const adapter: UpdateRuntime = { check: vi.fn().mockRejectedValue(new Error("network unavailable")) };
    const controller = new UpdateController(adapter);
    await expect(controller.check(() => undefined)).resolves.toMatchObject({ status: "error", error: "network unavailable" });
  });
});
