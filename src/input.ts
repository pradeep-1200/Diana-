// User input handling: clicking, petting, dragging (Rust-owned), hover, context menu.
// Double-click detection works in all modes because JS owns pointer events on the WebView;
// Rust only owns window *movement*, not input dispatch.

import { Animator } from "./sprites";
import { Mood } from "./mood";
import { Behaviors } from "./behaviors";
import { Brain, EMOTION_CLIPS } from "./brain";
import { state, setMode, setWanderEnabled, setVisible, recordInteraction, setDragging } from "./state";
import { petEl, bubbleEl, fx, say, bar, syncHitRects } from "./ui";
import {
  getWindowPosition,
  getWindowSize,
  getCurrentWorkArea,
  hideWindow,
  closeWindow,
  onWindowMoved,
  saveLocalPosition,
  showNativeContextMenu,
  setDragState,
  dbLogEvent,
  openSettingsWindow,
  beginDrag,
  endDrag,
  onDragEnded,
  logDecision,
} from "./platform";

import { ActivityMonitor } from "./activity";

export class InputHandler {
  private down: { x: number; y: number; clientX: number; clientY: number } | null = null;
  private dragging = false;
  private hoverTimer: number | undefined;
  private posTimer: number | undefined;

  // Grace timer after drag-ended while above floor → switch to fall if not clicked again
  private hangGraceTimer: number | undefined;
  private hangGraceMs = 1500; // ms before grace expires and fall starts

  constructor(
    private anim: Animator,
    private mood: Mood,
    private behaviors: Behaviors,
    private brain: Brain,
    private activityMonitor: ActivityMonitor
  ) {
    this.bindPointer();
    this.bindHover();
    this.bindWindowMoved();
    this.bindContextMenu();
    this.bindPhysicsEvents();
  }

  // ── Click / double-click ───────────────────────────────────────────────────

