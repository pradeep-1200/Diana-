// Tauri API and OS window interaction wrappers

import {
  getCurrentWindow,
  currentMonitor,
  primaryMonitor,
  availableMonitors,
  PhysicalPosition,
  PhysicalSize,
  Monitor,
} from "@tauri-apps/api/window";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { Menu, MenuOptions } from "@tauri-apps/api/menu";
import { invoke } from "@tauri-apps/api/core";

export const win = getCurrentWindow();

export interface WorkAreaBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
}

export async function getMonitor(): Promise<Monitor | null> {
  return await currentMonitor();
}

export async function getPrimaryMonitor(): Promise<Monitor | null> {
  return await primaryMonitor();
}

export async function getAllMonitors(): Promise<Monitor[]> {
  return await availableMonitors();
}

export async function getCurrentWorkArea(): Promise<WorkAreaBounds | null> {
  const mon = (await currentMonitor()) || (await primaryMonitor());
  if (!mon) return null;
  const wa = mon.workArea ?? { position: mon.position, size: mon.size };
  return {
    x: wa.position.x,
    y: wa.position.y,
    width: wa.size.width,
    height: wa.size.height,
    scaleFactor: mon.scaleFactor,
  };
}

export async function getWindowPosition(): Promise<{ x: number; y: number }> {
  const pos = await win.outerPosition();
  return { x: pos.x, y: pos.y };
}

export async function setWindowPosition(x: number, y: number): Promise<void> {
  await win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
}

export async function getWindowSize(): Promise<{ width: number; height: number }> {
  const size = await win.outerSize();
  return { width: size.width, height: size.height };
}

export async function setWindowSize(width: number, height: number): Promise<void> {
  await win.setSize(new PhysicalSize(Math.round(width), Math.round(height)));
}

export async function getScaleFactor(): Promise<number> {
  return await win.scaleFactor();
}

export async function startDragging(): Promise<void> {
  await win.startDragging();
}

export async function hideWindow(): Promise<void> {
  await win.hide();
}

export async function showWindow(): Promise<void> {
  await win.show();
}

export async function closeWindow(): Promise<void> {
  await win.close();
}

export async function focusWindow(): Promise<void> {
  await win.setFocus();
}

export function onWindowMoved(cb: () => void): () => void {
  let unlisten: UnlistenFn | undefined;
  win.onMoved(() => cb()).then((fn) => {
    unlisten = fn;
  });
  return () => {
    unlisten?.();
  };
}

export function saveLocalPosition(x: number, y: number) {
  try {
    localStorage.setItem("diana.pos", JSON.stringify({ x, y }));
  } catch {}
}

