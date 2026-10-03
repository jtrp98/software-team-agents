export type UserRow = {
  id: number;
  email: string;
  name: string;
  status: string;
  isOrgAdmin: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  assignments: AssignmentRow[];
};

export type AssignmentRow = {
  id: number;
  role: string;
  knowledgeId: number | null;
  knowledgeName: string | null;
  module: string | null;
  priority: number;
};

export type RoleCatalogItem = { role: string; displayName: string };
export type GatePolicyItem = { gateType: string; requiredRole: string };
export type KnowledgeLite = { id: number; name: string; modules: string[] };

export type AuditRow = {
  id: number;
  at: string;
  actorType: string;
  actorName: string | null;
  actingRole: string | null;
  action: string;
  objectType: string | null;
  objectId: string | null;
  knowledge: string | null;
  module: string | null;
  detail: unknown;
};

export type UsageRow = { runtimeType: string; outcome: string | null; count: number };
