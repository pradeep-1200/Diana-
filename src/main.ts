import { Animator } from "./sprites";
import { Mood } from "./mood";
import { ScriptedBrain } from "./brain";
import { Behaviors, sleep, hour, isLateNight } from "./behaviors";
import { InputHandler } from "./input";
import { state, setVisible, setWanderEnabled, setBreakEnabled, setQuietHours } from "./state";
import { SCALE, applyScale, setWalkSpeed, setBreakEveryMin, setChattiness, ChattinessLevel } from "./config";
import { spriteEl, say, syncHitRects, askInlineInput } from "./ui";
import {
  getCurrentWorkArea,
  getWindowSize,
  getWindowPosition,
  setWindowPosition,
  loadLocalPosition,
  onTrayAction,
  onPetVisible,
  focusWindow,
  dbGetFact,
  dbSetFact,
  dbLogEvent,
  dbRecordActivity,
  dbGetStatsSummary,
  dbGetAllSettings,
  onSettingScale,
  onSettingWander,
  onSettingWanderAll,
  onSettingWalkSpeed,
  onSettingUsername,
  onSettingChattiness,
  onSettingBreakEnabled,
  onSettingBreakInterval,
  onSettingQuietHours,
  onMemoryReset,
  getUserIdleMs,
  updateTrayTooltip,
  logDecision,
} from "./platform";
import { listen } from "@tauri-apps/api/event";

import { ActivityMonitor } from "./activity";

// Initialize styling
applyScale(SCALE);

// Core instances
const anim = new Animator(spriteEl);
const mood = new Mood();
const brain = new ScriptedBrain();
const behaviors = new Behaviors(anim, mood, brain);
const activityMonitor = new ActivityMonitor(anim, mood, brain, behaviors);
new InputHandler(anim, mood, behaviors, brain, activityMonitor);

// Tray event listeners from Rust
onTrayAction((action) => {
  if (action === "dance") behaviors.doDance();
  if (action === "sleep") behaviors.toggleSleep();
  if (action === "dnd") activityMonitor.toggleDnd();
});

// Requirement B: "Bring Diana back" rescue from Rust tray item
listen("bring-back", () => {
  logDecision("bring-back event: resetting to idle from Rust rescue");
  setVisible(true);
  anim.resume();
  behaviors.toIdle();
  activityMonitor.start();
}).catch(console.warn);

onPetVisible((visible) => {
  setVisible(visible);
  logDecision(`onPetVisible: visible=${visible} (reason: user/tray visibility toggle)`);
  if (visible) {
    anim.resume();
    behaviors.scheduleDecide("onPetVisible");
    activityMonitor.start();
  } else {
    anim.pause();
    behaviors.stopDecide();
    activityMonitor.stop();
    mood.flush();
    dbLogEvent("session_hide");
  }
});

// Live settings event listeners
onSettingScale((scale) => {
  applyScale(scale);
  // Do NOT resize the OS window here — the Tauri window is fixed at 240×328 (tauri.conf.json).
  // Resizing on scale-change breaks Rust's floor/clamp math which uses physical pixel atomics.
  syncHitRects();
});

onSettingWander((enabled) => {
  setWanderEnabled(enabled);
  if (!enabled && state.mode === "walking") {
    behaviors.toIdle();
  }
});

onSettingWanderAll((enabled) => {
  state.wanderAllMonitors = enabled;
});

onSettingWalkSpeed((speed) => {
  setWalkSpeed(speed);
});

onSettingUsername((name) => {
  brain.setUserName(name);
});

onSettingChattiness((level) => {
  setChattiness(level as ChattinessLevel);
});

onSettingBreakEnabled((enabled) => {
  setBreakEnabled(enabled);
});

onSettingBreakInterval((mins) => {
  setBreakEveryMin(mins);
});

onSettingQuietHours((data) => {
  const [sh, sm] = (data.start || "23:00").split(":").map(Number);
  const [eh, em] = (data.end || "07:00").split(":").map(Number);
  setQuietHours({
    enabled: data.enabled,
    startH: sh || 0,
    startM: sm || 0,
    endH: eh || 0,
    endM: em || 0,
  });
});

