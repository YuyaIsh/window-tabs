import { describe, expect, it } from "vitest";

import { releaseTagForVersion } from "./check-release-version.mjs";
import { hasExecutableDiff, isReleaseImpactingPath } from "./check-version-bump.mjs";

describe("release automation helpers", () => {
  it("derives the tag from a valid application version", () => {
    expect(releaseTagForVersion("0.1.1")).toBe("v0.1.1");
  });

  it("rejects a non-SemVer application version", () => {
    expect(() => releaseTagForVersion("0.1")).toThrow("invalid application version");
  });

  it("ignores documentation and README paths", () => {
    expect(isReleaseImpactingPath("docs/DISTRIBUTION.md")).toBe(false);
    expect(isReleaseImpactingPath("README.md")).toBe(false);
    expect(isReleaseImpactingPath("src-tauri/src/lib.rs")).toBe(true);
  });

  it("ignores comment-only diffs while detecting executable changes", () => {
    expect(hasExecutableDiff("+// comment", "src/core/controller.ts")).toBe(false);
    expect(hasExecutableDiff("+# comment", "src-tauri/Cargo.toml")).toBe(false);
    expect(hasExecutableDiff("+const changed = true;", "src/core/controller.ts")).toBe(true);
  });
});
