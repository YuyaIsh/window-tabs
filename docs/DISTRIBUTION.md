# Distribution, installer, and updater

## Status and scope

Windows v1 is distributed as an x86_64 NSIS `setup.exe` from public GitHub Releases. The same release provides Tauri v2 updater metadata and signed updater artifacts. Microsoft Store and macOS distribution are later work.

The repository remains private while the Phase 6 implementation PR is reviewed. Visibility may be changed only after the full-history security gate is clean. Public repository visibility does not grant an OSS license; no license is added without a separate owner decision.

## Application identity and persistence

The production identifier is `io.github.yuyaish.window-tabs`. It is fixed before the first public release because changing it can change installer identity and WebView/application-data locations. The earlier unreleased `local.window-tabs` identity is not migrated automatically.

Presets are stored in WebView local storage under `window-tabs.presets.v1`, not in the installation directory. NSIS current-user upgrade and Tauri updater installs replace application files while retaining application data for the unchanged identifier. Runtime HWND/HMONITOR values are never persisted. This design assumption is automated; actual N→N+1 retention remains a mandatory Windows smoke test.

## Windows installer

`pnpm tauri build` runs the frontend build through `beforeBuildCommand`, produces only NSIS by default, and requires Tauri signing-key environment variables because production updater artifacts are enabled. Before the signing ceremony, use `pnpm run build:unsigned`; it builds the frontend and uses `src-tauri/tauri.ci.conf.json` to disable updater artifacts before producing an unsigned NSIS bundle. The installer uses `currentUser` mode, does not require administrator privileges, creates normal Windows application shortcuts, supports uninstall, and installs the tray application.

The formal download is the x64 `setup.exe` attached to a GitHub Release. MSI is not a supported v1 entry point.

## Updater architecture

The controller WebView is the sole updater owner. Secondary group hosts never call the updater plugin. The controller:

1. checks once 1.5 seconds after startup;
2. accepts manual checks from the tray item `更新を確認…`;
3. rate-limits endpoint requests to one per 60 seconds per process;
4. shows the available version and notes;
5. downloads only after `更新をダウンロード`;
6. installs only after `インストールして再起動`; on Windows the updater launches the installer and exits this process, and the installer performs the subsequent restart;
7. records failures in diagnostics and offers the Releases page without blocking normal use.

There is no constant polling, silent download, silent restart, private GitHub API, PAT, or embedded GitHub credential. The endpoint is:

`https://github.com/YuyaIsh/window-tabs/releases/latest/download/latest.json`

Network failure, missing/malformed `latest.json`, invalid signature, interrupted download, and install failure leave the currently installed app available. Same-version metadata returns no update through the plugin's SemVer comparison.

## Updater signing

Tauri updater signatures are mandatory and independent from Windows Authenticode. Before the first release, generate the long-lived Tauri signing key in a controlled key ceremony. Do not print or commit the private key or password.

Configure:

