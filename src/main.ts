import { Animator } from "./sprites";
import { Mood } from "./mood";
import { ScriptedBrain } from "./brain";
import { Behaviors, sleep, hour, isLateNight } from "./behaviors";
import { InputHandler } from "./input";
import { state, setVisible } from "./state";
import { SCALE, BREAK_EVERY_MIN, TASKBAR_MARGIN, applyScale } from "./config";
import { spriteEl, say, syncHitRects } from "./ui";
import {
  getMonitor,
  getWindowSize,
  getScaleFactor,
  setWindowPosition,
  loadLocalPosition,
  onTrayAction,
  onPetVisible,
} from "./platform";

// Initialize styling
applyScale(SCALE);

// Core instances
const anim = new Animator(spriteEl);
const mood = new Mood();
const brain = new ScriptedBrain();
const behaviors = new Behaviors(anim, mood, brain);
new InputHandler(anim, mood, behaviors, brain);

// Tray event listeners from Rust
onTrayAction((action) => {
  if (action === "dance") behaviors.doDance();
  if (action === "sleep") behaviors.toggleSleep();
});

onPetVisible((visible) => {
  setVisible(visible);
  if (visible) anim.resume();
  else anim.pause();
});

// Slow background clock (once per minute)
setInterval(async () => {
  mood.tick(1, state.mode === "sleeping");
  mood.save();
  if (!state.visible || state.mode !== "idle" || state.dndEnabled) return;

  const now = Date.now();
  if (now - state.lastBreak > BREAK_EVERY_MIN * 60000) {
    state.lastBreak = now;
    const reply = await brain.respond({
      trigger: "breakTime",
      moodLabel: mood.label(),
      energy: mood.s.energy,
      hour: hour(),
    });
    say(reply.text, reply.emote, 5000);
    behaviors.act("waiting", 4);
  } else if (isLateNight() && now - state.lastLateNight > 60 * 60000) {
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

// Initial placement and greeting sequence
async function placeInitially() {
  const [mon, size, sf] = await Promise.all([
    getMonitor(),
    getWindowSize(),
    getScaleFactor(),
  ]);
  if (!mon) return;

  const saved = loadLocalPosition();
  const inside =
    saved &&
    saved.x > mon.position.x - size.width / 2 &&
    saved.x < mon.position.x + mon.size.width - size.width / 2 &&
    saved.y > mon.position.y &&
    saved.y < mon.position.y + mon.size.height - size.height / 2;

  const x = inside
    ? saved!.x
    : mon.position.x + mon.size.width - size.width - 40 * sf;
  const y = inside
    ? saved!.y
    : mon.position.y + mon.size.height - size.height - TASKBAR_MARGIN * sf;

  await setWindowPosition(x, y);
}

async function start() {
  await placeInitially();
  anim.play("idle");
  syncHitRects();
  await sleep(900);

  const away = mood.awayMinutes;
  const greetingTrigger =
    away > 180 ? "returnLong" : away > 20 ? "returnShort" : "timeGreeting";

  const reply = await brain.respond({
    trigger: greetingTrigger,
    moodLabel: mood.label(),
    energy: mood.s.energy,
    hour: hour(),
    awayMinutes: away,
  });
  say(reply.text, reply.emote, reply.durationMs);
  behaviors.act("cozy", 2);
  behaviors.scheduleDecide();
}

document.addEventListener("dragstart", (e) => e.preventDefault());
start();
