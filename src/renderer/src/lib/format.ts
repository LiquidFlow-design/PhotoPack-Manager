export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '–'
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toLocaleString('de-DE', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${u[i]}`
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return ''
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

export function fmtDate(ms: number | null | undefined, withTime = true): string {
  if (!ms) return '–'
  const d = new Date(ms)
  return withTime
    ? d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('de-DE')} ${n === 1 ? one : many}`
}
