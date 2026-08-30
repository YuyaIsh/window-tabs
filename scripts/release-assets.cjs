function expectedReleaseAssets(version) {
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("release version is required");
  }

  return [
    `window-tabs_${version}_x64-setup.exe`,
    `window-tabs_${version}_x64-setup.exe.sig`,
    "latest.json",
  ];
}

module.exports = { expectedReleaseAssets };
