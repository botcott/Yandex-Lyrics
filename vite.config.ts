import path from 'node:path'
import { promises as fs, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

import addonConfig from './addon.config.mjs'

const rootDir = path.dirname(fileURLToPath(import.meta.url))
const addonStaticDir = path.resolve(rootDir, 'addon')
const outDir = process.env.PULSESYNC_ADDON_OUT_DIR
    ? path.resolve(process.env.PULSESYNC_ADDON_OUT_DIR)
    : path.resolve(rootDir, 'dist', addonConfig.directoryName)

function sanitizeMetadataValue(value: string | string[] | undefined) {
    if (Array.isArray(value)) {
        return value.map(entry => String(entry).trim()).filter(Boolean)
    }

    return typeof value === 'string' ? value.trim() : ''
}

function createMetadata() {
    return {
        id: addonConfig.id,
        name: addonConfig.name,
        description: addonConfig.description,
        version: addonConfig.version,
        author: sanitizeMetadataValue(addonConfig.author),
        type: addonConfig.type,
        image: addonConfig.image || '',
        banner: addonConfig.banner || '',
        libraryLogo: addonConfig.libraryLogo || '',
        css: 'script.css',
        script: 'script.js',
        tags: Array.isArray(addonConfig.tags) ? addonConfig.tags : [],
        dependencies: Array.isArray(addonConfig.dependencies) ? addonConfig.dependencies : [],
        allowedUrls: Array.isArray(addonConfig.allowedUrls) ? addonConfig.allowedUrls : [],
        supportedVersions: Array.isArray(addonConfig.supportedVersions) ? addonConfig.supportedVersions : [],
    }
}

/**
 * Поля, которые PulseSync дописал в metadata.json установленного аддона
 * (например `installSource`). Без них аддон в клиенте числится «магазинным».
 *
 * Снимок делается на этапе чтения конфига, а не в плагине: Vite очищает
 * выходную папку до сборки, и к моменту `closeBundle` файла уже нет.
 */
function readInstalledMetadata(): Record<string, unknown> {
    try {
        return JSON.parse(readFileSync(path.join(outDir, 'metadata.json'), 'utf8'))
    } catch {
        return {}
    }
}

function packagePulseSyncAddon() {
    const installed = readInstalledMetadata()

    return {
        name: 'package-pulsesync-addon',
        async closeBundle() {
            await fs.mkdir(outDir, { recursive: true })
            await fs.cp(addonStaticDir, outDir, { recursive: true, force: true })

            await fs.writeFile(
                path.join(outDir, 'metadata.json'),
                JSON.stringify({ ...installed, ...createMetadata() }, null, 4) + '\n',
                'utf8'
            )
        },
    }
}

export default defineConfig(() => {
    return {
        resolve: {
            alias: {
                '@': path.resolve(rootDir, 'src'),
            },
        },
        build: {
            assetsDir: 'Assets',
            // Выходная папка — установленный аддон, очищать её можно: там лежат
            // только сборка и статика из `addon/`. Исключение — случай, когда
            // outDir совпал с корнем репозитория: тогда очистка снесла бы
            // исходники.
            emptyOutDir: outDir !== rootDir,
            // Сборка не минифицируется: `script.js` и `script.css` лежат в
            // папке аддона и читаются глазами при отладке в клиенте, а
            // выигрыш от сжатия здесь не стоит превращения их в одну строку.
            minify: false,
            outDir,
            sourcemap: false,
            target: 'chrome140',
            cssCodeSplit: false,
            lib: {
                entry: path.resolve(rootDir, 'src/main.ts'),
                formats: ['iife'],
                name: 'YandexLyricsAddon',
                fileName: () => 'script.js',
                cssFileName: 'script',
            },
            rollupOptions: {
                output: {
                    assetFileNames: assetInfo => {
                        if (assetInfo.names?.some(name => name.endsWith('.css'))) {
                            return '[name][extname]'
                        }

                        return 'Assets/[name][extname]'
                    },
                },
            },
        },
        plugins: [packagePulseSyncAddon()],
    }
})
