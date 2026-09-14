/**
 * Получение официальной лирики Яндекс Музыки.
 *
 * Эндпоинт `/tracks/{id}/lyrics` закрыт двумя барьерами:
 *  1. Подпись — `base64(HMAC-SHA256(key, "{trackId}{timestamp}"))` плюс сам
 *     `timeStamp`. Ключ жёстко привязан к заголовку `X-Yandex-Music-Client`:
 *     с чужим заголовком сервис отвечает `403 Invalid Sign`. Padding у base64
 *     обрезать нельзя.
 *  2. Авторизация — `Authorization: OAuth <token>`.
 *
 * Токен аддон не хранит и не спрашивает у пользователя: он берётся из того же
 * хранилища, что использует клиент (`localStorage.oauth`), а если там пусто —
 * пассивно подслушивается из запросов клиента. Это значит, что аддон работает
 * ровно с теми же правами, что и сам клиент.
 */

const API_BASE = 'https://api.music.yandex.net'

/** Ключ, под которым клиент Яндекс Музыки хранит OAuth-токен. */
const TOKEN_STORAGE_KEY = 'oauth'

/** Пары «заголовок клиента + ключ подписи». Ключ валиден только со своим заголовком. */
type ClientProfile = {
    header: string
    key: string
}

const CLIENT_PROFILES: Record<string, ClientProfile> = {
    windows: { header: 'YandexMusicDesktopAppWindows/5.119.0', key: 'kzqU4XhfCaY6B6JTHODeq5' },
    linux: { header: 'YandexMusicDesktopAppLinux/5.119.0', key: 'uVNvVMAvdrvjtwN0VlhEt2' },
    macos: { header: 'YandexMusicDesktopAppMacOS/5.119.0', key: 'uz0zSpaYCLmgk6C7YLdo5F' },
    android: { header: 'YandexMusicAndroid/24023621', key: 'p93jhgh689SBReK6ghtw62' },
}

/** Порядок перебора: сначала «своя» платформа, потом универсальный мобильный клиент. */
function profileOrder(): ClientProfile[] {
    const platform = (window.pulsesyncApi?.getPlatform?.() ?? navigator.userAgent).toLowerCase()

    const native = platform.includes('win')
        ? CLIENT_PROFILES.windows
        : platform.includes('mac') || platform.includes('darwin')
          ? CLIENT_PROFILES.macos
          : platform.includes('linux')
            ? CLIENT_PROFILES.linux
            : null

    return native ? [native, CLIENT_PROFILES.android] : [CLIENT_PROFILES.android]
}

export type LyricsFormat = 'LRC' | 'TEXT'

export type YandexLyrics = {
    /** Содержимое текста (LRC с таймкодами либо просто текст). */
    text: string
    format: LyricsFormat
    /** Авторы текста, если сервис их отдал. */
    writers: string[]
    /** Источник текста (`major`), например `Yandex` или `Musixmatch`. */
    provider?: string
}

/**
 * Ответ эндпоинта лирики. Форма зависит от заголовка клиента: мобильный
 * заворачивает данные в `result`, десктопный отдаёт их на верхнем уровне.
 */
type LyricsMetaResponse = {
    downloadUrl?: string
    writers?: string[]
    major?: { name?: string }
    result?: {
        downloadUrl?: string
        writers?: string[]
        major?: { name?: string }
    }
}

/* ───────────────────────── Токен ───────────────────────── */

let sniffedToken: string | null = null
let snifferInstalled = false

function extractTokenFromHeaders(headers: unknown): void {
    if (!headers) {
        return
    }

    if (headers instanceof Headers) {
        noteAuthValue(headers.get('Authorization') ?? headers.get('authorization'))
        return
    }

    if (Array.isArray(headers)) {
        for (const entry of headers) {
            const [name, value] = entry as [unknown, unknown]
            if (String(name).toLowerCase() === 'authorization') {
                noteAuthValue(String(value))
            }
        }
        return
    }

    if (typeof headers === 'object') {
        for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
            if (name.toLowerCase() === 'authorization') {
                noteAuthValue(String(value))
            }
        }
    }
}

function noteAuthValue(value: string | null): void {
    if (!value) {
        return
    }

    const match = /^(?:OAuth|Bearer)\s+(.+)$/i.exec(value.trim())
    if (match) {
        sniffedToken = match[1]
    }
}

