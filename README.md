# iCode

An AI-native, local-first coding workspace: create a project, describe what you
want, review actual file changes, run a real verification command, inspect the
preview, and restore a previous project version.

## Run locally

This runtime has no external package dependency.

~~~powershell
node static-server.js
~~~

Then open `http://127.0.0.1:5173`. Create a local account, create a project,
and send an instruction such as `Build a SaaS dashboard with a dark mode`.

## What is implemented

- Local email/password sessions with scrypt password hashes, HTTP-only cookies,
  SameSite policy, CSRF protection, rate-limited sign-in, and server-side
  project authorization.
- SQLite persistence for users, projects, file metadata, conversations,
  messages, agent runs, tool calls, versions, deployments, usage, and settings.
- Per-project workspaces behind path-traversal and secret-file protections.
- A local agent loop that inspects files, snapshots the project, writes files,
  runs a real `node --check` verification, records every tool call, retries a
  syntax repair when needed, and stores an after-version.
- Real editor saves, file creation/deletion, authenticated live preview, safe
  build/test/check controls, change review, and version restore.

The built-in provider is deliberately deterministic and tool-backed so the
product works without an API key. Provider-specific model execution can be
added behind the agent boundary without giving a model direct filesystem or
terminal access.

## Verify

~~~powershell
node --check static-server.js
node --check script.js
node --test tests/icode-server.test.js
~~~

The end-to-end test creates an isolated temporary database and verifies account
creation, project creation, an agent build, file persistence, verification,
history, preview authorization, and path traversal rejection.

## Local data

The running app keeps its database and project workspaces in `.icode-data/`,
which is intentionally gitignored. The existing ROSX research files that were
already in this repository remain untouched.
