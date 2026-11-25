mod activity;
mod db;
mod hittest;

use activity::{get_fullscreen_and_power, get_system_activity, get_user_idle_ms};
use db::*;
use hittest::{abort_physics, begin_drag, begin_fall, begin_flight, set_flight_target, end_flight, end_drag, set_drag_state, update_hit_rects, HitTester};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};
use tauri_plugin_autostart::ManagerExt;

#[tauri::command]
fn open_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(&app, "settings", tauri::WebviewUrl::App("settings.html".into()))
        .title("Diana Settings")
        .inner_size(480.0, 640.0)
        .min_inner_size(400.0, 500.0)
        .resizable(true)
        .decorations(true)
        .transparent(false)
        .shadow(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart(app: AppHandle, enable: bool) -> Result<(), String> {
    if enable {
        app.autolaunch().enable().map_err(|e| e.to_string())
    } else {
        app.autolaunch().disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn set_main_always_on_top(app: AppHandle, always_on_top: bool) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.set_always_on_top(always_on_top).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn is_debug_fast() -> bool {
    std::env::var("DIANA_DEBUG_FAST")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

#[tauri::command]
fn log_decision(app: AppHandle, entry: String) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("[{}] {}\n", now, entry);
    print!("{}", line);
    let _ = std::io::Write::flush(&mut std::io::stdout());

    // Resolve path in app_data_dir with fallback to CWD
    let log_path = match app.path().app_data_dir() {
        Ok(dir) => {
            let _ = std::fs::create_dir_all(&dir);
            dir.join("decisions.log")
        }
        Err(_) => std::path::PathBuf::from("decisions.log"),
    };

    // Size cap: Rotate when > 1 MB (1_048_576 bytes)
    if let Ok(meta) = std::fs::metadata(&log_path) {
        if meta.len() > 1_048_576 {
            let old_path = log_path.with_extension("log.old");
            let _ = std::fs::rename(&log_path, &old_path);
        }
    }

    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        use std::io::Write;
        let _ = file.write_all(line.as_bytes());
        let _ = file.flush();
    }
}

#[tauri::command]
fn update_tray_tooltip(app: AppHandle, tooltip: String) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_tooltip(Some(&tooltip));
    }
    Ok(())
}

fn toggle_visibility(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let now_visible = w.is_visible().unwrap_or(true);
        if now_visible {
            let _ = w.hide();
        } else {
            // Requirement A: before showing, validate position is on-screen.
            snap_to_floor_if_offscreen(app);
            let _ = w.show();
        }
        if let Some(hittest) = app.try_state::<HitTester>() {
            hittest.set_visible(!now_visible);
        }
        let _ = app.emit("pet-visible", !now_visible);
    }
}

/// Snap Diana to the primary monitor floor if she is off-screen.
/// Called before show() so she always reappears in a valid position.
fn snap_to_floor_if_offscreen(app: &AppHandle) {
    use tauri::Manager;
    let Some(w) = app.get_webview_window("main") else { return };
    let (pos, size, monitors) = match (w.outer_position(), w.outer_size(), w.available_monitors()) {
        (Ok(p), Ok(s), Ok(m)) => (p, s, m),
        _ => return,
    };

    // Check if window centre is inside any monitor's work area
    let cx = pos.x + size.width as i32 / 2;
    let cy = pos.y + size.height as i32 / 2;
    let on_screen = monitors.iter().any(|m| {
        let wa = m.work_area();
        cx >= wa.position.x
            && cx <= wa.position.x + wa.size.width as i32
            && cy >= wa.position.y
            && cy <= wa.position.y + wa.size.height as i32
    });

    if !on_screen {
        // Snap to primary monitor floor
        if let Some(primary) = monitors.iter()
            .find(|m| m.position().x == 0 && m.position().y == 0)
            .or_else(|| monitors.first())
        {
            let wa = primary.work_area();
            let floor_x = wa.position.x + wa.size.width as i32 / 2 - size.width as i32 / 2;
            let floor_y = wa.position.y + wa.size.height as i32 - size.height as i32;
            eprintln!(
                "[diana] snap_to_floor_if_offscreen: was ({},{}) off-screen -> snapping to ({},{})",
                pos.x, pos.y, floor_x, floor_y
            );
            let _ = w.set_position(tauri::PhysicalPosition::new(floor_x, floor_y));
        }
    }
}

