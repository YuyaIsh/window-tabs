import { readFileSync, writeFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const configUrl = new URL("../src-tauri/tauri.conf.json", import.meta.url);
const config = JSON.parse(readFileSync(configUrl, "utf8"));
const cargo = readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
const mainCapability = JSON.parse(readFileSync(new URL("../src-tauri/capabilities/main.json", import.meta.url), "utf8"));
const groupCapability = JSON.parse(readFileSync(new URL("../src-tauri/capabilities/group-hosts.json", import.meta.url), "utf8"));
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const versions = [packageJson.version, config.version, cargoVersion];
const errors = [];

if (!versions.every((version) => version === versions[0])) errors.push(`version mismatch: ${versions.join(", ")}`);
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version)) errors.push("version must be SemVer");
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== `v${packageJson.version}`) errors.push(`release tag must be v${packageJson.version}`);
if (config.identifier !== "io.github.yuyaish.window-tabs") errors.push("production identifier changed");
if (!config.bundle?.targets?.includes("nsis")) errors.push("NSIS is not a bundle target");
if (config.bundle?.createUpdaterArtifacts !== true) errors.push("updater artifacts are disabled");
if (config.bundle?.windows?.nsis?.installMode !== "currentUser") errors.push("NSIS must use currentUser install mode");
if (config.plugins?.updater?.windows?.installMode !== "passive") errors.push("updater must use passive install mode");
const expectedEndpoint = "https://github.com/YuyaIsh/window-tabs/releases/latest/download/latest.json";
if (!config.plugins?.updater?.endpoints?.includes(expectedEndpoint)) errors.push("updater endpoint changed");
if (!mainCapability.permissions.includes("updater:default")) errors.push("controller updater permission is missing");
if (groupCapability.permissions.some((permission) => permission.startsWith("updater:") || permission.startsWith("process:"))) errors.push("secondary hosts must not own updater/process permissions");

const configuredPublicKey = process.env.TAURI_UPDATER_PUBLIC_KEY?.trim();
if (configuredPublicKey) {
  config.plugins.updater.pubkey = configuredPublicKey;
  writeFileSync(configUrl, `${JSON.stringify(config, null, 2)}\n`);
}
if (process.env.REQUIRE_RELEASE_KEY === "1") {
  if (!configuredPublicKey) errors.push("TAURI_UPDATER_PUBLIC_KEY repository variable is required");
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY) errors.push("TAURI_SIGNING_PRIVATE_KEY secret is required");
  if (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) errors.push("TAURI_SIGNING_PRIVATE_KEY_PASSWORD secret is required");
  if (config.plugins.updater.pubkey.startsWith("REPLACE_")) errors.push("updater public key placeholder is not releasable");
}

if (errors.length) {
  for (const error of errors) console.error(`release config: ${error}`);
  process.exit(1);
}
console.log(`release config valid for ${packageJson.version}`);
