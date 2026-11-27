//! The Windows computer-use backend: accessibility inspection and actions over
//! Windows UI Automation (`IUIAutomation`), top-level window enumeration over
//! `EnumWindows` + DWM bounds + integrity-level checks, and fallback window
//! input via `SendInput`.
//!
//! Coordinates returned by this backend are physical screen pixels under
//! Per-Monitor DPI Awareness v2 so `DwmGetWindowAttribute`, UI Automation
//! `CurrentBoundingRectangle`, and `SendInput` (`MOUSEEVENTF_VIRTUALDESK`) all
//! share one exact coordinate space. Electron's cursor overlay converts to DIP
//! on its own side via `screen.screenToDipRect` / `screen.screenToDipPoint`.

#![allow(non_snake_case)]

use std::ffi::c_void;
use std::mem::size_of;
use std::thread;
use std::time::Duration;

use windows::core::{BOOL, BSTR, HRESULT, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_INSUFFICIENT_BUFFER, HANDLE, HWND, LPARAM, RECT, RPC_E_CHANGED_MODE,
    S_FALSE, S_OK,
};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel,
    TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
    PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, ExpandCollapseState_Expanded, IUIAutomation, IUIAutomationElement,
    IUIAutomationExpandCollapsePattern, IUIAutomationInvokePattern, IUIAutomationScrollPattern,
    IUIAutomationSelectionItemPattern, IUIAutomationTogglePattern, IUIAutomationTreeWalker,
    IUIAutomationValuePattern, ScrollAmount, ScrollAmount_LargeDecrement,
    ScrollAmount_LargeIncrement, ScrollAmount_NoAmount, ScrollAmount_SmallDecrement,
    ScrollAmount_SmallIncrement, UIA_ExpandCollapsePatternId, UIA_InvokePatternId,
    UIA_ScrollPatternId, UIA_SelectionItemPatternId, UIA_TogglePatternId, UIA_ValuePatternId,
};
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN,
    MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
    MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    AllowSetForegroundWindow, EnumWindows, GetForegroundWindow, GetShellWindow,
    GetSystemMetrics, GetWindowLongW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, SetForegroundWindow,
    ShowWindow, ASFW_ANY, GWL_EXSTYLE, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
    SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_RESTORE, WS_EX_APPWINDOW, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW,
};

use super::backend::{
    Desktop, DesktopError, Dispatched, Measured, RawInspection, RawTarget, TargetRef,
};
use super::uid::{identity_digest, make_uid, parse_uid};
use super::windows_logic::{
    extract_process_names, horizontal_wheel_delta, is_elevated_integrity_rid,
    normalize_virtual_desktop_coord, parse_chord, supported_actions, uia_control_type_role,
    vertical_wheel_delta, UiaPatternFlags, VK_CONTROL,
};
use super::{Action, ActionKind, Capabilities, Fidelity, Node, PermissionState, Rect, MAX_LABEL_CHARS};

/// Bound recursion depth so a pathological or cyclic custom UIA provider cannot
/// blow the stack or spin indefinitely.
const MAX_TREE_DEPTH: usize = 32;

/// Default Medium integrity RID (SECURITY_MANDATORY_MEDIUM_RID).
const MEDIUM_INTEGRITY_RID: u32 = 0x2000;

pub struct WindowsDesktop {
    own_integrity_rid: u32,
}

impl WindowsDesktop {
    pub fn new() -> Self {
        // Ensure physical-pixel consistency across DWM, UIA, and SendInput.
        // Ignoring the return value is safe if already set via manifest/host.
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        let own_integrity_rid = current_process_integrity_rid().unwrap_or(MEDIUM_INTEGRITY_RID);
        Self { own_integrity_rid }
    }

    fn hwnd_from_target(target: &TargetRef) -> Result<HWND, DesktopError> {
        if target.window == 0 {
            return Err(DesktopError::TargetGone);
        }
        let hwnd = HWND(target.window as usize as *mut c_void);
        if !unsafe { IsWindow(Some(hwnd)).as_bool() } {
            return Err(DesktopError::TargetGone);
        }
        let pid = window_pid(hwnd);
        if pid == 0 || pid != target.pid {
            return Err(DesktopError::TargetGone);
        }
        Ok(hwnd)
    }

