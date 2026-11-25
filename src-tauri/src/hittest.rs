// Diana physics thread: hit-testing, drag (floor-clamped), and gravity fall.
// The thread sleeps most of the time and only runs at ~60 Hz during drag/fall.

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

// â”€â”€ Public data types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

#[derive(Debug, Clone, Copy, serde::Deserialize, serde::Serialize)]
pub struct HitRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DragEndedPayload {
    pub window_x: i32,
    pub window_y: i32,
    pub above_floor: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LandedPayload {
    pub window_x: i32,
    pub window_y: i32,
}

// â”€â”€ Physics mode (shared via Mutex) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

#[derive(Debug)]
enum PhysMode {
    Idle,
    Drag {
        offset_x: i32,  // cursor_x - window_x at grab time (physical px)
        offset_y: i32,  // cursor_y - window_y at grab time
        floor_y: i32,   // max window bottom edge (physical px)
        win_h: i32,     // physical window height
        started: Instant,
    },
    Fall {
        vel_y: f64,    // physical px/s, positive = down
        floor_y: i32,  // max window bottom edge (physical px)
        win_h: i32,
        scale: f64,    // DPI scale factor, for gravity constant
    },
}

// â”€â”€ HitTester public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

pub struct HitTester {
    hit_rects: Arc<Mutex<Vec<HitRect>>>,
    is_visible: Arc<AtomicBool>,
    // PHYS_MODE_FLAG: 0=Idle, 1=Drag, 2=Fall
    phys_flag: Arc<AtomicU8>,
    phys_mode: Arc<Mutex<PhysMode>>,
    // Shared floor_y so JS can update without replacing the whole mode
    #[allow(dead_code)]
    floor_y: Arc<AtomicI32>,
    // Set by Rust when dragging is active (mirrors is_dragging for hit-test)
    is_dragging: Arc<AtomicBool>,
    // Set when falling: suppress normal hit-rect filtering (always hittable)
    is_falling: Arc<AtomicBool>,
    // Last known-valid window position (physical px), updated each drag tick
    last_valid_x: Arc<AtomicI32>,
    last_valid_y: Arc<AtomicI32>,
}

const PHYS_IDLE: u8 = 0;
const PHYS_DRAG: u8 = 1;
const PHYS_FALL: u8 = 2;

impl Default for HitTester {
    fn default() -> Self {
        Self::new()
    }
}

impl HitTester {
    pub fn new() -> Self {
        Self {
            hit_rects: Arc::new(Mutex::new(Vec::new())),
            is_visible: Arc::new(AtomicBool::new(true)),
            phys_flag: Arc::new(AtomicU8::new(PHYS_IDLE)),
            phys_mode: Arc::new(Mutex::new(PhysMode::Idle)),
            floor_y: Arc::new(AtomicI32::new(i32::MAX)),
            is_dragging: Arc::new(AtomicBool::new(false)),
            is_falling: Arc::new(AtomicBool::new(false)),
            last_valid_x: Arc::new(AtomicI32::new(0)),
            last_valid_y: Arc::new(AtomicI32::new(0)),
        }
    }

    pub fn set_rects(&self, rects: Vec<HitRect>) {
        if let Ok(mut lock) = self.hit_rects.lock() {
            *lock = rects;
        }
    }

    pub fn set_visible(&self, visible: bool) {
        self.is_visible.store(visible, Ordering::Relaxed);
        if !visible {
            // Abort any active physics immediately
            self.abort_physics();
        }
    }

    /// Abort drag/fall silently (hide/DND path â€” JS will place Diana on floor itself).
    pub fn abort_physics(&self) {
        self.phys_flag.store(PHYS_IDLE, Ordering::Release);
        if let Ok(mut lock) = self.phys_mode.lock() {
            *lock = PhysMode::Idle;
        }
        self.is_dragging.store(false, Ordering::Relaxed);
        self.is_falling.store(false, Ordering::Relaxed);
    }

