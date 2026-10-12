import { getCurrentWindow, currentMonitor, PhysicalPosition } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { Menu } from "@tauri-apps/api/menu";
import { Animator, ClipName } from "./sprites";
import { Mood } from "./mood";
import { Line, pick, timeGreetingKey } from "./lines";

// ---- tweakables ------------------------------------------------------------
const SCALE = 0.8;            // sprite size (must match --scale in style.css)
const WALK_SPEED = 110;       // logical px per second
const TASKBAR_MARGIN = 46;    // logical px kept free at the bottom on first launch
const BREAK_EVERY_MIN = 50;   // work-break reminder interval
// ---------------------------------------------------------------------------

document.documentElement.style.setProperty("--scale", String(SCALE));

const win = getCurrentWindow();
const petEl = document.getElementById("pet")!;
const spriteEl = document.getElementById("sprite")!;
const bubbleEl = document.getElementById("bubble")!;
const anim = new Animator(spriteEl);
const mood = new Mood();

type Mode = "idle" | "walking" | "sleeping" | "dancing" | "carried" | "busy";
let mode: Mode = "idle";
let visible = true;
let wanderEnabled = true;
let lastInteraction = Date.now();
let lastBreak = Date.now();
let lastLateNight = 0;
let lastHover = 0;
let lastClick = 0;
const clicks: number[] = [];

let bubbleTimer: number | undefined;
let decideTimer: number | undefined;
let dropTimer: number | undefined;
let hoverTimer: number | undefined;
let posTimer: number | undefined;
let walkToken = 0;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const hour = () => new Date().getHours();
const isLateNight = () => hour() < 5;

// ---- little visual effects -------------------------------------------------
const fx = {
  bounce: () =>
    petEl.animate(
      [
        { transform: "translateY(0)" },
        { transform: "translateY(-14px) scale(1.03,0.97)" },
        { transform: "translateY(0) scale(1.06,0.94)" },
        { transform: "translateY(0)" },
      ],
      { duration: 420, easing: "ease-out" }
    ),
  shake: () =>
    petEl.animate(
      [{ transform: "translateX(0)" }, { transform: "translateX(-6px)" }, { transform: "translateX(6px)" }, { transform: "translateX(-4px)" }, { transform: "translateX(0)" }],
      { duration: 320 }
    ),
  squish: () =>
    petEl.animate(
      [{ transform: "scale(1,1)" }, { transform: "scale(1.07,0.92)" }, { transform: "scale(1,1)" }],
      { duration: 240, transformOrigin: "bottom center" } as KeyframeAnimationOptions
    ),
};

function emote(ch: string) {
  const s = document.createElement("span");
  s.className = "emote";
  s.textContent = ch;
  s.style.left = `${rand(55, 85)}%`;
  petEl.appendChild(s);
  s.addEventListener("animationend", () => s.remove());
}

function say(line: Line, ms?: number) {
  bubbleEl.textContent = line.t;
  bubbleEl.classList.add("show");
  window.clearTimeout(bubbleTimer);
  bubbleTimer = window.setTimeout(() => bubbleEl.classList.remove("show"), ms ?? 2200 + line.t.length * 60);
  if (line.e) emote(line.e);
}

// ---- state helpers ---------------------------------------------------------
function toIdle() {
  mode = "idle";
  anim.play("idle");
}

function cancelWalk() {
  walkToken++;
}

function act(name: ClipName, loops: number, newMode: Mode = "busy") {
  cancelWalk();
  mode = newMode;
  anim.play(name, { loops, onDone: toIdle });
}

function pickWeighted(options: [() => void, number][]) {
  const total = options.reduce((a, [, w]) => a + w, 0);
  let r = Math.random() * total;
  for (const [fn, w] of options) {
    r -= w;
    if (r <= 0) return fn();
  }
}

// ---- behaviours ------------------------------------------------------------
function thoughtKey(): string {
  switch (mood.label()) {
    case "happy": return "thoughtHappy";
    case "bored": return "thoughtBored";
    case "down": return "thoughtDown";
    case "lonely": return "thoughtLonely";
    case "sleepy": return "thoughtSleepy";
    default: return "thoughtContent";
  }
}

function thought() {
  const label = mood.label();
  say(pick(thoughtKey()));
  if (label === "happy") act("cozy", 3);
  else if (label === "down" || label === "lonely") act("down", 2);
  else if (label === "sleepy") act("sleepy", 1);
  else act("neutral", 3);
}

function ponder() {
  say(pick("thoughtContent"), 3500);
  emote("💭");
  act("thinking", 3);
}

function seekAttention() {
  say(pick("thoughtBored"));
  act("waiting", 4);
}

function doDance() {
  lastInteraction = Date.now();
  if (mode === "sleeping") mood.woken();
  mood.danced();
  say(pick("dance"));
  emote("♪");
  fx.bounce();
  act("dance", 3, "dancing");
}

