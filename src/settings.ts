export type Kind = 'outlines' | 'borders' | 'labels';
export type IconKind = 'lightning' | 'snow' | 'hail';
export type InkTarget = 'all' | 'dark' | 'light';

export interface KindStyle {
    /** False until the user changes something, so an untouched plugin never fights Windy's own styling. */
    touched: boolean;
    visible: boolean;
    recolor: boolean;
    color: string;
    /** Which pixels of a baked (raster) tile get the new colour. */
    ink: InkTarget;
    /** Line thickness multiplier: 1 = original, 2 = dilate 1px, 3 = dilate 2px, etc. */
    thickness: number;
    /** Manual list of map layer ids. Empty means "auto-detect by name". */
    layerIds: string[];
    /** Manual tile URL prefix (everything before /z/x/y). Empty means "read it from the layer's source". */
    tilePrefix: string;
}

export interface IconStyle {
    /** The user's replacement image, downscaled, as a data URL. */
    dataUrl: string | null;
    /** The Windy texture URL this replaces (picked from the scan list). */
    textureUrl: string;
}

export interface Settings {
    version: 1;
    background: { enabled: boolean; color: string; hideWindyFill: boolean };
    kinds: Record<Kind, KindStyle>;
    icons: Record<IconKind, IconStyle>;
}

export const STORAGE_KEY = 'windy-plugin-map-style:v1';

const kind = (color: string, ink: InkTarget): KindStyle => ({
    touched: false,
    visible: true,
    recolor: false,
    color,
    ink,
    thickness: 1,
    layerIds: [],
    tilePrefix: '',
});

export const defaults = (): Settings => ({
    version: 1,
    background: { enabled: false, color: '#1b2430', hideWindyFill: false },
    kinds: {
        outlines: kind('#ffffff', 'all'),
        borders: kind('#ffd166', 'all'),
        labels: kind('#ffffff', 'dark'),
    },
    icons: {
        lightning: { dataUrl: null, textureUrl: '' },
        snow: { dataUrl: null, textureUrl: '' },
        hail: { dataUrl: null, textureUrl: '' },
    },
});

function merge<T>(base: T, over: any): T {
    if (!over || typeof over !== 'object') {
        return base;
    }
    const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
    for (const key of Object.keys(over)) {
        const b = (base as any)[key];
        const o = over[key];
        if (b && typeof b === 'object' && !Array.isArray(b) && o && typeof o === 'object') {
            out[key] = merge(b, o);
        } else if (b === undefined || b === null || typeof b === typeof o) {
            out[key] = o;
        }
    }
    return out;
}

export function loadSettings(): Settings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? merge(defaults(), JSON.parse(raw)) : defaults();
    } catch {
        return defaults();
    }
}

/** Returns false if the browser refused the write (storage full or blocked). */
export function saveSettings(s: Settings): boolean {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
        return true;
    } catch {
        return false;
    }
}
