// Reine Logik für Tri-State-Paketzuordnung (testbar ohne UI).
import type { AssignmentDelta, AssignmentPair } from './types'

export type TriState = 'none' | 'partial' | 'all'

export type AssignmentIndex = Map<number, Set<string>>

export function buildIndex(pairs: AssignmentPair[]): AssignmentIndex {
  const idx: AssignmentIndex = new Map()
  for (const [m, p] of pairs) {
    let s = idx.get(m)
    if (!s) idx.set(m, (s = new Set()))
    s.add(p)
  }
  return idx
}

export function triState(idx: AssignmentIndex, mediaIds: Iterable<number>, packageId: string): { state: TriState; count: number; total: number } {
  let count = 0
  let total = 0
  for (const id of mediaIds) {
    total++
    if (idx.get(id)?.has(packageId)) count++
  }
  const state: TriState = count === 0 ? 'none' : count === total ? 'all' : 'partial'
  return { state, count, total }
}

/**
 * Klick auf Paketindikator:
 *  - keines  -> allen zuordnen
 *  - teilweise -> fehlende ergänzen
 *  - alle -> für alle entfernen
 */
export function toggleDelta(idx: AssignmentIndex, mediaIds: number[], packageId: string): AssignmentDelta {
  const { state } = triState(idx, mediaIds, packageId)
  if (state === 'all') {
    return { added: [], removed: mediaIds.map((m) => [m, packageId] as AssignmentPair) }
  }
  return {
    added: mediaIds.filter((m) => !idx.get(m)?.has(packageId)).map((m) => [m, packageId] as AssignmentPair),
    removed: []
  }
}

/** Mehrere Pakete gleichzeitig hinzufügen (Modus „auswählen, dann Enter“). */
export function addManyDelta(idx: AssignmentIndex, mediaIds: number[], packageIds: string[]): AssignmentDelta {
  const added: AssignmentPair[] = []
  for (const m of mediaIds) for (const p of packageIds) if (!idx.get(m)?.has(p)) added.push([m, p])
  return { added, removed: [] }
}

export function invertDelta(d: AssignmentDelta): AssignmentDelta {
  return { added: d.removed.map((x) => [...x] as AssignmentPair), removed: d.added.map((x) => [...x] as AssignmentPair) }
}

export function applyDelta(idx: AssignmentIndex, d: AssignmentDelta): void {
  for (const [m, p] of d.removed) idx.get(m)?.delete(p)
  for (const [m, p] of d.added) {
    let s = idx.get(m)
    if (!s) idx.set(m, (s = new Set()))
    s.add(p)
  }
}

export function isEmptyDelta(d: AssignmentDelta): boolean {
  return d.added.length === 0 && d.removed.length === 0
}
