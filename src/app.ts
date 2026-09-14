/**
 * Контроллер аддона: связывает настройки, лирику, оверлей и плеер.
 *
 * Жизненный цикл:
 *  1. перехват OAuth-токена клиента;
 *  2. ожидание `pulsesyncApi`;
 *  3. подписка на смену трека и открытие/закрытие оверлея;
 *  4. покадровое обновление караоке, пока оверлей видим.
 */

import addonConfig from '../addon.config.mjs'
import { getApi, getCurrentTrack, whenApiReady, type PulseSyncTrackMeta } from '@/pulsesync/globals'
import { DEFAULT_OPTIONS, getSettingsStore, toOptions, type AddonOptions } from '@/pulsesync/settings'
import { LyricsService, type LyricsDocument } from '@/lyrics/lyricsService'
import { startTokenSniffing } from '@/lyrics/providers/yandex'
import { TimeSource } from '@/player/timeSource'
import { DynamicBackground } from '@/view/background'
import { LyricsView } from '@/view/lyricsView'
import { createControls, type ControlsHandle } from '@/view/controls'
import { createFloatingButton, type FloatingButtonHandle } from '@/view/floatingButton'

/** Как часто опрашиваем состояние, если нет подписки на события. */
const FALLBACK_POLL_MS = 500

/**
 * Первая строка подписи: кто автор текста.
 *
 * Яндекс отдаёт список авторов, LRCLIB — нет, там известен только источник,
 * поэтому для него честнее показать название библиотеки, чем выдумать имя.
 */
function lyricsCreditLine(document: LyricsDocument): string {
    const authors = document.writers.filter(Boolean)
    const who = authors.length > 0 ? authors.join(', ') : document.sourceLabel
    return `Текст: ${who}`
}

export class AddonController {
    private readonly view: LyricsView
    private readonly background: DynamicBackground
    private readonly service = new LyricsService()
    private readonly timeSource = new TimeSource()
    private readonly settingsStore = getSettingsStore()

    private options: AddonOptions = DEFAULT_OPTIONS
    private currentTrackId: string | null = null
    private frameHandle = 0
    private pollHandle = 0
    private unsubscribe: Array<() => void> = []
    private controls: ControlsHandle | null = null
    private floatingButton: FloatingButtonHandle | null = null
    /** Какие настройки кнопки сейчас применены. */
    private floatingButtonEnabled: boolean | null = null

    constructor(host: HTMLElement) {
        this.view = new LyricsView(host, this.toViewOptions(this.options))
        this.background = new DynamicBackground(this.view.background)

        this.view.setSeekHandler(timeMs => {
            getApi()?.setProgress(timeMs / 1000)
            this.timeSource.reset()
        })
    }

    start(): void {
        this.applySettings()

        this.settingsStore.onChange(settings => {
            this.options = toOptions(settings)
            this.applySettings()
        })

        whenApiReady(() => this.bindPlayer())
        this.bindKeyboard()

        this.controls = createControls(this.view.root, {
            onClose: () => this.close(),
            onToggleWordSync: () => this.toggleWordSync(),
            onToggleBlur: () => this.toggleBlur(),
            onShiftOffset: delta => this.shiftOffset(delta),
            onResetSettings: () => this.resetSettings(),
        })
    }

    private toViewOptions(options: AddonOptions) {
        return {
            wordSync: options.wordSync,
            blurInactive: options.blurInactive,
            lineHoverBackground: options.lineHoverBackground,
            offsetMs: options.offsetMs,
            gradientDegrees: options.gradientDegrees,
        }
    }

