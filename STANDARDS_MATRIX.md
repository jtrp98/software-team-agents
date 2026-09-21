# Software Development Standards Matrix

> Status: Framework baseline  
> Scope: `software-team-agents` Framework  
> Owner: Framework maintainers  
> Review cadence: Review when standards, policies, workflows, or role contracts materially change

## 1. Purpose

This document is the **standards registry and compliance map** for the `software-team-agents` Framework.

It answers four questions:

1. Which external standard, specification, guideline, or body of knowledge is relevant?
2. Which role or engineering area owns the concern?
3. How strongly does the Framework require it?
4. Where should the requirement be implemented, reviewed, or enforced?

This file is intentionally **not** a copy of external standards and **not** a second policy system.

Detailed rules belong in:

- `policies/` — shared Framework rules
- `contracts/` — machine-readable role permissions
- `workflows/` — lifecycle and stage sequencing
- `.claude/hooks/` and equivalent runtime guards — deterministic enforcement
- `test-pyramid.yaml` — test-level policy
- `knowledge/` / company Knowledge repository — organization-, product-, domain-, or regulation-specific requirements
- Target repository — product implementation and evidence

The Framework repository is the process/workflow layer. Company- and product-specific compliance requirements should normally live in the Knowledge repository rather than being hard-coded here.

---

## 2. Requirement Levels

The following keywords define how this document should be interpreted.

| Level | Meaning | Expected behavior |
|---|---|---|
| **MUST** | Mandatory Framework baseline when applicable | A policy, gate, review, automated check, or explicit evidence should exist |
| **SHOULD** | Recommended default | Follow unless there is a documented reason not to |
| **MAY** | Optional practice | Apply when useful for the project, stack, or risk profile |
| **REFERENCE** | Guidance / body of knowledge | Use as a source of practices; no compliance claim is implied |

`MUST` does **not** mean the Framework is automatically certified against the named external standard. Certification or formal compliance requires its own scoped assessment and evidence.

---

## 3. Core Principles

### 3.1 Single Source of Truth

`STANDARDS_MATRIX.md` declares **what the Framework references**.

It must not duplicate detailed rules that already belong in `policies/`, `contracts/`, `workflows/`, schemas, hooks, or Knowledge artifacts.

### 3.2 Enforce Behavior, Not Prompt Text

A statement in an agent prompt alone is not considered strong enforcement.

Where practical, mandatory requirements should be backed by one or more of:

- deterministic validation
- schema validation
- role contract
- workflow gate
- automated test
- static analysis
- security scan
- human approval/sign-off
- retained evidence

### 3.3 Applicability Matters

A standard may be mandatory only when its concern exists.

Examples:

- WCAG applies to user-facing interfaces.
- OpenAPI applies when a REST/HTTP API contract exists.
- AsyncAPI applies when event/message interfaces are formally specified.
- OWASP API Security applies when an API is exposed.
- platform HIG guidance applies when targeting that platform.

### 3.4 Project-Specific Compliance Is an Overlay

Regulatory and company-specific requirements such as PDPA, GDPR, PCI DSS, HIPAA, internal security standards, contractual SLAs, or sector-specific controls should be modeled as Knowledge items and linked to the affected requirements/design/test evidence.

They should not be added to the global Framework baseline unless they are intentionally required for every project using the Framework.

---

# 4. Standards Matrix

## 4.1 Business Analysis

| Role / Area | Reference | Level | Applies to | Framework implementation | Evidence / Review |
|---|---|---:|---|---|---|
| `business-analyst` | BABOK Guide | REFERENCE | Business analysis practices | BA agent guidance, requirement workflow | Human review / approval |
| `business-analyst` | ISO/IEC/IEEE 29148 — Requirements Engineering | SHOULD | Structured requirements | Requirement artifacts and traceability | Requirement review |
| `business-analyst` | BPMN 2.x | SHOULD | Business/process modeling | Knowledge design/process artifacts | BA/SA review |
| `business-analyst` | DMN | MAY | Complex decision rules | Business-rule / decision artifacts | BA/SA review |
| `business-analyst` | Agile / Scrum practices | REFERENCE | Iterative product delivery | Stories, acceptance criteria, workflow planning | Team review |