/// Requirement B: "Bring Diana back" — unconditional rescue.
fn bring_diana_back(app: &AppHandle) {
    eprintln!("[diana] bring_diana_back: invoked");
    if let Some(hittest) = app.try_state::<HitTester>() {
        hittest.abort_physics();
    }
    if let Some(w) = app.get_webview_window("main") {
        // Reset to default size (240x328 physical px)
        // Use LogicalSize so the window restores to 240×328 CSS pixels
        // regardless of the DPI scale factor.
        let _ = w.set_size(tauri::LogicalSize::new(240.0_f64, 328.0_f64));

        // Snap to primary monitor floor using current window physical size
        if let Ok(monitors) = w.available_monitors() {
            let primary = monitors.iter()
                .find(|m| m.position().x == 0 && m.position().y == 0)
                .or_else(|| monitors.first());
            if let Some(mon) = primary {
                let wa = mon.work_area();
                // Get physical size (after set_size above applied LogicalSize)
                let phys_w = w.outer_size().map(|s| s.width as i32).unwrap_or(300);
                let phys_h = w.outer_size().map(|s| s.height as i32).unwrap_or(410);
                let floor_x = wa.position.x + wa.size.width as i32 / 2 - phys_w / 2;
                let floor_y = wa.position.y + wa.size.height as i32 - phys_h;
                eprintln!("[diana] bring_diana_back: placing at ({},{}) phys_size={}x{}", floor_x, floor_y, phys_w, phys_h);
                let _ = w.set_position(tauri::PhysicalPosition::new(floor_x, floor_y));
            }
        }
        let _ = w.show();
        let _ = w.set_ignore_cursor_events(false);
    }
    if let Some(hittest) = app.try_state::<HitTester>() {
        hittest.set_visible(true);
    }
    // Tell JS to reset to idle mode
    let _ = app.emit("bring-back", ());
    let _ = app.emit("pet-visible", true);
}

