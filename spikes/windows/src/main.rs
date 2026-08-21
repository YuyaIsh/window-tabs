//! A deliberately small, disposable Win32 feasibility probe for Phase 0.
//!
//! This is not product code.  It lets us verify the Windows assumptions before
//! the Tauri application and its cross-platform abstractions exist.

#![cfg_attr(not(windows), allow(dead_code, unused_imports))]

#[cfg(not(windows))]
fn main() {
    eprintln!("window-tabs-windows-spike must be built and run on Windows.");
}

#[cfg(windows)]
mod app {
    use std::env;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicIsize, Ordering};

    use windows::{
        core::w,
        Win32::{
            Foundation::{BOOL, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
            Graphics::Gdi::{
                EnumDisplayMonitors, GetMonitorInfoW, HBRUSH, HDC, HMONITOR, MONITORINFO,
            },
            System::LibraryLoader::GetModuleHandleW,
            UI::{
                Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK},
                HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI},
                Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL},
                WindowsAndMessaging::*,
            },
        },
    };

    static HOST_TARGET: AtomicIsize = AtomicIsize::new(0);

    #[derive(Debug)]
    struct WindowSummary {
        hwnd: HWND,
        pid: u32,
        title: String,
        class_name: String,
        rect: RECT,
        style: u32,
        ex_style: u32,
    }

    pub fn main() -> windows::core::Result<()> {
        let mut args = env::args().skip(1);
        let Some(command) = args.next() else {
            usage();
            return Ok(());
        };

        match command.as_str() {
            "list" => list_windows(),
            "watch" => watch_events(),
            "overlap" => {
                let source = parse_hwnd(args.next().as_deref())?;
                let targets = args
                    .map(|value| parse_hwnd(Some(&value)))
                    .collect::<windows::core::Result<Vec<_>>>()?;
                if targets.is_empty() {
                    return Err(windows::core::Error::new(
                        windows::core::HRESULT(0x80070057u32 as i32),
                        "overlap needs at least one target HWND",
                    ));
                }
                overlap(source, &targets)
            }
            "activate" => activate(parse_hwnd(args.next().as_deref())?),
            "host" => run_tab_bar_host(parse_hwnd(args.next().as_deref())?),
            "monitors" => list_monitors(),
            _ => {
                usage();
                Ok(())
            }
        }
    }

    fn usage() {
        eprintln!(
            "Usage:\n  window-tabs-windows-spike list\n  window-tabs-windows-spike watch\n  window-tabs-windows-spike overlap <source-hwnd> <target-hwnd>...\n  window-tabs-windows-spike activate <hwnd>\n  window-tabs-windows-spike host <target-hwnd>\n  window-tabs-windows-spike monitors\n\nHWND accepts decimal or 0x-prefixed hexadecimal."
        );
    }

    fn parse_hwnd(value: Option<&str>) -> windows::core::Result<HWND> {
        let value = value.ok_or_else(|| {
            windows::core::Error::new(windows::core::HRESULT(0x80070057u32 as i32), "missing HWND")
        })?;
        let value = value.trim();
        let raw = if let Some(hex) = value.strip_prefix("0x") {
            isize::from_str_radix(hex, 16)
        } else {
            value.parse()
        }
        .map_err(|_| {
            windows::core::Error::new(windows::core::HRESULT(0x80070057u32 as i32), "invalid HWND")
        })?;
        Ok(HWND(raw as *mut c_void))
    }

    fn hwnd_value(hwnd: HWND) -> usize {
        hwnd.0 as usize
    }

    fn list_windows() -> windows::core::Result<()> {
        let mut windows = Vec::<WindowSummary>::new();
        unsafe {
            EnumWindows(
                Some(enum_window),
                LPARAM((&mut windows as *mut Vec<WindowSummary>) as isize),
            )?;
        }
        for window in windows {
            println!(
                "hwnd=0x{:X} pid={} class={:?} title={:?} rect=({}, {}) {}x{} style=0x{:X} exstyle=0x{:X}",
                hwnd_value(window.hwnd),
                window.pid,
                window.class_name,
                window.title,
                window.rect.left,
                window.rect.top,
                window.rect.right - window.rect.left,
                window.rect.bottom - window.rect.top,
                window.style,
                window.ex_style,
            );
        }
        Ok(())
    }

    unsafe extern "system" fn enum_window(hwnd: HWND, data: LPARAM) -> BOOL {
        // This is intentionally a broad but useful Phase-0 candidate filter.
        // Product filtering belongs to the Phase-1 Windows backend.
        // `GW_OWNER` returns null when a top-level window has no owner. The
        // generated Rust binding represents that null as an error, but it is
        // the expected result for an eligible top-level window.
        let owner = GetWindow(hwnd, GW_OWNER).unwrap_or_default();
        if !IsWindowVisible(hwnd).as_bool() || !owner.0.is_null() {
            return BOOL(1);
        }
        let title = window_text(hwnd);
        if title.is_empty() {
            return BOOL(1);
        }
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return BOOL(1);
        }
        let windows = &mut *(data.0 as *mut Vec<WindowSummary>);
        windows.push(WindowSummary {
            hwnd,
            pid,
            title,
            class_name: class_name(hwnd),
            rect,
            style: GetWindowLongW(hwnd, GWL_STYLE) as u32,
            ex_style: GetWindowLongW(hwnd, GWL_EXSTYLE) as u32,
        });
        BOOL(1)
    }

    fn window_text(hwnd: HWND) -> String {
        unsafe {
            let mut text = [0u16; 1024];
            let length = GetWindowTextW(hwnd, &mut text);
            String::from_utf16_lossy(&text[..length.max(0) as usize])
        }
    }

    fn class_name(hwnd: HWND) -> String {
        unsafe {
            let mut text = [0u16; 256];
            let length = GetClassNameW(hwnd, &mut text);
            String::from_utf16_lossy(&text[..length.max(0) as usize])
        }
    }

    fn overlap(source: HWND, targets: &[HWND]) -> windows::core::Result<()> {
        unsafe {
            let mut rect = RECT::default();
            GetWindowRect(source, &mut rect)?;
            let width = rect.right - rect.left;
            let height = rect.bottom - rect.top;
            for target in targets {
                SetWindowPos(
                    *target,
                    HWND::default(),
                    rect.left,
                    rect.top,
                    width,
                    height,
                    SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOZORDER,
                )?;
                println!("moved 0x{:X} to the source frame", hwnd_value(*target));
            }
        }
        activate(source)
    }

    fn activate(hwnd: HWND) -> windows::core::Result<()> {
        unsafe {
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            if !SetForegroundWindow(hwnd).as_bool() {
                eprintln!("SetForegroundWindow returned false for 0x{:X}; Windows foreground rules may have rejected it.", hwnd_value(hwnd));
            }
        }
        Ok(())
    }

    fn watch_events() -> windows::core::Result<()> {
        unsafe {
            let hook = SetWinEventHook(
                EVENT_MIN,
                EVENT_MAX,
                None,
                Some(win_event),
                0,
                0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            );
            if hook.0.is_null() {
                return Err(windows::core::Error::from_win32());
            }
            println!("watching WinEvents; press Ctrl+C to stop");
            message_loop();
            UnhookWinEvent(hook).ok()?;
        }
        Ok(())
    }

    unsafe extern "system" fn win_event(
        _hook: HWINEVENTHOOK,
        event: u32,
        hwnd: HWND,
        object_id: i32,
        child_id: i32,
        _thread_id: u32,
        _time: u32,
    ) {
        // Window events can also describe child accessibility objects.  Phase 0
        // only evaluates top-level window events.
        if hwnd.0.is_null() || object_id != OBJID_WINDOW.0 || child_id != 0 {
            return;
        }
        let name = event_name(event);
        if event == EVENT_SYSTEM_MOVESIZESTART {
            println!("{name}: hwnd=0x{:X} ctrl={}", hwnd_value(hwnd), ctrl_down());
            return;
        }
        if event == EVENT_SYSTEM_MOVESIZEEND {
            let target = drop_target(hwnd);
            println!("{name}: hwnd=0x{:X} drop_target={target}", hwnd_value(hwnd));
            return;
        }
        if event == EVENT_OBJECT_LOCATIONCHANGE {
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect).is_ok() {
                println!(
                    "{name}: hwnd=0x{:X} rect=({}, {}) {}x{}",
                    hwnd_value(hwnd),
                    rect.left,
                    rect.top,
                    rect.right - rect.left,
                    rect.bottom - rect.top
                );
                return;
            }
        }
        println!(
            "{name}: hwnd=0x{:X} title={:?}",
            hwnd_value(hwnd),
            window_text(hwnd)
        );
    }

    fn event_name(event: u32) -> &'static str {
        match event {
            EVENT_SYSTEM_FOREGROUND => "foreground",
            EVENT_SYSTEM_MOVESIZESTART => "move-size-start",
            EVENT_SYSTEM_MOVESIZEEND => "move-size-end",
            EVENT_OBJECT_CREATE => "created",
            EVENT_OBJECT_DESTROY => "destroyed",
            EVENT_OBJECT_LOCATIONCHANGE => "location-changed",
            EVENT_SYSTEM_MINIMIZESTART => "minimized",
            EVENT_SYSTEM_MINIMIZEEND => "restored",
            _ => "other",
        }
    }

    fn ctrl_down() -> bool {
        unsafe { GetKeyState(VK_CONTROL.0 as i32) < 0 }
    }

    fn drop_target(origin: HWND) -> String {
        unsafe {
            let mut point = POINT::default();
            if GetCursorPos(&mut point).is_err() {
                return "<cursor unavailable>".to_owned();
            }
            let hit = WindowFromPoint(point);
            let root = GetAncestor(hit, GA_ROOT);
            if root.0.is_null() || root == origin {
                "<none>".to_owned()
            } else {
                format!("0x{:X} {:?}", hwnd_value(root), window_text(root))
            }
        }
    }

    fn run_tab_bar_host(target: HWND) -> windows::core::Result<()> {
        unsafe {
            let class = w!("WindowTabsPhase0Host");
            let instance: HINSTANCE = GetModuleHandleW(None)?.into();
            let wc = WNDCLASSW {
                hInstance: instance,
                lpszClassName: class,
                lpfnWndProc: Some(host_window_proc),
                hCursor: LoadCursorW(None, IDC_HAND)?,
                hbrBackground: HBRUSH::default(),
                ..Default::default()
            };
            RegisterClassW(&wc);

            let mut rect = RECT::default();
            GetWindowRect(target, &mut rect)?;
            let height = 30;
            HOST_TARGET.store(target.0 as isize, Ordering::Release);
            let host = CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                class,
                w!("window-tabs Phase 0 host — click to activate target"),
                WS_POPUP | WS_VISIBLE,
                rect.left,
                rect.top - height,
                rect.right - rect.left,
                height,
                None,
                None,
                instance,
                None,
            )?;
            SetWindowPos(
                host,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            )?;
            let _ = ShowWindow(host, SW_SHOWNOACTIVATE);
            println!("host=0x{:X}; target=0x{:X}. Verify it is absent from taskbar, Alt+Tab, and Task View; click it to activate the target. Close the host to stop.", hwnd_value(host), hwnd_value(target));
            message_loop();
        }
        Ok(())
    }

    unsafe extern "system" fn host_window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_LBUTTONUP => {
                let target = HWND(HOST_TARGET.load(Ordering::Acquire) as *mut c_void);
                let _ = activate(target);
                LRESULT(0)
            }
            WM_CLOSE => {
                let _ = DestroyWindow(hwnd);
                LRESULT(0)
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, message, wparam, lparam),
        }
    }

    fn message_loop() {
        unsafe {
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }

    fn list_monitors() -> windows::core::Result<()> {
        let mut monitors = Vec::<HMONITOR>::new();
        unsafe {
            EnumDisplayMonitors(
                HDC::default(),
                None,
                Some(enum_monitor),
                LPARAM((&mut monitors as *mut Vec<HMONITOR>) as isize),
            )
            .ok()?;
        }
        for monitor in monitors {
            unsafe {
                let mut info = MONITORINFO {
                    cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                    ..Default::default()
                };
                GetMonitorInfoW(monitor, &mut info).ok()?;
                let mut dpi_x = 0;
                let mut dpi_y = 0;
                let dpi = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
                println!(
                    "monitor=0x{:X} work=({}, {}) {}x{} dpi={}x{} dpi_result={}",
                    monitor.0 as usize,
                    info.rcWork.left,
                    info.rcWork.top,
                    info.rcWork.right - info.rcWork.left,
                    info.rcWork.bottom - info.rcWork.top,
                    dpi_x,
                    dpi_y,
                    if dpi.is_ok() { "ok" } else { "failed" },
                );
            }
        }
        Ok(())
    }

    unsafe extern "system" fn enum_monitor(
        monitor: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        let monitors = &mut *(data.0 as *mut Vec<HMONITOR>);
        monitors.push(monitor);
        BOOL(1)
    }
}

#[cfg(windows)]
fn main() -> windows::core::Result<()> {
    app::main()
}
