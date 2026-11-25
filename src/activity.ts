// Windows OS activity monitor: idle detection, fullscreen suspension, battery tracking, and breaks

import { getUserIdleMs, getFullscreenAndPower, hideWindow, showWindow, isDebugFast, logDecision, onWindowFocusChanged } from "./platform";
import { state, setDndEnabled, isInQuietHours } from "./state";
import { BREAK_EVERY_MIN } from "./config";
import { Animator } from "./sprites";
import { Mood } from "./mood";
import { Brain } from "./brain";
import { Behaviors } from "./behaviors";
import { say, fx } from "./ui";

export class ActivityMonitor {
  private idleTimer: number | undefined;
  private powerTimer: number | undefined;

  private activeSeconds = 0;
  private wasAway = false;
  private hiddenDueToFullscreen = false;
  private debugFast = false;

  private lastCharging: boolean | null = null;
  private lastBatteryPercent: number | null = null;
  private lowBatteryNotified = false;

  /** Track last focus state to avoid repeat reactions */
  private lastFocused: boolean | null = null;
  private focusUnlisten?: () => void;

  constructor(
    private anim: Animator,
    private mood: Mood,
    private brain: Brain,
    private behaviors: Behaviors
  ) {}

  async start() {
    this.debugFast = await isDebugFast();
    if (this.debugFast) {
      console.log("[ActivityMonitor] DIANA_DEBUG_FAST=1 enabled: idle-sleep 30s, away 20s, break 1m");
    }
    this.scheduleIdleCheck();
    this.schedulePowerCheck();
    this._bindWindowFocus();
  }

  stop() {
    window.clearTimeout(this.idleTimer);
    window.clearTimeout(this.powerTimer);
    this.idleTimer = undefined;
    this.powerTimer = undefined;
    this.focusUnlisten?.();
    this.focusUnlisten = undefined;
  }

  // ── Window focus / app-switch reactive behavior ──────────────────────────

  private _bindWindowFocus() {
    this.focusUnlisten?.();
    this.focusUnlisten = onWindowFocusChanged(async (focused) => {
      if (this.lastFocused === focused) return;
      this.lastFocused = focused;
      if (!state.visible || state.dndEnabled || isInQuietHours()) return;
      if (state.mode === "sleeping" || state.mode === "hanging" || state.mode === "falling") return;

      if (!focused) {
        // User switched to another app
        logDecision("WindowFocus: lost focus → appBlur reaction");
        const reply = await this.brain.respond({
          trigger: "appBlur",
          moodLabel: this.mood.label(),
          energy: this.mood.s.energy,
          hour: new Date().getHours(),
        });
        say(reply.text, reply.emote, reply.durationMs);
        this.behaviors.act("waiting", 1);
      } else {
        // User came back to Diana
        logDecision("WindowFocus: gained focus → appFocus reaction");
        const now = Date.now();
        // Only react if it's been more than 10 seconds since last interaction
        if (now - state.lastInteraction > 10000) {
          const reply = await this.brain.respond({
            trigger: "appFocus",
            moodLabel: this.mood.label(),
            energy: this.mood.s.energy,
            hour: new Date().getHours(),
          });
          say(reply.text, reply.emote, reply.durationMs);
          this.behaviors.act("cozy", 1);
        }
      }
    });
  }

  // --- Manual Do Not Disturb toggle ---
  toggleDnd() {
    const next = !state.dndEnabled;
    setDndEnabled(next);
    if (next) {
      logDecision("toggleDnd: ON (reason: user DND) → hiding window, pausing anim, canceling timers");
      this.behaviors.emergencyToFloor().then(() => {
        this.anim.pause();
        this.stop();
        this.behaviors.stopDecide();
        hideWindow();
      });
    } else {
      logDecision("toggleDnd: OFF (reason: user DND) → restoring window, resuming anim, re-arming timers");
      showWindow();
      this.anim.resume();
      this.start();
      say("Do not disturb turned off. I'm back!");
      this.behaviors.toIdle();
    }
  }

  // --- Fast Poll: User Idle Time (Every ~10s or ~2s in debug-fast) ---
  private scheduleIdleCheck() {
    window.clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    // If hidden, DND, or fullscreen, cancel polling completely
    if (!state.visible || state.dndEnabled || this.hiddenDueToFullscreen) {
      return;
    }
    const interval = this.debugFast ? 2000 : 10000;
    this.idleTimer = window.setTimeout(async () => {
      await this.checkIdle();
      this.scheduleIdleCheck();
    }, interval);
  }

