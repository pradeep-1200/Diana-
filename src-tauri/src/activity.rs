#[cfg(windows)]
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
#[cfg(windows)]
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
#[cfg(windows)]
use windows::Win32::UI::Shell::{
    SHQueryUserNotificationState, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
};

#[cfg(windows)]
extern "system" {
    fn GetTickCount() -> u32;
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct FullscreenAndPower {
    pub is_fullscreen: bool,
    pub is_charging: bool,
    pub battery_percent: Option<u8>,
    pub notification_state: u32,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SystemActivity {
    pub idle_ms: u64,
    pub is_fullscreen: bool,
    pub is_charging: bool,
    pub battery_percent: Option<u8>,
    pub notification_state: u32,
}

#[tauri::command]
pub fn get_user_idle_ms() -> u64 {
    #[cfg(windows)]
    {
        let mut lii = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        let ok = unsafe { GetLastInputInfo(&mut lii) };
        if ok.as_bool() {
            let now = unsafe { GetTickCount() };
            return now.wrapping_sub(lii.dwTime) as u64;
        }
    }
    0
}

#[tauri::command]
pub fn get_fullscreen_and_power() -> FullscreenAndPower {
    #[cfg(windows)]
    {
        // 1. Fullscreen state
        let (is_fullscreen, notification_state) = match unsafe { SHQueryUserNotificationState() } {
            Ok(state) => {
                let fs = matches!(
                    state,
                    QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE
                );
                (fs, state.0 as u32)
            }
            Err(_) => (false, 0),
        };

        // 2. Battery / Power state
        let mut sps = SYSTEM_POWER_STATUS::default();
        let (is_charging, battery_percent) = match unsafe { GetSystemPowerStatus(&mut sps) } {
            Ok(_) => {
                let charging = sps.ACLineStatus == 1;
                let percent = if sps.BatteryLifePercent <= 100 {
                    Some(sps.BatteryLifePercent)
                } else {
                    None
                };
                (charging, percent)
            }
            Err(_) => (false, None),
        };

        return FullscreenAndPower {
            is_fullscreen,
            is_charging,
            battery_percent,
            notification_state,
        };
    }

    #[allow(unreachable_code)]
    FullscreenAndPower {
        is_fullscreen: false,
        is_charging: true,
        battery_percent: None,
        notification_state: 0,
    }
}

#[tauri::command]
pub fn get_system_activity() -> SystemActivity {
    let idle_ms = get_user_idle_ms();
    let fp = get_fullscreen_and_power();
    SystemActivity {
        idle_ms,
        is_fullscreen: fp.is_fullscreen,
        is_charging: fp.is_charging,
        battery_percent: fp.battery_percent,
        notification_state: fp.notification_state,
    }
}
