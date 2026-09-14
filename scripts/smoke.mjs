/**
 * Дымовой тест собранного аддона в jsdom.
 *
 * Проверяет, что бандл исполняется, оверлей строится, караоке-разметка
 * создаётся и подсветка двигается по кадрам. Запуск: `node scripts/smoke.mjs`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import { JSDOM, VirtualConsole } from 'jsdom'

import addonConfig from '../addon.config.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(here, '..')
const srcDir = join(rootDir, 'src')
const bundlePath = join(rootDir, 'dist', addonConfig.directoryName, 'script.js')
const bundle = readFileSync(bundlePath, 'utf8')

/**
 * Тест читает собранный бандл, а не исходники, поэтому устаревшая сборка
 * проверяла бы старый код и молча проходила. Ловим это сразу.
 */
function newestMtime(dir) {
    let newest = 0
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs)
    }
    return newest
}

if (newestMtime(srcDir) > statSync(bundlePath).mtimeMs) {
    console.error('Бандл старше исходников — сначала `npm run build`.')
    process.exit(1)
}

// jsdom без пакета `canvas` не умеет `getContext` — для теста это не важно.
const virtualConsole = new VirtualConsole()
virtualConsole.on('jsdomError', () => {})
virtualConsole.on('error', message => console.error('[window]', message))

const LRC = [
    '[offset:0]',
    '[00:01.00]<00:01.00>Первая <00:01.60>строка',
    '[00:03.00]<00:03.00>Вторая <00:03.70>строка',
    '[00:05.00]<00:05.00>Третья <00:05.50>строка',
].join('\n')

const TRACK = {
    id: '12345',
    title: 'Тестовый трек',
    artists: [{ name: 'Тестовый исполнитель' }],
    coverUri: 'avatars.yandex.net/get-music-content/1/2/%%',
    durationMs: 200000,
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://music.yandex.ru/',
    pretendToBeVisual: true, // Нужно, чтобы `window.eval` выполнял бандл именно в контексте окна.
    runScripts: 'outside-only',
    virtualConsole,
})

const { window } = dom

// ── Заглушки окружения клиента ────────────────────────────────────────────

window.localStorage.setItem('oauth', 'test-token')

// jsdom отдаёт crypto без WebCrypto — подменяем на нодовский.
if (!window.crypto?.subtle) {
    Object.defineProperty(window, 'crypto', {
        value: globalThis.crypto,
        configurable: true,
        writable: true,
    })
}

// В jsdom нет TextEncoder/TextDecoder, а они нужны для HMAC-подписи.
for (const name of ['TextEncoder', 'TextDecoder', 'btoa', 'atob']) {
    if (typeof window[name] === 'undefined') {
        Object.defineProperty(window, name, {
            value: globalThis[name],
            configurable: true,
            writable: true,
        })
    }
}

const calls = { setProgress: [], timeMs: 1000 }

/** Слушатели смены трека клиента — тест дёргает их вручную. */
const trackListeners = []

window.pulsesyncApi = {
    getSettings: () => ({
        getCurrent: () => ({
            backgroundMode: 'off',
            backgroundBlur: 40,
            wordSync: true,
            blurInactive: true,
            lineHoverBackground: true,
            offsetMs: 0,
            gradientDegrees: 90,
            useSystemFont: false,
            controlsPosition: 'bottom',
            showFloatingButton: true,
            hotkey: 'KeyL',
            enabled: true,
        }),
        onChange: () => () => {},
    }),
    getCurrentTrack: () => TRACK,
    getProgress: () => calls.timeMs / 1000,
    isPlaying: () => true,
    setProgress: seconds => calls.setProgress.push(seconds),
    getPlatform: () => 'web',
    onCurrentTrackChange: callback => {
        trackListeners.push(callback)
        return () => {}
    },
}

const jsonResponse = payload => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
})

const textResponse = body => ({
    ok: true,
    status: 200,
    json: async () => JSON.parse(body),
    text: async () => body,
})

const notFound = () => ({
    ok: false,
    status: 404,
    json: async () => ({}),
    text: async () => '',
})

const PLAIN = ['Просто текст без таймингов', 'Вторая строка простого текста', 'Третья строка простого текста'].join('\n')

/** Трек без синхронизации: Яндекс отдаёт текст, в котором нет таймкодов. */
const PLAIN_ONLY_ID = '999'

