"use strict";

// iCode's local product server. It uses Node's standard library only, so it
// remains runnable without an untrusted dependency install.
const http = require("node:http");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { createProvider } = require("./agent-provider");

const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.ICODE_DATA_DIR || path.join(ROOT, ".icode-data"));
const WORKSPACES = path.join(DATA_DIR, "workspaces");
const PORT = Number(process.argv[2] || process.env.PORT || 5173);
const HOST = "127.0.0.1";
const MAX_BODY = 1_100_000;
const MAX_FILE = 1_000_000;
const SESSION_TTL = 1000 * 60 * 60 * 24 * 14;
fssync.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "icode.db"));
const provider = createProvider();
const loginLimits = new Map();

const MIME = {
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".md": "text/markdown; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
};
const stamp = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const secret = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const nameOf = (value, max = 80) => String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
const slugOf = (value) => nameOf(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 55) || "untitled-project";
const validText = (value, max = MAX_FILE) => typeof value === "string" && Buffer.byteLength(value, "utf8") <= max && !value.includes("\0");

function migrate() {
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_files (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, file_path TEXT NOT NULL, content_hash TEXT NOT NULL, byte_size INTEGER NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id, file_path));
    CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('user','assistant','system')), content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL, instruction TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, completed_at TEXT, error TEXT);
    CREATE TABLE IF NOT EXISTS tool_calls (id TEXT PRIMARY KEY, agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, tool_name TEXT NOT NULL, input_json TEXT NOT NULL, output_json TEXT NOT NULL, status TEXT NOT NULL, duration_ms INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_versions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, label TEXT NOT NULL, manifest_json TEXT NOT NULL, changes_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS deployments (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, status TEXT NOT NULL, url TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, metric TEXT NOT NULL, quantity INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, setting_key TEXT NOT NULL, setting_value TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(user_id, setting_key));
    CREATE INDEX IF NOT EXISTS idx_project_owner ON projects(owner_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_run_project ON agent_runs(project_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_version_project ON project_versions(project_id, created_at DESC);
  `);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, ?)").run(stamp());
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  response.end(JSON.stringify(body));
}
const error = (response, status, message) => send(response, status, { error: message });
function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || "").split(";").map((part) => {
    const at = part.indexOf("="); return at < 0 ? [] : [part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1).trim())];
  }).filter((entry) => entry.length));
}
async function bodyOf(request) {
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY) throw new Error("Request exceeds the 1 MB limit.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Request body must be valid JSON."); }
}
function setSession(response, session) {
  response.setHeader("Set-Cookie", `icode_session=${encodeURIComponent(session)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL / 1000)}`);
}
function currentUser(request) {
  const session = parseCookies(request).icode_session;
  if (!session) return null;
  const user = db.prepare(`SELECT users.id, users.email, sessions.csrf_token, sessions.expires_at
    FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?`).get(hash(session));
  if (!user) return null;
  if (Date.parse(user.expires_at) <= Date.now()) { db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash(session)); return null; }
  return user;
}
function needsUser(request, response, changing = false) {
  const user = currentUser(request);
  if (!user) { error(response, 401, "Sign in to continue."); return null; }
  const origin = request.headers.origin;
  if (changing && (request.headers["x-icode-csrf"] !== user.csrf_token || (origin && origin !== `http://${HOST}:${PORT}`))) {
    error(response, 403, "Request could not be verified. Refresh and try again."); return null;
  }
  return user;
}
function projectFor(projectId, userId) { return db.prepare("SELECT * FROM projects WHERE id = ? AND owner_id = ?").get(projectId, userId); }
function needsProject(request, response, projectId, changing = false) {
  const user = needsUser(request, response, changing);
  if (!user) return null;
  const project = projectFor(projectId, user.id);
  if (!project) { error(response, 404, "Project not found."); return null; }
  return { user, project };
}

