// Decision loop, wandering physics, and rich autonomous pet behaviors (Step 1)

import { Animator, ClipName } from "./sprites";
import { Mood, MoodState, MoodLabel } from "./mood";
import { Brain, EMOTION_CLIPS } from "./brain";
import { state, setMode, nextWalkToken, recordInteraction, Mode, isInQuietHours } from "./state";
import { SCALE, WALK_SPEED, CHATTINESS, CHATTINESS_WEIGHT } from "./config";
import { fx, emote, say, setMotionSleeping, setMotionPaused } from "./ui";
import { getSeason, getHoliday, pick } from "./lines";
import {
  getCurrentWorkArea,
  getAllMonitors,
  getWindowPosition,
  getWindowSize,
  setWindowPosition,
  getUserIdleMs,
  logDecision,
  beginFall,
  abortPhysics,
  onPhysicsLanded,
  LandedPayload,
  beginFlight,
  setFlightTarget,
  endFlight,
  onFlightTick,
  onFlightEnded,
} from "./platform";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const hour = () => new Date().getHours();
export const isLateNight = () => hour() < 5;

/** ms the hang clip plays before gravity starts (gives user time to double-click for copter). */
const HANG_GRACE_MS = 1500;
// COPTER_FLY_MS removed — real flight duration is now 45 s, controlled by Rust (Issue 4 fix)

let decideTimer: number | undefined;

export interface SceneStep {
  clip?: ClipName;
  loops?: number;
  mirror?: boolean;
  fx?: "bounce" | "shake" | "squish" | "sway" | "shiver" | "stretch" | "hiccup";
  emote?: string;
  bubble?: { text: string; emote?: string; durationMs?: number };
  moveRelativeX?: number;
  waitMs?: number;
}

export interface BehaviorDef {
  id: string;
  name: string;
  isScene?: boolean;
  weight: (m: MoodState, label: MoodLabel, idleFor: number) => number;
  run: (b: Behaviors) => Promise<void> | void;
}

export class Behaviors {
  private recentBehaviors: string[] = [];
  private burstQueue = 0;

  constructor(
    private anim: Animator,
    private mood: Mood,
    private brain: Brain
  ) {}

  toIdle = () => {
    logDecision(`toIdle() transitioning mode ${state.mode} -> idle (energy=${this.mood.s.energy.toFixed(1)})`);
    setMode("idle");
    this.anim.play("idle");
    setMotionSleeping(false);
    this.scheduleDecide("toIdle");
  };

  act(name: ClipName, loops: number, newMode: Mode = "busy") {
    nextWalkToken();
    logDecision(`act(${name}, loops=${loops}, newMode=${newMode}) from mode=${state.mode}`);
    setMode(newMode);
    this.anim.play(name, { loops, onDone: this.toIdle });
  }

  async playScene(sceneName: string, steps: SceneStep[]) {
    const token = nextWalkToken();
    setMode("busy");
    logDecision(`playScene("${sceneName}", steps=${steps.length}) started`);
    try {
      for (const step of steps) {
        if (token !== state.walkToken || !state.visible || state.dndEnabled) break;
        if (step.emote) emote(step.emote);
        if (step.bubble) say(step.bubble.text, step.bubble.emote, step.bubble.durationMs);
        if (step.fx && fx[step.fx]) fx[step.fx]();
        if (step.moveRelativeX) {
          const pos = await getWindowPosition();
          await setWindowPosition(pos.x + step.moveRelativeX, pos.y);
        }
        if (step.clip) {
          await new Promise<void>((resolve) => {
            this.anim.play(step.clip!, {
              loops: step.loops ?? 1,
              mirror: step.mirror,
              onDone: resolve,
            });
          });
        }
        if (step.waitMs) {
          await sleep(step.waitMs);
        }
      }
    } catch (err) {
      logDecision(`playScene("${sceneName}") error: ${err}`);
    } finally {
      if (token === state.walkToken) {
        this.toIdle();
      }
    }
  }

  async thought() {
    const m = this.mood.s;
    const label = this.mood.label();
    const reply = await this.brain.respond({
      trigger: "thought",
      moodLabel: label,
      energy: m.energy,
      hour: hour(),
    });
    say(reply.text, reply.emote, reply.durationMs);

    const clip = EMOTION_CLIPS[reply.emotion] || "neutral";
    const loops = clip === "cozy" || clip === "neutral" ? 3 : clip === "sleepy" ? 1 : 2;
    this.act(clip, loops);
  }

