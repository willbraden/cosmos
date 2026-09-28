#!/usr/bin/env node
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const root = resolve(new URL('..', import.meta.url).pathname)
const sourceIcon = join(root, 'build/icon.icon')
const outputIcns = join(root, 'build/icon.icns')
const outputAssetsCar = join(root, 'build/Assets.car')

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
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