onMemoryReset(async () => {
  await mood.init();
  mood.s.energy = 80;
  mood.save();
  await mood.flush();
  brain.setUserName("");
  say("I feel refreshed! Like a new day~ ✨");
  behaviors.toIdle();
});

let minuteClockTimer: number | undefined;
let watchdogTimer: number | undefined;

/** Issue 0 Req H: 2-second watchdog — if window drifts off-screen, snap back to floor. */
function startWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = window.setInterval(async () => {
    if (!state.visible || state.dndEnabled || state.mode === "carried" || state.mode === "falling") return;
    try {
      const [pos, size, wa] = await Promise.all([
        getWindowPosition(),
        getWindowSize(),
        getCurrentWorkArea(),
      ]);
      if (!wa) return;
      const cx = pos.x + size.width / 2;
      const cy = pos.y + size.height / 2;
      const onScreen =
        cx >= wa.x - size.width &&
        cx <= wa.x + wa.width + size.width &&
        cy >= wa.y - size.height &&
        cy <= wa.y + wa.height + size.height;
      if (!onScreen) {
        const snapX = wa.x + wa.width - size.width - Math.round(40 * wa.scaleFactor);
        const snapY = wa.y + wa.height - size.height;
        logDecision(
          `watchdog: window off-screen at (${pos.x},${pos.y}) size=(${size.width},${size.height}) — snapping to (${snapX},${snapY})`
        );
        await setWindowPosition(snapX, snapY);
        behaviors.toIdle();
      }
    } catch { /* ignore */ }
  }, 2000);
}

function startMinuteClock() {
  if (minuteClockTimer) clearInterval(minuteClockTimer);
  minuteClockTimer = window.setInterval(async () => {
    const idleMs = await getUserIdleMs();
    const userActive = idleMs < 60000;
    mood.tick(1, state.mode === "sleeping", userActive);
    mood.save();
    await mood.flush();

    const todayStr = new Date().toISOString().slice(0, 10);
    await dbRecordActivity(todayStr, hour(), 1, 0);

    if (!state.visible || state.mode !== "idle" || state.dndEnabled) return;

    const now = Date.now();
    if (isLateNight() && now - state.lastLateNight > 60 * 60000) {
      state.lastLateNight = now;
      const reply = await brain.respond({
        trigger: "lateNight",
        moodLabel: mood.label(),
        energy: mood.s.energy,
        hour: hour(),
      });
      say(reply.text, reply.emote, 5000);
      behaviors.act("thinking", 3);
    }
  }, 60000);
}

// Initial placement and greeting sequence
async function placeInitially() {
  const [wa, size] = await Promise.all([
    getCurrentWorkArea(),
    getWindowSize(),
  ]);
  if (!wa) return;

  const saved = loadLocalPosition();
  const inside =
    saved &&
    saved.x >= wa.x - size.width / 2 &&
    saved.x <= wa.x + wa.width - size.width / 2 &&
    saved.y >= wa.y &&
    saved.y <= wa.y + wa.height - size.height;

  const x = inside
    ? saved!.x
    : wa.x + wa.width - size.width - Math.round(40 * wa.scaleFactor);
  const y = inside
    ? saved!.y
    : wa.y + wa.height - size.height;

  await setWindowPosition(x, y);

  // Cache floor/size into state for Rust physics fallback
  state.floorY = wa.y + wa.height;
  state.winH = size.height;
  state.scaleFactor = wa.scaleFactor;
}

let hasStarted = false;

