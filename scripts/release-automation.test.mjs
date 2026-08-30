import { describe, expect, it } from "vitest";

import { compareSemVer, releaseTagForVersion } from "./check-release-version.mjs";
import { hasExecutableDiff, isReleaseImpactingPath, shouldReleaseForMainPush } from "./check-version-bump.mjs";

describe("release automation helpers", () => {
  it("derives the tag from a valid application version", () => {
    expect(releaseTagForVersion("0.1.1")).toBe("v0.1.1");
  });

  it("rejects a non-SemVer application version", () => {
    expect(() => releaseTagForVersion("0.1")).toThrow("invalid application version");
  });

  it("orders stable and pre-release SemVer values", () => {
    expect(compareSemVer("0.1.1", "0.1.0")).toBeGreaterThan(0);
    expect(compareSemVer("0.1.0", "0.1.0-rc.1")).toBeGreaterThan(0);
    expect(compareSemVer("0.1.0-alpha.1", "0.1.0-alpha.2")).toBeLessThan(0);
    expect(compareSemVer("0.1.0+build.2", "0.1.0+build.1")).toBe(0);
  });

  it("skips non-release main pushes and rejects non-increasing releases", () => {
    expect(shouldReleaseForMainPush({ hasCodeChange: false, baseVersion: "0.1.1", currentVersion: "0.1.1" })).toBe(false);
    expect(shouldReleaseForMainPush({ hasCodeChange: true, baseVersion: "0.1.1", currentVersion: "0.1.2" })).toBe(true);
    expect(() => shouldReleaseForMainPush({ hasCodeChange: true, baseVersion: "0.1.1", currentVersion: "0.1.1" })).toThrow("newer than 0.1.1");
    expect(() => shouldReleaseForMainPush({ hasCodeChange: true, baseVersion: "0.2.0", currentVersion: "0.1.9" })).toThrow("newer than 0.2.0");
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

  it("ignores changed lines inside multiline CSS comments", () => {
    const before = "/*\nold note\n*/\n";
    const after = "/*\nnew note\n*/\n";
    const diff = "@@ -1,3 +1,3 @@\n /*\n-old note\n+new note\n */";
    expect(hasExecutableDiff(diff, "src/styles.css", { before, after })).toBe(false);

    const inlineCloseBefore = "/*\nold note */\n";
    const inlineCloseAfter = "/*\nnew note */\n";
    const inlineCloseDiff = "@@ -1,2 +1,2 @@\n /*\n-old note */\n+new note */";
    expect(hasExecutableDiff(inlineCloseDiff, "src/styles.css", { before: inlineCloseBefore, after: inlineCloseAfter })).toBe(false);
  });
});
