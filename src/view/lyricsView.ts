/**
 * Рендер полноэкранного слоя лирики и покадровое обновление караоке.
 *
 * Строки строятся один раз при смене трека, дальше каждый кадр меняются только
 * CSS-переменные и классы. Запись в DOM кэшируется: без этого запись
 * `--yl-gradient-position` в сотни слов подряд роняет кадры.
 *
 * Скролл реализован трансформацией контейнера, а не нативным `scrollTop`:
 * так позиция строки задаётся точно (центрирование первой и последней строки
 * без хаков) и не конфликтует с анимацией.
 */

import type { LyricsLine, ParsedLyrics } from '@/lyrics/parseLrc'
import { findActiveLineIndex, getLineProgress } from '@/lyrics/parseLrc'

/** Сила размытия неактивных строк на единицу удаления от активной. */
const BLUR_MULTIPLIER = 1.25
/** Удаление, после которого размытие перестаёт расти. */
const BLUR_MAX_DISTANCE = 5
/** Сколько строк по обе стороны обновляем каждый кадр. */
const ACTIVE_WINDOW = 12
/** Сколько строк вокруг активной считаем пословный прогресс. */
const WORD_WINDOW = 2
/** Сдвиг активной строки вниз от центра, px. */
const CENTER_BIAS_PX = 30
/** Пауза после ручного скролла, прежде чем вернуться к автопрокрутке, мс. */
const USER_SCROLL_IDLE_MS = 3_500
/**
 * Позиция градиента для уже спетого фрагмента.
 *
 * Градиент состоит из трёх зон: спетое, яркий край и ещё не спетое. Значение
 * выше 100% уводит обе границы за пределы блока, поэтому спетый фрагмент
 * окрашивается в один ровный цвет — держать яркий край на последней букве
 * закончившегося слова незачем.
 */
const SCROLL_TRANSITION = '0.85s cubic-bezier(0.22, 1, 0.36, 1)'

export type LyricsViewOptions = {
    /**
     * Пословная подсветка.
     *
     * `true` — слова загораются по очереди, по мере пения.
     * `false` — строка загорается целиком, когда становится активной.
     */
    wordSync: boolean
    /** Размывать ли неактивные строки. */
    blurInactive: boolean
    /** Плашка под строкой при наведении. */
    lineHoverBackground: boolean
    /** Сдвиг синхронизации, мс. */
    offsetMs: number
    /** Направление градиента караоке, градусы. */
    gradientDegrees: number
}

/** Кусок строки, который подсвечивается отдельно. */
type Segment = {
    text: string
    /** Длина в символах, минимум 1 — по ней раскладывается прогресс строки. */
    length: number
}

/**
 * Режет строку на куски, каждый со своим градиентом.
 *
 * Разбивать нужно всегда, даже когда у строки нет word-таймингов: градиент,
 * растянутый на весь блок, при переносе текста подсвечивает вертикальную
 * полосу сразу во всех визуальных строках, а не буквы по порядку.
 */
function lineSegments(line: LyricsLine): Segment[] {
    if (line.words.length > 0) {
        return line.words.map(word => {
            const length = Math.max(word.text.length, 1)
            return { text: word.text, length }
        })
    }

    // Пробелы остаются прицеплены к предыдущему слову — так градиент едет
    // без разрывов, а перенос по-прежнему работает.
    const matches = line.text.match(/\S+\s*/g)

    if (!matches || matches.length === 0) {
        return [{ text: line.text, length: Math.max(line.text.length, 1) }]
    }

    return matches.map(text => ({ text, length: text.length }))
}

type LineEntry = {
    line: LyricsLine
    element: HTMLElement
    wordElements: HTMLElement[]
    /** Длины кусков в символах. */
    segmentLengths: number[]
    /** Сумма длин — на неё умножается прогресс строки. */
    totalChars: number
    /** Последние записанные значения — чтобы не трогать DOM впустую. */
    cacheClass: string
    cacheBlur: string
    cacheWordState: string[]
}

export class LyricsView {
    readonly root: HTMLDivElement

