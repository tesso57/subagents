import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertChildSkills, mapParentSkills } from '../extensions/src/skills.ts';

test('matches skill name, description and actual file', () => {
 const root=mkdtempSync(join(tmpdir(),'skill-inventory-')),first=join(root,'first.md'),second=join(root,'second.md');writeFileSync(first,'one');writeFileSync(second,'two');
 const expected=[{name:'example',description:'Example',path:first}];
 assert.doesNotThrow(()=>assertChildSkills(expected,[{name:'example',description:'Example',filePath:first}]));
 assert.throws(()=>assertChildSkills(expected,[{name:'example',description:'Different',filePath:first}]),/differs/);
 assert.throws(()=>assertChildSkills(expected,[{name:'example',description:'Example',filePath:second}]),/path differs/);
 assert.throws(()=>assertChildSkills(expected,[{name:'example',description:'Example',filePath:first},{name:'extra',description:'Extra',filePath:first}]),/absent from parent/);
});

test('maps a parent skill and supporting files to an identical worktree', () => {
 const root=mkdtempSync(join(tmpdir(),'skill-parent-')),worktree=mkdtempSync(join(tmpdir(),'skill-child-'));
 for(const dir of [root,worktree]) {mkdirSync(join(dir,'skill'));writeFileSync(join(dir,'skill','SKILL.md'),'body');writeFileSync(join(dir,'skill','guide.md'),'guide');}
 const result=mapParentSkills(root,worktree,[{name:'example',description:'Example',path:join(root,'skill','SKILL.md')}]);
 assert.equal(result[0].path,join(worktree,'skill','SKILL.md'));
 writeFileSync(join(root,'skill','guide.md'),'changed');
 assert.throws(()=>mapParentSkills(root,worktree,[{name:'example',description:'Example',path:join(root,'skill','SKILL.md')}]),/differs/);
});

test('detects a child exposing a skill hidden from the parent model', async () => {
 const { inferParentSkillVisibility }=await import('../extensions/src/skills.ts');
 const path=join(mkdtempSync(join(tmpdir(),'skill-visible-')),'SKILL.md');writeFileSync(path,'body');
 const expected=inferParentSkillVisibility([{name:'example',description:'Example',path}],undefined,['read']);
 assert.equal(expected[0].visible,false);
 assert.throws(()=>assertChildSkills(expected,[{name:'example',description:'Example',filePath:path,disableModelInvocation:false}]),/visibility/i);
});

test('derives visible skills from the exact Pi-rendered section', async () => {
 const {formatSkillsForPrompt}=await import('@earendil-works/pi-coding-agent');const {inferParentSkillVisibility}=await import('../extensions/src/skills.ts');
 const root=mkdtempSync(join(tmpdir(),'skill-visible-list-')),first=join(root,'first.md'),second=join(root,'second.md');writeFileSync(first,'one');writeFileSync(second,'two');
 const skills=[{name:'first',description:'Example & details',path:first},{name:'second',description:'Hidden',path:second}];
 const render=skills.map((s,i)=>({name:s.name,description:s.description,filePath:s.path,disableModelInvocation:i===1})) as any;
 const section=`<skills>\n${formatSkillsForPrompt(render,'read').trim()}\n</skills>`;
 const expected=inferParentSkillVisibility(skills,section,['read']);assert.deepEqual(expected.map(s=>s.visible),[true,false]);
 assert.doesNotThrow(()=>assertChildSkills(expected,[{name:'first',description:'Example & details',filePath:first,disableModelInvocation:false},{name:'second',description:'Hidden',filePath:second,disableModelInvocation:true}]));
 assert.throws(()=>inferParentSkillVisibility(skills,section.replace('Example &amp; details','Changed'),['read']),/cannot be verified/);
});

test('does not infer baseline skill visibility from a custom prompt decoy', async () => {
 const {formatSkillsForPrompt}=await import('@earendil-works/pi-coding-agent');const {inferBaselineSkillVisibility}=await import('../extensions/src/skills.ts');
 const root=mkdtempSync(join(tmpdir(),'skill-baseline-decoy-')),path=join(root,'SKILL.md');writeFileSync(path,'body');const skills=[{name:'demo',description:'Demo',path}];
 const rendered=formatSkillsForPrompt([{name:'demo',description:'Demo',filePath:path,disableModelInvocation:false} as any],'read').trim();const custom=`<skills>\n${rendered}\n</skills>`;const prompt=`${custom}\n\n<cwd>\n${root}\n</cwd>`;
 assert.equal(inferBaselineSkillVisibility(skills,prompt,['read'],root,custom)?.[0].visible,false);
 assert.equal(inferBaselineSkillVisibility(skills,prompt,['codemode'],root,custom)?.[0].visible,undefined);
});
