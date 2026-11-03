// One block = a textarea bound to a Y.Text, with a "mirror" layer behind it that paints
// comment highlights, other people's carets and selections at exact character positions.
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';

export const LOCAL = 'local-input';

function transformIndex(idx, delta) {
  let pos = 0;
  for (const op of delta) {
    if (op.retain) pos += op.retain;
    else if (op.insert) {
      const len = typeof op.insert === 'string' ? op.insert.length : 1;
      if (pos < idx) idx += len;
      pos += len;
    } else if (op.delete) {
      if (pos < idx) idx -= Math.min(op.delete, idx - pos);
    }
  }
  return idx;
}

function singleHunk(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { at: p, del: a.length - p - s, ins: b.slice(p, b.length - s) };
}

// marks: [{ start, end, cls, color, key, onClick }], carets: [{ index, color, name, key }]
function Mirror({ text, marks, carets, selRef }) {
  const points = new Set([0, text.length]);
  for (const m of marks) points.add(Math.max(0, Math.min(text.length, m.start))), points.add(Math.max(0, Math.min(text.length, m.end)));
  for (const c of carets) points.add(Math.max(0, Math.min(text.length, c.index)));
  const sorted = [...points].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    const at = sorted[i];
    for (const c of carets.filter((c) => Math.min(text.length, Math.max(0, c.index)) === at))
      out.push(
        <span key={'c' + c.key} className="caret" style={{ '--c': c.color }}>
          <span className="caret-label">{c.name}</span>
        </span>,
      );
    const next = sorted[i + 1];
    if (next === undefined || next === at) continue;
    const seg = text.slice(at, next);
    const covering = marks.filter((m) => m.start <= at && m.end >= next && m.end > m.start);
    if (!covering.length) {
      out.push(<span key={'s' + at}>{seg}</span>);
      continue;
    }
    const top = covering[covering.length - 1];
    // The first segment of each thread's highlight carries its id, so the margin can line the card up with it.
    const anchors = covering.filter((m) => m.tid && m.start === at).map((m) => m.tid).join(' ');
    out.push(
      <span
        key={'s' + at}
        ref={top.cls.includes('self-sel') && at === top.start ? selRef : undefined}
        className={'mark ' + covering.map((m) => m.cls).join(' ')}
        style={{ '--c': top.color }}
        data-anchor={anchors || undefined}
      >
        {seg}
      </span>,
    );
  }
  out.push(<span key="end">{'\u200b'}</span>);
  return (
    <div className="mirror" aria-hidden>
      {out}
    </div>
  );
}

export const BlockEditor = forwardRef(function BlockEditor(
  { block, ydoc, marks, carets, placeholder, onKeyDown, onSelection, onFocusChange, onTypeShortcut, onCaretClick, selRef },
  ref,
) {
  const ytext = block.get('text');
  const ta = useRef(null);
  const [value, setValue] = useState(() => ytext.toString());
  const pendingSel = useRef(null);
  const composing = useRef(false);

  useImperativeHandle(ref, () => ({
    focus(pos = 'end') {
      const el = ta.current;
      if (!el) return;
      el.focus();
      const p = pos === 'end' ? el.value.length : Math.min(pos, el.value.length);
      el.setSelectionRange(p, p);
    },
    el: () => ta.current,
    selection: () => (ta.current ? [ta.current.selectionStart, ta.current.selectionEnd] : [0, 0]),
  }));

  useEffect(() => {
    setValue(ytext.toString());
    const obs = (ev, tr) => {
      const next = ytext.toString();
      const el = ta.current;
      if (tr.origin !== LOCAL && el && document.activeElement === el) {
        pendingSel.current = [transformIndex(el.selectionStart, ev.delta), transformIndex(el.selectionEnd, ev.delta)];
      }
      setValue(next);
    };
    ytext.observe(obs);
    return () => ytext.unobserve(obs);
  }, [ytext]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    if (pendingSel.current) {
      el.setSelectionRange(...pendingSel.current);
      pendingSel.current = null;
    }
    el.style.height = '0px';
    el.style.height = el.scrollHeight + 'px';
  }, [value]);

  useEffect(() => {
    const el = ta.current;
    const ro = new ResizeObserver(() => {
      el.style.height = '0px';
      el.style.height = el.scrollHeight + 'px';
    });
    ro.observe(el.parentElement);
    return () => ro.disconnect();
  }, []);

  const onChange = (e) => {
    const next = e.target.value;
    const cur = ytext.toString();
    if (onTypeShortcut && onTypeShortcut(next)) return;
    const h = singleHunk(cur, next);
    ydoc.transact(() => {
      if (h.del) ytext.delete(h.at, h.del);
      if (h.ins) ytext.insert(h.at, h.ins);
    }, LOCAL);
    setValue(next);
    reportSel();
  };

  const reportSel = () => {
    const el = ta.current;
    if (el) onSelection?.(el.selectionStart, el.selectionEnd);
  };

  return (
    <div className="editor">
      <Mirror text={value} marks={marks} carets={carets} selRef={selRef} />
      <textarea
        ref={ta}
        rows={1}
        spellCheck
        value={value}
        placeholder={placeholder}
        onChange={onChange}
        onKeyDown={(e) => onKeyDown?.(e, ta.current)}
        onSelect={reportSel}
        onKeyUp={reportSel}
        onMouseUp={() => {
          reportSel();
          const el = ta.current;
          if (el && el.selectionStart === el.selectionEnd) onCaretClick?.(el.selectionStart);
        }}
        onFocus={() => {
          onFocusChange?.(true);
          reportSel();
        }}
        onBlur={() => onFocusChange?.(false)}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={() => (composing.current = false)}
      />
    </div>
  );
});