  async ponder() {
    const m = this.mood.s;
    const reply = await this.brain.respond({
      trigger: "ponder",
      moodLabel: this.mood.label(),
      energy: m.energy,
      hour: hour(),
    });
    say(reply.text, reply.emote || "💭", 3500);
    this.act("thinking", 3);
  }

  async seekAttention() {
    const m = this.mood.s;
    const reply = await this.brain.respond({
      trigger: "thought",
      moodLabel: "bored",
      energy: m.energy,
      hour: hour(),
    });
    say(reply.text, reply.emote, reply.durationMs);
    this.act("waiting", 4);
  }

  async doDance() {
    recordInteraction();
    if (state.mode === "sleeping") this.mood.woken();
    const res = this.mood.danced();
    if (!res.ok) {
      say("Whoa... the room is still spinning! 💫", "💫", 2800);
      fx.shake();
      this.act("pout", 2);
      return;
    }

    const m = this.mood.s;
    if (res.dizzyNow) {
      say("Whew! Dancing is fun but I'm getting dizzy~ 💫", "💫", 3000);
    } else {
      const reply = await this.brain.respond({
        trigger: "dance",
        moodLabel: this.mood.label(),
        energy: m.energy,
        hour: hour(),
      });
      say(reply.text, reply.emote || "♪", reply.durationMs);
    }
    fx.bounce();
    this.act("dance", 3, "dancing");
  }

  goToSleep = () => {
    nextWalkToken();
    setMode("sleeping");
    setMotionSleeping(true);
    this.anim.play("sleepy");
    emote("💤");
  };

  async startNap() {
    const m = this.mood.s;
    const reply = await this.brain.respond({
      trigger: "yawn",
      moodLabel: this.mood.label(),
      energy: m.energy,
      hour: hour(),
    });
    say(reply.text, reply.emote || "💤", reply.durationMs);
    nextWalkToken();
    setMode("busy");
    this.anim.play("sleepy", { loops: 1, onDone: this.goToSleep });
  }

  async wakeUp(natural = false) {
    setMotionSleeping(false);
    const m = this.mood.s;
    const reply = await this.brain.respond({
      trigger: natural ? "timeGreeting" : "wake",
      moodLabel: this.mood.label(),
      energy: m.energy,
      hour: hour(),
    });
    say(reply.text, reply.emote, reply.durationMs);
    this.act("cozy", 2);
  }

  toggleSleep = () => {
    recordInteraction();
    if (state.mode === "sleeping") this.wakeUp();
    else this.startNap();
  };

  // ── Hang / Fall / Land ──────────────────────────────────────────────────────

  /**
   * Called by InputHandler after drag-ended with above_floor=true.
   * Plays the "hang" clip (extras sheet), starts grace window.
   * If no double-click within graceMs → start fall.
   * Double-click path (Commit B) will call deployFlight() instead.
   */
  startHang = async (wx: number, wy: number) => {
    nextWalkToken();
    setMode("hanging");
    logDecision(`startHang() wx=${wx} wy=${wy}`);

    const reply = await this.brain.respond({
      trigger: "pickup",
      moodLabel: this.mood.label(),
      energy: this.mood.s.energy,
      hour: hour(),
    });
    say(reply.text, reply.emote || "😮", reply.durationMs);
    this.anim.playExtras("hang");

    // Arm fall after grace window (1.5 s by default)
    // Bug 4 fix: only Behaviors owns this timer; InputHandler calls cancelHang()
    this._hangGraceTimer = window.setTimeout(() => this._startFall(), HANG_GRACE_MS);
  };

  cancelHang() {
    window.clearTimeout(this._hangGraceTimer);
  }

  private _hangGraceTimer: number | undefined;

