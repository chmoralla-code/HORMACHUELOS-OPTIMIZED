//! Click-through desktop overlay events for Desktop Computer Use.
//!
//! Visuals live in the `computer-fx` WebView. This module never sends typed
//! characters across the event boundary.

use serde::Serialize;
use std::sync::OnceLock;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseFxEvent {
    pub kind: String,
    pub x: i32,
    pub y: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub char_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_chars: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gesture: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta_x: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta_y: Option<i32>,
}

static FX_EMITTER: OnceLock<Box<dyn Fn(ComputerUseFxEvent) + Send + Sync>> = OnceLock::new();

pub fn install_emitter(emitter: impl Fn(ComputerUseFxEvent) + Send + Sync + 'static) {
    let _ = FX_EMITTER.set(Box::new(emitter));
}

pub fn emit(event: ComputerUseFxEvent) {
    if let Some(emitter) = FX_EMITTER.get() {
        emitter(event);
    }
}

fn overlay_point(screen_x: i32, screen_y: i32) -> (i32, i32) {
    let (origin_x, origin_y, _, _) = overlay_bounds();
    (screen_x - origin_x, screen_y - origin_y)
}

pub fn overlay_bounds() -> (i32, i32, u32, u32) {
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
            SM_YVIRTUALSCREEN,
        };
        unsafe {
            let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let width = GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1) as u32;
            let height = GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1) as u32;
            (x, y, width, height)
        }
    }
    #[cfg(not(windows))]
    {
        (0, 0, 1, 1)
    }
}

fn event(kind: &str, screen_x: i32, screen_y: i32, gesture: Option<&str>) -> ComputerUseFxEvent {
    let (x, y) = overlay_point(screen_x, screen_y);
    ComputerUseFxEvent {
        kind: kind.into(),
        x,
        y,
        text: None,
        char_index: None,
        total_chars: None,
        gesture: gesture.map(str::to_string),
        width: None,
        height: None,
        delta_x: None,
        delta_y: None,
    }
}

pub fn approach(x: i32, y: i32) {
    emit(event("approach", x, y, Some("approach")));
}

pub fn hover(x: i32, y: i32) {
    emit(event("hover", x, y, Some("hover")));
}

pub fn cursor_move(x: i32, y: i32) {
    emit(event("cursor_move", x, y, Some("approach")));
}

pub fn press(x: i32, y: i32) {
    emit(event("press", x, y, Some("press")));
}

pub fn click(x: i32, y: i32, button: &str) {
    let mut payload = event("click", x, y, Some("click"));
    payload.text = Some(button.to_string());
    emit(payload);
}

pub fn key(x: i32, y: i32) {
    emit(event("key", x, y, Some("key")));
}

pub fn scroll(x: i32, y: i32, delta_x: i32, delta_y: i32) {
    let mut payload = event("scroll", x, y, Some("scroll"));
    payload.delta_x = Some(delta_x);
    payload.delta_y = Some(delta_y);
    emit(payload);
}

pub fn drag(from_x: i32, from_y: i32, to_x: i32, to_y: i32) {
    let mut payload = event("drag", to_x, to_y, Some("drag"));
    payload.text = Some(format!("{from_x},{from_y}"));
    emit(payload);
}

pub fn target(x: i32, y: i32, width: i32, height: i32) {
    let mut payload = event("target", x, y, Some("hover"));
    payload.width = Some(width.max(1));
    payload.height = Some(height.max(1));
    emit(payload);
}

fn private_typing_event(
    kind: &str,
    x: i32,
    y: i32,
    _typed_text: &str,
    char_index: u32,
    total_chars: u32,
) -> ComputerUseFxEvent {
    let mut payload = event(kind, x, y, Some("type"));
    payload.text = None;
    payload.char_index = Some(char_index);
    payload.total_chars = Some(total_chars);
    payload
}

pub fn type_char(x: i32, y: i32, preview: &str, char_index: u32, total_chars: u32) {
    emit(private_typing_event(
        "type_char",
        x,
        y,
        preview,
        char_index,
        total_chars,
    ));
}

pub fn type_done(x: i32, y: i32, text: &str, total_chars: u32) {
    emit(private_typing_event(
        "type_done",
        x,
        y,
        text,
        total_chars.saturating_sub(1),
        total_chars,
    ));
}

pub fn clear() {
    emit(ComputerUseFxEvent {
        kind: "clear".into(),
        x: 0,
        y: 0,
        text: None,
        char_index: None,
        total_chars: None,
        gesture: None,
        width: None,
        height: None,
        delta_x: None,
        delta_y: None,
    });
}

#[cfg(test)]
mod tests {
    use super::private_typing_event;

    const SENTINEL_SECRET: &str = "typed-secret-SENTINEL-9f0c2d";

    #[test]
    fn typing_fx_never_serializes_typed_content() {
        for event in [
            private_typing_event("type_char", 10, 20, SENTINEL_SECRET, 3, 24),
            private_typing_event("type_done", 10, 20, SENTINEL_SECRET, 23, 24),
        ] {
            let payload = serde_json::to_string(&event).expect("typing event should serialize");
            assert!(!payload.contains(SENTINEL_SECRET));
            assert!(event.text.is_none());
            assert_eq!(event.total_chars, Some(24));
            assert_eq!(event.gesture.as_deref(), Some("type"));
        }
    }
}
