# Diana Pet (Phase 1)

A tiny always-on-top desktop companion built with Tauri 2 + TypeScript.
No AI model, no API key, no network. Personality comes from a mood engine + scripted lines.

## Run

```powershell
npm install
npm run tauri dev      # first run compiles Rust: several minutes
npm run tauri build    # makes the installer in src-tauri\target\release\bundle
```

## Controls
- Click: pet her (reaction depends on her mood)  |  double-click: dance  |  spam-click: she gets annoyed
- Hover for a second: she notices you
- Drag: pick her up and move her (she reacts when you drop her)
- Right-click: dance, nap, stop/allow wandering, mood check, hide, quit
- Tray icon: left-click show/hide, right-click menu

## Tweak
- `src/main.ts` top: size, walk speed, taskbar margin, break-reminder interval
- `src/lines.ts`: everything she says
- `src/sprites.ts`: which sprite frames map to which pose
- `src/mood.ts`: how her moods drift

Sprites: Diana Codex Pet by AlohomoraC, CC BY 4.0. Diana is a Capcom character; keep this a personal fan project.