### Expected BA outcomes

The Framework should encourage requirements that are:

- clear
- testable
- traceable
- feasible
- unambiguous
- consistent
- appropriately scoped
- connected to acceptance criteria
- versioned through Knowledge history

---

## 4.2 System Analysis and Architecture

| Role / Area | Reference | Level | Applies to | Framework implementation | Evidence / Review |
|---|---|---:|---|---|---|
| `system-analyst` | ISO/IEC/IEEE 29148 | SHOULD | System/software requirements | `_docs/module/*/design.md`, requirement/design relations | SA review + human approval |
| `system-analyst` | ISO/IEC 25010 | SHOULD | Quality requirements / NFR | NFR sections in design/requirements | SA + QA review |
| `system-analyst` | UML 2.x | SHOULD | Behavioral/structural modeling | Sequence, activity, state, component diagrams where useful | Design review |
| `system-analyst` | C4 Model | SHOULD | Software architecture communication | Context/container/component views | Architecture review |
| `system-analyst` | ISO/IEC/IEEE 42010 | REFERENCE | Architecture descriptions | `policies/architecture.md`, design artifacts, ADRs | Architecture review |
| `system-analyst` | OpenAPI Specification | MUST when applicable | REST/HTTP API contracts | API contract in Knowledge/Target | Schema/contract validation |
| `system-analyst` | JSON Schema | SHOULD when applicable | JSON data contracts | Request/response/event schemas | Schema validation |
| `system-analyst` | AsyncAPI Specification | SHOULD when applicable | Event/message contracts | Event integration specification | Contract review |
| `system-analyst` | HTTP Semantics (IETF RFCs) | MUST when applicable | HTTP services/APIs | API conventions and implementation | API tests / review |

### System design should explicitly consider

- happy path
- alternative flow
- error / exception flow
- data ownership
- integration boundaries
- authentication / authorization
- timeout
- retry
- idempotency
- concurrency
- consistency
- observability
- migration / rollback
- measurable NFRs

---

## 4.3 UX/UI and Accessibility

| Role / Area | Reference | Level | Applies to | Framework implementation | Evidence / Review |
|---|---|---:|---|---|---|
| `uxui-designer` / `frontend-engineer` / `qa-engineer` | WCAG 2.2 Level AA | MUST | User-facing web UI unless explicitly exempted | `policies/ux.md`, UX artifact, frontend implementation | UX sign-off + accessibility verification |
| `uxui-designer` / `frontend-engineer` | WAI-ARIA Authoring Practices | MUST when applicable | Custom interactive web components | `policies/ux.md`, component implementation | Keyboard / screen-reader checks |
| `uxui-designer` | ISO 9241-210 | REFERENCE | Human-centred design process | UX discovery/design workflow | UX review |
| `uxui-designer` | ISO 9241-110 | REFERENCE | Interaction principles | UX design review | UX review |
| `uxui-designer` | Nielsen Usability Heuristics | REFERENCE | Usability evaluation | UX review checklist | Heuristic review |
| `uxui-designer` / `frontend-engineer` | Material Design | MAY | Material-based products | Project Design System / Knowledge | Design review |
| `uxui-designer` / `frontend-engineer` | Apple Human Interface Guidelines | SHOULD when applicable | Apple-platform products | Project Design System / Knowledge | Platform review |

### UX/UI baseline

User-facing features should consider:

- keyboard operation
- visible focus
- semantic structure
- accessible names and labels
- sufficient contrast
- text resizing / reflow
- validation and error identification
- loading / empty / error states
- responsive behavior
- reduced-motion preferences where relevant
- touch/pointer target usability
- consistent component states
- localization and content expansion where applicable

