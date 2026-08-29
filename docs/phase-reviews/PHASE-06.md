# Phase 06 — Distribution / Installer / Updater / Release hardening

Status: **IN_REVIEW; release acceptance remains BLOCKED: RELEASE VERIFICATION**

## Implemented

- Production identity `io.github.yuyaish.window-tabs` and documented pre-release identity break.
- Standard Tauri/Vite before-dev and before-build commands.
- Windows x86_64 current-user NSIS bundle as the only formal v1 installer.
- Tauri v2 updater plugin, controller-only capabilities, updater artifacts, passive Windows install, and public GitHub `latest.json` endpoint.
- Controller-only startup/manual checks with a 60-second process cooldown.
- User-separated check, download, install actions; on Windows the updater installer owns process exit/restart, with no polling or silent update.
- Update state/error UI, diagnostics, and Releases fallback.
- PR CI without signing secrets and a main-push release-only signing workflow with automatically published GitHub Releases.
- SemVer/config/tag checks and tracked-private-key scan.
- D-024 through D-027 and the distribution runbook.

## Automated checks

- `pnpm test` — PASS (13 files, 46 tests; updater cooldown/ownership/state/no-update/available/error/consent and release automation helpers included).
- `pnpm run build` — PASS (TypeScript and Vite production build).
- `pnpm run check:release` — PASS for `0.1.1` (SemVer/config/identity/endpoint/NSIS/capability assumptions).
- Release-key fail-closed check — PASS; absent public key/private key/password rejects release configuration.
- `pnpm run check:secrets` — PASS (126 tracked/untracked non-ignored repository files).
- `actionlint 1.7.12 .github/workflows/*.yml` — PASS; downloaded archive checksum verified.
- `git diff --check` — PASS.
- `cargo fmt --check --manifest-path src-tauri/Cargo.toml` — PASS.
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` — PASS.
- `cargo test --manifest-path src-tauri/Cargo.toml` — PASS (0 Rust unit tests; Windows test binary compiled and ran).

## Security checks

- Gitleaks 8.30.1 final full-history scan — PASS: 34 commits, approximately 955 KB, no leaks. The official Linux archive SHA-256 was verified before execution.
- Full-history high-risk filename search (`.env`, key/certificate/keystore extensions, SSH key names) — no matches.
- Full-history content search for PAT prefixes, private-key markers, assigned signing keys, and absolute `C:\Users`/`/home/<user>` paths — no matches.
- Current repository private-key marker/extension scan — PASS.

Updater private key/password were not generated, displayed, or committed. The checked-in public-key placeholder makes a release fail closed until the signing ceremony is complete.

**MANUAL SECRET BACKUP REQUIRED.**

## Distribution checks

- Configuration/schema validation: PASS through Tauri build scripts, release-config check, Rust compile, and actionlint.
- Unsigned local NSIS build: PASS using the CI config override; the recorded artifact was `window-tabs_0.1.0_x64-setup.exe` before the release-automation version bump.
- Normal signed `pnpm tauri build`: NOT RUN; production signing key/public key are intentionally unavailable. The unsigned CI-equivalent bundle does not prove updater signing.
- Signed updater artifact / `.sig` / `latest.json`: NOT RUN (signing key intentionally unavailable).
- GitHub Actions release reproduction: NOT RUN.

## Release verification

The following are **NOT RUN** and are not PASS:

1. clean Windows NSIS install;
2. installed app and tray startup;
3. uninstall;
4. unauthenticated public GitHub Release download;
5. public `latest.json` retrieval;
6. version N detecting N+1;
7. updater signature verification;
8. user Update action;
9. N+1 startup;
10. preset/settings retention;
11. failure leaving N usable;
12. release workflow artifact reproduction;
13. repository/release/log secret exposure review.

Phase 0–5 Windows GUI verification remains unchanged and NOT RUN where previously recorded, including physical Ctrl D&D, Task View/Alt+Tab, Snap/maximize/restore, multiple groups, mixed DPI/display disconnect, preset reconnect, and tab D&D.

## Review findings

- P1 — Updater/process capability was initially available to secondary group hosts. Fixed by splitting `main` and `group-hosts` capabilities; unit/config checks now enforce controller-only ownership.
- P1 — The existing opener JS package lacked Rust plugin initialization, breaking the fallback capability. Fixed with `tauri-plugin-opener` and builder initialization.
- P1 — Plugin JSON config required an explicit `serde_json` dependency for generated context compilation. Fixed and recompiled.
- P2 — The private-key scanner initially matched its own minisign marker. Fixed by constructing the marker from fragments; repository scan now passes.
- P2 — First GitHub CI run rejected duplicate pnpm version declarations in `package.json` and `pnpm/action-setup`. Fixed by letting the action read the pinned `packageManager`; local actionlint passed before rerun.
- P2 — Release workflow used an outdated `tauri-action`. Fixed by pinning the immutable commit for the current `action-v1.0.0` release and validating the v1 inputs with actionlint.
- P2 — The release-key preflight accepted an empty `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, as GitHub Actions maps a missing secret to an empty string. Fixed by rejecting missing and whitespace-only private keys/passwords.
- P2 — Frontend updater code called the process-plugin relaunch after `install()`, although Windows updater installation exits the app itself. Fixed by removing the process plugin and delegating exit/restart to the Windows updater installer; the unit test now asserts only explicit download/install calls.
- P2 — Docs implied that an unsigned installer could be built with normal `pnpm tauri build`. Fixed with the explicit `pnpm run build:unsigned` CI-equivalent script and documentation that normal builds require signing-key environment variables.

The fixes require reviewer re-review before code approval is restored.

## Release automation follow-up

- The repository's latest existing tag is `v0.1.0`; the synchronized application version for this change is `0.1.1`.
- `.github/workflows/release.yml` now runs on `main` pushes only. It does not run from tag pushes or require a manual dispatch/tag.
- Before Release creation, `actions/github-script` atomically creates the version-derived tag at the current commit and a new marked draft Release with `GITHUB_TOKEN`; a final automatic step publishes it only after Tauri asset upload succeeds. It stops with `Bump the application version before releasing.` for a tag on another commit, a published Release, or an unrecognized/non-empty draft. A retry may resume only an empty marked draft for the same commit, without force-updating the tag or overwriting assets.
- The pinned `tauri-apps/tauri-action` SHA `1deb371b0cd8bd54025b384f1cd735e725c4060f` resolves to `action-v1.0.0`; `releaseId`, `tagName: v__VERSION__`, `releaseDraft: false`, `uploadUpdaterJson: true`, and `updaterJsonPreferNsis: true` preserve the updater artifact flow. The action builds and uploads assets for that immutable Release.
- PR CI checks that release-impacting code/dependency changes change the application version; documentation, README, and comment-only changes do not require a bump.
- The release workflow uses a non-canceling concurrency group so queued `main` releases re-check the tag after the earlier release completes.

Current unresolved P0/P1/P2: **0**, pending reviewer re-review.

## Deferred

- Windows Authenticode and SmartScreen reputation; unsigned-warning documentation is included.
- Microsoft Store.
- macOS packaging, Apple signing, and notarization.

## Approval

- Code review: **IN_REVIEW** (the four P2 fixes are awaiting reviewer confirmation).
- Release acceptance: BLOCKED — real public release and N→N+1 smoke are not run.
- Phase 6: **BLOCKED: RELEASE VERIFICATION**.
