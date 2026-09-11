/**
 * The legacy-project importer is gone with `orchestrator/src/adoption/`.
 *
 * `ADR-024-docs-vs-knowledge.md` chose (a) and accepts explicitly that this
 * import becomes unrepeatable: the one run it had is committed in
 * `knowledge-schoolbright` (`e6f502f`). The verb errors for one release instead
 * of vanishing, so a script still calling it says why rather than "unknown verb".
 */
export function runRetiredAdoptVerb(): number {
  console.error(
    "[orchestrator] adopt is retired — the one-time legacy import has already run and its result is committed under knowledge/. " +
      "See decisions/ADR-024-docs-vs-knowledge.md, which accepts that this import is not repeatable. " +
      "There is no replacement command; `sta --check-knowledge` still validates the store.",
  );
  return 1;
}