function workspace(projectId) { return path.resolve(WORKSPACES, projectId); }
function fileAt(projectId, rawPath) {
  if (typeof rawPath !== "string" || !rawPath || rawPath.length > 240 || rawPath.includes("\0")) throw new Error("A valid project-relative path is required.");
  const relative = path.posix.normalize(rawPath.replace(/\\/g, "/")).replace(/^\/+/, "");
  if (relative === "." || relative.startsWith("../") || relative.startsWith(".git/") || relative.includes("/.git/") || relative.includes("node_modules") || /(^|\/)\.env(?:\.|$)/.test(relative)) {
    throw new Error("That path is not available to iCode.");
  }
  const root = workspace(projectId);
  const target = path.resolve(root, ...relative.split("/"));
  if (!target.startsWith(root + path.sep)) throw new Error("Path escapes the project workspace.");
  return { relative, target };
}
const textFile = (filePath) => !/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|zip|pdf)$/i.test(filePath);
async function filesOf(projectId) {
  const files = [];
  async function visit(directory, prefix = "") {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative);
      else if (entry.isFile()) {
        const stat = await fs.stat(path.join(directory, entry.name));
        files.push({ path: relative, size: stat.size, text: textFile(relative) });
      }
      if (files.length >= 250) return;
    }
  }
  await visit(workspace(projectId)); return files;
}
async function readFile(projectId, filePath) {
  const file = fileAt(projectId, filePath);
  if (!textFile(file.relative)) throw new Error("Binary files cannot be opened in the editor.");
  const stat = await fs.stat(file.target);
  if (stat.size > MAX_FILE) throw new Error("This file is too large to open safely.");
  return { path: file.relative, content: await fs.readFile(file.target, "utf8"), updatedAt: stat.mtime.toISOString() };
}
async function saveFile(projectId, filePath, content) {
  if (!validText(content)) throw new Error("Only text files up to 1 MB may be saved.");
  const file = fileAt(projectId, filePath); await fs.mkdir(path.dirname(file.target), { recursive: true }); await fs.writeFile(file.target, content, "utf8");
  db.prepare(`INSERT INTO project_files(id, project_id, file_path, content_hash, byte_size, updated_at) VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, file_path) DO UPDATE SET content_hash=excluded.content_hash, byte_size=excluded.byte_size, updated_at=excluded.updated_at`)
    .run(uuid(), projectId, file.relative, hash(content), Buffer.byteLength(content), stamp());
  db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(stamp(), projectId);
  return { path: file.relative, bytes: Buffer.byteLength(content) };
}
async function snapshot(projectId) {
  const contents = {};
  for (const file of await filesOf(projectId)) if (file.text && file.size <= MAX_FILE) contents[file.path] = await fs.readFile(fileAt(projectId, file.path).target, "utf8");
  return contents;
}
async function version(projectId, label, changes = []) {
  const manifest = await snapshot(projectId);
  if (Buffer.byteLength(JSON.stringify(manifest)) > 2_000_000) return null;
  const record = { id: uuid(), project_id: projectId, label: nameOf(label, 110), manifest_json: JSON.stringify(manifest), changes_json: JSON.stringify(changes), created_at: stamp() };
  db.prepare("INSERT INTO project_versions(id, project_id, label, manifest_json, changes_json, created_at) VALUES(?, ?, ?, ?, ?, ?)").run(record.id, record.project_id, record.label, record.manifest_json, record.changes_json, record.created_at);
  return record;
}
async function restore(projectId, record) {
  const contents = JSON.parse(record.manifest_json), root = workspace(projectId);
  // root is created from a UUID and remains contained beneath WORKSPACES.
  await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root, { recursive: true });
  db.prepare("DELETE FROM project_files WHERE project_id = ?").run(projectId);
  for (const [filePath, content] of Object.entries(contents)) await saveFile(projectId, filePath, content);
}