    private readonly linesContainer: HTMLDivElement
    private readonly scrollContainer: HTMLDivElement
    private readonly backgroundLayer: HTMLDivElement
    private readonly noticeElement: HTMLDivElement
    private readonly creditsElement: HTMLDivElement
    private readonly creditsLyrics: HTMLDivElement
    private readonly creditsAddon: HTMLDivElement
    private readonly headerElement: HTMLDivElement
    private readonly headerTitle: HTMLDivElement
    private readonly headerSubtitle: HTMLDivElement

    private entries: LineEntry[] = []
    private lines: LyricsLine[] = []
    private activeIndex = -1
    private options: LyricsViewOptions
    /** Есть ли у текущей лирики тайминги (иначе показываем простой текст). */
    private synced = true

    /** Текущее смещение контейнера строк, px (положительное — вниз). */
    private scrollOffset = 0
    /** Смещение, добавленное ручным скроллом пользователя. */
    private manualOffset = 0
    private userScrolling = false
    private scrollIdleTimer = 0

    /**
     * Строки, у которых сейчас проставлены пословные классы.
     *
     * Состояние слов пишется только у строк рядом с активной: держать его у всех
     * было бы дорого. Поэтому нужен список «кого мы тронули», чтобы погасить
     * ровно эти строки, когда активная уехала дальше.
     */
    private wordWindow: { from: number; to: number } | null = null

    private onSeek?: (timeMs: number) => void

    constructor(host: HTMLElement, options: LyricsViewOptions) {
        this.options = options

        this.root = document.createElement('div')
        this.root.id = 'yl-overlay'
        this.root.hidden = true

        this.backgroundLayer = this.buildBackground()
        const stage = document.createElement('div')
        stage.className = 'yl-stage'

        this.scrollContainer = document.createElement('div')
        this.scrollContainer.className = 'yl-scroll'

        this.linesContainer = document.createElement('div')
        this.linesContainer.className = 'yl-lines'
        this.linesContainer.style.transition = `transform ${SCROLL_TRANSITION}`

        this.scrollContainer.appendChild(this.linesContainer)
        stage.appendChild(this.scrollContainer)

        // Подпись под последней строкой: кто сделал текст и кто — аддон.
        // Живёт внутри прокручиваемого списка, поэтому до неё можно доскроллить.
        this.creditsElement = document.createElement('div')
        this.creditsElement.className = 'yl-credits'
        this.creditsLyrics = document.createElement('div')
        this.creditsLyrics.className = 'yl-credits-line'
        this.creditsAddon = document.createElement('div')
        this.creditsAddon.className = 'yl-credits-line'
        this.creditsElement.append(this.creditsLyrics, this.creditsAddon)

        this.noticeElement = document.createElement('div')
        this.noticeElement.className = 'yl-notice'
        this.noticeElement.hidden = true

        this.headerElement = document.createElement('div')
        this.headerElement.className = 'yl-header'
        this.headerTitle = document.createElement('div')
        this.headerTitle.className = 'yl-track-title'
        this.headerSubtitle = document.createElement('div')
        this.headerSubtitle.className = 'yl-track-artist'
        this.headerElement.append(this.headerTitle, this.headerSubtitle)

        this.root.append(this.backgroundLayer, stage, this.headerElement, this.noticeElement)
        host.appendChild(this.root)

        this.bindInteractions()
        this.applyOptions(options)
    }

    private buildBackground(): HTMLDivElement {
        const layer = document.createElement('div')
        layer.className = 'yl-bg'
        layer.dataset.mode = 'off'

        const scrim = document.createElement('div')
        scrim.className = 'yl-bg-scrim'

        layer.appendChild(scrim)
        return layer
    }

    /** Куда сообщать о запросе перемотки при клике по строке. */
    setSeekHandler(handler: (timeMs: number) => void): void {
        this.onSeek = handler
    }

    get background(): HTMLElement {
        return this.backgroundLayer
    }

    /** Обновляет шапку с названием трека и исполнителем. */
    setTrack(title: string, subtitle: string): void {
        this.headerTitle.textContent = title
        this.headerSubtitle.textContent = subtitle
        this.headerSubtitle.hidden = !subtitle
        this.headerElement.classList.toggle('yl-visible', Boolean(title))
    }