    pub fn start_thread(&self, app: AppHandle) {
        let hit_rects = Arc::clone(&self.hit_rects);
        let is_visible = Arc::clone(&self.is_visible);
        let phys_flag = Arc::clone(&self.phys_flag);
        let phys_mode = Arc::clone(&self.phys_mode);
        let is_dragging = Arc::clone(&self.is_dragging);
        let is_falling = Arc::clone(&self.is_falling);
        let last_valid_x = Arc::clone(&self.last_valid_x);
        let last_valid_y = Arc::clone(&self.last_valid_y);

        thread::Builder::new()
            .name("diana-physics".into())
            .spawn(move || {
                #[cfg(windows)]
                {
                    use windows::Win32::Foundation::{HWND, POINT};
                    use windows::Win32::UI::Input::KeyboardAndMouse::{
                        GetAsyncKeyState, VK_LBUTTON,
                    };
                    use windows::Win32::UI::WindowsAndMessaging::{
                        GetCursorPos, SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER,
                    };

                    let mut last_ignored: Option<bool> = None;
                    let mut last_emit_ticker: u32 = 0;

                    loop {
                        // â”€â”€ Visibility gate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
                        if !is_visible.load(Ordering::Relaxed) {
                            thread::sleep(Duration::from_millis(500));
                            last_ignored = None;
                            continue;
                        }

                        let Some(window) = app.get_webview_window("main") else {
                            thread::sleep(Duration::from_millis(500));
                            continue;
                        };

                        let flag = phys_flag.load(Ordering::Acquire);

                        // â”€â”€ DRAG mode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
                        if flag == PHYS_DRAG {
                            is_dragging.store(true, Ordering::Relaxed);
                            let _ = window.set_ignore_cursor_events(false);
                            last_ignored = Some(false);

                            // Read drag params
                            let (offset_x, offset_y, floor_y, win_h, started) = {
                                let lock = phys_mode.lock().unwrap();
                                match &*lock {
                                    PhysMode::Drag {
                                        offset_x,
                                        offset_y,
                                        floor_y,
                                        win_h,
                                        started,
                                    } => (*offset_x, *offset_y, *floor_y, *win_h, *started),
                                    _ => {
                                        thread::sleep(Duration::from_millis(16));
                                        continue;
                                    }
                                }
                            };

                            // Failsafe: max 60 s
                            let timed_out = started.elapsed().as_secs() > 60;

                            // Check mouse button via Win32 (Rust-side release detection)
                            let btn_down =
                                unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16) & 0x8000 != 0 };

                            if timed_out || !btn_down {
                                // End drag â€” read current window position
                                let (wx, wy) = window
                                    .outer_position()
                                    .map(|p| (p.x, p.y))
                                    .unwrap_or((0, 0));
                                let above_floor = wy + win_h < floor_y;

                                phys_flag.store(PHYS_IDLE, Ordering::Release);
                                if let Ok(mut lock) = phys_mode.lock() {
                                    *lock = PhysMode::Idle;
                                }
                                is_dragging.store(false, Ordering::Relaxed);

                                let _ = app.emit(
                                    "drag-ended",
                                    DragEndedPayload {
                                        window_x: wx,
                                        window_y: wy,
                                        above_floor,
                                    },
                                );
                                thread::sleep(Duration::from_millis(16));
                                continue;
                            }

                            // Move window: cursor - grab offset, clamped to floor
                            let mut cursor = POINT::default();
                            if unsafe { GetCursorPos(&mut cursor).is_ok() } {
                                let new_x = cursor.x - offset_x;
                                let raw_y = cursor.y - offset_y;
                                let max_y = floor_y - win_h;
                                let new_y = raw_y.min(max_y);

                                // â”€â”€ Requirement C: sanity check drag position â”€â”€
                                // Reject wildly out-of-bounds positions (e.g. off all monitors).
                                // A simple guard: x must be within [-8000, 32000], y within [-2000, 32000].
                                // This catches the logicalâ†’physical pixel mismatch causing x=-15000 etc.
                                let sane = new_x > -8000 && new_x < 32000
                                    && new_y > -2000 && new_y < 32000;

                                if sane {
                                    last_valid_x.store(new_x, Ordering::Relaxed);
                                    last_valid_y.store(new_y, Ordering::Relaxed);

                                    if let Ok(hwnd) = window.hwnd() {
                                        unsafe {
                                            let _ = SetWindowPos(
                                                HWND(hwnd.0),
                                                None,
                                                new_x,
                                                new_y,
                                                0,
                                                0,
                                                SWP_NOACTIVATE | SWP_NOZORDER,
                                            );
                                        }
                                    }
                                } else {
                                    // Reject: position is insane â€” keep last valid pos
                                    let lx = last_valid_x.load(Ordering::Relaxed);
                                    let ly = last_valid_y.load(Ordering::Relaxed);
                                    eprintln!(
                                        "[diana-physics] WARN: rejected drag pos ({},{}) â€” keeping last valid ({},{}). cursor=({},{}) offset=({},{})",
                                        new_x, new_y, lx, ly, cursor.x, cursor.y, offset_x, offset_y
                                    );
                                    // End drag cleanly to prevent repeated badness
                                    let above_floor = ly + win_h < floor_y;
                                    phys_flag.store(PHYS_IDLE, Ordering::Release);
                                    if let Ok(mut lock) = phys_mode.lock() {
                                        *lock = PhysMode::Idle;
                                    }
                                    is_dragging.store(false, Ordering::Relaxed);
                                    let _ = app.emit(
                                        "drag-ended",
                                        DragEndedPayload {
                                            window_x: lx,
                                            window_y: ly,
                                            above_floor,
                                        },
                                    );
                                }
                            }

                            thread::sleep(Duration::from_millis(16));
                            continue;
                        }

                        // â”€â”€ FALL mode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
                        if flag == PHYS_FALL {
                            is_dragging.store(false, Ordering::Relaxed);
                            is_falling.store(true, Ordering::Relaxed);
                            let _ = window.set_ignore_cursor_events(false);
                            last_ignored = Some(false);

                            let dt = 0.016_f64;

                            let (floor_y, win_h, _scale, new_vel) = {
                                let mut lock = phys_mode.lock().unwrap();
                                match &mut *lock {
                                    PhysMode::Fall {
                                        vel_y,
                                        floor_y,
                                        win_h,
                                        scale,
                                    } => {
                                        // Gravity: 2000 logical px/sÂ² Ã— scale = physical px/sÂ²
                                        let g = 2000.0 * *scale;
                                        // Terminal velocity: 1400 logical px/s
                                        let term = 1400.0 * *scale;
                                        *vel_y = (*vel_y + g * dt).min(term);
                                        (*floor_y, *win_h, *scale, *vel_y)
                                    }
                                    _ => {
                                        thread::sleep(Duration::from_millis(16));
                                        continue;
                                    }
                                }
                            };

                            let dy = (new_vel * dt).round() as i32;

                            if let Ok(pos) = window.outer_position() {
                                let new_y = pos.y + dy;
                                let max_y = floor_y - win_h;

                                if new_y >= max_y {
                                    // Landed
                                    let _ = window.hwnd().map(|hwnd| unsafe {
                                        let _ = SetWindowPos(
                                            HWND(hwnd.0),
                                            None,
                                            pos.x,
                                            max_y,
                                            0,
                                            0,
                                            SWP_NOACTIVATE | SWP_NOZORDER,
                                        );
                                    });

                                    phys_flag.store(PHYS_IDLE, Ordering::Release);
                                    if let Ok(mut lock) = phys_mode.lock() {
                                        *lock = PhysMode::Idle;
                                    }
                                    is_falling.store(false, Ordering::Relaxed);

                                    let _ = app.emit(
                                        "physics-landed",
                                        LandedPayload {
                                            window_x: pos.x,
                                            window_y: max_y,
                                        },
                                    );
                                } else {
                                    let _ = window.hwnd().map(|hwnd| unsafe {
                                        let _ = SetWindowPos(
                                            HWND(hwnd.0),
                                            None,
                                            pos.x,
                                            new_y,
                                            0,
                                            0,
                                            SWP_NOACTIVATE | SWP_NOZORDER,
                                        );
                                    });

                                    // Emit position to JS at ~10 Hz (every 6th frame)
                                    last_emit_ticker = last_emit_ticker.wrapping_add(1);
                                    if last_emit_ticker % 6 == 0 {
                                        let _ = app.emit(
                                            "physics-pos",
                                            serde_json::json!({
                                                "x": pos.x,
                                                "y": new_y,
                                                "vel_y": new_vel,
                                            }),
                                        );
                                    }
                                }
                            }

                            thread::sleep(Duration::from_millis(16));
                            continue;
                        }

                        // â”€â”€ IDLE: normal hit-test â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
                        is_dragging.store(false, Ordering::Relaxed);
                        is_falling.store(false, Ordering::Relaxed);

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
                        if unsafe { GetCursorPos(&mut cursor_pt).is_err() } {
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
                        if last_ignored != Some(should_ignore) {
                            let _ = window.set_ignore_cursor_events(should_ignore);
                            last_ignored = Some(should_ignore);
                        }

                        let sleep_ms = if is_near { 50 } else { 300 };
                        thread::sleep(Duration::from_millis(sleep_ms));
                    }
                }
            })
            .expect("failed to spawn physics thread");
    }
}