/// Requirement D: Automated self-test harness activated by DIANA_SELFTEST=1.
/// Writes PASS/FAIL report to {app_data_dir}/selftest.log and exits cleanly.
fn spawn_selftest(app: AppHandle) {
    std::thread::Builder::new()
        .name("diana-selftest".into())
        .spawn(move || {
            use std::io::Write;
            use std::time::Duration;

            let mut lines: Vec<String> = Vec::new();
            let mut all_ok = true;
            let mut record = |name: &str, ok: bool, detail: String| {
                let tag = if ok { "PASS" } else { "FAIL" };
                if !ok {
                    all_ok = false;
                }
                let msg = format!("[{}] {} — {}", tag, name, detail);
                eprintln!("[selftest] {}", msg);
                lines.push(msg);
            };

            // Give WebView / main.ts time to initialize startWatchdog() and placeInitially()
            std::thread::sleep(Duration::from_millis(2000));

            let Some(w) = app.get_webview_window("main") else {
                record("INIT", false, "main window missing".into());
                app.exit(1);
                return;
            };

            let monitors = w.available_monitors().unwrap_or_default();
            let in_any_wa = |px: i32, py: i32, pw: i32, ph: i32| -> bool {
                let cx = px + pw / 2;
                let cy = py + ph / 2;
                monitors.iter().any(|m| {
                    let wa = m.work_area();
                    cx >= wa.position.x
                        && cx <= wa.position.x + wa.size.width as i32
                        && cy >= wa.position.y
                        && cy <= wa.position.y + wa.size.height as i32
                })
            };

            // Test A: Requirement A (toggle_visibility / snap_to_floor_if_offscreen)
            let _ = w.set_position(tauri::PhysicalPosition::new(-20000_i32, 20000_i32));
            std::thread::sleep(Duration::from_millis(120));
            toggle_visibility(&app); // hide
            std::thread::sleep(Duration::from_millis(100));
            toggle_visibility(&app); // show -> calls snap_to_floor_if_offscreen
            std::thread::sleep(Duration::from_millis(200));
            let pos_a = w.outer_position().unwrap_or(tauri::PhysicalPosition::new(-99999, -99999));
            let size_a = w.outer_size().unwrap_or(tauri::PhysicalSize::new(0, 0));
            let vis_a = w.is_visible().unwrap_or(false);
            let ok_a = vis_a && in_any_wa(pos_a.x, pos_a.y, size_a.width as i32, size_a.height as i32);
            record(
                "REQ_A_OFFSCREEN_SHOW",
                ok_a,
                format!("visible={} pos=({},{}) size={}x{}", vis_a, pos_a.x, pos_a.y, size_a.width, size_a.height),
            );

            // Test B: Requirement B (bring_diana_back from bad pos + bad size)
            let _ = w.set_size(tauri::PhysicalSize::new(40_u32, 40_u32));
            let _ = w.set_position(tauri::PhysicalPosition::new(50000_i32, -20000_i32));
            std::thread::sleep(Duration::from_millis(120));
            bring_diana_back(&app);
            std::thread::sleep(Duration::from_millis(250));
            let pos_b = w.outer_position().unwrap_or(tauri::PhysicalPosition::new(-99999, -99999));
            let size_b = w.outer_size().unwrap_or(tauri::PhysicalSize::new(0, 0));
            let vis_b = w.is_visible().unwrap_or(false);
            let ok_b = vis_b
                && size_b.width >= 200
                && size_b.height >= 280
                && in_any_wa(pos_b.x, pos_b.y, size_b.width as i32, size_b.height as i32);
            record(
                "REQ_B_BRING_DIANA_BACK",
                ok_b,
                format!("visible={} pos=({},{}) size={}x{}", vis_b, pos_b.x, pos_b.y, size_b.width, size_b.height),
            );

            // Test C: Requirement C (monitor-union sanity check rejects insane positions)
            let reject_neg = !hittest::is_within_monitors_union(-20000, 20000, &monitors, 250);
            let reject_pos = !hittest::is_within_monitors_union(50000, 50000, &monitors, 250);
            let accept_valid = monitors.first().map(|m| {
                let wa = m.work_area();
                hittest::is_within_monitors_union(wa.position.x + 100, wa.position.y + 100, &monitors, 250)
            }).unwrap_or(false);
            let ht_idle = app.try_state::<HitTester>().map(|h| h.is_phys_idle()).unwrap_or(false);
            let ok_c = reject_neg && reject_pos && accept_valid && ht_idle;
            record(
                "REQ_C_DRAG_SANITY_CLAMP",
                ok_c,
                format!("reject_neg={} reject_pos={} accept_valid={} phys_idle={}", reject_neg, reject_pos, accept_valid, ht_idle),
            );

            // Test D: 2-second JS watchdog recovery from (-20000, 20000) without calling Rust snap
            let _ = w.set_position(tauri::PhysicalPosition::new(-20000_i32, 20000_i32));
            std::thread::sleep(Duration::from_millis(3200));
            let pos_d = w.outer_position().unwrap_or(tauri::PhysicalPosition::new(-99999, -99999));
            let size_d = w.outer_size().unwrap_or(tauri::PhysicalSize::new(0, 0));
            let ok_d = in_any_wa(pos_d.x, pos_d.y, size_d.width as i32, size_d.height as i32);
            record(
                "REQ_D_2S_WATCHDOG",
                ok_d,
                format!("pos=({},{}) size={}x{}", pos_d.x, pos_d.y, size_d.width, size_d.height),
            );

            let summary = if all_ok { "SELFTEST SUMMARY: ALL PASS" } else { "SELFTEST SUMMARY: FAILED" };
            lines.push(summary.to_string());
            eprintln!("[selftest] {}", summary);

            let log_path = match app.path().app_data_dir() {
                Ok(dir) => {
                    let _ = std::fs::create_dir_all(&dir);
                    dir.join("selftest.log")
                }
                Err(_) => std::path::PathBuf::from("selftest.log"),
            };
            if let Ok(mut f) = std::fs::File::create(&log_path) {
                for l in &lines {
                    let _ = writeln!(f, "{}", l);
                }
                let _ = f.flush();
            }
            app.exit(if all_ok { 0 } else { 1 });
        })
        .expect("failed to spawn selftest thread");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let hittest = HitTester::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(hittest)
        .invoke_handler(tauri::generate_handler![
            open_settings_window,
            get_autostart,
            set_autostart,
            set_main_always_on_top,
            is_debug_fast,
            log_decision,
            update_hit_rects,
            set_drag_state,
            begin_drag,
            end_drag,
            begin_fall,
            abort_physics,
            begin_flight,
            set_flight_target,
            end_flight,
            get_user_idle_ms,
            get_fullscreen_and_power,
            get_system_activity,
            db_get_mood,
            db_save_mood,
            db_get_setting,
            db_set_setting,
            db_get_all_settings,
            db_get_fact,
            db_set_fact,
            db_log_event,
            db_record_activity,
            db_get_stats_summary,
            db_reset_memory,
            db_import_local_storage,
            db_export_all,
            db_import_all,
            update_tray_tooltip,
        ])
        .setup(|app| {
            let db_state = db::DbState::new(app.handle())
                .map_err(Box::<dyn std::error::Error>::from)?;
            let initial_streak = db_state.get_streak();
            let tray_tooltip = format!("Diana — Day {}", initial_streak);

            app.manage(db_state);

            let ht = app.state::<HitTester>();
            ht.start_thread(app.handle().clone());
            let toggle = MenuItem::with_id(app, "toggle", "Show / Hide Diana", true, None::<&str>)?;
            let rescue = MenuItem::with_id(app, "rescue", "Bring Diana back 🔄", true, None::<&str>)?;
            let dnd = MenuItem::with_id(app, "dnd", "Do Not Disturb", true, None::<&str>)?;
            let dance = MenuItem::with_id(app, "dance", "Dance", true, None::<&str>)?;
            let sleep = MenuItem::with_id(app, "sleep", "Nap / Wake", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle, &rescue, &dnd, &dance, &sleep, &settings, &quit])?;

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip(&tray_tooltip)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "toggle" => toggle_visibility(app),
                    "rescue" => bring_diana_back(app),
                    "settings" => {
                        let _ = open_settings_window(app.clone());
                    }
                    id => {
                        let _ = app.emit("tray-action", id.to_string());
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_visibility(tray.app_handle());
                    }
                })
                .build(app)?;

            if std::env::var("DIANA_SELFTEST").map(|v| v == "1").unwrap_or(false) {
                spawn_selftest(app.handle().clone());
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Diana");
}
