import { readFileSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';

export type Agent = { name: string; description: string; prompt: string; model?: string; tools?: string[]; path: string; contents: string };
export function loadAgent(root: string, name: string): Agent {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error('Invalid agent name');
  const base = realpathSync(root), path = realpathSync(join(base,'.pi','agents',`${name}.md`));
  const rel = relative(base, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Agent must be inside repository');
  const contents = readFileSync(path, 'utf8');
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(contents);
  if (frontmatter.name !== name || typeof frontmatter.description !== 'string') throw new Error('Invalid agent frontmatter');
  const raw = frontmatter.tools;
  if (raw !== undefined && !Array.isArray(raw) && typeof raw !== 'string') throw new Error('Invalid tools');
  if (frontmatter.model !== undefined && (typeof frontmatter.model !== 'string' || !frontmatter.model.trim())) throw new Error('Invalid model');
  const tools = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : undefined;
  if (tools && !tools.every(x => typeof x === 'string')) throw new Error('Invalid tools');
  return {name, description: frontmatter.description, prompt: body.trim(), path, contents, model: typeof frontmatter.model === 'string' ? frontmatter.model : undefined, tools: tools?.map(x => x.trim()).filter(Boolean)};
}
