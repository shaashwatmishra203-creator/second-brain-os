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

Copy `agents/haiku-worker.md` to `~/.claude/agents/` for the cheap-model
subagent, and the folders under `skills/` to `~/.claude/skills/`.

Run `ccmod doctor` to check all of it.
