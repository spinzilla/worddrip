const EVENT = 'quicknotes-changed';

export function notifyQuickNotesChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT));
}

export function onQuickNotesChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
