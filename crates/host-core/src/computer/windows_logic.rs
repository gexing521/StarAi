//! Platform-independent Windows UI Automation and Win32 mapping logic.
//!
//! Kept outside `#[cfg(target_os = "windows")]` so key-chord parsing, UIA
//! control-type/pattern mapping, virtual-desktop coordinate normalization,
//! elevation comparison, and process-name extraction are unit-tested on every
//! host OS.

#![allow(dead_code)]

use super::{ActionKind, Rect};

// Standard Win32 Virtual-Key codes (winuser.h).
pub(crate) const VK_BACK: u16 = 0x08;
pub(crate) const VK_TAB: u16 = 0x09;
pub(crate) const VK_RETURN: u16 = 0x0D;
pub(crate) const VK_SHIFT: u16 = 0x10;
pub(crate) const VK_CONTROL: u16 = 0x11;
pub(crate) const VK_MENU: u16 = 0x12; // Alt
pub(crate) const VK_ESCAPE: u16 = 0x1B;
pub(crate) const VK_SPACE: u16 = 0x20;
pub(crate) const VK_PRIOR: u16 = 0x21; // Page Up
pub(crate) const VK_NEXT: u16 = 0x22; // Page Down
pub(crate) const VK_END: u16 = 0x23;
pub(crate) const VK_HOME: u16 = 0x24;
pub(crate) const VK_LEFT: u16 = 0x25;
pub(crate) const VK_UP: u16 = 0x26;
pub(crate) const VK_RIGHT: u16 = 0x27;
pub(crate) const VK_DOWN: u16 = 0x28;
pub(crate) const VK_DELETE: u16 = 0x2E;

/// One parsed Windows key chord: ordered modifier virtual keys plus one main key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WindowsKeyChord {
    pub modifiers: Vec<u16>,
    pub key: u16,
}

/// Map a normalized chord like `ctrl+a` or `shift+tab` onto Win32 virtual keys.
///
/// The accepted set is intentionally narrow: OS-shell modifiers (`win`, `super`,
/// `meta`, `cmd`) and secure-attention sequences (`ctrl+alt+delete`) are refused
/// so a model cannot escape the granted window via system shortcuts.
pub(crate) fn parse_chord(chord: &str) -> Option<WindowsKeyChord> {
    let mut has_ctrl = false;
    let mut has_shift = false;
    let mut has_alt = false;
    let mut key: Option<u16> = None;

    for part in chord.split('+') {
        let token = part.trim().to_ascii_lowercase();
        match token.as_str() {
            "" => return None,
            "ctrl" | "control" => has_ctrl = true,
            "shift" => has_shift = true,
            "alt" | "option" | "opt" => has_alt = true,
            // Explicitly refuse OS shell / macOS-only modifiers on Windows.
            "win" | "windows" | "super" | "meta" | "cmd" | "command" => return None,
            other => {
                if key.is_some() {
                    return None;
                }
                key = virtual_key(other);
                key?;
            }
        }
    }

    let key = key?;
    // Never allow Secure Attention Sequence or Alt+F4 (F4 is already rejected,
    // and Ctrl+Alt+Delete is guarded explicitly as defense in depth).
    if has_ctrl && has_alt && key == VK_DELETE {
        return None;
    }

    let mut modifiers = Vec::new();
    if has_ctrl {
        modifiers.push(VK_CONTROL);
    }
    if has_alt {
        modifiers.push(VK_MENU);
    }
    if has_shift {
        modifiers.push(VK_SHIFT);
    }
    Some(WindowsKeyChord { modifiers, key })
}