    /**
     * Подпись под последней строкой: кто сделал текст и кто — аддон.
     * Пустая строка прячется, чтобы не оставлять зазор на пустом месте.
     */
    setCredits(lyricsCredit: string, addonCredit: string): void {
        this.creditsLyrics.textContent = lyricsCredit
        this.creditsLyrics.hidden = !lyricsCredit
        this.creditsAddon.textContent = addonCredit
        this.creditsAddon.hidden = !addonCredit
        this.creditsElement.hidden = !lyricsCredit && !addonCredit
    }

    get isVisible(): boolean {
        return !this.root.hidden
    }

    private bindInteractions(): void {
        this.linesContainer.addEventListener('click', event => {
            const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('.yl-line')
            if (!target) {
                return
            }

            const index = Number(target.dataset.lineIndex)
            const entry = Number.isFinite(index) ? this.entries[index] : undefined
            if (!entry) {
                return
            }

            // У простого текста нет таймингов — перематывать некуда.
            if (!this.synced) {
                return
            }

            // Клик по строке — перемотка на её начало.
            this.onSeek?.(entry.line.time)
            this.manualOffset = 0
            this.activeIndex = -1
        })

        // Ручной скролл колесом. Пока пользователь листает — автопрокрутка
        // выключена, иначе строку будет «вырывать» из-под курсора.
        this.scrollContainer.addEventListener(
            'wheel',
            event => {
                // У простого текста нет ни таймингов, ни своей прокрутки — там
                // листает сам контейнер, и перехватывать колесо нельзя.
                if (!this.synced) {
                    return
                }

                // Приращение считаем от уже ограниченной позиции: иначе колесо
                // копит «лишние» пиксели и после сброса ручного сдвига список
                // прыгает обратно.
                const next = this.clampOffset(this.scrollOffset + this.manualOffset + event.deltaY)
                this.manualOffset = next - this.scrollOffset
                this.beginUserScroll()
                this.applyTransform(false)
                event.preventDefault()
            },
            { passive: false },
        )
    }

    private beginUserScroll(): void {
        this.userScrolling = true
        this.root.classList.add('yl-scrolling')

        window.clearTimeout(this.scrollIdleTimer)
        this.scrollIdleTimer = window.setTimeout(() => {
            this.userScrolling = false
            this.root.classList.remove('yl-scrolling')
            this.manualOffset = 0

            // Возвращаемся к активной строке тем же плавным переходом, а не
            // прыжком: мгновенная перемотка выдёргивала из чтения.
            this.scrollToLine(this.activeIndex, false)
        }, USER_SCROLL_IDLE_MS)
    }

    setOptions(options: LyricsViewOptions): void {
        this.options = options
        this.applyOptions(options)
    }

    private applyOptions(options: LyricsViewOptions): void {
        this.root.style.setProperty('--yl-gradient-degrees', `${options.gradientDegrees}deg`)
        this.root.dataset.hoverBg = String(options.lineHoverBackground)
        this.syncWordSyncAttr()

        for (const entry of this.entries) {
            entry.cacheClass = ''
            entry.cacheBlur = ''
            this.resetWordStates(entry)
            entry.cacheWordState = []
        }

        this.wordWindow = null
    }

    private syncWordSyncAttr(): void {
        this.linesContainer.dataset.wordSync = String(this.options.wordSync)
    }

    /** Показывает сообщение вместо лирики (нет текста, офлайн, ошибка). */
    showNotice(title: string, hint?: string): void {
        this.clearLines()
        this.noticeElement.replaceChildren()

        const titleElement = document.createElement('div')
        titleElement.className = 'yl-notice-title'
        titleElement.textContent = title
        this.noticeElement.appendChild(titleElement)

        if (hint) {
            const hintElement = document.createElement('div')
            hintElement.className = 'yl-notice-hint'
            hintElement.textContent = hint
            this.noticeElement.appendChild(hintElement)
        }

        this.noticeElement.hidden = false
        this.scrollContainer.hidden = true
    }

    /** Скрывает сообщение и показывает область лирики. */
    clearNotice(): void {
        this.noticeElement.hidden = true
        this.scrollContainer.hidden = false
    }

