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
- Each group opens one integrated native host window. The host owns the tab
  strip and the active external child window; inactive children are hidden.
  Hosts use an in-process `BroadcastChannel` only for live workspace
  synchronization; the preset storage schema remains free of runtime IDs.
- Native hosting snapshots parent/style/exstyle/frame, enables mixed-DPI
  hosting, commits registry ownership only after all Win32 mutations succeed,
  and restores children before dissolve, quit, and updater install.
- Monitor enumeration, normalized group geometry, previous/next-display move,
  host-bar drag follow, display-disconnect fallback to the primary display,
  frame-settled synchronization, coalescing, and a one-second guard for
  self-generated frame events.
- Persisted presets, safe 0/1/many-candidate reconnection, later polling for
  newly created candidates, three-poll transient-disappearance tolerance,
  manual assignment through the picker, user tab names, optional title-pattern
  input, and per-preset matcher editing.
- The tray exposes saved presets directly; the diagnostic log is available
  from the group menu. Applying a tray preset does not surface or focus the
  hidden controller WebView.
- The initial `main` WebView is the sole controller for workspace mutations,
  native events, polling, geometry writes, tray actions, and preset
  reconnection. Secondary group hosts receive snapshots and send commands.
- Presets store a persistent display hint instead of runtime HMONITOR-derived
  IDs. Applying or reconnecting a preset excludes every runtime window already
  owned by another group before evaluating match rules.
- Native drop targeting now enumerates top-level windows in Z order, skips the
  moving source, and applies the same manageable-window filter used by the
  picker. This can find a valid window behind the source at the cursor point.
- Picker state carries an explicit target-group and unresolved-tab context, so
  a secondary host's add button and a manual preset assignment both mutate the
  intended group even though the controller itself is not a group host.
- Focusing another group restores and activates its active real tab; it does
  not focus a group-bar host. A tab dropped outside every group host is
  released, while Esc cancels the drag without a workspace transition.

## Automated checks

- `pnpm test` — PASS (31 tests after controller, picker-context, duplicate
  ownership, display persistence, host lifecycle, display fallback, and
  virtual-desktop geometry coverage)
- `pnpm run build` — PASS
- `cargo fmt --check --manifest-path src-tauri/Cargo.toml` — PASS
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` — PASS

## Still requiring Windows 10 verification

- Physical Ctrl+D&D, cancel behavior, and drop targeting.
- Group host behavior in Task View, Alt+Tab, taskbar, tray, and foreground-loop
  behavior.
- Two displays with mixed DPI, disconnect/reconnect, maximize, restore, and
  standard Windows 10 Snap.
- Restart/reconnect with 0, one, and ambiguous preset candidates.
- Two simultaneous integrated group hosts must remain bound to their stable
  group IDs while focus changes; the controller is not a group host.
- Cross-group tab moves, outside-bar tab release, later preset reconnect, and
  manual preset assignment must place the real window at the destination frame.

## Manual procedure additions

1. Create two groups, then move, resize, focus, and Ctrl-drag a target in each
   group. Confirm exactly one tab/group mutation occurs per native action.
2. Save preset A using a window that is connected in group B. Apply A and
   confirm that window remains owned by B and A stays unresolved.
3. Apply a preset with an off-screen/missing monitor. Confirm the waiting host
   and every connected target move to the resolved monitor position.
4. Ctrl-drag a window over another window that remains behind the dragged
   source. Confirm the behind-window target is found; also confirm tooltips,
   menus, invisible windows, and the window-tabs host are never targets.
5. Open and close picker, preset manager, and diagnostics from an existing
   group. Confirm the host always returns to compact geometry and never leaves
   an input-blocking transparent 640px window.
6. Maximize, restore, and use normal Windows 10 Snap on the active tab. Confirm
   other tabs and the host follow exactly once.
7. Dissolve a secondary-host group, or move its final tab into another group.
   Confirm its native host window closes rather than remaining as an empty bar.
8. Create two groups and focus a native window in each. Confirm exactly two
   integrated hosts remain, each bound to its original group, regardless of
   active focus.
9. Reconnect a preset candidate or manually assign an unresolved preset tab.
   Confirm the newly connected real window moves to that group's saved frame.
10. Drop a tab outside every group bar. Confirm it is released from a
    multi-tab group (or its one-tab group is dissolved), then repeat with Esc
    and confirm ownership and group count are unchanged.
11. From a secondary host, use `＋` and manually assign an unresolved preset
    tab. Confirm the selected candidate is added or assigned to that exact
    group, not to a newly created group. Apply a tray preset while the
    controller is hidden and confirm no controller window is surfaced.
12. Drop a tab onto its own group-bar whitespace, group name, and `＋`; confirm
    it remains in that group. Drop it onto whitespace in another group bar and
    confirm it moves into that destination group rather than being released.

## Current review result

- Automated P0/P1/P2 findings: **0** for this change set.
- GUI verification: **NOT RUN** for the scenarios above; this document is not
  an approval claim.

## Review limitation

The automated UI driver can inspect the release WebView but cannot provide
click geometry for its buttons in this environment. Creation and interaction
of a second native host therefore remain **NOT RUN** rather than inferred.
