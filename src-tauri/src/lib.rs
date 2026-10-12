mod activity;
mod hittest;

use activity::{get_fullscreen_and_power, get_system_activity, get_user_idle_ms};
use hittest::{set_drag_state, update_hit_rects, HitTester};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

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
        .manage(hittest)
        .invoke_handler(tauri::generate_handler![
            update_hit_rects,
            set_drag_state,
            get_user_idle_ms,
            get_fullscreen_and_power,
            get_system_activity,
        ])
        .setup(|app| {
            let ht = app.state::<HitTester>();
            ht.start_thread(app.handle().clone());
            let toggle = MenuItem::with_id(app, "toggle", "Show / Hide Diana", true, None::<&str>)?;
            let dnd = MenuItem::with_id(app, "dnd", "Do Not Disturb", true, None::<&str>)?;
            let dance = MenuItem::with_id(app, "dance", "Dance", true, None::<&str>)?;
            let sleep = MenuItem::with_id(app, "sleep", "Nap / Wake", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle, &dnd, &dance, &sleep, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Diana")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "toggle" => toggle_visibility(app),
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
