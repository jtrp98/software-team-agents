# ExecutionPacket v2

The compiler derives a versioned RuntimeTask from a canonical plan task and
explicit reference declarations in requirement.md and design.md. It refuses
missing, duplicate, empty or ambiguous selected references. Heading sections,
list items and table rows are addressable; fuzzy mentions are not definitions.
Nested content stays with its selected definition, while other IDs are excluded.

The packet stores the canonical task once, without Status, plus resolved DAG
dependencies and completion/output references, selected REQ/AC/DES/contracts,
the current stage's effective roots/allow/deny rules, verified retrieval candidates,
verification levels, stops and expansion pointers. `renderPacketText` renders
these stored fields. Schema validation recomputes the text and packet hash.
Task Tier and verification-selection rationale are audit data rather than model
routing prose. An empty candidate list explicitly means no verified retrieval
candidate; authored retrieval hints never become verified paths by implication.

Role permissions and Target stack permissions use the same resolver as the live
guard. The executor refuses scope/root drift and passes the packet's exact allow
and deny lists to the adapter. Natural-language do-not-modify constraints remain
visible task requirements; the compiler does not invent permission globs from
prose. Other pipeline stages' roots and deny lists are not unioned into this stage.
No role-contract or Tier-policy values are changed by packet compilation.

Identity includes the Status-independent task and full-plan hashes, source
artifact hashes, configuration/guard hash, compiler version/source hash and
Target base revision. Recompilation checks authored source and selected fragment
freshness. Retrieval candidates require provenance, revision and a matching file
hash. Completion/output references come only from the selected dependencies.
Whole document and routing supplements do not enter a v2 prompt; bounded
`qa-evidence` and explicit stage instructions are stored and rendered together.

Packet files under `.workflow/packets` use exclusive creation for an explicit
attempt. An identical repeat is idempotent; different content at the same attempt
is refused. The reader validates the content hash and can compare expected
revision, plan, config and compiler identity. Retention is unchanged. Legacy
packets and RuntimeTasks remain readable for audit, but legacy packet execution
is refused. Author missing canonical fields (or explicitly migrate a complete
expanded table), then recompile in a new attempt. There is no in-place packet
upgrade or real-data migration.

The ordinary two-repair stop appears in the packet; the existing global retry
ceiling is labeled defense in depth. Controller/repair lifecycle enforcement,
route-policy changes, retrieval-provider selection and wave retirement remain
with their later V8 tasks. A packet is neither a QA verdict nor human approval.
