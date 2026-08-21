# Phase 00 — Windows feasibility spike

Status: **BLOCKED: MANUAL VERIFICATION**

Implementation continuation: **AUTHORIZED BY USER** — Phase 1 onward may be
implemented, but this phase and Windows v1 remain unapproved until the listed
manual checks are completed.

## Implemented

- Added the isolated Win32 probe in `spikes/windows/`, including an
  interactive-desktop window picker for build runners that cannot see the
  user's desktop.
- `list` uses `EnumWindows` and reports HWND, PID, class, title, frame, and
  styles for visible unowned top-level windows.
- `overlap` moves windows to a shared frame; `activate` exercises the explicit
  foreground path.
- `watch` uses `SetWinEventHook` for foreground, move/resize, create, destroy,
  location, minimize, and restore events. It reports Ctrl state at move start
  and resolves the top-level drop target at move end.
- `host` creates a `WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE` native tab-bar probe,
  places it topmost with `SetWindowPos`, and returns focus to its configured
  target on click.
- `monitors` reports each monitor work area and effective DPI.

## Automated checks

- `git diff --no-index --check /dev/null <each added file>` — PASS
- `cargo fmt --all --manifest-path spikes/windows/Cargo.toml -- --check` — PASS
- `CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=<local Windows temp directory> cargo
  check --manifest-path spikes/windows/Cargo.toml` — PASS. The temporary target
  directory avoids an NTFS lock limitation when building from this WSL UNC path.
- `CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=<local Windows temp directory> cargo
  clippy --manifest-path spikes/windows/Cargo.toml -- -D warnings` — PASS
- `CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=<local Windows temp directory> cargo
  test --manifest-path spikes/windows/Cargo.toml` — PASS (0 tests; test target
  compiled successfully)

## Behavior verification

All Phase-0 GUI verification remains **NOT RUN**. This environment cannot
exercise the interactive Windows 10 GUI and must not stand in for those tests.

The build runner was also used to launch `list`, but it runs outside the user's
interactive window station and therefore saw no desktop windows. That result is
not used as verification evidence; the probe must be launched from the
interactive Windows desktop described in `spikes/windows/README.md`.

Run the procedures in `spikes/windows/README.md` and replace the following
with the observed result and any command output reference.

| Verification | Windows 10 |
| --- | --- |
| 1. Enumerate external top-level windows | PASS — the interactive picker listed Chrome, Notion, and other external top-level windows. |
| 2. Distinguish multiple Chrome windows by HWND | PASS — `0x40AE6` and `0x20E1E` were listed as distinct Chrome windows. |
| 3. Overlap windows at one frame | NOT RUN |
| 4. Activate from tab-click-equivalent host | NOT RUN |
| 5. Observe foreground/move/resize/create/destroy | NOT RUN |
| 6. Task View / Alt+Tab keep real windows distinct | NOT RUN |
| 7. Exclude host from Task View / Alt+Tab / taskbar | NOT RUN |
| 8. Return focus from host to target | NOT RUN |
| 9. Detect Ctrl + real-window D&D | NOT RUN |
| 10. Identify D&D drop target | NOT RUN |
| 11. Track maximize / restore / Snap frame | NOT RUN |
| 12. Validate mixed-DPI coordinate approach | NOT RUN |

## Review findings

- P2 — The required interactive Windows 10 GUI checks cannot be run from the
  current build runner. This is the reason for the blocked status, not a PASS.
  Re-check: pending manual execution on Windows 10.
- P3 — Computer Use cannot supply click geometry for this native listbox, so it
  cannot drive the picker buttons. The successful interactive enumeration is
  recorded above; remaining scenarios stay NOT RUN rather than inferred PASS.

## Regression

- Not applicable: this repository had no product implementation before Phase 0.

## Deferred

- Whether maximize state itself is synchronized, or only the final frame, is
  intentionally deferred until the two OS runs produce evidence.
- A low-level pointer hook is intentionally not added unless the event-based
  detection above proves insufficient.

## Approval

- Acceptance criteria: BLOCKED (items 3–12 remain unverified)
- Regression: NOT APPLICABLE
- Architecture boundary: PASS — the spike is outside future product code.
- Unresolved P0–P2: 1 (manual verification)
