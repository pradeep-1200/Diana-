use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoodRecord {
    pub energy: f64,
    pub happiness: f64,
    pub affection: f64,
    pub boredom: f64,
    pub last_seen: i64,
    pub total_pets: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FactRecord {
    pub key: String,
    pub value: String,
    pub source: String,
    pub updated_at: i64,
}

// Helper to convert YYYY-MM-DD into days since an arbitrary epoch (Gregorian)
fn parse_date_to_days(d: &str) -> Option<i64> {
    let parts: Vec<&str> = d.split('-').collect();
    if parts.len() != 3 {
        return None;
    }
    let y: i64 = parts[0].parse().ok()?;
    let m: i64 = parts[1].parse().ok()?;
    let day: i64 = parts[2].parse().ok()?;

    let m_adj = (m + 9) % 12;
    let y_adj = y - m_adj / 10;
    let days = 365 * y_adj + y_adj / 4 - y_adj / 100 + y_adj / 400 + (m_adj * 306 + 5) / 10 + (day - 1);
    Some(days)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatsSummary {
    pub streak_days: i64,
    pub total_pets: i64,
    pub total_active_minutes: i64,
    pub top_active_hours: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupData {
    pub mood: Option<MoodRecord>,
    pub settings: HashMap<String, String>,
    pub facts: Vec<FactRecord>,
    pub stats: Option<StatsSummary>,
}

pub struct DbState {
    pub conn: Mutex<Connection>,
}

impl DbState {
    pub fn get_streak(&self) -> i64 {
        if let Ok(conn) = self.conn.lock() {
            let mut stmt = match conn.prepare("SELECT DISTINCT date FROM daily_stats WHERE active_minutes > 0 ORDER BY date DESC;") {
                Ok(s) => s,
                Err(_) => return 1,
            };
            let dates: Vec<String> = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map(|rows| rows.filter_map(Result::ok).collect())
                .unwrap_or_default();

            let mut streak = 0i64;
            let mut prev_day: Option<i64> = None;
            for d in &dates {
                if let Some(cur) = parse_date_to_days(d) {
                    match prev_day {
                        None => {
                            streak = 1;
                            prev_day = Some(cur);
                        }
                        Some(p) => {
                            if p - cur == 1 {
                                streak += 1;
                                prev_day = Some(cur);
                            } else if p == cur {
                                continue;
                            } else {
                                break;
                            }
                        }
                    }
                }
            }
            streak.max(1)
        } else {
            1
        }
    }
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let app_dir: PathBuf = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get app data dir: {}", e))?;

        if !app_dir.exists() {
            fs::create_dir_all(&app_dir)
                .map_err(|e| format!("Failed to create app data dir: {}", e))?;
        }

        let db_path = app_dir.join("diana.db");
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("Failed to open SQLite database at {:?}: {}", db_path, e))?;

        // 1. Performance Pragmas (WAL mode + NORMAL synchronous)
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;",
        )
        .map_err(|e| format!("Failed to set PRAGMA: {}", e))?;

        // 2. Schema Migrations via user_version
        let version: i32 = conn
            .query_row("PRAGMA user_version;", [], |r| r.get(0))
            .unwrap_or(0);

        if version < 1 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS mood (
                    id INTEGER PRIMARY KEY CHECK(id=1),
                    energy REAL NOT NULL,
                    happiness REAL NOT NULL,
                    affection REAL NOT NULL,
                    boredom REAL NOT NULL,
                    last_seen INTEGER NOT NULL,
                    total_pets INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS facts (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    source TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts INTEGER NOT NULL,
                    type TEXT NOT NULL,
                    meta TEXT
                );

                CREATE TABLE IF NOT EXISTS daily_stats (
                    date TEXT PRIMARY KEY,
                    active_minutes INTEGER NOT NULL DEFAULT 0,
                    pets INTEGER NOT NULL DEFAULT 0,
                    sessions INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS hourly_activity (
                    hour INTEGER PRIMARY KEY,
                    minutes INTEGER NOT NULL DEFAULT 0,
                    days_seen INTEGER NOT NULL DEFAULT 0
                );

                PRAGMA user_version = 1;",
            )
            .map_err(|e| format!("Failed to run migration v1: {}", e))?;
        }

        // 3. Prune events older than 90 days
        let cutoff = now_millis() - (90 * 86_400 * 1000);
        let _ = conn.execute("DELETE FROM events WHERE ts < ?1;", params![cutoff]);

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}

// --- Tauri Commands ---

#[tauri::command]
pub fn db_get_mood(state: tauri::State<DbState>) -> Result<Option<MoodRecord>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT energy, happiness, affection, boredom, last_seen, total_pets FROM mood WHERE id = 1;")
        .map_err(|e| e.to_string())?;

    let mut rows = stmt
        .query_map([], |r| {
            Ok(MoodRecord {
                energy: r.get(0)?,
                happiness: r.get(1)?,
                affection: r.get(2)?,
                boredom: r.get(3)?,
                last_seen: r.get(4)?,
                total_pets: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;

    if let Some(first) = rows.next() {
        first.map(Some).map_err(|e| e.to_string())
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn db_save_mood(state: tauri::State<DbState>, mood: MoodRecord) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO mood (id, energy, happiness, affection, boredom, last_seen, total_pets)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
            energy = excluded.energy,
            happiness = excluded.happiness,
            affection = excluded.affection,
            boredom = excluded.boredom,
            last_seen = excluded.last_seen,
            total_pets = excluded.total_pets;",
        params![
            mood.energy,
            mood.happiness,
            mood.affection,
            mood.boredom,
            mood.last_seen,
            mood.total_pets,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_get_setting(state: tauri::State<DbState>, key: String) -> Result<Option<String>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT value FROM settings WHERE key = ?1;")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map(params![key], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;

    if let Some(first) = rows.next() {
        first.map(Some).map_err(|e| e.to_string())
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn db_set_setting(state: tauri::State<DbState>, key: String, value: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_get_all_settings(state: tauri::State<DbState>) -> Result<HashMap<String, String>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings;")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;

    let mut map = HashMap::new();
    for row in rows {
        let (k, v) = row.map_err(|e| e.to_string())?;
        map.insert(k, v);
    }
    Ok(map)
}

#[tauri::command]
pub fn db_get_fact(state: tauri::State<DbState>, key: String) -> Result<Option<FactRecord>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT key, value, source, updated_at FROM facts WHERE key = ?1;")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map(params![key], |r| {
            Ok(FactRecord {
                key: r.get(0)?,
                value: r.get(1)?,
                source: r.get(2)?,
                updated_at: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;

    if let Some(first) = rows.next() {
        first.map(Some).map_err(|e| e.to_string())
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn db_set_fact(
    state: tauri::State<DbState>,
    key: String,
    value: String,
    source: String,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let ts = now_millis();
    conn.execute(
        "INSERT INTO facts (key, value, source, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            source = excluded.source,
            updated_at = excluded.updated_at;",
        params![key, value, source, ts],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_log_event(
    state: tauri::State<DbState>,
    event_type: String,
    meta: Option<String>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let ts = now_millis();
    conn.execute(
        "INSERT INTO events (ts, type, meta) VALUES (?1, ?2, ?3);",
        params![ts, event_type, meta],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_record_activity(
    state: tauri::State<DbState>,
    date: String,
    hour: u32,
    active_mins: i32,
    pets: i32,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;

    // 1. Update daily_stats
    conn.execute(
        "INSERT INTO daily_stats (date, active_minutes, pets, sessions)
         VALUES (?1, ?2, ?3, 1)
         ON CONFLICT(date) DO UPDATE SET
            active_minutes = active_minutes + excluded.active_minutes,
            pets = pets + excluded.pets;",
        params![date, active_mins, pets],
    )
    .map_err(|e| e.to_string())?;

    // 2. Update hourly_activity (Amendment 1)
    conn.execute(
        "INSERT INTO hourly_activity (hour, minutes, days_seen)
         VALUES (?1, ?2, 1)
         ON CONFLICT(hour) DO UPDATE SET
            minutes = minutes + excluded.minutes;",
        params![hour, active_mins],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn db_get_stats_summary(state: tauri::State<DbState>) -> Result<StatsSummary, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;

    // 1. Total pets from mood table
    let total_pets: i64 = conn
        .query_row("SELECT total_pets FROM mood WHERE id = 1;", [], |r| r.get(0))
        .unwrap_or(0);

    // 2. Total active minutes
    let total_active_minutes: i64 = conn
        .query_row("SELECT COALESCE(SUM(active_minutes), 0) FROM daily_stats;", [], |r| r.get(0))
        .unwrap_or(0);

    // 3. Consecutive streak days
    let mut stmt = conn
        .prepare("SELECT DISTINCT date FROM daily_stats WHERE active_minutes > 0 ORDER BY date DESC;")
        .map_err(|e| e.to_string())?;
    let dates: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    let mut streak_days = 0i64;
    let mut prev_day_num: Option<i64> = None;

    for d in &dates {
        if let Some(cur_day_num) = parse_date_to_days(d) {
            match prev_day_num {
                None => {
                    streak_days = 1;
                    prev_day_num = Some(cur_day_num);
                }
                Some(prev) => {
                    if prev - cur_day_num == 1 {
                        streak_days += 1;
                        prev_day_num = Some(cur_day_num);
                    } else if prev == cur_day_num {
                        continue;
                    } else {
                        break;
                    }
                }
            }
        }
    }

    // 4. Top active hours
    let mut hour_stmt = conn
        .prepare("SELECT hour FROM hourly_activity WHERE minutes > 0 ORDER BY minutes DESC LIMIT 3;")
        .map_err(|e| e.to_string())?;
    let top_active_hours: Vec<u32> = hour_stmt
        .query_map([], |r| r.get::<_, u32>(0))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    Ok(StatsSummary {
        streak_days,
        total_pets,
        total_active_minutes,
        top_active_hours,
    })
}

#[tauri::command]
pub fn db_reset_memory(state: tauri::State<DbState>) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute_batch(
        "DELETE FROM facts;
         DELETE FROM events;
         DELETE FROM daily_stats;
         DELETE FROM hourly_activity;
         INSERT INTO mood (id, energy, happiness, affection, boredom, last_seen, total_pets)
         VALUES (1, 80.0, 60.0, 50.0, 20.0, 0, 0)
         ON CONFLICT(id) DO UPDATE SET
            energy = 80.0,
            happiness = 60.0,
            affection = 50.0,
            boredom = 20.0,
            last_seen = 0,
            total_pets = 0;",
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_import_local_storage(
    state: tauri::State<DbState>,
    mood: Option<MoodRecord>,
    pos: Option<String>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;

    // If mood is not already in sqlite, insert the local storage mood
    if let Some(m) = mood {
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM mood WHERE id = 1;", [], |r| r.get(0))
            .unwrap_or(0);
        if count == 0 {
            let _ = conn.execute(
                "INSERT INTO mood (id, energy, happiness, affection, boredom, last_seen, total_pets)
                 VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6);",
                params![m.energy, m.happiness, m.affection, m.boredom, m.last_seen, m.total_pets],
            );
        }
    }

    // If position is provided and not in settings, insert it
    if let Some(p) = pos {
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM settings WHERE key = 'window_pos';", [], |r| r.get(0))
            .unwrap_or(0);
        if count == 0 {
            let _ = conn.execute(
                "INSERT INTO settings (key, value) VALUES ('window_pos', ?1);",
                params![p],
            );
        }
    }

    Ok(())
}

#[tauri::command]
pub fn db_export_all(state: tauri::State<DbState>) -> Result<String, String> {
    let mood = db_get_mood(state.clone())?;
    let settings = db_get_all_settings(state.clone())?;
    let stats = db_get_stats_summary(state.clone()).ok();

    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT key, value, source, updated_at FROM facts;")
        .map_err(|e| e.to_string())?;
    let facts: Vec<FactRecord> = stmt
        .query_map([], |r| {
            Ok(FactRecord {
                key: r.get(0)?,
                value: r.get(1)?,
                source: r.get(2)?,
                updated_at: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    let backup = BackupData {
        mood,
        settings,
        facts,
        stats,
    };

    serde_json::to_string_pretty(&backup).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_import_all(state: tauri::State<DbState>, json: String) -> Result<(), String> {
    let backup: BackupData = serde_json::from_str(&json).map_err(|e| format!("Invalid backup JSON: {}", e))?;

    if let Some(m) = backup.mood {
        db_save_mood(state.clone(), m)?;
    }

    for (k, v) in backup.settings {
        db_set_setting(state.clone(), k, v)?;
    }

    for f in backup.facts {
        db_set_fact(state.clone(), f.key, f.value, f.source)?;
    }

    Ok(())
}
