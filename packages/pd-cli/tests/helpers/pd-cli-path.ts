import { join } from 'node:path';

export function getBuiltPdCliPath(): string {
  return join(process.cwd(), 'dist', 'index.js');
}
