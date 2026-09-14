/**
 * Запасной источник лирики — LRCLIB.
 *
 * Открытый сервис без авторизации, отдаёт синхронизированный LRC. Используется,
 * когда у трека нет официального текста в Яндекс Музыке или токен ещё не пойман.
 *
 * Документация: https://lrclib.net/docs
 */

const API_BASE = 'https://lrclib.net/api'

/** Допустимое расхождение длительности при поиске, секунды. */
const DURATION_TOLERANCE = 4
/** Задержка перед повтором после 429, мс. */
const RATE_LIMIT_BACKOFF_MS = 2_000

export type LrclibLyrics = {
    /** Синхронизированный LRC, если он есть у записи. */
    synced: string | null
    /** Простой текст без таймингов. */
    plain: string | null
    /** Название записи в базе — для отладки и подписи источника. */
    trackName: string
    artistName: string
    instrumental: boolean
}

type LrclibRecord = {
    id?: number
    trackName?: string
    artistName?: string
    albumName?: string
    duration?: number
    instrumental?: boolean
    plainLyrics?: string | null
    syncedLyrics?: string | null
}

function toResult(record: LrclibRecord): LrclibLyrics {
    return {
        synced: record.syncedLyrics?.trim() ? record.syncedLyrics : null,
        plain: record.plainLyrics?.trim() ? record.plainLyrics : null,
        trackName: record.trackName ?? '',
        artistName: record.artistName ?? '',
        instrumental: Boolean(record.instrumental),
    }
}

async function requestJson<T>(url: string, attempt = 0): Promise<T | null> {
    const response = await fetch(url, { headers: { Accept: 'application/json' } })

    if (response.status === 404) {
        return null
    }

    if (response.status === 429 && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_BACKOFF_MS * (attempt + 1)))
        return requestJson<T>(url, attempt + 1)
    }

    if (!response.ok) {
        return null
    }

    return (await response.json()) as T
}

/**
 * Точный поиск: `/api/get` требует совпадения названия, исполнителя и
 * альбома, поэтому сначала пробуем его — он даёт самый релевантный результат.
 */
async function getExact(artist: string, track: string, album: string, durationSec: number): Promise<LrclibLyrics | null> {
    const params = new URLSearchParams({
        artist_name: artist,
        track_name: track,
    })

    if (album) {
        params.set('album_name', album)
    }
    if (durationSec > 0) {
        params.set('duration', String(Math.round(durationSec)))
    }

    const record = await requestJson<LrclibRecord>(`${API_BASE}/get?${params.toString()}`)
    return record ? toResult(record) : null
}

/**
 * Поиск по названию и исполнителю с выбором ближайшего по длительности.
 *
 * `/api/search` возвращает несколько вариантов, среди которых бывают каверы и
 * ремиксы. Длительность — самый надёжный признак: у каверов она отличается.
 */
async function searchBestMatch(
    artist: string,
    track: string,
    durationSec: number
): Promise<LrclibLyrics | null> {
    const params = new URLSearchParams({
        artist_name: artist,
        track_name: track,
    })

    const records = await requestJson<LrclibRecord[]>(`${API_BASE}/search?${params.toString()}`)
    if (!Array.isArray(records) || records.length === 0) {
        return null
    }

    const withLyrics = records.filter(record => record.syncedLyrics?.trim() || record.plainLyrics?.trim())
    if (withLyrics.length === 0) {
        return null
    }

    if (durationSec > 0) {
        const close = withLyrics.filter(
            record => typeof record.duration === 'number' && Math.abs(record.duration - durationSec) <= DURATION_TOLERANCE
        )
        if (close.length > 0) {
            // Среди близких по длительности предпочитаем синхронизированный текст.
            const synced = close.find(record => record.syncedLyrics?.trim())
            return toResult(synced ?? close[0])
        }
    }

    return toResult(withLyrics.find(record => record.syncedLyrics?.trim()) ?? withLyrics[0])
}

export type LrclibQuery = {
    artist: string
    track: string
    album?: string
    /** Длительность трека в секундах. */
    durationSec?: number
}

export async function fetchLrclibLyrics(query: LrclibQuery): Promise<LrclibLyrics | null> {
    const artist = query.artist.trim()
    const track = query.track.trim()

    if (!artist || !track) {
        return null
    }

    const durationSec = query.durationSec ?? 0

    const exact = await getExact(artist, track, query.album?.trim() ?? '', durationSec)
    if (exact && (exact.synced || exact.plain)) {
        return exact
    }

    return searchBestMatch(artist, track, durationSec)
}
