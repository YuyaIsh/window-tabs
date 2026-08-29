import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

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
  const impactfulFiles = changedFiles(base).filter(isReleaseImpactingPath);
  if (!impactfulFiles.length) return { required: false, impactfulFiles, currentVersion };

  const hasCodeChange = impactfulFiles.some((filePath) => hasExecutableDiff(git(["diff", "--unified=0", base, "--", filePath]), filePath));
  if (!hasCodeChange) return { required: false, impactfulFiles, currentVersion };

  const baseVersion = readVersionAtRevision(base);
  if (currentVersion === baseVersion) {
    throw new Error(
      `release-impacting changes require an application version bump (still ${currentVersion}); update package.json, src-tauri/tauri.conf.json, and src-tauri/Cargo.toml`,
    );
  }
  return { required: true, impactfulFiles, baseVersion, currentVersion };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseFlagIndex = process.argv.indexOf("--base");
  const base = baseFlagIndex === -1 ? undefined : process.argv[baseFlagIndex + 1];

  try {
    const result = checkVersionBump({ base });
    if (result.required) {
      console.log(`release-impacting changes bump the application version from ${result.baseVersion} to ${result.currentVersion}.`);
    } else {
      console.log("no release-impacting changes require an application version bump.");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