  private async checkIdle() {
    if (!state.visible || state.dndEnabled || this.hiddenDueToFullscreen) return;

    // ── Quiet Hours gate ─────────────────────────────────────────────────────
    if (isInQuietHours()) {
      if (state.mode === "idle") {
        logDecision("checkIdle: quiet hours active → enforcing sleep");
        this.behaviors.startNap();
      }
      return; // No other activity processing during quiet hours
    }

    const idleMs = await getUserIdleMs();

    // Timer thresholds (shrunk if DIANA_DEBUG_FAST=1)
    const breakTargetSec = this.debugFast ? 60 : BREAK_EVERY_MIN * 60;
    const breakResetMs = this.debugFast ? 20000 : 300000;
    const awayThresholdMs = this.debugFast ? 20000 : 300000;
    const idleSleepMs = this.debugFast ? 30000 : 900000;
    const activeThresholdMs = this.debugFast ? 8000 : 60000;
    const returnThresholdMs = this.debugFast ? 5000 : 15000;
    const stepSec = this.debugFast ? 2 : 10;

    // 1. Break reminder tracking — only when enabled (Bug 4 fix)
    if (state.breakEnabled) {
      if (idleMs < activeThresholdMs) {
        this.activeSeconds += stepSec;
        if (this.activeSeconds >= breakTargetSec) {
          this.activeSeconds = 0;
          const reply = await this.brain.respond({
            trigger: "breakTime",
            moodLabel: this.mood.label(),
            energy: this.mood.s.energy,
            hour: new Date().getHours(),
          });
          say(reply.text, reply.emote, 6000);
          this.behaviors.act("waiting", 4);
        }
      } else if (idleMs >= breakResetMs) {
        this.activeSeconds = 0;
      }
    }

    // 2. Absence & "Welcome back"
    if (idleMs >= awayThresholdMs) {
      this.wasAway = true;
      if (idleMs >= idleSleepMs && state.mode === "idle") {
        this.behaviors.startNap();
      }
    } else if (this.wasAway && idleMs < returnThresholdMs) {
      this.wasAway = false;
      if (state.mode === "sleeping") {
        this.behaviors.wakeUp();
      }
      const reply = await this.brain.respond({
        trigger: "welcomeBack",
        moodLabel: this.mood.label(),
        energy: this.mood.s.energy,
        hour: new Date().getHours(),
      });
      say(reply.text, reply.emote, reply.durationMs);
      fx.bounce();
      this.behaviors.act("cozy", 2);
    }
  }

  // --- Slow Poll: Fullscreen & Battery (Every ~30s) ---
  private schedulePowerCheck() {
    window.clearTimeout(this.powerTimer);
    this.powerTimer = undefined;
    if (!state.visible || state.dndEnabled) {
      return;
    }
    this.powerTimer = window.setTimeout(async () => {
      await this.checkPowerAndFullscreen();
      this.schedulePowerCheck();
    }, 30000);
  }

  private async checkPowerAndFullscreen() {
    if (!state.visible || state.dndEnabled) return;

    const data = await getFullscreenAndPower();

    // 1. Fullscreen handling
    if (data.is_fullscreen) {
      if (!this.hiddenDueToFullscreen) {
        logDecision(
          `ActivityMonitor: hideWindow due to fullscreen (notification_state=${data.notification_state})`
        );
        this.hiddenDueToFullscreen = true;
        this.behaviors.emergencyToFloor().then(() => {
          this.anim.pause();
          this.behaviors.stopDecide();
          window.clearTimeout(this.idleTimer);
          this.idleTimer = undefined;
          hideWindow();
        });
      }
      return;
    } else if (this.hiddenDueToFullscreen) {
      logDecision(
        `ActivityMonitor: showWindow exiting fullscreen (notification_state=${data.notification_state})`
      );
      this.hiddenDueToFullscreen = false;
      await showWindow();
      this.anim.resume();
      this.scheduleIdleCheck();
      this.behaviors.toIdle();
    }

    // 2. Battery & Charging transitions
    if (this.lastCharging !== null && this.lastCharging !== data.is_charging) {
      if (data.is_charging) {
        this.lowBatteryNotified = false;
        const reply = await this.brain.respond({
          trigger: "pluggedIn",
          moodLabel: this.mood.label(),
          energy: this.mood.s.energy,
          hour: new Date().getHours(),
        });
        say(reply.text, reply.emote, reply.durationMs);
        fx.bounce();
        this.behaviors.act("cozy", 2);
      } else {
        const reply = await this.brain.respond({
          trigger: "unplugged",
          moodLabel: this.mood.label(),
          energy: this.mood.s.energy,
          hour: new Date().getHours(),
        });
        say(reply.text, reply.emote, reply.durationMs);
        this.behaviors.act("thinking", 2);
      }
    }
    this.lastCharging = data.is_charging;

    // 3. Low Battery warning (< 20%)
    if (data.battery_percent !== null) {
      if (!data.is_charging && data.battery_percent <= 20) {
        if (!this.lowBatteryNotified) {
          this.lowBatteryNotified = true;
          const reply = await this.brain.respond({
            trigger: "lowBattery",
            moodLabel: this.mood.label(),
            energy: this.mood.s.energy,
            hour: new Date().getHours(),
          });
          say(reply.text, reply.emote, reply.durationMs);
          fx.shake();
          this.behaviors.act("pout", 2);
        }
      } else if (data.battery_percent > 25) {
        this.lowBatteryNotified = false;
      }
      this.lastBatteryPercent = data.battery_percent;
    }
  }
}