async function start() {
  if (hasStarted) {
    logDecision("main.ts start() re-called -> tearing down timers for clean idempotent restart");
    behaviors.stopDecide();
    activityMonitor.stop();
  }
  hasStarted = true;
  logDecision("main.ts start() begin");
  await placeInitially();
  anim.play("idle");
  startMinuteClock();
  startWatchdog();
  activityMonitor.start();

  // 1. Initialize SQLite mood & load settings
  await mood.init();
  await dbLogEvent("session_start");

  const settings = await dbGetAllSettings();
  logDecision(`main.ts settings loaded: ${JSON.stringify(settings)}`);
  if (settings["scale"]) {
    const s = parseFloat(settings["scale"]);
    if (!isNaN(s) && s > 0) {
      applyScale(s);
      // Do NOT call resizeWindowForScale — window is fixed at 240×328 (tauri.conf.json)
    }
  }
  if (settings["wander_enabled"] !== undefined) {
    setWanderEnabled(settings["wander_enabled"] !== "false");
  }
  if (settings["wander_all_monitors"] !== undefined) {
    state.wanderAllMonitors = settings["wander_all_monitors"] === "true";
  }
  if (settings["walk_speed"]) {
    const spd = parseInt(settings["walk_speed"], 10);
    if (!isNaN(spd) && spd > 0) setWalkSpeed(spd);
  }
  if (settings["chattiness"]) {
    setChattiness(settings["chattiness"] as ChattinessLevel);
  }
  if (settings["break_reminder_enabled"] !== undefined) {
    setBreakEnabled(settings["break_reminder_enabled"] !== "false");
  }
  if (settings["break_interval_mins"]) {
    const bim = parseInt(settings["break_interval_mins"], 10);
    if (!isNaN(bim) && bim > 0) setBreakEveryMin(bim);
  }
  if (settings["quiet_hours_enabled"] !== undefined) {
    const [sh, sm] = (settings["quiet_hours_start"] || "23:00").split(":").map(Number);
    const [eh, em] = (settings["quiet_hours_end"] || "07:00").split(":").map(Number);
    setQuietHours({
      enabled: settings["quiet_hours_enabled"] === "true",
      startH: sh || 0,
      startM: sm || 0,
      endH: eh || 0,
      endM: em || 0,
    });
  }
  syncHitRects();

  // 2. Onboarding: Check user name fact
  const nameFact = await dbGetFact("user_name");
  logDecision(`main.ts nameFact: ${nameFact ? nameFact.value : "null"}`);
  if (!nameFact || !nameFact.value.trim()) {
    logDecision("main.ts displaying onboarding input prompt");
    await sleep(400);
    // Explicitly focus window for typing
    await focusWindow();
    askInlineInput(
      "Hi! What should I call you?",
      "Your name...",
      async (name) => {
        logDecision(`main.ts onboarding submitted name="${name}"`);
        if (name) {
          await dbSetFact("user_name", name, "onboarding");
          brain.setUserName(name);
          say(`Nice to meet you, ${name}! ❤`);
        } else {
          say("That's okay! We can just hang out. ✨");
        }
        behaviors.act("cozy", 2);
        (document.activeElement as HTMLElement)?.blur();
        behaviors.scheduleDecide("onboarding_submit");
      },
      () => {
        logDecision("main.ts onboarding skipped");
        say("No problem! Let's be friends anyway~ ✨");
        behaviors.act("cozy", 2);
        (document.activeElement as HTMLElement)?.blur();
        behaviors.scheduleDecide("onboarding_skip");
      }
    );
    // CRITICAL: Also arm the decision loop in the background so Diana is NOT frozen if user doesn't type!
    behaviors.scheduleDecide("onboarding_initial_background");
    return;
  }

  brain.setUserName(nameFact.value);

  await sleep(900);

  // 3. Stats Summary: streaks & active hour pattern
  const stats = await dbGetStatsSummary();
  logDecision(`main.ts stats: streaks=${stats.streak_days}, pets=${stats.total_pets}, hours=${JSON.stringify(stats.top_active_hours)}`);
  updateTrayTooltip(`Diana — Day ${Math.max(1, stats.streak_days)}`);
  const h = hour();
  const away = mood.awayMinutes;
  const greetingTrigger =
    away > 180 ? "returnLong" : away > 20 ? "returnShort" : "timeGreeting";

  const reply = await brain.respond({
    trigger: greetingTrigger,
    moodLabel: mood.label(),
    energy: mood.s.energy,
    hour: h,
    awayMinutes: away,
  });

  let text = reply.text;
  if (stats.top_active_hours && stats.top_active_hours.includes(h) && Math.random() < 0.4) {
    text += " You're usually up around this time!";
  } else if (stats.streak_days >= 7 && Math.random() < 0.35) {
    text += ` Day ${stats.streak_days} in a row!`;
  }

  say(text, reply.emote, reply.durationMs);
  behaviors.act("cozy", 2);
  behaviors.scheduleDecide("startup_greeting");
}

window.addEventListener("beforeunload", () => {
  mood.flush();
  dbLogEvent("session_end");
});

document.addEventListener("dragstart", (e) => e.preventDefault());
start();