For MEDIUM+ frontend work, the Framework's existing UX artifact/sign-off gate remains the process authority.

---

## 4.4 Development and API Implementation

| Role / Area | Reference | Level | Applies to | Framework implementation | Evidence / Review |
|---|---|---:|---|---|---|
| `backend-engineer` / `frontend-engineer` | SOLID principles | REFERENCE | Software design | `policies/coding.md`, architecture guidance | Code review |
| `backend-engineer` / `frontend-engineer` | Secure Coding practices | MUST | Production code | `policies/security.md`, code review, scans | Security/QA evidence |
| `backend-engineer` / `frontend-engineer` | Semantic Versioning | SHOULD when applicable | Versioned packages/APIs | Release/version policy | Release review |
| `backend-engineer` / `frontend-engineer` | Conventional Commits | SHOULD | Git history when adopted by project | `policies/git.md` or project policy | Commit/CI validation — performed by humans/orchestrator/Target CI; an agent never runs state-changing git |
| `backend-engineer` | HTTP Semantics / relevant IETF RFCs | MUST when applicable | HTTP APIs | API implementation | Contract/integration tests |
| `backend-engineer` | OpenAPI contract | MUST when applicable | Contract-defined REST APIs | Implementation must conform to approved contract | Contract tests |
| `frontend-engineer` | Approved Design System | MUST when available | UI implementation | UX artifact / Knowledge design source | UX + QA review |

### Development baseline

Implementation should preserve:

- approved requirement intent
- approved system design
- approved UX behavior where applicable
- API/data contracts
- secure defaults
- error handling
- testability
- observability
- backward compatibility expectations
- migration / rollback safety

---

## 4.5 Quality Assurance and Testing

| Role / Area | Reference | Level | Applies to | Framework implementation | Evidence / Review |
|---|---|---:|---|---|---|
| `test-planner` / `qa-engineer` | ISO/IEC/IEEE 29119 series | REFERENCE | Test process and artifacts | Test-plan structure, QA workflow | Test plan / test evidence |
| `test-planner` / `qa-engineer` | ISTQB terminology/practices | REFERENCE | Testing vocabulary and techniques | QA guidance | QA review |
| `qa-engineer` | ISO/IEC 25010 | SHOULD | Quality attribute validation | NFR verification | Test evidence |
| `test-planner` / `qa-engineer` | BDD / Gherkin | MAY | Behavior-focused acceptance tests | Acceptance scenarios | Executable/manual evidence |
| `qa-engineer` | WCAG 2.2 AA | MUST when applicable | User-facing UI | Accessibility verification | Automated + manual checks |
| `qa-engineer` | OWASP testing guidance | SHOULD when applicable | Security-relevant behavior | QA/security test scope | Test evidence |

### Minimum test evidence

Depending on change risk, verification may include:

- unit tests
- integration tests
- contract tests
- system / end-to-end tests
- regression tests
- accessibility checks
- performance checks
- security checks
- migration tests
- rollback / recovery checks

`test-pyramid.yaml` remains the Framework source of truth for test-level policy.

---

## 4.6 Security

| Role / Area | Reference | Level | Applies to | Framework implementation | Evidence / Review |
|---|---|---:|---|---|---|
| `security` / engineers | OWASP ASVS | SHOULD | Web application security requirements | `policies/security.md` | Security review |
| `security` / engineers | OWASP Top 10 | REFERENCE | Common web application risks | Security guidance | Review / scan |
| `security` / `backend-engineer` / `qa-engineer` | OWASP API Security Top 10 | MUST when applicable | Exposed/internal APIs with security impact | `policies/security.md`, API review | Security tests |
| `security` | ISO/IEC 27001 | REFERENCE | Organizational ISMS | Company Knowledge, not Framework certification | Organization-level evidence |
| `security` | ISO/IEC 27002 | REFERENCE | Security controls | Company/project Knowledge | Control evidence |
| `security` / engineers | OAuth 2.0 / OpenID Connect | MUST when selected | Delegated authorization / identity | Architecture/API contract | Security review + tests |
| `security` / engineers | Principle of Least Privilege | MUST | Access control | `policies/security.md`, role/permission design | Review / tests |

