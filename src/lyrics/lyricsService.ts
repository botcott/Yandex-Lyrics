/**
 * Единая точка получения лирики для трека.
 *
 * Порядок источников:
 *  1. кэш (IndexedDB);
 *  2. официальная лирика Яндекс Музыки в LRC;
 *  3. официальная лирика Яндекс Музыки простым текстом;
 *  4. LRCLIB — синхронизированный текст;
 *  5. LRCLIB — простой текст.
 *
 * Первый успешный источник побеждает и кладётся в кэш.
 */

import type { PulseSyncTrackMeta } from '@/pulsesync/globals'

import { readCache, writeCache } from './cache'
import { parseLrc, parsePlainText, type ParsedLyrics } from './parseLrc'
import { fetchLrclibLyrics } from './providers/lrclib'
import { fetchYandexLyrics, getAuthToken } from './providers/yandex'

export type LyricsSource = 'yandex' | 'lrclib' | 'cache'

export type LyricsDocument = {
    parsed: ParsedLyrics
    source: LyricsSource
    /** Человекочитаемое название источника для подписи в интерфейсе. */
    sourceLabel: string
    writers: string[]
}

const SOURCE_LABELS: Record<LyricsSource, string> = {
    yandex: 'Яндекс Музыка',
    lrclib: 'LRCLIB',
    cache: 'Кэш',
}

function trackArtists(track: PulseSyncTrackMeta): string {
    return (track.artists ?? [])
        .map(artist => artist.name)
        .filter((name): name is string => Boolean(name))
        .join(', ')
}

function trackAlbum(track: PulseSyncTrackMeta): string {
    const album = track.albums?.[0]
    return album?.title ?? album?.name ?? ''
}

function trackDurationSeconds(track: PulseSyncTrackMeta): number {
    if (typeof track.durationMs === 'number' && track.durationMs > 0) {
        return track.durationMs / 1000
    }

    if (typeof track.duration === 'number' && track.duration > 0) {
        // В мете Яндекс Музыки `duration` — миллисекунды.
        return track.duration > 10_000 ? track.duration / 1000 : track.duration
    }

    return 0
}

/** Заголовок без фич/ремикс-суффиксов — повышает шанс совпадения в LRCLIB. */
function cleanTitle(title: string): string {
    return title
        .replace(/\s*[([][^)\]]*(?:feat|ft|prod|remaster|remastered|live|version)[^)\]]*[)\]]/gi, '')
        .replace(/\s*-\s*(?:remaster(?:ed)?|live|radio edit)\s*$/i, '')
        .trim()
}

export class LyricsService {
    /** Дедупликация: пока грузится один трек, повторные запросы ждут его. */
    private inFlight = new Map<string, Promise<LyricsDocument | null>>()
    /** Быстрый кэш в памяти — чтобы не ходить в IndexedDB на каждый повтор. */
    private memory = new Map<string, LyricsDocument>()

    /** Сбрасывает всё загруженное состояние (при смене настроек или выходе). */
    reset(): void {
        this.inFlight.clear()
        this.memory.clear()
    }

    forget(trackId: string): void {
        this.memory.delete(trackId)
    }

    load(track: PulseSyncTrackMeta): Promise<LyricsDocument | null> {
        const trackId = String(track.id)

        const cached = this.memory.get(trackId)
        if (cached) {
            return Promise.resolve(cached)
        }

        const pending = this.inFlight.get(trackId)
        if (pending) {
            return pending
        }

        const request = this.resolve(track).finally(() => {
            this.inFlight.delete(trackId)
        })

        this.inFlight.set(trackId, request)
        return request
    }

    private async resolve(track: PulseSyncTrackMeta): Promise<LyricsDocument | null> {
        const trackId = String(track.id)

        const stored = await readCache(trackId)
        if (stored) {
            const document = this.buildDocument(stored.text, stored.format, 'cache', stored.writers)
            if (document) {
                this.memory.set(trackId, document)
                return document
            }
        }

        const document = await this.fetchFromProviders(track, trackId)
        if (!document) {
            return null
        }

        this.memory.set(trackId, document)
        return document
    }

    private async fetchFromProviders(track: PulseSyncTrackMeta, trackId: string): Promise<LyricsDocument | null> {
        // 1-2. Официальная лирика Яндекс Музыки.
        if (getAuthToken()) {
            for (const format of ['LRC', 'TEXT'] as const) {
                const result = await this.safe(() => fetchYandexLyrics(trackId, format))
                if (result) {
                    const document = this.buildDocument(result.text, result.format, 'yandex', result.writers, result.provider)
                    if (document) {
                        void writeCache({
                            trackId,
                            text: result.text,
                            format: result.format,
                            source: 'yandex',
                            writers: result.writers,
                        })
                        return document
                    }
                }
            }
        }

        // 3-4. LRCLIB.
        const title = track.title ?? ''
        if (title) {
            const lrclib = await this.safe(() =>
                fetchLrclibLyrics({
                    artist: trackArtists(track),
                    track: cleanTitle(title),
                    album: trackAlbum(track),
                    durationSec: trackDurationSeconds(track),
                })
            )

            if (lrclib && !lrclib.instrumental) {
                if (lrclib.synced) {
                    const document = this.buildDocument(lrclib.synced, 'LRC', 'lrclib', [])
                    if (document) {
                        void writeCache({
                            trackId,
                            text: lrclib.synced,
                            format: 'LRC',
                            source: 'lrclib',
                            writers: [],
                        })
                        return document
                    }
                }

                if (lrclib.plain) {
                    const document = this.buildDocument(lrclib.plain, 'TEXT', 'lrclib', [])
                    if (document) {
                        void writeCache({
                            trackId,
                            text: lrclib.plain,
                            format: 'TEXT',
                            source: 'lrclib',
                            writers: [],
                        })
                        return document
                    }
                }
            }
        }

        return null
    }

    private buildDocument(
        text: string,
        format: string,
        source: LyricsSource,
        writers: string[],
        provider?: string
    ): LyricsDocument | null {
        const parsed = format === 'LRC' ? parseLrc(text) : parsePlainText(text)

        if (parsed.lines.length === 0) {
            return null
        }

        const label = provider ? `${SOURCE_LABELS[source]} · ${provider}` : SOURCE_LABELS[source]

        return { parsed, source, sourceLabel: label, writers }
    }

    /** Провайдеры не должны ронять загрузку трека своими ошибками. */
    private async safe<T>(action: () => Promise<T>): Promise<T | null> {
        try {
            return await action()
        } catch (error) {
            console.debug('[Yandex Lyrics] Источник лирики недоступен:', error)
            return null
        }
    }
}
