// UI elements, animations, speech bubble, and emotes

import { updateHitRects, HitRect } from "./platform";

export const petEl = document.getElementById("pet")!;
export const spriteEl = document.getElementById("sprite")!;
export const bubbleEl = document.getElementById("bubble")!;
export const stageEl = document.getElementById("stage")!;

petEl.classList.add("alive");

export function setMotionSleeping(sleeping: boolean) {
  petEl.classList.toggle("sleeping", sleeping);
}

export function setMotionPaused(paused: boolean) {
  petEl.classList.toggle("paused-motion", paused);
}

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
  sway: () =>
    petEl.animate(
      [
        { transform: "rotate(0deg)" },
        { transform: "rotate(-3deg)" },
        { transform: "rotate(3deg)" },
        { transform: "rotate(0deg)" },
      ],
      { duration: 1200, easing: "ease-in-out" }
    ),
  shiver: () =>
    petEl.animate(
      [
        { transform: "translateX(0)" },
        { transform: "translateX(-2px)" },
        { transform: "translateX(2px)" },
        { transform: "translateX(-1.5px)" },
        { transform: "translateX(1.5px)" },
        { transform: "translateX(0)" },
      ],
      { duration: 380 }
    ),
  stretch: () =>
    petEl.animate(
      [
        { transform: "scale(1,1)" },
        { transform: "scale(0.96, 1.08)" },
        { transform: "scale(1,1)" },
      ],
      { duration: 520, transformOrigin: "bottom center" } as KeyframeAnimationOptions
    ),
  hiccup: () =>
    petEl.animate(
      [
        { transform: "translateY(0)" },
        { transform: "translateY(-7px) scale(1.02, 0.98)" },
        { transform: "translateY(0)" },
      ],
      { duration: 180, easing: "ease-out" }
    ),
};

export function syncHitRects() {
  const rects: HitRect[] = [];
  const petRect = petEl.getBoundingClientRect();
  if (petRect.width > 0 && petRect.height > 0) {
    rects.push({
      x: petRect.left,
      y: petRect.top,
      width: petRect.width,
      height: petRect.height,
    });
  }

  if (bubbleEl.classList.contains("show")) {
    const bubbleRect = bubbleEl.getBoundingClientRect();
    if (bubbleRect.width > 0 && bubbleRect.height > 0) {
      rects.push({
        x: bubbleRect.left,
        y: bubbleRect.top,
        width: bubbleRect.width,
        height: bubbleRect.height,
      });
    }
  }

  // Include any visible inline input or modal
  const inputs = document.querySelectorAll<HTMLElement>("input, button");
  for (const input of Array.from(inputs)) {
    const r = input.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      rects.push({
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height,
      });
    }
  }

  updateHitRects(rects);
}

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
  syncHitRects();
  window.clearTimeout(bubbleTimer);
  bubbleTimer = window.setTimeout(() => {
    bubbleEl.classList.remove("show");
    syncHitRects();
  }, ms ?? 2200 + text.length * 60);
  if (emoteChar) emote(emoteChar);
}

export function hideBubble() {
  window.clearTimeout(bubbleTimer);
  bubbleEl.classList.remove("show");
  syncHitRects();
}

export function bar(v: number): string {
  const n = Math.round(v / 20);
  return "▮".repeat(n) + "▯".repeat(5 - n);
}

export function askInlineInput(
  promptText: string,
  placeholder: string,
  onSubmit: (val: string) => void,
  onSkip: () => void
) {
  window.clearTimeout(bubbleTimer);
  bubbleEl.textContent = "";

  const textDiv = document.createElement("div");
  textDiv.textContent = promptText;
  textDiv.style.marginBottom = "6px";
  textDiv.style.fontSize = "12px";
  textDiv.style.fontWeight = "500";
  bubbleEl.appendChild(textDiv);

  const form = document.createElement("div");
  form.style.display = "flex";
  form.style.alignItems = "center";
  form.style.justifyContent = "center";
  form.style.gap = "4px";

  const input = document.createElement("input");
  input.id = "name-input";
  input.type = "text";
  input.maxLength = 20;
  input.placeholder = placeholder;
  input.style.width = "90px";
  input.style.padding = "3px 6px";
  input.style.fontSize = "12px";
  input.style.borderRadius = "8px";
  input.style.border = "1px solid #c0c0d0";
  input.style.outline = "none";
  input.style.background = "#f4f4fa";
  input.style.textAlign = "center";

  const btnOk = document.createElement("button");
  btnOk.textContent = "✔";
  btnOk.style.padding = "3px 6px";
  btnOk.style.fontSize = "11px";
  btnOk.style.borderRadius = "8px";
  btnOk.style.border = "none";
  btnOk.style.background = "#5b73ff";
  btnOk.style.color = "#ffffff";
  btnOk.style.cursor = "pointer";

  const btnSkip = document.createElement("button");
  btnSkip.textContent = "✖";
  btnSkip.style.padding = "3px 6px";
  btnSkip.style.fontSize = "11px";
  btnSkip.style.borderRadius = "8px";
  btnSkip.style.border = "none";
  btnSkip.style.background = "#e0e0e8";
  btnSkip.style.color = "#444444";
  btnSkip.style.cursor = "pointer";

  form.appendChild(input);
  form.appendChild(btnOk);
  form.appendChild(btnSkip);
  bubbleEl.appendChild(form);

  bubbleEl.classList.add("show");
  syncHitRects();

  let finished = false;
  const finish = (val?: string) => {
    if (finished) return;
    finished = true;
    bubbleEl.classList.remove("show");
    bubbleEl.textContent = "";
    syncHitRects();
    if (val !== undefined && val.length > 0) {
      onSubmit(val);
    } else {
      onSkip();
    }
  };

  btnOk.addEventListener("click", () => finish(input.value.trim()));
  btnSkip.addEventListener("click", () => finish());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(input.value.trim());
    else if (e.key === "Escape") finish();
  });

  setTimeout(() => input.focus(), 60);
}

