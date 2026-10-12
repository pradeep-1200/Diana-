// User input handling: clicking, petting, dragging, hover, and context menu

import { Animator } from "./sprites";
import { Mood } from "./mood";
import { Behaviors } from "./behaviors";
import { Brain, EMOTION_CLIPS } from "./brain";
import { state, setMode, setWanderEnabled, setVisible, recordInteraction, setDragging } from "./state";
import { petEl, bubbleEl, fx, say, bar } from "./ui";
import {
  getWindowPosition,
  startDragging,
  hideWindow,
  closeWindow,
  onWindowMoved,
  saveLocalPosition,
  showNativeContextMenu,
} from "./platform";

export class InputHandler {
  private down: { x: number; y: number } | null = null;
  private dragging = false;
  private dropTimer: number | undefined;
  private hoverTimer: number | undefined;
  private posTimer: number | undefined;

  constructor(
    private anim: Animator,
    private mood: Mood,
    private behaviors: Behaviors,
    private brain: Brain
  ) {
    this.bindPointer();
    this.bindHover();
    this.bindWindowMoved();
    this.bindContextMenu();
  }

  private async onClick() {
    const now = Date.now();
    recordInteraction(now);
    state.clicks.push(now);
    while (state.clicks.length && now - state.clicks[0] > 5000) state.clicks.shift();

    if (state.mode === "sleeping") {
      this.mood.woken();
      return this.behaviors.wakeUp();
    }

    if (state.clicks.length >= 6) {
      state.clicks.length = 0;
      this.mood.annoy();
      const reply = await this.brain.respond({
        trigger: "annoyed",
        moodLabel: this.mood.label(),
        energy: this.mood.s.energy,
        hour: new Date().getHours(),
      });
      say(reply.text, reply.emote || "💢", reply.durationMs);
      fx.shake();
      return this.behaviors.act("pout", 2);
    }

    if (now - state.lastClick < 350) {
      state.lastClick = 0;
      return this.behaviors.doDance();
    }
    state.lastClick = now;

    this.mood.pet();
    const label = this.mood.label();
    const reply = await this.brain.respond({
      trigger: "click",
      moodLabel: label,
      energy: this.mood.s.energy,
      hour: new Date().getHours(),
    });
    say(reply.text, reply.emote, reply.durationMs);
    fx.squish();

    if (label === "happy" || label === "bored") {
      fx.bounce();
      this.behaviors.act("cozy", 2);
    } else if (label === "sleepy") {
      this.behaviors.act("sleepy", 1);
    } else if (label === "down" || label === "lonely") {
      this.behaviors.act("nuzzle", 1);
    } else {
      const clip = EMOTION_CLIPS[reply.emotion] || "surprised";
      this.behaviors.act(clip, 1);
    }
  }

  private async beginCarry() {
    recordInteraction();
    setMode("carried");
    this.mood.carried();
    this.anim.play("surprised");

    const reply = await this.brain.respond({
      trigger: "pickup",
      moodLabel: this.mood.label(),
      energy: this.mood.s.energy,
      hour: new Date().getHours(),
    });
    say(reply.text, reply.emote || "❗", reply.durationMs);
    this.armDropTimer(1500);
  }

  private armDropTimer(ms: number) {
    window.clearTimeout(this.dropTimer);
    this.dropTimer = window.setTimeout(() => this.dropped(), ms);
  }

  private async dropped() {
    if (state.mode !== "carried") return;
    const reply = await this.brain.respond({
      trigger: "drop",
      moodLabel: this.mood.label(),
      energy: this.mood.s.energy,
      hour: new Date().getHours(),
    });
    say(reply.text, reply.emote, reply.durationMs);
    fx.bounce();
    this.behaviors.act("cozy", 2);
  }

  private bindPointer() {
    petEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      this.down = { x: e.clientX, y: e.clientY };
      this.dragging = false;
      setDragging(false);
    });

    window.addEventListener("pointermove", (e) => {
      if (!this.down || this.dragging) return;
      if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 5) {
        this.dragging = true;
        setDragging(true);
        this.down = null;
        this.beginCarry();
        startDragging();
      }
    });

    window.addEventListener("pointerup", () => {
      if (this.down && !this.dragging) this.onClick();
      this.down = null;
      this.dragging = false;
      setDragging(false);
    });
  }

  private bindHover() {
    petEl.addEventListener("pointerenter", () => {
      window.clearTimeout(this.hoverTimer);
      this.hoverTimer = window.setTimeout(async () => {
        const now = Date.now();
        if (state.mode === "idle" && now - state.lastHover > 25000) {
          state.lastHover = now;
          const reply = await this.brain.respond({
            trigger: "hover",
            moodLabel: this.mood.label(),
            energy: this.mood.s.energy,
            hour: new Date().getHours(),
          });
          say(reply.text, reply.emote || "👀", reply.durationMs);
          this.behaviors.act("waiting", 2);
        }
      }, 1000);
    });

    petEl.addEventListener("pointerleave", () => window.clearTimeout(this.hoverTimer));
  }

  private bindWindowMoved() {
    onWindowMoved(() => {
      window.clearTimeout(this.posTimer);
      this.posTimer = window.setTimeout(async () => {
        const p = await getWindowPosition();
        saveLocalPosition(p.x, p.y);
      }, 600);
      if (state.mode === "carried") this.armDropTimer(220);
    });
  }

  private showStats() {
    const s = this.mood.s;
    say(
      `Energy ${bar(s.energy)}  Mood ${bar(s.happiness)}\nLove ${bar(s.affection)}  Bored ${bar(s.boredom)}`,
      undefined,
      5000
    );
    bubbleEl.style.whiteSpace = "pre-line";
    window.setTimeout(() => (bubbleEl.style.whiteSpace = ""), 5200);
  }

  private hidePet() {
    setVisible(false);
    this.anim.pause();
    hideWindow();
  }

  private bindContextMenu() {
    petEl.addEventListener("contextmenu", async (e) => {
      e.preventDefault();
      await showNativeContextMenu([
        { id: "dance", text: "Dance ♪", action: () => this.behaviors.doDance() },
        {
          id: "sleep",
          text: state.mode === "sleeping" ? "Wake up" : "Take a nap",
          action: () => this.behaviors.toggleSleep(),
        },
        {
          id: "wander",
          text: state.wanderEnabled ? "Stay here (stop wandering)" : "Let her wander",
          action: () => {
            const next = !state.wanderEnabled;
            setWanderEnabled(next);
            if (!next && state.mode === "walking") this.behaviors.toIdle();
            say(next ? "Okay, I'll explore a bit!" : "Okay, I'll stay right here.");
          },
        },
        { id: "feel", text: "How is she feeling?", action: () => this.showStats() },
        { item: "Separator" as const },
        { id: "hide", text: "Hide (bring back from tray)", action: () => this.hidePet() },
        {
          id: "quit",
          text: "Quit",
          action: () => {
            this.mood.save();
            closeWindow();
          },
        },
      ]);
    });
  }
}
