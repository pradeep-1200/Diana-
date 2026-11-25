// Spritesheet A (main): 1536x1872 = 8 cols x 9 rows, 192x208 per frame.
// Spritesheet B (extras): 1536x1536 = 8 cols x 6 rows, 192x256 per frame.
// The CSS sprite box is always 192x256. Main-sheet frames are bottom-aligned
// inside it (the 48 px of headroom above are transparent on the main sheet).
// Edit CLIPS / EXTRAS_CLIPS to remap poses.

export const MAIN_FRAME_W = 192;
export const MAIN_FRAME_H = 208; // sprite pixel height on the main sheet
export const SPRITE_BOX_W = 192; // fixed CSS display size
export const SPRITE_BOX_H = 256; // fixed CSS display size (48 px copter headroom)
export const EXTRAS_FRAME_H = 256;

export interface Clip {
  row: number;
  frames: number[];
  ms: number | number[];
}

// ── Main spritesheet clips ────────────────────────────────────────────────────

export const CLIPS = {
  idle:      { row: 0, frames: [0, 1, 2, 3, 4, 5], ms: [1500, 1100, 1600, 140, 1200, 1500] },
  walkRight: { row: 1, frames: [0, 1, 2, 3, 4, 5, 6, 7], ms: 110 },
  walkLeft:  { row: 2, frames: [0, 1, 2, 3, 4, 5, 6, 7], ms: 110 },
  run:       { row: 3, frames: [0, 1, 2, 3, 4, 5, 6, 7], ms: 70 },  // faster sprint (row 3)
  dance:     { row: 4, frames: [0, 1, 2, 3, 4, 5, 6, 7], ms: 150 },
  cozy:      { row: 5, frames: [0, 5, 6, 5], ms: 450 },
  surprised: { row: 5, frames: [1], ms: 900 },
  down:      { row: 5, frames: [2], ms: 1200 },
  sleepy:    { row: 5, frames: [3, 4], ms: [1400, 2200] },
  waiting:   { row: 6, frames: [0, 1, 2, 3, 4, 5], ms: 450 },
  zoom:      { row: 7, frames: [0, 1, 2, 3, 4, 5], ms: 90 },
  thinking:  { row: 8, frames: [0, 4], ms: 1100 },
  pout:      { row: 8, frames: [2, 3], ms: 900 },
  nuzzle:    { row: 8, frames: [1], ms: 1200 },
  neutral:   { row: 8, frames: [5], ms: 1000 },
  sly:       { row: 8, frames: [3], ms: 1000 },   // mischievous half-smile
} satisfies Record<string, Clip>;

// ── Extras spritesheet clips ──────────────────────────────────────────────────

export const EXTRAS_CLIPS = {
  hang:    { row: 0, frames: [0, 1, 2, 3, 4, 5, 6, 7], ms: 140, loop: true },
  fall:    { row: 1, frames: [0, 1, 2, 3], ms: 70, loop: true },
  land:    { row: 2, frames: [0, 1, 2, 3, 4, 5], ms: 90, loop: false },
  deploy:  { row: 3, frames: [0, 1, 2, 3, 4, 5, 6, 7], ms: [110, 110, 140, 110, 120, 90, 80, 70], loop: false },
  fly:     { row: 4, frames: [0, 1, 2, 3, 4, 5, 6, 7], ms: 60, loop: true },
  retract: { row: 5, frames: [0, 1, 2, 3, 4, 5], ms: [140, 140, 140, 110, 110, 160], loop: false },
} satisfies Record<string, Clip & { loop: boolean }>;

export type ClipName = keyof typeof CLIPS;
export type ExtrasClipName = keyof typeof EXTRAS_CLIPS;

interface PlayOpts {
  loops?: number;
  mirror?: boolean;
  onDone?: () => void;
}

// ── Animator ─────────────────────────────────────────────────────────────────

export class Animator {
  private clip: Clip = CLIPS.idle;
  private idx = 0;
  private timer: number | undefined;
  private loopsLeft = Infinity;
  private done?: () => void;
  private paused = false;
  private onExtras = false;

  name: ClipName = "idle";

