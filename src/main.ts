import { Animator } from "./sprites";
import { Mood } from "./mood";
import { ScriptedBrain } from "./brain";
import { Behaviors, sleep, hour, isLateNight } from "./behaviors";
import { InputHandler } from "./input";
import { state, setVisible } from "./state";
import { SCALE, applyScale } from "./config";
import { spriteEl, say, syncHitRects, askInlineInput } from "./ui";
import {
  getCurrentWorkArea,
  getWindowSize,
  setWindowPosition,
  loadLocalPosition,
  onTrayAction,
  onPetVisible,
  focusWindow,
  dbGetFact,
  dbSetFact,
  dbLogEvent,
  dbRecordActivity,
  dbGetStatsSummary,
} from "./platform";

import { ActivityMonitor } from "./activity";

// Initialize styling
applyScale(SCALE);

// Core instances
const anim = new Animator(spriteEl);
const mood = new Mood();
const brain = new ScriptedBrain();
const behaviors = new Behaviors(anim, mood, brain);
const activityMonitor = new ActivityMonitor(anim, mood, brain, behaviors);
new InputHandler(anim, mood, behaviors, brain, activityMonitor);

// Tray event listeners from Rust
onTrayAction((action) => {
  if (action === "dance") behaviors.doDance();
  if (action === "sleep") behaviors.toggleSleep();
  if (action === "dnd") activityMonitor.toggleDnd();
});

onPetVisible((visible) => {
  setVisible(visible);
  if (visible) {
    anim.resume();
  } else {
    anim.pause();
    mood.flush();
    dbLogEvent("session_hide");
  }
});

// Slow background clock (once per minute)
setInterval(async () => {
  mood.tick(1, state.mode === "sleeping");
  mood.save();
  await mood.flush();

  const todayStr = new Date().toISOString().slice(0, 10);
  await dbRecordActivity(todayStr, hour(), 1, 0);

  if (!state.visible || state.mode !== "idle" || state.dndEnabled) return;

  const now = Date.now();
  if (isLateNight() && now - state.lastLateNight > 60 * 60000) {
    state.lastLateNight = now;
    const reply = await brain.respond({
      trigger: "lateNight",
      moodLabel: mood.label(),
      energy: mood.s.energy,
      hour: hour(),
    });
    say(reply.text, reply.emote, 5000);
    behaviors.act("thinking", 3);
  }
}, 60000);

activityMonitor.start();

// Initial placement and greeting sequence
async function placeInitially() {
  const [wa, size] = await Promise.all([
    getCurrentWorkArea(),
    getWindowSize(),
  ]);
  if (!wa) return;

  const saved = loadLocalPosition();
  const inside =
    saved &&
    saved.x >= wa.x - size.width / 2 &&
    saved.x <= wa.x + wa.width - size.width / 2 &&
    saved.y >= wa.y &&
    saved.y <= wa.y + wa.height - size.height;

  const x = inside
    ? saved!.x
    : wa.x + wa.width - size.width - Math.round(40 * wa.scaleFactor);
  const y = inside
    ? saved!.y
    : wa.y + wa.height - size.height;

  await setWindowPosition(x, y);
}

async function start() {
  await placeInitially();
  anim.play("idle");
  syncHitRects();

  // 1. Initialize SQLite mood & log session start
  await mood.init();
  await dbLogEvent("session_start");

  // 2. Onboarding: Check user name fact
  const nameFact = await dbGetFact("user_name");
  if (!nameFact || !nameFact.value.trim()) {
    await sleep(400);
    // Explicitly focus window for typing
    await focusWindow();
    askInlineInput(
      "Hi! What should I call you?",
      "Your name...",
      async (name) => {
        if (name) {
          await dbSetFact("user_name", name, "onboarding");
          brain.setUserName(name);
          say(`Nice to meet you, ${name}! ❤`);
        } else {
          say("That's okay! We can just hang out. ✨");
        }
        behaviors.act("cozy", 2);
        (document.activeElement as HTMLElement)?.blur();
        behaviors.scheduleDecide();
      },
      () => {
        say("No problem! Let's be friends anyway~ ✨");
        behaviors.act("cozy", 2);
        (document.activeElement as HTMLElement)?.blur();
        behaviors.scheduleDecide();
      }
    );
    return;
  }

  brain.setUserName(nameFact.value);

  await sleep(900);

  // 3. Stats Summary: streaks & active hour pattern
  const stats = await dbGetStatsSummary();
  const h = hour();
  const away = mood.awayMinutes;
  const greetingTrigger =
    away > 180 ? "returnLong" : away > 20 ? "returnShort" : "timeGreeting";

  const reply = await brain.respond({
    trigger: greetingTrigger,
    moodLabel: mood.label(),
    energy: mood.s.energy,
    hour: h,
    awayMinutes: away,
  });

  let text = reply.text;
  if (stats.top_active_hours.includes(h) && Math.random() < 0.4) {
    text += " You're usually up around this time!";
  } else if (stats.streak_days >= 7 && Math.random() < 0.35) {
    text += ` Day ${stats.streak_days} in a row!`;
  }

  say(text, reply.emote, reply.durationMs);
  behaviors.act("cozy", 2);
  behaviors.scheduleDecide();
}

window.addEventListener("beforeunload", () => {
  mood.flush();
  dbLogEvent("session_end");
});

document.addEventListener("dragstart", (e) => e.preventDefault());
start();
