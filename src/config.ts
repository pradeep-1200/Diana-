// Tweakables and default configuration for Diana Pet

export const DEFAULT_CONFIG = {
  scale: 0.8, // sprite size (matches --scale in style.css)
  walkSpeed: 110, // logical px per second
  taskbarMargin: 46, // logical px kept free at the bottom on first launch
  breakEveryMin: 50, // work-break reminder interval
} as const;

export let SCALE: number = DEFAULT_CONFIG.scale;
export let WALK_SPEED: number = DEFAULT_CONFIG.walkSpeed;
export let TASKBAR_MARGIN: number = DEFAULT_CONFIG.taskbarMargin;
export let BREAK_EVERY_MIN: number = DEFAULT_CONFIG.breakEveryMin;

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
