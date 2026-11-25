// Tweakables and default configuration for Diana Pet

export const DEFAULT_CONFIG = {
  scale: 0.8, // sprite size (matches --scale in style.css)
  walkSpeed: 110, // logical px per second
  taskbarMargin: 46, // logical px kept free at the bottom on first launch
  breakEveryMin: 50, // work-break reminder interval
} as const;

/** Base window logical dimensions at scale 1.0
 * These match tauri.conf.json (width=240, height=328).
 * Do NOT change without also updating tauri.conf.json and the Rust atomics.
 * The previous session changed these to 300/410 — reverted back (Issue 5 fix).
 */
export const BASE_WINDOW_W = 240;
export const BASE_WINDOW_H = 328;

export let SCALE: number = DEFAULT_CONFIG.scale;
export let WALK_SPEED: number = DEFAULT_CONFIG.walkSpeed;
export let TASKBAR_MARGIN: number = DEFAULT_CONFIG.taskbarMargin;
export let BREAK_EVERY_MIN: number = DEFAULT_CONFIG.breakEveryMin;

/** "quiet" | "normal" | "chatty" — drives thought/ponder weights */
export type ChattinessLevel = "quiet" | "normal" | "chatty";
export let CHATTINESS: ChattinessLevel = "normal";

export const CHATTINESS_WEIGHT: Record<ChattinessLevel, number> = {
  quiet: 8,
  normal: 20,
  chatty: 38,
};

export function applyScale(scale: number) {
  SCALE = scale;
  document.documentElement.style.setProperty("--scale", String(scale));
}

export function setWalkSpeed(speed: number) {
  WALK_SPEED = speed;
}

export function setBreakEveryMin(mins: number) {
  BREAK_EVERY_MIN = mins;
}

export function setTaskbarMargin(margin: number) {
  TASKBAR_MARGIN = margin;
}

export function setChattiness(level: ChattinessLevel) {
  CHATTINESS = level;
}
