# Policy — Data (§16)

Database concerns the schema-contract rule (`policies/architecture.md` §7) does not cover. §7 owns
what the schema *is* — models, fields, ownership, drift. This section owns what it *does* under
load, concurrency, and failure, and how recovery is proven. Changing the schema is still §7's
contract; operating it is this section's subject.

---

## 16. Database operations and restore verification

**Retrieve this section when any of these is true:** destructive migration · high-volume table ·
transaction or concurrency concern · index or query-plan issue · replication or partitioning ·
retention · capacity · provider change. Outside those triggers it stays unread — knowledge on
demand, not a standing tax on every run. A provider change re-runs the whole list: nothing about
the old database's semantics ports by assumption.

The stack is Target-resolved (`.agent-team/config.yaml` `stack:`): implement the database the
project actually resolved and answer these concerns in its terms. Nothing here is one vendor's
answer — `contracts/system-analyst.yaml` declaring `database: ["postgresql"]` is that contract's
capability, not a universal default.

**Design time — `system-analyst`:**

- **Normalization and denormalization:** the write-safety versus read-performance trade is decided
  explicitly in the Data Model, not left to whoever writes the queries later.
- **Capacity:** expected data volume and growth, stated early because they drive partitioning,
  retention and index choices downstream.
- **Partitioning:** whether and how the largest tables split when volume demands it.
- **Retention:** how long data lives and how it leaves (prune, archive) — decided at design time,
  not after the first full disk.
- **Isolation level:** chosen deliberately for the concurrency the feature actually has, with the
  anomalies that level permits known by name in the vendor's own terms.

**Implementation time — `backend-engineer`:**

- **Indexes and query plans:** a query that touches real volume is checked against the plan the
  database actually chooses; N+1 access and unindexed scans are read off that plan, not guessed at.
- **Connection pooling:** connections are pooled and bounded — an unbounded connection path is a
  defect even while the tests pass.
- **Deadlock avoidance:** locks are acquired in a consistent order and held briefly; concurrent
  paths are reasoned about together, because tests rarely interleave the way production does.
- **Transaction boundaries:** short, and wrapping exactly the operations that must succeed or fail
  together — never a whole request, loop, or network call.

**Migration and recovery — `devops` with `backend-engineer`:**

The destructive-migration rule already says: *"take and record a restorable backup; without a
backup, do not migrate."* This strengthens it, because a recorded backup is not yet evidence:

**Restore verification — the backup counts only after a restore has been performed and its result
recorded.** *Recorded* means an artifact exists that someone else can check: the restore was run
against a disposable target, and its outcome — the restore command's output plus a check that the
restored data is intact — is written into that migration's `deploy.md` Deploy History entry. That
recorded restore result is the checkable thing; confidence in a backup is not.
