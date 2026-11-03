// Built-in model runtime: Claude Opus 5.5 with tools that map 1:1 onto the agent API.
// Runs on the computer that hosts the agent, with that computer's ANTHROPIC_API_KEY.
import Anthropic from '@anthropic-ai/sdk';
import { drainInbox } from '../bridge.js';

const MODEL = process.env.MARGIN_MODEL || 'claude-opus-5-5';

const obj = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });

const TOOLS = [
  {
    name: 'read_doc',
    description: 'Read a document: every block with its id and type, open threads, leases, and your open proposals.',
    input_schema: obj({ doc_id: str('Document id, e.g. dabc123') }, ['doc_id']),
  },
  {
    name: 'read_thread',
    description: 'Read a comment thread, the quoted text it is anchored to, and the current text of that block. Returns seen_through for replying.',
    input_schema: obj({ doc_id: str('Document id'), thread_id: str('Thread id') }, ['doc_id', 'thread_id']),
  },
  {
    name: 'reply_in_thread',
    description:
      'Post a reply in a thread. Pass seen_through = the id of the last message you read; if people wrote since, the reply is held and you are shown what you missed. To send a held reply anyway, call again with its idempotency_key.',
    input_schema: obj(
      { doc_id: str('Document id'), thread_id: str('Thread id'), text: str('Reply, 1-4 sentences'), seen_through: str('Last message id you read, or empty'), idempotency_key: str('Key from a held reply, or empty') },
      ['doc_id', 'thread_id', 'text', 'seen_through', 'idempotency_key'],
    ),
  },
  {
    name: 'propose_edit',
    description:
      'Propose new full text for ONE block. base_text must be the exact block text you read; the hub merges your change with anything humans typed since. Humans approve according to the doc policy.',
    input_schema: obj(
      { doc_id: str('Document id'), block_id: str('Block id'), base_text: str('Block text exactly as you read it'), text: str('Full new text of the block'), rationale: str('One sentence: why') },
      ['doc_id', 'block_id', 'base_text', 'text', 'rationale'],
    ),
  },
  {
    name: 'propose_insert',
    description: 'Propose inserting new blocks after a block (after_block_id empty = at the top).',
    input_schema: obj(
      {
        doc_id: str('Document id'),
        after_block_id: str('Insert after this block id, or empty for the top'),
        blocks: {
          type: 'array',
          items: obj({ type: { type: 'string', enum: ['h1', 'h2', 'h3', 'p', 'li', 'quote', 'code'] }, text: str('Block text') }, ['type', 'text']),
        },
        rationale: str('One sentence: why'),
      },
      ['doc_id', 'after_block_id', 'blocks', 'rationale'],
    ),
  },
  {
    name: 'propose_delete',
    description: 'Propose deleting one block.',
    input_schema: obj({ doc_id: str('Document id'), block_id: str('Block id'), rationale: str('One sentence: why') }, ['doc_id', 'block_id', 'rationale']),
  },
  {
    name: 'add_comment',
    description: 'Open a new comment thread anchored to exact words inside a block (e.g. to flag a claim).',
    input_schema: obj({ doc_id: str('Document id'), block_id: str('Block id'), quote: str('Exact words from the block'), text: str('Comment') }, ['doc_id', 'block_id', 'quote', 'text']),
  },
  {
    name: 'claim_blocks',
    description: 'Lease blocks before a multi-step edit so other agents do not edit them at the same time. Fails if another agent holds one.',
    input_schema: obj({ doc_id: str('Document id'), block_ids: { type: 'array', items: { type: 'string' } } }, ['doc_id', 'block_ids']),
  },
];