export function loadLocalPosition(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem("diana.pos");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function onTrayAction(handler: (action: string) => void): Promise<UnlistenFn> {
  return await listen<string>("tray-action", (e) => handler(e.payload));
}

export async function onPetVisible(handler: (visible: boolean) => void): Promise<UnlistenFn> {
  return await listen<boolean>("pet-visible", (e) => handler(e.payload));
}

export async function showNativeContextMenu(items: NonNullable<MenuOptions["items"]>): Promise<void> {
  const menu = await Menu.new({ items });
  await menu.popup();
}

export interface HitRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function updateHitRects(rects: HitRect[]): Promise<void> {
  try {
    await invoke("update_hit_rects", { rects });
  } catch (err) {
    console.warn("Failed to update hit rects:", err);
  }
}

export async function setDragState(dragging: boolean): Promise<void> {
  try {
    await invoke("set_drag_state", { dragging });
  } catch (err) {
    console.warn("Failed to set drag state:", err);
  }
}

export async function getUserIdleMs(): Promise<number> {
  try {
    return await invoke<number>("get_user_idle_ms");
  } catch {
    return 0;
  }
}

export interface FullscreenAndPower {
  is_fullscreen: boolean;
  is_charging: boolean;
  battery_percent: number | null;
}

export async function getFullscreenAndPower(): Promise<FullscreenAndPower> {
  try {
    return await invoke<FullscreenAndPower>("get_fullscreen_and_power");
  } catch {
    return { is_fullscreen: false, is_charging: true, battery_percent: null };
  }
}

export interface MoodRecord {
  energy: number;
  happiness: number;
  affection: number;
  boredom: number;
  last_seen: number;
  total_pets: number;
}

export interface FactRecord {
  key: string;
  value: string;
  source: string;
  updated_at: number;
}

export interface StatsSummary {
  streak_days: number;
  total_pets: number;
  total_active_minutes: number;
  top_active_hours: number[];
}

export async function dbGetMood(): Promise<MoodRecord | null> {
  try {
    return await invoke<MoodRecord | null>("db_get_mood");
  } catch {
    return null;
  }
}

export async function dbSaveMood(mood: MoodRecord): Promise<void> {
  try {
    await invoke("db_save_mood", { mood });
  } catch (err) {
    console.warn("db_save_mood failed:", err);
  }
}

export async function dbGetSetting(key: string): Promise<string | null> {
  try {
    return await invoke<string | null>("db_get_setting", { key });
  } catch {
    return null;
  }
}

export async function dbSetSetting(key: string, value: string): Promise<void> {
  try {
    await invoke("db_set_setting", { key, value });
  } catch (err) {
    console.warn("db_set_setting failed:", err);
  }
}

export async function dbGetAllSettings(): Promise<Record<string, string>> {
  try {
    return await invoke<Record<string, string>>("db_get_all_settings");
  } catch {
    return {};
  }
}

export async function dbGetFact(key: string): Promise<FactRecord | null> {
  try {
    return await invoke<FactRecord | null>("db_get_fact", { key });
  } catch {
    return null;
  }
}

export async function dbSetFact(key: string, value: string, source: string): Promise<void> {
  try {
    await invoke("db_set_fact", { key, value, source });
  } catch (err) {
    console.warn("db_set_fact failed:", err);
  }
}

export async function dbLogEvent(eventType: string, meta?: string): Promise<void> {
  try {
    await invoke("db_log_event", { eventType, meta: meta ?? null });
  } catch (err) {
    console.warn("db_log_event failed:", err);
  }
}

export async function dbRecordActivity(
  date: string,
  hour: number,
  activeMins: number,
  pets: number
): Promise<void> {
  try {
    await invoke("db_record_activity", { date, hour, activeMins, pets });
  } catch (err) {
    console.warn("db_record_activity failed:", err);
  }
}

export async function dbGetStatsSummary(): Promise<StatsSummary> {
  try {
    return await invoke<StatsSummary>("db_get_stats_summary");
  } catch {
    return { streak_days: 0, total_pets: 0, total_active_minutes: 0, top_active_hours: [] };
  }
}

export async function dbResetMemory(): Promise<void> {
  try {
    await invoke("db_reset_memory");
  } catch (err) {
    console.warn("db_reset_memory failed:", err);
  }
}

export async function dbImportLocalStorage(mood?: MoodRecord | null, pos?: string | null): Promise<void> {
  try {
    await invoke("db_import_local_storage", { mood: mood ?? null, pos: pos ?? null });
  } catch (err) {
    console.warn("db_import_local_storage failed:", err);
  }
}

export async function openSettingsWindow(): Promise<void> {
  try {
    await invoke("open_settings_window");
  } catch (err) {
    console.warn("open_settings_window failed:", err);
  }
}

export async function onSettingScale(handler: (scale: number) => void): Promise<UnlistenFn> {
  return await listen<number>("setting-scale", (e) => handler(e.payload));
}

export async function onSettingWander(handler: (enabled: boolean) => void): Promise<UnlistenFn> {
  return await listen<boolean>("setting-wander", (e) => handler(e.payload));
}

export async function onSettingWalkSpeed(handler: (speed: number) => void): Promise<UnlistenFn> {
  return await listen<number>("setting-walk-speed", (e) => handler(e.payload));
}

export async function onSettingUsername(handler: (name: string) => void): Promise<UnlistenFn> {
  return await listen<string>("setting-username", (e) => handler(e.payload));
}

export async function onMemoryReset(handler: () => void): Promise<UnlistenFn> {
  return await listen("memory-reset", () => handler());
}

export async function isDebugFast(): Promise<boolean> {
  try {
    return await invoke<boolean>("is_debug_fast");
  } catch {
    return false;
  }
}


