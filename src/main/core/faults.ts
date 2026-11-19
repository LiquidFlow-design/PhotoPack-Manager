// Fehlerinjektion für Tests (simulierte Abstürze an definierten Punkten der Datei-Engine).
// Im Produktivbetrieb sind keine Hooks registriert; hit() ist dann ein No-op.

export type FaultPoint =
  | 'copy:afterTmpCreated'
  | 'copy:afterTmpWritten'
  | 'copy:afterVerify'
  | 'copy:beforeCommit'
  | 'copy:afterCommit'
  | 'release:beforeMove'
  | 'release:afterRecoveryCopy'
  | 'release:afterRecoveryCommit'
  | 'release:afterSourceRemoved'
  | 'restore:afterCommit'

/** Simuliert einen Prozessabsturz: die Engine darf danach keinen weiteren Zustand schreiben. */
export class SimulatedCrash extends Error {
  constructor(public point: FaultPoint) {
    super('Simulierter Absturz bei ' + point)
  }
}

export type FaultHook = (ctx: Record<string, unknown>) => void | Promise<void>

export class Faults {
  private hooks = new Map<FaultPoint, FaultHook>()
  on(point: FaultPoint, hook: FaultHook): void {
    this.hooks.set(point, hook)
  }
  crashAt(point: FaultPoint, times = 1): void {
    let n = times
    this.hooks.set(point, () => {
      if (n-- > 0) throw new SimulatedCrash(point)
    })
  }
  clear(): void {
    this.hooks.clear()
  }
  async hit(point: FaultPoint, ctx: Record<string, unknown> = {}): Promise<void> {
    const h = this.hooks.get(point)
    if (h) await h(ctx)
  }
}
