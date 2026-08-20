# Policy — Version control (§5)

Split from `.claude/shared/conventions.md` by T49. One rule, kept in its own file because it is
enforced structurally, not just written down.

---

## 5. Version control

**No agent runs git** — no `init`/`add`/`commit`/`push`/`checkout`/branch/tag, nothing touching `.git/`. Version control is entirely the user's. Writing a git-*related file* (`.gitignore`, a CI workflow) is fine for the agents whose job that is (`setup`, `devops`) — writing a config file isn't running git.

**Enforced, not just requested**: `.claude/hooks/block-git.js` blocks state-changing git commands and any `.git/` access before the call runs; read-only inspection (`status`/`log`/`diff`/`show`) still works. Full reasoning is in the hook's own comments — read it if you're touching the hook, not on every agent run. If you get blocked, don't look for a way around it: tell the user what you wanted to do and let them run it.
