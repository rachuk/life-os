import { z } from 'zod';

/** Structured outputs for image analysis (PRD §11.3–11.5). All values are suggestions. */

export const weightPhotoSchema = z.object({
  readable: z.boolean(),
  value: z.number().min(20).max(400).nullable(),
  unit: z.enum(['kg', 'lb']).nullable(),
  confidence: z.number().min(0).max(1),
  otherNumbersVisible: z.boolean().default(false),
  note: z.string().max(300).nullable().default(null),
});

export const stepsScreenshotSchema = z.object({
  readable: z.boolean(),
  value: z.number().int().min(0).max(1000000).nullable(),
  period: z.enum(['day', 'week', 'month', 'unknown']),
  dateShown: z.string().nullable(), // as printed on screen, e.g. "Сегодня", "1 нояб."
  dateIso: z.string().nullable(), // model's best guess YYYY-MM-DD, re-validated by the server
  metric: z.enum(['steps', 'distance', 'calories', 'other']),
  confidence: z.number().min(0).max(1),
  note: z.string().max(300).nullable().default(null),
});

export const mealPhotoSchema = z.object({
  readable: z.boolean(),
  detected: z.array(z.object({ name: z.string().max(80), confidence: z.number().min(0).max(1) })).max(15),
  possible: z.array(z.string().max(80)).max(10),
  notVisible: z.array(z.string().max(120)).max(10),
  portionNote: z.string().max(200).nullable(),
  questions: z.array(z.string().max(160)).max(2),
  matchesPlan: z.enum(['yes', 'partly', 'no', 'unknown']),
  note: z.string().max(300).nullable().default(null),
});

export const weeklyInsightsSchema = z.object({
  summary: z.string().max(800),
  observations: z.array(z.object({ text: z.string().max(400), basedOn: z.string().max(200) })).max(4),
  suggestions: z.array(z.object({ text: z.string().max(400), why: z.string().max(300) })).max(3),
});

export type WeightPhoto = z.infer<typeof weightPhotoSchema>;
export type StepsScreenshot = z.infer<typeof stepsScreenshotSchema>;
export type MealPhoto = z.infer<typeof mealPhotoSchema>;
export type WeeklyInsights = z.infer<typeof weeklyInsightsSchema>;
