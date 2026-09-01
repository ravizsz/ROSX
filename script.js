"use strict";

const state = { user: null, csrf: null, projects: [], project: null, files: [], activeFile: null, openFiles: [], fileContent: "", dirty: false, history: { versions: [], messages: [], runs: [] }, changes: [] };
const $ = (selector) => document.querySelector(selector);
const dom = {
  authShell: $("#authShell"), appShell: $("#appShell"), authForm: $("#authForm"), authTitle: $("#authTitle"), authEyebrow: $("#authEyebrow"), authMode: $("#authMode"), authSubmit: $("#authSubmit"), authError: $("#authError"), authEmail: $("#authEmail"), authPassword: $("#authPassword"),
  projectSelect: $("#projectSelect"), projectName: $("#projectName"), projectDescription: $("#projectDescription"), fileTree: $("#fileTree"), tabs: $("#tabs"), editorEmpty: $("#editorEmpty"), editorArea: $("#editorArea"), editor: $("#codeEditor"), lineNumbers: $("#lineNumbers"), breadcrumbs: $("#breadcrumbs"), syntaxStatus: $("#syntaxStatus"), cursorStatus: $("#cursorStatus"), fileLanguage: $("#fileLanguage"), savedState: $("#savedState"),
  chatLog: $("#chatLog"), promptForm: $("#promptForm"), promptInput: $("#promptInput"), runAgentButton: $("#runAgentButton"), terminalOutput: $("#terminalOutput"), terminalForm: $("#terminalForm"), commandSelect: $("#commandSelect"), changesContent: $("#changesContent"), historyContent: $("#historyContent"), consoleContent: $("#consoleContent"), previewPane: $("#previewPane"), previewFrame: $("#previewFrame"), previewEmpty: $("#previewEmpty"), previewPath: $("#previewPath"), toast: $("#toast"),
  projectModal: $("#projectModal"), projectForm: $("#projectForm"), projectError: $("#projectError"), projectNameInput: $("#newProjectName"), projectDescriptionInput: $("#newProjectDescription"), activity: $("#activityStatus"), changeCount: $("#changeCount"), logout: $("#logoutButton"), explorer: $("#explorer")
};
function clear(element) { while (element.firstChild) element.removeChild(element.firstChild); }
function el(tag, text, className) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function toast(message) { dom.toast.textContent = message; dom.toast.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => dom.toast.classList.remove("show"), 2600); }
function setActivity(value) { dom.activity.textContent = value; }
function language(filePath) { const ext = (filePath || "").split(".").pop().toLowerCase(); return ({ js: "JavaScript", jsx: "JavaScript React", ts: "TypeScript", tsx: "TypeScript React", css: "CSS", html: "HTML", json: "JSON", md: "Markdown", py: "Python", yml: "YAML", yaml: "YAML" })[ext] || "Plain text"; }
function kind(filePath) { const ext = (filePath || "").split(".").pop().toLowerCase(); return ({ css: "css", json: "json", md: "md" })[ext] || "code"; }
function setSaved(value) { state.dirty = value; dom.savedState.innerHTML = "<span></span>" + (value ? "Unsaved changes" : "Saved"); renderTabs(); }
async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) }, method = (options.method || "GET").toUpperCase();
  if (state.csrf && method !== "GET" && method !== "HEAD") headers["X-iCode-CSRF"] = state.csrf;
  if (options.body && typeof options.body !== "string") { headers["Content-Type"] = "application/json"; options.body = JSON.stringify(options.body); }
  const response = await fetch(path, { ...options, headers }), payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "The request could not be completed.");
  return payload;
}
function ago(value) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
  return Math.floor(seconds / 86400) + "d ago";
}

