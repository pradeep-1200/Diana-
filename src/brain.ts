import type { ClipName } from "./sprites";
import { Line, pick, timeGreetingKey } from "./lines";

export type Emotion =
  | "happy"
  | "sad"
  | "curious"
  | "sleepy"
  | "annoyed"
  | "shy"
  | "excited"
  | "neutral";

/**
 * Single source of truth mapping each high-level Emotion to a spritesheet animation clip.
 */
export const EMOTION_CLIPS: Record<Emotion, ClipName> = {
  happy: "cozy",
  sad: "down",
  curious: "thinking",
  sleepy: "sleepy",
  annoyed: "pout",
  shy: "nuzzle",
  excited: "surprised",
  neutral: "neutral",
};

export interface MessageHistory {
  role: "user" | "assistant";
  text: string;
}

export interface BrainContext {
  trigger: string;
  moodLabel: string;
  energy: number;
  userName?: string;
  hour: number;
  awayMinutes?: number;
  userMessage?: string;
  history?: MessageHistory[];
  extra?: Record<string, unknown>;
}

export interface BrainReply {
  text: string;
  emotion: Emotion;
  emote?: string;
  durationMs?: number;
}

export interface Brain {
  respond(ctx: BrainContext): Promise<BrainReply>;
}

/**
 * Scripted brain implementation wrapping deterministic lines and personality rules.
 */
export class ScriptedBrain implements Brain {
  userName = "";

  setUserName(name: string) {
    this.userName = name.trim();
  }

  async respond(ctx: BrainContext): Promise<BrainReply> {
    const activeName = ctx.userName?.trim() || this.userName;
    const { key, emotion } = this.resolveTrigger(ctx);
    const line: Line = pick(key);
    let text = line.t;

    // Substitute template tags if name is available
    if (text.includes("{name}")) {
      text = text.replace(/\{name\}/g, activeName || "");
    } else if (
      activeName &&
      Math.random() < 0.22 &&
      (ctx.trigger === "click" || ctx.trigger === "thought" || ctx.trigger === "timeGreeting")
    ) {
      // Naturally address by name occasionally
      text = `${text} ${activeName}~`;
    }

    const durationMs = 2200 + text.length * 60;
    return {
      text,
      emotion,
      emote: line.e,
      durationMs,
    };
  }

  private resolveTrigger(ctx: BrainContext): { key: string; emotion: Emotion } {
    switch (ctx.trigger) {
      case "click": {
        switch (ctx.moodLabel) {
          case "happy": return { key: "clickHappy", emotion: "happy" };
          case "sleepy": return { key: "clickSleepy", emotion: "sleepy" };
          case "down": return { key: "clickDown", emotion: "shy" };
          case "lonely": return { key: "clickLonely", emotion: "shy" };
          case "bored": return { key: "clickBored", emotion: "happy" };
          default: return { key: "clickContent", emotion: "neutral" };
        }
      }
      case "annoyed": return { key: "annoyed", emotion: "annoyed" };
      case "dance": return { key: "dance", emotion: "happy" };
      case "yawn": return { key: "yawn", emotion: "sleepy" };
      case "sleeping": return { key: "sleeping", emotion: "sleepy" };
      case "wake": return { key: "wake", emotion: "happy" };
      case "timeGreeting": return { key: timeGreetingKey(ctx.hour), emotion: "happy" };
      case "pickup": return { key: "pickup", emotion: "excited" };
      case "drop": return { key: "drop", emotion: "happy" };
      case "hover": return { key: "hover", emotion: "curious" };
      case "breakTime": return { key: "breakTime", emotion: "neutral" };
      case "lateNight": return { key: "lateNight", emotion: "curious" };
      case "returnShort": return { key: "returnShort", emotion: "happy" };
      case "returnLong": return { key: "returnLong", emotion: "happy" };
      case "welcomeBack": return { key: "welcomeBack", emotion: "happy" };
      case "lowBattery": return { key: "lowBattery", emotion: "annoyed" };
      case "pluggedIn": return { key: "pluggedIn", emotion: "excited" };
      case "unplugged": return { key: "unplugged", emotion: "curious" };
      case "ponder": return { key: "thoughtContent", emotion: "curious" };
      case "thought": {
        switch (ctx.moodLabel) {
          case "happy": return { key: "thoughtHappy", emotion: "happy" };
          case "bored": return { key: "thoughtBored", emotion: "neutral" };
          case "down": return { key: "thoughtDown", emotion: "sad" };
          case "lonely": return { key: "thoughtLonely", emotion: "sad" };
          case "sleepy": return { key: "thoughtSleepy", emotion: "sleepy" };
          default: return { key: "thoughtContent", emotion: "neutral" };
        }
      }
      default: {
        return { key: ctx.trigger in (window as unknown as { LINES?: unknown }) ? ctx.trigger : "thoughtContent", emotion: "neutral" };
      }
    }
  }
}

/**
 * Composite brain that attempts primary execution (e.g. LLM) and falls back
 * to a guaranteed fallback (e.g. ScriptedBrain) upon failure or timeout.
 */
export class FallbackBrain implements Brain {
  constructor(
    private primary: Brain,
    private fallback: Brain,
    private timeoutMs = 3000
  ) {}

  async respond(ctx: BrainContext): Promise<BrainReply> {
    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Primary brain timed out")), this.timeoutMs)
      );
      return await Promise.race([this.primary.respond(ctx), timeoutPromise]);
    } catch (err) {
      console.warn("Primary brain failed or timed out, failing over to secondary:", err);
      return this.fallback.respond(ctx);
    }
  }
}
