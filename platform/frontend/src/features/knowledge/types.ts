export type KnowledgeInfo = {
  name: string;
  path?: string;
  state?: string;
  isDefault?: boolean;
  modules: string[];
  problems?: string[];
  warnings?: string[];
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

export type MemberDto = { userId: number; name: string; email: string; status: string };
export type UserLite = { id: number; email: string; name: string; status: string };
