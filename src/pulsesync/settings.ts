/**
 * Чтение пользовательских настроек аддона.
 *
 * PulseSync отдаёт значения по имени аддона в виде стора с `getCurrent()` и
 * `onChange()`. Каждое значение может прийти как «сырое» (`true`) или как
 * обёртка `{ value, default }` — обе формы нужно уметь разворачивать.
 */

import type { AddonSettings, AddonSettingsStore } from '@pulsesync/yamusic-types'

import addonConfig from '../../addon.config.mjs'

export type BackgroundMode = 'dynamic' | 'static' | 'off'

export type AddonOptions = {
    enabled: boolean
    backgroundMode: BackgroundMode
    backgroundBlur: number
    wordSync: boolean
    blurInactive: boolean
    lineHoverBackground: boolean
    offsetMs: number
    gradientDegrees: number
    useSystemFont: boolean
    controlsPosition: 'top' | 'bottom'
    showFloatingButton: boolean
    hotkey: string
}

export const DEFAULT_OPTIONS: AddonOptions = {
    enabled: true,
    backgroundMode: 'dynamic',
    backgroundBlur: 90,
    wordSync: true,
    blurInactive: true,
    lineHoverBackground: true,
    offsetMs: 0,
    gradientDegrees: 90,
    useSystemFont: false,
    controlsPosition: 'bottom',
    showFloatingButton: true,
    hotkey: 'KeyL',
}

function unwrap<T>(entry: unknown, fallback: T): T {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const record = entry as { value?: unknown; default?: unknown }

        if (typeof record.value !== 'undefined') {
            return record.value as T
        }

        if (typeof record.default !== 'undefined') {
            return record.default as T
        }
    }

    return typeof entry !== 'undefined' ? (entry as T) : fallback
}

function readBoolean(settings: AddonSettings, key: string, fallback: boolean): boolean {
    const value = unwrap(settings[key], fallback)
    if (typeof value === 'string') {
        return value === 'true' || value === '1'
    }

    return Boolean(value)
}

function readNumber(settings: AddonSettings, key: string, fallback: number): number {
    const value = Number(unwrap(settings[key], fallback))
    return Number.isFinite(value) ? value : fallback
}

function readString(settings: AddonSettings, key: string, fallback: string): string {
    const value = unwrap(settings[key], fallback)
    return typeof value === 'string' && value ? value : fallback
}

function readBackgroundMode(settings: AddonSettings): BackgroundMode {
    const value = readString(settings, 'backgroundMode', DEFAULT_OPTIONS.backgroundMode)
    return value === 'static' || value === 'off' ? value : 'dynamic'
}

export function toOptions(settings: AddonSettings): AddonOptions {
    return {
        enabled: readBoolean(settings, 'enabled', DEFAULT_OPTIONS.enabled),
        backgroundMode: readBackgroundMode(settings),
        backgroundBlur: readNumber(settings, 'backgroundBlur', DEFAULT_OPTIONS.backgroundBlur),
        wordSync: readBoolean(settings, 'wordSync', DEFAULT_OPTIONS.wordSync),
        blurInactive: readBoolean(settings, 'blurInactive', DEFAULT_OPTIONS.blurInactive),
        lineHoverBackground: readBoolean(settings, 'lineHoverBackground', DEFAULT_OPTIONS.lineHoverBackground),
        offsetMs: readNumber(settings, 'offsetMs', DEFAULT_OPTIONS.offsetMs),
        gradientDegrees: readNumber(settings, 'gradientDegrees', DEFAULT_OPTIONS.gradientDegrees),
        useSystemFont: readBoolean(settings, 'useSystemFont', DEFAULT_OPTIONS.useSystemFont),
        controlsPosition: readString(settings, 'controlsPosition', 'bottom') === 'top' ? 'top' : 'bottom',
        showFloatingButton: readBoolean(settings, 'showFloatingButton', DEFAULT_OPTIONS.showFloatingButton),
        hotkey: readString(settings, 'hotkey', DEFAULT_OPTIONS.hotkey),
    }
}

export type SettingsStore = AddonSettingsStore<AddonSettings>

/** Стор настроек аддона; при отсутствии API отдаёт пустой объект. */
export function getSettingsStore(): SettingsStore {
    return (
        window.pulsesyncApi?.getSettings<AddonSettings>(addonConfig.name) ?? {
            getCurrent: () => ({}),
            onChange: () => () => {},
        }
    )
}
