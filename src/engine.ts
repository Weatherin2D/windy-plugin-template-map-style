import { map, toggleLandSeaMaskColored } from '@windy/map';
import { defaults, loadSettings, saveSettings } from './settings';
import type { IconKind, InkTarget, Kind, Settings } from './settings';

export type { IconKind, Kind, Settings };

const win = window as any;

export const KINDS: Kind[] = ['outlines', 'borders', 'labels'];
export const ICONS: IconKind[] = ['lightning', 'snow', 'hail'];

/** Mutable, shared with the UI. Call commit() after changing it. */
export const settings: Settings = loadSettings();

/* ------------------------------------------------------------------ */
/* Map access                                                          */
/* ------------------------------------------------------------------ */

/**
 * Returns the MapLibre map instance.
 * Diagnostics confirmed the property is _maplibreMap (with underscore).
 */
const ml = (): any => {
    const m: any = map;
    if (!m) return null;
    return m._maplibreMap ?? m.maplibreMap ?? m;
};

export interface LayerInfo {
    id: string;
    type: string;
    source: string;
}

export function listLayers(): LayerInfo[] {
    try {
        const layers = ml()?.getStyle?.()?.layers ?? [];
        return layers.map((l: any) => ({ id: String(l.id), type: String(l.type), source: String(l.source ?? '') }));
    } catch {
        return [];
    }
}

/* Name-based guesses for auto-detection. The Inspector lets you assign layers manually. */
const WEATHER = /weather|particle|radar|satellite|overlay|isoline|hurricane|airspace|main|mask|poi/i;
const PATTERNS: [Kind, RegExp][] = [
    ['labels', /label|place|name|city|text/i],
    ['borders', /border|bound|countr|state|admin|province/i],
    ['outlines', /coast|outline|shore|water|sea|ocean|lake|land/i],
];

function classify(id: string): Kind | null {
    if (WEATHER.test(id)) {
        return null;
    }
    for (const [kind, re] of PATTERNS) {
        if (re.test(id)) {
            return kind;
        }
    }
    return null;
}

export function resolveLayers(kind: Kind): LayerInfo[] {
    const all = listLayers();
    const manual = settings.kinds[kind].layerIds;
    return manual.length ? all.filter(l => manual.includes(l.id)) : all.filter(l => classify(l.id) === kind);
}

function sourceTiles(sourceId: string): string[] {
    try {
        const s = ml()?.getSource?.(sourceId);
        const o = s?.serialize?.() ?? s;
        return (o?.tiles ?? s?.tiles ?? []) as string[];
    } catch {
        return [];
    }
}

const abs = (u: string): string => {
    try {
        return new URL(u, location.href).href;
    } catch {
        return u;
    }
};

const prefixOf = (template: string): string => {
    const i = template.indexOf('{');
    return i > 0 ? abs(template.slice(0, i)) : '';
};

/**
 * Known Windy raster tile prefixes, used as fallback when MapLibre layer
 * enumeration returns nothing (which happens with Windy's LeafletGL setup).
 */
const WINDY_TILE_DEFAULTS: Record<Kind, string> = {
    outlines: 'https://tiles.windy.com/tiles/',   // darkmap tiles contain outlines + borders
    borders:  'https://tiles.windy.com/tiles/',   // same source as outlines
    labels:   'https://tiles.windy.com/labels/',  // separate label tiles
};

export function effectivePrefix(kind: Kind): string {
    const k = settings.kinds[kind];
    if (k.tilePrefix) {
        return abs(k.tilePrefix);
    }
    for (const layer of resolveLayers(kind)) {
        if (layer.type !== 'raster') {
            continue;
        }
        const t = sourceTiles(layer.source)[0];
        const p = t ? prefixOf(t) : '';
        if (p) {
            return p;
        }
    }
    // Fall back to known Windy tile prefixes so recolouring works even when
    // MapLibre layer enumeration returns empty (Windy's LeafletGL wrapping).
    return WINDY_TILE_DEFAULTS[kind];
}

/* ------------------------------------------------------------------ */
/* Image helpers                                                       */
/* ------------------------------------------------------------------ */

function hexToRgb(hex: string): [number, number, number] {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    const n = m ? parseInt(m[1], 16) : 0xffffff;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function dataUrlToBlob(dataUrl: string): Blob {
    const [head, body] = dataUrl.split(',');
    const mime = /data:([^;]+)/.exec(head)?.[1] ?? 'image/png';
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
}

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
    });
}