pub(crate) fn virtual_key(name: &str) -> Option<u16> {
    if name.len() == 1 {
        let byte = name.as_bytes()[0];
        if byte.is_ascii_lowercase() {
            return Some(u16::from(byte.to_ascii_uppercase()));
        }
        if byte.is_ascii_digit() {
            return Some(u16::from(byte));
        }
    }
    let code = match name {
        "return" | "enter" => VK_RETURN,
        "tab" => VK_TAB,
        "space" => VK_SPACE,
        "backspace" => VK_BACK,
        "delete" | "del" => VK_DELETE,
        "escape" | "esc" => VK_ESCAPE,
        "left" => VK_LEFT,
        "up" => VK_UP,
        "right" => VK_RIGHT,
        "down" => VK_DOWN,
        "home" => VK_HOME,
        "end" => VK_END,
        "pageup" | "page_up" | "pgup" => VK_PRIOR,
        "pagedown" | "page_down" | "pgdn" => VK_NEXT,
        _ => return None,
    };
    Some(code)
}

/// Capabilities exposed by a UI Automation element during tree inspection.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct UiaPatternFlags {
    pub invoke: bool,
    pub toggle: bool,
    pub selection_item: bool,
    pub expand_collapse: bool,
    pub value: bool,
    pub value_read_only: bool,
    pub scroll: bool,
    pub is_password: bool,
}

/// Map UIA pattern availability onto our platform-neutral `ActionKind` list.
pub(crate) fn supported_actions(
    flags: UiaPatternFlags,
    control_type_id: i32,
    enabled: bool,
    has_bounds: bool,
) -> Vec<ActionKind> {
    if !enabled {
        return Vec::new();
    }
    let mut actions = Vec::new();
    let clickable_role = matches!(
        control_type_id,
        50000 // Button
        | 50002 // CheckBox
        | 50003 // ComboBox
        | 50005 // Hyperlink
        | 50007 // ListItem
        | 50011 // MenuItem
        | 50013 // RadioButton
        | 50019 // TabItem
        | 50024 // TreeItem
        | 50029 // DataItem
        | 50031 // SplitButton
    );
    if flags.invoke || flags.toggle || flags.expand_collapse || (clickable_role && has_bounds) {
        actions.push(ActionKind::Click);
    }
    if flags.selection_item {
        if !actions.contains(&ActionKind::Click) {
            actions.push(ActionKind::Click);
        }
        actions.push(ActionKind::Select);
    }
    // Editable text controls (Edit=50004, Document=50030) or writable ValuePattern.
    let editable_role = matches!(control_type_id, 50004 | 50030);
    if !flags.is_password && ((flags.value && !flags.value_read_only) || (editable_role && has_bounds)) {
        actions.push(ActionKind::SetValue);
    }
    if flags.scroll {
        actions.push(ActionKind::Scroll);
    }
    actions
}

/// Map standard `UIA_*ControlTypeId` values (UIAutomationClient.h) onto concise
/// role names.
pub(crate) fn uia_control_type_role(control_type_id: i32) -> &'static str {
    match control_type_id {
        50000 => "Button",
        50001 => "Calendar",
        50002 => "CheckBox",
        50003 => "ComboBox",
        50004 => "Edit",
        50005 => "Hyperlink",
        50006 => "Image",
        50007 => "ListItem",
        50008 => "List",
        50009 => "Menu",
        50010 => "MenuBar",
        50011 => "MenuItem",
        50012 => "ProgressBar",
        50013 => "RadioButton",
        50014 => "ScrollBar",
        50015 => "Slider",
        50016 => "Spinner",
        50017 => "StatusBar",
        50018 => "Tab",
        50019 => "TabItem",
        50020 => "Text",
        50021 => "ToolBar",
        50022 => "ToolTip",
        50023 => "Tree",
        50024 => "TreeItem",
        50025 => "Custom",
        50026 => "Group",
        50027 => "Thumb",
        50028 => "DataGrid",
        50029 => "DataItem",
        50030 => "Document",
        50031 => "SplitButton",
        50032 => "Window",
        50033 => "Pane",
        50034 => "Header",
        50035 => "HeaderItem",
        50036 => "Table",
        50037 => "TitleBar",
        50038 => "Separator",
        50039 => "SemanticZoom",
        50040 => "AppBar",
        _ => "Unknown",
    }
}

