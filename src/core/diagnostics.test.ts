import { describe, expect, it } from "vitest";
import { diagnostics, recordDiagnostic } from "./diagnostics";

describe("diagnostics", () => {
  it("retains a bounded in-memory diagnostic trail", () => {
    recordDiagnostic("info", "test event");
    expect(diagnostics().at(-1)?.message).toBe("test event");
  });
});
