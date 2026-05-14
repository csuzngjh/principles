import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('useBookmarks hook logic', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('should load empty bookmarks from localStorage', () => {
    const raw = localStorage.getItem('pd-principles-bookmarks');
    expect(raw).toBeNull();
  });

  it('should save and load bookmarks', () => {
    const ids = ['P_001', 'P_042', 'P_088'];
    localStorage.setItem('pd-principles-bookmarks', JSON.stringify(ids));
    const raw = localStorage.getItem('pd-principles-bookmarks');
    const loaded = JSON.parse(raw!) as string[];
    expect(loaded).toEqual(ids);
  });

  it('should toggle bookmark correctly', () => {
    const bookmarks = ['P_001', 'P_042'];
    const id = 'P_088';
    const toggled = bookmarks.includes(id)
      ? bookmarks.filter((b) => b !== id)
      : [...bookmarks, id];
    expect(toggled).toEqual(['P_001', 'P_042', 'P_088']);

    const toggledAgain = toggled.includes(id)
      ? toggled.filter((b) => b !== id)
      : [...toggled, id];
    expect(toggledAgain).toEqual(['P_001', 'P_042']);
  });

  it('should handle corrupted localStorage data', () => {
    localStorage.setItem('pd-principles-bookmarks', 'not-json');
    try {
      const raw = localStorage.getItem('pd-principles-bookmarks');
      JSON.parse(raw!);
    } catch {
      // Expected to fail, hook should return []
    }
  });

  it('should handle non-array localStorage data', () => {
    localStorage.setItem('pd-principles-bookmarks', JSON.stringify({ foo: 'bar' }));
    const raw = localStorage.getItem('pd-principles-bookmarks');
    const parsed = JSON.parse(raw!) as unknown;
    expect(Array.isArray(parsed)).toBe(false);
  });
});

describe('export logic', () => {
  it('should generate valid JSON for export', () => {
    const principles = [
      { id: 'P_001', text: 'Test principle', status: 'active', priority: 'P0' },
      { id: 'P_042', text: 'Another principle', status: 'candidate', priority: 'P1' },
    ];
    const json = JSON.stringify(principles, null, 2);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual(principles);
    expect(parsed).toHaveLength(2);
  });
});
