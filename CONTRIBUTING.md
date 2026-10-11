# Contributing to Devdock

Thanks for your interest! Devdock is a small personal tool, so contributions are welcome but kept deliberately simple.

## Reporting bugs

Open an issue and include:

- Your OS, Node version (`node -v`) and Docker version (`docker version`)
- What you did, what you expected, and what happened
- Relevant output from the server (or `~/Library/Logs/devdock.log` if you use the macOS login agent)
- Output of `docker compose ls -a` if a project is missing or shown with the wrong status

Please remove anything private (paths, project names, env values) before posting.

## Suggesting features

Open an issue first to discuss it before writing code, so we can agree it fits before you spend time on it.

## Development

There's nothing to install or build:

```bash
node server.mjs
```

Then open http://127.0.0.1:7777. The server reads `index.html` on every request, so refresh the page to see UI changes; restart the server after editing `server.mjs`.

Before opening a pull request, run the smoke test (needs Docker):

```bash
node test/smoke.mjs
```

## Guidelines

- **No dependencies.** Node built-ins on the server, plain HTML/CSS/JS in a single `index.html` on the client. No npm packages, frameworks or build steps.
- **Stay local.** The server must keep binding to `127.0.0.1` and keep its `Host`/`Origin` checks. Commands go through `execFile`/`spawn` with argument arrays, never a shell, and only for discovered projects.
- **Match the existing style.** Same naming, comment density and formatting as the surrounding code.
- **Check both themes and phone width** for UI changes.
- **Keep pull requests focused** on one change, and add a line under `Unreleased` in [CHANGELOG.md](CHANGELOG.md).

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Make your change and test it against real compose projects.
3. Open a pull request describing what changed and why, with a screenshot for UI changes.

Please note that this project has a [Code of Conduct](CODE_OF_CONDUCT.md); by participating you agree to follow it.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
