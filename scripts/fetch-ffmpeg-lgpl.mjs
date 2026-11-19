// Lädt einen LGPL-Build von FFmpeg (gemeinsam genutzte Bibliotheken, ohne GPL-Komponenten) nach vendor/ffmpeg/.
// Quelle: BtbN/FFmpeg-Builds. Für reproduzierbare Builds eine feste URL über FFMPEG_LGPL_URL setzen
// (z. B. ein datiertes „autobuild-…“-Release); die SHA-256 der Datei wird in vendor/ffmpeg/<ziel>/MANIFEST.json protokolliert.
// Aufruf: node scripts/fetch-ffmpeg-lgpl.mjs [win32-x64|linux-x64] [--force]
import { execFileSync, execSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const target = process.argv.find((a) => /^(win32|linux)-x64$/.test(a)) ?? `${process.platform}-${process.arch}`
const assets = {
  'win32-x64': 'ffmpeg-master-latest-win64-lgpl-shared.zip',
  'linux-x64': 'ffmpeg-master-latest-linux64-lgpl-shared.tar.xz'
}
if (!assets[target]) throw new Error('Nicht unterstütztes Ziel: ' + target)
const url = process.env.FFMPEG_LGPL_URL ?? `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${assets[target]}`
const root = path.resolve(import.meta.dirname, '..')
const dest = path.join(root, 'vendor', 'ffmpeg', target)
if (fs.existsSync(path.join(dest, 'MANIFEST.json')) && !process.argv.includes('--force')) {
  console.log('✓ bereits vorhanden:', dest)
  process.exit(0)
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ppm-ffmpeg-'))
const archive = path.join(work, path.basename(new URL(url).pathname))
console.log('Lade', url)
execFileSync('curl', ['-fsSL', '--retry', '3', '-o', archive, url], { stdio: 'inherit' })
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
if (archive.endsWith('.zip')) {
  if (process.platform === 'win32') execFileSync('tar', ['-xf', archive, '-C', work])
  else execFileSync('unzip', ['-q', archive, '-d', work])
} else execFileSync('tar', ['-xJf', archive, '-C', work])
const top = fs.readdirSync(work).find((d) => d.startsWith('ffmpeg-') && fs.statSync(path.join(work, d)).isDirectory())
if (!top) throw new Error('Unerwarteter Archivaufbau.')
const lic = fs.readFileSync(path.join(work, top, 'LICENSE.txt'), 'utf8')
if (!/LESSER GENERAL PUBLIC LICENSE/i.test(lic)) throw new Error('Archiv ist kein LGPL-Build – Abbruch.')
fs.rmSync(dest, { recursive: true, force: true })
fs.mkdirSync(dest, { recursive: true })
for (const sub of ['bin', 'lib']) {
  const from = path.join(work, top, sub)
  if (!fs.existsSync(from)) continue
  fs.cpSync(from, path.join(dest, sub), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (f) => !/ffplay/i.test(path.basename(f)) && !/\.(a|pc|la|def|lib)$/i.test(f) && !f.includes(`${path.sep}pkgconfig`)
  })
}
fs.copyFileSync(path.join(work, top, 'LICENSE.txt'), path.join(dest, 'LICENSE.txt'))
let version = null
if (target === `${process.platform}-${process.arch}`) {
  const exe = path.join(dest, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  version = execSync(`"${exe}" -hide_banner -version`).toString()
  if (/--enable-gpl/.test(version)) throw new Error('Build enthält GPL-Komponenten – Abbruch.')
  version = version.split('\n')[0]
}
fs.writeFileSync(path.join(dest, 'MANIFEST.json'), JSON.stringify({ url, sha256, fetchedAt: new Date().toISOString(), version, license: 'LGPL-2.1-or-later' }, null, 2))
fs.rmSync(work, { recursive: true, force: true })
console.log('✓ LGPL-FFmpeg in', dest, version ?? '')