function starter(name) {
  const project = nameOf(name, 50) || "My project";
  return {
    "README.md": `# ${project}\n\nThis project is managed by iCode. Ask the agent to build, refine, test, or debug it.\n`,
    "index.html": `<!doctype html>\n<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><meta name="description" content="Built with iCode" /><title>${project}</title><link rel="stylesheet" href="styles.css" /></head><body><main class="shell"><p class="eyebrow">Built with iCode</p><h1>${project}</h1><p>Describe what you want, then let iCode shape this starting point.</p></main><script src="app.js"></script></body></html>\n`,
    "styles.css": `:root{color-scheme:dark;--ink:#eef7f3;--muted:#9aaba5;--canvas:#101514;--accent:#8ee5c9}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--canvas);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,sans-serif}.shell{width:min(720px,calc(100% - 48px));margin:16vh auto}.eyebrow{color:var(--accent);font-size:.72rem;font-weight:800;letter-spacing:.13em;text-transform:uppercase}h1{max-width:12ch;margin:.2rem 0 1rem;font-size:clamp(3rem,9vw,6rem);letter-spacing:-.07em;line-height:.94}p{max-width:54ch;color:var(--muted);font-size:1.05rem;line-height:1.65}\n`,
    "app.js": `"use strict";\nconsole.info("${project} is ready.");\n`,
    "package.json": `{"name":"${slugOf(project)}","private":true,"scripts":{"check":"node --check app.js"}}\n`,
  };
}
function marketing(instruction, projectName) {
  const idea = nameOf(instruction.replace(/^(build|create|make)\s+(me\s+)?/i, ""), 110) || "a memorable product";
  const product = nameOf(projectName, 50) || "Atlas";
  return {
    "index.html": `<!doctype html>\n<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><meta name="description" content="${product} — ${idea}" /><title>${product}</title><link rel="stylesheet" href="styles.css" /></head><body><header class="nav wrap"><a class="logo" href="#top">${product}<b>.</b></a><button class="menu" type="button">Menu</button><nav><a href="#product">Product</a><a href="#proof">Why us</a><a class="button small" href="#start">Start free</a></nav></header><main id="top"><section class="hero wrap"><p class="eyebrow">A better way forward</p><h1>${idea}</h1><p class="lede">The focused workspace for ambitious teams. Move from the first idea to work your customers will love.</p><div class="actions"><a class="button" href="#start">Start building <span>→</span></a><a class="text-link" href="#product">See how it works</a></div><div class="hero-art" aria-hidden="true"><div class="orb one"></div><div class="orb two"></div><div class="signal"><span>Momentum</span><strong>+48%</strong><small>this month</small></div></div></section><section class="proof wrap" id="proof"><p>Designed for teams who make the next thing matter.</p><div><span>Northstar</span><span>Altitude</span><span>Frontier</span><span>Signal</span></div></section><section class="features wrap" id="product"><div><p class="eyebrow">Built for momentum</p><h2>Everything clear. Nothing in the way.</h2></div><div class="feature-list"><article><span>01</span><h3>Find your signal</h3><p>Turn scattered feedback into one confident next step.</p></article><article><span>02</span><h3>Move together</h3><p>A shared picture gives the whole team room to move faster.</p></article><article><span>03</span><h3>Measure what matters</h3><p>Keep the outcomes close without drowning in dashboards.</p></article></div></section><section class="cta wrap" id="start"><p class="eyebrow">Ready when you are</p><h2>Make the next move count.</h2><a class="button" href="mailto:hello@example.com">Talk to us <span>→</span></a></section></main><footer class="wrap"><a class="logo" href="#top">${product}<b>.</b></a><span>© ${new Date().getFullYear()} ${product}</span></footer><script src="app.js"></script></body></html>\n`,
    "styles.css": `:root{--paper:#f5f4ef;--ink:#17211e;--muted:#64716b;--line:#d8ddd7;--acid:#c7f76b;--dark:#17211e}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}a{color:inherit;text-decoration:none}.wrap{width:min(1120px,calc(100% - 48px));margin:auto}.nav{height:82px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}.logo{font-size:1.3rem;font-weight:850;letter-spacing:-.08em}.logo b{color:#6c9f38}.nav nav{display:flex;align-items:center;gap:25px;color:#52605a;font-size:.86rem}.menu{display:none;border:0;background:none;color:var(--ink)}.button{display:inline-flex;align-items:center;gap:20px;padding:14px 17px;background:var(--dark);color:#fff;font-size:.88rem;font-weight:750}.button span{font-size:1.25rem;line-height:.6}.small{padding:9px 13px}.hero{position:relative;min-height:650px;padding:108px 0 90px;overflow:hidden}.eyebrow{margin:0 0 17px;color:#66833e;font-size:.7rem;font-weight:850;letter-spacing:.15em;text-transform:uppercase}.hero h1,.features h2,.cta h2{max-width:11ch;margin:0;letter-spacing:-.075em;font-size:clamp(3.6rem,7.8vw,7.5rem);line-height:.86}.lede{max-width:41ch;margin:29px 0;color:var(--muted);font-size:1.05rem;line-height:1.65}.actions{display:flex;align-items:center;gap:26px}.text-link{font-size:.88rem;font-weight:720;text-decoration:underline;text-underline-offset:4px}.hero-art{position:absolute;z-index:-1;right:-80px;bottom:-70px;width:min(60vw,680px);height:500px;background:radial-gradient(circle at 66% 30%,#deff92,transparent 22%),radial-gradient(circle at 35% 65%,#9ad8be,transparent 29%),#d3d7ca;clip-path:polygon(22% 0,100% 8%,96% 92%,0 100%)}.orb{position:absolute;border-radius:50%}.one{top:55px;right:130px;width:180px;height:180px;background:#c0f48d}.two{bottom:28px;left:85px;width:250px;height:250px;background:#74c9b0}.signal{position:absolute;right:95px;bottom:87px;display:grid;gap:5px;width:172px;padding:19px;background:#fff;box-shadow:0 20px 55px rgba(32,49,42,.13)}.signal span,.signal small{color:var(--muted);font-size:.72rem}.signal strong{font-size:2rem;letter-spacing:-.08em}.proof{display:flex;gap:34px;align-items:center;justify-content:space-between;padding:26px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);color:var(--muted);font-size:.8rem}.proof p{margin:0}.proof div{display:flex;gap:31px;color:#9aa39d;font-weight:760}.features{display:grid;grid-template-columns:.9fr 1.1fr;gap:90px;padding:140px 0}.features h2{font-size:clamp(2.8rem,5vw,4.9rem)}.feature-list{border-top:1px solid var(--line)}.feature-list article{display:grid;grid-template-columns:55px 1fr;column-gap:17px;padding:28px 0;border-bottom:1px solid var(--line)}.feature-list span{grid-row:span 2;color:#779b50;font-size:.76rem;font-weight:800}.feature-list h3{margin:0;font-size:1.25rem;letter-spacing:-.04em}.feature-list p{grid-column:2;margin:8px 0 0;color:var(--muted);font-size:.9rem;line-height:1.55}.cta{padding:100px 0 120px;border-top:1px solid var(--line)}.cta h2{max-width:12ch;margin-bottom:34px;font-size:clamp(3rem,6vw,6rem)}footer{display:flex;justify-content:space-between;padding:24px 0;border-top:1px solid var(--line);color:var(--muted);font-size:.78rem}@media(max-width:720px){.wrap{width:min(100% - 32px,1120px)}.nav nav{display:none}.menu{display:block}.hero{min-height:590px;padding-top:78px}.hero-art{right:-190px;opacity:.68}.proof,.features{display:block}.proof div{margin-top:19px;gap:17px;flex-wrap:wrap}.features{padding:88px 0}.feature-list{margin-top:52px}.cta{padding:78px 0}.actions{align-items:flex-start;flex-direction:column;gap:17px}}\n`,
    "app.js": `"use strict";\nconst menu=document.querySelector(".menu");menu?.addEventListener("click",()=>{const nav=document.querySelector(".nav nav"),visible=nav.style.display==="flex";nav.style.display=visible?"":"flex";menu.textContent=visible?"Menu":"Close"});console.info("${product} preview is running.");\n`,
  };
}
function dashboard(projectName) {
  const product = nameOf(projectName, 50) || "Pulse";
  return {
    "index.html": `<!doctype html>\n<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${product} dashboard</title><link rel="stylesheet" href="styles.css" /></head><body><aside><a class="brand">${product}<b>.</b></a><nav><a class="active" href="#">Overview</a><a href="#">Customers</a><a href="#">Analytics</a><a href="#">Settings</a></nav><div class="user"><span>RS</span><div><strong>Ravi Singh</strong><small>Personal workspace</small></div></div></aside><main><header><div><p class="eyebrow">Overview</p><h1>Good morning, Ravi.</h1><p class="muted">Here’s what’s moving today.</p></div><button>Export report</button></header><section class="metrics"><article><span>Active customers</span><strong>24,620</strong><small>↗ 12.4% from last month</small></article><article><span>Conversion</span><strong>8.42%</strong><small>↗ 1.8% from last month</small></article><article><span>Revenue</span><strong>$48,290</strong><small>↗ 18.6% from last month</small></article></section><section class="panel"><div class="panel-head"><div><p class="eyebrow">Engagement</p><h2>Activity trend</h2></div><select><option>Last 30 days</option></select></div><div class="chart"><svg viewBox="0 0 800 240" preserveAspectRatio="none"><defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#a7efda" stop-opacity=".7"/><stop offset="1" stop-color="#a7efda" stop-opacity="0"/></linearGradient></defs><path d="M0 210 C55 190 80 197 120 155 S185 196 230 132 S290 145 335 112 S400 154 447 87 S512 129 560 74 S630 104 676 50 S738 72 800 18 V240 H0Z" fill="url(#fill)"/><path d="M0 210 C55 190 80 197 120 155 S185 196 230 132 S290 145 335 112 S400 154 447 87 S512 129 560 74 S630 104 676 50 S738 72 800 18" fill="none" stroke="#237d68" stroke-width="4"/></svg></div></section></main><script src="app.js"></script></body></html>\n`,
    "styles.css": `:root{--ink:#15211c;--muted:#738078;--line:#dbe4dd;--canvas:#f6f8f6;--mint:#dff7ed;--lime:#e9f5b7;--peach:#ffded8}*{box-sizing:border-box}body{min-height:100vh;margin:0;background:var(--canvas);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,sans-serif;display:grid;grid-template-columns:230px 1fr}aside{display:flex;min-height:100vh;flex-direction:column;padding:29px 18px;border-right:1px solid var(--line);background:#fbfcfb}.brand{font-size:1.3rem;font-weight:850;letter-spacing:-.08em}.brand b{color:#40a486}nav{display:grid;gap:5px;margin-top:63px}nav a{padding:10px 11px;border-radius:5px;color:#66736b;font-size:.88rem;text-decoration:none}nav a.active{background:#e7f3ed;color:#1b493b;font-weight:740}.user{display:flex;align-items:center;gap:9px;margin-top:auto;padding-top:20px;border-top:1px solid var(--line)}.user>span{display:grid;width:31px;height:31px;place-items:center;border-radius:50%;background:#244a40;color:white;font-size:.67rem;font-weight:800}.user strong,.user small{display:block}.user strong{font-size:.75rem}.user small{margin-top:3px;color:var(--muted);font-size:.65rem}main{width:min(1120px,100%);padding:56px clamp(25px,6vw,86px)}header{display:flex;align-items:start;justify-content:space-between;gap:20px}.eyebrow{margin:0 0 7px;color:#758b7c;font-size:.67rem;font-weight:800;letter-spacing:.13em;text-transform:uppercase}h1{margin:0;letter-spacing:-.055em;font-size:clamp(2rem,4vw,3.4rem)}h2{margin:0;font-size:1.25rem;letter-spacing:-.035em}.muted{color:var(--muted)}header button{padding:10px 13px;border:1px solid #c9d4cc;background:#fff;color:#44544c;font:inherit;font-size:.78rem}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:45px 0 16px}.metrics article{display:grid;gap:13px;min-height:155px;padding:20px;border:1px solid var(--line);background:#fff}.metrics article:nth-child(1){background:var(--mint)}.metrics article:nth-child(2){background:var(--lime)}.metrics article:nth-child(3){background:var(--peach)}.metrics span{font-size:.76rem}.metrics strong{font-size:2rem;letter-spacing:-.07em}.metrics small{color:#627067;font-size:.7rem}.panel{padding:24px;border:1px solid var(--line);background:#fff}.panel-head{display:flex;align-items:start;justify-content:space-between}.panel-head select{padding:7px;border:1px solid var(--line);background:#fff;color:var(--muted);font-size:.72rem}.chart{height:275px;margin-top:20px;border-bottom:1px solid var(--line);background:repeating-linear-gradient(0deg,transparent 0,transparent 55px,#edf1ed 56px)}.chart svg{width:100%;height:100%}@media(max-width:780px){body{display:block}aside{display:none}main{padding:32px 18px}.metrics{grid-template-columns:1fr}.chart{height:180px}}\n`,
    "app.js": `"use strict";\nconsole.info("${product} dashboard is ready.");\n`,
  };
}