/// Convert a physical screen coordinate `(x, y)` into the `[0, 65535]` range
/// expected by `SendInput` with `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`.
///
/// Works with negative coordinates when secondary monitors sit left of or above
/// the primary monitor.
pub(crate) fn normalize_virtual_desktop_coord(
    x: f64,
    y: f64,
    virtual_screen: Rect,
) -> Option<(i32, i32)> {
    if !x.is_finite()
        || !y.is_finite()
        || !virtual_screen.width.is_finite()
        || !virtual_screen.height.is_finite()
        || virtual_screen.width < 1.0
        || virtual_screen.height < 1.0
    {
        return None;
    }
    let denom_x = (virtual_screen.width - 1.0).max(1.0);
    let denom_y = (virtual_screen.height - 1.0).max(1.0);
    let nx = (((x - virtual_screen.x) * 65_535.0) / denom_x)
        .round()
        .clamp(0.0, 65_535.0) as i32;
    let ny = (((y - virtual_screen.y) * 65_535.0) / denom_y)
        .round()
        .clamp(0.0, 65_535.0) as i32;
    Some((nx, ny))
}

/// Convert a logical scroll delta into Win32 `MOUSEEVENTF_WHEEL` units.
///
/// Positive `dy` scrolls down in the model's convention (matching web/macOS
/// viewport scrolling), whereas Win32 `WHEEL_DELTA` (+120) scrolls *up*, so
/// vertical deltas are inverted here.
pub(crate) fn vertical_wheel_delta(dy: f64) -> i32 {
    if !dy.is_finite() || dy == 0.0 {
        return 0;
    }
    let steps = (dy / 40.0).clamp(-10.0, 10.0);
    let ticks = if steps.abs() < 1.0 {
        steps.signum()
    } else {
        steps.round()
    };
    -(ticks as i32) * 120
}

pub(crate) fn horizontal_wheel_delta(dx: f64) -> i32 {
    if !dx.is_finite() || dx == 0.0 {
        return 0;
    }
    let steps = (dx / 40.0).clamp(-10.0, 10.0);
    let ticks = if steps.abs() < 1.0 {
        steps.signum()
    } else {
        steps.round()
    };
    (ticks as i32) * 120
}

/// UIPI blocks a process from sending input to a window owned by a higher
/// integrity level (e.g., Medium -> High / System).
pub(crate) fn is_elevated_integrity_rid(target_rid: u32, own_rid: u32) -> bool {
    target_rid > own_rid
}

