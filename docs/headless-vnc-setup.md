# Headless VNC Launcher Setup (server 65.109.100.94)

Last updated: 2026-08-31

## Overview

The Electron launcher runs headless on a virtual X display, exposed over VNC/noVNC through HTTPS.

- Repo (fork of codex-chatgpt-web): `/home/jaime/codex-chatgpt-web`
- Branch at setup time: `headless-cli-mode` (HEAD `56cb118`)
- Virtual display: `:99` (Xvfb, 1920x1080x24)

## Access

- Browser (noVNC): https://vnc.menustudioai.com/vnc.html?autoconnect=1&path=websockify
  - Chain: nginx → `127.0.0.1:6080` (websockify) → `65.109.100.94:5901` (x11vnc) → display `:99`
- Direct VNC client: `65.109.100.94:5901` (also `:::5900`)
- nginx config: `/etc/nginx/sites-enabled/vnc.menustudioai.com` (TLS via letsencrypt)

## Systemd user services

All under `systemctl --user`, all `enabled`, all must be `active`:

| Service | Role |
|---|---|
| `codex-web-gpt-xvfb.service` | Xvfb `:99` |
| `codex-web-gpt-wm.service` | openbox on `:99` |
| `codex-web-gpt-vnc.service` | x11vnc on `:99`, ports 5900/5901 |
| `codex-web-gpt-novnc.service` | websockify `127.0.0.1:6080` → `65.109.100.94:5901` |
| `codex-web-gpt-app.service` | Electron launcher (runs the repo working tree) |

- `Linger=yes` for user `jaime` → services run without an active login session.
- `codex-web-gpt-app.service` has `Restart=always`, `RestartSec=5`.
- Initial setup (smoke test + DEV harness) was completed and tested on 2026-08-31.

### Launcher service details

`~/.config/systemd/user/codex-web-gpt-app.service`:

```ini
[Unit]
Description=Codex Web GPT launcher (Electron, repo headless-cli-mode)
Requires=codex-web-gpt-xvfb.service codex-web-gpt-wm.service
After=codex-web-gpt-xvfb.service codex-web-gpt-wm.service

[Service]
Environment=DISPLAY=:99
Environment=ELECTRON_DISABLE_GPU=1
Environment=PATH=/home/jaime/.bun/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=/home/jaime/codex-chatgpt-web
ExecStart=/home/jaime/.bun/bin/bun run launcher
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Notes:
- The service runs the **repo working tree**, not the installed copy at
  `~/.local/lib/codex-web-gpt/4.0.7-fork` (that one is stale; its old AppRun
  autostart entry and duplicate service target were removed on 2026-08-31).
- `PATH` must include `/home/jaime/.bun/bin`, otherwise `bun` script children
  fail with exit 127 (`bun: command not found`).

## Helper runtime

- Generated helper: `.launcher-runtime/browser-helper.cjs` (rebuilt by `bun run launcher`
  → `scripts/dev.cjs` on each service start; manual rebuild:
  `bun run scripts/build-browser-helper.ts`)
- Descriptor with ports/tokens: `~/.codex-chatgpt-web/runtime/launcher-browser.json`
- Connector/app name: `Codex Native2`

## Known gotcha: patchright-difz in the helper

`patchright-difz` is an ESM-only package (`"type": "module"`, no `"require"`
export). The helper bundle is CJS executed via `ELECTRON_RUN_AS_NODE=1`, so a
static `import { x } from "patchright-difz"` compiles to `require(...)` and
crashes with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Symptom in the GUI:

> error invoking remote method 'launcher:browser-smoke': ... browser helper verification exited with status 1

Fix (applied in `src/browser-login.ts`): use a dynamic import at the call site:

```ts
const { installTurnstileAutoSolver } = await import("patchright-difz");
```

Bun inlines it into the CJS bundle, so no external `require` remains. If this
error reappears after a merge, check that no static top-level import of
`patchright-difz` sneaked back into `src/`.

## Turn-health fixes (2026-08-31, branch headless-cli-mode)

1. **False "DOM may have changed" failure during long tool/background-terminal waits.**
   `ChatGptTurnDomHealthTracker` now ignores the missing-completion-action failure while
   ChatGPT's live `[data-streaming-response-status]` activity pill is visible
   (`streamingStatusVisible` in the DOM snapshot).
2. **"The message you submitted was too long" alert.**
   - Detected explicitly (`throwIfChatGptMessageTooLongAlert`) → fails fast with
     `chatgpt_message_too_long` instead of the misleading DOM error.
   - Root cause: Bigger Context staging used max 3 parts with huge per-part payloads
     (stage 1 at 134k chars accepted, stage 2 at 117k rejected — ChatGPT limits the
     *accumulated* conversation, not single messages). Part count is now dynamic
     (2–8) sized by `CHATGPT_MULTIPART_STAGE_CHAR_BUDGET` = 64,000 chars/stage
     (`src/adapters/chatgpt-web/usage.ts`); overflow past 8 parts throws an
     actionable "compact the task" error before sending.
3. **"requires a current-turn user message for browser-session replay" with concurrent Codex sessions.**
   A provider round carrying only contextual traffic (e.g. a lone `<subagent_notification>`
   from a settling background terminal) now falls back to that message as the turn revision
   (`src/adapters/chatgpt-web/environment.ts`) instead of killing the stream.

## Common operations

```bash
# Status of the whole stack
systemctl --user is-active codex-web-gpt-{xvfb,wm,vnc,novnc,app}.service

# Restart the launcher only (VNC session stays up)
systemctl --user restart codex-web-gpt-app.service

# Logs
journalctl --user -u codex-web-gpt-app.service -f

# Sanity: exactly one launcher, no stale installed-copy processes
pgrep -af electron
pgrep -af "codex-web-gpt/4.0.7"   # should print nothing
```

## Unrelated, noted same day

- `codex-shim.service` (user) was crash-looping (`activating`/auto-restart) —
  not part of the VNC stack, still to investigate.
- `mythcortex-backend@4` / `mythcortex-frontend@4` were also crash-looping —
  separate project, unrelated to this setup.
