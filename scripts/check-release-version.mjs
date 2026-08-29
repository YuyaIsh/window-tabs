import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function releaseTagForVersion(version) {
  if (!semverPattern.test(version)) throw new Error(`invalid application version: ${version}`);
  return `v${version}`;
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
