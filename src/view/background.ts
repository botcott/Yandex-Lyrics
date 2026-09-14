/**
 * Динамический фон из обложки трека.
 *
 * Обложка сильно уменьшается на скрытом canvas (это даёт размытие и
 * «расплывание» цвета), затем растягивается на видимый canvas. Движение
 * добавляется CSS-анимацией по самому canvas — это дешевле, чем
 * перерисовывать кадры в JS, и не грузит основной поток.
 *
 * Если WebGL/2D недоступны или картинка не загрузилась, используется
 * запасной слой `.yl-bg-image` с CSS-размытием.
 */

/** До какого размера сжимаем обложку перед растягиванием. */
const SAMPLE_SIZE = 32
/** Размер запрашиваемой обложки Яндекс Музыки. */
const COVER_SIZE = '400x400'
/**
 * Насколько осветлить акцент перед покраской текста.
 *
 * Средний цвет обложки почти всегда темнее, чем нужно для читаемой подсветки
 * на тёмной подложке, поэтому он подмешивается к белому.
 */
const ACCENT_LIGHTEN = 0.55

export type BackgroundMode = 'dynamic' | 'static' | 'off'

type Rgb = { r: number; g: number; b: number }

/**
 * Приводит `coverUri` Яндекс Музыки к URL картинки.
 *
 * В мете трека лежит шаблон вида
 * `avatars.yandex.net/get-music-content/1234/abc/%%` — `%%` заменяется
 * на размер, схема протокола добавляется.
 */
export function resolveCoverUrl(coverUri?: string | null, size: string = COVER_SIZE): string | null {
    if (!coverUri) {
        return null
    }

    const withSize = coverUri.replace('%%', size)
    return withSize.startsWith('http') ? withSize : `https://${withSize}`
}

export class DynamicBackground {
    private readonly layer: HTMLElement
    private readonly canvas: HTMLCanvasElement
    private readonly fallbackImage: HTMLDivElement
    private readonly context: CanvasRenderingContext2D | null

    private mode: BackgroundMode = 'dynamic'
    private currentUrl: string | null = null
    private loadToken = 0
    private accent: Rgb | null = null

    constructor(layer: HTMLElement) {
        this.layer = layer

        this.canvas = document.createElement('canvas')
        this.canvas.className = 'yl-bg-canvas'
        this.canvas.width = SAMPLE_SIZE
        this.canvas.height = SAMPLE_SIZE

        this.fallbackImage = document.createElement('div')
        this.fallbackImage.className = 'yl-bg-image'
        this.fallbackImage.style.opacity = '0'

        // Вставляем перед затемняющим слоем, чтобы скрим остался сверху.
        const scrim = layer.querySelector('.yl-bg-scrim')
        layer.insertBefore(this.canvas, scrim)
        layer.insertBefore(this.fallbackImage, scrim)

        this.context = this.canvas.getContext('2d', { willReadFrequently: false })
    }

    /**
     * Цвет подсветки текста, выведенный из обложки, либо `null`, если обложки
     * ещё нет или canvas недоступен.
     */
    getAccentColor(): string | null {
        if (!this.accent) {
            return null
        }

        const mix = (channel: number) => Math.round(channel + (255 - channel) * ACCENT_LIGHTEN)

        return `rgb(${mix(this.accent.r)}, ${mix(this.accent.g)}, ${mix(this.accent.b)})`
    }

    setMode(mode: BackgroundMode): void {
        this.mode = mode
        this.layer.dataset.mode = mode

        if (mode === 'off') {
            this.canvas.style.opacity = '0'
            this.fallbackImage.style.opacity = '0'
            return
        }

        if (mode === 'static') {
            this.canvas.style.opacity = '0'
            this.fallbackImage.style.opacity = this.currentUrl ? '1' : '0'
            return
        }

        // dynamic
        this.fallbackImage.style.opacity = this.context ? '0' : this.currentUrl ? '1' : '0'
        this.canvas.style.opacity = this.context && this.currentUrl ? '1' : '0'
    }

    /**
     * Меняет обложку. Повторный вызов с тем же URL ничего не делает.
     * Пока картинка грузится, старая остаётся на месте — переход без «мигания».
     */
    async setCover(coverUri?: string | null): Promise<void> {
        const url = resolveCoverUrl(coverUri)
        if (url === this.currentUrl) {
            return
        }

        this.currentUrl = url

        if (!url) {
            this.canvas.style.opacity = '0'
            this.fallbackImage.style.opacity = '0'
            return
        }

        this.fallbackImage.style.backgroundImage = `url("${url}")`

        const token = ++this.loadToken

        try {
            const image = await this.loadImage(url)
            // Пока грузились, трек мог смениться.
            if (token !== this.loadToken) {
                return
            }

            this.draw(image)
        } catch {
            if (token !== this.loadToken) {
                return
            }

            console.debug('[Yandex Lyrics] Не удалось загрузить обложку для фона:', url)
            this.canvas.style.opacity = '0'
            if (this.mode !== 'off') {
                this.fallbackImage.style.opacity = '1'
            }
        }
    }

    private loadImage(url: string): Promise<HTMLImageElement> {
        return new Promise((resolve, reject) => {
            const image = new Image()
            image.crossOrigin = 'anonymous'
            image.decoding = 'async'

            image.addEventListener('load', () => resolve(image), { once: true })
            image.addEventListener('error', () => reject(new Error(`Не загрузилась обложка: ${url}`)), { once: true })

            image.src = url
        })
    }

    /** Сжимает обложку в маленький canvas — отсюда берётся мягкий градиент. */
    private draw(image: HTMLImageElement): void {
        const context = this.context

        if (!context) {
            if (this.mode !== 'off') {
                this.fallbackImage.style.opacity = '1'
            }
            return
        }

        context.clearRect(0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
        try {
            context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
        } catch (error) {
            // Рисование может упасть на «загрязнённой» канве (CORS).
            console.debug('[Yandex Lyrics] Не удалось отрисовать обложку:', error)
            this.canvas.style.opacity = '0'
            if (this.mode !== 'off') {
                this.fallbackImage.style.opacity = '1'
            }
            return
        }

        this.accent = this.extractAccent(context)

        if (this.mode === 'dynamic') {
            this.canvas.style.opacity = '1'
            this.fallbackImage.style.opacity = '0'
        } else if (this.mode === 'static') {
            this.canvas.style.opacity = '0'
            this.fallbackImage.style.opacity = '1'
        }
    }

    /**
     * Средний цвет обложки с отброшенными крайностями.
     *
     * Совсем тёмные и совсем светлые пиксели пропускаются — иначе почти
     * любая обложка даёт грязно-серый «акцент».
     */
    private extractAccent(context: CanvasRenderingContext2D): Rgb | null {
        let data: Uint8ClampedArray

        try {
            data = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data
        } catch {
            return null
        }

        let r = 0
        let g = 0
        let b = 0
        let count = 0

        for (let index = 0; index < data.length; index += 4) {
            const red = data[index]
            const green = data[index + 1]
            const blue = data[index + 2]

            const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue
            if (luma < 30 || luma > 225) {
                continue
            }

            r += red
            g += green
            b += blue
            count++
        }

        if (count === 0) {
            return null
        }

        return {
            r: Math.round(r / count),
            g: Math.round(g / count),
            b: Math.round(b / count),
        }
    }

    destroy(): void {
        this.loadToken++
        this.canvas.remove()
        this.fallbackImage.remove()
        this.accent = null
        this.currentUrl = null
    }
}
