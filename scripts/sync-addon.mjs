import path from 'node:path'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'

import addonConfig from '../addon.config.mjs'
import { getPulseSyncAddonDir, getPulseSyncAddonsDir } from './pulsesync-paths.mjs'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = path.join(rootDir, 'dist', addonConfig.directoryName)

/**
 * Поля, которые PulseSync дописал в metadata.json установленного аддона
 * (например `installSource`). Папка пересоздаётся с нуля, поэтому снимок нужно
 * снять заранее — иначе аддон в клиенте станет «магазинным».
 */
async function readInstalledMetadata(targetDir) {
    return fs
        .readFile(path.join(targetDir, 'metadata.json'), 'utf8')
        .then(JSON.parse)
        .catch(() => ({}))
}

async function main() {
    const targetRoot = getPulseSyncAddonsDir()
    const targetDir = getPulseSyncAddonDir()

    await fs.access(sourceDir)

    const installed = await readInstalledMetadata(targetDir)

    await fs.mkdir(targetRoot, { recursive: true })
    await fs.rm(targetDir, { recursive: true, force: true })
    await fs.cp(sourceDir, targetDir, { recursive: true, force: true })

    if (Object.keys(installed).length > 0) {
        const metadataPath = path.join(targetDir, 'metadata.json')
        const fresh = await fs.readFile(metadataPath, 'utf8').then(JSON.parse)
        await fs.writeFile(metadataPath, JSON.stringify({ ...installed, ...fresh }, null, 4) + '\n', 'utf8')
    }

    console.log(`Synced addon to ${targetDir}`)
}

main().catch(error => {
    console.error('Failed to sync addon:', error)
    process.exitCode = 1
})