    private applySettings(): void {
        const { options } = this

        this.view.setOptions(this.toViewOptions(options))
        this.background.setMode(options.backgroundMode)
        this.view.root.style.setProperty('--yl-static-blur', `${options.backgroundBlur}px`)
        this.view.root.dataset.font = options.useSystemFont ? 'system' : 'default'
        this.view.root.dataset.controlsPosition = options.controlsPosition
        this.controls?.sync({
            wordSync: options.wordSync,
            blurInactive: options.blurInactive,
            offsetMs: options.offsetMs,
        })
        this.applyAccent()

        if (!options.enabled) {
            this.close()
        }

        // Кнопку создаём и убираем только при смене самой настройки: она
        // держит обработчики перетаскивания, пересоздавать её на каждый
        // пересчёт настроек незачем.
        if (options.showFloatingButton !== this.floatingButtonEnabled) {
            this.floatingButtonEnabled = options.showFloatingButton
            this.floatingButton?.dispose()
            this.floatingButton = options.showFloatingButton ? createFloatingButton(() => this.toggle()) : null
            this.syncFloatingButtonVisibility()
        }
    }

    /** Пока оверлей открыт, плавающая кнопка лишняя — закрывать есть чем внутри. */
    private syncFloatingButtonVisibility(): void {
        this.floatingButton?.setVisible(!this.view.isVisible)
    }

    private bindKeyboard(): void {
        const handler = (event: KeyboardEvent) => {
            // В полях ввода хоткей не перехватываем.
            const target = event.target as HTMLElement | null
            if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
                return
            }

            if (event.code !== this.options.hotkey) {
                return
            }

            if (event.ctrlKey || event.metaKey || event.altKey) {
                return
            }

            event.preventDefault()
            this.toggle()
        }

        window.addEventListener('keydown', handler, true)
        this.unsubscribe.push(() => window.removeEventListener('keydown', handler, true))

