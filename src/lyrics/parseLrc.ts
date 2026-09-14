/**
 * Парсер LRC-лирики.
 *
 * Поддерживаются:
 *  - обычный LRC: `[mm:ss.xx]строка`
 *  - расширенный LRC (word-by-word): `[mm:ss.xx]<mm:ss.xx>слово<mm:ss.xx>слово`
 *  - несколько меток времени на строку: `[00:12.00][01:20.00]строка`
 *  - теги метаданных: `[ar:...]`, `[ti:...]`, `[offset:...]`
 *  - строки без тайминга (например, кредиты в конце) отбрасываются
 */

export type LyricsWord = {
    /** Текст слова вместе с завершающим пробелом, если он был в оригинале. */
    text: string
    /** Начало слова, мс. */
    time: number
    /** Конец слова, мс. */
    endTime: number
}

export type LyricsLine = {
    /** Полный текст строки без таймингов. */
    text: string
    /** Начало строки, мс. */
    time: number
    /** Оценка конца строки, мс (начало следующей строки либо +duration). */
    endTime: number
    /** Разбивка по словам. Пусто, если у строки нет word-level таймингов. */
    words: LyricsWord[]
}

export type ParsedLyrics = {
    /** Строки, отсортированные по времени. */
    lines: LyricsLine[]
    /** Есть ли хотя бы в одной строке word-level тайминги. */
    hasWordSync: boolean
    /** Есть ли у строк реальные тайминги. У простого текста — `false`. */
    synced: boolean
    /** Смещение из тега `[offset:]`, мс. */
    offset: number
    /** Теги метаданных (`ar`, `ti`, `al`, `by`, ...). */
    meta: Record<string, string>
}

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g

/** `mm:ss.xx` -> миллисекунды. Поддерживает 1–3 знака в дробной части. */
function toMs(minutes: string, seconds: string, fraction?: string): number {
    const min = Number(minutes)
    const sec = Number(seconds)
    let ms = 0

    if (fraction) {
        // `.5` — это 500мс, `.50` — 500мс, `.500` — 500мс
        ms = Number(fraction.padEnd(3, '0').slice(0, 3))
    }

    return min * 60_000 + sec * 1000 + ms
}

/**
 * Разбирает строку на слова по `<таймкод>`.
 * Возвращает пустой массив, если word-level таймингов нет.
 */
function parseWords(raw: string, lineTime: number): LyricsWord[] {
    WORD_TAG.lastIndex = 0

    const matches = Array.from(raw.matchAll(WORD_TAG))
    if (matches.length === 0) {
        return []
    }

    const words: LyricsWord[] = []

    // Текст до первого таймкода, если он есть, относится к началу строки.
    const leading = raw.slice(0, matches[0].index ?? 0)

    matches.forEach((match, index) => {
        const start = toMs(match[1], match[2], match[3])
        const next = matches[index + 1]
        const textStart = (match.index ?? 0) + match[0].length
        const textEnd = next ? (next.index ?? raw.length) : raw.length

        let text = raw.slice(textStart, textEnd)
        if (index === 0 && leading) {
            text = leading + text
        }
        if (!text) {
            return
        }

        // Конец слова = начало следующего; для последнего слова оставляем
        // оценку, которую уточнит `finalizeLines`.
        const end = next ? toMs(next[1], next[2], next[3]) : Number.NaN

        words.push({ text, time: start, endTime: end })
    })

    if (words.length === 0) {
        return []
    }

    words[0].time = Number.isFinite(words[0].time) ? Math.min(words[0].time, lineTime) : lineTime
    return words
}

/** Убирает таймкоды слов и лишние пробелы, оставляя читаемый текст строки. */
function stripWordTags(raw: string): string {
    return raw
        .replace(WORD_TAG, '')
        .replace(/\s+/g, ' ')
        .trim()
}

