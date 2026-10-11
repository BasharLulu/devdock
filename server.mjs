#!/usr/bin/env node
// Devdock: a tiny local dashboard for starting/stopping docker compose projects.
// Run: node server.mjs   then open http://127.0.0.1:7777
import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { readFile, readdir, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 7777);
const HOST = "127.0.0.1";
const SCAN_DIRS = (process.env.DEVDOCK_DIRS || path.join(os.homedir(), "Sites")).split(":");
const COMPOSE_NAMES = ["docker-compose.dev.yml", "docker-compose.dev.yaml", "compose.dev.yml", "compose.dev.yaml"];
const DOCKER = ["/usr/local/bin/docker", "/opt/homebrew/bin/docker"].find(existsSync) || "docker";
const HERE = path.dirname(fileURLToPath(import.meta.url));

// project name -> { running: bool, action, log: string, ok: bool|null, at }
const jobs = new Map();
// project name -> config file path, refreshed on each listing; actions only accept names in here
let known = new Map();

function run(args, opts = {}) {
  return new Promise((resolve) => {
    execFile(DOCKER, args, { maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout, stderr: stderr || (err && err.message) || "" }));
  });
}

async function scanComposeFiles() {
  const found = new Map();
  for (const dir of SCAN_DIRS) {
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      for (const f of COMPOSE_NAMES) {
        const file = path.join(dir, e.name, f);
        try { await access(file); } catch { continue; }
        let name = null;
        try {
          const m = (await readFile(file, "utf8")).match(/^name:\s*["']?([\w.-]+)/m);
          if (m) name = m[1];
        } catch {}
        name ||= `${e.name.toLowerCase().replace(/[^a-z0-9_-]/g, "")}-dev`;
        if (!found.has(name)) found.set(name, file);
        break;
      }
    }
  }
  return found;
}

function pickConfig(configFiles) {
  const files = configFiles.split(",").filter(Boolean);
  return files.find((f) => !f.includes("/.claude/worktrees/") && !f.includes("/copilot-worktrees/")) || files[0];
}

async function listProjects() {
  const [scanned, ls, ps] = await Promise.all([
    scanComposeFiles(),
    run(["compose", "ls", "-a", "--format", "json"]),
    run(["ps", "-a", "--filter", "label=com.docker.compose.project", "--format", "{{json .}}"]),
  ]);

  const configs = new Map(scanned);
  if (ls.ok) {
    for (const p of JSON.parse(ls.stdout || "[]")) {
      if (!configs.has(p.Name)) configs.set(p.Name, pickConfig(p.ConfigFiles));
    }
  }
  known = configs;

  const byProject = new Map();
  if (ps.ok) {
    for (const line of ps.stdout.split("\n").filter(Boolean)) {
      const c = JSON.parse(line);
      const labels = Object.fromEntries(c.Labels.split(",").map((kv) => {
        const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)];
      }));
      const project = labels["com.docker.compose.project"];
      if (!byProject.has(project)) byProject.set(project, []);
      const ports = [...new Set((c.Ports || "").split(", ")
        .map((p) => p.match(/(?:0\.0\.0\.0|\[::\]|127\.0\.0\.1):(\d+)->/)?.[1]).filter(Boolean))].map(Number);
      byProject.get(project).push({
        id: c.ID,
        name: c.Names,
        service: labels["com.docker.compose.service"],
        oneoff: labels["com.docker.compose.oneoff"] === "True",
        state: c.State,
        status: c.Status,
        image: c.Image,
        ports,
      });
    }
  }

  const projects = [...configs].map(([name, config]) => {
    const containers = (byProject.get(name) || []).sort((a, b) =>
      a.oneoff - b.oneoff || a.service.localeCompare(b.service));
    const running = containers.filter((c) => c.state === "running").length;
    const job = jobs.get(name);
    return {
      name,
      config,
      dir: path.dirname(config),
      containers,
      running,
      ports: [...new Set(containers.filter((c) => c.state === "running").flatMap((c) => c.ports))],
      job: job ? { running: job.running, action: job.action, ok: job.ok, at: job.at } : null,
    };
  }).sort((a, b) => (b.running > 0) - (a.running > 0) || a.name.localeCompare(b.name));

  return { docker: ls.ok, error: ls.ok ? null : ls.stderr.trim(), projects };
}

const ACTIONS = {
  up: (svc) => ["up", "-d", ...svc],
  rebuild: (svc) => ["up", "-d", "--build", ...svc],
  stop: (svc) => ["stop", ...svc],
  restart: (svc) => ["restart", ...svc],
  down: () => ["down", "--remove-orphans"],
};

function startJob(project, action, service) {
  const config = known.get(project);
  if (!config) throw Object.assign(new Error("unknown project"), { status: 404 });
  if (!ACTIONS[action]) throw Object.assign(new Error("unknown action"), { status: 400 });
  if (service && !/^[\w.-]+$/.test(service)) throw Object.assign(new Error("bad service"), { status: 400 });
  if (jobs.get(project)?.running) throw Object.assign(new Error("an action is already running"), { status: 409 });

  const args = ["compose", "-f", config, "-p", project, ...ACTIONS[action](service ? [service] : [])];
  const job = { running: true, action: service ? `${action} ${service}` : action, log: `$ docker ${args.join(" ")}\n`, ok: null, at: Date.now() };
  jobs.set(project, job);
  const child = spawn(DOCKER, args, { cwd: path.dirname(config), env: { ...process.env, COMPOSE_ANSI: "never" } });
  const append = (d) => { job.log = (job.log + d.toString()).slice(-200_000); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("close", (code) => { job.running = false; job.ok = code === 0; append(`\n[exit ${code}]\n`); });
  child.on("error", (e) => { job.running = false; job.ok = false; append(`\n${e.message}\n`); });
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) { body += chunk; if (body.length > 10_000) break; }
  return body ? JSON.parse(body) : {};
}

function send(res, status, data, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(data) : data);
}

const server = http.createServer(async (req, res) => {
  // Only accept requests addressed to this local server (blocks DNS-rebinding / cross-site POSTs).
  const host = req.headers.host || "";
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return send(res, 403, { error: "forbidden" });
  if (req.method === "POST") {
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) return send(res, 403, { error: "forbidden" });
  }

  const url = new URL(req.url, `http://${host}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, await readFile(path.join(HERE, "index.html")), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/api/projects") {
      return send(res, 200, await listProjects());
    }
    const m = url.pathname.match(/^\/api\/projects\/([\w.-]+)\/(action|job|logs)$/);
    if (m) {
      const [, project, kind] = m;
      if (!known.size) await listProjects();
      if (!known.has(project)) return send(res, 404, { error: "unknown project" });

      if (kind === "action" && req.method === "POST") {
        const { action, service } = await readBody(req);
        startJob(project, action, service);
        return send(res, 202, { ok: true });
      }
      if (kind === "job" && req.method === "GET") {
        const job = jobs.get(project);
        return send(res, 200, job || { running: false, log: "" });
      }
      if (kind === "logs" && req.method === "GET") {
        const service = url.searchParams.get("service");
        if (service && !/^[\w.-]+$/.test(service)) return send(res, 400, { error: "bad service" });
        const r = await run(["compose", "-f", known.get(project), "-p", project, "logs", "--no-color", "--tail", "300", "--timestamps",
          ...(service ? [service] : [])], { cwd: path.dirname(known.get(project)) });
        return send(res, 200, { log: r.stdout + (r.ok ? "" : r.stderr) });
      }
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => console.log(`Devdock running at http://${HOST}:${PORT}  (scanning ${SCAN_DIRS.join(", ")})`));
