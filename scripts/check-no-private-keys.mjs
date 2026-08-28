import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tracked = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\0").filter(Boolean);
const forbiddenExtensions = /\.(?:p12|pfx|key|jks|keystore)$/i;
const minisignSecretMarker = ["untrusted comment: minisign encrypted", " secret key"].join("");
const findings = [];
for (const file of tracked) {
  if (forbiddenExtensions.test(file)) findings.push(`${file}: private-key extension`);
  let contents;
  try { contents = readFileSync(file, "utf8"); } catch { continue; }
  if (/-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/.test(contents)) findings.push(`${file}: PEM private key`);
  if (contents.includes(minisignSecretMarker)) findings.push(`${file}: minisign private key`);
}
if (findings.length) {
  for (const finding of findings) console.error(`tracked secret material: ${finding}`);
  process.exit(1);
}
console.log(`repository private-key scan passed (${tracked.length} files)`);