    fn measure_hwnd(&self, hwnd: HWND, expected_pid: Option<i32>) -> Result<Measured, DesktopError> {
        if !unsafe { IsWindow(Some(hwnd)).as_bool() }
            || !unsafe { IsWindowVisible(hwnd).as_bool() }
            || unsafe { IsIconic(hwnd).as_bool() }
            || is_window_cloaked(hwnd)
        {
            return Err(DesktopError::TargetGone);
        }
        let pid = window_pid(hwnd);
        if pid == 0 {
            return Err(DesktopError::TargetGone);
        }
        if let Some(expected) = expected_pid {
            if pid != expected {
                return Err(DesktopError::TargetGone);
            }
        }
        let (_, app_key, elevated) = query_process_identity(pid, self.own_integrity_rid);
        if elevated {
            return Err(DesktopError::Elevated);
        }
        let bounds = window_bounds(hwnd).ok_or(DesktopError::TargetGone)?;
        if bounds.width < 1.0 || bounds.height < 1.0 {
            return Err(DesktopError::TargetGone);
        }
        let title = window_title(hwnd);
        Ok(Measured {
            bounds,
            app_key,
            title,
        })
    }

    fn enumerate(&self) -> Result<Vec<RawTarget>, DesktopError> {
        struct EnumState {
            own_integrity_rid: u32,
            shell_hwnd: HWND,
            targets: Vec<RawTarget>,
        }

        unsafe extern "system" fn callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let state = &mut *(lparam.0 as *mut EnumState);
            if hwnd == state.shell_hwnd {
                return BOOL(1);
            }
            if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                return BOOL(1);
            }
            if is_window_cloaked(hwnd) {
                return BOOL(1);
            }
            let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            let is_tool = (ex_style & WS_EX_TOOLWINDOW.0) != 0;
            let is_app = (ex_style & WS_EX_APPWINDOW.0) != 0;
            let is_no_activate = (ex_style & WS_EX_NOACTIVATE.0) != 0;
            if (is_tool && !is_app) || (is_no_activate && !is_app) {
                return BOOL(1);
            }
            let Some(bounds) = window_bounds(hwnd) else {
                return BOOL(1);
            };
            if bounds.width < 1.0 || bounds.height < 1.0 {
                return BOOL(1);
            }
            let title = window_title(hwnd);
            let pid = window_pid(hwnd);
            if pid <= 0 {
                return BOOL(1);
            }
            let (app_name, app_key, elevated) =
                query_process_identity(pid, state.own_integrity_rid);
            if app_name.is_empty() && title.is_empty() {
                return BOOL(1);
            }
            let window = hwnd.0 as usize as u64;
            let display_app = if app_name.is_empty() {
                format!("pid-{pid}")
            } else {
                app_name
            };
            let resolved_key = if app_key.is_empty() {
                display_app.to_ascii_lowercase()
            } else {
                app_key
            };
            state.targets.push(RawTarget {
                target: TargetRef {
                    target_id: format!("{pid}:{window}"),
                    pid,
                    window,
                    app_key: resolved_key,
                },
                app_name: display_app,
                title,
                bounds,
                elevated,
            });
            BOOL(1)
        }

        let shell_hwnd = unsafe { GetShellWindow() };
        let mut state = EnumState {
            own_integrity_rid: self.own_integrity_rid,
            shell_hwnd,
            targets: Vec::new(),
        };
        unsafe {
            let _ = EnumWindows(
                Some(callback),
                LPARAM(&mut state as *mut EnumState as isize),
            );
        }
        Ok(state.targets)
    }

    fn walk_uia(
        &self,
        walker: &IUIAutomationTreeWalker,
        element: &IUIAutomationElement,
        path: &mut Vec<usize>,
        parent: Option<usize>,
        nodes: &mut Vec<Node>,
        max_nodes: usize,
        depth: usize,
    ) -> bool {
        if nodes.len() >= max_nodes {
            return true;
        }
        let (role, label, has_value, enabled, focused, bounds, flags, control_type_id) =
            read_element_snapshot(element);
        let actions = supported_actions(flags, control_type_id, enabled, bounds.is_some());
        let index = nodes.len();
        nodes.push(Node {
            uid: make_uid(path, role, label.as_deref()),
            role: role.to_string(),
            label,
            has_value,
            enabled,
            focused,
            bounds,
            parent,
            actions,
        });

        if depth >= MAX_TREE_DEPTH {
            return false;
        }

        let mut child_opt = unsafe { walker.GetFirstChildElement(element).ok() };
        let mut child_index = 0usize;
        while let Some(child) = child_opt {
            path.push(child_index);
            let truncated =
                self.walk_uia(walker, &child, path, Some(index), nodes, max_nodes, depth + 1);
            path.pop();
            if truncated {
                return true;
            }
            child_index += 1;
            child_opt = unsafe { walker.GetNextSiblingElement(&child).ok() };
        }
        false
    }

    fn resolve_uia_element(
        &self,
        walker: &IUIAutomationTreeWalker,
        root: &IUIAutomationElement,
        uid: &str,
    ) -> Result<(IUIAutomationElement, Option<Rect>, bool), DesktopError> {
        let (path, digest) = parse_uid(uid).ok_or(DesktopError::ElementNotFound)?;
        let mut current = root.clone();
        for target_index in path {
            let mut child_opt = unsafe { walker.GetFirstChildElement(&current).ok() };
            let mut idx = 0usize;
            let mut matched = None;
            while let Some(child) = child_opt {
                if idx == target_index {
                    matched = Some(child);
                    break;
                }
                idx += 1;
                child_opt = unsafe { walker.GetNextSiblingElement(&child).ok() };
            }
            current = matched.ok_or(DesktopError::ElementNotFound)?;
        }
        let (role, label, _, _, _, bounds, flags, _) = read_element_snapshot(&current);
        if identity_digest(role, label.as_deref()) != digest {
            return Err(DesktopError::ElementNotFound);
        }
        Ok((current, bounds, flags.is_password))
    }

    fn click_point(x: f64, y: f64, right: bool, double: bool) -> Result<(), DesktopError> {
        let virtual_screen = virtual_screen_rect()?;
        let (nx, ny) =
            normalize_virtual_desktop_coord(x, y, virtual_screen).ok_or(DesktopError::NotActionable)?;
        let (down_flag, up_flag) = if right {
            (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
        } else {
            (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
        };
        let move_flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;

        let mut inputs = vec![
            mouse_input(nx, ny, 0, move_flags),
            mouse_input(nx, ny, 0, move_flags | down_flag),
            mouse_input(nx, ny, 0, move_flags | up_flag),
        ];
        if double && !right {
            inputs.push(mouse_input(nx, ny, 0, move_flags | down_flag));
            inputs.push(mouse_input(nx, ny, 0, move_flags | up_flag));
        }
        send_inputs(&inputs)
    }

    fn scroll_at_point(x: f64, y: f64, dx: f64, dy: f64) -> Result<(), DesktopError> {
        let virtual_screen = virtual_screen_rect()?;
        let (nx, ny) =
            normalize_virtual_desktop_coord(x, y, virtual_screen).ok_or(DesktopError::NotActionable)?;
        let move_flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        let mut inputs = vec![mouse_input(nx, ny, 0, move_flags)];
        let v_delta = vertical_wheel_delta(dy);
        if v_delta != 0 {
            inputs.push(mouse_input(0, 0, v_delta as u32, MOUSEEVENTF_WHEEL));
        }
        let h_delta = horizontal_wheel_delta(dx);
        if h_delta != 0 {
            inputs.push(mouse_input(0, 0, h_delta as u32, MOUSEEVENTF_HWHEEL));
        }
        if inputs.len() == 1 {
            return Ok(());
        }
        send_inputs(&inputs)
    }

    fn press_keys(hwnd: HWND, chords: &[String]) -> Result<(), DesktopError> {
        let parsed = chords
            .iter()
            .map(|c| parse_chord(c).ok_or(DesktopError::NotActionable))
            .collect::<Result<Vec<_>, _>>()?;
        focus_window(hwnd);
        for chord in parsed {
            let mut inputs = Vec::with_capacity(chord.modifiers.len() * 2 + 2);
            for &modifier in &chord.modifiers {
                inputs.push(vk_input(modifier, false));
            }
            inputs.push(vk_input(chord.key, false));
            inputs.push(vk_input(chord.key, true));
            for &modifier in chord.modifiers.iter().rev() {
                inputs.push(vk_input(modifier, true));
            }
            send_inputs(&inputs)?;
        }
        Ok(())
    }

    fn type_unicode_text(text: &str) -> Result<(), DesktopError> {
        let mut inputs = Vec::new();
        for unit in text.encode_utf16() {
            if unit == b'\r' as u16 {
                continue;
            }
            if unit == b'\n' as u16 {
                inputs.push(vk_input(super::windows_logic::VK_RETURN, false));
                inputs.push(vk_input(super::windows_logic::VK_RETURN, true));
                continue;
            }
            inputs.push(unicode_input(unit, false));
            inputs.push(unicode_input(unit, true));
        }
        if inputs.is_empty() {
            return Ok(());
        }
        send_inputs(&inputs)
    }

    fn select_all_and_type(hwnd: HWND, text: &str) -> Result<(), DesktopError> {
        focus_window(hwnd);
        // Ctrl+A to replace existing content before typing, matching SetValue semantics.
        let select_all = [
            vk_input(VK_CONTROL, false),
            vk_input(b'A' as u16, false),
            vk_input(b'A' as u16, true),
            vk_input(VK_CONTROL, true),
        ];
        send_inputs(&select_all)?;
        if text.is_empty() {
            let clear = [
                vk_input(super::windows_logic::VK_BACK, false),
                vk_input(super::windows_logic::VK_BACK, true),
            ];
            return send_inputs(&clear);
        }
        Self::type_unicode_text(text)
    }
}

impl Desktop for WindowsDesktop {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            platform: "win32".into(),
            backend: "windows-uia".into(),
            fidelity: Fidelity::Full,
            accessibility: PermissionState::Granted,
            capture: PermissionState::Granted,
            session_type: None,
            input_unsupported_reason: None,
        }
    }

    fn request_permission(&self) -> Result<PermissionState, DesktopError> {
        // Windows UI Automation needs no OS consent prompt.
        Ok(PermissionState::Granted)
    }

    fn list_targets(&self) -> Result<Vec<RawTarget>, DesktopError> {
        self.enumerate()
    }

    fn measure(&self, target: &TargetRef) -> Result<Measured, DesktopError> {
        let hwnd = Self::hwnd_from_target(target)?;
        self.measure_hwnd(hwnd, Some(target.pid))
    }

    fn inspect(&self, target: &TargetRef, max_nodes: usize) -> Result<RawInspection, DesktopError> {
        let hwnd = Self::hwnd_from_target(target)?;
        self.measure_hwnd(hwnd, Some(target.pid))?;
        with_uia(|uia| {
            let root = unsafe { uia.ElementFromHandle(hwnd) }.map_err(|_| DesktopError::TargetGone)?;
            let walker = unsafe { uia.ControlViewWalker() }
                .map_err(|err| DesktopError::Failed(format!("UIA ControlViewWalker: {err}")))?;
            let mut nodes = Vec::new();
            let mut path = Vec::new();
            let truncated = self.walk_uia(&walker, &root, &mut path, None, &mut nodes, max_nodes, 0);
            Ok(RawInspection {
                nodes,
                truncated,
                fidelity: Fidelity::Full,
            })
        })
    }

    fn secure_input_active(&self) -> bool {
        // 1. If the input desktop cannot be opened (UAC secure desktop, lock screen),
        // fail closed so no inspection or input happens on a credential screen.
        let desktop = unsafe {
            OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
        };
        match desktop {
            Ok(handle) => {
                let _ = unsafe { CloseDesktop(handle) };
            }
            Err(_) => return true,
        }

        // 2. Check whether the currently focused UIA element is a password box.
        with_uia(|uia| {
            let focused = match unsafe { uia.GetFocusedElement() } {
                Ok(el) => el,
                Err(_) => return Ok(false),
            };
            let is_pw = unsafe { focused.CurrentIsPassword() }
                .map(|b| b.as_bool())
                .unwrap_or(false);
            Ok(is_pw)
        })
        .unwrap_or(false)
    }

    fn perform(
        &self,
        target: &TargetRef,
        uid: Option<&str>,
        action: &Action,
    ) -> Result<Dispatched, DesktopError> {
        let kind = action.kind.ok_or(DesktopError::NotActionable)?;
        let hwnd = Self::hwnd_from_target(target)?;
        let measured = self.measure_hwnd(hwnd, Some(target.pid))?;

        if kind == ActionKind::PressKeys {
            let keys = action.keys.as_ref().ok_or(DesktopError::NotActionable)?;
            Self::press_keys(hwnd, keys)?;
            return Ok(Dispatched::WindowEvent);
        }

        // Element-targeted path (preferred over coordinate actions).
        if let Some(uid) = uid {
            return with_uia(|uia| {
                let root =
                    unsafe { uia.ElementFromHandle(hwnd) }.map_err(|_| DesktopError::TargetGone)?;
                let walker = unsafe { uia.ControlViewWalker() }
                    .map_err(|err| DesktopError::Failed(format!("UIA ControlViewWalker: {err}")))?;
                let (element, bounds, is_password) = self.resolve_uia_element(&walker, &root, uid)?;
                if is_password {
                    return Err(DesktopError::NotActionable);
                }
                let center = bounds.map(|b| (b.x + b.width / 2.0, b.y + b.height / 2.0));

                match kind {
                    ActionKind::Click => {
                        if try_uia_click(&element) {
                            return Ok(Dispatched::AccessibilityAction);
                        }
                        if let Some((cx, cy)) = center {
                            focus_window(hwnd);
                            Self::click_point(cx, cy, false, false)?;
                            return Ok(Dispatched::WindowEvent);
                        }
                        Err(DesktopError::NotActionable)
                    }
                    ActionKind::DoubleClick => {
                        if let Some((cx, cy)) = center {
                            focus_window(hwnd);
                            Self::click_point(cx, cy, false, true)?;
                            return Ok(Dispatched::WindowEvent);
                        }
                        if try_uia_invoke(&element) {
                            let _ = try_uia_invoke(&element);
                            return Ok(Dispatched::AccessibilityAction);
                        }
                        Err(DesktopError::NotActionable)
                    }
                    ActionKind::RightClick => {
                        let (cx, cy) = center.ok_or(DesktopError::NotActionable)?;
                        focus_window(hwnd);
                        Self::click_point(cx, cy, true, false)?;
                        Ok(Dispatched::WindowEvent)
                    }
                    ActionKind::Select => {
                        if try_uia_select(&element, &walker, action.option.as_deref()) {
                            return Ok(Dispatched::AccessibilityAction);
                        }
                        if let Some((cx, cy)) = center {
                            focus_window(hwnd);
                            Self::click_point(cx, cy, false, false)?;
                            return Ok(Dispatched::WindowEvent);
                        }
                        Err(DesktopError::NotActionable)
                    }
                    ActionKind::SetValue => {
                        let text = action.text.as_deref().ok_or(DesktopError::NotActionable)?;
                        if try_uia_set_value(&element, text) {
                            return Ok(Dispatched::AccessibilityAction);
                        }
                        // Fallback for Chromium/Electron/custom rich inputs that do not
                        // implement ValuePattern::SetValue: focus and type Unicode.
                        focus_window(hwnd);
                        if unsafe { element.SetFocus() }.is_err() {
                            if let Some((cx, cy)) = center {
                                Self::click_point(cx, cy, false, false)?;
                            } else {
                                return Err(DesktopError::NotActionable);
                            }
                        }
                        Self::select_all_and_type(hwnd, text)?;
                        Ok(Dispatched::WindowEvent)
                    }
                    ActionKind::Scroll => {
                        let scroll = action.scroll.ok_or(DesktopError::NotActionable)?;
                        if try_uia_scroll(&element, scroll.dx, scroll.dy) {
                            return Ok(Dispatched::AccessibilityAction);
                        }
                        let (cx, cy) = center.unwrap_or((
                            measured.bounds.x + measured.bounds.width / 2.0,
                            measured.bounds.y + measured.bounds.height / 2.0,
                        ));
                        focus_window(hwnd);
                        Self::scroll_at_point(cx, cy, scroll.dx, scroll.dy)?;
                        Ok(Dispatched::WindowEvent)
                    }
                    ActionKind::PressKeys => unreachable!("handled above"),
                }
            });
        }

        // Coordinate-targeted path (already validated and clamped by policy.rs).
        let point = action.point.ok_or(DesktopError::ElementNotFound)?;
        let sx = measured.bounds.x + point.x;
        let sy = measured.bounds.y + point.y;
        focus_window(hwnd);
        match kind {
            ActionKind::Click => Self::click_point(sx, sy, false, false)?,
            ActionKind::DoubleClick => Self::click_point(sx, sy, false, true)?,
            ActionKind::RightClick => Self::click_point(sx, sy, true, false)?,
            ActionKind::Select => Self::click_point(sx, sy, false, false)?,
            ActionKind::SetValue => {
                let text = action.text.as_deref().ok_or(DesktopError::NotActionable)?;
                Self::click_point(sx, sy, false, false)?;
                Self::select_all_and_type(hwnd, text)?;
            }
            ActionKind::Scroll => {
                let scroll = action.scroll.ok_or(DesktopError::NotActionable)?;
                Self::scroll_at_point(sx, sy, scroll.dx, scroll.dy)?;
            }
            ActionKind::PressKeys => unreachable!("handled above"),
        }
        Ok(Dispatched::WindowEvent)
    }

    fn self_pids(&self) -> Vec<i32> {
        let own = std::process::id();
        let mut pids = vec![own as i32];
        if let Some(parent) = parent_pid_windows(own) {
            if parent > 0 && parent as i32 != own as i32 {
                pids.push(parent as i32);
            }
        }
        pids
    }
}

