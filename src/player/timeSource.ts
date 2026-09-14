/**
 * Источник времени воспроизведения для синхронизации лирики.
 *
 * Приоритет источников:
 *  1. `HTMLAudioElement.currentTime` текущего медиаплеера — самая точная и
 *     плавная шкала (обновляется браузером, а не опросом React-состояния).
 *  2. `sonataState.playerState.progress` — состояние плеера Яндекс Музыки.
 *  3. `pulsesyncApi.getProgress()` — публичный API PulseSync.
 *
 * Позиция из стора приходит «ступеньками» (раз в ~250мс), поэтому между
 * обновлениями она экстраполируется по `performance.now()`, а при расхождении
 * с реальным значением — плавно подтягивается.
 */

import { getSonataState, getApi } from '@/pulsesync/globals'

/** Максимальное расхождение, при котором позиция подтягивается мгновенно, мс. */
const HARD_RESYNC_MS = 700
/** Доля расхождения, которая убирается за один кадр при мягкой синхронизации. */
const SOFT_RESYNC_FACTOR = 0.12
/** Как часто перечитывать позицию из стора, мс. */
const STORE_POLL_MS = 100
/** Как часто можно сканировать DOM в поисках `<audio>`, мс. */
const AUDIO_SCAN_INTERVAL_MS = 1_000

type ProgressLike = number | { position?: number; duration?: number } | null | undefined

function readProgressNumber(progress: ProgressLike): number | null {
    if (typeof progress === 'number' && Number.isFinite(progress)) {
        return progress
    }

    if (progress && typeof progress === 'object' && typeof progress.position === 'number') {
        return Number.isFinite(progress.position) ? progress.position : null
    }

    return null
}

/** Достаёт `currentTime` текущего аудиоэлемента, если он доступен. */
let cachedAudio: HTMLAudioElement | null = null
let lastAudioScanAt = 0

function readAudioElement(): HTMLAudioElement | null {
    if (cachedAudio && cachedAudio.isConnected) {
        return cachedAudio
    }

    cachedAudio = null

    const state = getSonataState()
    const player = state?.currentMediaPlayer?.value

    const candidates = [player?.currentAudioElement?.value, player?.currentAudioElement]

    for (const candidate of candidates) {
        if (candidate instanceof HTMLAudioElement) {
            cachedAudio = candidate
            return cachedAudio
        }
    }

    // Фолбэк: играющий <audio> на странице. Ищем редко — обход DOM не бесплатный.
    const now = performance.now()
    if (now - lastAudioScanAt < AUDIO_SCAN_INTERVAL_MS) {
        return null
    }
    lastAudioScanAt = now

    for (const element of document.querySelectorAll('audio')) {
        if (element instanceof HTMLAudioElement) {
            cachedAudio = element
            return cachedAudio
        }
    }

    return null
}

/** Позиция из состояния плеера, секунды. */
function readStorePosition(): number | null {
    const state = getSonataState()

    const fromPlayerState = readProgressNumber(state?.playerState?.progress?.value as ProgressLike)
    if (fromPlayerState != null) {
        return fromPlayerState
    }

    const fromApi = readProgressNumber(getApi()?.getProgress() as ProgressLike)
    if (fromApi != null) {
        return fromApi
    }

    return null
}

export class TimeSource {
    private lastStorePosition: number | null = null
    private lastStoreReadAt = 0
    private lastAudioReadAt = 0
    private smoothed: number | null = null

    /** Текущая позиция в миллисекундах. */
    getTimeMs(): number {
        const now = performance.now()
        const playing = this.isPlaying()
        const audio = readAudioElement()

        if (audio && Number.isFinite(audio.currentTime) && !audio.seeking) {
            const seconds = audio.currentTime

            this.lastAudioReadAt = now
            this.smoothed = seconds * 1000
            return this.smoothed
        }

        if (now - this.lastStoreReadAt >= STORE_POLL_MS || this.lastStorePosition == null) {
            const storePosition = readStorePosition()

            if (storePosition != null) {
                if (this.lastStorePosition == null) {
                    this.smoothed = storePosition * 1000
                } else if (playing) {
                    const driftMs = storePosition * 1000 - (this.smoothed ?? storePosition * 1000)

                    if (Math.abs(driftMs) > HARD_RESYNC_MS) {
                        this.smoothed = storePosition * 1000
                    } else {
                        this.smoothed = (this.smoothed ?? storePosition * 1000) + driftMs * SOFT_RESYNC_FACTOR
                    }
                } else {
                    this.smoothed = storePosition * 1000
                }

                this.lastStorePosition = storePosition
                this.lastStoreReadAt = now
            }
        }

        if (this.smoothed == null) {
            return 0
        }

        if (!playing) {
            return this.smoothed
        }

        // Между обновлениями стора позиция движется линейно.
        const elapsed = now - Math.max(this.lastStoreReadAt, this.lastAudioReadAt)
        return this.smoothed + elapsed
    }

    isPlaying(): boolean {
        const audio = readAudioElement()
        if (audio) {
            return !audio.paused && !audio.ended
        }

        const api = getApi()
        if (api && typeof api.isPlaying === 'function') {
            return Boolean(api.isPlaying())
        }

        const status = getSonataState()?.playerState?.status?.value
        return status === 'playing'
    }

    /** Сбрасывает накопленное состояние — вызывать при смене трека или seek. */
    reset(): void {
        this.lastStorePosition = null
        this.lastStoreReadAt = 0
        this.lastAudioReadAt = 0
        this.smoothed = null
    }
}
