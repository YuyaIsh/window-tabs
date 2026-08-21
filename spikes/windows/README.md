# Windows Phase 0 feasibility spike

This disposable Win32 command-line probe supplies evidence for Phase 0. It is
not a product backend and must not be imported by a later Tauri application.

Run it in an elevated **Windows** terminal only if the windows being tested are
also elevated; otherwise use a normal terminal. A normal process cannot
reliably control a higher-integrity window.

```powershell
cd spikes/windows
cargo run --release -- list
cargo run --release -- watch
# Run this directly on the interactive desktop when a build runner cannot see
# desktop windows. It lists real top-level windows and can foreground one.
cargo run --release --bin window-tabs-phase0-picker
```

Use the `list` output to obtain the HWND values used below. HWNDs accept either
decimal or `0x`-prefixed hexadecimal values.

```powershell
# Put the target windows at exactly the source window's frame, then foreground it.
cargo run --release -- overlap 0xSOURCE 0xTARGET_A 0xTARGET_B

# Explicit user-action-equivalent foreground test.
cargo run --release -- activate 0xTARGET

# Creates a WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE host (placed topmost with
# SetWindowPos) directly above a
# target. Its click handler foregrounds the target. Close the host to exit.
cargo run --release -- host 0xTARGET

# Records work areas and effective DPI of every monitor.
cargo run --release -- monitors
```

## Required manual checks

Keep `watch` running while exercising the following checks and record the
actual output and result in `docs/phase-reviews/PHASE-00.md`.

| Plan item | Procedure | Expected evidence |
| --- | --- | --- |
| 1–2 | Run `list` with Chrome (at least two windows), Notion, and Terminal open. | Each eligible top-level window is listed; Chrome windows have distinct HWNDs. |
| 3, 6 | Run `overlap`, then select each real window through Alt+Tab and Task View. | The real windows remain separate OS entries and `watch` logs `foreground`. |
| 4, 8 | Run `host`; click its bar. | The target receives foreground; host does not retain focus. |
| 5, 9–11 | Run `watch`; Ctrl-drag a real window over another, cancel once, move/resize, maximize, restore, and Snap. | Start/end, Ctrl state, drop target, and final frames are printed. |
| 7 | With `host` open, check taskbar, Alt+Tab, and Task View. | The host is absent in all three locations. |
| 12 | Run `monitors` with 100% and 125%+ displays, and move a window between them. | Work areas and per-monitor DPI are recorded; frame events remain in physical pixels. |

Run the suite on Windows 10 and cover ordinary Snap. Do not mark Phase 0
approved until the Windows 10 run is recorded as PASS.
