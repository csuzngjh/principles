import { getValueB } from './b.js';

export function getValueA(): string {
  return 'A:' + getValueB();
}

export function helperA(input: string): string {
  return input.toUpperCase();
}