function goToSleep() {
  cancelWalk();
  mode = "sleeping";
  anim.play("sleepy");
  emote("💤");
}

function startNap() {
  say(pick("yawn"));
  cancelWalk();
  mode = "busy";
  anim.play("sleepy", { loops: 1, onDone: goToSleep });
}

function wakeUp(natural = false) {
  say(natural ? pick(timeGreetingKey()) : pick("wake"));
  act("cozy", 2);
}

function toggleSleep() {
  lastInteraction = Date.now();
  if (mode === "sleeping") wakeUp();
  else startNap();
}

async function wander() {
  if (!wanderEnabled) return;
  const token = ++walkToken;
  const mon = await currentMonitor();
  if (!mon || token !== walkToken) return;
  const [pos, size, sf] = await Promise.all([win.outerPosition(), win.outerSize(), win.scaleFactor()]);

  const pad = (size.width - 192 * SCALE * sf) / 2; // empty window margin beside the sprite
  const minX = mon.position.x - pad;
  const maxX = mon.position.x + mon.size.width - size.width + pad;
  const dir = Math.random() < 0.5 ? -1 : 1;
  const target = Math.max(minX, Math.min(maxX, pos.x + dir * rand(150, 550) * sf));
  if (Math.abs(target - pos.x) < 60 * sf) return;
  const d = target > pos.x ? 1 : -1;

  mode = "walking";
  anim.play(d > 0 ? "walkRight" : "walkLeft");
  let x = pos.x;
  let last = performance.now();
  while (token === walkToken && Math.abs(target - x) > 2) {
    await sleep(33);
    if (token !== walkToken) return;
    const now = performance.now();
    x += d * WALK_SPEED * sf * ((now - last) / 1000);
    last = now;
    if ((d > 0 && x > target) || (d < 0 && x < target)) x = target;
    await win.setPosition(new PhysicalPosition(Math.round(x), pos.y));
  }
  if (token === walkToken) toIdle();
}

// ---- decision loop (the "free will") --------------------------------------
function scheduleDecide() {
  window.clearTimeout(decideTimer);
  decideTimer = window.setTimeout(decide, mode === "sleeping" ? rand(9000, 16000) : rand(6000, 16000));
}

function decide() {
  scheduleDecide();
  if (!visible) return;
  const m = mood.s;
  const idleFor = Date.now() - lastInteraction;

  if (mode === "sleeping") {
    if (m.energy >= 90 && !isLateNight()) return wakeUp(true);
    emote("💤");
    if (Math.random() < 0.25) say(pick("sleeping"), 1800);
    return;
  }
  if (mode !== "idle") return;

  const tired = m.energy < 15 || (isLateNight() && idleFor > 8 * 60000) || (idleFor > 45 * 60000 && m.energy < 45);
  if (tired) return startNap();

  pickWeighted([
    [() => {}, 20],
    [thought, 28],
    [wander, 12 + m.energy / 8],
    [doDance, 3 + (m.happiness > 65 ? 10 : 0)],
    [ponder, 10],
    [seekAttention, m.boredom > 60 ? 25 : 3],
  ]);
}

// ---- interaction -----------------------------------------------------------
function onClick() {
  const now = Date.now();
  lastInteraction = now;
  clicks.push(now);
  while (clicks.length && now - clicks[0] > 5000) clicks.shift();

  if (mode === "sleeping") {
    mood.woken();
    return wakeUp();
  }
  if (clicks.length >= 6) {
    clicks.length = 0;
    mood.annoy();
    say(pick("annoyed"));
    fx.shake();
    return act("pout", 2);
  }
  if (now - lastClick < 350) {
    lastClick = 0;
    return doDance();
  }
  lastClick = now;

  mood.pet();
  const label = mood.label();
  const key = { happy: "clickHappy", content: "clickContent", down: "clickDown", sleepy: "clickSleepy", bored: "clickBored", lonely: "clickLonely" }[label];
  say(pick(key));
  fx.squish();
  if (label === "happy" || label === "bored") {
    fx.bounce();
    act("cozy", 2);
  } else if (label === "sleepy") {
    act("sleepy", 1);
  } else if (label === "down" || label === "lonely") {
    act("nuzzle", 1);
  } else {
    act("surprised", 1);
  }
}

function beginCarry() {
  lastInteraction = Date.now();
  cancelWalk();
  mode = "carried";
  mood.carried();
  anim.play("surprised");
  say(pick("pickup"));
  armDropTimer(1500);
}

function armDropTimer(ms: number) {
  window.clearTimeout(dropTimer);
  dropTimer = window.setTimeout(dropped, ms);
}

function dropped() {
  if (mode !== "carried") return;
  say(pick("drop"));
  fx.bounce();
  act("cozy", 2);
}

// pointer: short press = click, press + move = drag the window
let down: { x: number; y: number } | null = null;
let dragging = false;

