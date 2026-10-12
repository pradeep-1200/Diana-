// Centralized state container for Diana Pet

export type Mode = "idle" | "walking" | "sleeping" | "dancing" | "carried" | "busy";

export interface AppState {
  mode: Mode;
  visible: boolean;
  wanderEnabled: boolean;
  wanderAllMonitors: boolean;
  dndEnabled: boolean;
  isDragging: boolean;
  lastInteraction: number;
  lastBreak: number;
  lastLateNight: number;
  lastHover: number;
  lastClick: number;
  clicks: number[];
  walkToken: number;
  lastModeChange: number;
}

export const state: AppState = {
  mode: "idle",
  visible: true,
  wanderEnabled: true,
  wanderAllMonitors: false,
  dndEnabled: false,
  isDragging: false,
  lastInteraction: Date.now(),
  lastBreak: Date.now(),
  lastLateNight: 0,
  lastHover: 0,
  lastClick: 0,
  clicks: [],
  walkToken: 0,
  lastModeChange: Date.now(),
};

type StateListener = (state: AppState) => void;
const listeners = new Set<StateListener>();

function notify() {
  for (const fn of listeners) fn(state);
}

export function onStateChange(fn: StateListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setMode(newMode: Mode) {
  if (state.mode === newMode) return;
  state.mode = newMode;
  state.lastModeChange = Date.now();
  notify();
}

export function setVisible(val: boolean) {
  if (state.visible === val) return;
  state.visible = val;
  notify();
}

export function setWanderEnabled(val: boolean) {
  if (state.wanderEnabled === val) return;
  state.wanderEnabled = val;
  notify();
}

export function setDndEnabled(val: boolean) {
  if (state.dndEnabled === val) return;
  state.dndEnabled = val;
  notify();
}

export function setDragging(val: boolean) {
  if (state.isDragging === val) return;
  state.isDragging = val;
  notify();
}

export function recordInteraction(ts = Date.now()) {
  state.lastInteraction = ts;
}

export function nextWalkToken(): number {
  state.walkToken++;
  return state.walkToken;
}

export function cancelWalk() {
  state.walkToken++;
}
