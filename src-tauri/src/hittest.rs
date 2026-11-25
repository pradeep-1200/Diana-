use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Copy, serde::Deserialize, serde::Serialize)]
pub struct HitRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub struct HitTester {
    hit_rects: Arc<Mutex<Vec<HitRect>>>,
    is_dragging: Arc<AtomicBool>,
    is_visible: Arc<AtomicBool>,
}

impl Default for HitTester {
    fn default() -> Self {
        Self::new()
    }
}

impl HitTester {
    pub fn new() -> Self {
        Self {
            hit_rects: Arc::new(Mutex::new(Vec::new())),
            is_dragging: Arc::new(AtomicBool::new(false)),
            is_visible: Arc::new(AtomicBool::new(true)),
        }
    }

    pub fn set_rects(&self, rects: Vec<HitRect>) {
        if let Ok(mut lock) = self.hit_rects.lock() {
            *lock = rects;
        }
    }

    pub fn set_dragging(&self, dragging: bool) {
        self.is_dragging.store(dragging, Ordering::Relaxed);
    }

    pub fn set_visible(&self, visible: bool) {
        self.is_visible.store(visible, Ordering::Relaxed);
    }

    pub fn start_thread(&self, app: AppHandle) {
        let hit_rects = Arc::clone(&self.hit_rects);
        let is_dragging = Arc::clone(&self.is_dragging);
        let is_visible = Arc::clone(&self.is_visible);

        thread::Builder::new()
            .name("diana-hittest".into())
            .spawn(move || {
                #[cfg(windows)]
                {
                    use windows::Win32::Foundation::POINT;
                    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

                    let mut last_ignored = false;

                    loop {
                        // If hidden, suspend polling
                        if !is_visible.load(Ordering::Relaxed) {
                            thread::sleep(Duration::from_millis(500));
                            continue;
                        }

                        let Some(window) = app.get_webview_window("main") else {
                            thread::sleep(Duration::from_millis(500));
                            continue;
                        };

                        // While dragging, never ignore cursor events
                        if is_dragging.load(Ordering::Relaxed) {
                            if last_ignored {
                                let _ = window.set_ignore_cursor_events(false);
                                last_ignored = false;
                            }
                            thread::sleep(Duration::from_millis(100));
                            continue;
                        }

                        // Read window outer position and size fresh on every poll
                        let (win_pos, win_size, scale_factor) = match (
                            window.outer_position(),
                            window.outer_size(),
                            window.scale_factor(),
                        ) {
                            (Ok(p), Ok(s), Ok(sf)) => (p, s, sf),
                            _ => {
                                thread::sleep(Duration::from_millis(100));
                                continue;
                            }
                        };

                        let mut cursor_pt = POINT::default();
                        let cursor_ok = unsafe { GetCursorPos(&mut cursor_pt).is_ok() };
                        if !cursor_ok {
                            thread::sleep(Duration::from_millis(100));
                            continue;
                        }

                        let near_margin = (100.0 * scale_factor) as i32;
                        let win_left = win_pos.x;
                        let win_top = win_pos.y;
                        let win_right = win_pos.x + win_size.width as i32;
                        let win_bottom = win_pos.y + win_size.height as i32;

                        let is_near = cursor_pt.x >= win_left - near_margin
                            && cursor_pt.x <= win_right + near_margin
                            && cursor_pt.y >= win_top - near_margin
                            && cursor_pt.y <= win_bottom + near_margin;

                        let rects = hit_rects.lock().map(|g| g.clone()).unwrap_or_default();
                        let mut hit = false;

                        for r in &rects {
                            let r_left = win_left + (r.x * scale_factor).round() as i32;
                            let r_top = win_top + (r.y * scale_factor).round() as i32;
                            let r_right = r_left + (r.width * scale_factor).round() as i32;
                            let r_bottom = r_top + (r.height * scale_factor).round() as i32;

                            if cursor_pt.x >= r_left
                                && cursor_pt.x <= r_right
                                && cursor_pt.y >= r_top
                                && cursor_pt.y <= r_bottom
                            {
                                hit = true;
                                break;
                            }
                        }

                        let should_ignore = !hit;
                        if should_ignore != last_ignored {
                            let _ = window.set_ignore_cursor_events(should_ignore);
                            last_ignored = should_ignore;
                        }

                        let sleep_ms = if is_near { 50 } else { 300 };
                        thread::sleep(Duration::from_millis(sleep_ms));
                    }
                }
            })
            .expect("failed to spawn hit-test thread");
    }
}

#[tauri::command]
pub fn update_hit_rects(state: tauri::State<HitTester>, rects: Vec<HitRect>) {
    state.set_rects(rects);
}

#[tauri::command]
pub fn set_drag_state(state: tauri::State<HitTester>, dragging: bool) {
    state.set_dragging(dragging);
}
