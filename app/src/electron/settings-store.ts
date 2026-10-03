import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

import { DEFAULT_SETTINGS, sanitizeSettings } from './settings-validation.js';
import type { AppSettings } from '../shared/contracts.js';
export type { AppSettings, Pc2Side, Pc2Layout } from '../shared/contracts.js';

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
            this.settings = sanitizeSettings(raw);
        } catch {
            // First run or unreadable file - keep defaults.
        }
    }

    public get(): AppSettings {
        return { ...this.settings, pc2Layout: { ...this.settings.pc2Layout } };
    }

    public update(patch: Partial<AppSettings>): AppSettings {
        this.settings = sanitizeSettings({ ...this.settings, ...patch });
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            const temporaryPath = `${this.filePath}.tmp`;
            fs.writeFileSync(temporaryPath, JSON.stringify(this.settings, null, 2));
            fs.renameSync(temporaryPath, this.filePath);
        } catch (err) {
            console.error('Failed to persist settings:', err);
        }
        return this.get();
    }
}

export const settingsStore = new SettingsStore();
