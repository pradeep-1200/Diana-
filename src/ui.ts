// UI elements, animations, speech bubble, and emotes

export const petEl = document.getElementById("pet")!;
export const spriteEl = document.getElementById("sprite")!;
export const bubbleEl = document.getElementById("bubble")!;
export const stageEl = document.getElementById("stage")!;

let bubbleTimer: number | undefined;

export const fx = {
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
      [
        { transform: "translateX(0)" },
        { transform: "translateX(-6px)" },
        { transform: "translateX(6px)" },
        { transform: "translateX(-4px)" },
        { transform: "translateX(0)" },
      ],
      { duration: 320 }
    ),
  squish: () =>
    petEl.animate(
      [
        { transform: "scale(1,1)" },
        { transform: "scale(1.07,0.92)" },
        { transform: "scale(1,1)" },
      ],
      { duration: 240, transformOrigin: "bottom center" } as KeyframeAnimationOptions
    ),
};

export function emote(ch: string) {
  const s = document.createElement("span");
  s.className = "emote";
  s.textContent = ch;
  s.style.left = `${55 + Math.random() * 30}%`;
  petEl.appendChild(s);
  s.addEventListener("animationend", () => s.remove());
}

export function say(text: string, emoteChar?: string, ms?: number) {
  bubbleEl.textContent = text;
  bubbleEl.classList.add("show");
  window.clearTimeout(bubbleTimer);
  bubbleTimer = window.setTimeout(
    () => bubbleEl.classList.remove("show"),
    ms ?? 2200 + text.length * 60
  );
  if (emoteChar) emote(emoteChar);
}

export function hideBubble() {
  window.clearTimeout(bubbleTimer);
  bubbleEl.classList.remove("show");
}

export function bar(v: number): string {
  const n = Math.round(v / 20);
  return "▮".repeat(n) + "▯".repeat(5 - n);
}