  private async onClick() {
    const now = Date.now();
    recordInteraction(now);
    state.clicks.push(now);
    while (state.clicks.length && now - state.clicks[0] > 5000) state.clicks.shift();

    // While hanging: double-click arms copter!
    if (state.mode === "hanging" || state.mode === "falling") {
      this.behaviors.cancelHang();
      window.clearTimeout(this.hangGraceTimer);

      if (now - state.lastClick < 450 && state.mode === "hanging") {
        state.lastClick = 0;
        return this.behaviors.deployFlight();
      }

      if (state.mode === "hanging") {
        say("Whoa! I'm floating! Double-click for copter~", "😮", 1800);
      }
      state.lastClick = now;
      recordInteraction(now);
      return;
    }

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
    dbLogEvent("pet");
    if (this.mood.s.totalPets === 100) {
      say("100 pats! You're really the best! ❤", "✨", 5000);
      fx.bounce();
      return this.behaviors.act("cozy", 3);
    }

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

  // ── Pickup / carry / drop ──────────────────────────────────────────────────

  private async beginCarry() {
    recordInteraction();
    setMode("carried");
    this.mood.carried();
    dbLogEvent("carry");
    this.anim.play("surprised");

    const reply = await this.brain.respond({
      trigger: "pickup",
      moodLabel: this.mood.label(),
      energy: this.mood.s.energy,
      hour: new Date().getHours(),
    });
    say(reply.text, reply.emote || "❗", reply.durationMs);
  }

  private async dropped(aboveFloor: boolean, wx: number, wy: number) {
    if (state.mode !== "carried" && state.mode !== "hanging") return;
    dbLogEvent("drop");

    if (aboveFloor) {
      // Start hang sequence
      this.behaviors.startHang(wx, wy);
    } else {
      // Landed on the floor directly
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
  }

  // ── Pointer binding ────────────────────────────────────────────────────────

  private bindPointer() {
    petEl.addEventListener("pointerdown", async (e) => {
      if (e.button !== 0) return;
      this.down = { x: e.screenX, y: e.screenY, clientX: e.clientX, clientY: e.clientY };
      this.dragging = false;

      // If currently hanging: start grace timer for double-click / copter
      if (state.mode === "hanging") {
        window.clearTimeout(this.hangGraceTimer);
        // A fresh pointerdown during hang resets the grace window
      }
    });

    window.addEventListener("pointermove", async (e) => {
      if (!this.down || this.dragging) return;
      if (Math.hypot(e.screenX - this.down.x, e.screenY - this.down.y) > 5) {
        // Guard: do not start drag while in busy/pout/act mode
        if (state.mode === "busy" || state.mode === "dancing") return;

        this.dragging = true;
        setDragging(true);
        this.down = null;
        window.clearTimeout(this.hangGraceTimer);

        // Read window metrics for Rust
        const [pos, size, wa] = await Promise.all([
          getWindowPosition(),
          getWindowSize(),
          getCurrentWorkArea(),
        ]);
        const scale = wa ? wa.scaleFactor : (state.scaleFactor || 1);
        const floor = wa ? wa.y + wa.height : state.floorY;

        // CRITICAL FIX (Issue 0): e.screenX/Y are LOGICAL CSS pixels in the WebView.
        // getWindowPosition() returns PHYSICAL pixels from win.outerPosition().
        // At 125% DPI (scale=1.25), raw e.screenX - pos.x is 25% too small,
        // causing the window to teleport far off-screen on drag start.
        // Fix: convert cursor to physical px by multiplying by scaleFactor.
        const cursorPhysX = Math.round(e.screenX * scale);
        const cursorPhysY = Math.round(e.screenY * scale);
        const offX = cursorPhysX - pos.x;
        const offY = cursorPhysY - pos.y;
        const winH = size.height;

        logDecision(
          `beginDrag: scale=${scale} cursorLogical=(${e.screenX},${e.screenY}) cursorPhys=(${cursorPhysX},${cursorPhysY}) winPos=(${pos.x},${pos.y}) off=(${offX},${offY}) winH=${winH} floor=${floor}`
        );

        setDragState(true); // legacy compat
        await beginDrag(offX, offY, floor, winH);
        this.beginCarry();
      }
    });

    window.addEventListener("pointerup", async () => {
      const wasDown = !!this.down;
      const wasJustClicking = wasDown && !this.dragging;
      this.down = null;

      if (wasJustClicking) {
        this.onClick();
      }

      if (this.dragging) {
        this.dragging = false;
        setDragging(false);
        setDragState(false);
        // Tell Rust to end drag (Rust may have already done so via button-check).
        // endDrag() is safe to call even after Rust already ended it.
        endDrag();
      } else {
        setDragging(false);
        setDragState(false);
      }
    });
  }

  // ── Physics events ─────────────────────────────────────────────────────────

  /** "drag-ended" fires from Rust when mouse button is released (or failsafe). */
  private bindPhysicsEvents() {
    onDragEnded(async ({ above_floor, window_x, window_y }) => {
      if (!this.dragging && state.mode !== "carried") return; // stale event
      this.dragging = false;
      setDragging(false);
      setDragState(false);
      await this.dropped(above_floor, window_x, window_y);
    });
  }

  // ── Hover ──────────────────────────────────────────────────────────────────

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

  // ── Window moved ───────────────────────────────────────────────────────────

  private bindWindowMoved() {
    onWindowMoved(() => {
      window.clearTimeout(this.posTimer);
      this.posTimer = window.setTimeout(async () => {
        const p = await getWindowPosition();
        saveLocalPosition(p.x, p.y);
      }, 600);
    });
  }

  // ── Context menu ───────────────────────────────────────────────────────────

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
        {
          id: "dnd",
          text: state.dndEnabled ? "Disable Do Not Disturb" : "Do Not Disturb (silent & hidden)",
          action: () => this.activityMonitor.toggleDnd(),
        },
        { item: "Separator" as const },
        { id: "settings", text: "Settings...", action: () => openSettingsWindow() },
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
