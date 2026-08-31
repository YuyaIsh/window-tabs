#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    Emitter, Manager, State, WebviewUrl,
};

struct TrayState(TrayIcon<tauri::Wry>);

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

#[cfg(target_os = "windows")]
mod windows_backend {
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::ffi::c_void;
    use std::path::Path;
    use std::sync::{Mutex, OnceLock};
    use std::thread;
    use windows::Win32::{
        Foundation::{CloseHandle, BOOL, HWND, LPARAM, POINT, RECT, WPARAM},
        Graphics::Gdi::{
            EnumDisplayMonitors, GetMonitorInfoW, MonitorFromWindow, HDC, HMONITOR, MONITORINFOEXW,
            MONITOR_DEFAULTTONEAREST,
        },
        System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
        UI::{
            Accessibility::{SetWinEventHook, HWINEVENTHOOK},
            HiDpi::GetDpiForWindow,
            Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL},
            WindowsAndMessaging::*,
        },
    };

    static EVENT_APP: OnceLock<tauri::AppHandle> = OnceLock::new();
    static NATIVE_DRAGS: OnceLock<Mutex<HashSet<usize>>> = OnceLock::new();
    static GROUPS: OnceLock<Mutex<GroupRegistry>> = OnceLock::new();

    struct HostedWindow {
        group_id: String,
        parent: usize,
        style: i32,
        exstyle: i32,
        frame: Rect,
    }
    #[derive(Default)]
    struct GroupRegistry {
        hosts: HashMap<String, usize>,
        hosted: HashMap<usize, HostedWindow>,
    }
    fn groups() -> &'static Mutex<GroupRegistry> {
        GROUPS.get_or_init(|| Mutex::new(GroupRegistry::default()))
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
    fn strip_frame(window: HWND) {
        unsafe {
            let style = GetWindowLongW(window, GWL_STYLE);
            let frame =
                (WS_CAPTION | WS_THICKFRAME | WS_MINIMIZE | WS_MAXIMIZE | WS_SYSMENU).0 as i32;
            SetWindowLongW(
                window,
                GWL_STYLE,
                (style & !frame & !WS_POPUP.0 as i32) | WS_CHILD.0 as i32,
            );
            let _ = SetWindowPos(
                window,
                HWND::default(),
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
            );
        }
    }
    fn restore_hosted(window: HWND, saved: HostedWindow) {
        unsafe {
            if !IsWindow(window).as_bool() {
                return;
            }
            let _ = ShowWindow(window, SW_HIDE);
            let _ = SetParent(window, HWND(saved.parent as *mut c_void));
            SetWindowLongW(window, GWL_STYLE, saved.style);
            SetWindowLongW(window, GWL_EXSTYLE, saved.exstyle);
            let _ = SetWindowPos(
                window,
                HWND::default(),
                saved.frame.x,
                saved.frame.y,
                saved.frame.width,
                saved.frame.height,
                SWP_NOACTIVATE | SWP_NOZORDER | SWP_FRAMECHANGED,
            );
            let _ = ShowWindow(window, SW_SHOWNA);
        }
    }
    fn restore_group(group_id: &str) {
        let saved = groups()
            .lock()
            .ok()
            .map(|mut groups| {
                groups.hosts.remove(group_id);
                let ids = groups
                    .hosted
                    .iter()
                    .filter_map(|(id, item)| (item.group_id == group_id).then_some(*id))
                    .collect::<Vec<_>>();
                ids.into_iter()
                    .filter_map(|id| {
                        groups
                            .hosted
                            .remove(&id)
                            .map(|item| (HWND(id as *mut c_void), item))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for (window, item) in saved {
            restore_hosted(window, item);
        }
    }
    pub fn restore_group_host(group_id: &str) {
        restore_group(group_id);
    }
    pub fn restore_all_groups() {
        let group_ids = groups()
            .lock()
            .ok()
            .map(|groups| groups.hosts.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for group_id in group_ids {
            restore_group(&group_id);
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
            if hook.0.is_null() {
                return;
            }
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
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
        let host = groups()
            .lock()
            .map_err(|_| "group registry is unavailable")?
            .hosts
            .get(&group_id)
            .copied()
            .map(|host| HWND(host as *mut c_void))
            .ok_or_else(|| "group host is unavailable".to_string())?;
        let requested = window_ids
            .iter()
            .map(|id| hwnd(id).map(|window| window.0 as usize))
            .collect::<Result<HashSet<usize>, _>>()?;
        let removed = groups()
            .lock()
            .ok()
            .map(|mut groups| {
                groups
                    .hosted
                    .iter()
                    .filter_map(|(id, item)| {
                        (item.group_id == group_id && !requested.contains(id)).then_some(*id)
                    })
                    .collect::<Vec<_>>()
                    .into_iter()
                    .filter_map(|id| {
                        groups
                            .hosted
                            .remove(&id)
                            .map(|item| (HWND(id as *mut c_void), item))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for (window, item) in removed {
            restore_hosted(window, item);
        }
        unsafe {
            let mut client = RECT::default();
            GetClientRect(host, &mut client).map_err(|e| e.to_string())?;
            let strip = (48 * GetDpiForWindow(host) as i32 + 95) / 96;
            for id in window_ids {
                let window = hwnd(&id)?;
                let previous = groups()
                    .lock()
                    .ok()
                    .and_then(|mut groups| groups.hosted.remove(&(window.0 as usize)));
                if let Some(mut item) = previous {
                    if item.group_id != group_id {
                        restore_hosted(window, item);
                    } else {
                        item.frame = frame.clone();
                        groups()
                            .lock()
                            .ok()
                            .map(|mut groups| groups.hosted.insert(window.0 as usize, item));
                    }
                }
                if !is_hosted(window) {
                    let saved = HostedWindow {
                        group_id: group_id.clone(),
                        parent: GetParent(window).unwrap_or_default().0 as usize,
                        style: GetWindowLongW(window, GWL_STYLE),
                        exstyle: GetWindowLongW(window, GWL_EXSTYLE),
                        frame: frame.clone(),
                    };
                    SetParent(window, host).map_err(|e| e.to_string())?;
                    strip_frame(window);
                    groups()
                        .lock()
                        .map_err(|_| "group registry is unavailable")?
                        .hosted
                        .insert(window.0 as usize, saved);
                }
                let active = active_id.as_deref() == Some(id.as_str());
                let _ = ShowWindow(window, if active { SW_SHOWNA } else { SW_HIDE });
                SetWindowPos(
                    window,
                    HWND::default(),
                    0,
                    strip,
                    client.right - client.left,
                    (client.bottom - client.top - strip).max(0),
                    SWP_NOACTIVATE | SWP_NOZORDER,
                )
                .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
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
    pub fn restore_all_groups() {}
    pub fn restore_group_host(_group_id: &str) {}
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
                    "quit" => {
                        windows_backend::restore_all_groups();
                        app.exit(0);
                    }
                    id if id.starts_with("preset:") => {
                        let _ = app.emit("launcher:apply-preset", id.trim_start_matches("preset:"));
                    }
                    _ => {}
                })
                .build(app)?;
            app.manage(TrayState(tray));
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
                windows_backend::restore_all_groups();
            }
        });
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
    let window = tauri::window::WindowBuilder::new(&app, &label)
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
    let close_group_id = group_id.clone();
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
    windows_backend::register_group_host(
        group_id,
        windows::Win32::Foundation::HWND(window.hwnd().map_err(|error| error.to_string())?.0),
    );
    Ok(())
}

#[tauri::command]
fn close_group_host(app: tauri::AppHandle, group_id: String) -> Result<(), String> {
    let label = format!("group-{group_id}");
    windows_backend::restore_group_host(&group_id);
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