### Security baseline

Security-sensitive designs should explicitly address:

- authentication
- authorization
- least privilege
- input validation
- output encoding
- secret handling
- sensitive-data handling
- encryption in transit
- encryption at rest where required
- session/token lifecycle
- audit logging
- rate limiting / abuse controls
- dependency risk
- security-relevant error handling

Critical or Important security findings remain subject to the Framework's existing security/human gate behavior.

---

## 4.7 Data

| Role / Area | Reference | Level | Applies to | Framework implementation | Evidence / Review |
|---|---|---:|---|---|---|
| `system-analyst` / `backend-engineer` | Project Data Standard | MUST | Persistent/project data | `policies/data.md`, Knowledge data model | SA/code review |
| `system-analyst` | JSON Schema | SHOULD when applicable | JSON payloads/events | Schema artifacts | Schema validation |
| `system-analyst` / `backend-engineer` | Data classification policy | MUST when defined | Sensitive or regulated data | Company Knowledge + `policies/data.md` | Security review |
| `backend-engineer` / `devops` | Retention / disposal requirements | MUST when defined | Stored data, logs, backups | Company/project Knowledge | Operational evidence |

### Data artifacts should define where relevant

- canonical field name
- meaning
- type
- format
- required / nullable
- default
- allowed values
- source of truth
- ownership
- classification
- validation
- transformation
- retention
- migration behavior

---

## 4.8 DevOps, Reliability, and Observability

| Role / Area | Reference | Level | Applies to | Framework implementation | Evidence / Review |
|---|---|---:|---|---|---|
| `devops` / engineers | Infrastructure as Code | SHOULD | Managed infrastructure | Project/stack policy | Review + plan/apply evidence |
| `devops` / engineers | CI/CD practices | MUST for automated delivery pipelines | Build/test/deploy | Workflow/Target pipeline | CI evidence |
| `devops` / engineers | OpenTelemetry | SHOULD when applicable | Distributed/service observability | Architecture/ops guidance | Logs/metrics/traces evidence |
| `devops` | SRE principles | REFERENCE | Reliability-sensitive services | SLI/SLO/runbook design | Operational review |
| `devops` / `security` | CIS Benchmarks | SHOULD when applicable | Supported infrastructure/platforms | Company/project hardening policy | Scan / audit evidence |
| `devops` | Backup / recovery requirements | MUST when defined | Stateful production systems | Knowledge NFR / runbook | Restore test evidence |

### Production-readiness concerns

Where applicable, designs and deployments should define:

- availability target
- latency target
- throughput / capacity
- SLI / SLO
- health checks
- logging
- metrics
- traces
- alerting
- backup
- restore
- failover
- incident response
- rollback
- runbook ownership

---

## 4.9 Project Management and Delivery

| Role / Area | Reference | Level | Applies to | Framework implementation | Evidence / Review |
|---|---|---:|---|---|---|
| `project-manager` | Agile / Scrum / Kanban practices | REFERENCE | Delivery planning | Workflow/status management | Team review |
| `project-manager` | Risk management practices | SHOULD | Material delivery/technical risk | Risk/dependency tracking | Human review |
| `project-manager` | Definition of Ready / Done | SHOULD | Lifecycle gates | Workflow policies | Gate evidence |

Project management references guide delivery behavior but should not override role contracts, deterministic guards, or human approval gates.

---

# 5. Role-to-Standard Summary

