# Security Policy

## Supported versions

Only the latest release receives security fixes.

| Version | Supported |
| ------- | --------- |
| 1.x     | Yes       |
| < 1.0   | No        |

## Reporting a vulnerability

**Please don't report security issues in public issues, pull requests or discussions.**

Report them privately through GitHub instead:

1. Go to the [Security tab](https://github.com/BasharLulu/devdock/security) of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, how to reproduce it, and its impact. A proof of concept helps.

You can expect an acknowledgement within a few days. Once the issue is confirmed, a fix will be released as soon as practical and you'll be credited in the advisory unless you'd rather stay anonymous.

## Security model

Devdock can start, stop and remove Docker containers, so it is designed to be reachable only from your own machine:

- The server binds to `127.0.0.1` only.
- Requests whose `Host` header isn't `127.0.0.1` or `localhost` are rejected, which blocks DNS-rebinding attacks.
- `POST` requests with a foreign `Origin` are rejected, which blocks cross-site requests from other web pages.
- Actions are limited to a fixed set (`up`, `up --build`, `stop`, `restart`, `down`) on projects Devdock discovered itself, and service names are validated.
- Commands run through `execFile`/`spawn` with argument arrays, never a shell.

There is **no authentication**. Anything that can reach the port can control your containers.

### In scope

- Bypassing the `Host`/`Origin` checks or otherwise triggering actions from a web page or remote host
- Running commands, actions or arguments outside the fixed set, including via crafted project or service names
- Reading files or data outside what the dashboard is meant to show
- Cross-site scripting in the dashboard, for example via container names, statuses or log output

### Out of scope

- Exposing the port to a network yourself (port forwarding, tunnels, reverse proxies, binding to `0.0.0.0`)
- Malicious software already running on the same machine as your user
- Vulnerabilities in Docker, Docker Compose, Node.js or the containers you run
- What your own compose files do when Devdock starts them