    /** Строит строки для нового трека. */
    setLyrics(lyrics: ParsedLyrics | null): void {
        this.clearLines()

        if (!lyrics || lyrics.lines.length === 0) {
            return
        }

        this.synced = lyrics.synced
        this.lines = lyrics.lines

        this.syncWordSyncAttr()
        this.scrollContainer.dataset.synced = String(lyrics.synced)
        this.linesContainer.dataset.synced = String(lyrics.synced)

        const fragment = document.createDocumentFragment()

        lyrics.lines.forEach((line, index) => {
            const element = document.createElement('div')
            element.className = 'yl-line yl-notsung'
            element.dataset.lineIndex = String(index)

            const wordElements: HTMLElement[] = []
            const segmentLengths: number[] = []
            let totalChars = 0

            for (const segment of lineSegments(line)) {
                const wordElement = document.createElement('span')
                wordElement.className = 'yl-word'
                wordElement.textContent = segment.text
                element.appendChild(wordElement)

                wordElements.push(wordElement)
                segmentLengths.push(segment.length)
                totalChars += segment.length
            }

            fragment.appendChild(element)

            this.entries.push({
                line,
                element,
                wordElements,
                segmentLengths,
                totalChars,
                cacheClass: '',
                cacheBlur: '',
                cacheWordState: [],
            })
        })

        // Подпись идёт последним элементом списка — до неё достаёт прокрутка,
        // поэтому она же служит нижней границей.
        fragment.appendChild(this.creditsElement)

        this.linesContainer.replaceChildren(fragment)
        this.activeIndex = -1
        this.manualOffset = 0
        this.scrollOffset = 0
        this.linesContainer.style.transform = 'translate3d(0, 0, 0)'
    }

    private clearLines(): void {
        this.entries = []
        this.lines = []
        this.activeIndex = -1
        this.synced = true
        this.linesContainer.replaceChildren()
    }

    /** Показывает/скрывает оверлей без пересоздания DOM. */
    setVisible(visible: boolean): void {
        this.root.hidden = !visible
    }

    /**
     * Обновляет состояние караоке для момента `timeMs`.
     * Вызывается каждый кадр, пока оверлей открыт.
     */
    render(timeMs: number): void {
        if (this.entries.length === 0 || !this.synced) {
            return
        }

        const adjusted = timeMs + this.options.offsetMs
        const activeIndex = findActiveLineIndex(this.lines, adjusted)

        if (activeIndex !== this.activeIndex) {
            const previous = this.activeIndex
            this.activeIndex = activeIndex

            if (!this.userScrolling) {
                // При первом показе и при перескоке (seek) — без плавного проезда
                // через весь список.
                const isJump = previous < 0 || Math.abs(activeIndex - previous) > 2
                this.scrollToLine(activeIndex, isJump)
            }
        }

        this.updateClasses(activeIndex, adjusted)
        this.updateWordStates(activeIndex, adjusted)
    }

    private updateClasses(activeIndex: number, timeMs: number): void {
        const { blurInactive } = this.options
        const from = Math.max(0, activeIndex - ACTIVE_WINDOW)
        const to = Math.min(this.entries.length - 1, activeIndex + ACTIVE_WINDOW)

        for (let index = from; index <= to; index++) {
            const entry = this.entries[index]
            const { line } = entry

            let state: 'yl-notsung' | 'yl-active' | 'yl-sung'
            if (index === activeIndex) {
                state = 'yl-active'
            } else if (timeMs >= line.endTime) {
                state = 'yl-sung'
            } else {
                state = 'yl-notsung'
            }

            const distance = Math.abs(index - activeIndex)
            const blur = blurInactive ? Math.min(BLUR_MULTIPLIER * distance, BLUR_MULTIPLIER * BLUR_MAX_DISTANCE + BLUR_MULTIPLIER * 0.465) : 0

            const className = `yl-line ${state}`
            if (className !== entry.cacheClass) {
                entry.element.className = className
                entry.cacheClass = className
            }

            // Активная строка и её соседи всегда резкие.
            const blurValue = distance <= 1 ? '0.00' : blur.toFixed(2)
            if (blurValue !== entry.cacheBlur) {
                entry.element.style.setProperty('--yl-blur-amount', `${blurValue}px`)
                entry.cacheBlur = blurValue
            }
        }
    }

    private resetWordStates(entry: LineEntry | undefined): void {
        if (!entry) {
            return
        }

        for (let index = 0; index < entry.wordElements.length; index++) {
            if (entry.cacheWordState[index]) {
                entry.wordElements[index].className = 'yl-word'
                entry.cacheWordState[index] = ''
            }
        }
    }