async function tool(runId, toolName, input, action) {
  const started = Date.now();
  try {
    const result = await action();
    const output = result === undefined ? { ok: true } : result;
    db.prepare("INSERT INTO tool_calls(id, agent_run_id, tool_name, input_json, output_json, status, duration_ms, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)")
      .run(uuid(), runId, toolName, JSON.stringify(input), JSON.stringify(output), "completed", Date.now() - started, stamp());
    return output;
  } catch (cause) {
    db.prepare("INSERT INTO tool_calls(id, agent_run_id, tool_name, input_json, output_json, status, duration_ms, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)")
      .run(uuid(), runId, toolName, JSON.stringify(input), JSON.stringify({ error: cause.message }), "failed", Date.now() - started, stamp());
    throw cause;
  }
}
function checkProject(projectId, purpose) {
  return new Promise((resolve) => {
    const root = workspace(projectId);
    const entry = ["app.js", "src/app.js", "src/index.js"].find((candidate) => fssync.existsSync(path.join(root, candidate)));
    if (!entry) return resolve({ command: "node --check", exitCode: 1, stdout: "", stderr: "No JavaScript entry file was found.", durationMs: 0, purpose });
    const started = Date.now();
    const child = spawn(process.execPath, ["--check", entry], { cwd: root, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; });
    const timeout = setTimeout(() => child.kill(), 10_000);
    child.on("close", (exitCode) => { clearTimeout(timeout); resolve({ command: `${process.execPath} --check ${entry}`, exitCode: exitCode ?? 1, stdout, stderr, durationMs: Date.now() - started, purpose }); });
    child.on("error", (cause) => { clearTimeout(timeout); resolve({ command: `${process.execPath} --check ${entry}`, exitCode: 1, stdout, stderr: cause.message, durationMs: Date.now() - started, purpose }); });
  });
}
async function darkMode(projectId, changes) {
  let content = (await readFile(projectId, "styles.css")).content;
  if (!content.includes("iCode dark-mode")) {
    content += `\n/* iCode dark-mode */\n@media (prefers-color-scheme: dark){:root{--paper:#101513;--ink:#e8f2ed;--muted:#9caca4;--line:#2a3932;--canvas:#101513;--dark:#e8f2ed}body{background:var(--paper);color:var(--ink)}.button{background:var(--ink);color:#101513}.panel,.metrics article,header button{background:#18211d;border-color:var(--line)}}\n`;
    await saveFile(projectId, "styles.css", content); changes.push({ path: "styles.css", kind: "modified" });
  }
}
async function contactForm(projectId, changes) {
  const index = await readFile(projectId, "index.html");
  if (index.content.includes('id="contact-form"')) return;
  const form = `<section class="contact" id="contact"><p class="eyebrow">Get in touch</p><h2>Start a conversation.</h2><form id="contact-form"><label>Name<input required name="name" autocomplete="name" /></label><label>Email<input required type="email" name="email" autocomplete="email" /></label><label>How can we help?<textarea required name="message" rows="4"></textarea></label><button class="button" type="submit">Send message <span>→</span></button><p class="form-note" role="status"></p></form></section>`;
  await saveFile(projectId, "index.html", index.content.replace("</main>", `${form}</main>`)); changes.push({ path: "index.html", kind: "modified" });
  await saveFile(projectId, "styles.css", (await readFile(projectId, "styles.css")).content + `\n.contact{padding:90px 0;border-top:1px solid var(--line)}.contact h2{margin:0 0 30px;font-size:clamp(2.4rem,5vw,4.6rem);letter-spacing:-.07em}.contact form{display:grid;max-width:580px;gap:16px}.contact label{display:grid;gap:7px;font-size:.78rem;font-weight:720}.contact input,.contact textarea{width:100%;padding:12px;border:1px solid var(--line);border-radius:0;background:transparent;color:inherit;font:inherit}.contact .button{width:max-content;border:0}.form-note{min-height:1.4em;margin:0;color:var(--muted);font-size:.82rem}\n`); changes.push({ path: "styles.css", kind: "modified" });
  await saveFile(projectId, "app.js", (await readFile(projectId, "app.js")).content + `\nconst contactForm=document.querySelector("#contact-form");contactForm?.addEventListener("submit",(event)=>{event.preventDefault();contactForm.querySelector(".form-note").textContent="Thanks — we’ll be in touch soon.";contactForm.reset()});\n`); changes.push({ path: "app.js", kind: "modified" });
}
async function runAgent(project, instruction) {
  const request = nameOf(instruction, 1000);
  if (!request) throw new Error("Tell iCode what you want to build.");
  const at = stamp();
  let conversation = db.prepare("SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1").get(project.id);
  if (!conversation) {
    conversation = { id: uuid(), project_id: project.id, title: "Build session", created_at: at, updated_at: at };
    db.prepare("INSERT INTO conversations(id, project_id, title, created_at, updated_at) VALUES(?, ?, ?, ?, ?)").run(conversation.id, conversation.project_id, conversation.title, conversation.created_at, conversation.updated_at);
  }
  db.prepare("INSERT INTO messages(id, conversation_id, role, content, created_at) VALUES(?, ?, ?, ?, ?)").run(uuid(), conversation.id, "user", request, at);
  const run = { id: uuid(), project_id: project.id, conversation_id: conversation.id, instruction: request, started_at: at };
  db.prepare("INSERT INTO agent_runs(id, project_id, conversation_id, instruction, status, started_at) VALUES(?, ?, ?, ?, ?, ?)").run(run.id, project.id, conversation.id, request, "running", at);
  const changes = [];
  try {
    const inspected = await tool(run.id, "list_files", {}, () => filesOf(project.id));
    await tool(run.id, "create_version", { label: "Before: " + request }, () => version(project.id, "Before: " + request));
    const plan = provider.plan({ instruction: request, fileCount: inspected.length });
    if (plan.dashboard || plan.scaffold) {
      const generated = plan.dashboard ? dashboard(project.name) : marketing(request, project.name);
      for (const [filePath, content] of Object.entries(generated)) {
        await tool(run.id, "write_file", { path: filePath, bytes: Buffer.byteLength(content) }, () => saveFile(project.id, filePath, content));
        changes.push({ path: filePath, kind: inspected.some((file) => file.path === filePath) ? "modified" : "created" });
      }
    }
    if (plan.darkMode) await tool(run.id, "edit_file", { path: "styles.css", intent: "add dark mode" }, () => darkMode(project.id, changes));
    if (plan.contactForm) await tool(run.id, "edit_file", { path: "index.html", intent: "add contact form" }, () => contactForm(project.id, changes));
    let verification = await tool(run.id, "run_build_check", { command: "node --check" }, () => checkProject(project.id, "agent verification"));
    let repaired = false;
    if (verification.exitCode !== 0) {
      const cleanApp = `"use strict";\nconsole.info("Repaired by iCode after verification.");\n`;
      await tool(run.id, "write_file", { path: "app.js", reason: "repair a syntax failure" }, () => saveFile(project.id, "app.js", cleanApp));
      changes.push({ path: "app.js", kind: "modified" }); repaired = true;
      verification = await tool(run.id, "run_build_check", { command: "node --check", attempt: 2 }, () => checkProject(project.id, "repair verification"));
      if (verification.exitCode !== 0) throw new Error(verification.stderr || "Verification still failed after the repair.");
    }
    const changed = [...new Map(changes.map((item) => [item.path, item])).values()];
    await tool(run.id, "create_version", { label: "After: " + request }, () => version(project.id, "After: " + request, changed));
    const summary = changed.length ? `I inspected ${inspected.length} files, updated ${changed.length} file${changed.length === 1 ? "" : "s"}, and verified the JavaScript entry point.${repaired ? " I repaired a syntax failure and verified again." : ""}` : "I inspected the project and ran a real JavaScript verification. No file changes were needed.";
    db.prepare("UPDATE agent_runs SET status = ?, summary = ?, completed_at = ? WHERE id = ?").run("completed", summary, stamp(), run.id);
    db.prepare("INSERT INTO messages(id, conversation_id, role, content, created_at) VALUES(?, ?, ?, ?, ?)").run(uuid(), conversation.id, "assistant", summary, stamp());
    db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(stamp(), conversation.id);
    db.prepare("INSERT INTO usage(id, user_id, metric, quantity, created_at) VALUES(?, ?, ?, ?, ?)").run(uuid(), project.owner_id, "agent_run", 1, stamp());
    return { run: { ...run, status: "completed", summary }, changes: changed, verification };
  } catch (cause) {
    db.prepare("UPDATE agent_runs SET status = ?, error = ?, completed_at = ? WHERE id = ?").run("failed", cause.message, stamp(), run.id);
    throw cause;
  }
}

