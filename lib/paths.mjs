import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = process.env.PLIB_DATA || path.join(ROOT, 'data');
export const DB_PATH = path.join(DATA, 'library.db');
export const SEED = path.join(ROOT, 'seed');
export const PUBLIC = path.join(ROOT, 'public');
