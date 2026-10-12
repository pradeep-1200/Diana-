mod activity;
mod db;
mod hittest;

use activity::{get_fullscreen_and_power, get_system_activity, get_user_idle_ms};
use db::*;
use hittest::{set_drag_state, update_hit_rects, HitTester};
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

fn toggle_visibility(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let now_visible = w.is_visible().unwrap_or(true);
        if now_visible {
            let _ = w.hide();
        } else {
            let _ = w.show();
        }
        if let Some(hittest) = app.try_state::<HitTester>() {
            hittest.set_visible(!now_visible);
        }
        let _ = app.emit("pet-visible", !now_visible);
    }
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
            update_hit_rects,
            set_drag_state,
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
        ])
        .setup(|app| {
            let db_state = db::DbState::new(app.handle())
                .map_err(Box::<dyn std::error::Error>::from)?;
            app.manage(db_state);

            let ht = app.state::<HitTester>();
            ht.start_thread(app.handle().clone());
            let toggle = MenuItem::with_id(app, "toggle", "Show / Hide Diana", true, None::<&str>)?;
            let dnd = MenuItem::with_id(app, "dnd", "Do Not Disturb", true, None::<&str>)?;
            let dance = MenuItem::with_id(app, "dance", "Dance", true, None::<&str>)?;
            let sleep = MenuItem::with_id(app, "sleep", "Nap / Wake", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle, &dnd, &dance, &sleep, &settings, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Diana")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "toggle" => toggle_visibility(app),
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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Diana");
}
