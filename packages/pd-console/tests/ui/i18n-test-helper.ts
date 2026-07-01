function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJsonRecord(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) {
    throw new Error('Expected locale root to be an object');
  }
  return value;
}

export function getNestedRecord(root: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let current: unknown = root;
  for (const key of path) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) {
      throw new Error(`Missing locale object: ${path.join('.')}`);
    }
    current = Reflect.get(current, key);
  }
  if (!isRecord(current)) {
    throw new Error(`Expected locale object: ${path.join('.')}`);
  }
  return current;
}

export function getNestedString(root: Record<string, unknown>, path: string[]): string {
  const parent = getNestedRecord(root, path.slice(0, -1));
  const key = path.at(-1);
  const value = key && Object.hasOwn(parent, key) ? parent[key] : undefined;
  if (typeof value !== 'string') throw new Error(`Expected locale string: ${path.join('.')}`);
  return value;
}
