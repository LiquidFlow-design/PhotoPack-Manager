import { useEffect, useState } from 'react'
import type { MediaDetail } from '@shared/types'
import { api, mediaUrl, previewUrl } from '../lib/api'

/** Präsentationsfenster (zweiter Bildschirm): zeigt das aktive Medium; Pfeiltasten steuern das Hauptfenster. */
export function Presenter() {
  const [id, setId] = useState<number | null>(null)
  const [detail, setDetail] = useState<MediaDetail | null>(null)
  useEffect(() => {
    document.documentElement.dataset.theme = 'dark'
    document.title = 'PhotoPack Manager – Präsentation'
    const off = api.onEvent((e) => {
      if (e.type === 'presenter-show') setId(e.mediaId)
    })
    void api.app.presenterCurrent().then((m) => setId((cur) => cur ?? m))
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ') void api.app.presenterNav(1)
      else if (e.key === 'ArrowLeft') void api.app.presenterNav(-1)
      else if (e.key === 'Escape') {
        if (document.fullscreenElement) void document.exitFullscreen()
        else void api.app.closePresenter()
      } else if (e.key === 'f' || e.key === 'F11') {
        e.preventDefault()
        if (document.fullscreenElement) void document.exitFullscreen()
        else void document.documentElement.requestFullscreen()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      off()
      window.removeEventListener('keydown', onKey)
    }
  }, [])
  useEffect(() => {
    let off = false
    setDetail(null)
    if (id != null) void api.media.detail(id).then((d) => !off && setDetail(d))
    return () => {
      off = true
    }
  }, [id])
  return (
    <div className="presenter" onDoubleClick={() => (document.fullscreenElement ? void document.exitFullscreen() : void document.documentElement.requestFullscreen())}>
      {id == null || !detail ? null : detail.kind === 'video' ? <video key={id} src={mediaUrl(id)} controls /> : <img key={id} src={previewUrl(id)} alt={detail.name} />}
    </div>
  )
}