struct ComGuard {
    should_uninit: bool,
}

impl ComGuard {
    fn enter() -> Result<Self, DesktopError> {
        let hr: HRESULT = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if hr == S_OK || hr == S_FALSE {
            Ok(Self {
                should_uninit: true,
            })
        } else if hr == RPC_E_CHANGED_MODE {
            // Thread already initialized COM in another apartment (e.g., STA).
            Ok(Self {
                should_uninit: false,
            })
        } else {
            Err(DesktopError::Failed(format!("CoInitializeEx failed: {hr:?}")))
        }
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.should_uninit {
            unsafe { CoUninitialize() };
        }
    }
}

fn with_uia<T>(f: impl FnOnce(&IUIAutomation) -> Result<T, DesktopError>) -> Result<T, DesktopError> {
    let _guard = ComGuard::enter()?;
    let uia: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
            .map_err(|err| DesktopError::Failed(format!("CUIAutomation unavailable: {err}")))?;
    f(&uia)
}

fn read_element_snapshot(
    element: &IUIAutomationElement,
) -> (
    &'static str,
    Option<String>,
    bool,
    bool,
    bool,
    Option<Rect>,
    UiaPatternFlags,
    i32,
) {
    let control_type_id = unsafe { element.CurrentControlType() }
        .map(|ct| ct.0)
        .unwrap_or(0);
    let role = uia_control_type_role(control_type_id);
    let label = unsafe { element.CurrentName() }
        .ok()
        .map(|s| s.to_string())
        .map(|s| s.chars().take(MAX_LABEL_CHARS).collect::<String>())
        .filter(|s| !s.trim().is_empty());
    let enabled = unsafe { element.CurrentIsEnabled() }
        .map(|b| b.as_bool())
        .unwrap_or(true);
    let focused = unsafe { element.CurrentHasKeyboardFocus() }
        .map(|b| b.as_bool())
        .unwrap_or(false);
    let is_password = unsafe { element.CurrentIsPassword() }
        .map(|b| b.as_bool())
        .unwrap_or(false);
    let bounds = unsafe { element.CurrentBoundingRectangle() }.ok().and_then(|r| {
        let width = f64::from(r.right - r.left);
        let height = f64::from(r.bottom - r.top);
        if width > 0.0 && height > 0.0 {
            Some(Rect {
                x: f64::from(r.left),
                y: f64::from(r.top),
                width,
                height,
            })
        } else {
            None
        }
    });

    let invoke = unsafe { element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) }.is_ok();
    let toggle = unsafe { element.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) }.is_ok();
    let selection_item = unsafe {
        element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
    }
    .is_ok();
    let expand_collapse = unsafe {
        element.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId)
    }
    .is_ok();
    let scroll = unsafe { element.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId) }.is_ok();
    let value_pattern = unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }.ok();
    let value = value_pattern.is_some();
    let value_read_only = value_pattern
        .as_ref()
        .and_then(|p| unsafe { p.CurrentIsReadOnly() }.ok())
        .map(|b| b.as_bool())
        .unwrap_or(false);
    let has_value = value;

    let flags = UiaPatternFlags {
        invoke,
        toggle,
        selection_item,
        expand_collapse,
        value,
        value_read_only,
        scroll,
        is_password,
    };

    (role, label, has_value, enabled, focused, bounds, flags, control_type_id)
}