/** Downscales a picked file so it fits comfortably in browser storage. */
export async function fileToIcon(file: File, max = 256): Promise<string> {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
}

interface RecolorRule {
    prefix: string;
    color: [number, number, number];
    ink: InkTarget;
}
interface IconRule {
    url: string;
    dataUrl: string;
}

/** Keeps the alpha channel, replaces the colour of the pixels the rule targets. */
async function recolorBlob(blob: Blob, rule: RecolorRule): Promise<Blob> {
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const g = canvas.getContext('2d')!;
    g.drawImage(bmp, 0, 0);
    const img = g.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    const [r, gr, b] = rule.color;
    for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) {
            continue;
        }
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (rule.ink === 'all' || (rule.ink === 'dark' && lum < 128) || (rule.ink === 'light' && lum >= 128)) {
            d[i] = r;
            d[i + 1] = gr;
            d[i + 2] = b;
        }
    }
    g.putImageData(img, 0, 0);
    return canvas.convertToBlob({ type: 'image/png' });
}

const iconCache = new Map<string, Promise<Blob>>();

/** Draws the user's image at the size of the original texture, so texture coordinates stay valid. */
function buildIconBlob(origFetch: typeof fetch, url: string, dataUrl: string): Promise<Blob> {
    const key = `${url}|${dataUrl.length}|${dataUrl.slice(-48)}`;
    let p = iconCache.get(key);
    if (!p) {
        p = (async () => {
            const user = await createImageBitmap(dataUrlToBlob(dataUrl));
            let w = user.width;
            let h = user.height;
            try {
                const res = await origFetch(url);
                if (res.ok) {
                    const o = await createImageBitmap(await res.blob());
                    w = o.width;
                    h = o.height;
                }
            } catch {
                /* keep the user's own size */
            }
            const c = new OffscreenCanvas(w, h);
            c.getContext('2d')!.drawImage(user, 0, 0, w, h);
            return c.convertToBlob({ type: 'image/png' });
        })();
        iconCache.set(key, p);
    }
    return p;
}

/* ------------------------------------------------------------------ */
/* Network interception (installed once per page, rules swapped live)  */
/* ------------------------------------------------------------------ */

function installInterceptors() {
    if (!win.__wmsOrigFetch) {
        win.__wmsOrigFetch = win.fetch.bind(win);
        win.fetch = async function (input: any, init?: any) {
            try {
                const rules = win.__wmsRules;
                const raw: string = typeof input === 'string' ? input : input?.url ?? '';
                if (rules && raw && !raw.startsWith('data:') && !raw.startsWith('blob:')) {
                    const url = abs(raw);
                    const bare = url.split('?')[0];
                    const icon = (rules.iconRules as IconRule[]).find(r => r.url === bare);
                    if (icon) {
                        const blob = await buildIconBlob(win.__wmsOrigFetch, url, icon.dataUrl);
                        return new Response(blob, { status: 200, headers: { 'Content-Type': 'image/png' } });
                    }
                    const rule = (rules.recolorRules as RecolorRule[]).find(r => url.startsWith(r.prefix));
                    if (rule) {
                        const res = await win.__wmsOrigFetch(input, init);
                        if (!res.ok) {
                            return res;
                        }
                        const out = await recolorBlob(await res.clone().blob(), rule);
                        return new Response(out, { status: 200, headers: { 'Content-Type': 'image/png' } });
                    }
                }
            } catch {
                /* fall through to the untouched request */
            }
            return win.__wmsOrigFetch(input, init);
        };
    }

    const proto = HTMLImageElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'src');
    if (desc?.set && !win.__wmsImgPatched) {
        win.__wmsImgPatched = true;
        Object.defineProperty(proto, 'src', {
            configurable: true,
            enumerable: desc.enumerable,
            get: desc.get,
            set(this: HTMLImageElement, value: string) {
                try {
                    const rules = win.__wmsRules;
                    if (rules && typeof value === 'string' && value && !value.startsWith('data:')) {
                        const url = abs(value);
                        const icon = (rules.iconRules as IconRule[]).find(r => r.url === url.split('?')[0]);
                        if (icon) {
                            buildIconBlob(win.__wmsOrigFetch, url, icon.dataUrl)
                                .then(blobToDataUrl)
                                .then(du => desc.set!.call(this, du))
                                .catch(() => desc.set!.call(this, value));
                            return;
                        }
                    }
                } catch {
                    /* use the original value */
                }
                desc.set!.call(this, value);
            },
        });
    }
}

