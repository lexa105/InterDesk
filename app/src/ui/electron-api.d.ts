import type { BkmdApi } from '../shared/contracts';
export type { BluetoothDevice, ConnectionState, Pc2Side, Pc2Layout, AppSettings, BkmdApi } from '../shared/contracts';

declare global {
    interface Window { bkmd: BkmdApi; }
}
