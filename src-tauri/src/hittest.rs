// Diana physics thread: hit-testing, drag (floor-clamped), and gravity fall.
// The thread sleeps most of the time and only runs at ~60 Hz during drag/fall.

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

// ── Public data types ─────────────────────────────────────────────────────────

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

// ── Physics mode (shared via Mutex) ──────────────────────────────────────────

#[derive(Debug)]
enum PhysMode {
    Idle,
    Drag {
        offset_x: i32,
        offset_y: i32,
        floor_y: i32,
        win_h: i32,
        started: Instant,
    },
    Fall {
        vel_y: f64,
        floor_y: i32,
        win_h: i32,
        scale: f64,
    },
    Flight {
        floor_y: i32,
        win_h: i32,
        win_w: i32,
        scale: f64,
        started: Instant,
        /// Max flight duration before auto-retract
        max_ms: u64,
    },
}

/// Pure helper: returns true if (x, y) is within the union of all monitor work areas
/// plus a small edge margin (250 px) so edge-dragging stays smooth while far-off-screen
/// coordinates (e.g. -20000, +20000) are rejected.
pub fn is_within_monitors_union(x: i32, y: i32, monitors: &[tauri::Monitor], margin: i32) -> bool {
    if monitors.is_empty() {
        return x > -4000 && x < 16000 && y > -2000 && y < 16000;
    }
    let mut min_x = i32::MAX;
    let mut min_y = i32::MAX;
    let mut max_x = i32::MIN;
    let mut max_y = i32::MIN;
    for m in monitors {
        let wa = m.work_area();
        min_x = min_x.min(wa.position.x);
        min_y = min_y.min(wa.position.y);
        max_x = max_x.max(wa.position.x + wa.size.width as i32);
        max_y = max_y.max(wa.position.y + wa.size.height as i32);
    }
    x >= min_x - margin && x <= max_x + margin && y >= min_y - margin && y <= max_y + margin
}

// ── HitTester public API ──────────────────────────────────────────────────────

pub struct HitTester {
    hit_rects: Arc<Mutex<Vec<HitRect>>>,
    is_visible: Arc<AtomicBool>,
    phys_flag: Arc<AtomicU8>,
    phys_mode: Arc<Mutex<PhysMode>>,
    #[allow(dead_code)]
    floor_y: Arc<AtomicI32>,
    is_dragging: Arc<AtomicBool>,
    is_falling: Arc<AtomicBool>,
    last_valid_x: Arc<AtomicI32>,
    last_valid_y: Arc<AtomicI32>,
    // Flight target position (physical px), set by JS via set_flight_target
    flight_target_x: Arc<AtomicI32>,
    flight_target_y: Arc<AtomicI32>,
}

