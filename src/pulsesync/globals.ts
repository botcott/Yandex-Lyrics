/**
 * Типизированный доступ к глобалам, которые PulseSync и Яндекс Музыка
 * выставляют в `window`.
 *
 * Все обращения идут через этот модуль, чтобы:
 *  - не разбрасывать по коду `window as any`;
 *  - иметь одно место с проверками на случай, если клиент ещё не поднял
 *    нужный объект (аддон стартует раньше приложения).
 */

import type { PulseSyncApi, PulseSyncTrackMeta, SonataState } from '@pulsesync/yamusic-types'

export type { PulseSyncApi, PulseSyncTrackMeta, SonataState }

export function getApi(): PulseSyncApi | undefined {
    return window.pulsesyncApi
}

export function getSonataState(): SonataState | undefined {
    return window.sonataState
}

/**
 * Текущий трек по данным PulseSync.
 *
 * `getCurrentTrack()` отдаёт нормализованную мету (id, title, artists,
 * durationMs, coverUri), поэтому он удобнее, чем разбор `sonataState`.
 */
export function getCurrentTrack(): PulseSyncTrackMeta | undefined {
    const track = getApi()?.getCurrentTrack()
    if (track) {
        return track
    }

    return readTrackFromSonata()
}

/** Запасной путь: достаём мету прямо из очереди Яндекс Музыки. */
function readTrackFromSonata(): PulseSyncTrackMeta | undefined {
    const state = getSonataState()
    const entity = state?.queueState?.currentEntity?.value

    const meta = entity?.entity?.entityData?.meta ?? entity?.entity?.data?.meta
    if (!meta?.id) {
        return undefined
    }

    return meta
}

/**
 * Ждёт появления `pulsesyncApi`, затем вызывает колбэк.
 *
 * Аддон может загрузиться раньше WebHost-моста, поэтому просто читать
 * `window.pulsesyncApi` на старте недостаточно.
 */
export function whenApiReady(callback: (api: PulseSyncApi) => void, timeoutMs = 15_000): () => void {
    const existing = getApi()
    if (existing) {
        callback(existing)
        return () => {}
    }

    const startedAt = Date.now()
    const timer = window.setInterval(() => {
        const api = getApi()

        if (api) {
            window.clearInterval(timer)
            callback(api)
            return
        }

        if (Date.now() - startedAt > timeoutMs) {
            window.clearInterval(timer)
            console.warn('[Yandex Lyrics] pulsesyncApi не появился за отведённое время')
        }
    }, 100)

    return () => window.clearInterval(timer)
}
