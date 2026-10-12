// Windows OS activity monitor: idle detection, fullscreen suspension, battery tracking, and breaks

import { getUserIdleMs, getFullscreenAndPower, hideWindow, showWindow } from "./platform";
import { state, setDndEnabled } from "./state";
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

  private lastCharging: boolean | null = null;
  private lastBatteryPercent: number | null = null;
  private lowBatteryNotified = false;

  constructor(
    private anim: Animator,
    private mood: Mood,
    private brain: Brain,
    private behaviors: Behaviors
  ) {}

  start() {
    this.scheduleIdleCheck();
    this.schedulePowerCheck();
  }

  stop() {
    window.clearTimeout(this.idleTimer);
    window.clearTimeout(this.powerTimer);
  }

  // --- Manual Do Not Disturb toggle ---
  toggleDnd() {
    const next = !state.dndEnabled;
    setDndEnabled(next);
    if (next) {
      this.anim.pause();
      hideWindow();
    } else {
      showWindow();
      this.anim.resume();
      say("Do not disturb turned off. I'm back!");
      this.behaviors.toIdle();
    }
  }

  // --- Fast Poll: User Idle Time (Every ~10s) ---
  private scheduleIdleCheck() {
    window.clearTimeout(this.idleTimer);
    // If hidden or DND, do not poll
    if (!state.visible || state.dndEnabled || this.hiddenDueToFullscreen) {
      this.idleTimer = window.setTimeout(() => this.scheduleIdleCheck(), 3000);
      return;
    }
    this.idleTimer = window.setTimeout(async () => {
      await this.checkIdle();
      this.scheduleIdleCheck();
    }, 10000);
  }

  private async checkIdle() {
    if (!state.visible || state.dndEnabled || this.hiddenDueToFullscreen) return;

    const idleMs = await getUserIdleMs();

    // 1. Break reminder tracking (Amendment 5)
    if (idleMs < 60000) {
      // User is active: increment active seconds
      this.activeSeconds += 10;
      if (this.activeSeconds >= BREAK_EVERY_MIN * 60) {
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
    } else if (idleMs >= 300000) {
      // Idle for >= 5 minutes counts as a real break -> reset accumulator completely!
      this.activeSeconds = 0;
    }

    // 2. Absence & "Welcome back" (Amendment 7)
    if (idleMs >= 300000) {
      this.wasAway = true;
      // If away for > 15 minutes and Diana is standing idle, let her take a nap
      if (idleMs >= 900000 && state.mode === "idle") {
        this.behaviors.startNap();
      }
    } else if (this.wasAway && idleMs < 15000) {
      // User just returned after being idle for >= 5 minutes
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
    // If hidden or DND, do not poll
    if (!state.visible || state.dndEnabled) {
      this.powerTimer = window.setTimeout(() => this.schedulePowerCheck(), 5000);
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

    // 1. Fullscreen handling (Amendment 3)
    if (data.is_fullscreen) {
      if (!this.hiddenDueToFullscreen) {
        this.hiddenDueToFullscreen = true;
        this.anim.pause();
        await hideWindow();
      }
      return; // Do not process battery or timers while fullscreen
    } else if (this.hiddenDueToFullscreen) {
      // Exited fullscreen -> restore window
      this.hiddenDueToFullscreen = false;
      await showWindow();
      this.anim.resume();
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