window.fetch = async url => {
    const href = String(url)

    if (href.includes('lrclib.net')) {
        return notFound()
    }

    if (href.includes('plain.txt')) {
        return textResponse(PLAIN)
    }

    if (href.includes(`/tracks/${PLAIN_ONLY_ID}/`)) {
        // Тот же контент и для LRC, и для TEXT — как у трека без таймингов.
        return jsonResponse({ result: { downloadUrl: 'https://example.test/plain.txt' } })
    }

    if (href.endsWith('/lyrics.lrc')) {
        return textResponse(LRC)
    }

    if (href.includes('/lyrics')) {
        return jsonResponse({ result: { downloadUrl: 'https://example.test/lyrics.lrc' } })
    }

    return notFound()
}

// Кадры гоняем вручную, чтобы тест был детерминированным.
const frameQueue = []
window.requestAnimationFrame = callback => {
    frameQueue.push(callback)
    return frameQueue.length
}
window.cancelAnimationFrame = () => {}

// ── Запуск бандла ─────────────────────────────────────────────────────────

window.eval(bundle)

const errors = []
window.addEventListener('error', event => errors.push(event.message))

const flush = () => new Promise(r => setTimeout(r, 0))

/**
 * Ждёт выполнения условия. Загрузка текста асинхронна и в jsdom занимает
 * непредсказуемое число тиков (сеть, разбор, запись в кеш), поэтому
 * фиксированное число `flush()` давало бы плавающий тест.
 */
const waitFor = async (predicate, attempts = 200) => {
    for (let i = 0; i < attempts; i++) {
        if (predicate()) {
            return true
        }
        await flush()
    }
    return predicate()
}

/** Прогоняет накопившиеся кадры вручную — тест должен быть детерминированным. */
const tick = () => {
    const pending = frameQueue.splice(0, frameQueue.length)
    for (const callback of pending) callback(0)
}

/**
 * Прогоняет несколько кадров с реальными паузами: позиция из стора
 * перечитывается не чаще раза в 100 мс, без пауз время бы не двигалось.
 */
const advance = async (frames = 6) => {
    for (let i = 0; i < frames; i++) {
        tick()
        await new Promise(r => setTimeout(r, 25))
    }
}

const assert = (condition, message) => {
    if (!condition) {
        console.error(`  ✗ ${message}`)
        process.exitCode = 1
    } else {
        console.log(`  ✓ ${message}`)
    }
}

await flush()

const overlay = window.document.getElementById('yl-overlay')
assert(overlay, 'оверлей создан')
assert(window.document.querySelector('.yl-controls'), 'панель управления создана')

// Открываем оверлей горячей клавишей.
window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyL', bubbles: true }))
assert(overlay?.hidden === false, 'оверлей открылся по горячей клавише')

// Даём сервису загрузить и разобрать лирику.
await waitFor(() => window.document.querySelectorAll('.yl-line').length === 3)

const lines = window.document.querySelectorAll('.yl-line')
assert(lines.length === 3, `разобрано 3 строки (получено ${lines.length})`)
assert(window.document.querySelectorAll('.yl-word').length === 6, 'слова разбиты пословно')

// Первый кадр: активной должна стать первая строка.
tick()
assert(window.document.querySelectorAll('.yl-line.yl-active').length === 1, 'ровно одна активная строка')

const activeWord = window.document.querySelector('.yl-line.yl-active .yl-word')
assert(activeWord?.classList.contains('yl-word'), 'слово внутри строки — отдельный элемент')
assert(
    window.document.querySelectorAll('.yl-line.yl-active .yl-word.yl-active').length === 0,
    'в начале строки ни одно слово ещё не подсвечено',
)

const before = window.document.querySelector('.yl-line.yl-active')?.textContent
assert(before?.includes('Первая'), 'активна именно первая строка')

// Внутри строки подсветка должна переходить по словам, а не стоять на месте.
calls.timeMs = 1300
await advance(5)

const litWords = window.document.querySelectorAll('.yl-line.yl-active .yl-word.yl-active')
assert(litWords.length === 1, `подсвечено ровно одно слово — то, что звучит (${litWords.length})`)
assert(litWords[0]?.textContent?.includes('Первая'), 'подсвечено именно первое слово строки')

// Перематываем время вперёд: активной должна стать вторая строка.
calls.timeMs = 3200
await advance(10)

const activeText = window.document.querySelector('.yl-line.yl-active')?.textContent
assert(activeText?.includes('Вторая'), `после перемотки активна вторая строка (${activeText})`)
assert(window.document.querySelectorAll('.yl-line.yl-sung').length >= 1, 'первая строка помечена как спетая')

