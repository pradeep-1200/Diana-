// Decision loop, wandering physics, and autonomous pet behaviors

import { Animator, ClipName } from "./sprites";
import { Mood } from "./mood";
import { Brain, EMOTION_CLIPS } from "./brain";
import { state, setMode, nextWalkToken, recordInteraction, Mode } from "./state";
import { SCALE, WALK_SPEED } from "./config";
import { fx, emote, say } from "./ui";
import {
  getCurrentWorkArea,
  getAllMonitors,
  getWindowPosition,
  getWindowSize,
  setWindowPosition,
} from "./platform";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const hour = () => new Date().getHours();
export const isLateNight = () => hour() < 5;

let decideTimer: number | undefined;

export class Behaviors {
  constructor(
    private anim: Animator,
    private mood: Mood,
    private brain: Brain
  ) {}

  toIdle = () => {
    setMode("idle");
    this.anim.play("idle");
  };

  act(name: ClipName, loops: number, newMode: Mode = "busy") {
    nextWalkToken();
    setMode(newMode);
    this.anim.play(name, { loops, onDone: this.toIdle });
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
    this.mood.danced();

    const m = this.mood.s;
    const reply = await this.brain.respond({
      trigger: "dance",
      moodLabel: this.mood.label(),
      energy: m.energy,
      hour: hour(),
    });
    say(reply.text, reply.emote || "♪", reply.durationMs);
    fx.bounce();
    this.act("dance", 3, "dancing");
  }

  goToSleep = () => {
    nextWalkToken();
    setMode("sleeping");
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

  wander = async () => {
    if (!state.wanderEnabled) return;
    const token = nextWalkToken();
    const wa = await getCurrentWorkArea();
    if (!wa || token !== state.walkToken) return;
    const [pos, size] = await Promise.all([
      getWindowPosition(),
      getWindowSize(),
    ]);

    const pad = (size.width - 192 * SCALE * wa.scaleFactor) / 2; // empty window margin beside the sprite
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
    while (token === state.walkToken && Math.abs(target - x) > 2) {
      await sleep(33);
      if (token !== state.walkToken) return;
      const now = performance.now();
      x += d * WALK_SPEED * wa.scaleFactor * ((now - last) / 1000);
      last = now;
      if ((d > 0 && x > target) || (d < 0 && x < target)) x = target;
      await setWindowPosition(x, pos.y);
    }
    if (token === state.walkToken) this.toIdle();
  };

  scheduleDecide() {
    window.clearTimeout(decideTimer);
    decideTimer = window.setTimeout(
      () => this.decide(),
      state.mode === "sleeping" ? rand(9000, 16000) : rand(6000, 16000)
    );
  }

  decide = async () => {
    this.scheduleDecide();
    if (!state.visible || state.dndEnabled) return;
    const m = this.mood.s;
    const idleFor = Date.now() - state.lastInteraction;

    if (state.mode === "sleeping") {
      if (m.energy >= 90 && !isLateNight()) return this.wakeUp(true);
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
    if (state.mode !== "idle") return;

    const tired =
      m.energy < 15 ||
      (isLateNight() && idleFor > 8 * 60000) ||
      (idleFor > 45 * 60000 && m.energy < 45);
    if (tired) return this.startNap();

    const options: [() => void, number][] = [
      [() => {}, 20],
      [() => this.thought(), 28],
      [() => this.wander(), 12 + m.energy / 8],
      [() => this.doDance(), 3 + (m.happiness > 65 ? 10 : 0)],
      [() => this.ponder(), 10],
      [() => this.seekAttention(), m.boredom > 60 ? 25 : 3],
    ];

    const total = options.reduce((a, [, w]) => a + w, 0);
    let r = Math.random() * total;
    for (const [fn, w] of options) {
      r -= w;
      if (r <= 0) return fn();
    }
  };
}
