/** Identity types shared across features. */

export type Me = {
  id: number;
  email: string;
  name: string;
  isOrgAdmin: boolean;
  visibleKnowledgeNames: string[];
};

export type AuthResponse = {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  user: Me;
};
