import { Check, X, Locate } from 'lucide-react';
import { diffHunks, merge3, findBlock, blockText } from '../shared/schema.js';
import { initials } from './hooks.js';

export function WordDiff({ before, after }) {
  const hunks = diffHunks(before, after);
  const out = [];
  let pos = 0;
  hunks.forEach((h, i) => {
    if (h.start > pos) out.push(<span key={'e' + i}>{before.slice(pos, h.start)}</span>);
    if (h.end > h.start) out.push(<del key={'d' + i}>{before.slice(h.start, h.end)}</del>);
    if (h.insert) out.push(<ins key={'i' + i}>{h.insert}</ins>);
    pos = h.end;
  });
  out.push(<span key="tail">{before.slice(pos)}</span>);
  return <div className="diff">{out}</div>;
}

// What would land if this were accepted right now: the agent's edit re-merged onto the live text.
export function livePreview(p, ydoc) {
  if (p.kind === 'edit') {
    const f = findBlock(ydoc, p.blockId);
    if (!f) return { gone: true };
    const current = blockText(f.block);
    const m = merge3(p.baseText, p.newText, current);
    return m.ok ? { before: current, after: m.text, rebased: current !== p.baseText } : { before: current, conflict: true };
  }
  if (p.kind === 'delete') {
    const f = findBlock(ydoc, p.blockId);
    return f ? { before: blockText(f.block), after: '' } : { gone: true };
  }
  return null;
}

const WHAT = (p) => (p.kind === 'edit' ? 'suggests an edit' : p.kind === 'insert' ? `suggests ${p.blocks.length === 1 ? 'a new block' : `${p.blocks.length} new blocks`}` : 'suggests deleting this');
const STATUS = { committed: ['accepted', 'ok'], rejected: ['rejected', ''], withdrawn: ['withdrawn', ''], held: ['held', 'warn'] };

function Body({ p, prev, done }) {
  if (p.kind === 'insert')
    return (
      <div className="diff">
        {p.blocks.map((b, i) => (
          <ins key={i} className={`ins-block t-${b.type}`}>
            {b.text}
          </ins>
        ))}
      </div>
    );
  if (done) return p.preview ? <WordDiff before={p.preview.before} after={p.applied ?? p.preview.after} /> : null;
  if (prev?.gone) return <div className="muted">The block is gone.</div>;
  if (prev?.conflict) return <div className="muted">Someone changed the same words since. {p.author.name} needs to suggest it again against the current text.</div>;
  return prev ? <WordDiff before={prev.before} after={prev.after} /> : null;
}

// One component, two places: inline under the block it changes (inline), and in the History drawer.
export function ProposalCard({ p, ydoc, client, docId, me, inline, toast, onFocusBlock }) {
  const prev = livePreview(p, ydoc);
  const votes = Object.values(p.votes || {});
  const myVote = p.votes?.[me.id]?.vote;
  const vote = (v) => client.rpc('proposal.vote', { docId, proposalId: p.id, vote: v }).catch((e) => toast(e.message));
  const done = !['pending', 'held'].includes(p.status);
  const [statusText, statusTone] = STATUS[p.status] || [];
  const actions = !done && (
    <span className="acts">
      {votes.length > 0 && (
        <span className="votes">
          {votes.map((v, i) => (
            <span key={i} className={`vote ${v.vote}`} title={`${v.name}: ${v.vote}`}>
              {initials(v.name)}
            </span>
          ))}
        </span>
      )}
      <button className={`btn sm quiet ${myVote === 'reject' ? 'on' : ''}`} onClick={() => vote('reject')}>
        <X className="i" /> {p.status === 'held' ? 'Dismiss' : 'Reject'}
      </button>
      {p.status === 'pending' && (
        <button className={`btn sm primary ${myVote === 'accept' ? 'on' : ''}`} onClick={() => vote('accept')}>
          <Check className="i" /> Accept
        </button>
      )}
    </span>
  );

  if (inline)
    return (
      <div className={`proposal inline st-${p.status}`}>
        <Body p={p} prev={prev} done={done} />
        <div className="proposal-foot">
          <span className="meta-line">
            <span>
              <b>{p.author.name}</b> {WHAT(p)}
            </span>
            {p.rationale && <span className="why">“{p.rationale}”</span>}
            {statusText && <span className={`status-word ${statusTone}`}>{statusText}</span>}
            {prev?.rebased && !prev.conflict && p.status === 'pending' && (
              <span className="status-word" title="People edited this block since; the change was merged onto the current text">
                merged with newer edits
              </span>
            )}
          </span>
          {actions}
        </div>
      </div>
    );

  return (
    <div className={`proposal st-${p.status}`}>
      <div className="proposal-head">
        <span className="avatar agent xs">{initials(p.author.name)}</span>
        <b>{p.author.name}</b> {WHAT(p)}
        {statusText && <span className={`status-word ${statusTone}`}>· {statusText}</span>}
        <span style={{ flex: 1 }} />
        {onFocusBlock && (p.blockId || p.afterBlockId) && (
          <button className="link" title="Show in the doc" onClick={() => onFocusBlock(p.blockId || p.afterBlockId)}>
            <Locate className="i" />
          </button>
        )}
      </div>
      <Body p={p} prev={prev} done={done} />
      {(p.rationale || actions) && (
        <div className="proposal-foot">
          <span className="meta-line">{p.rationale && <span className="why">“{p.rationale}”</span>}</span>
          {actions}
        </div>
      )}
    </div>
  );
}
