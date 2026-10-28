import { createHash, randomBytes } from 'node:crypto';
import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { QueryResultRow } from 'pg';
import { postgresErrorCode } from '../common/database/postgres-error';
import { DatabaseService, TransactionClient } from '../database/database.service';
import { AccessTokenClaims, UserRole } from './auth.types';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

interface UserCredentialRow extends QueryResultRow {
  id: string;
  password_hash: string;
  role: UserRole;
  status: string;
}

interface RefreshSessionRow extends QueryResultRow {
  id: string;
  user_id: string;
  token_family_id: string;
  status: 'active' | 'rotated' | 'revoked' | 'compromised';
  expires_at: Date;
  role: UserRole;
  user_status: string;
}

interface IssuedSession {
  sessionId: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface AuthTokens {
  accessToken: string;
  accessTokenExpiresInSeconds: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

export function durationToSeconds(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value);
  if (!match) throw new Error('Invalid JWT duration');
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier =
    unit === 'ms' ? 0.001 : unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
  return Math.max(1, Math.floor(amount * multiplier));
}

@Injectable()
export class AuthService {
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlDays: number;
  private readonly dummyPasswordHash: Promise<string>;

  constructor(
    private readonly database: DatabaseService,
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.accessTtlSeconds = durationToSeconds(config.getOrThrow<string>('jwt.accessTtl'));
    this.refreshTtlDays = config.getOrThrow<number>('jwt.refreshTtlDays');
    this.dummyPasswordHash = argon2.hash('invalid-login-password', {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
  }

  async register(
    input: RegisterDto,
    requestId?: string,
  ): Promise<{ user: { id: string; role: UserRole }; tokens: AuthTokens }> {
    const passwordHash = await argon2.hash(input.password, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    try {
      const created = await this.database.withTransaction(async (client) => {
        const userResult = await client.query<{ id: string; role: UserRole } & QueryResultRow>(
          `INSERT INTO users (email, password_hash, role, status)
           VALUES ($1, $2, 'patient', 'active')
           RETURNING id, role`,
          [input.email, passwordHash],
        );
        const user = userResult.rows[0];
        if (!user) throw new Error('User insert returned no row');
        await client.query(
          `INSERT INTO profiles (user_id, full_name, timezone) VALUES ($1, $2, $3)`,
          [user.id, input.fullName, input.timezone],
        );
        const session = await this.createSession(client, user.id);
        await this.audit(client, user.id, 'auth.registered', 'user', user.id, requestId);
        return { user, session };
      });
      return { user: created.user, tokens: await this.tokens(created.user, created.session) };
    } catch (error) {
      if (postgresErrorCode(error) === '23505') {
        throw new ConflictException('An account with this email already exists');
      }
      throw error;
    }
  }

  async login(
    input: LoginDto,
    requestId?: string,
  ): Promise<{ user: { id: string; role: UserRole }; tokens: AuthTokens }> {
    const result = await this.database.query<UserCredentialRow>(
      `SELECT id, password_hash, role, status FROM users WHERE email = $1`,
      [input.email],
    );
    const user = result.rows[0];
    const comparisonHash = user?.password_hash ?? (await this.dummyPasswordHash);
    const valid = await argon2.verify(comparisonHash, input.password).catch(() => false);
    if (!user || !valid || user.status !== 'active') {
      throw new UnauthorizedException('Email or password is incorrect');
    }
    const session = await this.database.withTransaction(async (client) => {
      const issued = await this.createSession(client, user.id);
      await this.audit(client, user.id, 'auth.logged_in', 'session', issued.sessionId, requestId);
      return issued;
    });
    return { user: { id: user.id, role: user.role }, tokens: await this.tokens(user, session) };
  }

  async refresh(refreshToken: string, requestId?: string): Promise<AuthTokens> {
    const tokenHash = this.hashToken(refreshToken);
    const outcome = await this.database.withTransaction(async (client) => {
      const result = await client.query<RefreshSessionRow>(
        `SELECT session.id, session.user_id, session.token_family_id, session.status,
                session.expires_at, app_user.role, app_user.status AS user_status
         FROM sessions AS session
         JOIN users AS app_user ON app_user.id = session.user_id
         WHERE session.token_hash = $1
         FOR UPDATE`,
        [tokenHash],
      );
      const current = result.rows[0];
      if (!current) return { denied: true as const };
      if (current.status !== 'active') {
        if (current.status === 'rotated') {
          await client.query(
            `UPDATE sessions SET status = 'compromised', terminal_at = now()
             WHERE token_family_id = $1 AND status = 'active'`,
            [current.token_family_id],
          );
          await this.audit(
            client,
            current.user_id,
            'auth.refresh_reuse_detected',
            'session',
            current.id,
            requestId,
          );
        }
        return { denied: true as const };
      }
      if (current.expires_at.getTime() <= Date.now() || current.user_status !== 'active') {
        await client.query(
          `UPDATE sessions SET status = 'revoked', terminal_at = now() WHERE id = $1`,
          [current.id],
        );
        return { denied: true as const };
      }

      await client.query(
        `UPDATE sessions SET status = 'rotated', terminal_at = now(), last_used_at = now()
         WHERE id = $1`,
        [current.id],
      );
      const next = await this.createSession(
        client,
        current.user_id,
        current.token_family_id,
        current.id,
      );
      await this.audit(
        client,
        current.user_id,
        'auth.token_refreshed',
        'session',
        next.sessionId,
        requestId,
      );
      return {
        denied: false as const,
        user: { id: current.user_id, role: current.role },
        session: next,
      };
    });
    if (outcome.denied) throw new UnauthorizedException('Refresh token is invalid or expired');
    return this.tokens(outcome.user, outcome.session);
  }

  async logout(userId: string, sessionId: string, requestId?: string): Promise<void> {
    await this.database.withTransaction(async (client) => {
      await client.query(
        `UPDATE sessions SET status = 'revoked', terminal_at = now()
         WHERE id = $1 AND user_id = $2 AND status = 'active'`,
        [sessionId, userId],
      );
      await this.audit(client, userId, 'auth.logged_out', 'session', sessionId, requestId);
    });
  }

  private async createSession(
    client: TransactionClient,
    userId: string,
    familyId?: string,
    parentSessionId?: string,
  ): Promise<IssuedSession> {
    const refreshToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.refreshTtlDays * 86_400_000);
    const result = await client.query<{ id: string } & QueryResultRow>(
      `INSERT INTO sessions (
         user_id, token_family_id, parent_session_id, token_hash, expires_at
       ) VALUES ($1, COALESCE($2, gen_random_uuid()), $3, $4, $5)
       RETURNING id`,
      [userId, familyId ?? null, parentSessionId ?? null, this.hashToken(refreshToken), expiresAt],
    );
    const sessionId = result.rows[0]?.id;
    if (!sessionId) throw new Error('Session insert returned no row');
    return { sessionId, refreshToken, refreshExpiresAt: expiresAt };
  }

  private async tokens(
    user: { id: string; role: UserRole },
    session: IssuedSession,
  ): Promise<AuthTokens> {
    const claims: AccessTokenClaims = {
      sub: user.id,
      role: user.role,
      sid: session.sessionId,
      typ: 'access',
    };
    return {
      accessToken: await this.jwt.signAsync(claims, {
        algorithm: 'HS256',
        expiresIn: this.accessTtlSeconds,
      }),
      accessTokenExpiresInSeconds: this.accessTtlSeconds,
      refreshToken: session.refreshToken,
      refreshTokenExpiresAt: session.refreshExpiresAt.toISOString(),
    };
  }

  private hashToken(token: string): Buffer {
    return createHash('sha256').update(token).digest();
  }

  private async audit(
    client: TransactionClient,
    actorId: string,
    action: string,
    resourceType: string,
    resourceId: string,
    requestId?: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, request_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [actorId, action, resourceType, resourceId, requestId ?? null],
    );
  }
}
