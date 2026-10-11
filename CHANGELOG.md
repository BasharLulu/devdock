# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Links to deployed sites on each project card, detected from Kamal `config/deploy*.yml` proxy hosts.
- Optional site status (up, degraded, down) from [Pingerer](https://pingerer.com), using a read-only API token.
- Optional config file at `~/.config/devdock/config.json` (or `DEVDOCK_CONFIG`) for the Pingerer token and per-project link overrides.
- Dependabot updates for GitHub Actions.
- End-to-end smoke test (`test/smoke.mjs`) and a GitHub Actions CI workflow running it on Node 18, 20, 22 and 24.
- Project docs: changelog, contributing guide, code of conduct, security policy, and issue and pull request templates.

## [1.0.0] - 2026-10-11

First release.

### Added

- Auto-discovery of compose projects: every `docker-compose.dev.yml` (or `.yaml` / `compose.dev.*`) in a subfolder of `~/Sites`, plus any project `docker compose ls` already knows about. Scan directories are configurable with `DEVDOCK_DIRS`.
- Project actions: start, stop, restart, rebuild (`up -d --build`) and down (volumes kept, with confirmation).
- Per-service actions: start, stop, restart and logs.
- Status for each project (running, partly running, stopped) with per-service chips and health. Successful one-shot services such as `setup` show as done, and running one-off `docker compose run` containers count toward their service.
- One-click links to published ports.
- Log drawer with service picker, follow mode, copy and error highlighting.
- Live refresh, in-card progress and toasts when actions finish, with the full command output one click away.
- Summary stats, status filters and search.
- Light, dark and system themes.
- Keyboard shortcuts: `/` to search, `r` to refresh, `Esc` to close menus.
- Responsive layout down to phone width.
- Localhost-only server: binds to `127.0.0.1`, rejects foreign `Host` and `Origin` headers, and runs only a fixed set of `docker compose` actions for discovered projects, without a shell.
- README with setup, configuration, macOS auto-start instructions and screenshots.
- MIT license.

[Unreleased]: https://github.com/BasharLulu/devdock/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/BasharLulu/devdock/releases/tag/v1.0.0
