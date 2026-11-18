import { describe, expect, it } from 'vitest'
import { addManyDelta, applyDelta, buildIndex, invertDelta, toggleDelta, triState } from '../../src/shared/assignment'

describe('Tri-State-Zuordnung', () => {
  it('keines -> allen zuordnen', () => {
    const idx = buildIndex([])
    expect(triState(idx, [1, 2], 'A').state).toBe('none')
    const d = toggleDelta(idx, [1, 2], 'A')
    expect(d.added).toEqual([[1, 'A'], [2, 'A']])
    expect(d.removed).toEqual([])
  })
  it('teilweise -> fehlende ergänzen, danach alle -> für alle entfernen', () => {
    const idx = buildIndex([[1, 'A']])
    expect(triState(idx, [1, 2, 3], 'A')).toEqual({ state: 'partial', count: 1, total: 3 })
    const d = toggleDelta(idx, [1, 2, 3], 'A')
    expect(d.added).toEqual([[2, 'A'], [3, 'A']])
    applyDelta(idx, d)
    expect(triState(idx, [1, 2, 3], 'A').state).toBe('all')
    const d2 = toggleDelta(idx, [1, 2, 3], 'A')
    expect(d2.removed).toHaveLength(3)
    applyDelta(idx, d2)
    expect(triState(idx, [1, 2, 3], 'A').state).toBe('none')
  })
  it('Rückgängig invertiert exakt', () => {
    const idx = buildIndex([[1, 'A']])
    const d = toggleDelta(idx, [1, 2], 'A')
    applyDelta(idx, d)
    applyDelta(idx, invertDelta(d))
    expect([...idx.get(1)!]).toEqual(['A'])
    expect(idx.get(2)?.size ?? 0).toBe(0)
  })
  it('mehrere Pakete auf einmal (Modus „auswählen, dann Enter“)', () => {
    const idx = buildIndex([[1, 'A']])
    const d = addManyDelta(idx, [1, 2], ['A', 'B'])
    expect(d.added).toEqual([[1, 'B'], [2, 'A'], [2, 'B']])
  })
  it('Paketzuordnung lässt andere Pakete unberührt', () => {
    const idx = buildIndex([[1, 'B']])
    const d = toggleDelta(idx, [1], 'A')
    applyDelta(idx, d)
    expect([...idx.get(1)!].sort()).toEqual(['A', 'B'])
  })
})
