import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { QueryResultRow } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessTokenClaims, USER_ROLES, UserRole } from '../auth.types';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

interface SessionUserRow extends QueryResultRow {
  user_id: string;
  role: UserRole;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly database: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    const authorization = request.header('authorization');
    if (!authorization?.startsWith('Bearer '))
      throw new UnauthorizedException('Bearer token required');
    const token = authorization.slice(7).trim();
    if (!token) throw new UnauthorizedException('Bearer token required');

    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(token, { algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedException('Access token is invalid or expired');
    }
    if (
      claims.typ !== 'access' ||
      !claims.sub ||
      !claims.sid ||
      !USER_ROLES.includes(claims.role)
    ) {
      throw new UnauthorizedException('Access token is invalid');
    }

    const result = await this.database.query<SessionUserRow>(
      `SELECT session.user_id, app_user.role
       FROM sessions AS session
       JOIN users AS app_user ON app_user.id = session.user_id
       WHERE session.id = $1 AND session.user_id = $2
         AND session.status = 'active' AND session.expires_at > now()
         AND app_user.status = 'active'`,
      [claims.sid, claims.sub],
    );
    const active = result.rows[0];
    if (!active || active.role !== claims.role)
      throw new UnauthorizedException('Session is no longer active');
    request.user = { id: active.user_id, role: active.role, sessionId: claims.sid };
    return true;
  }
}
