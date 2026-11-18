import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'
import type { CoreContext } from './context'

export function getSettings(ctx: CoreContext): AppSettings {
  const row = ctx.db.prepare("SELECT value FROM app_settings WHERE key = 'settings'").get() as { value: string } | undefined
  if (!row) return structuredClone(DEFAULT_SETTINGS)
  try {
    const parsed = JSON.parse(row.value) as Partial<AppSettings>
    return { ...structuredClone(DEFAULT_SETTINGS), ...parsed, layout: { ...DEFAULT_SETTINGS.layout, ...(parsed.layout ?? {}) } }
  } catch {
    return structuredClone(DEFAULT_SETTINGS)
  }
}

export function updateSettings(ctx: CoreContext, patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(ctx), ...patch }
  if (patch.layout) next.layout = { ...getSettings(ctx).layout, ...patch.layout }
  next.recoveryRetentionDays = Math.max(1, Math.min(3650, Math.round(next.recoveryRetentionDays)))
  ctx.db
    .prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('settings', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(JSON.stringify(next), ctx.now())
  return next
}