  /**
   * Called by InputHandler on double-click during hang.
   * Issue 4 fix: Real Rust-driven copter flight with spring-ease physics,
   * target tracking toward cursor, and tilt/mirror on the sprite.
   * Previous stub just ran `await sleep(COPTER_FLY_MS)` with no movement.
   */
  async deployFlight() {
    if (state.mode !== "hanging") return;
    window.clearTimeout(this._hangGraceTimer);
    this._hangGraceTimer = undefined;
    setMode("flying");
    logDecision("deployFlight() launching copter (real Rust flight)");

    say("Whirr~ 🚁", "🚁", 2000);
    // Play deploy animation (non-looping), wait for it to finish
    await new Promise<void>((resolve) =>
      this.anim.playExtras("deploy", { loops: 1, onDone: resolve })
    );

    if ((state.mode as Mode) !== "flying") return; // aborted during deploy

    // Start the looping fly animation
    this.anim.playExtras("fly");

    // Get physics params
    const [wa, size] = await Promise.all([
      getCurrentWorkArea(),
      getWindowSize(),
    ]);
    if (!wa) {
      logDecision("deployFlight() aborted: no work area");
      return this._startFall();
    }

    const floorY = wa.y + wa.height;
    const winH = size.height;
    const winW = size.width;
    const scale = wa.scaleFactor;
    state.floorY = floorY;
    state.winH = winH;
    state.scaleFactor = scale;

    const MAX_FLIGHT_MS = 45000; // 45 seconds max

    // Start Rust flight loop — it spring-eases toward flight_target
    await beginFlight(floorY, winH, winW, scale, MAX_FLIGHT_MS);

    // Track cursor: every 2–4 seconds pick a new target near last mouse position
    let lastMouseX = 0;
    let lastMouseY = 0;
    const mouseTracker = (e: MouseEvent) => {
      lastMouseX = e.screenX;
      lastMouseY = e.screenY;
    };
    window.addEventListener("mousemove", mouseTracker);

    // Initial target = current window position (hover in place first)
    const startPos = await getWindowPosition();
    await setFlightTarget(startPos.x, startPos.y);

    // Listen for flight ticks to apply tilt/mirror on sprite
    this._flightTickUnlisten?.();
    this._flightTickUnlisten = await onFlightTick(({ vel_x }) => {
      if ((state.mode as Mode) !== "flying") return;
      // Mirror based on horizontal direction
      const goingLeft = vel_x < -20;
      const goingRight = vel_x > 20;
      if (goingLeft) this.anim.setMirror(true);
      else if (goingRight) this.anim.setMirror(false);
      // Tilt via inline style on sprite element (degrees clamped ±15)
      const tilt = Math.max(-15, Math.min(15, vel_x * 0.03));
      this.anim.setTilt(tilt);
    });

    // Target-update loop: redirect copter toward cursor every 2–4 s
    const flightToken = nextWalkToken();
    const targetInterval = window.setInterval(async () => {
      if ((state.mode as Mode) !== "flying" || flightToken !== state.walkToken) {
        window.clearInterval(targetInterval);
        return;
      }
      // Target = cursor position (physical px), clamped above floor and within screen
      const cursorPhysX = Math.round(lastMouseX * scale) - Math.round(winW / 2);
      const cursorPhysY = Math.round(lastMouseY * scale) - Math.round(winH / 2);
      const clampedX = Math.max(wa.x, Math.min(wa.x + wa.width - winW, cursorPhysX));
      const clampedY = Math.max(wa.y - winH, Math.min(floorY - winH - 50, cursorPhysY));
      logDecision(`deployFlight() target=(${ clampedX },${ clampedY }) cursor=(${ lastMouseX },${ lastMouseY })`);
      await setFlightTarget(clampedX, clampedY);
    }, 2000 + Math.random() * 2000);

    // Listen for Rust auto-timeout (flight-ended) or early end
    this._flightEndUnlisten?.();
    this._flightEndUnlisten = await onFlightEnded(async ({ reason }) => {
      this._flightEndUnlisten?.(); this._flightEndUnlisten = undefined;
      if ((state.mode as Mode) !== "flying") return;
      logDecision(`deployFlight() flight-ended event reason=${reason}`);
      window.clearInterval(targetInterval);
      window.removeEventListener("mousemove", mouseTracker);
      this._flightTickUnlisten?.(); this._flightTickUnlisten = undefined;
      this.anim.setMirror(false);
      this.anim.setTilt(0);
      await this._retractAndFall();
    });

    // JS-side 45s failsafe (in case Rust event is missed)
    window.setTimeout(async () => {
      if ((state.mode as Mode) !== "flying") return;
      logDecision("deployFlight() JS 45s failsafe: ending flight");
      window.clearInterval(targetInterval);
      window.removeEventListener("mousemove", mouseTracker);
      await endFlight();
      this._flightTickUnlisten?.(); this._flightTickUnlisten = undefined;
      this.anim.setMirror(false);
      this.anim.setTilt(0);
      await this._retractAndFall();
    }, MAX_FLIGHT_MS + 500);
  }

  /** Cancel copter flight early (double-click during flight). */
  async cancelFlight() {
    if ((state.mode as Mode) !== "flying") return;
    logDecision("cancelFlight() early double-click during flight");
    this._flightEndUnlisten?.(); this._flightEndUnlisten = undefined;
    this._flightTickUnlisten?.(); this._flightTickUnlisten = undefined;
    this.anim.setMirror(false);
    this.anim.setTilt(0);
    await endFlight();
    await this._retractAndFall();
  }

