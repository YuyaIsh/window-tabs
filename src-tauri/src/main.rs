#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::sync::{mpsc, Mutex};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    Emitter, Manager, State, WebviewUrl,
};
use tauri_plugin_updater::UpdaterExt;

struct TrayState(TrayIcon<tauri::Wry>);

#[derive(Default)]
struct AppUpdaterState {
    update: Mutex<Option<tauri_plugin_updater::Update>>,
    downloaded_bytes: Mutex<Option<Vec<u8>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateInfo {
    current_version: String,
    version: String,
    body: Option<String>,
}

#[derive(Deserialize)]
struct TrayPreset {
    id: String,
    name: String,
}

#[derive(Deserialize)]
struct GroupMenuItem {
    id: String,
    label: String,
    enabled: bool,
}

fn tray_menu(app: &tauri::AppHandle, presets: &[TrayPreset]) -> tauri::Result<Menu<tauri::Wry>> {
    let new_group = MenuItem::with_id(app, "new-group", "新しいグループ", true, None::<&str>)?;
    let manager = MenuItem::with_id(app, "presets", "プリセットを管理…", true, None::<&str>)?;
    let check_updates = MenuItem::with_id(app, "check-updates", "更新を確認…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
    let mut items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = vec![&new_group, &manager];
    let preset_items = presets
        .iter()
        .map(|preset| {
            MenuItem::with_id(
                app,
                format!("preset:{}", preset.id),
                &preset.name,
                true,
                None::<&str>,
            )
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    items.extend(
        preset_items
            .iter()
            .map(|item| item as &dyn tauri::menu::IsMenuItem<tauri::Wry>),
    );
    items.push(&check_updates);
    items.push(&quit);
    Menu::with_items(app, &items)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Rect {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowInfo {
    id: String,
    process_id: u32,
    app_id: String,
    app_name: String,
    executable_path: Option<String>,
    class_name: String,
    title: String,
    frame: Rect,
    display_id: String,
    state: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DisplayInfo {
    id: String,
    name: String,
    work_area: Rect,
    primary: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostSyncRequest {
    group_id: String,
    window_ids: Vec<String>,
    active_id: Option<String>,
    frame: Rect,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GlobalTabShortcut {
    group_id: String,
    key: u32,
    ctrl: bool,
    shift: bool,
}

#[cfg(target_os = "windows")]
mod windows_backend {
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::ffi::c_void;
    use std::path::Path;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::thread;
    use windows::Win32::{
        Foundation::{
            CloseHandle, GetLastError, SetLastError, BOOL, HWND, LPARAM, LRESULT, POINT, RECT,
            WIN32_ERROR, WPARAM,
        },
        Graphics::Gdi::{
            EnumDisplayMonitors, GetMonitorInfoW, MonitorFromWindow, ScreenToClient, HDC, HMONITOR,
            MONITORINFOEXW, MONITOR_DEFAULTTONEAREST,
        },
        System::Threading::{
            AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW,
            PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        },
        UI::{
            Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK},
            HiDpi::{
                GetAwarenessFromDpiAwarenessContext, GetDpiForWindow, GetWindowDpiAwarenessContext,
                GetWindowDpiHostingBehavior, IsValidDpiAwarenessContext,
                SetThreadDpiHostingBehavior, DPI_AWARENESS_INVALID, DPI_HOSTING_BEHAVIOR,
                DPI_HOSTING_BEHAVIOR_INVALID, DPI_HOSTING_BEHAVIOR_MIXED,
            },
            Input::KeyboardAndMouse::{
                GetAsyncKeyState, GetKeyState, SetActiveWindow, SetFocus, VK_CONTROL, VK_MENU,
                VK_SHIFT, VK_TAB,
            },
            WindowsAndMessaging::*,
        },
    };

    static EVENT_APP: OnceLock<tauri::AppHandle> = OnceLock::new();
    static NATIVE_DRAGS: OnceLock<Mutex<HashSet<usize>>> = OnceLock::new();
    static GROUPS: OnceLock<Mutex<GroupRegistry>> = OnceLock::new();
    static HOST_MUTATIONS: OnceLock<Mutex<()>> = OnceLock::new();
    static MODIFIER_STATE: AtomicU32 = AtomicU32::new(0);

    #[derive(Clone)]
    struct HostedWindow {
        group_id: String,
        parent: usize,
        style: i32,
        exstyle: i32,
        frame: Rect,
        visible: bool,
    }
    #[derive(Clone)]
    struct TransactionSnapshot {
        native: HostedWindow,
        registry: Option<HostedWindow>,
    }
    #[derive(Clone, Default)]
    struct GroupRegistry {
        hosts: HashMap<String, usize>,
        hosted: HashMap<usize, HostedWindow>,
    }
    fn groups() -> &'static Mutex<GroupRegistry> {
        GROUPS.get_or_init(|| Mutex::new(GroupRegistry::default()))
    }
    fn host_mutations() -> &'static Mutex<()> {
        HOST_MUTATIONS.get_or_init(|| Mutex::new(()))
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct NativeWindowEvent {
        kind: &'static str,
        id: String,
        target: Option<String>,
        frame: Option<Rect>,
    }
    fn hwnd(id: &str) -> Result<HWND, String> {
        usize::from_str_radix(id.trim_start_matches("0x"), 16)
            .or_else(|_| id.parse())
            .map(|raw| HWND(raw as *mut c_void))
            .map_err(|_| "invalid runtime window id".into())
    }
    fn title(window: HWND) -> String {
        unsafe {
            let mut buffer = [0u16; 1024];
            let n = GetWindowTextW(window, &mut buffer);
            String::from_utf16_lossy(&buffer[..n.max(0) as usize])
        }
    }
    fn frame_for(window: HWND) -> Option<Rect> {
        unsafe {
            let mut rect = RECT::default();
            GetWindowRect(window, &mut rect).ok()?;
            Some(Rect {
                x: rect.left,
                y: rect.top,
                width: rect.right - rect.left,
                height: rect.bottom - rect.top,
            })
        }
    }
    fn window_info(window: HWND) -> Option<WindowInfo> {
        unsafe {
            let rect = frame_for(window)?;
            let (process_id, app_id, app_name, executable_path, class_name) =
                process_details(window);
            Some(WindowInfo {
                id: format!("{:X}", window.0 as usize),
                process_id,
                app_id,
                app_name,
                executable_path,
                class_name,
                title: title(window),
                frame: rect,
                display_id: display_id_for(window),
                state: if IsIconic(window).as_bool() {
                    "minimized".into()
                } else if IsZoomed(window).as_bool() {
                    "maximized".into()
                } else {
                    "normal".into()
                },
            })
        }
    }
    fn is_hosted(window: HWND) -> bool {
        groups()
            .lock()
            .is_ok_and(|groups| groups.hosted.contains_key(&(window.0 as usize)))
    }
    pub fn register_group_host(group_id: String, host: HWND) {
        if let Ok(mut groups) = groups().lock() {
            groups.hosts.insert(group_id, host.0 as usize);
        }
    }
    pub fn group_host_registered(group_id: &str) -> bool {
        groups()
            .lock()
            .is_ok_and(|groups| groups.hosts.contains_key(group_id))
    }
    fn set_window_long_checked(
        window: HWND,
        index: WINDOW_LONG_PTR_INDEX,
        value: i32,
        label: &str,
    ) -> Result<(), String> {
        unsafe {
            SetLastError(WIN32_ERROR(0));
            let previous = SetWindowLongW(window, index, value);
            let error = GetLastError();
            if previous == 0 && error.0 != 0 {
                return Err(format!("{label} failed: Win32 error {}", error.0));
            }
        }
        Ok(())
    }
    fn strip_frame(window: HWND) -> Result<(), String> {
        unsafe {
            let style = GetWindowLongW(window, GWL_STYLE);
            let frame =
                (WS_CAPTION | WS_THICKFRAME | WS_MINIMIZE | WS_MAXIMIZE | WS_SYSMENU).0 as i32;
            let child_style = (style & !frame & !WS_POPUP.0 as i32) | WS_CHILD.0 as i32;
            set_window_long_checked(window, GWL_STYLE, child_style, "SetWindowLongW(GWL_STYLE)")?;
            SetWindowPos(
                window,
                HWND::default(),
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
            )
            .map_err(|error| format!("SetWindowPos(frame change) failed: {error}"))?;
            if GetWindowLongW(window, GWL_STYLE) & (WS_CHILD.0 as i32) == 0 {
                return Err("window did not become a child window".into());
            }
        }
        Ok(())
    }
    fn restore_hosted(window: HWND, saved: HostedWindow) -> Result<(), String> {
        unsafe {
            if !IsWindow(window).as_bool() {
                return Ok(());
            }
            let _ = ShowWindow(window, SW_HIDE);
            // SetParent must be reversed before restoring the top-level style.
            // In particular, a standalone window is still WS_CHILD while it is
            // detached, and restoring WS_POPUP/WS_OVERLAPPED first can leave
            // Windows with an invalid parent/style combination.
            SetParent(window, HWND(saved.parent as *mut c_void))
                .map_err(|error| format!("SetParent(restore) failed: {error}"))?;
            set_window_long_checked(
                window,
                GWL_STYLE,
                saved.style,
                "SetWindowLongW(GWL_STYLE restore)",
            )?;
            set_window_long_checked(
                window,
                GWL_EXSTYLE,
                saved.exstyle,
                "SetWindowLongW(GWL_EXSTYLE restore)",
            )?;
            SetWindowPos(
                window,
                HWND::default(),
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
            )
            .map_err(|error| format!("SetWindowPos(restore) failed: {error}"))?;
            let (x, y) = if saved.parent == 0 {
                (saved.frame.x, saved.frame.y)
            } else {
                let mut point = POINT {
                    x: saved.frame.x,
                    y: saved.frame.y,
                };
                if !ScreenToClient(HWND(saved.parent as *mut c_void), &mut point).as_bool() {
                    return Err("ScreenToClient(restore) failed".into());
                }
                (point.x, point.y)
            };
            SetWindowPos(
                window,
                HWND::default(),
                x,
                y,
                saved.frame.width,
                saved.frame.height,
                SWP_NOACTIVATE | SWP_NOZORDER | SWP_FRAMECHANGED,
            )
            .map_err(|error| format!("SetWindowPos(restore frame) failed: {error}"))?;
            let _ = ShowWindow(window, if saved.visible { SW_SHOWNA } else { SW_HIDE });
            if GetParent(window).unwrap_or_default().0 != saved.parent as *mut c_void {
                return Err("window parent was not restored".into());
            }
            let actual_frame = frame_for(window).ok_or("window frame was not restored")?;
            if actual_frame.x != saved.frame.x
                || actual_frame.y != saved.frame.y
                || actual_frame.width != saved.frame.width
                || actual_frame.height != saved.frame.height
            {
                return Err("window frame was not restored".into());
            }
            if IsWindowVisible(window).as_bool() != saved.visible {
                return Err("window visibility was not restored".into());
            }
        }
        Ok(())
    }
    fn restore_group(group_id: &str) -> Result<(), String> {
        let _mutation = host_mutations()
            .lock()
            .map_err(|_| "host mutation lock is unavailable")?;
        let saved = groups()
            .lock()
            .map_err(|_| "group registry is unavailable")?
            .hosted
            .iter()
            .filter_map(|(id, item)| {
                (item.group_id == group_id).then_some((HWND(*id as *mut c_void), item.clone()))
            })
            .collect::<Vec<_>>();
        let mut errors = Vec::new();
        for (window, item) in saved {
            if let Err(error) = restore_hosted(window, item) {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            let mut groups = groups()
                .lock()
                .map_err(|_| "group registry is unavailable")?;
            groups.hosts.remove(group_id);
            groups.hosted.retain(|_, item| item.group_id != group_id);
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
    pub fn restore_group_host(group_id: &str) -> Result<(), String> {
        restore_group(group_id)
    }
    pub fn restore_all_groups() -> Result<(), String> {
        let group_ids = groups()
            .lock()
            .map_err(|_| "group registry is unavailable")?
            .hosts
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let mut errors = Vec::new();
        for group_id in group_ids {
            if let Err(error) = restore_group(&group_id) {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
    struct DpiHostingGuard(DPI_HOSTING_BEHAVIOR);
    impl Drop for DpiHostingGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = SetThreadDpiHostingBehavior(self.0);
            }
        }
    }
    pub fn with_mixed_dpi_hosting<T>(
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        unsafe {
            let previous = SetThreadDpiHostingBehavior(DPI_HOSTING_BEHAVIOR_MIXED);
            if previous.0 == DPI_HOSTING_BEHAVIOR_INVALID.0 {
                return Err(
                    "mixed-DPI window hosting is unavailable on this Windows version".into(),
                );
            }
            let _guard = DpiHostingGuard(previous);
            operation()
        }
    }
    pub fn validate_group_host_dpi(host: HWND) -> Result<(), String> {
        unsafe {
            if !IsWindow(host).as_bool() {
                return Err("group host no longer exists".into());
            }
            if GetWindowDpiHostingBehavior(host).0 != DPI_HOSTING_BEHAVIOR_MIXED.0 {
                return Err("group host was not created with mixed-DPI hosting".into());
            }
        }
        Ok(())
    }
    fn validate_dpi_hosting(host: HWND, window: HWND) -> Result<(), String> {
        validate_group_host_dpi(host)?;
        unsafe {
            let host_context = GetWindowDpiAwarenessContext(host);
            let window_context = GetWindowDpiAwarenessContext(window);
            if !IsValidDpiAwarenessContext(host_context).as_bool()
                || !IsValidDpiAwarenessContext(window_context).as_bool()
            {
                return Err(format!(
                    "window DPI awareness is unavailable for {:X}",
                    window.0 as usize
                ));
            }
            if GetAwarenessFromDpiAwarenessContext(host_context).0 == DPI_AWARENESS_INVALID.0
                || GetAwarenessFromDpiAwarenessContext(window_context).0 == DPI_AWARENESS_INVALID.0
            {
                return Err(format!(
                    "window DPI awareness is invalid for {:X}",
                    window.0 as usize
                ));
            }
            if GetDpiForWindow(host) == 0 || GetDpiForWindow(window) == 0 {
                return Err(format!(
                    "window DPI could not be determined for {:X}",
                    window.0 as usize
                ));
            }
        }
        Ok(())
    }
    fn snapshot_window(window: HWND, group_id: &str) -> Result<HostedWindow, String> {
        if !unsafe { IsWindow(window).as_bool() } {
            return Err(format!("window {:X} no longer exists", window.0 as usize));
        }
        Ok(HostedWindow {
            group_id: group_id.to_string(),
            parent: unsafe { GetParent(window).unwrap_or_default().0 as usize },
            style: unsafe { GetWindowLongW(window, GWL_STYLE) },
            exstyle: unsafe { GetWindowLongW(window, GWL_EXSTYLE) },
            frame: frame_for(window)
                .ok_or_else(|| "could not capture window frame".to_string())?
                .clone(),
            visible: unsafe { IsWindowVisible(window).as_bool() },
        })
    }
    fn abort_host_transaction(
        error: String,
        touched: &HashSet<usize>,
        rollback: &HashMap<usize, TransactionSnapshot>,
    ) -> Result<(), String> {
        let mut rollback_errors = Vec::new();
        let mut rollback_failures = HashSet::new();
        for (raw, snapshot) in rollback {
            if let Err(rollback_error) =
                restore_hosted(HWND(*raw as *mut c_void), snapshot.native.clone())
            {
                rollback_errors.push(rollback_error);
                rollback_failures.insert(*raw);
            }
        }
        if let Ok(mut groups) = groups().lock() {
            if rollback_errors.is_empty() {
                for raw in touched {
                    groups.hosted.remove(raw);
                }
                for (raw, snapshot) in rollback {
                    if let Some(saved) = &snapshot.registry {
                        groups.hosted.insert(*raw, saved.clone());
                    }
                }
            } else {
                // Keep a recovery record if any native restore failed. A
                // later quit/update restore can retry the original state.
                for raw in touched {
                    groups.hosted.remove(raw);
                }
                for (raw, snapshot) in rollback {
                    if let Some(saved) = &snapshot.registry {
                        // Preserve the ownership that existed before this
                        // transaction, including a source group during a
                        // cross-group transfer rollback.
                        groups.hosted.insert(*raw, saved.clone());
                    } else if rollback_failures.contains(raw) {
                        groups.hosted.insert(*raw, snapshot.native.clone());
                    }
                }
            }
        }
        if rollback_errors.is_empty() {
            Err(error)
        } else {
            Err(format!(
                "{error}; rollback failed: {}",
                rollback_errors.join("; ")
            ))
        }
    }
    fn class_name(window: HWND) -> String {
        unsafe {
            let mut buffer = [0u16; 256];
            let n = GetClassNameW(window, &mut buffer);
            String::from_utf16_lossy(&buffer[..n.max(0) as usize])
        }
    }
    fn process_image(process_id: u32) -> Option<String> {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()?;
            let mut buffer = [0u16; 1024];
            let mut length = buffer.len() as u32;
            let result = QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                windows::core::PWSTR(buffer.as_mut_ptr()),
                &mut length,
            );
            let _ = CloseHandle(process);
            result.ok()?;
            Some(String::from_utf16_lossy(&buffer[..length as usize]))
        }
    }
    fn process_details(window: HWND) -> (u32, String, String, Option<String>, String) {
        unsafe {
            let mut process_id = 0;
            GetWindowThreadProcessId(window, Some(&mut process_id));
            let class_name = class_name(window);
            let image = process_image(process_id);
            let app_id = image
                .as_deref()
                .and_then(|value| Path::new(value).file_name())
                .and_then(|value| value.to_str())
                .map(str::to_owned)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| class_name.clone());
            (process_id, app_id.clone(), app_id, image, class_name)
        }
    }
    fn is_own_process(process_id: u32, app_id: &str) -> bool {
        if process_id == std::process::id() {
            return true;
        }
        std::env::current_exe()
            .ok()
            .and_then(|path| {
                path.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
            })
            .is_some_and(|name| name.eq_ignore_ascii_case(app_id))
    }
    fn display_id_for(window: HWND) -> String {
        unsafe {
            format!(
                "{:X}",
                MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST).0 as usize
            )
        }
    }
    fn contains(rect: &RECT, point: POINT) -> bool {
        point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom
    }
    fn is_manageable_top_level(window: HWND) -> bool {
        unsafe {
            if window.0.is_null()
                || !IsWindowVisible(window).as_bool()
                || !GetWindow(window, GW_OWNER).unwrap_or_default().0.is_null()
                || (GetWindowLongW(window, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0) != 0
                || title(window).is_empty()
            {
                return false;
            }
            let mut rect = RECT::default();
            if GetWindowRect(window, &mut rect).is_err()
                || rect.right - rect.left < 120
                || rect.bottom - rect.top < 80
            {
                return false;
            }
            let (process_id, app_id, ..) = process_details(window);
            !is_own_process(process_id, &app_id)
        }
    }
    unsafe extern "system" fn each_display(
        monitor: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        let displays = &mut *(data.0 as *mut Vec<DisplayInfo>);
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(monitor, (&mut info as *mut MONITORINFOEXW).cast()).as_bool() {
            displays.push(DisplayInfo {
                id: format!("{:X}", monitor.0 as usize),
                name: String::from_utf16_lossy(&info.szDevice)
                    .trim_end_matches('\0')
                    .to_owned(),
                work_area: Rect {
                    x: info.monitorInfo.rcWork.left,
                    y: info.monitorInfo.rcWork.top,
                    width: info.monitorInfo.rcWork.right - info.monitorInfo.rcWork.left,
                    height: info.monitorInfo.rcWork.bottom - info.monitorInfo.rcWork.top,
                },
                primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
            });
        }
        BOOL(1)
    }
    pub fn start_window_events(app: tauri::AppHandle) {
        let _ = EVENT_APP.set(app);
        let _ = NATIVE_DRAGS.set(Mutex::new(HashSet::new()));
        let _ = GROUPS.set(Mutex::new(GroupRegistry::default()));
        thread::spawn(|| unsafe {
            let hook = SetWinEventHook(
                EVENT_MIN,
                EVENT_MAX,
                None,
                Some(on_win_event),
                0,
                0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            );
            let keyboard_hook =
                SetWindowsHookExW(WH_KEYBOARD_LL, Some(on_keyboard_event), None, 0).ok();
            if hook.0.is_null() && keyboard_hook.is_none() {
                return;
            }
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            if let Some(keyboard_hook) = keyboard_hook {
                let _ = UnhookWindowsHookEx(keyboard_hook);
            }
            if !hook.0.is_null() {
                let _ = UnhookWinEvent(hook);
            }
        });
    }
    unsafe extern "system" fn on_win_event(
        _hook: HWINEVENTHOOK,
        event: u32,
        window: HWND,
        object_id: i32,
        child_id: i32,
        _thread_id: u32,
        _time: u32,
    ) {
        if window.0.is_null()
            || object_id != OBJID_WINDOW.0
            || child_id != 0
            || GetWindowThreadProcessId(window, None) == std::process::id()
        {
            return;
        }
        if event != EVENT_OBJECT_DESTROY && is_hosted(window) {
            return;
        }
        if event == EVENT_OBJECT_DESTROY {
            if let Some(groups) = GROUPS.get() {
                let _ = groups
                    .lock()
                    .map(|mut groups| groups.hosted.remove(&(window.0 as usize)));
            }
        }
        let (kind, target, frame) = match event {
            EVENT_SYSTEM_FOREGROUND => ("focused", None, None),
            EVENT_OBJECT_DESTROY => ("destroyed", None, None),
            EVENT_SYSTEM_MINIMIZESTART => ("minimized", None, None),
            EVENT_SYSTEM_MINIMIZEEND => ("restored", None, frame_for(window)),
            EVENT_SYSTEM_MOVESIZESTART if ctrl_down() => {
                if let Some(drags) = NATIVE_DRAGS.get() {
                    let _ = drags
                        .lock()
                        .map(|mut drags| drags.insert(window.0 as usize));
                }
                ("drag-start", None, None)
            }
            EVENT_SYSTEM_MOVESIZEEND => {
                let dragging = NATIVE_DRAGS
                    .get()
                    .and_then(|drags| {
                        drags
                            .lock()
                            .ok()
                            .map(|mut drags| drags.remove(&(window.0 as usize)))
                    })
                    .unwrap_or(false);
                if dragging {
                    ("drag-end", drop_target(window), frame_for(window))
                } else {
                    ("frame-settled", None, frame_for(window))
                }
            }
            EVENT_OBJECT_LOCATIONCHANGE => ("frame-settled", None, frame_for(window)),
            _ => return,
        };
        if let Some(app) = EVENT_APP.get() {
            let _ = app.emit(
                "window-event",
                NativeWindowEvent {
                    kind,
                    id: format!("{:X}", window.0 as usize),
                    target,
                    frame,
                },
            );
        }
    }
    fn ctrl_down() -> bool {
        unsafe { GetKeyState(VK_CONTROL.0 as i32) < 0 }
    }
    fn focused_group_id(window: HWND) -> Option<String> {
        groups().lock().ok().and_then(|groups| {
            let mut current = window;
            for _ in 0..32 {
                if let Some(saved) = groups.hosted.get(&(current.0 as usize)) {
                    return Some(saved.group_id.clone());
                }
                if let Some(group_id) = groups.hosts.iter().find_map(|(group_id, host)| {
                    (*host == current.0 as usize).then(|| group_id.clone())
                }) {
                    return Some(group_id);
                }
                let parent = unsafe { GetParent(current).unwrap_or_default() };
                if parent.0.is_null() || parent.0 == current.0 {
                    break;
                }
                current = parent;
            }
            None
        })
    }
    fn update_modifier_state(key: u32, key_down: bool) {
        let bit = match key {
            0xA2 => Some(1),
            0xA3 => Some(2),
            0xA0 => Some(4),
            0xA1 => Some(8),
            _ => None,
        };
        if let Some(bit) = bit {
            if key_down {
                MODIFIER_STATE.fetch_or(bit, Ordering::Relaxed);
            } else {
                MODIFIER_STATE.fetch_and(!bit, Ordering::Relaxed);
            }
        }
    }
    fn modifier_state() -> (bool, bool) {
        let tracked = MODIFIER_STATE.load(Ordering::Relaxed);
        unsafe {
            (
                tracked & 0b0011 != 0 || GetAsyncKeyState(VK_CONTROL.0 as i32) < 0,
                tracked & 0b1100 != 0 || GetAsyncKeyState(VK_SHIFT.0 as i32) < 0,
            )
        }
    }
    unsafe extern "system" fn on_keyboard_event(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if code >= 0 && lparam.0 != 0 {
            let keyboard = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            let key = keyboard.vkCode;
            let key_down = wparam.0 as u32 == WM_KEYDOWN || wparam.0 as u32 == WM_SYSKEYDOWN;
            let key_up = wparam.0 as u32 == WM_KEYUP || wparam.0 as u32 == WM_SYSKEYUP;
            if key_down || key_up {
                update_modifier_state(key, key_down);
            }
            if key_down {
                let (ctrl, shift) = modifier_state();
                let alt = GetAsyncKeyState(VK_MENU.0 as i32) < 0;
                let is_tab = key == VK_TAB.0 as u32 && ctrl && !alt;
                let is_number_or_close =
                    ctrl && !shift && !alt && ((0x31..=0x39).contains(&key) || key == 0x57);
                let is_open_picker = (!ctrl && !shift && !alt && key == 0x77)
                    || (ctrl && shift && !alt && key == 0x41);
                if is_tab || is_number_or_close || is_open_picker {
                    if let Some(group_id) = focused_group_id(GetForegroundWindow()) {
                        if let Some(app) = EVENT_APP.get() {
                            let _ = app.emit(
                                "global-tab-shortcut",
                                GlobalTabShortcut {
                                    group_id,
                                    key,
                                    ctrl,
                                    shift,
                                },
                            );
                        }
                        return LRESULT(1);
                    }
                }
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }
    fn drop_target(source: HWND) -> Option<String> {
        unsafe {
            let mut point = POINT::default();
            GetCursorPos(&mut point).ok()?;
            let mut probe = DropProbe {
                source,
                point,
                target: None,
            };
            let _ = EnumWindows(
                Some(find_drop_target),
                LPARAM((&mut probe as *mut DropProbe) as isize),
            );
            probe
                .target
                .map(|target| format!("{:X}", target.0 as usize))
        }
    }
    struct DropProbe {
        source: HWND,
        point: POINT,
        target: Option<HWND>,
    }
    unsafe extern "system" fn find_drop_target(window: HWND, data: LPARAM) -> BOOL {
        let probe = &mut *(data.0 as *mut DropProbe);
        if window == probe.source || IsIconic(window).as_bool() {
            return BOOL(1);
        }
        let hosted_target = groups()
            .lock()
            .ok()
            .and_then(|groups| {
                groups
                    .hosts
                    .values()
                    .any(|host| *host == window.0 as usize)
                    .then(|| {
                        groups.hosted.iter().find_map(|(id, _item)| {
                            (GetParent(HWND(*id as *mut c_void)).unwrap_or_default() == window)
                                .then_some(*id)
                        })
                    })
            })
            .flatten();
        if let Some(target) = hosted_target {
            let mut rect = RECT::default();
            if GetWindowRect(window, &mut rect).is_ok() && contains(&rect, probe.point) {
                probe.target = Some(HWND(target as *mut c_void));
                return BOOL(0);
            }
        }
        if !is_manageable_top_level(window) {
            return BOOL(1);
        }
        let mut rect = RECT::default();
        if GetWindowRect(window, &mut rect).is_ok() && contains(&rect, probe.point) {
            probe.target = Some(window);
            return BOOL(0);
        }
        BOOL(1)
    }
    unsafe extern "system" fn each(window: HWND, data: LPARAM) -> BOOL {
        if !is_manageable_top_level(window) {
            return BOOL(1);
        }
        let items = &mut *(data.0 as *mut Vec<WindowInfo>);
        if let Some(item) = window_info(window) {
            items.push(item);
        }
        BOOL(1)
    }
    #[tauri::command]
    pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
        let mut items: Vec<WindowInfo> = Vec::new();
        unsafe {
            EnumWindows(
                Some(each),
                LPARAM((&mut items as *mut Vec<WindowInfo>) as isize),
            )
            .map_err(|e| e.to_string())?;
        }
        let hosted = groups()
            .lock()
            .ok()
            .map(|groups| groups.hosted.keys().copied().collect::<Vec<_>>())
            .unwrap_or_default();
        for id in hosted {
            let window = HWND(id as *mut c_void);
            if unsafe { IsWindow(window).as_bool() }
                && !items.iter().any(|item| item.id == format!("{:X}", id))
            {
                if let Some(item) = window_info(window) {
                    items.push(item);
                }
            }
        }
        Ok(items)
    }
    #[tauri::command]
    pub fn list_displays() -> Result<Vec<DisplayInfo>, String> {
        let mut displays = Vec::new();
        unsafe {
            EnumDisplayMonitors(
                HDC::default(),
                None,
                Some(each_display),
                LPARAM((&mut displays as *mut Vec<DisplayInfo>) as isize),
            )
            .ok()
            .map_err(|error| error.to_string())?;
        }
        Ok(displays)
    }
    #[tauri::command]
    pub fn get_foreground_window() -> Option<String> {
        unsafe {
            let window = GetForegroundWindow();
            (!window.0.is_null()).then(|| format!("{:X}", window.0 as usize))
        }
    }
    #[tauri::command]
    pub fn activate_window(id: String) -> Result<(), String> {
        unsafe {
            let window = hwnd(&id)?;
            if IsIconic(window).as_bool() {
                let _ = ShowWindow(window, SW_RESTORE);
            }
            if !SetForegroundWindow(window).as_bool() {
                return Err("Windows rejected foreground activation".into());
            }
        }
        Ok(())
    }
    #[tauri::command]
    pub fn restore_window(id: String) -> Result<(), String> {
        unsafe {
            let _ = ShowWindow(hwnd(&id)?, SW_RESTORE);
        }
        Ok(())
    }
    #[tauri::command]
    pub fn get_window_frame(id: String) -> Result<Rect, String> {
        frame_for(hwnd(&id)?).ok_or_else(|| "could not read window frame".into())
    }
    #[tauri::command]
    pub fn set_window_frame(id: String, frame: Rect) -> Result<(), String> {
        unsafe {
            let window = hwnd(&id)?;
            if is_hosted(window) {
                return Ok(());
            }
            if IsZoomed(window).as_bool() {
                let _ = ShowWindow(window, SW_RESTORE);
            }
            SetWindowPos(
                window,
                HWND::default(),
                frame.x,
                frame.y,
                frame.width,
                frame.height,
                SWP_NOACTIVATE | SWP_NOZORDER,
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    #[tauri::command]
    pub fn close_window(id: String) -> Result<(), String> {
        unsafe {
            PostMessageW(hwnd(&id)?, WM_CLOSE, WPARAM::default(), LPARAM::default())
                .map_err(|e| e.to_string())
        }
    }
    #[tauri::command]
    pub fn sync_group_host(
        group_id: String,
        window_ids: Vec<String>,
        active_id: Option<String>,
        frame: Rect,
    ) -> Result<(), String> {
        sync_group_hosts(vec![HostSyncRequest {
            group_id,
            window_ids,
            active_id,
            frame,
        }])
    }
    #[tauri::command]
    pub fn sync_group_hosts(requests: Vec<HostSyncRequest>) -> Result<(), String> {
        if requests.is_empty() {
            return Ok(());
        }
        let _mutation = host_mutations()
            .lock()
            .map_err(|_| "host mutation lock is unavailable")?;
        let initial = groups()
            .lock()
            .map_err(|_| "group registry is unavailable")?
            .hosted
            .clone();
        let mut target_group_ids = HashSet::new();
        let mut host_ids = HashSet::new();
        let mut requested_ids = HashSet::new();
        let mut resolved = Vec::with_capacity(requests.len());
        for request in &requests {
            // Keep the frame in the request contract for callers that already
            // calculate physical placement; child placement is derived from
            // the actual host client rect below.
            let _frame = &request.frame;
            if !target_group_ids.insert(request.group_id.clone()) {
                return Err("a group was requested more than once".into());
            }
            let host = groups()
                .lock()
                .map_err(|_| "group registry is unavailable")?
                .hosts
                .get(&request.group_id)
                .copied()
                .map(|host| HWND(host as *mut c_void))
                .ok_or_else(|| format!("group host is unavailable: {}", request.group_id))?;
            if !host_ids.insert(host.0 as usize) {
                return Err("multiple groups resolve to the same host".into());
            }
            if !unsafe { IsWindow(host).as_bool() } {
                return Err("group host no longer exists".into());
            }
            validate_group_host_dpi(host)?;
            let requested_windows = request
                .window_ids
                .iter()
                .map(|id| hwnd(id).map(|window| (id.clone(), window)))
                .collect::<Result<Vec<_>, _>>()?;
            for (_, window) in &requested_windows {
                if !requested_ids.insert(window.0 as usize) {
                    return Err("a window was requested in more than one group".into());
                }
            }
            resolved.push((request, host, requested_windows));
        }
        let mut touched = initial
            .iter()
            .filter_map(|(id, item)| target_group_ids.contains(&item.group_id).then_some(*id))
            .collect::<HashSet<_>>();
        touched.extend(requested_ids.iter().copied());
        let mut rollback = HashMap::new();
        for raw in &touched {
            let window = HWND(*raw as *mut c_void);
            rollback.insert(
                *raw,
                TransactionSnapshot {
                    native: snapshot_window(
                        window,
                        initial
                            .get(raw)
                            .map(|saved| saved.group_id.as_str())
                            .or_else(|| requests.first().map(|request| request.group_id.as_str()))
                            .unwrap_or("unknown"),
                    )?,
                    registry: initial.get(raw).cloned(),
                },
            );
        }
        for (_, host, requested_windows) in &resolved {
            for (_, window) in requested_windows {
                if window.0 == host.0 {
                    return abort_host_transaction(
                        "group host cannot host itself".into(),
                        &touched,
                        &rollback,
                    );
                }
                if !unsafe { IsWindow(*window).as_bool() } {
                    return abort_host_transaction(
                        format!("window {:X} no longer exists", window.0 as usize),
                        &touched,
                        &rollback,
                    );
                }
                if let Err(error) = validate_dpi_hosting(*host, *window) {
                    return abort_host_transaction(error, &touched, &rollback);
                }
            }
        }
        unsafe {
            for (request, host, requested_windows) in &resolved {
                let requested = requested_windows
                    .iter()
                    .map(|(_, window)| window.0 as usize)
                    .collect::<HashSet<_>>();
                let mut client = RECT::default();
                if let Err(error) = GetClientRect(*host, &mut client).map_err(|e| e.to_string()) {
                    return abort_host_transaction(error, &touched, &rollback);
                }
                let strip = (48 * GetDpiForWindow(*host) as i32 + 95) / 96;
                for (raw, saved) in &initial {
                    if saved.group_id == request.group_id && !requested.contains(raw) {
                        if let Err(error) = restore_hosted(HWND(*raw as *mut c_void), saved.clone())
                        {
                            return abort_host_transaction(error, &touched, &rollback);
                        }
                    }
                }
                for (id, window) in requested_windows {
                    let raw = window.0 as usize;
                    let same_group = initial
                        .get(&raw)
                        .is_some_and(|saved| saved.group_id == request.group_id);
                    if let Some(saved) = initial
                        .get(&raw)
                        .filter(|saved| saved.group_id != request.group_id)
                    {
                        if let Err(error) = restore_hosted(*window, saved.clone()) {
                            return abort_host_transaction(error, &touched, &rollback);
                        }
                    }
                    if !same_group {
                        if let Err(error) = strip_frame(*window) {
                            return abort_host_transaction(error, &touched, &rollback);
                        }
                        if let Err(error) = SetParent(*window, *host).map_err(|e| e.to_string()) {
                            return abort_host_transaction(
                                format!("SetParent failed: {error}"),
                                &touched,
                                &rollback,
                            );
                        }
                        if GetParent(*window).unwrap_or_default().0 != host.0 {
                            return abort_host_transaction(
                                "window parent was not set to group host".into(),
                                &touched,
                                &rollback,
                            );
                        }
                    }
                    let active = request.active_id.as_deref() == Some(id);
                    let _ = ShowWindow(*window, if active { SW_SHOWNA } else { SW_HIDE });
                    if let Err(error) = SetWindowPos(
                        *window,
                        HWND::default(),
                        0,
                        strip,
                        client.right - client.left,
                        (client.bottom - client.top - strip).max(0),
                        SWP_NOACTIVATE | SWP_NOZORDER,
                    )
                    .map_err(|e| e.to_string())
                    {
                        return abort_host_transaction(
                            format!("SetWindowPos(host) failed: {error}"),
                            &touched,
                            &rollback,
                        );
                    }
                    if IsWindowVisible(*window).as_bool() != active {
                        return abort_host_transaction(
                            "window visibility did not match active tab".into(),
                            &touched,
                            &rollback,
                        );
                    }
                }
            }
        }
        if let Ok(mut groups) = groups().lock() {
            groups.hosted.retain(|raw, item| {
                !target_group_ids.contains(&item.group_id) && !requested_ids.contains(raw)
            });
            for (request, _, requested_windows) in &resolved {
                for (_, window) in requested_windows {
                    let raw = window.0 as usize;
                    let snapshot = rollback.get(&raw).expect("rollback snapshot exists");
                    let mut saved = snapshot
                        .registry
                        .clone()
                        .unwrap_or_else(|| snapshot.native.clone());
                    saved.group_id = request.group_id.clone();
                    groups.hosted.insert(raw, saved);
                }
            }
        } else {
            return abort_host_transaction(
                "group registry is unavailable".into(),
                &touched,
                &rollback,
            );
        }
        Ok(())
    }
    #[tauri::command]
    pub fn focus_group_tab(
        _app: tauri::AppHandle,
        group_id: String,
        window_id: String,
    ) -> Result<(), String> {
        let host = groups()
            .lock()
            .map_err(|_| "group registry is unavailable")?
            .hosts
            .get(&group_id)
            .copied()
            .map(|host| HWND(host as *mut c_void))
            .ok_or_else(|| "group host is unavailable".to_string())?;
        let window = hwnd(&window_id)?;
        let owned = groups()
            .lock()
            .map_err(|_| "group registry is unavailable")?
            .hosted
            .get(&(window.0 as usize))
            .is_some_and(|saved| saved.group_id == group_id);
        if !owned {
            return Err("window is not owned by the requested group".into());
        }
        unsafe {
            if !IsWindow(host).as_bool() || !IsWindow(window).as_bool() {
                return Err("group host or tab no longer exists".into());
            }
            if GetParent(window).unwrap_or_default().0 != host.0 {
                return Err("tab is not attached to the requested group host".into());
            }
            let host_raw = host.0 as usize;
            let window_raw = window.0 as usize;
            let focus_group_id = group_id.clone();
            let sibling_raw = groups()
                .lock()
                .map_err(|_| "group registry is unavailable")?
                .hosted
                .iter()
                .filter_map(|(raw, saved)| (saved.group_id == group_id).then_some(*raw))
                .collect::<Vec<_>>();
            thread::spawn(move || {
                let host = HWND(host_raw as *mut c_void);
                let window = HWND(window_raw as *mut c_void);
                let result = (|| -> Result<(), String> {
                    // Do not wait for an external window's input queue from a
                    // Tauri command or its main thread. A broken/hung child
                    // must not freeze the controller while Windows resolves
                    // SetFocus across processes.
                    for raw in sibling_raw {
                        let sibling = HWND(raw as *mut c_void);
                        let active = raw == window_raw;
                        let _ = ShowWindow(sibling, if active { SW_SHOWNA } else { SW_HIDE });
                        if IsWindowVisible(sibling).as_bool() != active {
                            return Err("tab visibility did not update".into());
                        }
                    }
                    let host_thread = GetWindowThreadProcessId(host, None);
                    let window_thread = GetWindowThreadProcessId(window, None);
                    let current_thread = GetCurrentThreadId();
                    let mut attached = Vec::new();
                    for thread_id in [host_thread, window_thread] {
                        if thread_id != 0
                            && thread_id != current_thread
                            && !attached.contains(&thread_id)
                        {
                            if !AttachThreadInput(current_thread, thread_id, true).as_bool() {
                                for attached_thread in attached.into_iter().rev() {
                                    let _ =
                                        AttachThreadInput(current_thread, attached_thread, false);
                                }
                                return Err("could not attach to the tab input queue".into());
                            }
                            attached.push(thread_id);
                        }
                    }
                    let result = (|| {
                        if IsIconic(host).as_bool() {
                            let _ = ShowWindow(host, SW_RESTORE);
                        }
                        if !SetForegroundWindow(host).as_bool() {
                            return Err("Windows rejected group host activation".to_string());
                        }
                        let _ = SetActiveWindow(host);
                        SetFocus(window).map_err(|error| format!("SetFocus failed: {error}"))?;
                        Ok(())
                    })();
                    for attached_thread in attached.into_iter().rev() {
                        let _ = AttachThreadInput(current_thread, attached_thread, false);
                    }
                    result
                })();
                if let Err(error) = result {
                    if let Some(app) = EVENT_APP.get() {
                        let _ =
                            app.emit("group-focus-failed", format!("{focus_group_id}: {error}"));
                    }
                }
            });
            Ok(())
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod windows_backend {
    use super::*;

    pub fn start_window_events(_app: tauri::AppHandle) {}
    #[tauri::command]
    pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
        Ok(Vec::new())
    }
    #[tauri::command]
    pub fn list_displays() -> Result<Vec<DisplayInfo>, String> {
        Ok(Vec::new())
    }
    #[tauri::command]
    pub fn get_foreground_window() -> Option<String> {
        None
    }
    #[tauri::command]
    pub fn activate_window(_id: String) -> Result<(), String> {
        Err("Windows backend is unavailable on this platform".into())
    }
    #[tauri::command]
    pub fn restore_window(_id: String) -> Result<(), String> {
        Err("Windows backend is unavailable on this platform".into())
    }
    #[tauri::command]
    pub fn get_window_frame(_id: String) -> Result<Rect, String> {
        Err("Windows backend is unavailable on this platform".into())
    }
    #[tauri::command]
    pub fn set_window_frame(_id: String, _frame: Rect) -> Result<(), String> {
        Err("Windows backend is unavailable on this platform".into())
    }
    #[tauri::command]
    pub fn close_window(_id: String) -> Result<(), String> {
        Err("Windows backend is unavailable on this platform".into())
    }
    #[tauri::command]
    pub fn sync_group_host(
        _group_id: String,
        _window_ids: Vec<String>,
        _active_id: Option<String>,
        _frame: Rect,
    ) -> Result<(), String> {
        Err("Windows backend is unavailable on this platform".into())
    }
    #[tauri::command]
    pub fn sync_group_hosts(_requests: Vec<HostSyncRequest>) -> Result<(), String> {
        Err("Windows backend is unavailable on this platform".into())
    }
    #[tauri::command]
    pub fn focus_group_tab(
        _app: tauri::AppHandle,
        _group_id: String,
        _window_id: String,
    ) -> Result<(), String> {
        Err("Windows backend is unavailable on this platform".into())
    }
    pub fn restore_all_groups() -> Result<(), String> {
        Ok(())
    }
    pub fn restore_group_host(_group_id: &str) -> Result<(), String> {
        Ok(())
    }
    pub fn register_group_host(_group_id: String, _host: ()) {}
    pub fn group_host_registered(_group_id: &str) -> bool {
        false
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            windows_backend::start_window_events(app.handle().clone());
            let tray = TrayIconBuilder::with_id("launcher")
                .menu(&tray_menu(app.handle(), &[])?)
                .tooltip("window-tabs")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "new-group" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit("launcher:new-group", ());
                    }
                    "presets" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit("launcher:open-presets", ());
                    }
                    "check-updates" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit("launcher:check-updates", ());
                    }
                    "quit" => match windows_backend::restore_all_groups() {
                        Ok(()) => app.exit(0),
                        Err(error) => {
                            eprintln!("failed to restore grouped windows before quit: {error}");
                            let _ = app.emit("group-restore-failed", error);
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    },
                    id if id.starts_with("preset:") => {
                        let _ = app.emit("launcher:apply-preset", id.trim_start_matches("preset:"));
                    }
                    _ => {}
                })
                .build(app)?;
            app.manage(TrayState(tray));
            app.manage(AppUpdaterState::default());
            #[cfg(debug_assertions)]
            if std::env::args().any(|argument| argument == "--show-controller") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            windows_backend::list_windows,
            windows_backend::list_displays,
            windows_backend::get_foreground_window,
            windows_backend::activate_window,
            windows_backend::restore_window,
            windows_backend::get_window_frame,
            windows_backend::set_window_frame,
            windows_backend::close_window,
            windows_backend::sync_group_host,
            windows_backend::sync_group_hosts,
            windows_backend::focus_group_tab,
            prepare_update_install,
            check_app_update,
            download_app_update,
            install_app_update,
            open_group_host,
            close_group_host,
            raise_group_host,
            show_group_menu,
            set_tray_presets
        ])
        .build(tauri::generate_context!())
        .expect("tauri application error")
        .run(|_app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                restore_all_groups_for_exit();
            }
        });
}

fn restore_all_groups_for_exit() {
    if let Err(error) = windows_backend::restore_all_groups() {
        eprintln!("failed to restore grouped windows before exit: {error}");
    }
}

#[tauri::command]
fn prepare_update_install() -> Result<(), String> {
    windows_backend::restore_all_groups()
}

#[tauri::command]
async fn check_app_update(
    app: tauri::AppHandle,
    updater_state: State<'_, AppUpdaterState>,
) -> Result<Option<AppUpdateInfo>, String> {
    let updater = app
        .updater_builder()
        .on_before_exit(restore_all_groups_for_exit)
        .build()
        .map_err(|error| error.to_string())?;
    let update = updater.check().await.map_err(|error| error.to_string())?;
    let info = update.as_ref().map(|update| AppUpdateInfo {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        body: update.body.clone(),
    });
    *updater_state
        .update
        .lock()
        .map_err(|_| "updater state is unavailable".to_string())? = update;
    *updater_state
        .downloaded_bytes
        .lock()
        .map_err(|_| "updater state is unavailable".to_string())? = None;
    Ok(info)
}

#[tauri::command]
async fn download_app_update(updater_state: State<'_, AppUpdaterState>) -> Result<(), String> {
    let update = updater_state
        .update
        .lock()
        .map_err(|_| "updater state is unavailable".to_string())?
        .clone()
        .ok_or_else(|| "no update is ready to download".to_string())?;
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())?;
    *updater_state
        .downloaded_bytes
        .lock()
        .map_err(|_| "updater state is unavailable".to_string())? = Some(bytes);
    Ok(())
}

#[tauri::command]
fn install_app_update(updater_state: State<'_, AppUpdaterState>) -> Result<(), String> {
    let update = updater_state
        .update
        .lock()
        .map_err(|_| "updater state is unavailable".to_string())?
        .clone()
        .ok_or_else(|| "no update is ready to install".to_string())?;
    let bytes = updater_state
        .downloaded_bytes
        .lock()
        .map_err(|_| "updater state is unavailable".to_string())?
        .clone()
        .ok_or_else(|| "update must be downloaded before install".to_string())?;
    // Keep this explicit guard in addition to the updater's hook. The latter
    // is the last line before the plugin launches the installer and exits.
    windows_backend::restore_all_groups()?;
    update.install(bytes).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_tray_presets(
    app: tauri::AppHandle,
    tray: State<TrayState>,
    presets: Vec<TrayPreset>,
) -> Result<(), String> {
    tray.0
        .set_menu(Some(
            tray_menu(&app, &presets).map_err(|error| error.to_string())?,
        ))
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn open_group_host(app: tauri::AppHandle, group_id: String) -> Result<(), String> {
    let label = format!("group-{group_id}");
    if app.get_window(&label).is_some() {
        return Ok(());
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    let app_for_main = app.clone();
    app.run_on_main_thread(move || {
        let result = {
            #[cfg(target_os = "windows")]
            {
                windows_backend::with_mixed_dpi_hosting(|| {
                    build_group_host_on_current_thread(&app_for_main, &label, &group_id)
                })
            }
            #[cfg(not(target_os = "windows"))]
            {
                build_group_host_on_current_thread(&app_for_main, &label, &group_id)
            }
        };
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    receiver
        .recv()
        .map_err(|_| "group host creation did not complete".to_string())?
}

fn build_group_host_on_current_thread(
    app: &tauri::AppHandle,
    label: &str,
    group_id: &str,
) -> Result<(), String> {
    let window = tauri::window::WindowBuilder::new(app, label)
        .title("window-tabs")
        .inner_size(720.0, 480.0)
        .resizable(true)
        .decorations(false)
        .always_on_top(false)
        .skip_taskbar(false)
        .visible(false)
        .on_menu_event(|window, event| {
            let _ = window
                .app_handle()
                .emit("group-menu-action", event.id().as_ref());
        })
        .build()
        .map_err(|error| error.to_string())?;
    let setup = (|| {
        #[cfg(target_os = "windows")]
        let host =
            windows::Win32::Foundation::HWND(window.hwnd().map_err(|error| error.to_string())?.0);
        #[cfg(target_os = "windows")]
        windows_backend::validate_group_host_dpi(host)?;

        let strip = tauri::LogicalSize::new(720.0, 48.0);
        window
            .add_child(
                tauri::webview::WebviewBuilder::new(
                    format!("group-strip-{group_id}"),
                    WebviewUrl::App(format!("index.html?group={group_id}").into()),
                ),
                tauri::LogicalPosition::new(0.0, 0.0),
                strip,
            )
            .map_err(|error| error.to_string())?;
        let close_group_id = group_id.to_string();
        let close_app = app.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if windows_backend::group_host_registered(&close_group_id) {
                    api.prevent_close();
                    let _ = close_app.emit("group-close-requested", close_group_id.clone());
                }
            }
        });
        #[cfg(target_os = "windows")]
        windows_backend::register_group_host(group_id.to_string(), host);
        Ok(())
    })();
    if setup.is_err() {
        let _ = window.close();
    }
    setup
}

#[tauri::command]
fn close_group_host(app: tauri::AppHandle, group_id: String) -> Result<(), String> {
    let label = format!("group-{group_id}");
    windows_backend::restore_group_host(&group_id)?;
    if let Some(window) = app.get_window(&label) {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn raise_group_host(app: tauri::AppHandle, group_id: String) -> Result<(), String> {
    let label = format!("group-{group_id}");
    let window = app
        .get_window(&label)
        .ok_or_else(|| "group host is unavailable".to_string())?;
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::{
            Foundation::HWND,
            UI::WindowsAndMessaging::{
                SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
            },
        };
        let raw = window.hwnd().map_err(|error| error.to_string())?;
        let hwnd = HWND(raw.0);
        unsafe {
            SetWindowPos(
                hwnd,
                HWND_TOP,
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
            )
            .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn show_group_menu(
    app: tauri::AppHandle,
    group_id: String,
    items: Vec<GroupMenuItem>,
) -> Result<(), String> {
    let window = app
        .get_window(&format!("group-{group_id}"))
        .ok_or_else(|| "group host is unavailable".to_string())?;
    let menu_items = items
        .iter()
        .map(|item| MenuItem::with_id(&app, &item.id, &item.label, item.enabled, None::<&str>))
        .collect::<tauri::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    let references = menu_items
        .iter()
        .map(|item| item as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
        .collect::<Vec<_>>();
    let menu = Menu::with_items(&app, &references).map_err(|error| error.to_string())?;
    window.popup_menu(&menu).map_err(|error| error.to_string())
}
