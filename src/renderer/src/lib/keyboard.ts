import { useEffect } from 'react'
import { useStore } from '../state/store'

function isTextInput(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  const tag = t.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type
    return !['checkbox', 'radio', 'button', 'range', 'color'].includes(type)
  }
  return false
}

/** Globale Tastenkürzel. Paketkürzel werden während Texteingaben und offenen Dialogen nie ausgelöst. */
export function useKeyboard(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState()
      if (!s.project) return
      if (s.dialog) return // Dialoge behandeln Tasten selbst
      if (isTextInput(e.target)) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur()
        return
      }
      if (e.defaultPrevented) return
      const ctrl = e.ctrlKey || e.metaKey

      if (ctrl && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        s.selectAll()
        return
      }
      if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault()
        void s.undo()
        return
      }
      if (ctrl && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault()
        void s.redo()
        return
      }
      // Paketansicht: Strg+Pfeil verschiebt die Auswahl in der Reihenfolge
      if (ctrl && s.packageView && s.view === 'grid' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault()
        const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' ? -s.columns : s.columns
        void s.moveSelectionInPackage(step)
        return
      }
      // Alt+0–5: Bewertung, Alt+6–9: Farbmarkierung (umschalten)
      const altDigit = e.altKey && !ctrl ? (/^(?:Digit|Numpad)([0-9])$/.exec(e.code)?.[1] ?? null) : null
      if (altDigit != null) {
        e.preventDefault()
        const n = Number(altDigit)
        if (n <= 5) void s.setRating(n)
        else void s.toggleColor((['red', 'yellow', 'green', 'blue'] as const)[n - 6])
        return
      }
      if (ctrl && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        document.getElementById('media-search')?.focus()
        return
      }
      if (ctrl || e.altKey) return

      if (e.key === 'Escape') {
        if (s.filterOpen) s.setFilterOpen(false)
        else if (s.staged.size) useStore.setState({ staged: new Set() })
        else if (s.view === 'focus') s.setView('grid')
        else if (s.selection.size > 1 && s.active != null) s.select(s.active, 'single')
        else if (s.packageView) s.closePackageView()
        return
      }

      // Ziffern 1–9 (auch Ziffernblock) -> Paket
      const digit = /^Digit([1-9])$/.exec(e.code) ?? /^Numpad([1-9])$/.exec(e.code)
      if (digit && s.settings?.shortcutsEnabled !== false) {
        const n = Number(digit[1])
        const pkg = s.packages.find((p) => p.shortcut === n)
        if (pkg) {
          e.preventDefault()
          if (s.settings?.quickAssign === 'stage') s.toggleStage(pkg.id)
          else void s.togglePackage(pkg.id)
        }
        return
      }

      // Pfeiltasten nur, wenn kein Bedienelement den Fokus hat, das sie selbst nutzt
      const t = e.target as HTMLElement | null
      const inControl = !!t && t !== document.body && !t.closest('.gallery') && !t.closest('.stage') && /^(BUTTON|A|VIDEO|INPUT)$/.test(t.tagName)
      switch (e.key) {
        case 'ArrowRight':
          if (inControl) return
          e.preventDefault()
          s.navigate(1, e.shiftKey && s.view === 'grid')
          break
        case 'ArrowLeft':
          if (inControl) return
          e.preventDefault()
          s.navigate(-1, e.shiftKey && s.view === 'grid')
          break
        case 'ArrowDown':
          if (inControl || s.view !== 'grid') return
          e.preventDefault()
          s.navigate(s.columns, e.shiftKey)
          break
        case 'ArrowUp':
          if (inControl || s.view !== 'grid') return
          e.preventDefault()
          s.navigate(-s.columns, e.shiftKey)
          break
        case 'Delete':
          if (s.packageView && s.selection.size) {
            e.preventDefault()
            void s.removeSelectionFromPackage()
          }
          break
        case 'Home':
          e.preventDefault()
          s.navigate('home', e.shiftKey)
          break
        case 'End':
          e.preventDefault()
          s.navigate('end', e.shiftKey)
          break
        case 'Enter':
          if (t && t.tagName === 'BUTTON') return
          e.preventDefault()
          if (s.settings?.quickAssign === 'stage' && (s.staged.size || s.view === 'focus')) void s.commitStaged()
          else if (s.view === 'grid') {
            if (s.active != null) s.setView('focus')
          } else s.navigate(1)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