petEl.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  down = { x: e.clientX, y: e.clientY };
  dragging = false;
});
window.addEventListener("pointermove", (e) => {
  if (!down || dragging) return;
  if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) {
    dragging = true;
    down = null;
    beginCarry();
    win.startDragging();
  }
});
window.addEventListener("pointerup", () => {
  if (down && !dragging) onClick();
  down = null;
});

// hover: she notices you if you linger on her
petEl.addEventListener("pointerenter", () => {
  window.clearTimeout(hoverTimer);
  hoverTimer = window.setTimeout(() => {
    const now = Date.now();
    if (mode === "idle" && now - lastHover > 25000) {
      lastHover = now;
      say(pick("hover"));
      act("waiting", 2);
    }
  }, 1000);
});
petEl.addEventListener("pointerleave", () => window.clearTimeout(hoverTimer));

// window moved: save position, and detect when a drag has ended
win.onMoved(() => {
  window.clearTimeout(posTimer);
  posTimer = window.setTimeout(async () => {
    const p = await win.outerPosition();
    try { localStorage.setItem("diana.pos", JSON.stringify({ x: p.x, y: p.y })); } catch {}
  }, 600);
  if (mode === "carried") armDropTimer(220);
});

// right-click menu
function bar(v: number) {
  const n = Math.round(v / 20);
  return "▮".repeat(n) + "▯".repeat(5 - n);
}
function showStats() {
  const s = mood.s;
  say({ t: `Energy ${bar(s.energy)}  Mood ${bar(s.happiness)}\nLove ${bar(s.affection)}  Bored ${bar(s.boredom)}` }, 5000);
  bubbleEl.style.whiteSpace = "pre-line";
  window.setTimeout(() => (bubbleEl.style.whiteSpace = ""), 5200);
}
function hidePet() {
  visible = false;
  anim.pause();
  win.hide();
}

petEl.addEventListener("contextmenu", async (e) => {
  e.preventDefault();
  const menu = await Menu.new({
    items: [
      { id: "dance", text: "Dance ♪", action: () => doDance() },
      { id: "sleep", text: mode === "sleeping" ? "Wake up" : "Take a nap", action: toggleSleep },
      {
        id: "wander",
        text: wanderEnabled ? "Stay here (stop wandering)" : "Let her wander",
        action: () => {
          wanderEnabled = !wanderEnabled;
          cancelWalk();
          if (mode === "walking") toIdle();
          say({ t: wanderEnabled ? "Okay, I'll explore a bit!" : "Okay, I'll stay right here." });
        },
      },
      { id: "feel", text: "How is she feeling?", action: showStats },
      { item: "Separator" as const },
      { id: "hide", text: "Hide (bring back from tray)", action: hidePet },
      { id: "quit", text: "Quit", action: () => { mood.save(); win.close(); } },
    ],
  });
  await menu.popup();
});

// tray events from Rust
listen<string>("tray-action", (e) => {
  if (e.payload === "dance") doDance();
  if (e.payload === "sleep") toggleSleep();
});
listen<boolean>("pet-visible", (e) => {
  visible = e.payload;
  if (visible) anim.resume();
  else anim.pause();
});

// ---- slow background clock (once a minute) ---------------------------------
setInterval(() => {
  mood.tick(1, mode === "sleeping");
  mood.save();
  if (!visible || mode !== "idle") return;
  const now = Date.now();
  if (now - lastBreak > BREAK_EVERY_MIN * 60000) {
    lastBreak = now;
    say(pick("breakTime"), 5000);
    act("waiting", 4);
  } else if (isLateNight() && now - lastLateNight > 60 * 60000) {
    lastLateNight = now;
    say(pick("lateNight"), 5000);
    act("thinking", 3);
  }
}, 60000);

// ---- startup ---------------------------------------------------------------
async function placeInitially() {
  const [mon, size, sf] = await Promise.all([currentMonitor(), win.outerSize(), win.scaleFactor()]);
  if (!mon) return;
  let saved: { x: number; y: number } | null = null;
  try { saved = JSON.parse(localStorage.getItem("diana.pos") || "null"); } catch {}
  const inside =
    saved &&
    saved.x > mon.position.x - size.width / 2 &&
    saved.x < mon.position.x + mon.size.width - size.width / 2 &&
    saved.y > mon.position.y &&
    saved.y < mon.position.y + mon.size.height - size.height / 2;
  const x = inside ? saved!.x : mon.position.x + mon.size.width - size.width - 40 * sf;
  const y = inside ? saved!.y : mon.position.y + mon.size.height - size.height - TASKBAR_MARGIN * sf;
  await win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
}

async function start() {
  await placeInitially();
  anim.play("idle");
  await sleep(900);
  const away = mood.awayMinutes;
  say(pick(away > 180 ? "returnLong" : away > 20 ? "returnShort" : timeGreetingKey()));
  act("cozy", 2);
  scheduleDecide();
}

document.addEventListener("dragstart", (e) => e.preventDefault());
start();
