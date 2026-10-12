// Spritesheet: 1536x1872 = 8 columns x 9 rows, each frame 192x208.
// Edit CLIPS to remap poses. `ms` is the time per frame (number or per-frame array).

export const FRAME_W = 192;
export const FRAME_H = 208;

export interface Clip {
  row: number;
  frames: number[];
  ms: number | number[];
}

export const CLIPS = {
  idle:      { row: 0, frames: [0, 1, 2, 3, 4, 5], ms: [1500, 1100, 1600, 140, 1200, 1500] }, // 3 = blink
  walkRight: { row: 1, frames: [0, 1, 2, 3, 4, 5, 6, 7], ms: 110 },
  walkLeft:  { row: 2, frames: [0, 1, 2, 3, 4, 5, 6, 7], ms: 110 },
  dance:     { row: 4, frames: [0, 1, 2, 3, 4, 5, 6, 7], ms: 150 },
  cozy:      { row: 5, frames: [0, 5, 6, 5], ms: 450 },        // hands at chest, happy/shy
  surprised: { row: 5, frames: [1], ms: 900 },                 // arms out
  down:      { row: 5, frames: [2], ms: 1200 },                // hands in pockets, looking down
  sleepy:    { row: 5, frames: [3, 4], ms: [1400, 2200] },     // drooping head, eyes closing
  waiting:   { row: 6, frames: [0, 1, 2, 3, 4, 5], ms: 450 },  // hands clasped, looking at you
  zoom:      { row: 7, frames: [0, 1, 2, 3, 4, 5], ms: 90 },   // fast run
  thinking:  { row: 8, frames: [0, 4], ms: 1100 },
  pout:      { row: 8, frames: [2, 3], ms: 900 },
  nuzzle:    { row: 8, frames: [1], ms: 1200 },                // eye closed, hand at cheek
  neutral:   { row: 8, frames: [5], ms: 1000 },
} satisfies Record<string, Clip>;

export type ClipName = keyof typeof CLIPS;

interface PlayOpts {
  loops?: number;
  mirror?: boolean;
  onDone?: () => void;
}

export class Animator {
  private clip: Clip = CLIPS.idle;
  private idx = 0;
  private timer: number | undefined;
  private loopsLeft = Infinity;
  private done?: () => void;
  private paused = false;
  name: ClipName = "idle";

  constructor(private el: HTMLElement) {}

  play(name: ClipName, opts: PlayOpts = {}) {
    window.clearTimeout(this.timer);
    this.name = name;
    this.clip = CLIPS[name];
    this.idx = 0;
    this.loopsLeft = opts.loops ?? Infinity;
    this.done = opts.onDone;
    this.el.classList.toggle("mirror", !!opts.mirror);
    this.draw();
    this.schedule();
  }

  pause() {
    this.paused = true;
    window.clearTimeout(this.timer);
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.schedule();
  }

  private draw() {
    const f = this.clip.frames[this.idx];
    this.el.style.backgroundPosition = `-${f * FRAME_W}px -${this.clip.row * FRAME_H}px`;
  }

  private delay() {
    const m = this.clip.ms;
    return Array.isArray(m) ? m[this.idx % m.length] : m;
  }

  private schedule() {
    if (this.paused) return;
    // A single still frame that loops forever needs no timer at all.
    if (this.clip.frames.length === 1 && this.loopsLeft === Infinity) return;
    this.timer = window.setTimeout(() => this.step(), this.delay());
  }

  private step() {
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
    this.draw();
    this.schedule();
  }
}