- GitHub repository variable `TAURI_UPDATER_PUBLIC_KEY` with the complete Tauri public-key content;
- GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY`;
- GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

The release workflow injects the public key into the build-only config without logging it and refuses to run while the checked-in placeholder remains unresolved. Store an encrypted private-key backup outside GitHub and test recovery before first release. GitHub Secrets must not be the only copy.

**MANUAL SECRET BACKUP REQUIRED.** This repository and this implementation do not claim that a safe off-GitHub backup exists.

## GitHub Actions

`.github/workflows/ci.yml` runs on Windows for PRs and `main`: frozen pnpm install, frontend tests/build, release-config checks, tracked-private-key scan, Rust fmt/clippy/test, and unsigned NSIS smoke. It has read-only repository permissions and no signing secrets.

`.github/workflows/release.yml` runs on pushes to `main`, which includes the normal pull-request merge path. Its read-only gate reuses the version/change helper: docs, README, comments, and workflow-only pushes with no newer application version finish successfully without a Release; release-impacting pushes must carry a newer SemVer. The release job alone has `contents: write`; it uses the GitHub-provided `GITHUB_TOKEN`, Tauri signing secrets, and the immutable SHA for `tauri-apps/tauri-action` `action-v1.0.0`. Before building, it checks the version/tag; after all preflight checks, the workflow atomically creates the version-derived tag at the current commit and reserves a draft Release through the GitHub API. The Tauri action receives `tagName: v__VERSION__` and the newly created Release ID, then builds and uploads the NSIS setup, its `.sig`, and `latest.json` without adopting or overwriting another Release. A final automatic step verifies all expected assets, compares against the highest published non-prerelease SemVer, refuses to publish an older rerun, and publishes the Release only after the signed assets and updater metadata upload succeeds; a failed build leaves the Release unpublished. `updaterJsonPreferNsis` prevents MSI selection. The workflow is not triggered by tag pushes, so the generated tag cannot recursively start another release. No `git tag`, `git push`, PAT, or manual Release operation is used.

## Release procedure

### One-time prerequisites

1. Complete the Phase 6 PR review and confirm unresolved P0/P1/P2 = 0.
2. Complete the full-history secret review, then explicitly change repository visibility to public.
3. Generate the signing key, configure its public key, create both signing Secrets, create the public-key Variable, and verify the independent encrypted backup.

### Normal release

1. In the implementation PR, bump `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` to the same next SemVer.
2. Complete review and CI, including the release-impacting-change version-bump check.
3. Merge the PR into `main`.
4. The Release workflow automatically runs its gate and preflight checks, builds and signs the Windows x86_64 NSIS bundle, and verifies that `v<version>` is unused.
5. The workflow atomically creates `v<version>` and a temporary draft `window-tabs v<version>` Release at the merged commit; Tauri action builds and uploads the setup/updater/signature/`latest.json` assets, then an automatic final step verifies the complete asset set and publishes the Release.
6. Verify unauthenticated setup/latest.json downloads and perform the clean-install or N→N+1 smoke appropriate for the release.

No normal release step requires manually creating or pushing a tag, creating a GitHub Release, or publishing a draft Release. The workflow stops with a clear error if the application version already has a tag for another commit, an unrecognized/incomplete published Release, or a Release with a different marker. A retry may resume only an automated draft whose tag points to the same merged commit: a complete draft uses publish-only, while a partial draft rebuilds and replaces only the generated asset names through the pinned action. Before publishing, it compares the candidate SemVer with the highest published non-prerelease SemVer; an older or equal stale rerun fails without publishing or modifying the published Release. A completed automated Release is treated as an idempotent successful retry. It never force-updates a tag or modifies a published Release's assets.

### Ongoing distribution verification

1. For N+1, install N, save a preset/settings, merge the version-bumped PR, allow the Windows updater installer to restart, and verify retained data.
2. Exercise unavailable metadata, invalid-signature test metadata in an isolated test channel, interrupted download, and install failure; verify N remains usable.
3. Record evidence in `docs/phase-reviews/PHASE-06.md`. Only then may distribution be approved.

## Acceptance gate

Code/config review does not prove public distribution. Clean install, uninstall, public unauthenticated download, generated `latest.json`, N→N+1 detection and signature verification, user-authorized install followed by updater-installer restart, persistence, failure safety, workflow reproducibility, and release/log secret review must all be observed. Until then Phase 6 is `BLOCKED: RELEASE VERIFICATION`.

Unsigned installers may trigger Windows Defender SmartScreen warnings. Authenticode can improve publisher reputation but is separate from updater artifact signing and is not a Phase 6 blocker. The warning and manual trust decision must be included in the first-release notes.

## macOS later

macOS will reuse GitHub Releases, versioning, update ownership, and the signing pipeline. DMG, Apple code signing, notarization, Accessibility onboarding, and macOS updater smoke belong to later macOS phases.
