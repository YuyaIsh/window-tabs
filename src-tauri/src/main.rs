#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder,
};

struct TrayState(TrayIcon<tauri::Wry>);

#[derive(Deserialize)]
struct TrayPreset {
    id: String,
    name: String,
}

fn tray_menu(app: &tauri::AppHandle, presets: &[TrayPreset]) -> tauri::Result<Menu<tauri::Wry>> {
    let new_group = MenuItem::with_id(app, "new-group", "新しいグループ", true, None::<&str>)?;
    let manager = MenuItem::with_id(app, "presets", "プリセットを管理…", true, None::<&str>)?;
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
    use std::collections::HashSet;
    use std::ffi::c_void;
    use std::path::Path;
    use std::sync::{Mutex, OnceLock};
    use std::thread;
    use windows::Win32::{
        Foundation::{CloseHandle, BOOL, HWND, LPARAM, POINT, RECT},
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
            Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL},
            WindowsAndMessaging::*,
        },
    };

    static EVENT_APP: OnceLock<tauri::AppHandle> = OnceLock::new();
    static NATIVE_DRAGS: OnceLock<Mutex<HashSet<usize>>> = OnceLock::new();

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
        if window == probe.source || IsIconic(window).as_bool() || !is_manageable_top_level(window)
        {
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
        let value = title(window);
        let mut rect = RECT::default();
        if GetWindowRect(window, &mut rect).is_err() {
            return BOOL(1);
        }
        let (process_id, app_id, app_name, executable_path, class_name) = process_details(window);
        if is_own_process(process_id, &app_id) {
            return BOOL(1);
        }
        let items = &mut *(data.0 as *mut Vec<WindowInfo>);
        items.push(WindowInfo {
            id: format!("{:X}", window.0 as usize),
            process_id,
            app_id,
            app_name,
            executable_path,
            class_name,
            title: value,
            frame: Rect {
                x: rect.left,
                y: rect.top,
                width: rect.right - rect.left,
                height: rect.bottom - rect.top,
            },
            display_id: display_id_for(window),
            state: if IsIconic(window).as_bool() {
                "minimized".into()
            } else if IsZoomed(window).as_bool() {
                "maximized".into()
            } else {
                "normal".into()
            },
        });
        BOOL(1)
    }
    #[tauri::command]
    pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
        let mut items = Vec::new();
        unsafe {
            EnumWindows(
                Some(each),
                LPARAM((&mut items as *mut Vec<WindowInfo>) as isize),
            )
            .map_err(|e| e.to_string())?;
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
            SetWindowPos(
                hwnd(&id)?,
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
}

fn main() {
    tauri::Builder::default()
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
                    "quit" => app.exit(0),
                    id if id.starts_with("preset:") => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit("launcher:apply-preset", id.trim_start_matches("preset:"));
                    }
                    _ => {}
                })
                .build(app)?;
            app.manage(TrayState(tray));
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
            open_group_host,
            close_group_host,
            set_tray_presets
        ])
        .run(tauri::generate_context!())
        .expect("tauri application error");
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
    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App(format!("index.html?group={group_id}").into()),
    )
    .title("window-tabs")
    .inner_size(720.0, 120.0)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .build()
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn close_group_host(app: tauri::AppHandle, group_id: String) -> Result<(), String> {
    let label = format!("group-{group_id}");
    if let Some(window) = app.get_webview_window(&label) {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}