// â”€â”€ Tauri commands â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

#[tauri::command]
pub fn update_hit_rects(state: tauri::State<HitTester>, rects: Vec<HitRect>) {
    state.set_rects(rects);
}

/// Legacy no-op â€” kept so existing JS `set_drag_state` call compiles without
/// changes until input.ts is updated in this commit.
#[tauri::command]
pub fn set_drag_state(_state: tauri::State<HitTester>, _dragging: bool) {}

/// JS calls this when the user begins a drag.
/// offset_x/offset_y: cursor position relative to the window's top-left corner
/// (physical pixels). floor_y: bottom of the work area (physical px).
/// win_h: current physical window height.
#[tauri::command]
pub fn begin_drag(
    state: tauri::State<HitTester>,
    offset_x: i32,
    offset_y: i32,
    floor_y: i32,
    win_h: i32,
) {
    // Guard: reject clearly insane offsets (would cause teleport)
    if offset_x < -4000 || offset_x > 8000 || offset_y < -2000 || offset_y > 8000 {
        eprintln!(
            "[diana-physics] WARN: begin_drag rejected insane offset ({},{}) floor={} winH={}",
            offset_x, offset_y, floor_y, win_h
        );
        return;
    }
    let mut lock = state.phys_mode.lock().unwrap();
    *lock = PhysMode::Drag {
        offset_x,
        offset_y,
        floor_y,
        win_h,
        started: Instant::now(),
    };
    state.phys_flag.store(PHYS_DRAG, Ordering::Release);
}

