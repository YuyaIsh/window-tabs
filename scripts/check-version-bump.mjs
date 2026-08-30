import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { compareSemVer } from "./check-release-version.mjs";

const releaseImpactingPaths = [
  /^src\//,
  /^src-tauri\//,
  /^public\//,
  /^(?:package\.json|pnpm-lock\.yaml|index\.html)$/,
  /^(?:vite).*\.[cm]?[jt]sx?$/,
  /^tsconfig.*\.json$/,
];

function normalizePath(filePath) {
  return filePath.replaceAll("\\", "/");
}

export function isReleaseImpactingPath(filePath) {
  const normalizedPath = normalizePath(filePath);
  if (normalizedPath === "README.md" || normalizedPath.startsWith("docs/") || normalizedPath.endsWith(".md")) return false;
  return releaseImpactingPaths.some((pattern) => pattern.test(normalizedPath));
}

function isCommentOnlyLine(line, filePath) {
  if (line === "" || /^(?:\/\/|\/\*|\*|\*\/)/.test(line)) return true;
  if (/\.(?:toml|ya?ml)$/i.test(filePath) && line.startsWith("#")) return true;
  if (/\.html?$/i.test(filePath) && line.startsWith("<!--")) return true;
  return false;
}

export function hasExecutableDiff(diff, filePath = "") {
  if (diff.includes("Binary files ")) return true;
  return diff.split(/\r?\n/).some((line) => {
    if (!/^[+-]/.test(line) || line.startsWith("+++") || line.startsWith("---")) return false;
    const changedLine = line.slice(1).trim();
    return !isCommentOnlyLine(changedLine, filePath);
  });
}

function changedFilesWithCode(base) {
  const impactfulFiles = changedFiles(base).filter(isReleaseImpactingPath);
  const hasCodeChange = impactfulFiles.some((filePath) =>
    hasExecutableDiff(git(["diff", "--unified=0", base, "--", filePath]), filePath),
  );
  return { impactfulFiles, hasCodeChange };
}

export function shouldReleaseForMainPush({ hasCodeChange, baseVersion, currentVersion }) {
  const versionComparison = compareSemVer(currentVersion, baseVersion);
  if (!hasCodeChange && versionComparison === 0) return false;
  if (versionComparison <= 0) {
    throw new Error(
      `release-impacting changes require an application version newer than ${baseVersion} (current ${currentVersion}); update package.json, src-tauri/tauri.conf.json, and src-tauri/Cargo.toml`,
    );
  }
  return true;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function readVersionAtRevision(revision) {
  return JSON.parse(git(["show", `${revision}:package.json`])).version;
}

function changedFiles(base) {
  return git(["diff", "--name-only", "--diff-filter=ACMRD", base])
    .split(/\r?\n/)
    .filter(Boolean)
    .map(normalizePath);
}

export function checkVersionBump({ base, currentVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version } = {}) {
  if (!base) throw new Error("missing required --base revision");
  const { impactfulFiles, hasCodeChange } = changedFilesWithCode(base);
  if (!impactfulFiles.length) return { required: false, impactfulFiles, currentVersion };

  if (!hasCodeChange) return { required: false, impactfulFiles, currentVersion };

  const baseVersion = readVersionAtRevision(base);
  if (compareSemVer(currentVersion, baseVersion) <= 0) {
    const direction = currentVersion === baseVersion ? "still" : `must be newer than ${baseVersion} (current ${currentVersion})`;
    throw new Error(
      `release-impacting changes require an application version bump (${direction}); update package.json, src-tauri/tauri.conf.json, and src-tauri/Cargo.toml`,
    );
  }
  return { required: true, impactfulFiles, baseVersion, currentVersion };
}

export function checkMainPush({ base, currentVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version } = {}) {
  if (!base) throw new Error("missing required --base revision");

  const { impactfulFiles, hasCodeChange } = changedFilesWithCode(base);
  const baseVersion = readVersionAtRevision(base);
  const shouldRelease = shouldReleaseForMainPush({ hasCodeChange, baseVersion, currentVersion });

  return { shouldRelease, impactfulFiles, baseVersion, currentVersion };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseFlagIndex = process.argv.indexOf("--base");
  const base = baseFlagIndex === -1 ? undefined : process.argv[baseFlagIndex + 1];
  const mainPush = process.argv.includes("--main-push");

  try {
    const result = mainPush ? checkMainPush({ base }) : checkVersionBump({ base });
    if (mainPush) {
      console.log(result.shouldRelease ? "true" : "false");
      process.exitCode = 0;
    } else if (result.required) {
      console.log(`release-impacting changes bump the application version from ${result.baseVersion} to ${result.currentVersion}.`);
    } else {
      console.log("no release-impacting changes require an application version bump.");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