  private _flightTickUnlisten?: () => void;
  private _flightEndUnlisten?: () => void;

  /** Play retract animation then start fall. */
  private async _retractAndFall() {
    if ((state.mode as Mode) !== "flying") return;
    setMode("hanging"); // reuse hanging → fall path
    logDecision("_retractAndFall() playing retract clip");
    await new Promise<void>((resolve) =>
      this.anim.playExtras("retract", { loops: 1, onDone: resolve })
    );
    await this._startFall();
  }

  private async _startFall() {
    if (state.mode !== "hanging") return;
    setMode("falling");
    logDecision("_startFall() beginning Rust-driven gravity");

    // Show falling animation
    this.anim.playExtras("fall");

    const [wa, size] = await Promise.all([
      getCurrentWorkArea(),
      getWindowSize(),
    ]);
    if (!wa) return;
    const floorY = wa.y + wa.height;
    const winH = size.height;
    state.floorY = floorY;
    state.winH = winH;
    state.scaleFactor = wa.scaleFactor;

    await beginFall(0, floorY, winH, wa.scaleFactor);

    // Listen for landing (one-shot, using statically-imported onPhysicsLanded)
    this._landUnlisten?.();
    this._landUnlisten = await onPhysicsLanded((p) => this.onLanded(p));
  }

  private _landUnlisten?: () => void;

  /** Called when Rust thread emits physics-landed. */
  onLanded = async (_p: LandedPayload) => {
    this._landUnlisten?.();
    this._landUnlisten = undefined;
    if (state.mode !== "falling") return;
    setMode("busy");
    logDecision("onLanded() playing land clip");
    say("Ow... hehe. Again?", "🌟", 2000);
    await new Promise<void>((resolve) =>
      this.anim.playExtras("land", { loops: 1, onDone: resolve })
    );
    this.toIdle();
  };

  /**
   * Immediately snap Diana to the floor without animation.
   * Used when hide/DND/fullscreen fires during hang or fall.
   */
  emergencyToFloor = async () => {
    window.clearTimeout(this._hangGraceTimer);
    this._landUnlisten?.();
    this._landUnlisten = undefined;
    await abortPhysics();

    // Place on floor
    const [wa, size] = await Promise.all([
      getCurrentWorkArea(),
      getWindowSize(),
    ]);
    if (wa) {
      const pos = await getWindowPosition();
      await setWindowPosition(pos.x, wa.y + wa.height - size.height);
    }
    // toIdle() will be called when the window becomes visible again
  };

  wander = async () => {
    if (!state.wanderEnabled) return;
    const token = nextWalkToken();
    const wa = await getCurrentWorkArea();
    if (!wa || token !== state.walkToken) return;
    const [pos, size] = await Promise.all([
      getWindowPosition(),
      getWindowSize(),
    ]);

    const pad = (size.width - 192 * SCALE * wa.scaleFactor) / 2;
    let minX = wa.x - pad;
    let maxX = wa.x + wa.width - size.width + pad;

    if (state.wanderAllMonitors) {
      const all = await getAllMonitors();
      if (all.length > 1) {
        for (const m of all) {
          const mWa = m.workArea ?? { position: m.position, size: m.size };
          minX = Math.min(minX, mWa.position.x - pad);
          maxX = Math.max(maxX, mWa.position.x + mWa.size.width - size.width + pad);
        }
      }
    }

    const dir = Math.random() < 0.5 ? -1 : 1;
    const target = Math.max(minX, Math.min(maxX, pos.x + dir * rand(150, 550) * wa.scaleFactor));
    if (Math.abs(target - pos.x) < 60 * wa.scaleFactor) return;
    const d = target > pos.x ? 1 : -1;

    setMode("walking");
    this.anim.play(d > 0 ? "walkRight" : "walkLeft");
    let x = pos.x;
    let last = performance.now();
    try {
      while (token === state.walkToken && Math.abs(target - x) > 2) {
        await sleep(33);
        if (token !== state.walkToken) break;
        const now = performance.now();
        x += d * WALK_SPEED * wa.scaleFactor * ((now - last) / 1000);
        last = now;
        if ((d > 0 && x > target) || (d < 0 && x < target)) x = target;
        await setWindowPosition(x, pos.y);
      }
    } catch (err) {
      logDecision(`wander error: ${err}`);
    } finally {
      if (token === state.walkToken || state.mode === "walking") {
        this.toIdle();
      }
    }
  };

