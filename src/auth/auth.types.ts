export const USER_ROLES = ['patient', 'doctor', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export interface AuthenticatedUser {
  id: string;
  role: UserRole;
  sessionId: string;
}

export interface AccessTokenClaims {
  sub: string;
  role: UserRole;
  sid: string;
  typ: 'access';
  iat?: number;
  exp?: number;
}
