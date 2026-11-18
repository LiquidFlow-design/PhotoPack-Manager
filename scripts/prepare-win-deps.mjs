// Lädt die Windows-x64-Binärdateien für einen Cross-Build von Linux/macOS aus,
// ohne die lokalen (Linux-)Abhängigkeiten zu verändern. Auf Windows ist dieser Schritt unnötig.
import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const nm = path.join(root, 'node_modules')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function packInto(spec, targetDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppm-pack-'))
  const file = execFileSync(npm, ['pack', spec, '--silent'], { cwd: tmp }).toString().trim().split('\n').pop()
  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.mkdirSync(targetDir, { recursive: true })
  execSync(`tar -xzf "${path.join(tmp, file)}" -C "${targetDir}" --strip-components=1`)
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('✓', spec)
}

const sharpPkg = JSON.parse(fs.readFileSync(path.join(nm, 'sharp/package.json'), 'utf8'))
for (const dep of ['@img/sharp-win32-x64']) {
  const v = sharpPkg.optionalDependencies[dep]
  packInto(`${dep}@${v}`, path.join(nm, dep))
}
const etPkg = JSON.parse(fs.readFileSync(path.join(nm, 'exiftool-vendored/package.json'), 'utf8'))
packInto(`exiftool-vendored.exe@${etPkg.optionalDependencies['exiftool-vendored.exe']}`, path.join(nm, 'exiftool-vendored.exe'))

if (!fs.existsSync(path.join(nm, 'ffmpeg-static/ffmpeg.exe'))) {
  execFileSync(process.execPath, [path.join(nm, 'ffmpeg-static/install.js')], {
    cwd: path.join(nm, 'ffmpeg-static'),
    env: { ...process.env, npm_config_platform: 'win32', npm_config_arch: 'x64' },
    stdio: 'inherit'
  })
}
console.log('✓ ffmpeg.exe')
if (!fs.existsSync(path.join(nm, 'ffprobe-static/bin/win32/x64/ffprobe.exe'))) throw new Error('ffprobe.exe fehlt')
console.log('✓ ffprobe.exe')
