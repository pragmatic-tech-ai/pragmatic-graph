import { MemoryStore } from '../memory/MemoryStore.js';
import { KeyValueConformance } from './KeyValueConformance.js';

KeyValueConformance.Register('memory', async () => new MemoryStore());
