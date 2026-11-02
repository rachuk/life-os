import { z } from 'zod';

/**
 * Server configuration. Every secret comes from the environment; nothing is hard-coded.
 * Optional integrations are disabled (and reported as "не подключено") when keys are missing.
 */
const bool = (dflt: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? dflt : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  APP_URL: z.string().url().default('http://localhost:3000'),
  SIGNUP_MODE: z.enum(['closed', 'open']).default('closed'),
  MEDIA_SIGNING_SECRET: optional,
  CRON_SECRET: optional,
  STORAGE_DIR: z.string().default('./data/media'),
  MAX_UPLOAD_MB: z.coerce.number().min(1).max(50).default(15),

  ENABLE_TELEGRAM: bool(true),
  TELEGRAM_BOT_TOKEN: optional,
  TELEGRAM_BOT_USERNAME: optional,
  TELEGRAM_WEBHOOK_SECRET: optional,
  TELEGRAM_API_BASE: z.string().default('https://api.telegram.org'),

  ENABLE_WEB_PUSH: bool(true),
  VAPID_PUBLIC_KEY: optional,
  VAPID_PRIVATE_KEY: optional,
  VAPID_SUBJECT: z.string().default('mailto:admin@localhost'),

  ENABLE_AI_VOICE: bool(true),
  ENABLE_AI_INTENT: bool(true),
  ENABLE_AI_IMAGES: bool(true),
  ENABLE_AI_WEEKLY_REVIEW: bool(true),
  AI_TRANSCRIBE_BASE_URL: optional,
  AI_TRANSCRIBE_API_KEY: optional,
  AI_TRANSCRIBE_MODEL: z.string().default('whisper-1'),
  AI_LLM_BASE_URL: optional,
  AI_LLM_API_KEY: optional,
  AI_LLM_MODEL: optional,
  AI_VISION_MODEL: optional,
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(60000),
  AI_DAILY_REQUEST_LIMIT: z.coerce.number().int().min(0).max(10000).default(100),

  ENABLE_REWARDS: bool(true),
  ENABLE_FITNESS_CATALOG: bool(true),
  ENABLE_CALENDAR: bool(false),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** For tests that change process.env between cases. */
export function resetEnvCache(): void {
  cached = null;
}

export function mediaSigningSecret(): string {
  const e = env();
  if (e.MEDIA_SIGNING_SECRET) return e.MEDIA_SIGNING_SECRET;
  if (e.NODE_ENV === 'production') throw new Error('MEDIA_SIGNING_SECRET must be set in production');
  return 'dev-only-insecure-media-secret';
}

export interface IntegrationStatus {
  key: string;
  label: string;
  enabled: boolean;
  configured: boolean;
  detail: string;
}

export function integrationStatuses(): IntegrationStatus[] {
  const e = env();
  const tg = !!e.TELEGRAM_BOT_TOKEN && !!e.TELEGRAM_BOT_USERNAME;
  const push = !!e.VAPID_PUBLIC_KEY && !!e.VAPID_PRIVATE_KEY;
  const transcribe = !!e.AI_TRANSCRIBE_BASE_URL || !!e.AI_TRANSCRIBE_API_KEY;
  const llm = !!e.AI_LLM_MODEL && (!!e.AI_LLM_BASE_URL || !!e.AI_LLM_API_KEY);
  const vision = !!e.AI_VISION_MODEL && (!!e.AI_LLM_BASE_URL || !!e.AI_LLM_API_KEY);
  return [
    {
      key: 'telegram',
      label: 'Telegram-бот',
      enabled: e.ENABLE_TELEGRAM,
      configured: tg,
      detail: tg ? `@${e.TELEGRAM_BOT_USERNAME}` : 'Не подключено: не заданы TELEGRAM_BOT_TOKEN и TELEGRAM_BOT_USERNAME',
    },
    {
      key: 'web_push',
      label: 'Push-уведомления (PWA)',
      enabled: e.ENABLE_WEB_PUSH,
      configured: push,
      detail: push ? 'VAPID-ключи заданы' : 'Не подключено: не заданы VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (pnpm vapid)',
    },
    {
      key: 'ai_voice',
      label: 'Распознавание голоса',
      enabled: e.ENABLE_AI_VOICE,
      configured: transcribe,
      detail: transcribe ? `Модель ${e.AI_TRANSCRIBE_MODEL}` : 'Не подключено: голос можно ввести текстом',
    },
    {
      key: 'ai_intent',
      label: 'ИИ-разбор сообщений',
      enabled: e.ENABLE_AI_INTENT,
      configured: llm,
      detail: llm ? `Модель ${e.AI_LLM_MODEL}` : 'Работает встроенный разбор по правилам (без ИИ)',
    },
    {
      key: 'ai_images',
      label: 'Распознавание фото',
      enabled: e.ENABLE_AI_IMAGES,
      configured: vision,
      detail: vision ? `Модель ${e.AI_VISION_MODEL}` : 'Не подключено: значения с фото вводятся вручную',
    },
    {
      key: 'ai_weekly',
      label: 'ИИ-комментарий к обзору недели',
      enabled: e.ENABLE_AI_WEEKLY_REVIEW,
      configured: llm,
      detail: llm ? 'Факты считает сервер, ИИ только комментирует' : 'Обзор строится по правилам, без ИИ',
    },
  ];
}
