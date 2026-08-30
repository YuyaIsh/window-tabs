import { describe, expect, it } from "vitest";

import { compareSemVer, latestPublishedVersion, releaseTagForVersion, shouldPublishAsLatest } from "./check-release-version.mjs";
import { hasExecutableDiff, isReleaseImpactingPath, shouldReleaseForMainPush } from "./check-version-bump.mjs";
import { expectedReleaseAssets } from "./release-assets.cjs";

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

  it("does not let an older rerun take over Latest Release", () => {
    expect(shouldPublishAsLatest("0.1.1", null)).toBe(true);
    expect(shouldPublishAsLatest("0.1.1", "0.1.2")).toBe(false);
    expect(shouldPublishAsLatest("0.1.3", "0.1.2")).toBe(true);
    expect(shouldPublishAsLatest("0.1.2", "0.1.2")).toBe(false);
  });

  it("compares against the highest published SemVer regardless of release order", () => {
    expect(latestPublishedVersion([
      { tag_name: "v0.1.2", draft: false, prerelease: false, created_at: "2026-08-01T00:00:00Z" },
      { tag_name: "v0.1.1", draft: false, prerelease: false, created_at: "2026-08-02T00:00:00Z" },
      { tag_name: "v0.9.0", draft: true, prerelease: false },
      { tag_name: "v1.0.0-rc.1", draft: false, prerelease: true },
    ])).toBe("0.1.2");
  });

  it("matches the observed Tauri v0.1.0 Release asset set", () => {
    expect(expectedReleaseAssets("0.1.0")).toEqual([
      "window-tabs_0.1.0_x64-setup.exe",
      "window-tabs_0.1.0_x64-setup.exe.sig",
      "latest.json",
    ]);
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

  it("does not treat comment markers inside CSS or TypeScript strings as comments", () => {
    const cssBefore = '--marker: "/*";\n.button { color: red; }\n';
    const cssAfter = '--marker: "/*";\n.button { color: blue; }\n';
    const cssDiff = "@@ -1,2 +1,2 @@\n --marker: \"/*\";\n-.button { color: red; }\n+.button { color: blue; }";
    expect(hasExecutableDiff(cssDiff, "src/styles.css", { before: cssBefore, after: cssAfter })).toBe(true);

    const tsBefore = "const marker = `/*`;\nconst value = 1;\n";
    const tsAfter = "const marker = `/*`;\nconst value = 2;\n";
    const tsDiff = "@@ -1,2 +1,2 @@\n const marker = `/*`;\n-const value = 1;\n+const value = 2;";
    expect(hasExecutableDiff(tsDiff, "src/core/example.ts", { before: tsBefore, after: tsAfter })).toBe(true);

    const multilineBefore = "const message = `\n/* old\n`;\n";
    const multilineAfter = "const message = `\n/* new\n`;\n";
    const multilineDiff = "@@ -1,3 +1,3 @@\n const message = `\n-/* old\n+/* new\n `;";
    expect(hasExecutableDiff(multilineDiff, "src/core/example.ts", { before: multilineBefore, after: multilineAfter })).toBe(true);
  });

  it("does not treat hash-prefixed data inside TOML or YAML multiline values as comments", () => {
    const tomlBefore = 'message = """\n# old\n"""\n';
    const tomlAfter = 'message = """\n# new\n"""\n';
    const tomlDiff = "@@ -1,3 +1,3 @@\n message = \"\"\"\n-# old\n+# new\n \"\"\"";
    expect(hasExecutableDiff(tomlDiff, "src-tauri/Cargo.toml", { before: tomlBefore, after: tomlAfter })).toBe(true);

    const yamlBefore = "message: |\n  # old\n";
    const yamlAfter = "message: |\n  # new\n";
    const yamlDiff = "@@ -1,2 +1,2 @@\n message: |\n-  # old\n+  # new";
    expect(hasExecutableDiff(yamlDiff, "pnpm-lock.yaml", { before: yamlBefore, after: yamlAfter })).toBe(true);
  });

  it("treats changed block-comment delimiters as executable syntax changes", () => {
    const before = "/* gate */\n.button { color: red; }\n";
    const after = "/* gate\n.button { color: red; }\n*/\n";
    const diff = "@@ -1,2 +1,3 @@\n-/* gate */\n+/* gate\n .button { color: red; }\n+*/";
    expect(hasExecutableDiff(diff, "src/styles.css", { before, after })).toBe(true);
  });
});
