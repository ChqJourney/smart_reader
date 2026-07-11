import { useCallback, useEffect, useRef, useState } from "react";
import { DictEntry, lookupWord } from "../services/dictionary";

export interface WordLookupState {
  visible: boolean;
  word: string;
  entry: DictEntry | null;
  loading: boolean;
  x: number;
  y: number;
}

export function useWordLookup(
  enabled: boolean,
  delayMs = 500
): [WordLookupState, (word: string, x: number, y: number) => void, () => void] {
  const [state, setState] = useState<WordLookupState>({
    visible: false,
    word: "",
    entry: null,
    loading: false,
    x: 0,
    y: 0,
  });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentWordRef = useRef("");

  const hide = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    currentWordRef.current = "";
    setState((prev) => ({ ...prev, visible: false, loading: false }));
  }, []);

  const show = useCallback(
    (word: string, x: number, y: number) => {
      if (!enabled || !word) {
        hide();
        return;
      }
      if (word === currentWordRef.current) {
        return;
      }

      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      currentWordRef.current = word;
      setState((prev) => ({ ...prev, visible: false, loading: false }));

      timerRef.current = setTimeout(() => {
        setState({
          visible: true,
          word,
          entry: null,
          loading: true,
          x,
          y,
        });
        lookupWord(word)
          .then((entry) => {
            if (currentWordRef.current === word) {
              setState((prev) => ({ ...prev, entry, loading: false }));
            }
          })
          .catch(() => {
            if (currentWordRef.current === word) {
              setState((prev) => ({ ...prev, loading: false }));
            }
          });
      }, delayMs);
    },
    [enabled, delayMs, hide]
  );

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  return [state, show, hide];
}
