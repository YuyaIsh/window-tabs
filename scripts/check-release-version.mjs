import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemVer(version) {
  const match = semverPattern.exec(version);
  if (!match) throw new Error(`invalid application version: ${version}`);

  return {
    core: match.slice(1, 4),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

export function releaseTagForVersion(version) {
  parseSemVer(version);
  return `v${version}`;
}

function compareNumericIdentifiers(left, right) {
  const normalizedLeft = left.replace(/^0+(?=\d)/, "");
  const normalizedRight = right.replace(/^0+(?=\d)/, "");
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length > normalizedRight.length ? 1 : -1;
  }
  return normalizedLeft === normalizedRight ? 0 : normalizedLeft > normalizedRight ? 1 : -1;
}

export function compareSemVer(left, right) {
  const leftVersion = parseSemVer(left);
  const rightVersion = parseSemVer(right);

  for (let index = 0; index < leftVersion.core.length; index += 1) {
    const comparison = compareNumericIdentifiers(leftVersion.core[index], rightVersion.core[index]);
    if (comparison !== 0) return comparison;
  }

  if (!leftVersion.prerelease.length && !rightVersion.prerelease.length) return 0;
  if (!leftVersion.prerelease.length) return 1;
  if (!rightVersion.prerelease.length) return -1;

  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= leftVersion.prerelease.length) return -1;
    if (index >= rightVersion.prerelease.length) return 1;

    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];
    const leftIsNumeric = /^\d+$/.test(leftIdentifier);
    const rightIsNumeric = /^\d+$/.test(rightIdentifier);
    if (leftIsNumeric && rightIsNumeric) {
      const comparison = compareNumericIdentifiers(leftIdentifier, rightIdentifier);
      if (comparison !== 0) return comparison;
    } else if (leftIsNumeric !== rightIsNumeric) {
      return leftIsNumeric ? -1 : 1;
    } else if (leftIdentifier !== rightIdentifier) {
      return leftIdentifier > rightIdentifier ? 1 : -1;
    }
  }

  return 0;
}

export function shouldPublishAsLatest(currentVersion, latestVersion) {
  if (latestVersion === null || latestVersion === undefined) return true;
  return compareSemVer(currentVersion, latestVersion) > 0;
}

export function latestPublishedVersion(releases) {
  let latestVersion = null;
  for (const release of releases.filter((candidate) => !candidate.draft && !candidate.prerelease)) {
    const tag = release?.tag_name;
    const version = typeof tag === "string" && tag.startsWith("v") ? tag.slice(1) : null;
    if (!version) throw new Error(`invalid published release tag: ${tag ?? "<missing>"}`);
    parseSemVer(version);
    if (latestVersion === null || compareSemVer(version, latestVersion) > 0) latestVersion = version;
  }
  return latestVersion;
}

export function readApplicationVersion() {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return packageJson.version;
}

export function assertReleaseTagIsUnused({ version = readApplicationVersion(), remote = process.env.RELEASE_TAG_REMOTE || "origin" } = {}) {
  const tag = releaseTagForVersion(version);
  try {
    execFileSync("git", ["ls-remote", "--exit-code", "--refs", remote, `refs/tags/${tag}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error.status === 2) return { tag, version };
    throw new Error(`could not verify whether ${tag} already exists on ${remote}`);
  }
  throw new Error(`${tag} already exists. Bump the application version before releasing.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = assertReleaseTagIsUnused();
    console.log(`${result.tag} is available for release.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
