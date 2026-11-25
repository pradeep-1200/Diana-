// All of Diana's scripted dialogue. Add lines freely; she picks randomly and
// avoids repeating the last one. `e` is an optional floating emote.

export interface Line { t: string; e?: string }

const L = (t: string, e?: string): Line => ({ t, e });

export const LINES: Record<string, Line[]> = {
  morning: [L("Good morning! Did you sleep okay?", "🌤"), L("Morning... I'm still waking up."), L("A new day! What are we doing today?", "✨")],
  afternoon: [L("Hi! Is it afternoon already?"), L("Hello again~", "👋"), L("Oh, you're here!")],
  evening: [L("Good evening!"), L("Evening already... time goes fast."), L("Welcome! Long day?")],
  night: [L("You're still up?", "❓"), L("It's so late... shouldn't you rest?"), L("The night is quiet. I like it.")],
  returnShort: [L("Welcome back!", "❤"), L("You're back! That was quick.")],
  returnLong: [L("You were gone a long time... I missed you.", "❤"), L("There you are! I was waiting.", "✨"), L("I practiced standing still while you were away.")],

  clickHappy: [L("Hehe, that tickles!", "❤"), L("Hi hi!"), L("Do it again!", "✨"), L("I like that."), L("Pat pat? Okay!", "❤")],
  clickContent: [L("Hm? Did you need something?", "❓"), L("I'm here!"), L("Yes?"), L("Hello~")],
  clickDown: [L("...oh. Hi."), L("I'm okay. Just a little quiet today."), L("Thanks for coming to see me.", "❤")],
  clickSleepy: [L("Mm... I'm a little tired."), L("Five more minutes..."), L("*yawn* Hi...", "💤")],
  clickBored: [L("Finally! I was so bored!", "✨"), L("Play with me!"), L("You remembered me!", "❤")],
  clickLonely: [L("You're here... I thought you forgot me."), L("Hi... I was a bit lonely.")],
  annoyed: [L("Ow ow ow, stop poking!", "💢"), L("Hey! That's enough!", "💢"), L("Hmph. I'm not a button.", "💢")],
  wake: [L("Mmn... I'm up, I'm up."), L("Huh? Oh... hi.", "❓"), L("Was I asleep? Sorry...")],
  yawn: [L("*yawn* I'm going to nap a little...", "💤"), L("So sleepy... good night for now.", "💤")],
  sleeping: [L("zzz...", "💤"), L("...mmh...", "💤"), L("...five more...", "💤")],

  thoughtContent: [
    L("I wonder what's on the other side of the screen.", "💭"),
    L("Sometimes I just like watching you work."),
    L("Do clouds have a taste?", "💭"),
    L("Your cursor moves so fast."),
    L("I'm practicing standing very still."),
    L("Taskbar is a good place to stand, actually."),
  ],
  thoughtHappy: [L("Today feels like a good day!", "✨"), L("I want to dance!", "♪"), L("Everything is kind of sparkly today.", "✨"), L("La la la~", "♪")],
  thoughtBored: [L("Nothing is happening..."), L("Hey... hey... hey."), L("I counted all your icons. Twice.")],
  thoughtDown: [L("It's okay if today is slow."), L("I'll just stay right here, quietly."), L("...")],
  thoughtLonely: [L("It's quiet when you're away."), L("I hope you come see me soon.")],
  thoughtSleepy: [L("*yawn*", "💤"), L("My eyes keep closing..."), L("Is it nap time yet?")],

  pickup: [L("Whoa!", "❗"), L("Eep! Put me down—"), L("I'm flying!", "✨")],
  drop: [L("Phew... that was exciting."), L("Again? ...maybe a little."), L("My hair is a mess now.")],
  dance: [L("Watch this!", "♪"), L("La la la~", "♪"), L("Dance time!", "♪")],
  hover: [L("Oh? You're looking at me.", "👀"), L("Hm?", "❓"), L("...?", "❓")],
  breakTime: [L("You've been working a long time. Stretch with me?", "💧"), L("Water break! Please?", "💧"), L("Rest your eyes for a moment.", "👀")],
  lateNight: [L("It's past midnight... please get some sleep.", "💤"), L("Even I'm getting sleepy. You should rest too.")],
  lowBattery: [L("Battery is running low... please plug in soon!", "⚡"), L("Down under 20%! I need my charger...", "💧"), L("Low power warning! Let's find an outlet.", "🔋")],
  pluggedIn: [L("Plugged in! Full energy coming up~", "⚡"), L("Charging! We have all the power we need now.", "✨")],
  unplugged: [L("Unplugged! Running on battery now.", "🔋"), L("On battery power! I'll keep an eye on it.", "👀")],
  welcomeBack: [L("Welcome back! I was waiting for you.", "✨"), L("You're back! Ready to get to work?", "👋"), L("Oh! You're back! Welcome~", "❤")],

  // ── App focus / blur ──────────────────────────────────────────────────────
  appBlur:    [L("I'll be right here if you need me~"), L("Go get 'em! I'll keep watch."), L("Off you go. I'll be here.")],
  appFocus:   [L("Oh, you're back! Hi~", "✨"), L("Welcome back!"), L("There you are~ 👋")],

  // ── Seasonal ─────────────────────────────────────────────────────────────
  winter:  [L("It's so cold out... I'm glad we're cozy in here.","❄️"), L("Winter feels extra quiet today.","⛄"), L("*hugs self* Chilly!","🧊")],
  spring:  [L("Something feels alive in the air today~","🌸"), L("Spring! Everything is blooming.","🌷"), L("I smell flowers. Do you?","🌸")],
  summer:  [L("It's so warm today! Stay hydrated, okay?","☀️"), L("Summer energy!","🌻"), L("Hot hot hot~ Turn on a fan?","🌞")],
  fall:    [L("Cozy season is here~","🍂"), L("I love fall! Leaves are pretty.","🍁"), L("*crunches imaginary leaf*","🍂")],

  // ── Holidays ─────────────────────────────────────────────────────────────
  halloween: [L("Boo! ...Did that work?","👻"), L("Spooky season~ 🎃"), L("If I were a ghost, I'd haunt very politely.","👻")],
  christmas: [L("Merry Christmas! Ho ho ho~","🎄"), L("I hope you have a wonderful holiday!","✨"), L("*hums a carol quietly*","🎅")],
  newyear:   [L("Happy New Year! Make it a great one!","🎉"), L("New year, still the same me~ ✨"), L("🎆 Fireworks!")],
  valentine: [L("Happy Valentine's Day! 💕"), L("I appreciate you, just so you know~","❤"), L("You're my favourite person to be with~","💖")],
};

// ── Seasonal helpers ─────────────────────────────────────────────────────────

export function getSeason(): "winter" | "spring" | "summer" | "fall" {
  const m = new Date().getMonth() + 1; // 1-12
  if (m === 12 || m <= 2) return "winter";
  if (m <= 5) return "spring";
  if (m <= 8) return "summer";
  return "fall";
}

export function getHoliday(): string | null {
  const now = new Date();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  if (m === 10 && d === 31) return "halloween";
  if (m === 12 && d === 25) return "christmas";
  if (m === 1  && d === 1)  return "newyear";
  if (m === 2  && d === 14) return "valentine";
  return null;
}

const lastUsed = new Map<string, number>();

export function pick(key: string): Line {
  // Bug 1 fix: fall back gracefully on unknown keys instead of crashing
  const pool = LINES[key] ?? LINES["thoughtContent"];
  let i = Math.floor(Math.random() * pool.length);
  if (pool.length > 1 && lastUsed.get(key) === i) i = (i + 1) % pool.length;
  lastUsed.set(key, i);
  return pool[i];
}

export function timeGreetingKey(hour = new Date().getHours()): string {
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}