  constructor(private el: HTMLElement) {
    // Sprite element starts on the main sheet
    this._applySheet(false);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  play(name: ClipName, opts: PlayOpts = {}) {
    window.clearTimeout(this.timer);
    this.paused = false;
    this.name = name;
    this.clip = CLIPS[name];
    this.idx = 0;
    this.loopsLeft = opts.loops ?? Infinity;
    this.done = opts.onDone;
    this.el.classList.toggle("mirror", !!opts.mirror);
    if (this.onExtras) this._applySheet(false);
    this._draw();
    this._schedule();
  }

  playExtras(name: ExtrasClipName, opts: { loops?: number; mirror?: boolean; onDone?: () => void } = {}) {
    window.clearTimeout(this.timer);
    this.paused = false;
    this.clip = EXTRAS_CLIPS[name];
    this.idx = 0;
    this.loopsLeft = opts.loops ?? (EXTRAS_CLIPS[name].loop ? Infinity : 1);
    this.done = opts.onDone;
    this.el.classList.toggle("mirror", !!opts.mirror);
    if (!this.onExtras) this._applySheet(true);
    this._drawExtras();
    this._schedule();
  }

  pause() {
    this.paused = true;
    window.clearTimeout(this.timer);
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this._schedule();
  }

  get isOnExtras() {
    return this.onExtras;
  }

  /** Set mirror flag without restarting the current clip (used by flight tilt). */
  setMirror(mirrored: boolean) {
    this.el.classList.toggle("mirror", mirrored);
  }

  /** Apply a CSS rotation tilt (degrees) to the sprite for copter lean. */
  setTilt(degrees: number) {
    if (Math.abs(degrees) < 0.5) {
      this.el.style.rotate = "";
    } else {
      this.el.style.rotate = `${degrees.toFixed(1)}deg`;
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Switch background-image and background-size between the two sheets. */
  private _applySheet(extras: boolean) {
    this.onExtras = extras;
    if (extras) {
      this.el.style.backgroundImage = "url('/extras.png')";
      // 8 cols × 256 px tall = 1536×1536
      this.el.style.backgroundSize = `${MAIN_FRAME_W * 8}px ${EXTRAS_FRAME_H * 6}px`;
    } else {
      this.el.style.backgroundImage = "url('/spritesheet.png')";
      // 8 cols × 208 px tall row, but sprite box is 256; offset Y by 48 px headroom
      // background-size covers the full sheet natural size
      this.el.style.backgroundSize = `${MAIN_FRAME_W * 8}px ${MAIN_FRAME_H * 9}px`;
    }
  }

  /** Draw current frame from main sheet.
   * Issue 1 fix: the sprite element now lives inside #sprite-wrapper which clips to 208px.
   * No headroom offset needed — bgY = -(row * 208) positions correctly within the 1872px sheet.
   * The old +48px headroom was a workaround for the unclipped 256px box; now removed. */
  private _draw() {
    const f = this.clip.frames[this.idx];
    const bgX = -(f * MAIN_FRAME_W);
    const bgY = -(this.clip.row * MAIN_FRAME_H);
    this.el.style.backgroundPosition = `${bgX}px ${bgY}px`;
  }

  private _drawExtras() {
    const f = this.clip.frames[this.idx];
    const bgX = -(f * MAIN_FRAME_W);
    const bgY = -(this.clip.row * EXTRAS_FRAME_H);
    this.el.style.backgroundPosition = `${bgX}px ${bgY}px`;
  }

  private _delay() {
    const m = this.clip.ms;
    return Array.isArray(m) ? m[this.idx % m.length] : m;
  }

  private _schedule() {
    if (this.paused) return;
    if (this.clip.frames.length === 1 && this.loopsLeft === Infinity) return;
    this.timer = window.setTimeout(() => this._step(), this._delay());
  }

  private _step() {
    this.idx++;
    if (this.idx >= this.clip.frames.length) {
      this.loopsLeft--;
      if (this.loopsLeft <= 0) {
        this.idx = this.clip.frames.length - 1;
        const d = this.done;
        this.done = undefined;
        d?.();
        return;
      }
      this.idx = 0;
    }
    if (this.onExtras) this._drawExtras();
    else this._draw();
    this._schedule();
  }
}
