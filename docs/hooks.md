# Wiring the hooks

Three hooks make the relay and the model router automatic. They go in
`~/.claude/settings.json`, merged with whatever is already there.

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{
      "type": "command",
      "command": "\"$HOME/.claude/mods/bin/ccmod\" hook session-start",
      "timeout": 10
    }]}],
    "UserPromptSubmit": [{ "hooks": [{
      "type": "command",
      "command": "\"$HOME/.claude/mods/bin/ccmod\" hook user-prompt-submit",
      "timeout": 10
    }]}],
    "Stop": [{ "hooks": [{
      "type": "command",
      "command": "\"$HOME/.claude/mods/bin/ccmod\" hook stop",
      "timeout": 15,
      "asyncRewake": true,
      "rewakeMessage": "A peer Claude Code session sent you work:"
    }]}]
  },
  "statusLine": {
    "type": "command",
    "command": "\"$HOME/.claude/mods/bin/statusline\"",
    "padding": 0
  }
}
```

What each one does:

- **SessionStart** registers the session with the relay and delivers anything
  waiting for it.
- **UserPromptSubmit** delivers relay mail mid-conversation and classifies the
  prompt for model routing. Classification is pure regex — no API call, no
  added latency.
- **Stop** with `asyncRewake` wakes an idle session when a peer sends it work,
  capped at five consecutive wakes so two sessions cannot ping-pong.

`ccmod install` has already copied `agents/haiku-worker.md` and the folders
under `skills/` into `~/.claude`; if you skipped it, run it now. Only this
settings block is left by hand, because `settings.json` is yours to merge.

Run `ccmod doctor` to check all of it — `✓` is wired, `·` is an optional
config falling back to defaults, `✗` needs attention.

The paths above assume the checkout is at `~/.claude/mods`. If you cloned it
somewhere else, point the commands at that `bin/ccmod` instead; your data stays
in `~/.claude/mods/data` either way.

See [`api.md`](api.md) for the HTTP API the explorer and the pane talk to.