/// JS can call this to end the drag early (e.g. pointerup was received in JS
/// before Rust detected it). Rust will still emit "drag-ended".
/// Safe to call even if already ended.
#[tauri::command]
pub fn end_drag(app: AppHandle, state: tauri::State<HitTester>) {
    let flag = state.phys_flag.load(Ordering::Acquire);
    if flag != PHYS_DRAG {
        return;
    }
    let (win_h, floor_y) = {
        let lock = state.phys_mode.lock().unwrap();
        match &*lock {
            PhysMode::Drag {
                floor_y, win_h, ..
            } => (*floor_y, *win_h),
            _ => return,
        }
    };

    let (wx, wy) = app
        .get_webview_window("main")
        .and_then(|w| w.outer_position().ok())
        .map(|p| (p.x, p.y))
        .unwrap_or((0, 0));

    let above_floor = wy + win_h < floor_y;

    state.phys_flag.store(PHYS_IDLE, Ordering::Release);
    if let Ok(mut lock) = state.phys_mode.lock() {
        *lock = PhysMode::Idle;
    }
    state.is_dragging.store(false, Ordering::Relaxed);

    let _ = app.emit(
        "drag-ended",
        DragEndedPayload {
            window_x: wx,
            window_y: wy,
            above_floor,
        },
    );
}

/// JS calls this to start free-fall from current window position.
/// vel_y_initial: starting downward velocity (physical px/s), usually 0.
/// floor_y: bottom of work area (physical px). scale: DPI scale factor.
#[tauri::command]
pub fn begin_fall(
    state: tauri::State<HitTester>,
    vel_y_initial: f64,
    floor_y: i32,
    win_h: i32,
    scale: f64,
) {
    let mut lock = state.phys_mode.lock().unwrap();
    *lock = PhysMode::Fall {
        vel_y: vel_y_initial,
        floor_y,
        win_h,
        scale,
    };
    state.phys_flag.store(PHYS_FALL, Ordering::Release);
}

/// Abort any active physics (hide / DND / fullscreen path).
/// JS must place Diana on the floor itself after calling this.
#[tauri::command]
pub fn abort_physics(state: tauri::State<HitTester>) {
    state.abort_physics();
}
