import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import {
  dbGetFact,
  dbSetFact,
  dbGetSetting,
  dbSetSetting,
  dbGetAllSettings,
  dbGetStatsSummary,
  dbResetMemory,
} from "./platform";

// DOM Elements
const inputUsername = document.getElementById("input-username") as HTMLInputElement;
const btnSaveUsername = document.getElementById("btn-save-username") as HTMLButtonElement;
const usernameStatus = document.getElementById("username-status") as HTMLDivElement;

const sliderScale = document.getElementById("slider-scale") as HTMLInputElement;
const labelScale = document.getElementById("label-scale") as HTMLSpanElement;
const toggleAlwaysOnTop = document.getElementById("toggle-always-on-top") as HTMLInputElement;

const toggleWander = document.getElementById("toggle-wander") as HTMLInputElement;
const sliderWalkSpeed = document.getElementById("slider-walk-speed") as HTMLInputElement;
const labelWalkSpeed = document.getElementById("label-walk-speed") as HTMLSpanElement;
const selectChattiness = document.getElementById("select-chattiness") as HTMLSelectElement;

const toggleBreak = document.getElementById("toggle-break") as HTMLInputElement;
const rowBreakInterval = document.getElementById("row-break-interval") as HTMLDivElement;
const sliderBreakInterval = document.getElementById("slider-break-interval") as HTMLInputElement;
const labelBreakInterval = document.getElementById("label-break-interval") as HTMLSpanElement;

const toggleQuietHours = document.getElementById("toggle-quiet-hours") as HTMLInputElement;
const rowQuietHoursTimes = document.getElementById("row-quiet-hours-times") as HTMLDivElement;
const inputQuietStart = document.getElementById("input-quiet-start") as HTMLInputElement;
const inputQuietEnd = document.getElementById("input-quiet-end") as HTMLInputElement;

const toggleAutostart = document.getElementById("toggle-autostart") as HTMLInputElement;

const statPets = document.getElementById("stat-pets") as HTMLSpanElement;
const statStreak = document.getElementById("stat-streak") as HTMLSpanElement;
const statTime = document.getElementById("stat-time") as HTMLSpanElement;

const btnResetMemory = document.getElementById("btn-reset-memory") as HTMLButtonElement;
const modalConfirm = document.getElementById("modal-confirm") as HTMLDivElement;
const btnModalCancel = document.getElementById("btn-modal-cancel") as HTMLButtonElement;
const btnModalConfirm = document.getElementById("btn-modal-confirm") as HTMLButtonElement;

async function loadSettings() {
  try {
    // 1. User Name
    const nameFact = await dbGetFact("user_name");
    if (nameFact && nameFact.value) {
      inputUsername.value = nameFact.value;
    }

    // 2. Settings table
    const settings = await dbGetAllSettings();

    // Scale
    const scaleVal = parseFloat(settings["scale"] || "0.8");
    sliderScale.value = String(scaleVal);
    labelScale.textContent = `${Math.round(scaleVal * 100)}%`;

    // Always on Top
    toggleAlwaysOnTop.checked = settings["always_on_top"] !== "false";

    // Wandering
    toggleWander.checked = settings["wander_enabled"] !== "false";

    // Walk speed
    const walkSpeed = parseInt(settings["walk_speed"] || "110", 10);
    sliderWalkSpeed.value = String(walkSpeed);
    labelWalkSpeed.textContent = `${walkSpeed} px/s`;

    // Chattiness
    if (settings["chattiness"]) {
      selectChattiness.value = settings["chattiness"];
    }

    // Break reminders
    toggleBreak.checked = settings["break_reminder_enabled"] !== "false";
    rowBreakInterval.style.display = toggleBreak.checked ? "flex" : "none";
    const breakInterval = parseInt(settings["break_interval_mins"] || "50", 10);
    sliderBreakInterval.value = String(breakInterval);
    labelBreakInterval.textContent = `${breakInterval} min`;

    // Quiet hours
    const quietEnabled = settings["quiet_hours_enabled"] === "true";
    toggleQuietHours.checked = quietEnabled;
    rowQuietHoursTimes.style.display = quietEnabled ? "flex" : "none";
    if (settings["quiet_hours_start"]) inputQuietStart.value = settings["quiet_hours_start"];
    if (settings["quiet_hours_end"]) inputQuietEnd.value = settings["quiet_hours_end"];

    // 3. Autostart
    try {
      const autostart = await invoke<boolean>("get_autostart");
      toggleAutostart.checked = autostart;
    } catch (err) {
      console.warn("Autostart query failed:", err);
    }

    // 4. Stats Summary
    await updateStatsDisplay();
  } catch (err) {
    console.error("Failed to load settings:", err);
  }
}