async function initialize() {
  try {
    const auth = await api("/api/auth/me");
    if (!auth.user) return showAuth();
    state.user = auth.user; state.csrf = auth.csrfToken; await showApp();
  } catch (cause) { showAuth(); dom.authError.textContent = "iCode local server is unavailable. Start it and refresh."; }
}
function showAuth() { dom.authShell.classList.remove("hidden"); dom.appShell.classList.add("hidden"); }
async function showApp() {
  dom.authShell.classList.add("hidden"); dom.appShell.classList.remove("hidden"); dom.logout.textContent = state.user.email;
  await loadProjects(); if (!state.projects.length) openProjectModal();
}
async function loadProjects(preferredId) {
  const result = await api("/api/projects"); state.projects = result.projects; clear(dom.projectSelect);
  for (const project of state.projects) { const option = el("option", project.name); option.value = project.id; dom.projectSelect.append(option); }
  const selected = state.projects.find((project) => project.id === preferredId) || state.projects.find((project) => project.id === localStorage.getItem("icode-current-project")) || state.projects[0];
  if (selected) { dom.projectSelect.value = selected.id; await selectProject(selected.id); } else resetProject();
}
function resetProject() {
  state.project = null; state.files = []; state.activeFile = null; state.openFiles = []; state.changes = [];
  dom.projectName.textContent = "No project yet"; dom.projectDescription.textContent = "Create a safe local workspace"; clear(dom.fileTree); clear(dom.tabs);
  dom.editorEmpty.classList.remove("hidden"); dom.editorArea.classList.add("hidden"); dom.previewFrame.removeAttribute("src"); dom.previewEmpty.classList.remove("hidden"); renderChat(); renderChanges(); renderHistory();
}
async function selectProject(id) {
  const result = await api("/api/projects/" + id); state.project = result.project; localStorage.setItem("icode-current-project", id); dom.projectSelect.value = id;
  dom.projectName.textContent = state.project.name; dom.projectDescription.textContent = state.project.description || "Local iCode workspace";
  state.activeFile = null; state.openFiles = []; state.fileContent = ""; setSaved(false);
  await Promise.all([loadFiles(), loadHistory()]); loadPreview(); setActivity("Ready");
}
async function loadFiles() {
  if (!state.project) return; const result = await api("/api/projects/" + state.project.id + "/files"); state.files = result.files; renderTree();
}
function renderTree() {
  clear(dom.fileTree);
  if (!state.files.length) { dom.fileTree.append(el("p", "No files yet.", "empty-panel")); return; }
  let folder = "";
  for (const file of state.files) {
    const pieces = file.path.split("/"), nextFolder = pieces.length > 1 ? pieces.slice(0, -1).join("/") : "root";
    if (nextFolder !== folder) { folder = nextFolder; dom.fileTree.append(el("p", folder, "tree-folder")); }
    const button = el("button", "", "tree-file"); button.type = "button"; button.dataset.kind = kind(file.path); button.classList.toggle("active", file.path === state.activeFile);
    button.append(el("span", file.text ? "◇" : "▣", "file-glyph"), el("span", pieces[pieces.length - 1]));
    button.addEventListener("click", () => openFile(file.path)); dom.fileTree.append(button);
  }
}
async function openFile(path) {
  if (!state.project) return;
  if (state.dirty && state.activeFile !== path) { if (window.confirm("Save your current edits before opening another file?")) await saveCurrent(); else setSaved(false); }
  try {
    const file = await api("/api/projects/" + state.project.id + "/file?path=" + encodeURIComponent(path));
    state.activeFile = file.path; state.fileContent = file.content; if (!state.openFiles.includes(file.path)) state.openFiles.push(file.path);
    dom.editor.value = file.content; dom.editorEmpty.classList.add("hidden"); dom.editorArea.classList.remove("hidden");
    const pieces = file.path.split("/"); clear(dom.breadcrumbs); dom.breadcrumbs.append(el("span", pieces.slice(0, -1).join("/") || "root"), el("span", "  /  "), el("strong", pieces[pieces.length - 1]));
    dom.fileLanguage.textContent = language(file.path); dom.syntaxStatus.textContent = "Ready"; setSaved(false); renderMeta(); renderTree(); dom.editor.focus();
  } catch (cause) { toast(cause.message); }
}
function renderTabs() {
  clear(dom.tabs);
  for (const path of state.openFiles) {
    const button = el("button", "", "tab"); button.type = "button"; button.classList.toggle("active", path === state.activeFile);
    const pieces = path.split("/"); button.append(el("span", "◇", "tab-dot"), el("span", pieces[pieces.length - 1]));
    if (state.dirty && path === state.activeFile) button.append(el("span", "•", "tab-dot"));
    const close = el("span", "×", "tab-close"); close.title = "Close tab"; close.addEventListener("click", (event) => { event.stopPropagation(); closeTab(path); });
    button.append(close); button.addEventListener("click", () => openFile(path)); dom.tabs.append(button);
  }
}
function closeTab(path) {
  const index = state.openFiles.indexOf(path); if (index < 0) return; state.openFiles.splice(index, 1);
  if (state.activeFile === path) {
    const next = state.openFiles[index] || state.openFiles[index - 1]; state.activeFile = null; state.fileContent = ""; setSaved(false);
    if (next) openFile(next); else { dom.editorEmpty.classList.remove("hidden"); dom.editorArea.classList.add("hidden"); dom.breadcrumbs.textContent = "Select a file to begin"; }
  }
  renderTabs();
}
function renderMeta() {
  const lines = dom.editor.value.split("\n"), position = dom.editor.selectionStart, line = dom.editor.value.slice(0, position).split("\n").length, col = position - dom.editor.value.lastIndexOf("\n", position - 1);
  dom.lineNumbers.textContent = lines.map((_, index) => String(index + 1)).join("\n"); dom.cursorStatus.textContent = "Ln " + line + ", Col " + col;
}
async function saveCurrent() {
  if (!state.project || !state.activeFile) return;
  try {
    dom.syntaxStatus.textContent = "Saving…"; const content = dom.editor.value;
    await api("/api/projects/" + state.project.id + "/file", { method: "PUT", body: { path: state.activeFile, content } });
    state.fileContent = content; setSaved(false); dom.syntaxStatus.textContent = "Saved"; await loadFiles(); loadPreview(); toast("File saved to the workspace.");
  } catch (cause) { dom.syntaxStatus.textContent = "Save failed"; toast(cause.message); }
}
async function createFile() {
  if (!state.project) return; const path = window.prompt("Project-relative file path:", "src/new-file.js"); if (!path) return;
  try { await api("/api/projects/" + state.project.id + "/file", { method: "PUT", body: { path, content: "" } }); await loadFiles(); await openFile(path); toast("New file created."); } catch (cause) { toast(cause.message); }
}
async function deleteCurrent() {
  if (!state.project || !state.activeFile || !window.confirm("Delete " + state.activeFile + "? This removes the file from the project.")) return;
  try {
    await api("/api/projects/" + state.project.id + "/file/delete", { method: "POST", body: { path: state.activeFile } });
    state.openFiles = state.openFiles.filter((path) => path !== state.activeFile); state.activeFile = null; state.fileContent = ""; setSaved(false);
    dom.editorEmpty.classList.remove("hidden"); dom.editorArea.classList.add("hidden"); dom.breadcrumbs.textContent = "Select a file to begin"; await loadFiles(); renderTabs(); loadPreview(); toast("File deleted.");
  } catch (cause) { toast(cause.message); }
}

