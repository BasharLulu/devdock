# Devdock

A tiny local dashboard for starting and stopping Docker Compose dev projects.

Devdock scans `~/Sites` for compose projects and gives you one page to see what's running, start/stop/restart/rebuild whole projects or single services, open their published ports, and tail logs.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshot-dark.png">
  <img alt="Devdock dashboard showing compose projects with their service status, ports and start/stop controls" src="docs/screenshot-light.png">
</picture>

No dependencies, no build step: a Node server (`server.mjs`) that shells out to `docker compose`, and a single static page (`index.html`).

## Requirements

- Node 18+
- Docker Desktop (the `docker` CLI at `/usr/local/bin/docker` or `/opt/homebrew/bin/docker`, or on `PATH`)

## Run

```bash
node server.mjs
```

Then open http://127.0.0.1:7777.

## Configuration

| Env var        | Default    | Description                                        |
| -------------- | ---------- | -------------------------------------------------- |
| `PORT`         | `7777`     | Port to listen on (always bound to `127.0.0.1`)    |
| `DEVDOCK_DIRS` | `~/Sites`  | Colon-separated list of directories to scan        |

## How projects are found

Projects come from two sources, merged by compose project name:

1. **Scanned folders** — every immediate subfolder of `DEVDOCK_DIRS` containing `docker-compose.dev.yml`, `docker-compose.dev.yaml`, `compose.dev.yml` or `compose.dev.yaml`. The project name is the file's top-level `name:`, or `<folder>-dev` if it has none. These show up even before any containers exist.
2. **`docker compose ls -a`** — any other compose project Docker already knows about. Config files inside `.claude/worktrees/` or `copilot-worktrees/` are skipped in favour of the main checkout.

## What the buttons do

| Button  | Command                                   |
| ------- | ----------------------------------------- |
| Start   | `docker compose up -d [service]`          |
| Stop    | `docker compose stop [service]`           |
| Restart | `docker compose restart [service]`        |
| Rebuild | `docker compose up -d --build`            |
| Down    | `docker compose down --remove-orphans` (volumes are kept) |
| Logs    | `docker compose logs --tail 300 [service]` |

Every command runs with `-f <config> -p <project>` from the project's directory. One action per project runs at a time; its output streams into the "Output" panel.

Status dots: **green** — all long-running services up, **amber** — some up (e.g. `web` exited but `postgres` running), **grey** — stopped. One-shot services that exited with code 0 (like `setup`) don't count as down.

## Auto-start on login (macOS)

Create `~/Library/LaunchAgents/local.devdock.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>local.devdock</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/YOUR_USER/.local/bin/mise</string>
    <string>x</string>
    <string>node</string>
    <string>--</string>
    <string>node</string>
    <string>/Users/YOUR_USER/Sites/devdock/server.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/YOUR_USER/Sites/devdock</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/Users/YOUR_USER/Library/Logs/devdock.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOUR_USER/Library/Logs/devdock.log</string>
</dict>
</plist>
```

Replace `YOUR_USER` with your macOS username (`whoami`). Node is launched through [mise](https://mise.jdx.dev) so the agent survives Node upgrades; if you don't use mise, replace the first five arguments with the full path to `node` (`which node`).

Load it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.devdock.plist
```

Restart after editing the code:

```bash
launchctl kickstart -k gui/$(id -u)/local.devdock
```

Remove:

```bash
launchctl bootout gui/$(id -u)/local.devdock && rm ~/Library/LaunchAgents/local.devdock.plist
```

Logs go to `~/Library/Logs/devdock.log`.

## Security

Devdock can start and stop containers, so it is locked to your machine:

- Listens on `127.0.0.1` only.
- Rejects requests whose `Host` isn't `127.0.0.1`/`localhost` (blocks DNS rebinding) and cross-origin `POST`s.
- Only runs commands for projects it discovered, with a fixed set of actions and validated service names; arguments are passed to `docker` directly, never through a shell.

There is no authentication — don't expose the port.