| Role | Primary references |
|---|---|
| `business-analyst` | BABOK, ISO/IEC/IEEE 29148, BPMN, DMN |
| `system-analyst` | ISO/IEC/IEEE 29148, ISO/IEC 25010, UML, C4, OpenAPI, AsyncAPI, JSON Schema, HTTP |
| `project-manager` | Agile/Scrum/Kanban, delivery risk practices |
| `test-planner` | ISO/IEC/IEEE 29119, ISTQB, acceptance-test practices |
| `uxui-designer` | WCAG 2.2 AA, WAI-ARIA/APG, ISO 9241, Nielsen heuristics, platform HIGs |
| `backend-engineer` | Approved contracts, HTTP, secure coding, OWASP guidance |
| `frontend-engineer` | Approved UX/design system, WCAG 2.2 AA, WAI-ARIA/APG, secure coding |
| `qa-engineer` | Test plan, ISO/IEC 25010, WCAG, contract/security verification |
| `security` | OWASP ASVS, OWASP Top 10, OWASP API Security, organization security requirements |
| `devops` | CI/CD, IaC, OpenTelemetry, SRE practices, hardening baselines |

---

# 6. Enforcement Mapping

External references become useful only when translated into Framework controls.

| Enforcement type | Framework location | Example |
|---|---|---|
| Shared rule | `policies/*.md` | UX, security, architecture, data, coding rules |
| Role permission | `contracts/*.yaml` | Which role can write which paths |
| Workflow ordering | `workflows/*.yml` | UX before frontend for applicable design work |
| Human approval | Knowledge role/gate records | Requirement approval, UX sign-off |
| Deterministic guard | `.claude/hooks/*` or runtime equivalent | path permission, secrets, green-before-stop |
| Schema/contract check | scripts / CI / Target tests | OpenAPI/JSON Schema contract validation |
| Test policy | `test-pyramid.yaml` | Required verification level |
| Project-specific requirement | Knowledge repository | SLA, privacy, regulatory rule |
| Product evidence | Target repository / runtime evidence | tests, scan output, deployment evidence |

A `MUST` item should ideally map to at least one enforceable or auditable mechanism.

---

# 7. Framework Baseline

The recommended default baseline for a typical web/software product is:

```text
Business Analysis
├── ISO/IEC/IEEE 29148          SHOULD
├── BPMN                        SHOULD when process modeling is needed
└── BABOK                       REFERENCE

UX/UI
├── WCAG 2.2 Level AA           MUST for applicable user-facing web UI
├── WAI-ARIA/APG                MUST when custom interactive components require it
└── ISO 9241                    REFERENCE

System Analysis
├── ISO/IEC/IEEE 29148          SHOULD
├── ISO/IEC 25010               SHOULD
├── UML / C4                    SHOULD where they improve clarity
├── OpenAPI                     MUST for contract-defined REST APIs
└── AsyncAPI                    SHOULD for formal event/message contracts

Development
├── Approved contracts          MUST
├── Secure coding               MUST
├── HTTP semantics              MUST when applicable
└── Engineering principles      REFERENCE / project policy

Quality
├── Risk-appropriate tests      MUST
├── Accessibility verification MUST when applicable
├── ISO/IEC/IEEE 29119          REFERENCE
└── ISO/IEC 25010               SHOULD for quality-attribute verification

Security
├── OWASP API Security          MUST when applicable
├── Least privilege             MUST
├── OWASP ASVS                  SHOULD
└── ISO/IEC 27001/27002         REFERENCE / organization overlay

Operations
├── CI/CD verification          MUST when automated delivery is used
├── IaC                         SHOULD
├── OpenTelemetry               SHOULD when applicable
└── SRE practices               REFERENCE
```

---

# 8. Project / Organization Overlay

Each Knowledge repository may strengthen, weaken where legitimately inapplicable, or extend this baseline.

Example:

```yaml
standards:
  - id: WCAG-2.2-AA
    level: MUST
    applies_to:
      - web
    owner: uxui
    evidence:
      - accessibility-test
      - human-ux-signoff

  - id: COMPANY-SEC-001
    level: MUST
    source: internal-security-policy
    owner: security

  - id: PDPA
    level: MUST
    applies_to:
      - personal-data
    owner: ba
    reviewers:
      - sa
      - security
```

The exact project schema may differ; this example describes intent only.

Project-specific overlays should record:

- source
- owner
- applicability
- requirement level
- affected modules/targets
- approval status
- evidence expectation
- exception/waiver if any

---

# 9. Exceptions and Waivers

A mandatory applicable requirement should not be silently ignored.

A waiver should record at least:

```text
Requirement / Standard:
Scope:
Reason:
Risk:
Compensating control:
Owner:
Approver:
Expiry / review date:
Evidence:
```

Where practical, record architectural exceptions as an ADR/decision and link them to the affected Knowledge items.

---

# 10. Traceability Model

The preferred traceability chain is:

```text
Business Objective
    ↓
Business / Stakeholder Requirement
    ↓
System Requirement / NFR
    ↓
UX / Architecture / API / Data Design
    ↓
Implementation
    ↓
Test / Security / Accessibility Evidence
    ↓
Human Acceptance / Sign-off
    ↓
Production / Operational Evidence
```

Standards should attach to the relevant node rather than existing as disconnected documentation.

Example:

```text
WCAG 2.2 AA
    ↓ constrains
UX-142
    ↓ implemented-by
Frontend change
    ↓ verified-by
Accessibility test evidence
    ↓ approved-by
UX sign-off
```

---

# 11. Maintenance Rules

When editing this file:

1. Do not copy large sections of copyrighted or normative standards.
2. Prefer the official source or specification name.
3. Avoid pinning versions unless the Framework intentionally requires that exact version.
4. When a version is pinned, update the relevant policy/gate and this matrix together.
5. Do not claim certification unless a formal assessment has established it.
6. Do not add project-only regulations to the Framework baseline.
7. A new `MUST` should identify where enforcement or evidence will live.
8. Keep role names aligned with the actual Framework roster.
9. Keep this document smaller than the policies it indexes.
10. Treat `policies/`, `contracts/`, `workflows/`, guards, and Knowledge artifacts as implementation authorities for their respective concerns.

---

# 12. Primary Reference Links

These links are pointers to the authoritative organizations/projects. Project owners remain responsible for selecting the edition/version applicable to their context.

- WCAG / WAI: https://www.w3.org/WAI/standards-guidelines/wcag/
- WAI-ARIA APG: https://www.w3.org/WAI/ARIA/apg/
- ISO standards catalogue: https://www.iso.org/standards.html
- IEEE standards: https://standards.ieee.org/
- OMG BPMN: https://www.omg.org/bpmn/
- OMG UML: https://www.omg.org/spec/UML/
- OMG DMN: https://www.omg.org/dmn/
- OpenAPI Initiative: https://www.openapis.org/
- AsyncAPI Initiative: https://www.asyncapi.com/
- JSON Schema: https://json-schema.org/
- IETF RFCs: https://www.rfc-editor.org/
- OWASP ASVS: https://owasp.org/www-project-application-security-verification-standard/
- OWASP Top 10: https://owasp.org/www-project-top-ten/
- OWASP API Security: https://owasp.org/www-project-api-security/
- OpenTelemetry: https://opentelemetry.io/
- CIS Benchmarks: https://www.cisecurity.org/cis-benchmarks
- Apple Human Interface Guidelines: https://developer.apple.com/design/human-interface-guidelines/
- Material Design: https://m3.material.io/
- IIBA / BABOK: https://www.iiba.org/standards-and-resources/babok/

---

## Final Rule

> **The matrix declares the baseline. Policies define the rule. Contracts and workflows define ownership and sequence. Guards/tests provide enforcement. Knowledge supplies project-specific truth. Humans approve the decisions that require human authority.**