  async zoomies() {
    const token = nextWalkToken();
    const wa = await getCurrentWorkArea();
    if (!wa || token !== state.walkToken) return;
    const [pos, size] = await Promise.all([getWindowPosition(), getWindowSize()]);
    const pad = (size.width - 192 * SCALE * wa.scaleFactor) / 2;
    const minX = wa.x - pad;
    const maxX = wa.x + wa.width - size.width + pad;

    const dir = pos.x > (minX + maxX) / 2 ? -1 : 1;
    const dist = rand(250, 480) * wa.scaleFactor;
    const target = Math.max(minX, Math.min(maxX, pos.x + dir * dist));

    setMode("busy");
    say("Zoom!", "⚡", 1400);
    this.anim.play("zoom", { mirror: dir < 0 });
    let x = pos.x;
    let last = performance.now();
    try {
      while (token === state.walkToken && Math.abs(target - x) > 4) {
        await sleep(20);
        if (token !== state.walkToken) break;
        const now = performance.now();
        x += dir * (WALK_SPEED * 2.4) * wa.scaleFactor * ((now - last) / 1000);
        last = now;
        if ((dir > 0 && x > target) || (dir < 0 && x < target)) x = target;
        await setWindowPosition(x, pos.y);
      }
    } finally {
      if (token === state.walkToken) {
        this.toIdle();
      }
    }
  }

  async peekCorner() {
    const wa = await getCurrentWorkArea();
    if (!wa) return this.toIdle();
    const [pos, size] = await Promise.all([getWindowPosition(), getWindowSize()]);
    const nearLeft = pos.x < wa.x + wa.width / 2;
    const target = nearLeft ? wa.x : wa.x + wa.width - size.width;
    const dir = target > pos.x ? 1 : -1;
    const token = nextWalkToken();
    setMode("walking");
    this.anim.play(dir > 0 ? "walkRight" : "walkLeft");
    let x = pos.x;
    let last = performance.now();
    try {
      while (token === state.walkToken && Math.abs(target - x) > 10) {
        await sleep(33);
        if (token !== state.walkToken) break;
        const now = performance.now();
        x += dir * WALK_SPEED * wa.scaleFactor * ((now - last) / 1000);
        last = now;
        await setWindowPosition(x, pos.y);
      }
      if (token === state.walkToken) {
        setMode("busy");
        this.anim.play("thinking", { loops: 2, mirror: nearLeft });
        await sleep(2200);
      }
    } finally {
      if (token === state.walkToken) {
        this.toIdle();
      }
    }
  }

  stopDecide() {
    window.clearTimeout(decideTimer);
    decideTimer = undefined;
    setMotionPaused(true);
    logDecision("stopDecide() canceled decideTimer completely");
  }

  private getNextDelay(): number {
    if (state.mode === "sleeping") {
      return Math.round(rand(10000, 18000));
    }
    if (this.burstQueue > 0) {
      this.burstQueue--;
      // Quick burst of 2-3 actions
      return Math.round(rand(1800, 3200));
    }
    const r = Math.random();
    if (r < 0.12) {
      // Start a quick burst sequence
      this.burstQueue = Math.floor(rand(1, 3));
      return Math.round(rand(2000, 3500));
    } else if (r < 0.25) {
      // Quiet calm lull
      return Math.round(rand(30000, 52000));
    } else {
      // Skewed normal 4-12 seconds
      return Math.round(4000 + (Math.random() + Math.random()) * 4000);
    }
  }

  scheduleDecide(caller = "unknown") {
    window.clearTimeout(decideTimer);
    decideTimer = undefined;
    if (!state.visible || state.dndEnabled) {
      logDecision(`scheduleDecide(caller=${caller}) suppressed: visible=${state.visible}, dnd=${state.dndEnabled}`);
      return;
    }
    setMotionPaused(false);
    const delay = this.getNextDelay();
    logDecision(
      `scheduleDecide(caller=${caller}) armed next decide in ${delay}ms (mode=${state.mode}, energy=${this.mood.s.energy.toFixed(1)}, visible=${state.visible}, dnd=${state.dndEnabled})`
    );
    decideTimer = window.setTimeout(() => this.decide(), delay);
  }

