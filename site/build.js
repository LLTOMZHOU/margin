// Builds the website into site/_site: the page, the images, and the setup skill served at /skill.md
// (agents fetch it from there; its reference/*.md links resolve next to it).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = path.join(here, '_site');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(here, 'src'), out, { recursive: true });
fs.mkdirSync(path.join(out, 'images'), { recursive: true });
for (const f of ['app.png', 'logo.svg']) fs.copyFileSync(path.join(root, 'docs', 'images', f), path.join(out, 'images', f));
const setup = path.join(root, 'skills', 'margin-setup');
fs.copyFileSync(path.join(setup, 'SKILL.md'), path.join(out, 'skill.md'));
fs.cpSync(path.join(setup, 'reference'), path.join(out, 'reference'), { recursive: true });
fs.copyFileSync(path.join(root, 'skills', 'margin-agent', 'SKILL.md'), path.join(out, 'agent-skill.md'));
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log('site built →', out);