    /**
     * Красит слова по одному: целое слово либо горит, либо нет — прогресс
     * внутри слова не считается.
     */
    private updateWordStates(activeIndex: number, timeMs: number): void {
        const enabled = this.options.wordSync
        const from = enabled ? Math.max(0, activeIndex - WORD_WINDOW) : 0
        const to = enabled ? Math.min(this.entries.length - 1, activeIndex + WORD_WINDOW) : -1

        const previous = this.wordWindow
        if (previous) {
            for (let index = previous.from; index <= previous.to; index++) {
                if (enabled && index >= from && index <= to) {
                    continue
                }

                this.resetWordStates(this.entries[index])
            }
        }

        this.wordWindow = enabled ? { from, to } : null

        if (!enabled) {
            return
        }

        for (let index = from; index <= to; index++) {
            const entry = this.entries[index]
            const sungChars = getLineProgress(entry.line, timeMs) * entry.totalChars

            let offset = 0

            for (let wordIndex = 0; wordIndex < entry.segmentLengths.length; wordIndex++) {
                const length = entry.segmentLengths[wordIndex]
                const element = entry.wordElements[wordIndex]
                const state = sungChars >= offset + length ? 'yl-sung' : sungChars > offset ? 'yl-active' : ''
                const className = state ? `yl-word ${state}` : 'yl-word'

                if (className !== entry.cacheWordState[wordIndex]) {
                    element.className = className
                    entry.cacheWordState[wordIndex] = className
                }

                offset += length
            }
        }
    }

    /**
     * Границы прокрутки в пикселях: выше первой строки и ниже подписи листать
     * некуда — обе встают в центр, дальше только пустота.
     *
     * `null`, если раскладка ещё не посчитана: без высоты контейнера границы
     * выродились бы в мусор, и прокрутка залипла бы на месте.
     */
    private scrollBounds(): { min: number; max: number } | null {
        const first = this.entries[0]?.element
        const last = this.creditsElement.hidden ? this.entries[this.entries.length - 1]?.element : this.creditsElement

        const containerHeight = this.scrollContainer.clientHeight
        if (!first || !last || containerHeight <= 0) {
            return null
        }

        const centered = (element: HTMLElement) => element.offsetTop + element.offsetHeight / 2 - containerHeight / 2 - CENTER_BIAS_PX

        const min = centered(first)
        return { min, max: Math.max(centered(last), min) }
    }

    private clampOffset(value: number): number {
        const bounds = this.scrollBounds()
        if (!bounds) {
            return value
        }

        return Math.min(Math.max(value, bounds.min), bounds.max)
    }

    /**
     * Ставит строку в центр контейнера.
     *
     * `instant` отключает transition на один кадр — иначе первый показ или
     * перемотка проезжают через весь список строк.
     */
    private scrollToLine(index: number, instant: boolean): void {
        const entry = this.entries[index]
        if (!entry) {
            return
        }

        const containerHeight = this.scrollContainer.clientHeight
        // Вычитаем смещение, чтобы строка встала чуть ниже центра.
        const target = entry.element.offsetTop + entry.element.offsetHeight / 2 - containerHeight / 2 - CENTER_BIAS_PX

        this.scrollOffset = this.clampOffset(target)
        this.manualOffset = 0
        this.applyTransform(instant)
    }

    private applyTransform(instant: boolean): void {
        // Прокрутка вниз (deltaY > 0) должна уводить список вверх.
        const value = -this.clampOffset(this.scrollOffset + this.manualOffset)

        if (instant) {
            this.linesContainer.style.transition = 'none'
            this.linesContainer.style.transform = `translate3d(0, ${value}px, 0)`
            // Форсируем reflow, чтобы снятие transition применилось в этом же кадре.
            void this.linesContainer.offsetHeight
            this.linesContainer.style.transition = `transform ${SCROLL_TRANSITION}`
            return
        }

        this.linesContainer.style.transform = `translate3d(0, ${value}px, 0)`
    }

    destroy(): void {
        window.clearTimeout(this.scrollIdleTimer)
        this.clearLines()
        this.root.remove()
    }
}
