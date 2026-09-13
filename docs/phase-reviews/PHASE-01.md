# Phase 01 — Cross-platform foundation

Status: **IN REVIEW**

## Implemented

- Tauri, React, TypeScript, and Rust application shell with an integrated
  native group-host surface: tab strip above the active external child window.
- OS-neutral TypeScript models for runtime windows, groups, tabs, matching
  rules, normalized frames, and persisted presets.
- Tauri command boundary between React UI and the Windows implementation.
- Windows backend for top-level window enumeration, activation, restore, frame
  placement, foreground-window lookup, and monitor work-area enumeration.
- Win32 `SetWinEventHook` bridge for foreground, minimize, restore, and
  destroy lifecycle events; the React layer receives only normalized events.
- A Ctrl-gated native move/size event route that resolves the drop target and
  applies the same core group-add path used by the picker.
- Runtime IDs are intentionally omitted from the preset persistence schema;
  executable path and window class are platform hints, not runtime handles.
- Safe matching behavior: zero or multiple candidates stay unresolved.
- Windows tray launcher with new-group, preset-manager, and quit actions.
- Tray menus are refreshed from the persisted preset list, so a saved preset
  can be applied directly from the tray.
- A platform mock and bounded in-memory diagnostic log are available for
  automated tests and user-visible diagnostics.
- Generated application icon assets.

## Automated checks

- `pnpm test` — PASS (10 core tests)
- `pnpm run build` — PASS (TypeScript check and production frontend build)
- `cargo fmt --check --manifest-path src-tauri/Cargo.toml` — PASS
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` — PASS

## Behavior verification

- Release WebView renders the tab bar from bundled frontend assets — PASS.
- `+` opens the real Windows top-level window picker — PASS.
- The picker identifies Chrome, Notion, PowerShell, and other real windows by
  their executable name — PASS.
- The picker excludes the running `window-tabs` host itself — PASS.
- A real Chrome window can create a group, and the current group can be saved
  through the preset dialog — PASS.
- A release build with the WinEvent bridge and native-drag observation starts
  normally — PASS. End-to-end physical Ctrl+D&D remains NOT RUN.

## Review findings

- P2 — Each group now opens its own integrated native group host; group state is
  synchronized in-process and runtime IDs are not persisted. End-to-end
  multi-host interaction, child restore, and task-switcher semantics still
  require Windows 10 verification.
- P2 — Manual Windows 10 scenarios remain required under the user-authorized
  implementation-continuation exception recorded for Phase 0.

## Approval

- Acceptance criteria: INCOMPLETE
- Architecture boundary: provisional PASS — UI uses only the command client;
  runtime HWND values do not enter the shared model or persistence schema.
- Unresolved P0–P2: 2
