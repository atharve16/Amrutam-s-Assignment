import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface RateBucket {
  count: number;
  resetAt: number;
}

@Injectable()
export class AuthRateLimiterService {
  private readonly buckets = new Map<string, RateBucket>();
  private readonly maximum: number;
  private readonly windowMs: number;

  constructor(config: ConfigService) {
    this.maximum = config.getOrThrow<number>('auth.rateLimitMax');
    this.windowMs = config.getOrThrow<number>('auth.rateLimitWindowSeconds') * 1000;
  }

  consume(key: string): void {
    const now = Date.now();
    const current = this.buckets.get(key);
    if (!current || current.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    current.count += 1;
    if (current.count > this.maximum) {
      throw new HttpException('Too many authentication attempts', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  clear(key: string): void {
    this.buckets.delete(key);
  }
}
