# Standards baseline per role

The framework's external-standards baseline, indexed per role. The mapping itself — which standard,
which level, which role — is declared and reviewed in framework-root `STANDARDS_MATRIX.md` (the maintainer-facing
registry, not part of a synced workspace's payload). This file is the
read side agents consume with `sta policy standards <section>`. It carries no normative text from
any external standard, no version pins beyond what the matrix states, and no compliance or
certification claim.

## 0. How to read

Levels follow framework-root `STANDARDS_MATRIX.md` §2 requirement levels:

- **MUST** — mandatory framework baseline when the concern exists. Every MUST row here names the
  mechanism or evidence that backs it; a MUST with no mechanism is a known gap, reported at release,
  not a new rule. "when applicable / available / defined / selected" decides whether the row applies
  at all, and applicability is declared where the concern is established — normally the module's
  `design.md`.
- **SHOULD** — recommended default; follow unless the project documents a reason not to.
- **MAY** — optional; apply when useful for the project, stack, or risk profile.
- **REFERENCE** — body of knowledge to draw practice from; no compliance claim is implied.

A MUST is never a certification claim against the named standard.

## 1. business-analyst

| Standard | Level | Applies when | Evidence expected |
|---|---|---|---|
| ISO/IEC/IEEE 29148 | SHOULD | structured requirements | requirement artifacts and traceability; requirement review |
| BPMN 2.x | SHOULD | business/process modeling | process artifacts; BA/SA review |
| DMN | MAY | complex decision rules | decision artifacts; BA/SA review |
| BABOK Guide | REFERENCE | business analysis practice | human review |
| Agile / Scrum practices | REFERENCE | iterative delivery | team review |

No MUST row — requirement quality is carried by requirement review.

## 2. system-analyst

| Standard | Level | Applies when | Evidence expected |
|---|---|---|---|
| OpenAPI Specification | MUST when applicable | a REST/HTTP API contract exists | approved contract; schema/contract validation |
| HTTP Semantics (IETF) | MUST when applicable | HTTP services/APIs | API tests / review |
| Project Data Standard | MUST | persistent/project data | `policies/data.md`; SA/code review |
| Data classification policy | MUST when defined | sensitive or regulated data | security review; policy supplied by the knowledge repo |
| ISO/IEC/IEEE 29148 | SHOULD | system/software requirements | design and requirement relations; SA review + human approval |
| ISO/IEC 25010 | SHOULD | quality requirements / NFR | measurable NFR sections; SA + QA review |
| UML 2.x | SHOULD | behavioral/structural modeling where useful | design review |
| C4 Model | SHOULD | architecture communication | context/container/component views |
| JSON Schema | SHOULD when applicable | JSON data contracts, payloads, events | schema validation |
| AsyncAPI Specification | SHOULD when applicable | formal event/message contracts | contract review |
| ISO/IEC/IEEE 42010 | REFERENCE | architecture descriptions | `policies/architecture.md`; ADRs |

MUST rows rest in existing mechanisms: the schema/contract confirmation gate plus contract tests in
the Target — the framework does not run those tests itself.

## 3. project-manager

| Standard | Level | Applies when | Evidence expected |
|---|---|---|---|
| Risk management practices | SHOULD | material delivery/technical risk | risk/dependency tracking; human review |
| Definition of Ready / Done | SHOULD | lifecycle gates | workflow policies; gate evidence |
| Agile / Scrum / Kanban practices | REFERENCE | delivery planning | team review |

These references never override role contracts, deterministic guards, or human approval gates.

## 4. test-planner

| Standard | Level | Applies when | Evidence expected |
|---|---|---|---|
| ISO/IEC/IEEE 29119 | REFERENCE | test process and artifacts | test-plan structure |
| ISTQB terminology/practices | REFERENCE | testing vocabulary and techniques | QA guidance |
| BDD / Gherkin | MAY | behavior-focused acceptance tests | acceptance scenarios |

Test-level policy stays owned by `test-pyramid.yaml`, not this file.

## 5. uxui-designer

| Standard | Level | Applies when | Evidence expected |
|---|---|---|---|
| WCAG 2.2 Level AA | MUST | user-facing web UI unless explicitly exempted | UX sign-off + accessibility verification |
| WAI-ARIA Authoring Practices | MUST when applicable | custom interactive web components | keyboard / screen-reader checks |
| Apple Human Interface Guidelines | SHOULD when applicable | Apple-platform products | platform review |
| ISO 9241-210 | REFERENCE | human-centred design process | UX review |
| ISO 9241-110 | REFERENCE | interaction principles | UX review |
| Nielsen Usability Heuristics | REFERENCE | usability evaluation | heuristic review |
| Material Design | MAY | Material-based products | project design system / knowledge |

MUST rows rest in the existing UX gate: for MEDIUM+ frontend work, frontend cannot start without an
approved, current UX artifact carrying human uxui-signoff; `policies/ux.md` remains the working rule
set and QA rounds carry the verification.

## 6. backend-engineer

| Standard | Level | Applies when | Evidence expected |
|---|---|---|---|
| Secure Coding practices | MUST | production code | security/QA evidence; security review and scans |
| OpenAPI contract | MUST when applicable | contract-defined REST APIs | implementation conforms to the approved contract; contract tests |
| HTTP Semantics (IETF) | MUST when applicable | HTTP APIs | contract/integration tests |
| OWASP API Security Top 10 | MUST when applicable | exposed/internal APIs with security impact | security tests |
| Project Data Standard | MUST | persistent/project data | `policies/data.md`; SA/code review |
| Data classification policy | MUST when defined | sensitive or regulated data | security review; policy supplied by the knowledge repo |
| Retention / disposal requirements | MUST when defined | stored data, logs, backups | operational evidence; requirement supplied by the knowledge repo |
| Semantic Versioning | SHOULD when applicable | versioned packages/APIs | release review |
| Conventional Commits | SHOULD | git history when the project adopts it | commit/CI validation — performed by humans/orchestrator/Target CI; an agent never runs state-changing git |
| SOLID principles | REFERENCE | software design | code review; `policies/coding.md` |

MUST rows rest in existing mechanisms: the security gate (Critical/Important findings stay behind a
human gate — `policies/security.md §21`), QA's `cannot_close_security_finding`
(`contracts/qa-engineer.yaml`), and contract tests in the Target.

## 7. frontend-engineer

| Standard | Level | Applies when | Evidence expected |
|---|---|---|---|
| Approved Design System | MUST when available | UI implementation | the signed UX artifact / knowledge design source; UX + QA review |
| WCAG 2.2 Level AA | MUST | user-facing web UI unless explicitly exempted | UX sign-off + accessibility verification |
| WAI-ARIA Authoring Practices | MUST when applicable | custom interactive web components | keyboard / screen-reader checks |
| Secure Coding practices | MUST | production code | security/QA evidence |
| Apple Human Interface Guidelines | SHOULD when applicable | Apple-platform products | platform review |
| Semantic Versioning | SHOULD when applicable | versioned packages/APIs | release review |
| Conventional Commits | SHOULD | git history when the project adopts it | commit/CI validation — performed by humans/orchestrator/Target CI; an agent never runs state-changing git |
| Material Design | MAY | Material-based products | project design system / knowledge |
| SOLID principles | REFERENCE | software design | code review; `policies/coding.md` |

MUST rows rest in the UX sign-off gate (approved current UX artifact + human uxui-signoff before
frontend starts — see §5) and the security gate as in §6.

## 8. qa-engineer

| Standard | Level | Applies when | Evidence expected |
|---|---|---|---|
| WCAG 2.2 AA | MUST when applicable | user-facing UI | accessibility verification; automated + manual checks |
| ISO/IEC 25010 | SHOULD | quality attribute validation | test evidence for NFRs |
| OWASP testing guidance | SHOULD when applicable | security-relevant behavior | test evidence |
| ISO/IEC/IEEE 29119 | REFERENCE | test process and artifacts | test plan / test evidence |
| ISTQB terminology/practices | REFERENCE | testing vocabulary and techniques | QA review |
| BDD / Gherkin | MAY | behavior-focused acceptance tests | executable/manual evidence |

Accessibility verification rides the existing QA rounds, and QA never closes a security finding
(`cannot_close_security_finding`, `contracts/qa-engineer.yaml`).

## 9. security

| Standard | Level | Applies when | Evidence expected |
|---|---|---|---|
| OWASP API Security Top 10 | MUST when applicable | exposed/internal APIs with security impact | security tests; `policies/security.md` |
| OAuth 2.0 / OpenID Connect | MUST when selected | delegated authorization / identity | architecture/API contract; security review + tests |
| Principle of Least Privilege | MUST | access control | role/permission design; review / tests |
| OWASP ASVS | SHOULD | web application security requirements | security review; `policies/security.md` |
| OWASP Top 10 | REFERENCE | common web application risks | review / scan |
| ISO/IEC 27001 | REFERENCE | organizational ISMS | organization-level evidence, not a framework claim |
| ISO/IEC 27002 | REFERENCE | security controls | control evidence in company/project knowledge |

MUST rows rest in existing mechanisms: Critical/Important findings stay behind the human security
gate and only `security` closes a finding (`cannot_close_security_finding`,
`contracts/qa-engineer.yaml`); least privilege is enforced mechanically by `contracts/*.yaml`
write/read paths and the path-permission guards.

## 10. devops

| Standard | Level | Applies when | Evidence expected |
|---|---|---|---|
| CI/CD practices | MUST for automated delivery pipelines | build/test/deploy | CI evidence from the Target pipeline |
| Backup / recovery requirements | MUST when defined | stateful production systems | restore test evidence; requirement supplied by the knowledge repo |
| Retention / disposal requirements | MUST when defined | stored data, logs, backups | operational evidence; requirement supplied by the knowledge repo |
| Infrastructure as Code | SHOULD | managed infrastructure | review + plan/apply evidence |
| OpenTelemetry | SHOULD when applicable | distributed/service observability | logs/metrics/traces evidence |
| CIS Benchmarks | SHOULD when applicable | supported infrastructure/platforms | scan / audit evidence; hardening policy supplied by the knowledge repo |
| SRE principles | REFERENCE | reliability-sensitive services | SLI/SLO/runbook design |

Known gaps, stated plainly: IaC, OpenTelemetry, retention/backup, and CIS hardening have no
framework-side mechanism — their rows are enforced through evidence recorded in the Target, not by a
guard, and CI/CD verification likewise lives in the Target pipeline. This is the accepted
prompt-layer limit and is reported as such at release.

---

Maintenance: rows and levels here mirror framework-root `STANDARDS_MATRIX.md` — change the matrix first, then this
index, in the same edit. Keep this file smaller than the matrix: no normative standard text, no new
rules. Role prompts point here as `policies/standards.md §<n>`.