        const escape = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && this.view.isVisible) {
                event.stopPropagation()
                this.close()
            }
        }

        window.addEventListener('keydown', escape, true)
        this.unsubscribe.push(() => window.removeEventListener('keydown', escape, true))
    }

    /** Подписка на события плеера с запасным опросом. */
    private bindPlayer(): void {
        const api = getApi()
        if (!api) {
            return
        }

        if (typeof api.onCurrentTrackChange === 'function') {
            const unsubscribe = api.onCurrentTrackChange(track => this.handleTrackChange(track))
            if (typeof unsubscribe === 'function') {
                this.unsubscribe.push(unsubscribe)
            }
        } else {
            this.pollHandle = window.setInterval(() => {
                const track = getCurrentTrack()
                if (String(track?.id ?? '') !== String(this.currentTrackId ?? '')) {
                    this.handleTrackChange(track ?? null)
                }
            }, FALLBACK_POLL_MS)
        }

        this.handleTrackChange(getCurrentTrack() ?? null)
    }

    private async handleTrackChange(track: PulseSyncTrackMeta | null): Promise<void> {
        const trackId = track ? String(track.id) : null

        if (trackId === this.currentTrackId) {
            return
        }

        this.currentTrackId = trackId
        this.timeSource.reset()

        if (!track) {
            this.view.showNotice('Ничего не играет', 'Включите трек, чтобы увидеть текст.')
            return
        }

        const title = [track.title, track.version].filter(Boolean).join(' ')
        this.view.setTrack(title, this.artistLine(track))

        const coverUri = typeof track.coverUri === 'string' ? track.coverUri : null
        void this.background.setCover(coverUri).then(() => this.applyAccent())

        this.view.showNotice('Загрузка текста…')

        const document = await this.service.load(track)

        // Пока грузили, трек мог смениться.
        if (String(this.currentTrackId) !== trackId) {
            return
        }

        if (!document) {
            this.view.showNotice('Текст не найден', 'Для этого трека нет ни синхронизированного, ни простого текста.')
            return
        }

        this.view.clearNotice()
        this.view.setLyrics(document.parsed)
        this.view.setCredits(lyricsCreditLine(document), `Расширение: ${addonConfig.author}`)
    }

    private artistLine(track: PulseSyncTrackMeta): string {
        return (track.artists ?? [])
            .map(artist => artist.name)
            .filter(Boolean)
            .join(', ')
    }

    /**
     * Красит подсветку текста в цвет обложки.
     *
     * Если обложки нет, canvas недоступен или фон выключен — возвращаемся к
     * белому из темы.
     */
    private applyAccent(): void {
        const accent = this.options.backgroundMode === 'off' ? null : this.background.getAccentColor()

        if (accent) {
            this.view.root.style.setProperty('--yl-highlight', accent)
        } else {
            this.view.root.style.removeProperty('--yl-highlight')
        }
    }

    /* ───────────────────────── Видимость ───────────────────────── */

    toggle(): void {
        if (this.view.isVisible) {
            this.close()
        } else {
            this.open()
        }
    }

    open(): void {
        if (!this.options.enabled) {
            return
        }

        this.view.setVisible(true)
        this.view.root.dataset.playing = String(this.timeSource.isPlaying())
        this.syncFloatingButtonVisibility()

        if (this.currentTrackId == null) {
            void this.handleTrackChange(getCurrentTrack() ?? null)
        }

        this.startFrameLoop()
    }

    close(): void {
        this.view.setVisible(false)
        this.syncFloatingButtonVisibility()
        this.stopFrameLoop()
    }

    /* ───────────────────────── Кадровый цикл ───────────────────────── */

    private startFrameLoop(): void {
        if (this.frameHandle) {
            return
        }

        const tick = () => {
            if (!this.view.isVisible) {
                this.frameHandle = 0
                return
            }

            const playing = this.timeSource.isPlaying()
            this.view.root.dataset.playing = String(playing)
            this.view.render(this.timeSource.getTimeMs())

            this.frameHandle = requestAnimationFrame(tick)
        }

        this.frameHandle = requestAnimationFrame(tick)
    }

    private stopFrameLoop(): void {
        if (this.frameHandle) {
            cancelAnimationFrame(this.frameHandle)
            this.frameHandle = 0
        }
    }

    /* ───────────────────────── Действия ───────────────────────── */

    // Стор настроек доступен только на чтение, поэтому переключатели в оверлее
    // действуют до конца сессии и сбрасываются при изменении настроек в панели.

    private syncControls(): void {
        this.controls?.sync({
            wordSync: this.options.wordSync,
            blurInactive: this.options.blurInactive,
            offsetMs: this.options.offsetMs,
        })
    }

    private toggleWordSync(): void {
        this.options = { ...this.options, wordSync: !this.options.wordSync }
        this.view.setOptions(this.toViewOptions(this.options))
        this.syncControls()
    }

    private toggleBlur(): void {
        this.options = { ...this.options, blurInactive: !this.options.blurInactive }
        this.view.setOptions(this.toViewOptions(this.options))
        this.syncControls()
    }

    private shiftOffset(deltaMs: number): void {
        const offsetMs = Math.max(-5000, Math.min(5000, this.options.offsetMs + deltaMs))
        this.options = { ...this.options, offsetMs }
        this.view.setOptions(this.toViewOptions(this.options))
        this.syncControls()
    }

    /**
     * Возвращает настройки к значениям из панели PulseSync.
     *
     * Стор настроек только на чтение, поэтому «сброс» — это отказ от правок,
     * сделанных кнопками оверлея в этой сессии, а не запись значений в стор.
     */
    private resetSettings(): void {
        this.options = toOptions(this.settingsStore.getCurrent())
        this.applySettings()
    }

    destroy(): void {
        this.stopFrameLoop()
        window.clearInterval(this.pollHandle)
        for (const unsubscribe of this.unsubscribe) {
            unsubscribe()
        }
        this.unsubscribe = []

        this.controls?.dispose()
        this.floatingButton?.dispose()
        this.background.destroy()
        this.view.destroy()
    }
}

export function startAddon(host: HTMLElement): AddonController {
    startTokenSniffing()

    const controller = new AddonController(host)
    controller.start()

    return controller
}
