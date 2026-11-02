import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { ZodError, type ZodType } from 'zod';
import { getSessionUser, SESSION_COOKIE, type SessionUser } from './auth/session';
import { env } from './env';

/** Error contract (PRD §17): readable code, message, optional fieldErrors, correlationId. */
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: unknown,
    public fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Запись') => new AppError('NOT_FOUND', `${what} не найдена`, 404);
export const unauthorized = () => new AppError('UNAUTHORIZED', 'Нужно войти в аккаунт', 401);

export function errorBody(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: { code: err.code, message: err.message, fieldErrors: err.fieldErrors, details: err.details },
    };
  }
  if (err instanceof ZodError) {
    const fieldErrors: Record<string, string[]> = {};
    for (const i of err.issues) {
      const k = i.path.join('.') || '_';
      (fieldErrors[k] ??= []).push(i.message);
    }
    return { status: 422, body: { code: 'VALIDATION_ERROR', message: 'Проверь введённые данные', fieldErrors } };
  }
  const correlationId = randomUUID();
  // Log only the error type and correlation id — never user data or payloads (PRD §17, §18.3).
  console.error(`[error ${correlationId}]`, err instanceof Error ? `${err.name}: ${err.message.split('\n')[0]}` : 'unknown');
  return {
    status: 500,
    body: { code: 'INTERNAL', message: 'Что-то пошло не так. Попробуй ещё раз.', correlationId },
  };
}

export function errorResponse(err: unknown): NextResponse {
  const { status, body } = errorBody(err);
  return NextResponse.json(body, { status });
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** CSRF-compatible check for cookie-authenticated mutations: same-origin only. */
export function assertSameOrigin(req: Request): void {
  if (!MUTATING.has(req.method)) return;
  const origin = req.headers.get('origin');
  const site = req.headers.get('sec-fetch-site');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (origin) {
    let o: URL;
    try {
      o = new URL(origin);
    } catch {
      throw new AppError('CSRF', 'Запрос отклонён', 403);
    }
    const appOrigin = new URL(env().APP_URL).origin;
    if (o.origin === appOrigin || (host && o.host === host)) return;
    throw new AppError('CSRF', 'Запрос отклонён', 403);
  }
  if (site && site !== 'same-origin' && site !== 'none') throw new AppError('CSRF', 'Запрос отклонён', 403);
}

export async function sessionUserFromCookies(): Promise<SessionUser | null> {
  const c = await cookies();
  return getSessionUser(c.get(SESSION_COOKIE)?.value);
}

type Params = Record<string, string | string[] | undefined>;

export interface RouteCtx {
  req: Request;
  user: SessionUser;
  params: Params;
  url: URL;
}

/** Authenticated JSON route handler with error contract. */
export function userRoute(handler: (ctx: RouteCtx) => Promise<unknown>) {
  return async (req: Request, context: { params?: Promise<Params> }) => {
    try {
      assertSameOrigin(req);
      const user = await sessionUserFromCookies();
      if (!user) throw unauthorized();
      const params = (await context?.params) ?? {};
      const result = await handler({ req, user, params, url: new URL(req.url) });
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true });
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export async function readJson<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AppError('BAD_JSON', 'Некорректное тело запроса', 400);
  }
  return schema.parse(raw);
}

export function param(params: Params, key: string): string {
  const v = params[key];
  if (typeof v !== 'string') throw new AppError('BAD_REQUEST', `Нет параметра ${key}`, 400);
  return v;
}
