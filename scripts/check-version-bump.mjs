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

export function hasExecutableDiff(diff, filePath = "", sources = {}) {
  return hasExecutableDiffWithSources(diff, filePath, sources);
}

function blockCommentMarkers(filePath) {
  if (/\.html?$/i.test(filePath)) return { start: "<!--", end: "-->" };
  if (/\.(?:[cm]?[jt]sx?|s?css|rs)$/i.test(filePath)) return { start: "/*", end: "*/" };
  return null;
}

function supportsSlashComments(filePath) {
  return /\.(?:[cm]?[jt]sx?|rs)$/i.test(filePath);
}

function commentOnlyLineNumbers(source, filePath) {
  const markers = blockCommentMarkers(filePath);
  if (!markers) return new Set();

  const commentOnlyLines = new Set();
  let inBlockComment = false;
  let quote = null;
  let escaped = false;
  source.split(/\r?\n/).forEach((line, index) => {
    let cursor = 0;
    let hasCode = false;
    let hasBlockComment = false;

    while (cursor < line.length) {
      if (inBlockComment) {
        hasBlockComment = true;
        const end = line.indexOf(markers.end, cursor);
        if (end === -1) {
          cursor = line.length;
          break;
        }
        inBlockComment = false;
        cursor = end + markers.end.length;
        continue;
      }

      if (quote) {
        if (line.slice(cursor).trim()) hasCode = true;
        const character = line[cursor];
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === quote) {
          quote = null;
        }
        cursor += 1;
        continue;
      }

      if (supportsSlashComments(filePath) && !line.slice(0, cursor).trim() && line.slice(cursor).trimStart().startsWith("//")) {
        break;
      }

      const start = line.indexOf(markers.start, cursor);
      const quotePositions = [line.indexOf("\"", cursor), line.indexOf("'", cursor), line.indexOf("`", cursor)].filter((position) => position >= 0);
      const nextQuote = quotePositions.length ? Math.min(...quotePositions) : -1;
      if (start === -1 || (nextQuote >= 0 && nextQuote < start)) {
        if (nextQuote === -1) {
          if (line.slice(cursor).trim()) hasCode = true;
          break;
        }
        if (line.slice(cursor, nextQuote).trim()) hasCode = true;
        hasCode = true;
        quote = line[nextQuote];
        escaped = false;
        cursor = nextQuote + 1;
        continue;
      }
      if (line.slice(cursor, start).trim()) hasCode = true;
      hasBlockComment = true;
      inBlockComment = true;
      cursor = start + markers.start.length;
    }

    const trimmed = line.trim();
    const singleLineComment = (supportsSlashComments(filePath) && trimmed.startsWith("//")) || (markers.start === "<!--" && trimmed.startsWith("<!--"));
    if (!hasCode && (hasBlockComment || singleLineComment || markers.start === "/*" && line.trim() === "")) {
      commentOnlyLines.add(index + 1);
    }
  });
  return commentOnlyLines;
}

function changedDiffLines(diff) {
  let oldLine = 0;
  let newLine = 0;
  const changedLines = [];
  for (const line of diff.split(/\r?\n/)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) {
      changedLines.push({ side: "after", lineNumber: newLine, text: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith("-")) {
      changedLines.push({ side: "before", lineNumber: oldLine, text: line.slice(1) });
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return changedLines;
}

function hasExecutableDiffWithSources(diff, filePath, sources = {}) {
  if (diff.includes("Binary files ")) return true;
  if (sources.before !== undefined || sources.after !== undefined) {
    const beforeCommentLines = commentOnlyLineNumbers(sources.before || "", filePath);
    const afterCommentLines = commentOnlyLineNumbers(sources.after || "", filePath);
    return changedDiffLines(diff).some(({ side, lineNumber, text }) => {
      const commentLines = side === "after" ? afterCommentLines : beforeCommentLines;
      return !commentLines.has(lineNumber) && !isCommentOnlyLine(text.trim(), filePath);
    });
  }
  return diff.split(/\r?\n/).some((line) => {
    if (!/^[+-]/.test(line) || line.startsWith("+++") || line.startsWith("---")) return false;
    const changedLine = line.slice(1).trim();
    return !isCommentOnlyLine(changedLine, filePath);
  });
}

function changedFilesWithCode(base) {
  const impactfulFiles = changedFiles(base).filter(isReleaseImpactingPath);
  const hasCodeChange = impactfulFiles.some((filePath) =>
    hasExecutableDiffWithSources(
      git(["diff", "--unified=0", base, "--", filePath]),
      filePath,
      {
        before: readGitFile(base, filePath),
        after: readWorkingTreeFile(filePath),
      },
    ),
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

function readGitFile(revision, filePath) {
  try {
    return git(["show", `${revision}:${filePath}`]);
  } catch {
    return "";
  }
}

function readWorkingTreeFile(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
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