async function loadHistory() {
  if (!state.project) return; state.history = await api("/api/projects/" + state.project.id + "/history"); renderChat(); renderChanges(); renderHistory();
}
function renderChat() {
  clear(dom.chatLog); const messages = state.history.messages || [];
  if (!messages.length) { dom.chatLog.append(el("div", "I’ll inspect your project first, then write and verify the smallest useful change. Try “Build a SaaS dashboard” or “Add a contact form.”", "chat-empty")); return; }
  for (const item of messages) {
    if (item.role === "user") dom.chatLog.append(el("article", item.content, "message user"));
    else { const box = el("article", "", "message assistant"); box.append(el("div", "iCode agent", "message-assistant-title"), el("div", item.content)); dom.chatLog.append(box); }
  }
  dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
}
function renderChanges() {
  clear(dom.changesContent); const items = state.changes.length ? state.changes : ((state.history.versions || [])[0]?.changes || []); dom.changeCount.textContent = items.length;
  if (!items.length) { dom.changesContent.append(el("p", "No changes to review yet.", "empty-panel")); return; }
  const list = el("div", "", "change-list");
  for (const item of items) { const row = el("div", "", "change-row"), itemKind = item.kind || "modified"; row.append(el("span", itemKind, "change-kind " + itemKind), el("span", item.path || "Project file")); list.append(row); }
  dom.changesContent.append(list);
}
function renderHistory() {
  clear(dom.historyContent); const versions = state.history.versions || [];
  if (!versions.length) { dom.historyContent.append(el("p", "Versions will appear after a project change.", "empty-panel")); return; }
  const list = el("div", "", "history-list");
  for (const record of versions) {
    const row = el("div", "", "history-row"), words = document.createElement("div"), amount = (record.changes || []).length;
    words.append(el("strong", record.label), el("span", ago(record.created_at) + " · " + amount + " files"));
    const restore = el("button", "Restore"); restore.type = "button"; restore.addEventListener("click", () => restoreVersion(record)); row.append(words, restore); list.append(row);
  }
  dom.historyContent.append(list);
}
async function restoreVersion(record) {
  if (!state.project || !window.confirm("Restore “" + record.label + "”? iCode will first save the current state as a new version.")) return;
  try {
    await api("/api/projects/" + state.project.id + "/versions/" + record.id + "/restore", { method: "POST", body: {} });
    state.activeFile = null; state.openFiles = []; state.changes = []; dom.editorEmpty.classList.remove("hidden"); dom.editorArea.classList.add("hidden");
    await Promise.all([loadFiles(), loadHistory()]); loadPreview(); toast("Restored " + record.label + ".");
  } catch (cause) { toast(cause.message); }
}
async function runAgent(value) {
  if (!state.project) { openProjectModal(); return; } const instruction = (value || dom.promptInput.value).trim(); if (!instruction) return;
  dom.promptInput.value = ""; dom.runAgentButton.disabled = true; const phases = ["Inspecting project", "Planning changes", "Editing files", "Verifying"]; let phase = 0; setActivity(phases[phase]);
  const timer = setInterval(() => { phase = Math.min(phase + 1, phases.length - 1); setActivity(phases[phase]); }, 850);
  try {
    const result = await api("/api/projects/" + state.project.id + "/agent", { method: "POST", body: { instruction } });
    state.changes = result.changes || []; addTerminal(result.verification, "Agent verification"); await Promise.all([loadFiles(), loadHistory()]);
    if (state.activeFile && state.changes.some((item) => item.path === state.activeFile)) await openFile(state.activeFile); loadPreview(); toast("Agent run completed and verification finished.");
  } catch (cause) {
    const box = el("article", "", "message assistant"); box.append(el("div", "iCode agent", "message-assistant-title"), el("div", "Run stopped: " + cause.message)); dom.chatLog.append(box); dom.chatLog.scrollTop = dom.chatLog.scrollHeight; toast(cause.message);
  } finally { clearInterval(timer); dom.runAgentButton.disabled = false; setActivity("Ready"); }
}
function addTerminal(result, title) {
  const line = el("div", title + ": " + result.command + " → exit " + result.exitCode + " (" + result.durationMs + "ms)", result.exitCode === 0 ? "ok" : "bad");
  dom.terminalOutput.append(line); for (const value of [result.stdout, result.stderr]) if (value) dom.terminalOutput.append(el("div", value.trim(), result.exitCode === 0 ? "ok" : "bad"));
  dom.terminalOutput.scrollTop = dom.terminalOutput.scrollHeight; $("#consoleBadge").textContent = dom.terminalOutput.children.length;
}
async function runCommand() {
  if (!state.project) return; const command = dom.commandSelect.value; setActivity("Running " + command);
  try { const result = await api("/api/projects/" + state.project.id + "/commands", { method: "POST", body: { command } }); addTerminal(result.result, "Sandbox"); toast(result.result.exitCode === 0 ? "Verification completed." : "Verification reported an error."); } catch (cause) { toast(cause.message); } finally { setActivity("Ready"); }
}
function loadPreview() {
  if (!state.project) return; dom.previewEmpty.classList.add("hidden"); dom.previewPath.textContent = "/"; dom.previewFrame.src = "/preview/" + state.project.id + "/index.html?revision=" + Date.now();
}
function bottomTab(name) {
  document.querySelectorAll(".bottom-tab").forEach((button) => button.classList.toggle("active", button.dataset.bottomTab === name));
  dom.consoleContent.classList.toggle("hidden", name !== "console"); dom.changesContent.classList.toggle("hidden", name !== "changes"); dom.historyContent.classList.toggle("hidden", name !== "history");
}
function openProjectModal() { dom.projectError.textContent = ""; dom.projectModal.classList.remove("hidden"); setTimeout(() => dom.projectNameInput.focus(), 30); }
function closeProjectModal() { dom.projectModal.classList.add("hidden"); dom.projectForm.reset(); }

