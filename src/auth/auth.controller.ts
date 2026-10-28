import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthenticatedUser } from './auth.types';
import { AuthRateLimiterService } from './auth-rate-limiter.service';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly limiter: AuthRateLimiterService,
  ) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Register a patient account' })
  @ApiResponse({ status: 201, description: 'Patient registered and session created' })
  async register(@Body() input: RegisterDto, @Req() request: Request): Promise<unknown> {
    this.limiter.consume(`register:${request.ip}`);
    return this.auth.register(input, request.requestId);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Log in with email and password' })
  async login(@Body() input: LoginDto, @Req() request: Request): Promise<unknown> {
    const key = `login:${request.ip}:${input.email}`;
    this.limiter.consume(key);
    const response = await this.auth.login(input, request.requestId);
    this.limiter.clear(key);
    return response;
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate a refresh token and issue a new access token' })
  async refresh(@Body() input: RefreshTokenDto, @Req() request: Request): Promise<unknown> {
    this.limiter.consume(`refresh:${request.ip}`);
    return this.auth.refresh(input.refreshToken, request.requestId);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke the current session' })
  async logout(@CurrentUser() user: AuthenticatedUser, @Req() request: Request): Promise<void> {
    await this.auth.logout(user.id, user.sessionId, request.requestId);
  }
}
