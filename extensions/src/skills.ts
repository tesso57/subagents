import { basename, dirname, join, isAbsolute, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { mapWorktreeSkills } from './inheritance.ts';
import { formatSkillsForPrompt, type Skill } from '@earendil-works/pi-coding-agent';

export type ParentSkill={name:string;description:string;path:string;visible?:boolean};

/** Infer a baseline only from Pi's skills section immediately before its cwd section. */
export function inferBaselineSkillVisibility(skills:ParentSkill[],prompt:string,tools:string[],cwd:string,customPrompt?:string):ParentSkill[] | undefined {
  if (!tools.includes('read') && !tools.includes('bash')) return skills.map(skill=>({...skill,visible:undefined}));
  let remainder=prompt;
  if (customPrompt) {
    if (!remainder.startsWith(customPrompt)) return undefined;
    remainder=remainder.slice(customPrompt.length);
  }
  const cwdSection=`<cwd>\n${cwd.replace(/\\/g,'/')}\n</cwd>`;
  if (!remainder.endsWith(cwdSection)) return undefined;
  const beforeCwd=remainder.slice(0,-cwdSection.length).replace(/\n\n$/,'');
  if (!beforeCwd.endsWith('</skills>')) return inferParentSkillVisibility(skills,undefined,tools);
  const start=beforeCwd.lastIndexOf('<skills>\n');
  if (start<0) return undefined;
  try {return inferParentSkillVisibility(skills,beforeCwd.slice(start),tools);} catch {return undefined;}
}

export function captureRuntimeSkills(skills:Skill[],section:string | undefined,tools:string[]):Skill[] {
  if (!Array.isArray(skills) || !skills.every(skill=>skill && typeof skill.name==='string' && typeof skill.description==='string' && typeof skill.filePath==='string' && typeof skill.baseDir==='string' && typeof skill.disableModelInvocation==='boolean' && skill.sourceInfo && typeof skill.sourceInfo==='object')) throw new Error('Parent runtime skills cannot be verified');
  const snapshot=skills.map(skill=>({...skill,sourceInfo:{...skill.sourceInfo}}));
  const inferred=inferParentSkillVisibility(snapshot.map(skill=>({name:skill.name,description:skill.description,path:skill.filePath})),section,tools);
  if (inferred.some((skill,index)=>skill.visible!==undefined && skill.visible===snapshot[index].disableModelInvocation)) throw new Error('Parent runtime skill visibility differs from the observed prompt');
  return snapshot;
}

export function mapRuntimeSkills(root:string,worktree:string,skills:Skill[],parentCwd:string):Skill[] {
  return skills.map(skill=>{
    if ([skill.filePath,skill.baseDir].some(path=>!isAbsolute(path) && /^[a-z][a-z0-9+.-]*:\/\//i.test(path))) throw new Error(`Runtime skill path cannot be mapped to a worktree: ${skill.name}`);
    const filePath=isAbsolute(skill.filePath) ? skill.filePath : resolve(parentCwd,skill.filePath);
    const baseDir=isAbsolute(skill.baseDir) ? skill.baseDir : resolve(parentCwd,skill.baseDir);
    const mappedFile=mapParentSkills(root,worktree,[{name:skill.name,description:skill.description,path:filePath}])[0].path;
    const mappedBase=realpathSync(baseDir)===realpathSync(dirname(filePath)) ? dirname(mappedFile) : mapWorktreeSkills(root,worktree,[baseDir])[0];
    return {...skill,filePath:mappedFile,baseDir:mappedBase,sourceInfo:{...skill.sourceInfo,...(skill.sourceInfo.path===skill.filePath ? {path:mappedFile} : {}),...(skill.sourceInfo.baseDir===skill.baseDir ? {baseDir:mappedBase} : {})}};
  });
}

export function assertRuntimeSkillVisibility(skills:Skill[],section:string | undefined,tools:string[]) {
  const inferred=inferParentSkillVisibility(skills.map(skill=>({name:skill.name,description:skill.description,path:skill.filePath})),section,tools);
  if (inferred.some((skill,index)=>skill.visible!==undefined && skill.visible===skills[index].disableModelInvocation)) throw new Error('Child runtime skill visibility differs from the parent');
}

/** Derive visibility from the exact skill section that Pi sent to the parent model. */
export function inferParentSkillVisibility(skills:ParentSkill[],section:string | undefined,parentTools:string[]):ParentSkill[] {
  if (section===undefined) {
    const canRead=parentTools.includes('read') || parentTools.includes('bash');
    return skills.map(skill=>({...skill,visible:canRead ? false : undefined}));
  }
  const asSkill=(skill:ParentSkill,visible:boolean)=>({name:skill.name,description:skill.description,filePath:skill.path,disableModelInvocation:!visible} as Skill);
  const withVisibility=skills.map(skill=>{
    const single=formatSkillsForPrompt([asSkill(skill,true)],'read');
    const start=single.indexOf('  <skill>\n'),end=single.indexOf('  </skill>',start);
    if (start<0 || end<0) throw new Error(`Could not render parent skill: ${skill.name}`);
    const block=single.slice(start,end+'  </skill>'.length);
    return {...skill,visible:section.includes(block)};
  });
  const rendered=withVisibility.map(skill=>asSkill(skill,skill.visible));
  const matches=(['read','bash','indirect'] as const).some(reader=>{
    const body=formatSkillsForPrompt(rendered,reader).trim();
    return body && `<skills>\n${body}\n</skills>`===section;
  });
  if (!matches) throw new Error('Parent skill visibility cannot be verified');
  return withVisibility;
}

/** Map project skills to matching worktree files and compare their supporting directories. */
export function mapParentSkills(root:string,worktree:string,skills:ParentSkill[]):ParentSkill[] {
  const roots=skills.map(skill=>basename(skill.path)==='SKILL.md' ? dirname(skill.path) : skill.path);
  const mapped=mapWorktreeSkills(root,worktree,roots);
  return skills.map((skill,index)=>({...skill,path:basename(skill.path)==='SKILL.md' ? join(mapped[index],'SKILL.md') : mapped[index]}));
}

/** Verify that a child discovers the same named skills, descriptions and files as its parent. */
export function assertChildSkills(expected:ParentSkill[],actual:Array<{name:string;description:string;filePath:string;disableModelInvocation?:boolean}>) {
  const remaining=new Map(actual.map(skill=>[skill.name,skill]));
  for (const skill of expected) {
    const found=remaining.get(skill.name);
    if (!found || found.description!==skill.description) throw new Error(`Child skill differs from parent: ${skill.name}`);
    if (skill.visible!==undefined && found.disableModelInvocation!==!skill.visible) throw new Error(`Child skill visibility differs from parent: ${skill.name}`);
    let same=false;
    try {same=realpathSync(found.filePath)===realpathSync(skill.path);} catch {}
    if (!same) throw new Error(`Child skill path differs from parent: ${skill.name}`);
    remaining.delete(skill.name);
  }
  if (remaining.size) throw new Error(`Child discovered skills absent from parent: ${[...remaining.keys()].join(', ')}`);
}