  decide = async () => {
    // 1. Zero polling check FIRST before any re-arming
    if (!state.visible) {
      logDecision("decide() skipped & canceled: state.visible is false");
      this.stopDecide();
      return;
    }
    if (state.dndEnabled) {
      logDecision("decide() skipped & canceled: state.dndEnabled is true");
      this.stopDecide();
      return;
    }

    const m = this.mood.s;
    const idleFor = Date.now() - state.lastInteraction;
    logDecision(`decide() tick started. mode=${state.mode}, energy=${m.energy.toFixed(1)}, idleFor=${(idleFor/1000).toFixed(0)}s`);

    // 2. Re-arm next decision loop
    this.scheduleDecide("decide");

    // 3. Sleeping state management
    if (isInQuietHours()) {
      if (state.mode !== "sleeping") {
        logDecision("decide() quiet hours active -> enforcing sleep");
        return this.goToSleep();
      }
      return;
    }

    if (state.mode === "sleeping") {
      logDecision(`decide() mode=sleeping, energy=${m.energy.toFixed(1)}, idleFor=${(idleFor/1000).toFixed(0)}s`);
      // Natural wake threshold rebalanced to 70
      if (m.energy >= 70 && !isLateNight()) {
        logDecision("decide() waking up naturally: energy >= 70");
        return this.wakeUp(true);
      }
      emote("💤");
      if (Math.random() < 0.25) {
        const reply = await this.brain.respond({
          trigger: "sleeping",
          moodLabel: this.mood.label(),
          energy: m.energy,
          hour: hour(),
        });
        say(reply.text, reply.emote, 1800);
      }
      return;
    }

    // 4. Non-idle mode watchdog (skip for physics-owned modes)
    if (state.mode !== "idle") {
      // hanging/falling are owned by physics thread — do not interrupt
      if (state.mode === "hanging" || state.mode === "falling") {
        logDecision(`decide() skipping watchdog: mode=${state.mode} (physics-owned)`);
        return;
      }
      const now = Date.now();
      const inCurrentMode = now - (state.lastModeChange || now);
      if (inCurrentMode > 10000 && state.mode !== "carried") {
        logDecision(`decide() recovering stuck mode "${state.mode}" (${(inCurrentMode/1000).toFixed(1)}s in mode) -> resetting to idle`);
        this.toIdle();
      } else {
        logDecision(`decide() skipped: mode is "${state.mode}" (not idle, ${(inCurrentMode/1000).toFixed(1)}s in mode)`);
        return;
      }
    }

    // 5. Strict Napping Criteria (Item 8 Rebalance)
    // Never nap within 60s of interaction. Nap only when OS idle >= 2m OR energy < 10.
    const osIdleMs = await getUserIdleMs();
    const canNap = idleFor >= 60000 && (osIdleMs >= 120000 || m.energy < 10);
    const shouldNap =
      canNap &&
      (m.energy < 10 ||
        (isLateNight() && idleFor > 8 * 60000) ||
        (idleFor > 45 * 60000 && m.energy < 30));

    if (shouldNap) {
      logDecision(`decide() pet is tired (energy=${m.energy.toFixed(1)}, osIdle=${(osIdleMs/1000).toFixed(0)}s, idleFor=${(idleFor/1000).toFixed(0)}s), starting nap`);
      return this.startNap();
    }

    // 6. Rich Behaviors and Scenes Definition (>25 distinct actions)
    const label = this.mood.label();
    const behaviors: BehaviorDef[] = [
      {
        id: "idle_pause",
        name: "idle_pause",
        weight: () => 12,
        run: () => logDecision("decide() action: idle_pause (quiet breath)"),
      },
      {
        id: "look_around",
        name: "look_around",
        weight: () => 14,
        run: async () => {
          this.act("idle", 1);
          await sleep(600);
          this.anim.play("idle", { loops: 1, mirror: true, onDone: this.toIdle });
        },
      },
      {
        id: "stretch",
        name: "stretch",
        weight: () => 14,
        run: () => {
          fx.stretch();
          emote("✨");
          this.act("cozy", 1);
        },
      },
      {
        id: "yawn",
        name: "yawn",
        weight: (m) => 6 + (m.energy < 35 ? 16 : 0),
        run: () => {
          emote("🥱");
          say("*yawn*~", "🥱", 2000);
          this.act("sleepy", 1);
        },
      },
      {
        id: "hum",
        name: "hum",
        weight: (m) => 10 + (m.happiness > 60 ? 12 : 0),
        run: () => {
          emote("♪");
          say("Hmm-mm-hmmm~ ♪", "♪", 2400);
          this.act("cozy", 2);
        },
      },
      {
        id: "shiver",
        name: "shiver",
        weight: () => 8,
        run: () => {
          fx.shiver();
          emote("❄️");
          this.act("nuzzle", 1);
        },
      },
      {
        id: "sit_and_wait",
        name: "sit_and_wait",
        weight: (m) => 10 + (m.boredom > 50 ? 14 : 0),
        run: () => this.act("waiting", 3),
      },
      {
        id: "sway",
        name: "sway",
        weight: () => 14,
        run: () => {
          fx.sway();
          this.act("idle", 2);
        },
      },
      {
        id: "peek_corner",
        name: "peek_corner",
        weight: () => 9,
        run: () => this.peekCorner(),
      },
      {
        id: "zoomies",
        name: "zoomies",
        weight: (m) => (m.energy > 55 && m.boredom > 30 ? 15 : 2),
        run: () => this.zoomies(),
      },
      {
        id: "startled_by_nothing",
        name: "startled_by_nothing",
        weight: () => 7,
        run: () => {
          fx.bounce();
          emote("❗");
          this.act("surprised", 1);
        },
      },
      {
        id: "trip_stumble",
        name: "trip_stumble",
        weight: () => 7,
        run: async () => {
          this.anim.play("walkRight", { loops: 1 });
          await sleep(350);
          fx.squish();
          emote("💦");
          say("Whoa!", "💦", 1600);
          this.act("down", 1);
        },
      },
      {
        id: "hiccup",
        name: "hiccup",
        weight: () => 8,
        run: () => {
          fx.hiccup();
          emote("🫧");
          say("*hic!*", "🫧", 1500);
          this.act("neutral", 1);
        },
      },
      {
        id: "distracted_walk",
        name: "distracted_walk",
        weight: () => 10,
        run: async () => {
          this.anim.play("walkLeft", { loops: 1 });
          await sleep(400);
          this.act("thinking", 2);
        },
      },
      {
        id: "tiny_dance",
        name: "tiny_dance",
        weight: (m) => (m.happiness > 55 ? 12 : 3),
        run: () => {
          fx.bounce();
          emote("♪");
          this.act("dance", 1);
        },
      },
      {
        id: "ponder",
        name: "ponder",
        weight: () => Math.round(CHATTINESS_WEIGHT[CHATTINESS] * 0.6),
        run: () => this.ponder(),
      },
      {
        id: "sky_gaze",
        name: "sky_gaze",
        weight: () => 10,
        run: () => {
          emote("✨");
          this.act("neutral", 2);
        },
      },
      {
        id: "fidget_sleeves",
        name: "fidget_sleeves",
        weight: () => 12,
        run: () => this.act("cozy", 2),
      },
      {
        id: "sneeze",
        name: "sneeze",
        weight: () => 6,
        run: () => {
          fx.shake();
          emote("🤧");
          say("*achoo!*", "🤧", 1800);
          this.act("surprised", 1);
        },
      },
      {
        id: "balance_test",
        name: "balance_test",
        weight: () => 9,
        run: () => {
          fx.sway();
          this.act("neutral", 2);
        },
      },
      {
        id: "sigh_content",
        name: "sigh_content",
        weight: () => 10,
        run: async () => {
          this.anim.play("down", { loops: 1 });
          await sleep(1000);
          emote("💭");
          this.act("cozy", 2);
        },
      },
      {
        id: "daydream",
        name: "daydream",
        weight: () => 11,
        run: () => {
          emote("🫧");
          this.act("thinking", 2);
        },
      },
      {
        id: "dust_off",
        name: "dust_off",
        weight: () => 9,
        run: () => {
          fx.bounce();
          this.act("cozy", 2);
        },
      },
      {
        id: "arm_stretch",
        name: "arm_stretch",
        weight: () => 10,
        run: () => {
          fx.stretch();
          this.act("surprised", 1);
        },
      },
      {
        id: "brief_doze",
        name: "brief_doze",
        weight: (m) => (m.energy < 40 ? 12 : 4),
        run: async () => {
          this.anim.play("sleepy", { loops: 1 });
          await sleep(1500);
          fx.bounce();
          emote("❗");
          this.act("surprised", 1);
        },
      },
      {
        id: "check_surroundings",
        name: "check_surroundings",
        weight: () => 11,
        run: async () => {
          this.anim.play("idle", { loops: 1, mirror: true });
          await sleep(700);
          this.act("waiting", 1);
        },
      },
      {
        id: "foot_tap",
        name: "foot_tap",
        weight: () => 10,
        run: () => this.act("waiting", 2),
      },
      {
        id: "thought",
        name: "thought",
        weight: () => CHATTINESS_WEIGHT[CHATTINESS],
        run: () => this.thought(),
      },
      {
        id: "sprint",
        name: "sprint",
        weight: (m) => (m.energy > 40 ? 12 : 3),
        run: () => {
          say("Dash! 💨", "💨", 1600);
          this.act("run", 2);
        },
      },
      {
        id: "seasonal_thought",
        name: "seasonal_thought",
        weight: () => 10,
        run: async () => {
          const holiday = getHoliday();
          const season = getSeason();
          const key = holiday ?? season;
          const line = pick(key);
          say(line.t, line.e, 3500);
          this.act("cozy", 2);
        },
      },
      {
        id: "wander",
        name: "wander",
        weight: (m) => 12 + m.energy / 8,
        run: () => this.wander(),
      },
      // --- Data-Driven Multi-Step Scenes ---
      {
        id: "scene_morning_wake",
        name: "scene_morning_wake",
        isScene: true,
        weight: () => 9,
        run: () =>
          this.playScene("morning_wake", [
            { clip: "sleepy", loops: 1, emote: "🥱", bubble: { text: "*yawn*", durationMs: 1400 } },
            { clip: "cozy", loops: 1, fx: "stretch" },
            { clip: "neutral", loops: 1, bubble: { text: "Mmm, that felt nice~ ✨", durationMs: 2400 } },
          ]),
      },
      {
        id: "scene_phantom_bug",
        name: "scene_phantom_bug",
        isScene: true,
        weight: () => 8,
        run: () =>
          this.playScene("phantom_bug", [
            { clip: "idle", loops: 1, mirror: false, waitMs: 400 },
            { clip: "surprised", loops: 1, fx: "bounce", emote: "❗" },
            { clip: "thinking", loops: 2, bubble: { text: "Where did that little bug go...?", durationMs: 2200 } },
          ]),
      },
      {
        id: "scene_clumsy_stroll",
        name: "scene_clumsy_stroll",
        isScene: true,
        weight: () => 8,
        run: () =>
          this.playScene("clumsy_stroll", [
            { clip: "walkRight", loops: 1 },
            { clip: "down", loops: 1, fx: "squish", emote: "💦", bubble: { text: "Whoa, almost tripped!", durationMs: 2000 } },
            { clip: "nuzzle", loops: 2, bubble: { text: "Nobody saw that, right?", durationMs: 2200 } },
          ]),
      },
      {
        id: "scene_deep_realization",
        name: "scene_deep_realization",
        isScene: true,
        weight: () => 10,
        run: () =>
          this.playScene("deep_realization", [
            { clip: "waiting", loops: 1, emote: "..." },
            { clip: "thinking", loops: 2, emote: "💡" },
            { clip: "cozy", loops: 2, bubble: { text: "Oh! Just thought of something funny~", durationMs: 2600 } },
          ]),
      },
      {
        id: "scene_daydreamer",
        name: "scene_daydreamer",
        isScene: true,
        weight: () => 9,
        run: () =>
          this.playScene("daydreamer", [
            { clip: "thinking", loops: 2, emote: "🫧" },
            { clip: "cozy", loops: 2, fx: "sway", emote: "♪" },
            { clip: "neutral", loops: 1, bubble: { text: "Just drifted off for a second~", durationMs: 2200 } },
          ]),
      },
    ];

    // 7. Anti-Repeat Filter (Never repeat last; avoid last ~6)
    const available = behaviors.filter((b) => !this.recentBehaviors.includes(b.id));
    const candidates = available.length > 0 ? available : behaviors.filter((b) => b.id !== this.recentBehaviors[this.recentBehaviors.length - 1]);

    // 8. Weighted Selection
    const weighted = candidates.map((b) => {
      const w = Math.max(1, b.weight(m, label, idleFor));
      return { b, w };
    });
    const total = weighted.reduce((acc, item) => acc + item.w, 0);
    let r = Math.random() * total;

    let chosen = weighted[0].b;
    for (const item of weighted) {
      r -= item.w;
      if (r <= 0) {
        chosen = item.b;
        break;
      }
    }

    // 9. Update Anti-Repeat Buffer (keep last 6)
    this.recentBehaviors.push(chosen.id);
    if (this.recentBehaviors.length > 6) {
      this.recentBehaviors.shift();
    }

    logDecision(
      `decide() chose ${chosen.name} [isScene=${!!chosen.isScene}] (energy=${m.energy.toFixed(1)}, mood=${label}, recent=[${this.recentBehaviors.join(",")}])`
    );
    chosen.run(this);
  };
}
