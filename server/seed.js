// First-run content so the demo has something real to argue about.
const env = (k) => (typeof process !== 'undefined' && process.env ? process.env[k] : undefined);

const ROSTER = [
  ['Editor', 'Line editor. Tightens sentences, cuts filler words, keeps the author’s voice. Proposes edits; never rewrites whole sections unasked.'],
  ['Fact-Checker', 'Checks every factual claim and number. Leaves comments asking for sources and flags anything that cannot be verified.'],
  ['Skeptic', 'Red team. Pressure-tests the plan: absolute claims, missing risks, untested assumptions. Comments with the strongest counter-argument.'],
  ['Scribe', 'Summarizes threads and decisions, drafts new sections when asked, and keeps the open-questions list current.'],
];

// mode: 'demo' (a launch brief to argue about) or 'welcome' (a clean private hub)
export function seed(hub, { mode = env('MARGIN_SEED') || 'demo', spaceName = env('MARGIN_SPACE_NAME') } = {}) {
  if (mode === 'welcome') return seedWelcome(hub, spaceName);
  const space = hub.createSpace({
    name: 'Launch Room',
    instructions:
      'We are launching Tidepool, a shared notebook for small research teams, in Q1.\n' +
      'Audience: team leads at 5–50 person labs. Tone: plain, specific, no hype.\n' +
      'Every number in a public doc needs a source in a comment thread.',
  });
  hub.createDoc(space.id, {
    title: 'Q1 Launch Brief',
    policy: 'one',
    blocks: [
      ['h2', 'Why now'],
      [
        'p',
        'Research teams are basically drowning in scattered notes. Studies show that 73% of lab time is spent searching for information, and everyone agrees the current tools are really not built for teams.',
      ],
      [
        'p',
        'Tidepool gives every team one shared notebook where humans and AI assistants work side by side, and it is obviously the simplest way to keep a project’s thinking in one place.',
      ],
      ['h2', 'What we are launching'],
      ['li', 'Shared notebooks with live editing and comments anchored to any sentence.'],
      ['li', 'Agents that propose edits instead of overwriting, so a human always has the last word.'],
      ['li', 'A bridge that lets each person bring their own local agent into the notebook.'],
      ['h2', 'Launch plan'],
      [
        'p',
        'In order to reach 500 teams in the first month, we will just announce on our blog, post in three research communities, and offer a free plan that is very generous.',
      ],
      ['p', 'Success means 40% of new teams invite a second member within a week. We will never need paid acquisition in Q1.'],
      ['h2', 'Open questions'],
      ['li', 'Do we price per seat or per notebook?'],
      ['li', 'Which partner lab do we feature in the announcement?'],
    ],
  });
  const runtime = env('ANTHROPIC_API_KEY') ? 'claude-api' : 'sim';
  for (const [name, description] of ROSTER) hub.createAgent(space.id, { name, description, runtime });
  return space;
}

function seedWelcome(hub, spaceName = 'Our space') {
  const space = hub.createSpace({ name: spaceName, instructions: 'Write what every agent should know here: goals, audience, tone, rules.' });
  hub.createDoc(space.id, {
    title: 'Welcome',
    blocks: [
      ['p', 'This is your private hub. Everything here lives on infrastructure you control.'],
      ['h2', 'How it works'],
      ['li', 'Type anywhere. Everyone sees edits live.'],
      ['li', 'Select text and comment, or @mention an agent to bring it in.'],
      ['li', 'Agents suggest; humans accept or reject in Changes. The doc policy decides how many approvals an edit needs.'],
      ['h2', 'Bring agents online'],
      ['li', 'Agents run on your own computers. Run `margin computer` on a machine to host the agents in the sidebar.'],
      ['li', 'Or add an external agent and connect Codex or Claude Code with the commands it shows you.'],
    ],
  });
  for (const [name, description] of ROSTER) hub.createAgent(space.id, { name, description, runtime: 'sim' });
  return space;
}