/**
 * Начинает слушать исходящие запросы клиента в поисках OAuth-токена.
 *
 * Это запасной путь: обычно токен уже лежит в `localStorage`. Патчи
 * максимально осторожные — любая ошибка внутри сниффера проглатывается,
 * чтобы не сломать запросы самого клиента.
 */
export function startTokenSniffing(): void {
    if (snifferInstalled) {
        return
    }
    snifferInstalled = true

    const originalFetch = window.fetch
    if (typeof originalFetch === 'function') {
        window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit) {
            try {
                extractTokenFromHeaders(init?.headers)
                if (!sniffedToken && input instanceof Request) {
                    extractTokenFromHeaders(input.headers)
                }
            } catch {
                // Перехват не должен влиять на сам запрос.
            }

            return originalFetch.call(this, input as RequestInfo, init)
        }
    }

    const proto = XMLHttpRequest.prototype
    // У `open` две перегрузки — приводим к общей форме, чтобы сохранить вызов
    // с любым набором аргументов. Поведение самого метода не меняется.
    const originalOpen = proto.open as (
        this: XMLHttpRequest,
        ...args: unknown[]
    ) => void
    const originalSetHeader = proto.setRequestHeader

    proto.open = function patchedOpen(this: XMLHttpRequest, ...args: unknown[]) {
        return originalOpen.apply(this, args)
    }

    proto.setRequestHeader = function patchedSetHeader(this: XMLHttpRequest, name: string, value: string) {
        extractTokenFromHeaders([[name, value]])
        return originalSetHeader.call(this, name, value)
    }
}

/** OAuth-токен клиента либо `null`, если его ещё не видно. */
export function getAuthToken(): string | null {
    if (sniffedToken) {
        return sniffedToken
    }

    try {
        const stored = window.localStorage?.getItem(TOKEN_STORAGE_KEY)
        if (stored) {
            return stored
        }
    } catch {
        // localStorage может быть недоступен — не критично, есть сниффер.
    }

    return null
}

/* ───────────────────────── Подпись ───────────────────────── */

/** `12345:6789` -> `12345`. */
function normalizeTrackId(trackId: string): string {
    return String(trackId).split(':')[0]
}

async function signTrackId(trackId: string, timestamp: number, key: string): Promise<string> {
    const encoder = new TextEncoder()

    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        encoder.encode(key),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    )

    const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(`${trackId}${timestamp}`))

    let binary = ''
    for (const byte of new Uint8Array(signature)) {
        binary += String.fromCharCode(byte)
    }

    // Padding обязателен: без него сервис отвечает `403 Invalid Sign`.
    return btoa(binary)
}

/* ───────────────────────── Запросы ───────────────────────── */

async function requestLyrics(
    trackId: string,
    format: LyricsFormat,
    token: string,
    profile: ClientProfile
): Promise<YandexLyrics | null> {
    const timestamp = Math.floor(Date.now() / 1000)
    const sign = await signTrackId(trackId, timestamp, profile.key)

    const url =
        `${API_BASE}/tracks/${encodeURIComponent(trackId)}/lyrics` +
        `?format=${format}&timeStamp=${timestamp}&sign=${encodeURIComponent(sign)}`

    const response = await fetch(url, {
        headers: {
            Authorization: `OAuth ${token}`,
            'X-Yandex-Music-Client': profile.header,
        },
    })

    if (!response.ok) {
        return null
    }

    const payload = (await response.json()) as LyricsMetaResponse
    const meta = payload.result ?? payload
    const downloadUrl = meta.downloadUrl

    if (!downloadUrl) {
        return null
    }

    const textResponse = await fetch(downloadUrl)
    if (!textResponse.ok) {
        return null
    }

    const text = await textResponse.text()
    if (!text.trim()) {
        return null
    }

    return {
        text,
        format,
        writers: meta.writers ?? [],
        provider: meta.major?.name,
    }
}

/**
 * Забирает лирику трека.
 *
 * Возвращает `null`, если текста нет или ни один профиль клиента не подошёл —
 * вызывающая сторона в этом случае пробует следующий источник.
 */
export async function fetchYandexLyrics(trackId: string, format: LyricsFormat = 'LRC'): Promise<YandexLyrics | null> {
    const token = getAuthToken()
    if (!token) {
        return null
    }

    const normalizedId = normalizeTrackId(trackId)

    for (const profile of profileOrder()) {
        const result = await requestLyrics(normalizedId, format, token, profile)
        if (result) {
            return result
        }
    }

    return null
}
