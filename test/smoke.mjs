#!/usr/bin/env node
// End-to-end smoke test: starts the server against a throwaway compose project and
// exercises discovery, the localhost guards, actions and logs. No dependencies.
// Run: node test/smoke.mjs   (needs Docker; uses port 7799 unless PORT is set)
import http from "node:http";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 7799);
const PROJECT = "devdock-smoke";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({ host: "127.0.0.1", port: PORT, method, path: url,
      headers: { host: `127.0.0.1:${PORT}`, ...(data && { "content-type": "application/json" }), ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on("error", reject);
    req.end(data);
  });
}

async function waitFor(fn, what, timeout = 120_000) {
  const start = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await sleep(500);
  }
}

let step = 0;
async function check(name, fn) {
  step++;
  await fn();
  console.log(`ok ${step} - ${name}`);
}

// Static check: the inline scripts in index.html must parse.
const html = readFileSync(path.join(ROOT, "index.html"), "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
assert.ok(scripts.length > 0, "index.html has inline scripts");
scripts.forEach((src, i) => {
  try { new Function(src); } catch (e) { throw new Error(`index.html inline script #${i + 1} doesn't parse: ${e.message}`); }
});
console.log(`ok 0 - index.html inline scripts parse (${scripts.length})`);

const dir = mkdtempSync(path.join(tmpdir(), "devdock-smoke-"));
const composeFile = path.join(dir, "smoke", "docker-compose.dev.yml");
mkdirSync(path.dirname(composeFile));
writeFileSync(composeFile, `name: ${PROJECT}
services:
  app:
    image: busybox:1.36
    command: ["sh", "-c", "echo devdock-smoke-ready && sleep 3600"]
    init: true
`);

const server = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
  env: { ...process.env, PORT: String(PORT), DEVDOCK_DIRS: dir },
  stdio: ["ignore", "inherit", "inherit"],
});

async function cleanup() {
  server.kill();
  try { execFileSync("docker", ["compose", "-f", composeFile, "-p", PROJECT, "down", "--remove-orphans"], { stdio: "ignore" }); } catch {}
  rmSync(dir, { recursive: true, force: true });
}

const api = `/api/projects/${PROJECT}`;
const project = async () => (await request("GET", "/api/projects")).json.projects.find((p) => p.name === PROJECT);
const finished = async () => { const j = (await request("GET", `${api}/job`)).json; return !j.running && j; };

try {
  await waitFor(async () => (await request("GET", "/")).status === 200, "server to start", 15_000);

  await check("serves the dashboard", async () => {
    const r = await request("GET", "/");
    assert.equal(r.status, 200);
    assert.match(r.text, /<title>Devdock<\/title>/);
  });

  await check("rejects a foreign Host header", async () => {
    assert.equal((await request("GET", "/api/projects", { headers: { host: "evil.example:7799" } })).status, 403);
  });

  await check("rejects a cross-origin POST", async () => {
    const r = await request("POST", `${api}/action`, { headers: { origin: "http://evil.example" }, body: { action: "up" } });
    assert.equal(r.status, 403);
  });

  await check("discovers the compose project", async () => {
    const r = await request("GET", "/api/projects");
    assert.equal(r.status, 200);
    assert.equal(r.json.docker, true, `Docker unreachable: ${r.json.error}`);
    const p = r.json.projects.find((x) => x.name === PROJECT);
    assert.ok(p, `${PROJECT} not found`);
    assert.equal(p.config, composeFile);
  });

  await check("rejects unknown projects, actions and bad service names", async () => {
    assert.equal((await request("POST", "/api/projects/nope/action", { body: { action: "up" } })).status, 404);
    assert.equal((await request("POST", `${api}/action`, { body: { action: "rm -rf" } })).status, 400);
    assert.equal((await request("POST", `${api}/action`, { body: { action: "up", service: "app; ls" } })).status, 400);
  });

  await check("starts the project", async () => {
    assert.equal((await request("POST", `${api}/action`, { body: { action: "up" } })).status, 202);
    const job = await waitFor(finished, "up to finish");
    assert.equal(job.ok, true, job.log);
    await waitFor(async () => (await project())?.running === 1, "container to be running", 15_000);
  });

  await check("returns service logs", async () => {
    await waitFor(async () => (await request("GET", `${api}/logs?service=app`)).json.log.includes("devdock-smoke-ready"), "log line", 15_000);
  });

  await check("stops the project", async () => {
    assert.equal((await request("POST", `${api}/action`, { body: { action: "stop" } })).status, 202);
    const job = await waitFor(finished, "stop to finish");
    assert.equal(job.ok, true, job.log);
    assert.equal((await project()).running, 0);
  });

  await check("removes the project's containers", async () => {
    assert.equal((await request("POST", `${api}/action`, { body: { action: "down" } })).status, 202);
    const job = await waitFor(finished, "down to finish");
    assert.equal(job.ok, true, job.log);
    assert.equal((await project()).containers.length, 0);
  });

  console.log("\nAll smoke tests passed.");
} catch (e) {
  console.error(`\nnot ok - ${e.message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
