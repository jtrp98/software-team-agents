/**
 * The controlled vocabulary of things an agent can do.
 *
 * Deliberately a closed enum rather than free text. A capability's only purpose
 * is to be matched — "does anything on this team know how to build a gRPC
 * service?" — and free text cannot be matched reliably: `rest-api`, `REST API`
 * and `restful` would be three capabilities that mean one thing, and a typo
 * would silently read as "nobody can do this".
 *
 * Add a member when a genuinely new kind of work appears, not to describe the
 * same work more precisely.
 */
export enum Capability {
  REQUIREMENTS_INTERVIEW = "requirements-interview",
  FEASIBILITY_ANALYSIS = "feasibility-analysis",
  SCHEMA_DESIGN = "schema-design",
  TASK_PHASING = "task-phasing",
  SCAFFOLDING = "scaffolding",
  REST_API = "rest-api",
  /** Nothing on this roster has it yet — that absence is the point of tracking it. */
  GRPC = "grpc",
  /** Application-code data access, distinct from MIGRATION (real database schema changes). */
  DATABASE_ACCESS = "database-access",
  AUTH = "auth",
  UI = "ui",
  /** Writing/running tests, distinct from TEST_STRATEGY (deciding what to test). */
  TESTING = "testing",
  /** Deciding what needs testing and how, before implementation starts — distinct from TESTING. */
  TEST_STRATEGY = "test-strategy",
  UX_ANALYSIS = "ux-analysis",
  VERIFICATION = "verification",
  SECURITY_AUDIT = "security-audit",
  DEPLOYMENT = "deployment",
  /** Real database migrations, distinct from DATABASE_ACCESS (application-code queries). */
  MIGRATION = "migration",
  CI = "ci",
  TRIAGE = "triage",
  /** Only a person can give this — never an agent. */
  APPROVAL = "approval",
}

export const ALL_CAPABILITIES: Capability[] = Object.values(Capability);
