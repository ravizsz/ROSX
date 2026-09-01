"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const test = require("node:test");

const port = 5179;
let server;
let dataDir;

async function request(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

test.before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "icode-test-"));
  server = spawn(process.execPath, ["static-server.js", String(port)], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, ICODE_DATA_DIR: dataDir },
    windowsHide: true,
  });
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const result = await request("/api/health");
      if (result.response.ok) return;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error("Test server did not start.");
});

test.after(async () => {
  if (server && !server.killed) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

test("iCode preserves a secure project workflow end to end", async () => {
  const registration = await request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "engineer@example.com", password: "secure-passphrase" }),
  });
  assert.equal(registration.response.status, 201);
  const cookie = registration.response.headers.get("set-cookie").split(";")[0];
  const headers = { "Content-Type": "application/json", Cookie: cookie, "X-iCode-CSRF": registration.payload.csrfToken };

  const created = await request("/api/projects", { method: "POST", headers, body: JSON.stringify({ name: "Northstar", description: "Test workspace" }) });
  assert.equal(created.response.status, 201);
  const projectId = created.payload.project.id;

  const agent = await request(`/api/projects/${projectId}/agent`, { method: "POST", headers, body: JSON.stringify({ instruction: "Build a SaaS dashboard with a dark mode" }) });
  assert.equal(agent.response.status, 200, JSON.stringify(agent.payload));
  assert.equal(agent.payload.verification.exitCode, 0);
  assert.ok(agent.payload.changes.some((change) => change.path === "index.html"));

  const file = await request(`/api/projects/${projectId}/file?path=app.js`, { headers: { Cookie: cookie } });
  assert.equal(file.response.status, 200);
  assert.match(file.payload.content, /dashboard is ready/);

  const history = await request(`/api/projects/${projectId}/history`, { headers: { Cookie: cookie } });
  assert.equal(history.response.status, 200);
  assert.ok(history.payload.versions.length >= 3);
  assert.equal(history.payload.runs[0].status, "completed");

  const preview = await fetch(`http://127.0.0.1:${port}/preview/${projectId}/index.html`, { headers: { Cookie: cookie } });
  assert.equal(preview.status, 200);
  assert.match(await preview.text(), /Northstar dashboard/);

  const traversal = await request(`/api/projects/${projectId}/file?path=..%2F..%2Fpackage.json`, { headers: { Cookie: cookie } });
  assert.equal(traversal.response.status, 400);
});
