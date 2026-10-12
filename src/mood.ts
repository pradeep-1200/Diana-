// Tiny "inner life": four numbers (0-100) drifting over time and persisted in SQLite.

import { dbGetMood, dbSaveMood, dbImportLocalStorage, MoodRecord } from "./platform";

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
  private dirty = false;

  constructor() {
    this.s = this.loadLocal();
    this.catchUp();
  }

  private loadLocal(): MoodState {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return { ...DEFAULT, ...JSON.parse(raw) };
    } catch {}
    return { ...DEFAULT, lastSeen: Date.now() };
  }

  async init(): Promise<void> {
    try {
      // 1. One-time import check from localStorage
      const localRaw = localStorage.getItem(KEY);
      const localPos = localStorage.getItem("diana.pos");
      let localMood: MoodRecord | null = null;
      if (localRaw) {
        try {
          localMood = JSON.parse(localRaw);
        } catch {}
      }
      await dbImportLocalStorage(localMood, localPos);

      // 2. Load latest from SQLite
      const fromDb = await dbGetMood();
      if (fromDb) {
        this.s = {
          energy: fromDb.energy,
          happiness: fromDb.happiness,
          affection: fromDb.affection,
          boredom: fromDb.boredom,
          lastSeen: fromDb.last_seen || Date.now(),
          totalPets: fromDb.total_pets || 0,
        };
      }
    } catch (err) {
      console.warn("Failed to load mood from SQLite:", err);
    }
    this.catchUp();
  }

  save() {
    this.s.lastSeen = Date.now();
    this.dirty = true;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.s));
    } catch {}
  }

  /**
   * Coalesced disk flush: writes dirty mood state to SQLite.
   * Called during the minute clock and upon hide/exit.
   */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    await dbSaveMood({
      energy: this.s.energy,
      happiness: this.s.happiness,
      affection: this.s.affection,
      boredom: this.s.boredom,
      last_seen: this.s.lastSeen,
      total_pets: this.s.totalPets,
    });
  }

  private recentDanceTimestamps: number[] = [];
  dizzyUntil = 0;

  /** Apply what happened while the app was closed. */
  private catchUp() {
    const mins = Math.min(12 * 60, (Date.now() - this.s.lastSeen) / 60000);
    this.awayMinutes = mins;
    if (mins < 1) return;
    const s = this.s;
    s.energy = clamp(s.energy + Math.min(60, mins * 0.5)); // she rested
    if (mins >= 30) {
      // On startup after being closed >= 30 min, restore energy to at least 60
      s.energy = Math.max(s.energy, 60);
    }
    s.boredom = clamp(s.boredom + Math.min(50, mins * 0.15));
    s.affection = clamp(s.affection - Math.min(12, mins * 0.02));
    this.save();
  }

  /** Call once per minute. */
  tick(minutes: number, sleeping: boolean, userActive = false) {
    const s = this.s;
    if (sleeping) {
      // Sleep recovers ~3/min; she wakes on her own at ~70
      s.energy = clamp(s.energy + 3.0 * minutes);
    } else {
      // Awake drain <= ~0.1/min (0.08/min)
      s.energy = clamp(s.energy - 0.08 * minutes);
      // Floor of ~25 while user is active, so she can look tired without force-napping
      if (userActive && s.energy < 25) {
        s.energy = 25;
      }
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

  isDizzy(): boolean {
    return Date.now() < this.dizzyUntil;
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
  danced(): { ok: boolean; dizzyNow: boolean } {
    const now = Date.now();
    if (now < this.dizzyUntil) {
      return { ok: false, dizzyNow: true };
    }
    this.recentDanceTimestamps = this.recentDanceTimestamps.filter((t) => now - t < 45000);
    this.recentDanceTimestamps.push(now);

    const s = this.s;
    s.energy = clamp(s.energy - 0.5); // A dance costs ~0.5
    s.happiness = clamp(s.happiness + 4);
    s.boredom = clamp(s.boredom - 20);
    this.save();

    if (this.recentDanceTimestamps.length >= 2) {
      // After 2 dances in a row she says she's dizzy and refuses for ~2 min
      this.dizzyUntil = now + 120000;
      return { ok: true, dizzyNow: true };
    }
    return { ok: true, dizzyNow: false };
  }
  carried() {
    this.s.boredom = clamp(this.s.boredom - 5);
    this.s.happiness = clamp(this.s.happiness + 1);
  }
  woken() {
    this.s.happiness = clamp(this.s.happiness - 2);
  }
}
