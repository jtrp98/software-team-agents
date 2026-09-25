/** Test-only raw fixture seeding. Production v2 Knowledge writes must pass
 * STA's governed commit path; tests use this to exercise read/query behavior. */
import * as fs from "node:fs";
import * as path from "node:path";
import type { KnowledgeItem } from "./knowledgeModel.js";
import { pathFor, renderKnowledgeItem } from "./knowledgeStore.js";

export function seedKnowledgeFixture(item: KnowledgeItem, root: string): string {
  const destination = pathFor(item, root);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, renderKnowledgeItem(item), "utf8");
  return destination;
}
