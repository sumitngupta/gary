import { z } from 'zod';

export const mediaRadarSubscriptionStatusSchema = z.enum(['active', 'paused', 'cancelled']);

export const mediaRadarSubscriptionSchema = z.object({
  id: z.string().min(1),
  scheduleId: z.string().min(1),
  name: z.string().min(1),
  requester: z.string().min(1),
  resourceId: z.string().min(1),
  threadId: z.string().min(1),
  channel: z.enum(['telegram', 'slack', 'whatsapp', 'none']),
  theme: z.string().min(1),
  cron: z.string().min(1),
  timezone: z.string().min(1),
  quietHours: z.object({
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  }).optional(),
  consentedAt: z.string().datetime().optional(),
  preferredGenres: z.array(z.string()).default([]),
  blockedGenres: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  shortlistSize: z.number().int().min(1).max(20).default(5),
  status: mediaRadarSubscriptionStatusSchema,
  surfaced: z.array(z.object({
    title: z.string().min(1),
    year: z.number().int().optional(),
    surfacedAt: z.string().datetime(),
  })).default([]),
  lastRunAt: z.string().datetime().optional(),
  lastDeliveredAt: z.string().datetime().optional(),
  lastError: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type MediaRadarSubscription = z.infer<typeof mediaRadarSubscriptionSchema>;
