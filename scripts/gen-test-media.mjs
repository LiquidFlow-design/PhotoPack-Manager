// Erzeugt synthetische Testmedien (niemals echte Nutzerdaten).
// Aufruf: node scripts/gen-test-media.mjs <zielordner> [anzahlJpeg=40] [--videos]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sharp = require('sharp')
const ffmpeg = require('ffmpeg-static')

const out = path.resolve(process.argv[2] ?? 'test-media')
const n = Number(process.argv[3] ?? 40)
const videos = process.argv.includes('--videos')
fs.mkdirSync(out, { recursive: true })

const palette = [
  [56, 90, 123], [65, 108, 120], [69, 110, 88], [59, 73, 109], [104, 102, 123], [52, 90, 120],
  [75, 108, 129], [113, 84, 106], [65, 110, 119], [105, 123, 144], [123, 104, 120], [85, 107, 135]
]

async function img(file, i, w = 1600, h = 1067, fmt = 'jpeg') {
  const [r, g, b] = palette[i % palette.length]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x2="0.8" y2="1"><stop stop-color="rgb(${r},${g},${b})"/><stop offset="1" stop-color="rgb(${r + 80},${g + 50},${b + 30})"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${(w * (0.2 + (i % 7) * 0.1)) | 0}" cy="${(h * 0.3) | 0}" r="${(h * 0.15) | 0}" fill="#f7c6a2" opacity="0.7"/>
    <path d="M0 ${h * 0.75} Q ${w * 0.25} ${h * 0.55} ${w * 0.5} ${h * 0.74} T ${w} ${h * 0.68} V ${h} H 0 Z" fill="rgb(${r - 20},${g - 20},${b - 10})" opacity="0.85"/>
    <text x="40" y="${h - 40}" font-family="sans-serif" font-size="${(h * 0.08) | 0}" fill="white" opacity="0.85">#${String(i + 1).padStart(4, '0')}</text>
  </svg>`
  let p = sharp(Buffer.from(svg))
  if (fmt === 'jpeg') p = p.jpeg({ quality: 82 })
  else if (fmt === 'png') p = p.png()
  else if (fmt === 'webp') p = p.webp()
  else if (fmt === 'tiff') p = p.tiff()
  else if (fmt === 'gif') p = p.gif()
  await p.toFile(file)
}

const sub = ['Zeremonie', 'Feier', 'Portraits']
for (const d of sub) fs.mkdirSync(path.join(out, d), { recursive: true })
for (let i = 0; i < n; i++) {
  await img(path.join(out, sub[i % 3], `IMG_${String(i + 1).padStart(4, '0')}.jpg`), i)
}
await img(path.join(out, 'Feier', 'Grafik_01.png'), 3, 1200, 800, 'png')
await img(path.join(out, 'Feier', 'Web_01.webp'), 4, 1200, 800, 'webp')
await img(path.join(out, 'Feier', 'Scan_01.tiff'), 5, 1200, 1600, 'tiff')
await img(path.join(out, 'Feier', 'Anim_01.gif'), 6, 400, 300, 'gif')
// Gleicher Name in anderem Ordner (Kollisionstest) und exaktes Duplikat unter anderem Namen
await img(path.join(out, 'Portraits', 'IMG_0001.jpg'), 99)
fs.copyFileSync(path.join(out, sub[0], 'IMG_0001.jpg'), path.join(out, 'Feier', 'Kopie_von_IMG_0001.jpg'))
// BMP (24 Bit, unkomprimiert) von Hand schreiben
{
  const w = 64, h = 48, row = Math.ceil((w * 3) / 4) * 4, size = 54 + row * h
  const b = Buffer.alloc(size)
  b.write('BM'); b.writeUInt32LE(size, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14)
  b.writeInt32LE(w, 18); b.writeInt32LE(h, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(row * h, 34)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = 54 + y * row + x * 3; b[o] = 200; b[o + 1] = (x * 4) & 255; b[o + 2] = (y * 5) & 255 }
  fs.writeFileSync(path.join(out, 'Feier', 'Bitmap_01.bmp'), b)
}
// RAW ohne einbettete Vorschau / beschädigte Datei
fs.writeFileSync(path.join(out, 'Portraits', 'DSC_0001.NEF'), Buffer.alloc(300_000, 7))
fs.writeFileSync(path.join(out, 'Portraits', 'IMG_9999.CR3'), Buffer.from('kein echtes RAW'))
fs.writeFileSync(path.join(out, 'Feier', 'kaputt.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))
fs.writeFileSync(path.join(out, 'notizen.txt'), 'wird ignoriert')

if (videos && ffmpeg) {
  const v = (file, args) => execFileSync(ffmpeg, ['-y', '-loglevel', 'error', ...args, file])
  v(path.join(out, 'Feier', 'VID_0001.mp4'), ['-f', 'lavfi', '-i', 'testsrc=duration=4:size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'])
  v(path.join(out, 'Feier', 'VID_0002.mov'), ['-f', 'lavfi', '-i', 'testsrc2=duration=3:size=640x360:rate=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'])
  v(path.join(out, 'Feier', 'VID_0003.mkv'), ['-f', 'lavfi', '-i', 'smptebars=duration=3:size=640x360:rate=25', '-c:v', 'mpeg4'])
}
console.log('Testmedien erzeugt in', out)