// Допетые слова гаснут до «спетого» цвета: ярким остаётся только текущее.
const sungWords = window.document.querySelectorAll('.yl-line:first-child .yl-word.yl-sung')
assert(sungWords.length === 2, `слова первой строки помечены спетыми (${sungWords.length})`)
assert(
    window.document.querySelectorAll('.yl-line.yl-active .yl-word.yl-sung').length === 0,
    'в активной строке нет слов, помеченных спетыми',
)

// Подпись внизу списка: автор текста и автор расширения.
const credits = window.document.querySelector('.yl-credits')
assert(credits, 'подпись под лирикой создана')
assert(credits?.querySelector('.yl-credits-line')?.textContent.startsWith('Текст:'), 'первая строка подписи — автор текста')
assert(credits?.textContent.includes('Расширение: botcott'), 'вторая строка подписи — автор расширения')

// Переключатель пословной подсветки в оверлее.
const wordSyncOf = () => window.document.querySelector('.yl-lines').dataset.wordSync
assert(wordSyncOf() === 'true', 'пословная подсветка включена по умолчанию')

const karaokeButton = window.document.querySelector('.yl-controls [aria-label="Пословная подсветка"]')
karaokeButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await flush()
assert(wordSyncOf() === 'false', `кнопка выключает пословную подсветку (${wordSyncOf()})`)
assert(
    window.document.querySelectorAll('.yl-word.yl-sung, .yl-word.yl-active').length === 0,
    'без пословной подсветки следов подсветки слов не остаётся',
)

karaokeButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await flush()
assert(wordSyncOf() === 'true', `повторный клик включает её обратно (${wordSyncOf()})`)

// Сдвиг синхронизации: шаг 0.1 с, текущее значение видно на панели.
const offsetValue = () => window.document.querySelector('.yl-offset-value')?.textContent
assert(offsetValue() === '0.0 с', `сдвиг начинается с нуля (${offsetValue()})`)

const offsetClick = label => {
    const button = window.document.querySelector(`.yl-controls [aria-label^="${label}"]`)
    button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
}

offsetClick('Текст позже')
await flush()
assert(offsetValue() === '+0.1 с', `«позже» двигает текст на 0.1 с (${offsetValue()})`)

offsetClick('Текст раньше')
offsetClick('Текст раньше')
await flush()
assert(offsetValue() === '−0.1 с', `«раньше» двигает текст назад на 0.1 с (${offsetValue()})`)

const resetButton = window.document.querySelector('.yl-controls [aria-label="Сбросить настройки"]')
assert(resetButton, 'кнопка сброса настроек есть в панели')
resetButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await flush()
assert(offsetValue() === '0.0 с', `сброс возвращает сдвиг к нулю (${offsetValue()})`)

// Прокрутка колесом: вниз по списку — контейнер уезжает вверх.
const linesContainer = window.document.querySelector('.yl-lines')
const translateOf = () => parseFloat(/translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(linesContainer.style.transform)?.[1] ?? 'NaN')

const beforeWheel = translateOf()
window.document.querySelector('.yl-scroll').dispatchEvent(new window.WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }))
const afterWheel = translateOf()
assert(afterWheel < beforeWheel, `колесо вниз уводит список вверх (${beforeWheel} → ${afterWheel})`)

// Клик по строке перематывает трек.
const third = window.document.querySelectorAll('.yl-line')[2]
third.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await flush()
assert(calls.setProgress.at(-1) === 5, `клик по строке перемотал на 5 с (${calls.setProgress.at(-1)})`)

// ── Границы прокрутки ─────────────────────────────────────────────────────
// jsdom не считает раскладку: clientHeight и offsetTop всегда нули, а без них
// ограничивать прокрутку нечем. Подставляем геометрию вручную.
const VIEWPORT = 600
const LINE_HEIGHT = 60

Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
        return this.classList.contains('yl-scroll') ? VIEWPORT : 0
    },
})
Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
        return this.classList.contains('yl-line') || this.classList.contains('yl-credits') ? LINE_HEIGHT : 0
    },
})
Object.defineProperty(window.HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get() {
        if (this.classList.contains('yl-line')) {
            return Number(this.dataset.lineIndex) * LINE_HEIGHT
        }

        // Подпись стоит четвёртым блоком — сразу после трёх строк.
        return this.classList.contains('yl-credits') ? 3 * LINE_HEIGHT : 0
    },
})