fn try_uia_invoke(element: &IUIAutomationElement) -> bool {
    if let Ok(pattern) =
        unsafe { element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) }
    {
        return unsafe { pattern.Invoke() }.is_ok();
    }
    false
}

fn try_uia_click(element: &IUIAutomationElement) -> bool {
    if try_uia_invoke(element) {
        return true;
    }
    if let Ok(pattern) =
        unsafe { element.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) }
    {
        if unsafe { pattern.Toggle() }.is_ok() {
            return true;
        }
    }
    if let Ok(pattern) = unsafe {
        element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
    } {
        if unsafe { pattern.Select() }.is_ok() {
            return true;
        }
    }
    if let Ok(pattern) = unsafe {
        element.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId)
    } {
        let state = unsafe { pattern.CurrentExpandCollapseState() }.ok();
        let res = if state == Some(ExpandCollapseState_Expanded) {
            unsafe { pattern.Collapse() }
        } else {
            unsafe { pattern.Expand() }
        };
        if res.is_ok() {
            return true;
        }
    }
    false
}

fn try_uia_select(
    element: &IUIAutomationElement,
    walker: &IUIAutomationTreeWalker,
    option: Option<&str>,
) -> bool {
    if let Ok(pattern) = unsafe {
        element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
    } {
        if unsafe { pattern.Select() }.is_ok() {
            return true;
        }
    }
    let Some(wanted) = option.map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty()) else {
        return false;
    };
    // Expand combo/list if collapsible so children become selectable.
    if let Ok(expand) = unsafe {
        element.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId)
    } {
        let _ = unsafe { expand.Expand() };
    }
    let mut child_opt = unsafe { walker.GetFirstChildElement(element).ok() };
    let mut checked = 0usize;
    while let Some(child) = child_opt {
        if checked >= 128 {
            break;
        }
        checked += 1;
        let name = unsafe { child.CurrentName() }
            .ok()
            .map(|s| s.to_string().trim().to_ascii_lowercase())
            .unwrap_or_default();
        if name == wanted {
            if let Ok(sel) = unsafe {
                child.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                    UIA_SelectionItemPatternId,
                )
            } {
                if unsafe { sel.Select() }.is_ok() {
                    return true;
                }
            }
        }
        child_opt = unsafe { walker.GetNextSiblingElement(&child).ok() };
    }
    false
}