const PHYS_IDLE: u8 = 0;
const PHYS_DRAG: u8 = 1;
const PHYS_FALL: u8 = 2;
const PHYS_FLIGHT: u8 = 3;

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
            flight_target_x: Arc::new(AtomicI32::new(0)),
            flight_target_y: Arc::new(AtomicI32::new(0)),
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
            self.abort_physics();
        }
    }

    pub fn abort_physics(&self) {
        self.phys_flag.store(PHYS_IDLE, Ordering::Release);
        if let Ok(mut lock) = self.phys_mode.lock() {
            *lock = PhysMode::Idle;
        }
        self.is_dragging.store(false, Ordering::Relaxed);
        self.is_falling.store(false, Ordering::Relaxed);
    }

    pub fn is_phys_idle(&self) -> bool {
        self.phys_flag.load(Ordering::Acquire) == PHYS_IDLE
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
        let flight_target_x = Arc::clone(&self.flight_target_x);
        let flight_target_y = Arc::clone(&self.flight_target_y);

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
                    // Flight smooth position (sub-pixel accumulation)
                    let mut flight_x: f64 = 0.0;
                    let mut flight_y: f64 = 0.0;
                    let mut flight_vel_x: f64 = 0.0;
                    let mut flight_vel_y: f64 = 0.0;

                    loop {
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

                        // ── DRAG mode ─────────────────────────────────────────
                        if flag == PHYS_DRAG {
                            is_dragging.store(true, Ordering::Relaxed);
                            let _ = window.set_ignore_cursor_events(false);
                            last_ignored = Some(false);

                            let (offset_x, offset_y, floor_y, win_h, started) = {
                                let lock = phys_mode.lock().unwrap();
                                match &*lock {
                                    PhysMode::Drag {
                                        offset_x, offset_y, floor_y, win_h, started,
                                    } => (*offset_x, *offset_y, *floor_y, *win_h, *started),
                                    _ => { thread::sleep(Duration::from_millis(16)); continue; }
                                }
                            };

                            let timed_out = started.elapsed().as_secs() > 60;
                            let btn_down = unsafe {
                                (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16) & 0x8000 != 0
                            };

                            if timed_out || !btn_down {
                                let (wx, wy) = window.outer_position()
                                    .map(|p| (p.x, p.y)).unwrap_or((0, 0));
                                let above_floor = wy + win_h < floor_y;
                                phys_flag.store(PHYS_IDLE, Ordering::Release);
                                if let Ok(mut lock) = phys_mode.lock() { *lock = PhysMode::Idle; }
                                is_dragging.store(false, Ordering::Relaxed);
                                let _ = app.emit("drag-ended", DragEndedPayload {
                                    window_x: wx, window_y: wy, above_floor,
                                });
                                thread::sleep(Duration::from_millis(16));
                                continue;
                            }

                            let mut cursor = POINT::default();
                            if unsafe { GetCursorPos(&mut cursor).is_ok() } {
                                let new_x = cursor.x - offset_x;
                                let raw_y = cursor.y - offset_y;
                                let max_y = floor_y - win_h;
                                let new_y = raw_y.min(max_y);

                                // Sanity check (Req C): reject positions outside union of all monitor work areas (+250px margin)
                                let monitors = window.available_monitors().unwrap_or_default();
                                let sane = is_within_monitors_union(new_x, new_y, &monitors, 250);

                                if sane {
                                    last_valid_x.store(new_x, Ordering::Relaxed);
                                    last_valid_y.store(new_y, Ordering::Relaxed);
                                    if let Ok(hwnd) = window.hwnd() {
                                        unsafe {
                                            let _ = SetWindowPos(
                                                HWND(hwnd.0), None, new_x, new_y, 0, 0,
                                                SWP_NOACTIVATE | SWP_NOZORDER,
                                            );
                                        }
                                    }
                                } else {
                                    let lx = last_valid_x.load(Ordering::Relaxed);
                                    let ly = last_valid_y.load(Ordering::Relaxed);
                                    eprintln!(
                                        "[diana-physics] WARN: rejected drag pos ({},{}) outside monitor union — keeping ({},{}). cursor=({},{}) offset=({},{})",
                                        new_x, new_y, lx, ly, cursor.x, cursor.y, offset_x, offset_y
                                    );
                                    // Keep last valid position (don't teleport), end drag cleanly
                                    let above_floor = ly + win_h < floor_y;
                                    phys_flag.store(PHYS_IDLE, Ordering::Release);
                                    if let Ok(mut lock) = phys_mode.lock() { *lock = PhysMode::Idle; }
                                    is_dragging.store(false, Ordering::Relaxed);
                                    let _ = app.emit("drag-ended", DragEndedPayload {
                                        window_x: lx, window_y: ly, above_floor,
                                    });
                                }
                            }
                            thread::sleep(Duration::from_millis(16));
                            continue;
                        }

                        // ── FALL mode ─────────────────────────────────────────
                        if flag == PHYS_FALL {
                            is_dragging.store(false, Ordering::Relaxed);
                            is_falling.store(true, Ordering::Relaxed);
                            let _ = window.set_ignore_cursor_events(false);
                            last_ignored = Some(false);

                            let dt = 0.016_f64;
                            let (floor_y, win_h, _scale, new_vel) = {
                                let mut lock = phys_mode.lock().unwrap();
                                match &mut *lock {
                                    PhysMode::Fall { vel_y, floor_y, win_h, scale } => {
                                        let g = 2000.0 * *scale;
                                        let term = 1400.0 * *scale;
                                        *vel_y = (*vel_y + g * dt).min(term);
                                        (*floor_y, *win_h, *scale, *vel_y)
                                    }
                                    _ => { thread::sleep(Duration::from_millis(16)); continue; }
                                }
                            };

                            let dy = (new_vel * dt).round() as i32;
                            if let Ok(pos) = window.outer_position() {
                                let new_y = pos.y + dy;
                                let max_y = floor_y - win_h;
                                if new_y >= max_y {
                                    let _ = window.hwnd().map(|hwnd| unsafe {
                                        let _ = SetWindowPos(
                                            HWND(hwnd.0), None, pos.x, max_y, 0, 0,
                                            SWP_NOACTIVATE | SWP_NOZORDER,
                                        );
                                    });
                                    phys_flag.store(PHYS_IDLE, Ordering::Release);
                                    if let Ok(mut lock) = phys_mode.lock() { *lock = PhysMode::Idle; }
                                    is_falling.store(false, Ordering::Relaxed);
                                    let _ = app.emit("physics-landed", LandedPayload {
                                        window_x: pos.x, window_y: max_y,
                                    });
                                } else {
                                    let _ = window.hwnd().map(|hwnd| unsafe {
                                        let _ = SetWindowPos(
                                            HWND(hwnd.0), None, pos.x, new_y, 0, 0,
                                            SWP_NOACTIVATE | SWP_NOZORDER,
                                        );
                                    });
                                    last_emit_ticker = last_emit_ticker.wrapping_add(1);
                                    if last_emit_ticker % 6 == 0 {
                                        let _ = app.emit("physics-pos", serde_json::json!({
                                            "x": pos.x, "y": new_y, "vel_y": new_vel,
                                        }));
                                    }
                                }
                            }
                            thread::sleep(Duration::from_millis(16));
                            continue;
                        }

                        // ── FLIGHT mode (copter) ───────────────────────────────
                        if flag == PHYS_FLIGHT {
                            is_dragging.store(false, Ordering::Relaxed);
                            is_falling.store(false, Ordering::Relaxed);
                            let _ = window.set_ignore_cursor_events(false);
                            last_ignored = Some(false);

                            let (floor_y, win_h, win_w, scale, started, max_ms) = {
                                let lock = phys_mode.lock().unwrap();
                                match &*lock {
                                    PhysMode::Flight { floor_y, win_h, win_w, scale, started, max_ms } => {
                                        (*floor_y, *win_h, *win_w, *scale, *started, *max_ms)
                                    }
                                    _ => { thread::sleep(Duration::from_millis(16)); continue; }
                                }
                            };

                            // Auto-retract after max_ms
                            if started.elapsed().as_millis() as u64 >= max_ms {
                                phys_flag.store(PHYS_IDLE, Ordering::Release);
                                if let Ok(mut lock) = phys_mode.lock() { *lock = PhysMode::Idle; }
                                let pos = window.outer_position().map(|p| (p.x, p.y)).unwrap_or((0, 0));
                                let _ = app.emit("flight-ended", serde_json::json!({
                                    "window_x": pos.0, "window_y": pos.1, "reason": "timeout"
                                }));
                                thread::sleep(Duration::from_millis(16));
                                continue;
                            }

                            // Spring-ease toward flight target
                            let tx = flight_target_x.load(Ordering::Relaxed) as f64;
                            let ty = flight_target_y.load(Ordering::Relaxed) as f64;
                            let dt = 0.016_f64;

                            if let Ok(pos) = window.outer_position() {
                                // Init flight pos on first tick
                                if flight_x == 0.0 && flight_y == 0.0 {
                                    flight_x = pos.x as f64;
                                    flight_y = pos.y as f64;
                                    flight_target_x.store(pos.x, Ordering::Relaxed);
                                    flight_target_y.store(pos.y, Ordering::Relaxed);
                                }

                                // Spring: acc = k*(target-pos) - damping*vel, k=8, damping=0.85
                                let k = 8.0_f64;
                                let damp = 0.85_f64;
                                let ax = k * (tx - flight_x) - damp * flight_vel_x;
                                let ay = k * (ty - flight_y) - damp * flight_vel_y;
                                flight_vel_x += ax * dt;
                                flight_vel_y += ay * dt;
                                flight_x += flight_vel_x * dt;
                                flight_y += flight_vel_y * dt;

                                // Clamp above floor, within monitor X bounds
                                let min_y = -200_f64 * scale; // can go above taskbar
                                let max_y = (floor_y - win_h) as f64;
                                let min_x = -win_w as f64 / 2.0;
                                let max_x = 32000_f64; // generous right bound
                                flight_x = flight_x.clamp(min_x, max_x);
                                flight_y = flight_y.clamp(min_y, max_y);

                                let nx = flight_x.round() as i32;
                                let ny = flight_y.round() as i32;

                                if let Ok(hwnd) = window.hwnd() {
                                    unsafe {
                                        let _ = SetWindowPos(
                                            HWND(hwnd.0), None, nx, ny, 0, 0,
                                            SWP_NOACTIVATE | SWP_NOZORDER,
                                        );
                                    }
                                }

                                // Emit flight-tick at ~20Hz (every 3rd frame at 60Hz)
                                last_emit_ticker = last_emit_ticker.wrapping_add(1);
                                if last_emit_ticker % 3 == 0 {
                                    let _ = app.emit("flight-tick", serde_json::json!({
                                        "x": nx,
                                        "y": ny,
                                        "vel_x": flight_vel_x,
                                        "vel_y": flight_vel_y,
                                    }));
                                }
                            }
                            thread::sleep(Duration::from_millis(16));
                            continue;
                        }

                        // ── IDLE: normal hit-test ─────────────────────────────
                        is_dragging.store(false, Ordering::Relaxed);
                        is_falling.store(false, Ordering::Relaxed);
                        // Reset flight state so next flight starts fresh
                        flight_x = 0.0; flight_y = 0.0;
                        flight_vel_x = 0.0; flight_vel_y = 0.0;

                        let (win_pos, win_size, scale_factor) = match (
                            window.outer_position(),
                            window.outer_size(),
                            window.scale_factor(),
                        ) {
                            (Ok(p), Ok(s), Ok(sf)) => (p, s, sf),
                            _ => { thread::sleep(Duration::from_millis(100)); continue; }
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
                            if cursor_pt.x >= r_left && cursor_pt.x <= r_right
                                && cursor_pt.y >= r_top && cursor_pt.y <= r_bottom
                            {
                                hit = true; break;
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

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn update_hit_rects(state: tauri::State<HitTester>, rects: Vec<HitRect>) {
    state.set_rects(rects);
}

#[tauri::command]
pub fn set_drag_state(_state: tauri::State<HitTester>, _dragging: bool) {}

#[tauri::command]
pub fn begin_drag(
    app: AppHandle,
    state: tauri::State<HitTester>,
    offset_x: i32,
    offset_y: i32,
    floor_y: i32,
    win_h: i32,
) {
    if offset_x < -4000 || offset_x > 8000 || offset_y < -2000 || offset_y > 8000 {
        eprintln!(
            "[diana-physics] WARN: begin_drag rejected insane offset ({},{}) floor={} winH={}",
            offset_x, offset_y, floor_y, win_h
        );
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        if let Ok(pos) = w.outer_position() {
            state.last_valid_x.store(pos.x, Ordering::Relaxed);
            state.last_valid_y.store(pos.y, Ordering::Relaxed);
        }
    }
    let mut lock = state.phys_mode.lock().unwrap();
    *lock = PhysMode::Drag {
        offset_x, offset_y, floor_y, win_h, started: Instant::now(),
    };
    state.phys_flag.store(PHYS_DRAG, Ordering::Release);
}

#[tauri::command]
pub fn end_drag(app: AppHandle, state: tauri::State<HitTester>) {
    let flag = state.phys_flag.load(Ordering::Acquire);
    if flag != PHYS_DRAG { return; }
    let (win_h, floor_y) = {
        let lock = state.phys_mode.lock().unwrap();
        match &*lock {
            PhysMode::Drag { floor_y, win_h, .. } => (*floor_y, *win_h),
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
    if let Ok(mut lock) = state.phys_mode.lock() { *lock = PhysMode::Idle; }
    state.is_dragging.store(false, Ordering::Relaxed);
    let _ = app.emit("drag-ended", DragEndedPayload { window_x: wx, window_y: wy, above_floor });
}

#[tauri::command]
pub fn begin_fall(
    state: tauri::State<HitTester>,
    vel_y_initial: f64,
    floor_y: i32,
    win_h: i32,
    scale: f64,
) {
    let mut lock = state.phys_mode.lock().unwrap();
    *lock = PhysMode::Fall { vel_y: vel_y_initial, floor_y, win_h, scale };
    state.phys_flag.store(PHYS_FALL, Ordering::Release);
}

/// JS calls this after the deploy animation finishes to start real Rust-driven flight.
/// floor_y, win_h, win_w: physical pixels. max_ms: max flight duration.
#[tauri::command]
pub fn begin_flight(
    state: tauri::State<HitTester>,
    floor_y: i32,
    win_h: i32,
    win_w: i32,
    scale: f64,
    max_ms: u64,
) {
    let mut lock = state.phys_mode.lock().unwrap();
    *lock = PhysMode::Flight {
        floor_y, win_h, win_w, scale, started: Instant::now(), max_ms,
    };
    state.phys_flag.store(PHYS_FLIGHT, Ordering::Release);
}

/// JS calls this to update the copter's target position (physical px).
/// Can be called anytime during flight to redirect Diana.
#[tauri::command]
pub fn set_flight_target(state: tauri::State<HitTester>, x: i32, y: i32) {
    state.flight_target_x.store(x, Ordering::Relaxed);
    state.flight_target_y.store(y, Ordering::Relaxed);
}

/// End flight early (double-click during flight, DND, etc.).
#[tauri::command]
pub fn end_flight(app: AppHandle, state: tauri::State<HitTester>) {
    if state.phys_flag.load(Ordering::Acquire) != PHYS_FLIGHT { return; }
    state.phys_flag.store(PHYS_IDLE, Ordering::Release);
    if let Ok(mut lock) = state.phys_mode.lock() { *lock = PhysMode::Idle; }
    let pos = app.get_webview_window("main")
        .and_then(|w| w.outer_position().ok())
        .map(|p| (p.x, p.y))
        .unwrap_or((0, 0));
    let _ = app.emit("flight-ended", serde_json::json!({
        "window_x": pos.0, "window_y": pos.1, "reason": "early"
    }));
}

#[tauri::command]
pub fn abort_physics(state: tauri::State<HitTester>) {

    state.abort_physics();
}
