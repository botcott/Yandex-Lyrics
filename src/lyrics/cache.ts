/**
 * Мини-обёртка над IndexedDB для кэша лирики.
 *
 * Хранится сырой текст (LRC или plain), а не разобранная структура: так
 * изменения в парсере не требуют сброса кэша у пользователей.
 */

const DB_NAME = 'yandex-lyrics'
const DB_VERSION = 1
const STORE = 'lyrics'
/** Сколько записей держим — тексты песен весят мало, но кэш не должен расти вечно. */
const MAX_ENTRIES = 600
/** Срок жизни записи, мс. */
const TTL_MS = 90 * 24 * 60 * 60 * 1000

export type CachedLyrics = {
    trackId: string
    text: string
    format: 'LRC' | 'TEXT'
    source: string
    writers: string[]
    savedAt: number
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDatabase(): Promise<IDBDatabase | null> {
    if (dbPromise) {
        return dbPromise
    }

    dbPromise = new Promise(resolve => {
        if (typeof indexedDB === 'undefined') {
            resolve(null)
            return
        }

        const request = indexedDB.open(DB_NAME, DB_VERSION)

        request.addEventListener('upgradeneeded', () => {
            const db = request.result
            if (!db.objectStoreNames.contains(STORE)) {
                const store = db.createObjectStore(STORE, { keyPath: 'trackId' })
                store.createIndex('savedAt', 'savedAt')
            }
        })

        request.addEventListener('success', () => resolve(request.result))
        request.addEventListener('error', () => resolve(null))
        request.addEventListener('blocked', () => resolve(null))
    })

    return dbPromise
}

function runTransaction<T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
    return openDatabase().then(
        db =>
            new Promise<T | null>(resolve => {
                if (!db) {
                    resolve(null)
                    return
                }

                try {
                    const transaction = db.transaction(STORE, mode)
                    const request = action(transaction.objectStore(STORE))
                    request.addEventListener('success', () => resolve(request.result))
                    request.addEventListener('error', () => resolve(null))
                } catch {
                    resolve(null)
                }
            })
    )
}

export async function readCache(trackId: string): Promise<CachedLyrics | null> {
    const record = await runTransaction<CachedLyrics>('readonly', store => store.get(trackId))

    if (!record) {
        return null
    }

    if (Date.now() - record.savedAt > TTL_MS) {
        void deleteCache(trackId)
        return null
    }

    return record
}

export async function writeCache(entry: Omit<CachedLyrics, 'savedAt'>): Promise<void> {
    await runTransaction('readwrite', store => store.put({ ...entry, savedAt: Date.now() }))
    void pruneCache()
}

export async function deleteCache(trackId: string): Promise<void> {
    await runTransaction('readwrite', store => store.delete(trackId))
}

/** Убирает старые записи, если кэш разросся. */
async function pruneCache(): Promise<void> {
    const db = await openDatabase()
    if (!db) {
        return
    }

    try {
        const count = await runTransaction<number>('readonly', store => store.count())
        if (count == null || count <= MAX_ENTRIES) {
            return
        }

        const transaction = db.transaction(STORE, 'readwrite')
        const store = transaction.objectStore(STORE)
        const cursorRequest = store.index('savedAt').openCursor()
        let toDelete = count - MAX_ENTRIES

        cursorRequest.addEventListener('success', () => {
            const cursor = cursorRequest.result
            if (!cursor || toDelete <= 0) {
                return
            }

            cursor.delete()
            toDelete--
            cursor.continue()
        })
    } catch {
        // Кэш — не критичная часть, ошибки уборки игнорируем.
    }
}
