# Policy — Version control (§5, §22)

Two rules, kept in their own file because they are
enforced structurally, not just written down.

---

## 5. Version control

**No agent runs git** — no `init`/`add`/`commit`/`push`/`checkout`/branch/tag, nothing touching `.git/`. Version control is entirely the user's. Writing a git-*related file* (`.gitignore`, a CI workflow) is fine for the agents whose job that is (`setup`, `devops`) — writing a config file isn't running git.

**Enforced, not just requested**: `.claude/hooks/block-git.js` blocks state-changing git commands and any `.git/` access before the call runs; read-only inspection (`status`/`log`/`diff`/`show`) still works. Full reasoning is in the hook's own comments — read it if you're touching the hook, not on every agent run. If you get blocked, don't look for a way around it: tell the user what you wanted to do and let them run it.

---

## 22. Orchestrator-owned checkpoint contract

`policies/git.md §5` is unchanged: no agent runs Git. Only the trusted orchestrator process, through `orchestrator/src/git/`, may run a mutating Git command.

The subsystem has a closed command and argument allow-list: `rev-parse`, `symbolic-ref`, `status --porcelain`, `ls-files`, `diff`, `log`, `cat-file`, `merge-base`, `switch -c`, `branch`, `add -- <paths>`, and `commit -m --` without `-a`. A run starts only from a clean, ordinary Target repository. Staging is an explicitly computed, contained path list; `git add -A` and `git commit -a` are never allowed.

A checkpoint is a local durability and attribution boundary, not a QA verdict. STA never pushes, merges, reverts, or resets; those operations have no orchestrator code path.
