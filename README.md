# context-hud

A small bar above the prompt in Claude Code. It shows:

- How full the context is
- Time left before the prompt cache expires
- Your 5-hour and 7-day usage, and how much this session added
- Cost of this session
- How many output tokens went to reasoning
- How much your agents used

All numbers come from Claude Code or from the session's own log file. Nothing is guessed.

## What you need

- Claude Code with mods (hooks modules) turned on
- `find` and `tail` on the machine (macOS and Linux have them)

## Install

1. Open Claude Code in a terminal. (The desktop app can not run `/plugin install`.)
2. Type:

   ```
   /plugin install context-hud --marketplace zhaomh1998/claude-desktop-hud
   ```

3. Press `y` to add the marketplace.
4. Pick the `user` scope.

New sessions load it, also in the desktop app. In a session that is already open, type `/reload-plugins`.

## Install on an SSH machine

The plugin runs on the machine where Claude Code runs. For an SSH session, that is the remote machine. So install it there: log in with SSH, start `claude`, and do the same steps as above.

## Update

1. In a shell, run `claude plugin update context-hud` (on each machine).
2. In each open session, type `/reload-plugins`.

## Notes

- The plugin reads the session log in `~/.claude/projects` (or in `$CLAUDE_CONFIG_DIR/projects` if you set it).
- Agents started in the background are not counted.
- If something breaks, a gray line starting with `context-hud:` shows the error.
