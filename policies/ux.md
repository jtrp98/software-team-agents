# Policy — UX (§17, §18)

The accessibility and responsive baseline, and the split between shared design principles and
project-derived visual style. No prompt carries this content: `uxui-designer`, `frontend-engineer`
and `qa-engineer` retrieve it when the work renders UI. Nothing here weakens the human sign-off on
a UX artifact (`ADR-005`, `roleExecutionGate.ts`) — a policy section is not a signature.

---

## 17. Accessibility and responsive baseline

Retrieve when a change renders UI. Ownership is three-way, stated per item below, and lives here
rather than in a separate matrix: `uxui-designer` drafts, `frontend-engineer` implements,
`qa-engineer` verifies independently.

**Conformance target: WCAG 2.2 Level AA (assumption — unconfirmed).** That 2.2 is the current
stable W3C recommendation is an external fact this repository has not sourced; it stands on
recorded human agreement until a person sources the W3C recommendation, then the marker comes off.
AA, not AAA, is the blanket default: a target most content cannot meet is quietly ignored rather
than met — meet AA everywhere; adopt an AAA criterion only where a screen warrants one. The "AA"
ratios and sizes below are the standard's own numbers, not restated here.

- **Keyboard and focus** — every interactive element works by keyboard alone, in a visible and
  logical focus order, with no trap. Design: the tab path. Implement: markup and focus management.
  Verify: the primary flows, pointer-free.
- **Screen readers and semantics** — native elements before ARIA; where ARIA is used its roles,
  states and names are correct and kept true by behaviour; icon-only controls carry an accessible
  name. Design: name the semantics. Implement: markup. Verify: a screen-reader walk of the flow.
- **Contrast** — text and meaningful non-text indicators meet the AA ratios against the background
  actually rendered. Design: at draft time. Implement: in the stylesheet. Verify: computed values
  on the delivered page.
- **Reduced motion** — automatic motion honours the reduced-motion preference, and nothing
  essential is carried by animation alone. Design: decide what moves. Implement: wire the
  preference. Verify: toggle the setting.
- **Touch targets** — pointer targets meet the AA minimum size and spacing on coarse pointers, or
  an equivalent path exists without them. Design: on the wireframe. Implement: spacing and hit
  areas. Verify: at the smallest supported viewport.
- **Responsive behaviour** — content and function survive mobile, tablet and desktop widths: no
  horizontal scrolling of reading content, nothing lost at any supported width, an order that
  stays meaningful when the layout reflows. Design: what each device class gets. Implement: it.
  Verify: real widths, not one viewport.
- **Design system, tokens, component reuse** — build from the project's existing components and
  design tokens; a new one is a design decision recorded in the draft, not a local choice — no
  particular system, library or naming scheme is prescribed; the project's own applies. Design:
  decide. Implement: reuse. Verify: built from the declared set.
- **Information architecture and cognitive load** — a screen carries the decisions its step needs,
  grouped and ordered by the user's task, not the data model. Design: own this. Verify: walk the
  flow against the requirement.
- **Enumerated states** — a spec names its error, loading and empty states explicitly; "states",
  unenumerated, is not a spec. Design: enumerate. Implement: build each one. Verify: render each
  one.
- **Localization and long text** — layout survives strings longer or shorter than the source, and
  text stays readable when its size increases. Design: allow for it. Implement: no fixed-size text
  containers. Verify: a long-string pass.

## 18. Design principles vs visual style

Design principles are stable and shared across projects: the §17 baseline, like
reuse-before-create and the smallest typed change, does not vary per project. Visual style —
palette, typography, spacing, imagery, tone — is derived from the project itself: its existing UI,
brand material, and the design sources handed to the run. Never a house aesthetic:
`uxui-designer` derives it from what the project supplies; where that material is silent, style is
a question for the person — not a default taste.
