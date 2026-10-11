#!/usr/bin/env node
// Devdock: a tiny local dashboard for starting/stopping docker compose projects.
// Run: node server.mjs   then open http://127.0.0.1:7777
import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { readFile, readdir, access, stat } from "node:fs/promises";
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
const CONFIG_FILE = process.env.DEVDOCK_CONFIG || path.join(os.homedir(), ".config", "devdock", "config.json");
const PINGERER_TTL = 60_000;

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

// ~/.config/devdock/config.json, re-read whenever it changes on disk.
let config = { mtimeMs: null, data: {}, error: null };
async function loadConfig() {
  let st;
  try { st = await stat(CONFIG_FILE); } catch { config = { mtimeMs: null, data: {}, error: null }; return config; }
  if (st.mtimeMs === config.mtimeMs) return config;
  try {
    const data = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
    config = { mtimeMs: st.mtimeMs, data, error: null };
    if (data.pingerer?.token && st.mode & 0o077) console.warn(`Warning: ${CONFIG_FILE} holds a token but is readable by other users. Run: chmod 600 ${CONFIG_FILE}`);
  } catch (e) {
    config = { mtimeMs: st.mtimeMs, data: {}, error: `Couldn't read ${CONFIG_FILE.replace(os.homedir(), "~")}: ${e.message}` };
  }
  return config;
}

const normHost = (h) => String(h).trim().toLowerCase().replace(/^www\./, "").replace(/:\d+$/, "");
// Template defaults, wildcards, IPs and ERB/env interpolation aren't real public hostnames.
const NOT_A_SITE = /(^|\.)example\.(com|org|net)$|^localhost$|^\d{1,3}(\.\d{1,3}){3}$|[*<>%{}$\s\[\]]/;
const unquote = (v) => v.trim().replace(/^["']|["']$/g, "");

// Reads proxy.host / proxy.hosts from a Kamal deploy file without a YAML parser.
function kamalHosts(yaml) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => /^proxy:\s*(#.*)?$/.test(l));
  if (start < 0) return [];
  const hosts = [];
  let childIndent = null, inHosts = false;
  for (const raw of lines.slice(start + 1)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const line = raw.replace(/\s+#.*$/, "");
    const indent = line.match(/^ */)[0].length;
    if (indent === 0) break;
    childIndent ??= indent;
    const t = line.trim();
    if (inHosts && (indent > childIndent || t.startsWith("- "))) {
      const item = t.match(/^-\s*(.+)$/);
      if (item) hosts.push(unquote(item[1]));
      continue;
    }
    if (indent !== childIndent) continue;
    inHosts = /^hosts:$/.test(t);
    const one = t.match(/^host:\s*(.+)$/);
    const inline = t.match(/^hosts:\s*\[(.*)\]$/);
    if (one) hosts.push(unquote(one[1]));
    else if (inline) hosts.push(...inline[1].split(",").map(unquote));
  }
  return hosts.map((h) => h.toLowerCase()).filter((h) => h && !NOT_A_SITE.test(h));
}

// Links from config/deploy.yml (production) and config/deploy.<destination>.yml, plus config.json overrides.
async function projectLinks(name, dir, overrides = {}) {
  const links = [];
  if (overrides.detect !== false) {
    let files = [];
    try { files = await readdir(path.join(dir, "config")); } catch {}
    for (const f of files.sort()) {
      const m = f.match(/^deploy(?:\.([\w.-]+))?\.ya?ml$/);
      if (!m) continue;
      let yaml = "";
      try { yaml = await readFile(path.join(dir, "config", f), "utf8"); } catch { continue; }
      for (const host of kamalHosts(yaml)) links.push({ label: m[1] || "production", url: `https://${host}`, source: "kamal" });
    }
  }
  for (const l of overrides.links || []) {
    let u;
    try { u = new URL(l.url); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const i = links.findIndex((x) => normHost(new URL(x.url).host) === normHost(u.host));
    const link = { label: String(l.label || "site"), url: u.href.replace(/\/$/, ""), source: "config" };
    i >= 0 ? (links[i] = link) : links.push(link);
  }
  const seen = new Set();
  return links
    .map((l) => ({ ...l, host: new URL(l.url).host }))
    .filter((l) => !seen.has(normHost(l.host)) && seen.add(normHost(l.host)))
    .sort((a, b) => (b.label === "production") - (a.label === "production"));
}

// Site status from Pingerer (https://pingerer.com), fetched at most once a minute and only when a token is configured.
const pingerer = { key: null, at: 0, inflight: null, byHost: new Map(), error: null };
function refreshPingerer(p) {
  const key = p?.token ? JSON.stringify([p.token, p.url, p.accounts]) : null;
  if (key !== pingerer.key) Object.assign(pingerer, { key, at: 0, byHost: new Map(), error: null });
  if (!key || pingerer.inflight || Date.now() - pingerer.at < PINGERER_TTL) return pingerer.inflight;
  pingerer.inflight = (async () => {
    const byHost = new Map();
    try {
      const base = new URL(p.url || "https://pingerer.com");
      if (base.protocol !== "https:" && !/^(127\.0\.0\.1|localhost)$/.test(base.hostname)) throw new Error("pingerer.url must use https");
      for (const account of p.accounts?.length ? p.accounts : [null]) {
        for (let page = 1; page;) {
          const r = await fetch(new URL(`/api/v1/sites?per_page=100&page=${page}`, base), {
            headers: { authorization: `Bearer ${p.token}`, accept: "application/json", ...(account && { "pingerer-account": String(account) }) },
            signal: AbortSignal.timeout(10_000),
          });
          const body = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(body.message || body.error || `HTTP ${r.status}`);
          for (const s of body.data || []) byHost.set(normHost(s.host), { status: s.paused ? "paused" : s.status, since: s.last_status_change_at });
          page = body.meta?.next_page || 0;
        }
      }
      if (key === pingerer.key) Object.assign(pingerer, { byHost, error: null });
    } catch (e) {
      if (key === pingerer.key) pingerer.error = e.name === "TimeoutError" ? "request timed out" : e.message;
    } finally {
      if (key === pingerer.key) pingerer.at = Date.now();
      pingerer.inflight = null;
    }
  })();
  return pingerer.inflight;
}

function pickConfig(configFiles) {
  const files = configFiles.split(",").filter(Boolean);
  return files.find((f) => !f.includes("/.claude/worktrees/") && !f.includes("/copilot-worktrees/")) || files[0];
}

async function listProjects() {
  const { data: settings, error: configError } = await loadConfig();
  refreshPingerer(settings.pingerer);
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

  const projects = (await Promise.all([...configs].map(async ([name, config]) => {
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
      links: (await projectLinks(name, path.dirname(config), settings.projects?.[name])).map((l) => {
        const status = pingerer.byHost.get(normHost(l.host));
        return status ? { ...l, ...status } : l;
      }),
    };
  }))).sort((a, b) => (b.running > 0) - (a.running > 0) || a.name.localeCompare(b.name));

  return {
    docker: ls.ok,
    error: ls.ok ? null : ls.stderr.trim(),
    configError,
    pingerer: pingerer.key ? { error: pingerer.error, checkedAt: pingerer.at || null } : null,
    projects,
  };
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
