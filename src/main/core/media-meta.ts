// Bewertungen (0–5 Sterne) und Farbmarkierungen. Werden nur in der Projektdatenbank gespeichert.
import type { ColorLabel } from '@shared/types'
import type { CoreContext } from './context'
import { getSettings } from './settings'

function withPartners(ctx: CoreContext, projectId: string, ids: number[]): number[] {
  const out = new Set<number>()
  const pairOf = ctx.db.prepare("SELECT pair_id FROM media WHERE id = ? AND project_id = ? AND role = 'main'")
  const pair = getSettings(ctx).pairRawJpeg
  for (const id of ids) {
    const r = pairOf.get(id, projectId) as { pair_id: number | null } | undefined
    if (!r) continue
    out.add(id)
    if (pair && r.pair_id) out.add(r.pair_id)
  }
  return [...out]
}

export function setRating(ctx: CoreContext, projectId: string, ids: number[], rating: number): number[] {
  const r = Math.max(0, Math.min(5, Math.round(rating)))
  const all = withPartners(ctx, projectId, ids)
  const upd = ctx.db.prepare('UPDATE media SET rating = ? WHERE id = ?')
  ctx.db.transaction(() => all.forEach((id) => upd.run(r, id)))()
  ctx.emit({ type: 'media-changed', projectId, mediaIds: all })
  return all
}

export function setColorLabel(ctx: CoreContext, projectId: string, ids: number[], color: ColorLabel | null): number[] {
  const all = withPartners(ctx, projectId, ids)
  const upd = ctx.db.prepare('UPDATE media SET color_label = ? WHERE id = ?')
  ctx.db.transaction(() => all.forEach((id) => upd.run(color, id)))()
  ctx.emit({ type: 'media-changed', projectId, mediaIds: all })
  return all
}
