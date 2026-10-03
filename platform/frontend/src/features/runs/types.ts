export type KnowledgeInfo = {
  name: string;
  path?: string;
  state?: string;
  isDefault?: boolean;
  modules: string[];
};

export type KnowledgeRow = {
  id: number;
  name: string;
  repositoryUrl: string | null;
  defaultBranch: string | null;
  status: string;
  registeredOnThisMachine: boolean;
  createdAt: string;
  modules: string[];
  members: { userId: number; name: string; email: string; status: string }[];
  isMember: boolean;
};

export type RunRow = {
  staRunId: string;
  knowledgeId: number;
  knowledgeName: string;
  module: string;
  status: string | null;
  statusReason: string | null;
  openGates: number;
  createdAt: string;
  updatedAt: string;
  createdByName: string | null;
};

export type StaRunDiff = { diff: string; truncated: boolean; note?: string };
export type StaPrepareCommit = { note: string; commands: string[]; targetRoots: (string | null)[] };
