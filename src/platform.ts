// Tauri API and OS window interaction wrappers

import { getCurrentWindow, currentMonitor, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { Menu, MenuOptions } from "@tauri-apps/api/menu";
import { invoke } from "@tauri-apps/api/core";

export const win = getCurrentWindow();

export async function getMonitor() {
  return await currentMonitor();
}

export async function getWindowPosition(): Promise<{ x: number; y: number }> {
  const pos = await win.outerPosition();
  return { x: pos.x, y: pos.y };
}

export async function setWindowPosition(x: number, y: number): Promise<void> {
  await win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
}

export async function getWindowSize(): Promise<{ width: number; height: number }> {
  const size = await win.outerSize();
  return { width: size.width, height: size.height };
}

export async function setWindowSize(width: number, height: number): Promise<void> {
  await win.setSize(new PhysicalSize(Math.round(width), Math.round(height)));
}

export async function getScaleFactor(): Promise<number> {
  return await win.scaleFactor();
}

export async function startDragging(): Promise<void> {
  await win.startDragging();
}

export async function hideWindow(): Promise<void> {
  await win.hide();
}

export async function showWindow(): Promise<void> {
  await win.show();
}

export async function closeWindow(): Promise<void> {
  await win.close();
}

export async function focusWindow(): Promise<void> {
  await win.setFocus();
}

export function onWindowMoved(cb: () => void): () => void {
  let unlisten: UnlistenFn | undefined;
  win.onMoved(() => cb()).then((fn) => {
    unlisten = fn;
  });
  return () => {
    unlisten?.();
  };
}

export function saveLocalPosition(x: number, y: number) {
  try {
    localStorage.setItem("diana.pos", JSON.stringify({ x, y }));
  } catch {}
}

export function loadLocalPosition(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem("diana.pos");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function onTrayAction(handler: (action: string) => void): Promise<UnlistenFn> {
  return await listen<string>("tray-action", (e) => handler(e.payload));
}

export async function onPetVisible(handler: (visible: boolean) => void): Promise<UnlistenFn> {
  return await listen<boolean>("pet-visible", (e) => handler(e.payload));
}

export async function showNativeContextMenu(items: NonNullable<MenuOptions["items"]>): Promise<void> {
  const menu = await Menu.new({ items });
  await menu.popup();
}

export interface HitRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function updateHitRects(rects: HitRect[]): Promise<void> {
  try {
    await invoke("update_hit_rects", { rects });
  } catch (err) {
    console.warn("Failed to update hit rects:", err);
  }
}

export async function setDragState(dragging: boolean): Promise<void> {
  try {
    await invoke("set_drag_state", { dragging });
  } catch (err) {
    console.warn("Failed to set drag state:", err);
  }
}

