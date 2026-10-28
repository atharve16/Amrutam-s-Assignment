import type { Request } from 'express';

export const METRICS_PATH = '/api/v1/metrics';

const SAFE_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
const SAFE_ROUTE_TEMPLATE = /^\/[A-Za-z0-9_./:-]{0,199}$/;

export function boundedHttpMethod(method: string): string {
  const normalized = method.toUpperCase();
  return SAFE_METHODS.has(normalized) ? normalized : 'OTHER';
}

export function requestRouteTemplate(request: Request): string {
  const route = request.route as { path?: unknown } | undefined;
  const path = route?.path;
  return typeof path === 'string' && SAFE_ROUTE_TEMPLATE.test(path) ? path : 'unmatched';
}

export function isMetricsRequest(request: Request): boolean {
  return (
    request.path === METRICS_PATH ||
    request.path === '/metrics' ||
    request.originalUrl === METRICS_PATH ||
    request.originalUrl.startsWith(`${METRICS_PATH}?`)
  );
}
