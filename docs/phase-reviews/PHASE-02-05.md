# Phases 02–05 — Implementation review

Status: **IN REVIEW**

Implementation continuation is authorized by the user while the Phase-0 GUI
review remains blocked. This record is not an approval substitute.

## Implemented

- Picker-created groups, explicit ungrouping, tab selection/activation,
  minimize/restore/destroy lifecycle updates, and a workspace that retains
  independent groups.
- Ctrl-gated native move/size observation with a visible host highlight while
  a native drag is in progress. Drops create a group, add an unmanaged window
  to a group, or move a tab between groups without relying on whichever group
  happened to be selected.
- Tab reorder, explicit tab-to-group move, and detach-to-new-group UI paths.
- Each additional group opens a separate compact native host window. Hosts use
  an in-process `BroadcastChannel` only for live workspace synchronization;
  the preset storage schema remains free of runtime IDs.
- Monitor enumeration, normalized group geometry, previous/next-display move,
  host-bar drag follow, display-disconnect fallback to the primary display,
  frame-settled synchronization, coalescing, and a one-second guard for
  self-generated frame events.
- Persisted presets, safe 0/1/many-candidate reconnection, later polling for
  newly created candidates, three-poll transient-disappearance tolerance,
  manual assignment through the picker, user tab names, optional title-pattern
  input, and per-preset matcher editing.
- The tray exposes saved presets directly; the diagnostic log is available
  from the group menu.

## Automated checks

- `pnpm test` — PASS (10 tests)
- `pnpm run build` — PASS
- `cargo fmt --check --manifest-path src-tauri/Cargo.toml` — PASS
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` — PASS

## Still requiring Windows 10 verification

- Physical Ctrl+D&D, cancel behavior, and drop targeting.
- Task View, Alt+Tab, taskbar, tray, and foreground-loop behavior.
- Two displays with mixed DPI, disconnect/reconnect, maximize, restore, and
  standard Windows 10 Snap.
- Restart/reconnect with 0, one, and ambiguous preset candidates.

## Review limitation

The automated UI driver can inspect the release WebView but cannot provide
click geometry for its buttons in this environment. Creation and interaction
of a second native host therefore remain **NOT RUN** rather than inferred.