fn try_uia_set_value(element: &IUIAutomationElement, text: &str) -> bool {
    let Ok(pattern) =
        (unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) })
    else {
        return false;
    };
    if unsafe { pattern.CurrentIsReadOnly() }
        .map(|b| b.as_bool())
        .unwrap_or(true)
    {
        return false;
    }
    let bstr = BSTR::from(text);
    unsafe { pattern.SetValue(&bstr) }.is_ok()
}

fn try_uia_scroll(element: &IUIAutomationElement, dx: f64, dy: f64) -> bool {
    let Ok(pattern) =
        (unsafe { element.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId) })
    else {
        return false;
    };
    let amount = |delta: f64| -> ScrollAmount {
        if delta == 0.0 {
            ScrollAmount_NoAmount
        } else if delta >= 200.0 {
            ScrollAmount_LargeIncrement
        } else if delta > 0.0 {
            ScrollAmount_SmallIncrement
        } else if delta <= -200.0 {
            ScrollAmount_LargeDecrement
        } else {
            ScrollAmount_SmallDecrement
        }
    };
    unsafe { pattern.Scroll(amount(dx), amount(dy)) }.is_ok()
}

fn window_pid(hwnd: HWND) -> i32 {
    let mut pid: u32 = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    pid as i32
}

fn window_title(hwnd: HWND) -> String {
    let len = unsafe { GetWindowTextLengthW(hwnd) };
    if len <= 0 {
        return String::new();
    }
    let mut buf = vec![0u16; (len as usize) + 1];
    let written = unsafe { GetWindowTextW(hwnd, &mut buf) };
    if written <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..written as usize])
}

