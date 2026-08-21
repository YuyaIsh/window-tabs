#![windows_subsystem = "windows"]

//! A visible, interactive-desktop companion for the Phase-0 probe.
//!
//! The CLI probe can run under a non-interactive build window station. This
//! small native window verifies that `EnumWindows` sees the user's desktop.

use std::ffi::c_void;
use std::sync::{LazyLock, Mutex};

use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{BOOL, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM},
        System::LibraryLoader::GetModuleHandleW,
        UI::{
            Input::KeyboardAndMouse::{VK_DOWN, VK_RETURN, VK_UP},
            WindowsAndMessaging::*,
        },
    },
};

static WINDOWS: LazyLock<Mutex<Vec<isize>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static LIST_BOX: Mutex<isize> = Mutex::new(0);
static MAIN_WINDOW: Mutex<isize> = Mutex::new(0);

const REFRESH_BUTTON: usize = 100;
const ACTIVATE_BUTTON: usize = 101;

fn main() -> windows::core::Result<()> {
    unsafe {
        let instance: HINSTANCE = GetModuleHandleW(None)?.into();
        let class = w!("WindowTabsPhase0Picker");
        RegisterClassW(&WNDCLASSW {
            hInstance: instance,
            lpszClassName: class,
            lpfnWndProc: Some(window_proc),
            hCursor: LoadCursorW(None, IDC_ARROW)?,
            ..Default::default()
        });
        let window = CreateWindowExW(
            WS_EX_APPWINDOW,
            class,
            w!("window-tabs — Phase 0 window picker"),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            760,
            500,
            None,
            None,
            instance,
            None,
        )?;
        let _ = ShowWindow(window, SW_SHOW);
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    Ok(())
}

unsafe extern "system" fn window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_CREATE => {
            *MAIN_WINDOW.lock().expect("main window lock poisoned") = window.0 as isize;
            let list = CreateWindowExW(
                WS_EX_CLIENTEDGE,
                w!("LISTBOX"),
                None,
                WINDOW_STYLE(
                    WS_CHILD.0
                        | WS_VISIBLE.0
                        | WS_VSCROLL.0
                        | WS_TABSTOP.0
                        | LBS_HASSTRINGS as u32
                        | LBS_NOTIFY as u32
                        | LBS_NOINTEGRALHEIGHT as u32,
                ),
                16,
                16,
                710,
                360,
                window,
                HMENU(std::ptr::dangling_mut::<c_void>()),
                None,
                None,
            )
            .unwrap_or_default();
            *LIST_BOX.lock().expect("list box lock poisoned") = list.0 as isize;
            let _ = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("BUTTON"),
                w!("Refresh windows"),
                WINDOW_STYLE(WS_CHILD.0 | WS_VISIBLE.0 | WS_TABSTOP.0 | BS_PUSHBUTTON as u32),
                16,
                396,
                170,
                32,
                window,
                HMENU(REFRESH_BUTTON as *mut c_void),
                None,
                None,
            );
            let _ = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("BUTTON"),
                w!("Activate selected"),
                WINDOW_STYLE(WS_CHILD.0 | WS_VISIBLE.0 | WS_TABSTOP.0 | BS_PUSHBUTTON as u32),
                200,
                396,
                170,
                32,
                window,
                HMENU(ACTIVATE_BUTTON as *mut c_void),
                None,
                None,
            );
            refresh_windows();
            LRESULT(0)
        }
        WM_COMMAND => {
            match wparam.0 & 0xffff {
                REFRESH_BUTTON => refresh_windows(),
                ACTIVATE_BUTTON => activate_selected(),
                _ => {}
            }
            LRESULT(0)
        }
        WM_KEYDOWN => {
            match wparam.0 {
                key if key == VK_DOWN.0 as usize => select_offset(1),
                key if key == VK_UP.0 as usize => select_offset(-1),
                key if key == VK_RETURN.0 as usize => activate_selected(),
                _ => {}
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(window, message, wparam, lparam),
    }
}

fn refresh_windows() {
    unsafe {
        let list = HWND(*LIST_BOX.lock().expect("list box lock poisoned") as *mut c_void);
        let _ = SendMessageW(list, LB_RESETCONTENT, WPARAM(0), LPARAM(0));
        WINDOWS.lock().expect("window list lock poisoned").clear();
        let _ = EnumWindows(Some(enum_window), LPARAM(0));
    }
}

unsafe extern "system" fn enum_window(window: HWND, _: LPARAM) -> BOOL {
    if !IsWindowVisible(window).as_bool()
        || !GetWindow(window, GW_OWNER).unwrap_or_default().0.is_null()
    {
        return BOOL(1);
    }
    let mut text = [0u16; 1024];
    let length = GetWindowTextW(window, &mut text);
    if length <= 0 {
        return BOOL(1);
    }
    let text = String::from_utf16_lossy(&text[..length as usize]);
    let row = format!("0x{:X}  {text}", window.0 as usize);
    let mut wide = row.encode_utf16().collect::<Vec<_>>();
    wide.push(0);
    let list = HWND(*LIST_BOX.lock().expect("list box lock poisoned") as *mut c_void);
    let _ = SendMessageW(
        list,
        LB_ADDSTRING,
        WPARAM(0),
        LPARAM(wide.as_ptr() as isize),
    );
    WINDOWS
        .lock()
        .expect("window list lock poisoned")
        .push(window.0 as isize);
    BOOL(1)
}

fn activate_selected() {
    unsafe {
        let list = HWND(*LIST_BOX.lock().expect("list box lock poisoned") as *mut c_void);
        let index = SendMessageW(list, LB_GETCURSEL, WPARAM(0), LPARAM(0)).0 as isize;
        if index < 0 {
            return;
        }
        let Some(window) = WINDOWS
            .lock()
            .expect("window list lock poisoned")
            .get(index as usize)
            .copied()
        else {
            return;
        };
        let window = HWND(window as *mut c_void);
        if IsIconic(window).as_bool() {
            let _ = ShowWindow(window, SW_RESTORE);
        }
        let activated = SetForegroundWindow(window).as_bool();
        let mut title = window_title(window);
        if title.is_empty() {
            title = format!("0x{:X}", window.0 as usize);
        }
        set_picker_title(&format!("Activated ({activated}): {title}"));
    }
}

fn select_offset(offset: i32) {
    unsafe {
        let list = HWND(*LIST_BOX.lock().expect("list box lock poisoned") as *mut c_void);
        let count = SendMessageW(list, LB_GETCOUNT, WPARAM(0), LPARAM(0)).0 as i32;
        if count <= 0 {
            return;
        }
        let selected = SendMessageW(list, LB_GETCURSEL, WPARAM(0), LPARAM(0)).0 as i32;
        let next = if selected < 0 {
            0
        } else {
            (selected + offset).clamp(0, count - 1)
        };
        let _ = SendMessageW(list, LB_SETCURSEL, WPARAM(next as usize), LPARAM(0));
    }
}

fn window_title(window: HWND) -> String {
    unsafe {
        let mut text = [0u16; 1024];
        let length = GetWindowTextW(window, &mut text);
        String::from_utf16_lossy(&text[..length.max(0) as usize])
    }
}

fn set_picker_title(title: &str) {
    unsafe {
        let window = HWND(*MAIN_WINDOW.lock().expect("main window lock poisoned") as *mut c_void);
        let mut text = title.encode_utf16().collect::<Vec<_>>();
        text.push(0);
        let _ = SetWindowTextW(window, PCWSTR(text.as_ptr()));
    }
}
