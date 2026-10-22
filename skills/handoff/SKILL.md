---
name: handoff
description: Package the current work into a self-contained handoff and send it to another Claude Code session. Use when the user says to hand off, delegate to another session, "let the builder take it from here", or when you've finished planning and implementation should happen elsewhere.
---

# Handoff

A handoff is a relay message that another session can act on **without seeing
this conversation**. The failure mode is sending something only you understand.

## Write the brief first

Never hand off a one-liner. Produce these six things, then send them:

1. **Goal** — what "done" means, in one sentence.
2. **Context** — the two or three facts the other session cannot derive from the
   code (a decision made here, a constraint from the user, a dead end).
3. **Files** — exact paths, with line numbers where it matters.
4. **Steps** — ordered, concrete, each independently checkable.
5. **Out of scope** — what not to touch. This is the most valuable line; it
   prevents the other session from redesigning your decisions.
6. **Verification** — the command that proves it worked.

If the brief is long, write it to a file and reference the path — the message
body should still carry the goal and the file pointer, so the recipient knows
what it's looking at before opening anything.

## Send it

```bash
ccmod relay send builder "$(cat <<'BRIEF'
GOAL: Move session storage from JSON files to SQLite, same public API.

CONTEXT:
- User wants zero migration downtime; read path must tolerate both formats
  during rollout.
- We rejected better-sqlite3 — node:sqlite is built in, no native build step.

FILES:
- src/store/sessions.ts      (the only module that touches disk)
- src/store/sessions.test.ts (14 existing tests must stay green)

STEPS:
1. Add a SQLite backend behind the existing SessionStore interface.
2. On read, fall back to the JSON file when a row is missing.
3. Write through to SQLite only. Leave the JSON files on disk.

OUT OF SCOPE: the public API, the HTTP layer, anything in src/api/.

VERIFY: npm test -- sessions
BRIEF
)" --kind handoff
```

For structured data the recipient should parse, add `--payload '{"files":[...]}'`.

## Then tell the user

Say which session you handed to and what it will do. The user is the one who has
to go look at that session's window, so don't leave it implicit.

## Receiving a handoff

Restate the goal in one line before starting, so a misread surfaces immediately.
Work the steps in order. Report back with `ccmod relay send <sender> "..."` —
what landed, what you verified, and anything that blocked you. A blocked handoff
reported early is worth far more than a guess carried to completion.

See the `relay` skill for peers, naming, and plain messaging.