/// Extract `(app_name, app_key)` from a Windows executable path.
///
/// `app_key` keeps the lowercase `.exe` basename so it matches built-in
/// Windows credential denylist entries like `credentialuibroker.exe` and
/// `consent.exe`. `app_name` strips the `.exe` suffix for display.
pub(crate) fn extract_process_names(full_path: &str) -> (String, String) {
    let trimmed = full_path.trim();
    let file_name = trimmed
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("")
        .trim();
    if file_name.is_empty() {
        return (String::new(), String::new());
    }
    let app_key = file_name.to_ascii_lowercase();
    let app_name = file_name
        .strip_suffix(".exe")
        .or_else(|| file_name.strip_suffix(".EXE"))
        .unwrap_or(file_name)
        .to_string();
    (app_name, app_key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_chords_accept_safe_keys_and_refuse_shell_escapes() {
        assert_eq!(
            parse_chord("ctrl+a"),
            Some(WindowsKeyChord {
                modifiers: vec![VK_CONTROL],
                key: b'A' as u16,
            })
        );
        assert_eq!(
            parse_chord("Shift+Tab"),
            Some(WindowsKeyChord {
                modifiers: vec![VK_SHIFT],
                key: VK_TAB,
            })
        );
        assert_eq!(
            parse_chord("ctrl+shift+v"),
            Some(WindowsKeyChord {
                modifiers: vec![VK_CONTROL, VK_SHIFT],
                key: b'V' as u16,
            })
        );
        assert_eq!(
            parse_chord("enter"),
            Some(WindowsKeyChord {
                modifiers: vec![],
                key: VK_RETURN,
            })
        );

        for forbidden in [
            "",
            "ctrl",
            "ctrl+",
            "ctrl+a+b",
            "win+r",
            "win+l",
            "super+d",
            "cmd+a",
            "meta+space",
            "ctrl+alt+delete",
            "alt+f4",
            "f13",
        ] {
            assert!(
                parse_chord(forbidden).is_none(),
                "should refuse chord: {forbidden}"
            );
        }
    }

    #[test]
    fn virtual_desktop_normalization_supports_negative_monitors() {
        let virtual_screen = Rect {
            x: -1920.0,
            y: 0.0,
            width: 3840.0,
            height: 1080.0,
        };
        assert_eq!(
            normalize_virtual_desktop_coord(-1920.0, 0.0, virtual_screen),
            Some((0, 0))
        );
        assert_eq!(
            normalize_virtual_desktop_coord(1919.0, 1079.0, virtual_screen),
            Some((65_535, 65_535))
        );
        let (mid_x, mid_y) =
            normalize_virtual_desktop_coord(0.0, 540.0, virtual_screen).expect("midpoint");
        assert!((mid_x - 32_776).abs() <= 20, "unexpected mid_x={mid_x}");
        assert!((mid_y - 32_798).abs() <= 40, "unexpected mid_y={mid_y}");
    }

    #[test]
    fn uia_patterns_map_to_actions_and_protect_passwords() {
        let edit_actions = supported_actions(
            UiaPatternFlags {
                value: true,
                value_read_only: false,
                ..Default::default()
            },
            50004,
            true,
            true,
        );
        assert!(edit_actions.contains(&ActionKind::SetValue));

        let password_actions = supported_actions(
            UiaPatternFlags {
                value: true,
                value_read_only: false,
                is_password: true,
                ..Default::default()
            },
            50004,
            true,
            true,
        );
        assert!(
            !password_actions.contains(&ActionKind::SetValue),
            "password fields must not advertise SetValue"
        );

        let button_actions = supported_actions(
            UiaPatternFlags {
                invoke: true,
                ..Default::default()
            },
            50000,
            true,
            true,
        );
        assert_eq!(button_actions, vec![ActionKind::Click]);
    }

    #[test]
    fn process_name_extraction_preserves_exe_in_app_key() {
        assert_eq!(
            extract_process_names(r"C:\Windows\System32\CredentialUIBroker.exe"),
            ("CredentialUIBroker".into(), "credentialuibroker.exe".into())
        );
        assert_eq!(
            extract_process_names(r"C:\Program Files\StarAI\StarAI.exe"),
            ("StarAI".into(), "starai.exe".into())
        );
    }

    #[test]
    fn elevation_comparison_flags_higher_integrity() {
        const MEDIUM_RID: u32 = 0x2000;
        const HIGH_RID: u32 = 0x3000;
        assert!(!is_elevated_integrity_rid(MEDIUM_RID, MEDIUM_RID));
        assert!(is_elevated_integrity_rid(HIGH_RID, MEDIUM_RID));
    }

    #[test]
    fn wheel_deltas_invert_vertical_direction_for_win32() {
        assert!(vertical_wheel_delta(120.0) < 0, "positive dy scrolls down (negative Win32 wheel)");
        assert!(vertical_wheel_delta(-120.0) > 0, "negative dy scrolls up (positive Win32 wheel)");
        assert_eq!(vertical_wheel_delta(0.0), 0);
        assert!(horizontal_wheel_delta(80.0) > 0);
    }
}