export function parseLrc(source: string): ParsedLyrics {
    const meta: Record<string, string> = {}
    const lines: LyricsLine[] = []
    let offset = 0

    for (const rawLine of source.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line) {
            continue
        }

        // Теги метаданных пишутся до таймкодов, поэтому проверяем их первыми.
        const metaMatch = /^\[([a-zA-Z#]+):(.*)\]$/.exec(line)
        if (metaMatch && !/^\d+$/.test(metaMatch[1])) {
            const key = metaMatch[1].toLowerCase()
            const value = metaMatch[2].trim()
            meta[key] = value

            if (key === 'offset') {
                const parsed = Number(value)
                offset = Number.isFinite(parsed) ? parsed : 0
            }
            continue
        }

        TIME_TAG.lastIndex = 0
        const stamps = Array.from(line.matchAll(TIME_TAG))
        if (stamps.length === 0) {
            // Строка без тайминга — петь её нечем.
            continue
        }

        const lastStamp = stamps[stamps.length - 1]
        const contentStart = (lastStamp.index ?? 0) + lastStamp[0].length
        const content = line.slice(contentStart).trim()

        if (!content) {
            continue
        }

        const text = stripWordTags(content)
        if (!text) {
            continue
        }

        for (const stamp of stamps) {
            const time = toMs(stamp[1], stamp[2], stamp[3])
            const words = parseWords(content, time)

            lines.push({
                text,
                time,
                endTime: Number.NaN,
                words: words.length > 0 ? words.map(word => ({ ...word })) : [],
            })
        }
    }

    if (offset !== 0) {
        for (const line of lines) {
            line.time -= offset
            for (const word of line.words) {
                word.time -= offset
                if (Number.isFinite(word.endTime)) {
                    word.endTime -= offset
                }
            }
        }
    }

    lines.sort((a, b) => a.time - b.time)

    const hasWordSync = lines.some(line => line.words.length > 0)
    finalizeLines(lines)

    return { lines, hasWordSync, synced: lines.length > 0, offset, meta }
}

/**
 * Разбирает простой текст без таймингов.
 *
 * Строки получают `time: NaN` — вызывающая сторона по флагу `synced: false`
 * понимает, что подсвечивать нечего и текст нужно показать как есть.
 */
export function parsePlainText(source: string): ParsedLyrics {
    const lines: LyricsLine[] = source
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(text => ({ text, time: Number.NaN, endTime: Number.NaN, words: [] }))

    return { lines, hasWordSync: false, synced: false, offset: 0, meta: {} }
}

/**
 * Проставляет `endTime` строкам и словам.
 *
 * Строка заканчивается там, где начинается следующая. Последняя строка
 * получает оценку в 10 секунд, если её нечем ограничить. Слова внутри строки
 * получают конец либо из следующего слова, либо из конца строки.
 */
function finalizeLines(lines: LyricsLine[]): void {
    const FALLBACK_LINE_MS = 10_000
    const FALLBACK_WORD_MS = 600

    lines.forEach((line, index) => {
        const next = lines[index + 1]
        const nextStart = next ? next.time : line.time + FALLBACK_LINE_MS

        if (line.words.length > 0) {
            line.words.forEach((word, wordIndex) => {
                const nextWord = line.words[wordIndex + 1]
                const end = nextWord ? nextWord.time : Number.NaN

                if (Number.isFinite(end)) {
                    word.endTime = end
                } else if (!Number.isFinite(word.endTime)) {
                    word.endTime = Math.min(word.time + FALLBACK_WORD_MS, nextStart)
                }

                if (word.endTime <= word.time) {
                    word.endTime = word.time + 100
                }
            })

            // Конец строки не может быть раньше последнего слова.
            const lastWord = line.words[line.words.length - 1]
            line.endTime = Math.max(nextStart, lastWord.endTime)
        } else {
            line.endTime = nextStart
        }

        if (line.endTime <= line.time) {
            line.endTime = line.time + 1_000
        }
    })
}

/**
 * Возвращает индекс активной строки для момента `timeMs`.
 *
 * Пока строка ещё не началась, активной считается предыдущая — так подсветка
 * не «прыгает» в пустоту между строками.
 */
export function findActiveLineIndex(lines: readonly LyricsLine[], timeMs: number): number {
    let low = 0
    let high = lines.length - 1
    let result = -1

    while (low <= high) {
        const mid = (low + high) >> 1
        if (lines[mid].time <= timeMs) {
            result = mid
            low = mid + 1
        } else {
            high = mid - 1
        }
    }

    return result < 0 ? 0 : result
}

/**
 * Прогресс строки от 0 до 1. Используется для подсветки текста.
 *
 * Если у строки есть word-level тайминги, прогресс считается по «спелому»
 * тексту слов, что даёт ровный караоке-эффект без рывков.
 */
export function getLineProgress(line: LyricsLine, timeMs: number): number {
    if (line.words.length > 0) {
        const totalChars = line.words.reduce((sum, word) => sum + Math.max(word.text.length, 1), 0)
        if (totalChars === 0) {
            return 0
        }

        let sungChars = 0
        for (const word of line.words) {
            const length = Math.max(word.text.length, 1)
            const duration = Math.max(word.endTime - word.time, 1)

            if (timeMs >= word.endTime) {
                sungChars += length
                continue
            }

            if (timeMs <= word.time) {
                break
            }

            sungChars += length * ((timeMs - word.time) / duration)
            break
        }

        return Math.min(sungChars / totalChars, 1)
    }

    const duration = Math.max(line.endTime - line.time, 1)
    return Math.min(Math.max((timeMs - line.time) / duration, 0), 1)
}

/** Прогресс отдельного слова от 0 до 1. */
export function getWordProgress(word: LyricsWord, timeMs: number): number {
    const duration = Math.max(word.endTime - word.time, 1)
    return Math.min(Math.max((timeMs - word.time) / duration, 0), 1)
}
