import { useEffect, useCallback, useRef } from "react";

function isInputFocused(): boolean {
  const { activeElement } = document;
  return (
    activeElement instanceof HTMLInputElement ||
    activeElement instanceof HTMLTextAreaElement ||
    activeElement instanceof HTMLSelectElement
  );
}

interface UseKeyboardNavigationOptions {
  itemCount: number;
  onSelect: (index: number) => void;
  enabled?: boolean;
}

export function useKeyboardNavigation({
  itemCount,
  onSelect,
  enabled = true,
}: UseKeyboardNavigationOptions) {
  const selectedIndexRef = useRef<number>(-1);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!enabled || itemCount === 0) return;

      switch (event.key) {
        case "j":
        case "ArrowDown":
          event.preventDefault();
          selectedIndexRef.current = Math.min(selectedIndexRef.current + 1, itemCount - 1);
          onSelect(selectedIndexRef.current);
          break;
        case "k":
        case "ArrowUp":
          event.preventDefault();
          selectedIndexRef.current = Math.max(selectedIndexRef.current - 1, 0);
          onSelect(selectedIndexRef.current);
          break;
        case "g":
          if (!event.shiftKey) {
            event.preventDefault();
            selectedIndexRef.current = 0;
            onSelect(0);
          }
          break;
        case "G":
          event.preventDefault();
          selectedIndexRef.current = itemCount - 1;
          onSelect(selectedIndexRef.current);
          break;
      }
    },
    [enabled, itemCount, onSelect]
  );

  useEffect(() => {
    if (!enabled) return;

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [enabled, handleKeyDown]);

  const resetSelection = useCallback(() => {
    selectedIndexRef.current = -1;
  }, []);

  return { resetSelection, selectedIndex: selectedIndexRef.current };
}

interface UseFocusSearchOptions {
  enabled?: boolean;
}

export function useFocusSearch({ enabled = true }: UseFocusSearchOptions) {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!enabled) return;

      if (event.key === "/" && !isInputFocused()) {
        event.preventDefault();
        const searchInput = document.querySelector<HTMLInputElement>(
          'input[placeholder*="Search"], input[placeholder*="搜索"]'
        );
        searchInput?.focus();
      }

      if (event.key === "Escape" && isInputFocused()) {
        const searchInput = document.querySelector<HTMLInputElement>(
          'input[placeholder*="Search"], input[placeholder*="搜索"]'
        );
        searchInput?.blur();
      }
    },
    [enabled]
  );

  useEffect(() => {
    if (!enabled) return;

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [enabled, handleKeyDown]);
}