fn is_window_cloaked(hwnd: HWND) -> bool {
    let mut cloaked: u32 = 0;
    let res = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut c_void,
            size_of::<u32>() as u32,
        )
    };
    res.is_ok() && cloaked != 0
}

fn window_bounds(hwnd: HWND) -> Option<Rect> {
    let mut rect = RECT::default();
    let dwm_ok = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut c_void,
            size_of::<RECT>() as u32,
        )
        .is_ok()
    };
    if !dwm_ok && unsafe { GetWindowRect(hwnd, &mut rect) }.is_err() {
        return None;
    }
    Some(Rect {
        x: f64::from(rect.left),
        y: f64::from(rect.top),
        width: f64::from(rect.right - rect.left),
        height: f64::from(rect.bottom - rect.top),
    })
}

fn virtual_screen_rect() -> Result<Rect, DesktopError> {
    let x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    if width < 1 || height < 1 {
        return Err(DesktopError::Failed("virtual screen metrics unavailable".into()));
    }
    Ok(Rect {
        x: f64::from(x),
        y: f64::from(y),
        width: f64::from(width),
        height: f64::from(height),
    })
}

fn focus_window(hwnd: HWND) {
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        if GetForegroundWindow() != hwnd {
            let _ = AllowSetForegroundWindow(ASFW_ANY);
            let _ = SetForegroundWindow(hwnd);
            // Brief settle so subsequent SendInput lands in the focused window.
            thread::sleep(Duration::from_millis(35));
        }
    }
}

