/**
 * Панель управления в полноэкранном слое лирики.
 *
 * Кнопки сделаны иконками без внешних шрифтов: аддон не должен тянуть
 * ассеты, которых может не оказаться рядом.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

type IconPath = {
    /** Координаты в системе 24×24. */
    d: string
}

const ICONS: Record<string, IconPath> = {
    close: { d: 'M6.4 5 5 6.4l5.6 5.6L5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z' },
    karaoke: {
        d: 'M12 2a5 5 0 0 0-5 5v6a5 5 0 0 0 10 0V7a5 5 0 0 0-5-5zm0 2a3 3 0 0 1 3 3v1H9V7a3 3 0 0 1 3-3zM9 13v-1h6v1a3 3 0 0 1-6 0zm-1 5.8A7 7 0 0 1 5 13h2a5 5 0 0 0 10 0h2a7 7 0 0 1-3 5.7V21h-2v-1h-4v1H8z',
    },
    blur: {
        d: 'M12 3c-4 4.6-7 8-7 11a7 7 0 0 0 14 0c0-3-3-6.4-7-11zm0 15.5A4.5 4.5 0 0 1 7.5 14c0-1.9 1.9-4.4 4.5-7.4 2.6 3 4.5 5.5 4.5 7.4a4.5 4.5 0 0 1-4.5 4.5z',
    },
    minus: { d: 'M5 11h14v2H5z' },
    plus: { d: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z' },
    reset: {
        d: 'M12 5V2L7.5 6 12 10V7a5 5 0 1 1-4.8 6.4H5.1A7 7 0 1 0 12 5zm3 2.5 2.5 2.5L15 12.5 13.9 11.4l.4-.4H11V9.5h3.3l-.4-.4z',
    },
}

function createIcon(name: keyof typeof ICONS): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('focusable', 'false')

    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', ICONS[name].d)
    svg.appendChild(path)

    return svg
}

function createButton(label: string, icon: keyof typeof ICONS): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'yl-button'
    button.setAttribute('aria-label', label)
    button.title = label
    button.appendChild(createIcon(icon))
    return button
}

/** Шаг сдвига синхронизации кнопками `−` и `+`. */
const OFFSET_STEP_MS = 100

export type ControlsCallbacks = {
    onClose: () => void
    onToggleWordSync: () => void
    onToggleBlur: () => void
    onShiftOffset: (deltaMs: number) => void
    /** Вернуть настройки к значениям из панели PulseSync. */
    onResetSettings: () => void
}

export type ControlsState = {
    wordSync: boolean
    blurInactive: boolean
    offsetMs: number
}

export type ControlsHandle = {
    /** Приводит кнопки в соответствие с настройками. */
    sync: (state: ControlsState) => void
    dispose: () => void
}

/** Сдвиг в секундах со знаком: «+0.3 с», «0.0 с», «−0.3 с». */
function formatOffset(offsetMs: number): string {
    const seconds = offsetMs / 1000

    if (seconds === 0) {
        return '0.0 с'
    }

    // Минус типографский: обычный дефис рядом с цифрами читается как тире.
    return `${seconds > 0 ? '+' : '−'}${Math.abs(seconds).toFixed(1)} с`
}

/** Собирает панель управления и возвращает ручку для обновления и удаления. */
export function createControls(root: HTMLElement, callbacks: ControlsCallbacks): ControlsHandle {
    const bar = document.createElement('div')
    bar.className = 'yl-controls'

    const close = createButton('Закрыть (Esc)', 'close')
    close.addEventListener('click', () => callbacks.onClose())

    const karaoke = createButton('Пословная подсветка', 'karaoke')
    karaoke.addEventListener('click', () => callbacks.onToggleWordSync())

    const offsetBack = createButton(`Текст раньше на ${OFFSET_STEP_MS / 1000} с`, 'minus')
    offsetBack.addEventListener('click', () => callbacks.onShiftOffset(-OFFSET_STEP_MS))

    // Между кнопками — текущее значение: без него непонятно, насколько текст
    // уже сдвинут, а на слух это неочевидно.
    const offsetValue = document.createElement('span')
    offsetValue.className = 'yl-offset-value'
    offsetValue.textContent = formatOffset(0)

    const offsetForward = createButton(`Текст позже на ${OFFSET_STEP_MS / 1000} с`, 'plus')
    offsetForward.addEventListener('click', () => callbacks.onShiftOffset(OFFSET_STEP_MS))

    const offsetGroup = document.createElement('div')
    offsetGroup.className = 'yl-offset'
    offsetGroup.append(offsetBack, offsetValue, offsetForward)

    const blur = createButton('Размытие неактивных строк', 'blur')
    blur.addEventListener('click', () => callbacks.onToggleBlur())

    const reset = createButton('Сбросить настройки', 'reset')
    reset.addEventListener('click', () => callbacks.onResetSettings())

    bar.append(close, karaoke, offsetGroup, blur, reset)
    root.appendChild(bar)

    return {
        // Состояние кнопок — производная от настроек, а не собственный флаг:
        // иначе после переключения в панели PulseSync кнопка показывала бы
        // противоположное тому, что происходит с текстом.
        sync: ({ wordSync, blurInactive, offsetMs }) => {
            karaoke.setAttribute('aria-pressed', String(wordSync))
            blur.setAttribute('aria-pressed', String(blurInactive))

            offsetValue.textContent = formatOffset(offsetMs)
            offsetValue.title =
                offsetMs === 0 ? 'Сдвига нет' : `Текст сдвинут на ${formatOffset(offsetMs)}`
            offsetGroup.dataset.shifted = String(offsetMs !== 0)
        },
        dispose: () => bar.remove(),
    }
}