let recolorRules: RecolorRule[] = [];
let iconRules: IconRule[] = [];
let lastRuleSig = '';

function rebuildRules() {
    recolorRules = [];
    for (const kind of KINDS) {
        const k = settings.kinds[kind];
        if (!k.touched || !k.recolor) {
            continue;
        }
        const prefix = effectivePrefix(kind);
        if (prefix && !recolorRules.some(r => r.prefix === prefix)) {
            recolorRules.push({ prefix, color: hexToRgb(k.color), ink: k.ink });
        }
    }
    iconRules = ICONS.filter(i => settings.icons[i].dataUrl && settings.icons[i].textureUrl).map(i => ({
        url: abs(settings.icons[i].textureUrl).split('?')[0],
        dataUrl: settings.icons[i].dataUrl as string,
    }));
    win.__wmsRules = { recolorRules, iconRules };
}

/** Forces MapLibre to re-request base map tiles so recolour rules take effect. */
function refreshTiles(prefixes: string[]) {
    const m = ml();
    if (!m || !prefixes.length) {
        return;
    }
    try {
        const sources = m.getStyle?.()?.sources ?? {};
        for (const id of Object.keys(sources)) {
            const tiles = sourceTiles(id);
            if (!tiles.length || !prefixes.some(p => tiles.some(t => abs(t).startsWith(p)))) {
                continue;
            }
            const src = m.getSource(id);
            if (typeof src?.setTiles === 'function') {
                const stamp = `_ms=${Date.now()}`;
                src.setTiles(tiles.map(t => t.replace(/[?&]_ms=\d+/, '') + (t.includes('?') ? '&' : '?') + stamp));
            } else {
                m.style?.sourceCaches?.[id]?.clearTiles?.();
            }
        }
        m.triggerRepaint?.();
    } catch {
        /* the Inspector will show whether tiles reloaded */
    }
}

/* ------------------------------------------------------------------ */
/* Applying settings                                                   */
/* ------------------------------------------------------------------ */

let originalBackground: string | null = null;
let fillHidden = false;
const originalPaint = new Map<string, unknown>();

function applyBackground() {
    const b = settings.background;

    // Apply background colour to the map container element
    const el: HTMLElement | null = (map as any)?.getContainer?.() ?? null;
    if (el) {
        if (originalBackground === null) {
            originalBackground = el.style.backgroundColor;
        }
        el.style.backgroundColor = b.enabled ? b.color : (originalBackground ?? '');
    }

    // Also set MapLibre background layer colour
    try {
        const m = ml();
        if (m) {
            for (const l of listLayers().filter(l => l.type === 'background')) {
                const key = `${l.id}|background-color`;
                if (!originalPaint.has(key)) {
                    originalPaint.set(key, m.getPaintProperty(l.id, 'background-color'));
                }
                m.setPaintProperty(l.id, 'background-color', b.enabled ? b.color : originalPaint.get(key));
            }
        }
    } catch {
        /* no background layer in this style */
    }

    const hide = b.enabled && b.hideWindyFill;
    if (hide !== fillHidden) {
        try {
            toggleLandSeaMaskColored(!hide);
            fillHidden = hide;
        } catch {
            /* not available */
        }
    }
}

const PAINT_PROPS: Record<string, string[]> = {
    line: ['line-color'],
    symbol: ['text-color', 'icon-color'],
    fill: ['fill-color', 'fill-outline-color'],
    circle: ['circle-color'],
};

function applyKind(kind: Kind) {
    const k = settings.kinds[kind];
    if (!k.touched) {
        return;
    }
    const m = ml();
    if (!m) {
        return;
    }
    for (const layer of resolveLayers(kind)) {
        try {
            m.setLayoutProperty(layer.id, 'visibility', k.visible ? 'visible' : 'none');
        } catch {
            /* layer vanished */
        }
        for (const prop of PAINT_PROPS[layer.type] ?? []) {
            const key = `${layer.id}|${prop}`;
            try {
                if (!originalPaint.has(key)) {
                    originalPaint.set(key, m.getPaintProperty(layer.id, prop));
                }
                m.setPaintProperty(layer.id, prop, k.recolor ? k.color : originalPaint.get(key));
            } catch {
                /* property not supported by this layer */
            }
        }
    }
}

function layerSignature(): string {
    return listLayers()
        .map(l => l.id)
        .join('|');
}