const wheel = deltaY =>
    window.document.querySelector('.yl-scroll').dispatchEvent(new window.WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }))

/** Позиция блока, вставшего в центр контейнера, и соответствующий ей сдвиг. */
const centeredOffset = offsetTop => offsetTop + LINE_HEIGHT / 2 - VIEWPORT / 2 - 30
const expectedTranslate = offsetTop => -centeredOffset(offsetTop)

// Вниз до упора: дальше подписи листать некуда.
wheel(100_000)
assert(Math.abs(translateOf() - expectedTranslate(3 * LINE_HEIGHT)) < 1, `прокрутка вниз упирается в подпись (${translateOf()})`)

// И вверх до упора: выше первой строки ничего нет.
wheel(-100_000)
assert(Math.abs(translateOf() - expectedTranslate(0)) < 1, `прокрутка вверх упирается в первую строку (${translateOf()})`)

// Плавающая кнопка: живёт вне панели плеера и перетаскивается.
const floating = window.document.getElementById('yl-floating-button')
assert(floating, 'плавающая кнопка создана')

const pointer = (type, props) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true })
    Object.assign(event, props)
    return event
}

const leftOf = () => parseFloat(floating.style.left)
const topOf = () => parseFloat(floating.style.top)

assert(Number.isFinite(leftOf()) && Number.isFinite(topOf()), `у кнопки есть позиция (${floating.style.left}, ${floating.style.top})`)

const startLeft = leftOf()
const startTop = topOf()

floating.dispatchEvent(pointer('pointerdown', { pointerId: 1, clientX: startLeft + 10, clientY: startTop + 10 }))
floating.dispatchEvent(pointer('pointermove', { pointerId: 1, clientX: startLeft - 130, clientY: startTop - 90 }))
floating.dispatchEvent(pointer('pointerup', { pointerId: 1, clientX: startLeft - 130, clientY: startTop - 90 }))

assert(leftOf() < startLeft && topOf() < startTop, `кнопка уехала за курсором (${startLeft},${startTop} → ${leftOf()},${topOf()})`)

// Перетаскивание не должно заодно открывать оверлей.
const wasHidden = overlay?.hidden
floating.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
assert(overlay?.hidden === wasHidden, 'клик после перетаскивания не открывает оверлей')

// Позиция переживает пересоздание: она лежит в localStorage.
assert(Boolean(window.localStorage.getItem('yl-floating-button-position')), 'позиция кнопки сохранена')

// Кнопка не трогает панель плеера.
const playerBar = window.document.createElement('div')
playerBar.setAttribute('data-test-id', 'PLAYERBAR_DESKTOP')
const nativeLyrics = window.document.createElement('button')
nativeLyrics.setAttribute('data-test-id', 'LYRICS_BUTTON')
playerBar.appendChild(nativeLyrics)
window.document.body.appendChild(playerBar)
await flush()

assert(playerBar.children.length === 1, 'в панель плеера ничего не добавлено')
assert(nativeLyrics.style.display === '', 'нативная кнопка лирики осталась видимой')

// Закрытие по Escape.
window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
assert(overlay?.hidden === true, 'оверлей закрылся по Escape')

// ── Трек без синхронизации ────────────────────────────────────────────────
// Таймингов нет: караоке выключается, текст показывается уже подсвеченным,
// а прокрутка остаётся нативной — перехватывать колесо нельзя.

TRACK.id = PLAIN_ONLY_ID
trackListeners.forEach(listener => listener(TRACK))
await waitFor(() => window.document.querySelector('.yl-scroll')?.dataset.synced === 'false')

const plainContainer = window.document.querySelector('.yl-scroll')
assert(plainContainer?.dataset.synced === 'false', `текст без таймингов распознан (${plainContainer?.dataset.synced})`)
assert(window.document.querySelectorAll('.yl-line').length === 3, 'простой текст разобран построчно')
assert(window.document.querySelectorAll('.yl-line.yl-active').length === 0, 'караоке в простом тексте не включается')

// Колесо над оверлеем не должно поглощаться: листает сам контейнер.
const plainWheel = new window.WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })
plainContainer?.dispatchEvent(plainWheel)
assert(plainWheel.defaultPrevented === false, 'колесо в простом тексте не перехватывается')

assert(errors.length === 0, `без ошибок в window.onerror (${errors.join('; ')})`)

console.log(process.exitCode ? '\nПровалено.' : '\nВсё прошло.')
