// Tiny "inner life": four numbers (0-100) that drift over time and react to you.
// Persisted in localStorage for now; we'll move this to SQLite in the memory phase.

const KEY = "diana.mood.v1";

export interface MoodState {
  energy: number;
  happiness: number;
  affection: number;
  boredom: number;
  lastSeen: number;
  totalPets: number;
}

export type MoodLabel = "sleepy" | "bored" | "lonely" | "happy" | "content" | "down";

const DEFAULT: MoodState = {
  energy: 80,
  happiness: 60,
  affection: 50,
  boredom: 20,
  lastSeen: Date.now(),
  totalPets: 0,
};

const clamp = (v: number) => Math.max(0, Math.min(100, v));

export class Mood {
  s: MoodState;
  awayMinutes = 0;

  constructor() {
    this.s = this.load();
    this.catchUp();
  }

  private load(): MoodState {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return { ...DEFAULT, ...JSON.parse(raw) };
    } catch {}
    return { ...DEFAULT, lastSeen: Date.now() };
  }

  save() {
    this.s.lastSeen = Date.now();
    try {
      localStorage.setItem(KEY, JSON.stringify(this.s));
    } catch {}
  }

  /** Apply what happened while the app was closed. */
  private catchUp() {
    const mins = Math.min(12 * 60, (Date.now() - this.s.lastSeen) / 60000);
    this.awayMinutes = mins;
    if (mins < 1) return;
    const s = this.s;
    s.energy = clamp(s.energy + Math.min(60, mins * 0.5)); // she rested
    s.boredom = clamp(s.boredom + Math.min(50, mins * 0.15));
    s.affection = clamp(s.affection - Math.min(12, mins * 0.02));
    this.save();
  }

  /** Call once per minute. */
  tick(minutes: number, sleeping: boolean) {
    const s = this.s;
    if (sleeping) {
      s.energy = clamp(s.energy + 1.4 * minutes);
    } else {
      s.energy = clamp(s.energy - 0.2 * minutes);
      s.boredom = clamp(s.boredom + 0.7 * minutes);
    }
    s.affection = clamp(s.affection - 0.02 * minutes);
    const target =
      55 + (s.affection - 50) * 0.3 - (s.boredom > 60 ? (s.boredom - 60) * 0.5 : 0) - (s.energy < 25 ? 10 : 0);
    s.happiness = clamp(s.happiness + (target - s.happiness) * Math.min(1, 0.05 * minutes));
  }

  label(): MoodLabel {
    const s = this.s;
    if (s.energy < 20) return "sleepy";
    if (s.boredom > 75) return "bored";
    if (s.affection < 25) return "lonely";
    if (s.happiness > 72) return "happy";
    if (s.happiness < 35) return "down";
    return "content";
  }

  // --- events -------------------------------------------------------------
  pet() {
    const s = this.s;
    s.happiness = clamp(s.happiness + 6);
    s.affection = clamp(s.affection + 1.5);
    s.boredom = clamp(s.boredom - 15);
    s.totalPets++;
    this.save();
  }
  annoy() {
    this.s.happiness = clamp(this.s.happiness - 6);
    this.s.affection = clamp(this.s.affection - 1);
    this.save();
  }
  danced() {
    const s = this.s;
    s.energy = clamp(s.energy - 3);
    s.happiness = clamp(s.happiness + 4);
    s.boredom = clamp(s.boredom - 20);
    this.save();
  }
  carried() {
    this.s.boredom = clamp(this.s.boredom - 5);
    this.s.happiness = clamp(this.s.happiness + 1);
  }
  woken() {
    this.s.happiness = clamp(this.s.happiness - 2);
  }
}