async function runTool(api, name, input, hop) {
  switch (name) {
    case 'read_doc':
      return api.doc(input.doc_id);
    case 'read_thread':
      return api.thread(input.doc_id, input.thread_id);
    case 'reply_in_thread':
      return api.reply(input.doc_id, input.thread_id, {
        text: input.text,
        seen_through: input.seen_through || undefined,
        idempotency_key: input.idempotency_key || undefined,
        hop,
      });
    case 'propose_edit':
      return api.propose(input.doc_id, { kind: 'edit', block_id: input.block_id, base_text: input.base_text, text: input.text, rationale: input.rationale });
    case 'propose_insert':
      return api.propose(input.doc_id, { kind: 'insert', after_block_id: input.after_block_id || null, blocks: input.blocks, rationale: input.rationale });
    case 'propose_delete':
      return api.propose(input.doc_id, { kind: 'delete', block_id: input.block_id, rationale: input.rationale });
    case 'add_comment':
      return api.comment(input.doc_id, { block_id: input.block_id, quote: input.quote, text: input.text, hop });
    case 'claim_blocks':
      return api.lease(input.doc_id, input.block_ids, 120_000);
    default:
      return { ok: false, state: 'unknown_tool', text: `Unknown tool ${name}` };
  }
}

const statusFor = (name, input) =>
  ({
    read_doc: ['thinking', 'reading the doc'],
    read_thread: ['thinking', 'reading a thread'],
    reply_in_thread: ['working', 'replying'],
    propose_edit: ['working', `editing ${input.block_id}`],
    propose_insert: ['working', 'drafting new blocks'],
    propose_delete: ['working', `proposing to delete ${input.block_id}`],
    add_comment: ['working', 'leaving a comment'],
    claim_blocks: ['working', 'claiming blocks'],
  })[name] || ['working', name];

export const claudeApiRuntime = {
  name: 'claude-api',
  async run({ api, agent, log }) {
    const client = new Anthropic();
    const me = await api.whoami();
    const manual = await api.manual();
    const system = [
      `You are @${agent.name}, an AI member of the shared space “${me.data.space.name}”, working alongside several humans and other agents.`,
      `Your role: ${agent.description || 'general collaborator'}`,
      `Space instructions from the humans:\n${me.data.space.instructions || '(none)'}`,
      manual.text,
      'You act only through the tools. Finish every event in the batch, then end your turn with a one-line note of what you did.',
    ].join('\n\n');

    await drainInbox(api, async (events, batch) => {
      const hop = Math.max(0, ...events.map((e) => e.hop || 0));
      const messages = [{ role: 'user', content: `New inbox batch:\n\n${batch.text}\n\nHandle each event.` }];
      for (let turn = 0; turn < 16; turn++) {
        let res;
        try {
          res = await client.beta.messages.create({
            model: MODEL,
            max_tokens: 16000,
            system,
            tools: TOOLS.map((t) => ({ ...t, strict: true })),
            thinking: { type: 'adaptive' },
            output_config: { effort: 'medium' },
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            messages,
          });
        } catch (e) {
          if (e instanceof Anthropic.RateLimitError) {
            log('rate limited; retrying in 10s');
            await new Promise((r) => setTimeout(r, 10_000));
            continue;
          }
          if (e instanceof Anthropic.AuthenticationError) throw new Error('ANTHROPIC_API_KEY is missing or invalid on this computer');
          if (e instanceof Anthropic.APIError) throw new Error(`Claude API ${e.status}: ${e.message}`);
          throw e;
        }
        if (res.stop_reason === 'refusal') {
          log('model declined this batch');
          return;
        }
        messages.push({ role: 'assistant', content: res.content });
        const uses = res.content.filter((b) => b.type === 'tool_use');
        if (res.stop_reason !== 'tool_use' || !uses.length) return;
        const results = await Promise.all(
          uses.map(async (u) => {
            const [s, d] = statusFor(u.name, u.input || {});
            await api.status(s, d);
            const out = await runTool(api, u.name, u.input || {}, hop);
            return { type: 'tool_result', tool_use_id: u.id, content: out.text + (out.next?.text ? `\nNext: ${out.next.text}` : ''), is_error: !out.ok && !['interrupted', 'pending', 'empty'].includes(out.state) };
          }),
        );
        messages.push({ role: 'user', content: results });
      }
    });
  },
};