export function apply() {
    const before = recolorRules.map(r => r.prefix);
    rebuildRules();
    installInterceptors();
    applyBackground();
    KINDS.forEach(applyKind);
    const sig = JSON.stringify(recolorRules);
    if (sig !== lastRuleSig) {
        lastRuleSig = sig;
        refreshTiles([...new Set([...before, ...recolorRules.map(r => r.prefix)])]);
    }
}

/** Saves, then applies. Returns false if the browser would not store the settings. */
export function commit(): boolean {
    const ok = saveSettings(settings);
    apply();
    return ok;
}

export function resetAll() {
    const d = defaults();
    settings.background = d.background;
    settings.kinds = d.kinds;
    settings.icons = d.icons;
    saveSettings(settings);
    apply();
}

let started = false;
let lastLayerSig = '';

/** Safe to call every time the plugin opens. Effects stay in place after it closes. */
export function start() {
    try {
        performance.setResourceTimingBufferSize?.(2000);
    } catch {
        /* optional */
    }

    apply();
    lastLayerSig = layerSignature();

    if (started) {
        return;
    }
    started = true;

    // Re-apply whenever the map style changes (base map switch, zoom-level style swap, etc.)
    // LeafletGlMap fires 'load' on each full style load/reload.
    try {
        (map as any)?.on?.('load', () => {
            const sig = layerSignature();
            if (sig !== lastLayerSig) {
                lastLayerSig = sig;
                apply();
            }
        });
    } catch {
        /* ignore */
    }

    // Also listen for MapLibre's styledata event on the inner map object.
    try {
        ml()?.on?.('styledata', () => {
            const sig = layerSignature();
            if (sig !== lastLayerSig) {
                lastLayerSig = sig;
                apply();
            }
        });
    } catch {
        /* ignore */
    }
}

/* ------------------------------------------------------------------ */
/* Inspector                                                           */
/* ------------------------------------------------------------------ */

export interface ScanResult {
    layers: LayerInfo[];
    tilePrefixes: { prefix: string; count: number }[];
    images: { url: string; hint: IconKind | null }[];
}

const IMG_EXT = /\.(png|webp|svg|jpe?g|gif)$/i;
const TILE_TAIL = /\/\d+\/\d+\/\d+(\.[a-z0-9]+)?$/i;
const HINTS: [IconKind, RegExp][] = [
    ['lightning', /lightning|blitz|bolt|thunder|storm/i],
    ['hail', /hail|ice/i],
    ['snow', /snow|flake/i],
];

export function scan(): ScanResult {
    const layers = listLayers();
    const prefixes = new Map<string, number>();
    const images = new Map<string, IconKind | null>();
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    for (const e of entries) {
        const bare = e.name.split('?')[0];
        if (bare.startsWith('data:') || bare.startsWith('blob:')) {
            continue;
        }
        if (TILE_TAIL.test(bare)) {
            const prefix = bare.replace(TILE_TAIL, '/');
            prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
        } else if (IMG_EXT.test(bare)) {
            images.set(bare, HINTS.find(([, re]) => re.test(bare))?.[0] ?? null);
        }
    }
    return {
        layers,
        tilePrefixes: [...prefixes].map(([prefix, count]) => ({ prefix, count })).sort((a, b) => b.count - a.count),
        images: [...images]
            .map(([url, hint]) => ({ url, hint }))
            .sort((a, b) => Number(!!b.hint) - Number(!!a.hint)),
    };
}

/** Plain-text report for debugging — copy via the Inspector button. */
export function diagnostics(): string {
    const m = ml();
    let sources: unknown = null;
    try {
        const s = m?.getStyle?.()?.sources ?? {};
        sources = Object.keys(s).map(id => ({ id, type: s[id].type, tiles: s[id].tiles }));
    } catch {
        /* ignore */
    }
    const r = scan();
    const slim = JSON.parse(JSON.stringify(settings, (key, value) => (key === 'dataUrl' && value ? '[image]' : value)));
    return JSON.stringify(
        {
            maplibreFound: !!m,
            mapObjectKeys: Object.keys((map as any) ?? {}),
            layers: r.layers,
            sources,
            tilePrefixes: r.tilePrefixes.slice(0, 15),
            imageHints: r.images.filter(i => i.hint),
            otherImages: r.images.filter(i => !i.hint).slice(0, 25),
            settings: slim,
        },
        null,
        2,
    );
}