let registering = false;
dom.authMode.addEventListener("click", () => {
  registering = !registering; dom.authError.textContent = ""; dom.authEyebrow.textContent = registering ? "Start with iCode" : "Welcome to iCode"; dom.authTitle.textContent = registering ? "Create your local account." : "Sign in and keep building.";
  dom.authSubmit.innerHTML = registering ? "Create account <span>→</span>" : "Sign in <span>→</span>"; dom.authMode.textContent = registering ? "Sign in instead" : "Create an account"; dom.authMode.parentElement.firstChild.textContent = registering ? "Already have an account? " : "New to iCode? "; dom.authPassword.autocomplete = registering ? "new-password" : "current-password";
});
dom.authForm.addEventListener("submit", async (event) => {
  event.preventDefault(); dom.authError.textContent = ""; dom.authSubmit.disabled = true;
  try { const result = await api(registering ? "/api/auth/register" : "/api/auth/login", { method: "POST", body: { email: dom.authEmail.value, password: dom.authPassword.value } }); state.user = result.user; state.csrf = result.csrfToken; await showApp(); } catch (cause) { dom.authError.textContent = cause.message; } finally { dom.authSubmit.disabled = false; }
});
dom.projectForm.addEventListener("submit", async (event) => {
  event.preventDefault(); dom.projectError.textContent = "";
  try { const result = await api("/api/projects", { method: "POST", body: { name: dom.projectNameInput.value, description: dom.projectDescriptionInput.value } }); closeProjectModal(); await loadProjects(result.project.id); toast("Project created with a safe starter."); } catch (cause) { dom.projectError.textContent = cause.message; }
});
dom.projectSelect.addEventListener("change", () => selectProject(dom.projectSelect.value));
$("#openProjectModal").addEventListener("click", openProjectModal); $("#closeProjectModal").addEventListener("click", closeProjectModal); dom.projectModal.addEventListener("click", (event) => { if (event.target === dom.projectModal) closeProjectModal(); });
$("#newFileButton").addEventListener("click", createFile); $("#refreshFiles").addEventListener("click", () => loadFiles().then(() => toast("Files refreshed."))); $("#saveButton").addEventListener("click", saveCurrent); $("#deleteFileButton").addEventListener("click", deleteCurrent);
dom.editor.addEventListener("input", () => { setSaved(dom.editor.value !== state.fileContent); renderMeta(); }); dom.editor.addEventListener("click", renderMeta); dom.editor.addEventListener("keyup", renderMeta);
dom.editor.addEventListener("keydown", (event) => {
  if (event.key === "Tab") { event.preventDefault(); const start = dom.editor.selectionStart, end = dom.editor.selectionEnd; dom.editor.setRangeText("  ", start, end, "end"); dom.editor.dispatchEvent(new Event("input")); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); saveCurrent(); }
});
dom.promptForm.addEventListener("submit", (event) => { event.preventDefault(); runAgent(); }); dom.promptInput.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); runAgent(); } });
dom.terminalForm.addEventListener("submit", (event) => { event.preventDefault(); runCommand(); });
document.querySelectorAll(".bottom-tab").forEach((button) => button.addEventListener("click", () => bottomTab(button.dataset.bottomTab)));
document.querySelectorAll(".side-action").forEach((button) => button.addEventListener("click", () => bottomTab(button.dataset.sideTab)));
$("#togglePreviewButton").addEventListener("click", () => dom.previewPane.classList.add("open")); $("#closePreview").addEventListener("click", () => dom.previewPane.classList.remove("open")); $("#refreshPreview").addEventListener("click", loadPreview); $("#toggleExplorer").addEventListener("click", () => dom.explorer.classList.toggle("open"));
$("#clearChat").addEventListener("click", () => { clear(dom.chatLog); dom.chatLog.append(el("div", "Visible chat cleared. Your persisted agent history remains in the project timeline.", "chat-empty")); });
dom.logout.addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST", body: {} }); } catch (cause) { /* expired session is already safe */ }
  state.user = null; state.csrf = null; state.projects = []; resetProject(); showAuth(); dom.authPassword.value = ""; toast("Signed out.");
});
initialize();
