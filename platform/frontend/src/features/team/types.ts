export type TeamRow = {
  taskId: string;
  phase: number;
  status: string;
  stage: string | null;
  role: string | null;
  waitingOn: string | null;
  staRunId: string;
};
