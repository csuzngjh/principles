import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('useDebounce Hook Logic', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should delay function execution by specified time', () => {
    const func = vi.fn();
    const debounced = createDebouncedFunction(func, 300);

    debounced();
    expect(func).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(func).toHaveBeenCalledTimes(1);
  });

  it('should only call function once for multiple rapid calls', () => {
    const func = vi.fn();
    const debounced = createDebouncedFunction(func, 300);

    debounced();
    debounced();
    debounced();

    expect(func).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(func).toHaveBeenCalledTimes(1);
  });

  it('should reset timer on each call', () => {
    const func = vi.fn();
    const debounced = createDebouncedFunction(func, 300);

    debounced();
    vi.advanceTimersByTime(200);
    debounced();
    vi.advanceTimersByTime(200);

    expect(func).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(func).toHaveBeenCalledTimes(1);
  });

  it('should pass arguments to the debounced function', () => {
    const func = vi.fn();
    const debounced = createDebouncedFunction(func, 300);

    debounced('arg1', 123);
    vi.advanceTimersByTime(300);

    expect(func).toHaveBeenCalledWith('arg1', 123);
  });
});

function createDebouncedFunction<T extends (...args: unknown[]) => unknown>(
  func: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      func(...args);
      timeoutId = null;
    }, delay);
  };
}
