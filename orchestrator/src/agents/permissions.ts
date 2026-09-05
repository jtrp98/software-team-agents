/** The fixed permission vocabulary — every role's permission list is drawn from this set only. */
export enum Permission {
  READ = "read",
  WRITE_DOCS = "write_docs",
  WRITE_CODE = "write_code",
  TEST = "test",
  BUILD = "build",
  DEPLOY = "deploy",
  ROLLBACK = "rollback",
}
