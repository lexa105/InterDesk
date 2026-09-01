import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

export type Pc2Side = 'left' | 'right' | 'top' | 'bottom';

/** macOS-display-arrangement-style description of where PC2's screen sits. */
export interface Pc2Layout {
    /** Which edge of PC1's display PC2 sits on. */
    side: Pc2Side;
    /**
     * How far PC2's screen is slid along that shared edge, as a fraction of
     * PC1's edge length. 0 = aligned with PC1's edge start (top for left/right
     * sides, left for top/bottom). May be negative.
     */
    offset: number;
    /** PC2's edge length relative to PC1's (1 = same size). Must be > 0. */
    scale: number;
}

export interface AppSettings {
    /** Electron accelerator that toggles key/mouse forwarding on and off. */
    switchKeybind: string;
    forwardKeyboard: boolean;
    forwardMouse: boolean;
    /** Switch machines by throwing the cursor at the screen edge facing PC2. */
    dynamicSwitch: boolean;
    /** Where PC2's screen physically sits relative to PC1's. */
    pc2Layout: Pc2Layout;
    /** Absolute = DeskHop-style virtual cursor; relative = legacy delta forwarding. */
    mouseMode: 'absolute' | 'relative';
}

const DEFAULT_SETTINGS: AppSettings = {
    switchKeybind: 'CommandOrControl+Shift+R',
    forwardKeyboard: true,
    forwardMouse: true,
    dynamicSwitch: true,
    pc2Layout: { side: 'right', offset: 0, scale: 1 },
    mouseMode: 'absolute',
};

/** Keys we accept from a settings file; anything else is dropped on load. */
const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[];

class SettingsStore {
    private settings: AppSettings = { ...DEFAULT_SETTINGS };
    private filePath = '';

    /** Must be called once the app is ready (needs the userData path). */
    public load() {
        this.filePath = path.join(app.getPath('userData'), 'interdesk-settings.json');
        // Settings written before the BKMD -> InterDesk rename live under the
        // old filename, and under the old userData directory: naming the app
        // moved userData from <appData>/electron to <appData>/InterDesk. Read
        // whichever of those still exists; the next save() writes the new one.
        const candidates = [
            this.filePath,
            path.join(app.getPath('userData'), 'bkmd-settings.json'),
            path.join(app.getPath('appData'), 'electron', 'bkmd-settings.json'),
        ];
        const sourcePath = candidates.find((candidate) => fs.existsSync(candidate));
        try {
            const raw = JSON.parse(fs.readFileSync(sourcePath ?? this.filePath, 'utf-8'));
            const merged: AppSettings = { ...DEFAULT_SETTINGS };
            // Pick only known keys so retired fields (e.g. the legacy pc2Side)
            // don't survive on the typed object.
            for (const key of SETTINGS_KEYS) {
                if (raw?.[key] !== undefined) (merged as unknown as Record<string, unknown>)[key] = raw[key];
            }
            // Migration: settings files written before the layout model only
            // knew which side PC2 was on.
            if (raw?.pc2Layout === undefined && typeof raw?.pc2Side === 'string') {
                merged.pc2Layout = { ...DEFAULT_SETTINGS.pc2Layout, side: raw.pc2Side };
            } else {
                merged.pc2Layout = { ...DEFAULT_SETTINGS.pc2Layout, ...merged.pc2Layout };
            }
            this.settings = merged;
        } catch {
            // First run or unreadable file - keep defaults.
        }
    }

    public get(): AppSettings {
        return { ...this.settings };
    }

    public update(patch: Partial<AppSettings>): AppSettings {
        this.settings = { ...this.settings, ...patch };
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2));
        } catch (err) {
            console.error('Failed to persist settings:', err);
        }
        return this.get();
    }
}

export const settingsStore = new SettingsStore();