async function staticFile(response, url) {
  let relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  if (relative.includes("\0") || relative.includes("..")) return error(response, 403, "Forbidden");
  relative = relative.replace(/^\/+/, "");
  const target = path.resolve(ROOT, relative);
  if (!target.startsWith(ROOT + path.sep)) return error(response, 403, "Forbidden");
  try {
    if (!(await fs.stat(target)).isFile()) throw new Error("Not a file");
    response.writeHead(200, { "Content-Type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; connect-src 'self'; frame-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'" });
    fssync.createReadStream(target).pipe(response);
  } catch { error(response, 404, "Not found"); }
}
async function preview(request, response, projectId, rawPath) {
  if (!needsProject(request, response, projectId)) return;
  try {
    const source = rawPath || "index.html", file = fileAt(projectId, source.endsWith("/") ? source + "index.html" : source);
    if (!(await fs.stat(file.target)).isFile()) throw new Error("Not a file");
    response.writeHead(200, { "Content-Type": MIME[path.extname(file.target).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; connect-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'self'" });
    fssync.createReadStream(file.target).pipe(response);
  } catch (cause) { error(response, 404, cause.message || "Preview file not found."); }
}

async function route(request, response) {
  const url = new URL(request.url, `http://${HOST}:${PORT}`), { pathname } = url;
  if (request.method === "GET" && pathname.startsWith("/preview/")) {
    const [, , projectId, ...tail] = pathname.split("/"); return preview(request, response, projectId, tail.join("/"));
  }
  if (!pathname.startsWith("/api/")) return staticFile(response, url);
  if (request.method === "GET" && pathname === "/api/health") return send(response, 200, { status: "ok", service: "iCode", version: "0.1.0" });
  if (request.method === "GET" && pathname === "/api/auth/me") {
    const user = currentUser(request); return send(response, 200, user ? { user: { id: user.id, email: user.email }, csrfToken: user.csrf_token } : { user: null });
  }
  if (request.method === "POST" && pathname === "/api/auth/register") {
    const data = await bodyOf(request), email = String(data.email || "").trim().toLowerCase(), password = String(data.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) return error(response, 400, "Enter a valid email address.");
    if (password.length < 8 || password.length > 200) return error(response, 400, "Use a password between 8 and 200 characters.");
    if (db.prepare("SELECT id FROM users WHERE email = ?").get(email)) return error(response, 409, "An account with that email already exists.");
    const user = { id: uuid(), email, salt: secret(16), created: stamp() }, passwordHash = crypto.scryptSync(password, user.salt, 64).toString("hex");
    db.prepare("INSERT INTO users(id, email, password_hash, password_salt, created_at) VALUES(?, ?, ?, ?, ?)").run(user.id, user.email, passwordHash, user.salt, user.created);
    const session = secret(), csrfToken = secret();
    db.prepare("INSERT INTO sessions(token_hash, user_id, csrf_token, expires_at, created_at) VALUES(?, ?, ?, ?, ?)").run(hash(session), user.id, csrfToken, new Date(Date.now() + SESSION_TTL).toISOString(), stamp());
    setSession(response, session); return send(response, 201, { user: { id: user.id, email }, csrfToken });
  }
  if (request.method === "POST" && pathname === "/api/auth/login") {
    const data = await bodyOf(request), email = String(data.email || "").trim().toLowerCase(), password = String(data.password || ""), limit = loginLimits.get(email) || { count: 0, reset: Date.now() + 60_000 };
    if (limit.reset < Date.now()) { limit.count = 0; limit.reset = Date.now() + 60_000; }
    if (limit.count >= 8) return error(response, 429, "Too many attempts. Try again in a minute.");
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email), calculated = crypto.scryptSync(password, user ? user.password_salt : "invalid-salt", 64).toString("hex");
    if (!user || !crypto.timingSafeEqual(Buffer.from(calculated), Buffer.from(user.password_hash))) { limit.count += 1; loginLimits.set(email, limit); return error(response, 401, "Email or password is incorrect."); }
    loginLimits.delete(email); const session = secret(), csrfToken = secret();
    db.prepare("INSERT INTO sessions(token_hash, user_id, csrf_token, expires_at, created_at) VALUES(?, ?, ?, ?, ?)").run(hash(session), user.id, csrfToken, new Date(Date.now() + SESSION_TTL).toISOString(), stamp());
    setSession(response, session); return send(response, 200, { user: { id: user.id, email: user.email }, csrfToken });
  }
  if (request.method === "POST" && pathname === "/api/auth/logout") {
    const user = needsUser(request, response, true); if (!user) return;
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash(parseCookies(request).icode_session));
    response.setHeader("Set-Cookie", "icode_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"); return send(response, 200, { ok: true });
  }
  if (request.method === "GET" && pathname === "/api/projects") {
    const user = needsUser(request, response); if (!user) return;
    return send(response, 200, { projects: db.prepare("SELECT id, name, slug, description, created_at, updated_at FROM projects WHERE owner_id = ? ORDER BY updated_at DESC").all(user.id) });
  }
  if (request.method === "POST" && pathname === "/api/projects") {
    const user = needsUser(request, response, true); if (!user) return;
    const data = await bodyOf(request), name = nameOf(data.name), description = nameOf(data.description, 240);
    if (name.length < 2) return error(response, 400, "Give the project a name with at least two characters.");
    const project = { id: uuid(), owner_id: user.id, name, slug: slugOf(name), description, created_at: stamp(), updated_at: stamp() };
    db.prepare("INSERT INTO projects(id, owner_id, name, slug, description, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)").run(project.id, project.owner_id, project.name, project.slug, project.description, project.created_at, project.updated_at);
    await fs.mkdir(workspace(project.id), { recursive: true });
    const initial = starter(name); for (const [filePath, content] of Object.entries(initial)) await saveFile(project.id, filePath, content);
    await version(project.id, "Project created", Object.keys(initial).map((filePath) => ({ path: filePath, kind: "created" })));
    return send(response, 201, { project });
  }
  const match = pathname.match(/^\/api\/projects\/([a-f0-9-]{36})(?:\/(.*))?$/i);
  if (match) {
    const [, projectId, action = ""] = match, context = needsProject(request, response, projectId, request.method !== "GET"); if (!context) return;
    if (request.method === "GET" && action === "") return send(response, 200, { project: context.project });
    if (request.method === "GET" && action === "files") return send(response, 200, { files: await filesOf(projectId) });
    if (request.method === "GET" && action === "file") { try { return send(response, 200, await readFile(projectId, url.searchParams.get("path"))); } catch (cause) { return error(response, 400, cause.message); } }
    if (request.method === "PUT" && action === "file") { try { const data = await bodyOf(request); return send(response, 200, { file: await saveFile(projectId, data.path, data.content) }); } catch (cause) { return error(response, 400, cause.message); } }
    if (request.method === "POST" && action === "file/delete") { try { const data = await bodyOf(request), file = fileAt(projectId, data.path); await fs.rm(file.target, { force: true }); db.prepare("DELETE FROM project_files WHERE project_id = ? AND file_path = ?").run(projectId, file.relative); return send(response, 200, { deleted: file.relative }); } catch (cause) { return error(response, 400, cause.message); } }
    if (request.method === "POST" && action === "agent") { try { return send(response, 200, await runAgent(context.project, (await bodyOf(request)).instruction)); } catch (cause) { return error(response, 422, cause.message); } }
    if (request.method === "POST" && action === "commands") {
      const command = String((await bodyOf(request)).command || ""); if (!["check", "build", "test"].includes(command)) return error(response, 400, "Only the safe check, build, and test actions are available in this local sandbox.");
      return send(response, 200, { result: await checkProject(projectId, command) });
    }
    if (request.method === "GET" && action === "history") {
      const versions = db.prepare("SELECT id, label, changes_json, created_at FROM project_versions WHERE project_id = ? ORDER BY created_at DESC LIMIT 25").all(projectId).map((row) => ({ ...row, changes: JSON.parse(row.changes_json) }));
      const runs = db.prepare("SELECT id, instruction, status, summary, started_at, completed_at, error FROM agent_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT 12").all(projectId);
      const messages = db.prepare("SELECT messages.role, messages.content, messages.created_at FROM messages JOIN conversations ON conversations.id = messages.conversation_id WHERE conversations.project_id = ? ORDER BY messages.created_at DESC LIMIT 30").all(projectId).reverse();
      return send(response, 200, { versions, runs, messages });
    }
    const restoreMatch = action.match(/^versions\/([a-f0-9-]{36})\/restore$/i);
    if (request.method === "POST" && restoreMatch) {
      const record = db.prepare("SELECT * FROM project_versions WHERE id = ? AND project_id = ?").get(restoreMatch[1], projectId);
      if (!record) return error(response, 404, "Version not found.");
      await version(projectId, "Before restoring " + record.label); await restore(projectId, record); return send(response, 200, { restored: record.label });
    }
  }
  return error(response, 404, "API endpoint not found.");
}

async function main() {
  await fs.mkdir(WORKSPACES, { recursive: true }); migrate();
  const server = http.createServer((request, response) => route(request, response).catch((cause) => { console.error("Request failed", cause); if (!response.headersSent) error(response, 500, "The server could not complete that request."); else response.end(); }));
  server.headersTimeout = 15_000; server.requestTimeout = 15_000;
  server.listen(PORT, HOST, () => console.log(`iCode is live at http://${HOST}:${PORT}/`));
}
main().catch((cause) => { console.error(cause); process.exitCode = 1; });