fn mouse_input(
    dx: i32,
    dy: i32,
    mouse_data: u32,
    flags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS,
) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: mouse_data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn vk_input(vk: u16, key_up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: 0,
                dwFlags: if key_up {
                    KEYEVENTF_KEYUP
                } else {
                    Default::default()
                },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn unicode_input(code_unit: u16, key_up: bool) -> INPUT {
    let flags = if key_up {
        KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
    } else {
        KEYEVENTF_UNICODE
    };
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: code_unit,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn send_inputs(inputs: &[INPUT]) -> Result<(), DesktopError> {
    if inputs.is_empty() {
        return Ok(());
    }
    let sent = unsafe { SendInput(inputs, size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        return Err(DesktopError::Failed(
            "SendInput was blocked (possibly by UIPI)".into(),
        ));
    }
    Ok(())
}

fn current_process_integrity_rid() -> Option<u32> {
    let process = unsafe { GetCurrentProcess() };
    token_integrity_rid(process)
}

fn token_integrity_rid(process: HANDLE) -> Option<u32> {
    let mut token = HANDLE::default();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }.is_err() {
        return None;
    }
    struct HandleGuard(HANDLE);
    impl Drop for HandleGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
    let _token_guard = HandleGuard(token);

    let mut needed: u32 = 0;
    let first = unsafe { GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut needed) };
    if first.is_ok() || needed == 0 {
        return None;
    }
    let err = windows::core::Error::from_thread();
    if err.code() != ERROR_INSUFFICIENT_BUFFER.to_hresult() {
        return None;
    }

    let mut buffer = vec![0u8; needed as usize];
    if unsafe {
        GetTokenInformation(
            token,
            TokenIntegrityLevel,
            Some(buffer.as_mut_ptr() as *mut c_void),
            needed,
            &mut needed,
        )
    }
    .is_err()
    {
        return None;
    }

    let label = unsafe { &*(buffer.as_ptr() as *const TOKEN_MANDATORY_LABEL) };
    let sid = label.Label.Sid;
    if sid.0.is_null() {
        return None;
    }
    let count_ptr = unsafe { GetSidSubAuthorityCount(sid) };
    if count_ptr.is_null() {
        return None;
    }
    let count = unsafe { *count_ptr };
    if count == 0 {
        return None;
    }
    let rid_ptr = unsafe { GetSidSubAuthority(sid, u32::from(count - 1)) };
    if rid_ptr.is_null() {
        return None;
    }
    Some(unsafe { *rid_ptr })
}

fn query_process_identity(pid: i32, own_integrity_rid: u32) -> (String, String, bool) {
    let handle = match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid as u32) } {
        Ok(h) => h,
        Err(_) => {
            // If we cannot even open PROCESS_QUERY_LIMITED_INFORMATION, the
            // process is typically protected/elevated; mark elevated so policy
            // refuses cleanly rather than failing mid-action.
            return (String::new(), String::new(), true);
        }
    };
    struct HandleGuard(HANDLE);
    impl Drop for HandleGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
    let _guard = HandleGuard(handle);

    let mut buf = vec![0u16; 512];
    let mut len = buf.len() as u32;
    let path = if unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
    }
    .is_ok()
    {
        String::from_utf16_lossy(&buf[..len as usize])
    } else {
        String::new()
    };
    let (app_name, app_key) = extract_process_names(&path);
    let elevated = token_integrity_rid(handle)
        .map(|rid| is_elevated_integrity_rid(rid, own_integrity_rid))
        .unwrap_or(false);
    (app_name, app_key, elevated)
}

fn parent_pid_windows(own_pid: u32) -> Option<u32> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.ok()?;
    struct HandleGuard(HANDLE);
    impl Drop for HandleGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
    let _guard = HandleGuard(snapshot);

    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    if unsafe { Process32FirstW(snapshot, &mut entry) }.is_err() {
        return None;
    }
    loop {
        if entry.th32ProcessID == own_pid {
            return Some(entry.th32ParentProcessID);
        }
        if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
            return None;
        }
    }
}
