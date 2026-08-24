/**
 * The controlled vocabulary of things an agent can do (T12).
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
  /** Interview a person and turn the answers into requirements. */
  REQUIREMENTS_INTERVIEW = "requirements-interview",
  /** Judge whether a requirement can be built at all, and at what cost. */
  FEASIBILITY_ANALYSIS = "feasibility-analysis",
  /** Design tables, fields and relations. */
  SCHEMA_DESIGN = "schema-design",
  /** Break confirmed work into ordered, phased tasks. */
  TASK_PHASING = "task-phasing",
  /** Stand up a project skeleton from nothing. */
  SCAFFOLDING = "scaffolding",
  /** Build HTTP/REST endpoints. */
  REST_API = "rest-api",
  /** Build gRPC services. Nothing on this roster has it yet — that absence is the point of tracking it. */
  GRPC = "grpc",
  /** Query and migrate a database from application code. */
  DATABASE_ACCESS = "database-access",
  /** Build authentication and authorization. */
  AUTH = "auth",
  /** Build user interfaces. */
  UI = "ui",
  /** Write and run automated tests. */
  TESTING = "testing",
  /** Decide what needs testing and how (unit/integration/API/E2E), before implementation starts. */
  TEST_STRATEGY = "test-strategy",
  /** Analyze a design source (Figma file, design handoff) and turn it into UX recommendations. */
  UX_ANALYSIS = "ux-analysis",
  /** Check implemented work against what was specified. */
  VERIFICATION = "verification",
  /** Audit code adversarially for security defects. */
  SECURITY_AUDIT = "security-audit",
  /** Ship to an environment. */
  DEPLOYMENT = "deployment",
  /** Run database migrations against a real database. */
  MIGRATION = "migration",
  /** Set up and maintain continuous integration. */
  CI = "ci",
  /** Decide what an unclassifiable task actually is. */
  TRIAGE = "triage",
  /** Give an approval only a person can give. */
  APPROVAL = "approval",
}

export const ALL_CAPABILITIES: Capability[] = Object.values(Capability);
