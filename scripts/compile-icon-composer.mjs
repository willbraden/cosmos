#!/usr/bin/env node
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const root = resolve(new URL('..', import.meta.url).pathname)
const sourceIcon = join(root, 'build/icon.icon')
const outputIcns = join(root, 'build/icon.icns')
const outputAssetsCar = join(root, 'build/Assets.car')
const outputPng = join(root, 'build/icon.png')

if (!existsSync(sourceIcon)) {
  console.error(`Missing Icon Composer bundle: ${sourceIcon}`)
  process.exit(1)
}

const workDir = mkdtempSync(join(tmpdir(), 'cosmos-icon-'))
const compileInput = join(workDir, 'Icon.icon')
const compileOutput = join(workDir, 'out')

try {
  cpSync(sourceIcon, compileInput, { recursive: true })
  mkdirSync(compileOutput, { recursive: true })

  const args = [
    compileInput,
    '--compile',
    compileOutput,
    '--output-format',
    'human-readable-text',
    '--notices',
    '--warnings',
    '--output-partial-info-plist',
    join(compileOutput, 'assetcatalog_generated_info.plist'),
    '--app-icon',
    'Icon',
    '--include-all-app-icons',
    '--accent-color',
    'AccentColor',
    '--enable-on-demand-resources',
    'NO',
    '--development-region',
    'en',
    '--target-device',
    'mac',
    '--minimum-deployment-target',
    '26.0',
    '--platform',
    'macosx'
  ]

  const result = spawnSync('actool', args, { encoding: 'utf8' })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }

  writeFileSync(outputIcns, readFileSync(join(compileOutput, 'Icon.icns')))

  const assetsCarPath = join(compileOutput, 'Assets.car')
  if (existsSync(assetsCarPath)) {
    writeFileSync(outputAssetsCar, readFileSync(assetsCarPath))
  }

  console.log(`Wrote ${outputIcns}`)
  if (existsSync(assetsCarPath)) {
    console.log(`Wrote ${outputAssetsCar}`)
  }

  // The Dock icon used in development comes from a plain PNG, so derive it from
  // the compiled icns. actool lays the artwork out on Apple's icon grid (an 824pt
  // tile inside a 1024pt canvas, plus the system shadow); rendering the PNG
  // separately would approximate that squircle with a border radius and come out
  // visibly smaller than every other icon in the Dock.
  // 512 is the largest representation actool emits here, so asking for more only
  // upscales; the Dock never draws larger than this anyway.
  const sips = spawnSync('sips', ['-s', 'format', 'png', '-Z', '512', outputIcns, '--out', outputPng], { encoding: 'utf8' })
  if (sips.status !== 0) {
    if (sips.stderr) process.stderr.write(sips.stderr)
    process.exit(sips.status ?? 1)
  }
  console.log(`Wrote ${outputPng}`)
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
