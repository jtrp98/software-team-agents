export type ConnectionRow = {
  id: number;
  runtimeType: string;
  ownerType: string;
  ownerId: number;
  ownerLabel: string;
  sharingScope: string;
  status: string;
  label: string | null;
  machineName: string | null;
  staState: string | null;
  staAuthentication: string | null;
  createdAt: string;
};
