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

export function ProposalCard({ p, ydoc, client, docId, me, inline, toast, onFocusBlock }) {
  const prev = livePreview(p, ydoc);
  const votes = Object.values(p.votes || {});
  const myVote = p.votes?.[me.id]?.vote;
  const vote = (v) => client.rpc('proposal.vote', { docId, proposalId: p.id, vote: v }).catch((e) => toast(e.message));
  const done = !['pending', 'held'].includes(p.status);
  return (
    <div className={`proposal ${inline ? 'inline' : ''} st-${p.status}`} style={{ '--c': p.author.color }}>
      <div className="proposal-head">
        <span className="avatar agent sm" style={{ '--c': p.author.color }}>
          {initials(p.author.name)}
        </span>
        <b>{p.author.name}</b>
        <span className="muted">
          {p.kind === 'edit' ? 'suggests an edit' : p.kind === 'insert' ? `suggests ${p.blocks.length} new block${p.blocks.length > 1 ? 's' : ''}` : 'suggests deleting this block'}
        </span>
        {p.status === 'held' && <span className="badge warn">held</span>}
        {done && <span className={`badge ${p.status === 'committed' ? 'ok' : ''}`}>{p.status}</span>}
        {prev?.rebased && !prev.conflict && p.status === 'pending' && <span className="badge info" title="Humans edited this block since; the change has been re-merged onto the current text">rebased</span>}
        {!inline && onFocusBlock && (p.blockId || p.afterBlockId) && (
          <button className="link" onClick={() => onFocusBlock(p.blockId || p.afterBlockId)}>
            show
          </button>
        )}
      </div>
      {p.kind === 'insert' ? (
        <div className="diff">
          {p.blocks.map((b, i) => (
            <ins key={i} className={`ins-block t-${b.type}`}>
              {b.text}
            </ins>
          ))}
        </div>
      ) : done ? (
        p.preview && <WordDiff before={p.preview.before} after={p.applied ?? p.preview.after} />
      ) : prev?.gone ? (
        <div className="muted">The block is gone.</div>
      ) : prev?.conflict ? (
        <div className="muted">Someone changed the same words since. {p.author.name} needs to re-propose against the current text.</div>
      ) : (
        prev && <WordDiff before={prev.before} after={prev.after} />
      )}
      {p.rationale && <div className="rationale">“{p.rationale}”</div>}
      {!done && (
        <div className="proposal-actions">
          {p.status === 'pending' && (
            <button className={`btn accept ${myVote === 'accept' ? 'on' : ''}`} onClick={() => vote('accept')}>
              ✓ Accept
            </button>
          )}
          <button className={`btn reject ${myVote === 'reject' ? 'on' : ''}`} onClick={() => vote('reject')}>
            ✕ {p.status === 'held' ? 'Dismiss' : 'Reject'}
          </button>
          <span className="votes">
            {votes.map((v, i) => (
              <span key={i} className={`vote ${v.vote}`} style={{ '--c': v.color }} title={`${v.name}: ${v.vote}`}>
                {initials(v.name)}
              </span>
            ))}
          </span>
        </div>
      )}
    </div>
  );
}