async function updateStatsDisplay() {
  try {
    const stats = await dbGetStatsSummary();
    statPets.textContent = String(stats.total_pets);
    statStreak.textContent = `${stats.streak_days}d`;
    const hours = (stats.total_active_minutes / 60).toFixed(1);
    statTime.textContent = `${hours}h`;
  } catch (err) {
    console.warn("Failed to update stats summary:", err);
  }
}

// User Name Save
btnSaveUsername.addEventListener("click", async () => {
  const name = inputUsername.value.trim();
  if (!name) return;
  await dbSetFact("user_name", name, "settings");
  await emit("setting-username", name);
  usernameStatus.textContent = "Saved! Diana will remember this.";
  setTimeout(() => {
    usernameStatus.textContent = "";
  }, 2500);
});

inputUsername.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    btnSaveUsername.click();
  }
});

// Scale Slider
sliderScale.addEventListener("input", async () => {
  const scale = parseFloat(sliderScale.value);
  labelScale.textContent = `${Math.round(scale * 100)}%`;
  await dbSetSetting("scale", String(scale));
  await emit("setting-scale", scale);
});

// Always on Top
toggleAlwaysOnTop.addEventListener("change", async () => {
  const checked = toggleAlwaysOnTop.checked;
  await dbSetSetting("always_on_top", String(checked));
  try {
    await invoke("set_main_always_on_top", { alwaysOnTop: checked });
  } catch (err) {
    console.warn("Failed to set always on top:", err);
  }
});

// Wandering
toggleWander.addEventListener("change", async () => {
  const checked = toggleWander.checked;
  await dbSetSetting("wander_enabled", String(checked));
  await emit("setting-wander", checked);
});

// Walk Speed
sliderWalkSpeed.addEventListener("input", async () => {
  const speed = parseInt(sliderWalkSpeed.value, 10);
  labelWalkSpeed.textContent = `${speed} px/s`;
  await dbSetSetting("walk_speed", String(speed));
  await emit("setting-walk-speed", speed);
});

// Chattiness
selectChattiness.addEventListener("change", async () => {
  const val = selectChattiness.value;
  await dbSetSetting("chattiness", val);
  await emit("setting-chattiness", val);
});

// Break Reminders
toggleBreak.addEventListener("change", async () => {
  const checked = toggleBreak.checked;
  rowBreakInterval.style.display = checked ? "flex" : "none";
  await dbSetSetting("break_reminder_enabled", String(checked));
  await emit("setting-break-enabled", checked);
});

sliderBreakInterval.addEventListener("input", async () => {
  const mins = parseInt(sliderBreakInterval.value, 10);
  labelBreakInterval.textContent = `${mins} min`;
  await dbSetSetting("break_interval_mins", String(mins));
  await emit("setting-break-interval", mins);
});

// Quiet Hours
toggleQuietHours.addEventListener("change", async () => {
  const checked = toggleQuietHours.checked;
  rowQuietHoursTimes.style.display = checked ? "flex" : "none";
  await dbSetSetting("quiet_hours_enabled", String(checked));
  await emit("setting-quiet-hours", {
    enabled: checked,
    start: inputQuietStart.value,
    end: inputQuietEnd.value,
  });
});

inputQuietStart.addEventListener("change", async () => {
  await dbSetSetting("quiet_hours_start", inputQuietStart.value);
  await emit("setting-quiet-hours", {
    enabled: toggleQuietHours.checked,
    start: inputQuietStart.value,
    end: inputQuietEnd.value,
  });
});

inputQuietEnd.addEventListener("change", async () => {
  await dbSetSetting("quiet_hours_end", inputQuietEnd.value);
  await emit("setting-quiet-hours", {
    enabled: toggleQuietHours.checked,
    start: inputQuietStart.value,
    end: inputQuietEnd.value,
  });
});

// Autostart
toggleAutostart.addEventListener("change", async () => {
  const enable = toggleAutostart.checked;
  try {
    await invoke("set_autostart", { enable });
  } catch (err) {
    console.error("Failed to toggle autostart:", err);
    toggleAutostart.checked = !enable;
  }
});

// Reset Memory Modal
btnResetMemory.addEventListener("click", () => {
  modalConfirm.style.display = "flex";
});

btnModalCancel.addEventListener("click", () => {
  modalConfirm.style.display = "none";
});

btnModalConfirm.addEventListener("click", async () => {
  try {
    await dbResetMemory();
    await emit("memory-reset");
    inputUsername.value = "";
    modalConfirm.style.display = "none";
    await updateStatsDisplay();
    alert("Diana's memory has been reset.");
  } catch (err) {
    console.error("Failed to reset memory:", err);
  }
});

// Initial Load
loadSettings();
