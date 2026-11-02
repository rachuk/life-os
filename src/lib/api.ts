'use client';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
    public fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
  }
}

/** JSON fetch helper with the server error contract; network failures become a readable error. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers: init.body !== undefined && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
      body: init.body === undefined ? undefined : init.body instanceof FormData ? init.body : JSON.stringify(init.body),
      credentials: 'same-origin',
      signal: init.signal,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Нет соединения с сервером. Проверь интернет и попробуй ещё раз.');
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const d = (data ?? {}) as { code?: string; message?: string; details?: unknown; fieldErrors?: Record<string, string[]> };
    if (res.status === 401 && typeof window !== 'undefined') window.location.replace(new URL('/login', window.location.origin).toString());
    throw new ApiError(res.status, d.code ?? 'HTTP', d.message ?? `Ошибка ${res.status}`, d.details, d.fieldErrors);
  }
  return data as T;
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Что-то пошло не так';
}
