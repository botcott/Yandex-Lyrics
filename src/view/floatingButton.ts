/**
 * Плавающая кнопка открытия лирики.
 *
 * Панель плеера Яндекс Музыки — flex-строка фиксированной высоты: любой
 * добавленный в неё элемент растягивает ряд и выдавливает соседей вплоть до
 * ползунка громкости. Поэтому кнопка живёт отдельно от панели, поверх
 * интерфейса, и её можно перетащить в удобное место.
 *
 * Ведение — на Pointer Events: они одинаково работают для мыши, тачскрина и
 * пера. Короткое нажатие без движения открывает оверлей, нажатие с движением
 * перетаскивает кнопку.
 */

const BUTTON_ID = 'yl-floating-button'
const LABEL = 'YandexLyrics'

/** Куда сложить позицию, чтобы кнопка осталась на месте после перезапуска. */
const STORAGE_KEY = 'yl-floating-button-position'

/** Отступ от края окна при первичной расстановке и при ограничении позиции. */
const EDGE_GAP = 18

/** Сдвиг, с которого нажатие считается перетаскиванием, а не кликом. */
const DRAG_THRESHOLD_PX = 4

const SVG_NS = 'http://www.w3.org/2000/svg'

type Point = { x: number; y: number }

function createGlyph(): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('focusable', 'false')

    // Нота на строке — узнаваемый «текст песни».
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', 'M9 4v10.6A3.5 3.5 0 1 0 11 18V8h8V4H9zm8 2v0zM6.5 20A1.5 1.5 0 1 1 8 18.5 1.5 1.5 0 0 1 6.5 20z')
    svg.appendChild(path)

    return svg
}

function isPoint(value: unknown): value is Point {
    const point = value as Partial<Point> | null

    return Boolean(point) && typeof point?.x === 'number' && typeof point?.y === 'number'
}

/**
 * Позиция из прошлой сессии. Хранилище может быть недоступно (приватный
 * режим), поэтому чтение и запись молча деградируют до позиции по умолчанию.
 */
function readSavedPosition(): Point | null {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        return raw ? (JSON.parse(raw) as Point) : null
    } catch {
        return null
    }
}

function savePosition(point: Point): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(point))
    } catch {
        // Позиция — не то, ради чего стоит падать.
    }
}

export type FloatingButtonHandle = {
    /** Спрятать, пока открыт оверлей: там своя кнопка закрытия. */
    setVisible: (visible: boolean) => void
    dispose: () => void
}

export function createFloatingButton(onClick: () => void): FloatingButtonHandle {
    const button = document.createElement('button')
    button.type = 'button'
    button.id = BUTTON_ID
    button.className = 'yl-button yl-floating-button'
    button.setAttribute('aria-label', LABEL)
    button.title = LABEL
    button.appendChild(createGlyph())

    let pointerId: number | null = null
    let dragging = false
    /** Клик, который браузер пришлёт после перетаскивания, нужно погасить. */
    let suppressClick = false
    /** Смещение курсора внутри кнопки на момент захвата. */
    let grabOffset: Point = { x: 0, y: 0 }
    let dragOrigin: Point = { x: 0, y: 0 }
    /** Последняя позиция в левом верхнем углу — источник правды при клампе. */
    let position: Point | null = null

    const clamp = (point: Point): Point => {
        const maxX = Math.max(EDGE_GAP, window.innerWidth - button.offsetWidth - EDGE_GAP)
        const maxY = Math.max(EDGE_GAP, window.innerHeight - button.offsetHeight - EDGE_GAP)

        return {
            x: Math.min(Math.max(point.x, EDGE_GAP), maxX),
            y: Math.min(Math.max(point.y, EDGE_GAP), maxY),
        }
    }

    const applyPosition = (point: Point): Point => {
        position = clamp(point)
        button.style.left = `${position.x}px`
        button.style.top = `${position.y}px`

        return position
    }

    const placeDefault = () => {
        button.style.left = ''
        button.style.top = ''

        // Размер известен только после раскладки, а до неё посчитать нечего.
        const rect = button.getBoundingClientRect()
        applyPosition({
            x: window.innerWidth - rect.width - EDGE_GAP,
            y: window.innerHeight - rect.height - EDGE_GAP,
        })
    }

    button.addEventListener('pointerdown', event => {
        if (event.pointerType === 'mouse' && event.button !== 0) {
            return
        }

        suppressClick = false
        dragging = false
        pointerId = event.pointerId

        const rect = button.getBoundingClientRect()
        grabOffset = { x: event.clientX - rect.left, y: event.clientY - rect.top }
        dragOrigin = { x: event.clientX, y: event.clientY }

        // Захват указателя есть не везде (и не всегда нужен): без него
        // перетаскивание продолжает работать, просто курсор может уйти за
        // пределы кнопки.
        button.setPointerCapture?.(event.pointerId)
    })

    button.addEventListener('pointermove', event => {
        if (pointerId !== event.pointerId) {
            return
        }

        if (!dragging) {
            const moved = Math.hypot(event.clientX - dragOrigin.x, event.clientY - dragOrigin.y)

            // Порог нужен, иначе дрожь руки при клике уводила бы кнопку.
            if (moved < DRAG_THRESHOLD_PX) {
                return
            }

            dragging = true
            button.classList.add('yl-dragging')
        }

        applyPosition({ x: event.clientX - grabOffset.x, y: event.clientY - grabOffset.y })
        event.preventDefault()
    })

    const finishDrag = (event: PointerEvent) => {
        if (pointerId !== event.pointerId) {
            return
        }

        pointerId = null

        if (button.hasPointerCapture?.(event.pointerId)) {
            button.releasePointerCapture(event.pointerId)
        }

        if (!dragging) {
            return
        }

        dragging = false
        button.classList.remove('yl-dragging')

        if (position) {
            savePosition(position)
        }

        // Перетаскивание заканчивается там же, где началось, поэтому браузер
        // пришлёт `click` — открывать оверлей после переноса кнопки нельзя.
        suppressClick = true
    }

    button.addEventListener('pointerup', finishDrag)
    button.addEventListener('pointercancel', finishDrag)

    button.addEventListener('click', event => {
        if (suppressClick) {
            suppressClick = false
            event.preventDefault()
            event.stopPropagation()
            return
        }

        event.preventDefault()
        event.stopPropagation()
        onClick()
    })

    document.body.appendChild(button)

    const saved = readSavedPosition()

    if (saved) {
        applyPosition(saved)
    } else {
        window.requestAnimationFrame(placeDefault)
    }

    const handleResize = () => {
        if (position) {
            applyPosition(position)
        }
    }

    window.addEventListener('resize', handleResize)

    return {
        setVisible: visible => {
            button.hidden = !visible
        },
        dispose: () => {
            window.removeEventListener('resize', handleResize)
            button.remove()
        },
    }
}
