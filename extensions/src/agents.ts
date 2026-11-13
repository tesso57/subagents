import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { leavesRepository } from './inheritance.ts';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';

export type Agent = { name: string; description: string; prompt: string; model?: string; tools?: string[]; path: string; relativePath: string; contents: string };
export function loadAgent(root: string, selector: string): Agent {
  const base=realpathSync(root);
  const named=/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(selector);
  let logical=named ? join(base,'.pi','agents',`${selector}.md`) : resolve(base,selector);
  if (!named && isAbsolute(selector)) {
    let ancestor=logical, rootAlias:string | undefined;
    while (true) {
      try {if (realpathSync(ancestor)===base) rootAlias=ancestor;} catch { /* Check the next ancestor. */ }
      const parent=dirname(ancestor);if(parent===ancestor) break;ancestor=parent;
    }
    if (rootAlias) logical=join(base,relative(rootAlias,logical));
  }
  const name=named ? selector : basename(logical,'.md');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name) || (!named && !logical.endsWith('.md'))) throw new Error('Invalid agent path or name');
  const inside=(path:string)=>{const rel=relative(base,path);return rel!=='' && rel!=='..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);};
  if (!inside(logical) || leavesRepository(logical,base)) throw new Error('Agent must be inside repository');
  const path=realpathSync(logical);
  if (!inside(path)) throw new Error('Agent must be inside repository');
  const relativePath=relative(base,logical);
  const contents = readFileSync(path, 'utf8');
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(contents);
  if (frontmatter.name !== name || typeof frontmatter.description !== 'string') throw new Error('Invalid agent frontmatter');
  const raw = frontmatter.tools;
  if (raw !== undefined && !Array.isArray(raw) && typeof raw !== 'string') throw new Error('Invalid tools');
  if (frontmatter.model !== undefined && (typeof frontmatter.model !== 'string' || !frontmatter.model.trim())) throw new Error('Invalid model');
  const tools = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : undefined;
  if (tools && !tools.every(x => typeof x === 'string')) throw new Error('Invalid tools');
  return {name, relativePath, description: frontmatter.description, prompt: body.trim(), path, contents, model: typeof frontmatter.model === 'string' ? frontmatter.model : undefined, tools: tools?.map(x => x.trim()).filter(Boolean)};
}
