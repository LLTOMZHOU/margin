# Margin design spec

Updated: 2026-11-02

## Direction
A printed proof on a desk: the text is the only thing in full black, everything else is pencil. Conversations sit in the real margin beside the passage they are about; opening one fades the rest. (User confirmed: chose "reimagine" on 2026-11-02)

## Brand assets (do not change)
- The Margin name and logo (`docs/images/logo.svg`, also the `Logo` component in `src/client/Sidebar.jsx`). (User confirmed)
- Warm paper canvas with ink text; highlighter yellow is the only accent colour. (User confirmed)
- Serif for document text, sans for everything around it. (Agent inferred)

## Semantic roles
Tokens live in `src/client/styles.css` (`:root`). Components use roles, never raw values. (Agent inferred)
- `--paper` canvas; `--surface` cards, popovers, inputs; `--sunken` hover fills, selected rows, code. (Agent inferred)
- `--ink` primary text and the single strong control colour (primary buttons, focus ring, active rail item); `--ink-2` secondary text; `--ink-3` meta text and icons, the lightest text allowed. (Agent inferred)
- `--hl` only marks the passage of the open thread; other discussed passages get a 2px `--hl` underline. `--hl-soft` for your own selection and for a block you jumped to. Never use yellow for buttons or badges. (Agent inferred)
- `--ok` / `--bad` only inside suggested edits (inserted / deleted words) and status words; `--warn` only for held suggestions and reconnecting. (Agent inferred)
- People's colours appear only on live carets and their selections. Avatars are neutral monograms: people round, agents rounded squares; the current user is the ink avatar. (Agent inferred)
- Type: UI uses `--fs-xs` (meta), `--fs-sm` (secondary), `--fs-md` (body), `--fs-lg` (pane titles); the doc uses `--doc-size` / `--doc-lh` and the `.t-*` heading classes. Counts and sequence numbers use tabular numerals. (Agent inferred)
- Shape: `--r-sm` controls, `--r-md` cards and popovers, `--r-pill` avatars and counts. `--shadow-1` resting cards, `--shadow-2` anything floating (popovers, drawer, open thread). No coloured left bars except the 2px rule beside a suggested edit. (Agent inferred)
- Motion: `--dur` with `--ease` for hovers, fades and panel entrances; margin cards move with `top 220ms var(--ease)`. Everything respects `prefers-reduced-motion`. (Agent inferred)

## Components
- Icons: `lucide-react`, 16px, stroke 1.6, class `i`. No emoji or text glyphs as icons. (Agent inferred)
- `.btn` (`primary`, `quiet`, `sm`), `.icon-btn` (`counted` for an icon with a number), `.link`, `.field`. (Agent inferred)
- `.rail` + `.flyout` (`Pane` in `src/client/Sidebar.jsx`) for space-level lists: docs, people and agents, space instructions. (Agent inferred)
- `.topbar`: one row with doc crumb, who is here, approval policy, threads toggle, history, more. Nothing else goes in it. (Agent inferred)
- `.margin` + `.mcard` (`Margin` in `src/client/Panels.jsx`): threads positioned beside their anchor; the open card sits at its anchor and the rest stack or deck around it. Below 900px it becomes a bottom sheet. (Agent inferred)
- `.proposal.inline` (`ProposalCard` in `src/client/Proposals.jsx`): a suggested edit is shown as tracked changes in doc type, with author, reason, Reject and Accept on one quiet line. (Agent inferred)
- `.drawer` (`HistoryDrawer`): Changes and Log. `.menu` for small action lists. `.sheet` for forms (add agent, agent settings). (Agent inferred)

## Sample page
- `src/client/main.jsx` with `src/client/DocView.jsx`, `src/client/Panels.jsx`, `src/client/Proposals.jsx`, `src/client/Sidebar.jsx`: the doc workspace is fully on this spec. (Agent inferred)

## Do not
- Do not put settings or toolbars above the doc title; space-level things live in the rail, doc-level things in the top bar. (Agent inferred)
- Do not show more than one solid yellow passage at a time. (Agent inferred)
- Do not add tab panels beside the doc; threads belong in the margin, history in the drawer. (Agent inferred)
- Do not fade inactive threads below 3:1 text contrast. (Agent inferred)
