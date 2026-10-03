export type GateCard = {
  id: number;
  displayId: string;
  gateType: string;
  requiredRole: string | null;
  status: string;
  knowledgeName: string;
  module: string | null;
  question: string;
  aiAnalysis: string | null;
  options: string[];
  staRunId: string | null;
  assigneeName: string | null;
  createdAt: string;
  answeredByName: string | null;
  actingRole: string | null;
  decisionSummary: string | null;
  canAnswer: boolean;
};

export type GateDetail = {
  gate: GateCard;
  contextJson: string | null;
  blockedRefsJson: string | null;
  routingMode: string;
};

export type CreateGateRequest = {
  gateType: string;
  knowledgeId: number;
  module?: string;
  question: string;
  aiAnalysis?: string;
  options?: string[];
  contextJson?: string;
  staRunId?: string;
  staGateKey?: string;
  routingMode?: string;
  assigneeId?: number;
};

export type AnswerGateRequest = {
  approved?: boolean;
  choice?: string;
  comment?: string;
};
