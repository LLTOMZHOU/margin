import { useEffect, useReducer, useState } from 'react';

// Re-render whenever a Yjs type (or anything under it) changes.
export function useY(ytype, deep = true) {
  const [, bump] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    if (!ytype) return;
    const f = () => bump();
    deep ? ytype.observeDeep(f) : ytype.observe(f);
    return () => (deep ? ytype.unobserveDeep(f) : ytype.unobserve(f));
  }, [ytype, deep]);
}

export function useDocEvent(doc, ev) {
  const [, bump] = useReducer((x) => x + 1, 0);
  useEffect(() => doc?.on(ev, bump), [doc, ev]);
}

export function useNow(ms = 15000) {
  const [now, set] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => set(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function ago(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const initials = (name = '?') =>
  name
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
