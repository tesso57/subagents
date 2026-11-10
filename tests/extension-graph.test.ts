import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {snapshotExtensionGraph,validateExtensionGraph} from '../extensions/src/extension-graph.ts';

test('checks a TypeScript extension and its relative runtime imports', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-root-')),worktree=mkdtempSync(join(tmpdir(),'extension-graph-wt-'));
 for(const base of [root,worktree]) {writeFileSync(join(base,'guard.ts'),"import {enabled} from './policy.js'; export default () => enabled;\n");writeFileSync(join(base,'policy.ts'),'export const enabled=true;\n');}
 const snapshot=snapshotExtensionGraph([join(root,'guard.ts')]);
 assert.equal(snapshot.files.length,2);
 writeFileSync(join(root,'policy.ts'),'export const enabled=false;\n');
 assert.throws(()=>validateExtensionGraph(snapshot,root,worktree),/changed since parent/i);
});

test('rejects computed imports whose dependency cannot be verified', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-dynamic-'));
 const file=join(root,'guard.ts');writeFileSync(file,'export default async function(name:string){ return import(name); }');
 assert.throws(()=>snapshotExtensionGraph([file]),/dynamic.*import/i);
});

test('rejects worktree dependencies that differ even when the entry file matches', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-source-')),worktree=mkdtempSync(join(tmpdir(),'extension-graph-child-'));
 for(const base of [root,worktree]) {writeFileSync(join(base,'guard.js'),"import {enabled} from './policy.js'; export default () => enabled;\n");writeFileSync(join(base,'policy.js'),'export const enabled=true;\n');}
 const snapshot=snapshotExtensionGraph([join(root,'guard.js')],root);
 writeFileSync(join(worktree,'policy.js'),'export const enabled=false;\n');
 assert.throws(()=>validateExtensionGraph(snapshot,root,worktree),/differs/i);
});

test('checks literal CommonJS and dynamic-import dependencies', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-literal-'));
 writeFileSync(join(root,'guard.ts'),"const policy=require('./policy.json'); export default async () => (await import('./rules.ts')).ok && policy.enabled;");
 writeFileSync(join(root,'policy.json'),'{"enabled":true}');writeFileSync(join(root,'rules.ts'),'export const ok=true;');
 const snapshot=snapshotExtensionGraph([join(root,'guard.ts')],root);
 assert.equal(snapshot.files.length,3);
});

test('tracks module.require and aliased require dependencies', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-alias-'));
 writeFileSync(join(root,'guard.cjs'),"const r = require; const a = module.require('./policy.cjs'); const b = r('./second.cjs'); module.exports = a && b;");
 writeFileSync(join(root,'policy.cjs'),'module.exports=true;');writeFileSync(join(root,'second.cjs'),'module.exports=true;');
 const snapshot=snapshotExtensionGraph([join(root,'guard.cjs')],root);assert.equal(snapshot.files.length,3);
});

test('tracks createRequire aliases and rejects computed module.require', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-create-'));
 const file=join(root,'guard.mjs');writeFileSync(file,"import {createRequire as make} from 'node:module'; const load = make(import.meta.url); export default load('./policy.cjs');");writeFileSync(join(root,'policy.cjs'),'module.exports=true;');
 assert.equal(snapshotExtensionGraph([file],root).files.length,2);
 writeFileSync(file,'export default function(name){ return module.require(name); }');
 assert.throws(()=>snapshotExtensionGraph([file],root),/dynamic.*require/i);
});

test('does not treat a locally declared require function as a module loader', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-shadow-')),file=join(root,'guard.ts');
 writeFileSync(file,'function require(name:string){return name.toUpperCase()} export default function(level:string){return require(level)}');
 assert.equal(snapshotExtensionGraph([file],root).files.length,1);
});

test('distinguishes shadowed require bindings from the real module loader', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-scopes-')),file=join(root,'guard.js');
 writeFileSync(file,'function safe(require, name){return require(name)} function unsafe(name){return require(name)} export {safe,unsafe};');
 assert.throws(()=>snapshotExtensionGraph([file],root),/dynamic.*require/i);
 writeFileSync(file,'const load=require; function safe(load,name){return load(name)} export {safe};');
 assert.doesNotThrow(()=>snapshotExtensionGraph([file],root));
});

test('still tracks real imports when another scope shadows require', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-scope-mixed-')),file=join(root,'guard.js');
 writeFileSync(file,"function safe(require,name){return require(name)} const policy=require('./policy.cjs'); export {safe,policy};");writeFileSync(join(root,'policy.cjs'),'module.exports=true;');
 assert.equal(snapshotExtensionGraph([file],root).files.length,2);
});

test('tracks destructured and assigned aliases of module.require', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-assign-')),file=join(root,'guard.cjs');writeFileSync(join(root,'policy.cjs'),'module.exports=true;');
 writeFileSync(file,"const {require: load}=module; module.exports=load('./policy.cjs');");assert.equal(snapshotExtensionGraph([file],root).files.length,2);
 writeFileSync(file,"let load; load=require; module.exports=load('./policy.cjs');");assert.equal(snapshotExtensionGraph([file],root).files.length,2);
});

test('tracks a default module import used to create a require function', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-module-')),file=join(root,'guard.mjs');writeFileSync(join(root,'policy.cjs'),'module.exports=true;');
 writeFileSync(file,"import nodeModule from 'node:module'; const load=nodeModule.createRequire(import.meta.url); export default load('./policy.cjs');");
 assert.equal(snapshotExtensionGraph([file],root).files.length,2);
});

test('tracks require calls through a module alias', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-module-alias-')),file=join(root,'guard.cjs');writeFileSync(join(root,'policy.cjs'),'module.exports=true;');
 writeFileSync(file,"const current=module; module.exports=current.require('./policy.cjs');");assert.equal(snapshotExtensionGraph([file],root).files.length,2);
});

test('rejects module loader aliases passed through unknown functions', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-escape-')),file=join(root,'guard.cjs');
 writeFileSync(file,"const identity = x => x; const load=identity(require); module.exports=load('./policy.cjs');");writeFileSync(join(root,'policy.cjs'),'module.exports=true;');
 assert.throws(()=>snapshotExtensionGraph([file],root),/cannot verify.*require/i);
});

test('tracks TypeScript import-equals dependencies', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-ts-equals-')),file=join(root,'guard.ts');writeFileSync(join(root,'policy.cjs'),'module.exports=true;');
 writeFileSync(file,"import policy = require('./policy.cjs'); export default policy;");assert.equal(snapshotExtensionGraph([file],root).files.length,2);
});

test('tracks computed static module.require and rejects unknown module properties', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-computed-')),file=join(root,'guard.cjs');writeFileSync(join(root,'policy.cjs'),'module.exports=true;');
 writeFileSync(file,"module.exports=module['re'+'quire']('./policy.cjs');");assert.equal(snapshotExtensionGraph([file],root).files.length,2);
 writeFileSync(file,'export default function(name,key){return module[key](name)}');assert.throws(()=>snapshotExtensionGraph([file],root),/cannot verify.*module/i);
});

test('tracks loaders created through process.getBuiltinModule', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-builtin-')),file=join(root,'guard.cjs');writeFileSync(join(root,'policy.cjs'),'module.exports=true;');
 writeFileSync(file,"const load=process.getBuiltinModule('module').createRequire(__filename);module.exports=load('./policy.cjs');");assert.equal(snapshotExtensionGraph([file],root).files.length,2);
 writeFileSync(file,"const mod=process.getBuiltinModule('module'); const load=mod.createRequire(__filename); module.exports=load('./policy.cjs');");assert.equal(snapshotExtensionGraph([file],root).files.length,2);
});

test('accepts a static template literal import', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-template-')),file=join(root,'guard.mjs');writeFileSync(join(root,'policy.mjs'),'export const enabled=true;');
 writeFileSync(file,'export default async function(){return import(`./policy.mjs`)}');assert.equal(snapshotExtensionGraph([file],root).files.length,2);
});

test('resolves local package directories using package.json main', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-main-')),file=join(root,'guard.cjs');mkdirSync(join(root,'policy'));
 writeFileSync(file,"module.exports=require('./policy');");writeFileSync(join(root,'policy','package.json'),JSON.stringify({main:'./actual.cjs'}));writeFileSync(join(root,'policy','actual.cjs'),'module.exports=true;');
 assert.equal(snapshotExtensionGraph([file],root).files.length,3);
});

test('ignores type-only exports but follows mixed runtime exports', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-type-export-')),file=join(root,'guard.ts');
 writeFileSync(file,"export {type Foo} from './missing-types'; export {type Bar, value} from './policy';");writeFileSync(join(root,'policy.ts'),'export const value=true;');
 assert.equal(snapshotExtensionGraph([file],root).files.length,2);
});

test('tracks destructured createRequire from process.getBuiltinModule', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-builtin-destructure-')),file=join(root,'guard.cjs');writeFileSync(join(root,'policy.cjs'),'module.exports=true;');
 writeFileSync(file,"const {createRequire: make}=process.getBuiltinModule('module');const load=make(__filename);module.exports=load('./policy.cjs');");assert.equal(snapshotExtensionGraph([file],root).files.length,2);
});

test('tracks createRequire destructured from a module namespace', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-namespace-')),file=join(root,'guard.mjs');writeFileSync(join(root,'policy.cjs'),'module.exports=true;');
 writeFileSync(file,"import * as Module from 'node:module'; const {createRequire:make}=Module; const load=make(import.meta.url); export default load('./policy.cjs');");assert.equal(snapshotExtensionGraph([file],root).files.length,2);
 writeFileSync(file,"const Module=process.getBuiltinModule('module'); const {createRequire}=Module; const load=createRequire(import.meta.url); export default load('./policy.cjs');");assert.equal(snapshotExtensionGraph([file],root).files.length,2);
});

test('tracks repository-local package self-reference exports', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-self-')),file=join(root,'guard.mjs');
 writeFileSync(join(root,'package.json'),JSON.stringify({name:'my-guard-pkg',type:'module',exports:{'./policy':{'import':'./policy.mjs','require':'./policy.cjs'}}}));
 writeFileSync(file,"import {enabled} from 'my-guard-pkg/policy'; export default enabled;");writeFileSync(join(root,'policy.mjs'),'export const enabled=true;');writeFileSync(join(root,'policy.cjs'),'exports.enabled=true;');
 const snapshot=snapshotExtensionGraph([file],root);assert.equal(snapshot.files.length,3);
});

test('checks the package export condition used by the extension', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-conditions-')),file=join(root,'guard.mjs');
 writeFileSync(join(root,'package.json'),JSON.stringify({name:'condition-pkg',type:'module',exports:{'./policy':{'import':'./good.mjs','require':'./unused.cjs'}}}));
 writeFileSync(join(root,'good.mjs'),'export const enabled=true;');writeFileSync(join(root,'unused.cjs'),'module.exports=name=>require(name);');
 writeFileSync(file,"import {enabled} from 'condition-pkg/policy'; export default enabled;");assert.doesNotThrow(()=>snapshotExtensionGraph([file],root));
 const commonjs=join(root,'guard.cjs');writeFileSync(commonjs,"module.exports=require('condition-pkg/policy');");assert.throws(()=>snapshotExtensionGraph([commonjs],root),/dynamic.*require/i);
});

test('rejects an external package that resolves to different code in the worktree', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-external-root-')),worktree=mkdtempSync(join(tmpdir(),'extension-external-wt-'));
 for(const base of [root,worktree]) {mkdirSync(join(base,'node_modules','policy'),{recursive:true});writeFileSync(join(base,'guard.cjs'),"module.exports=require('policy');");writeFileSync(join(base,'node_modules','policy','package.json'),JSON.stringify({name:'policy',main:'index.js'}));writeFileSync(join(base,'node_modules','policy','index.js'),'module.exports=true;');}
 const snapshot=snapshotExtensionGraph([join(root,'guard.cjs')],root);writeFileSync(join(worktree,'node_modules','policy','index.js'),'module.exports=false;');
 assert.throws(()=>validateExtensionGraph(snapshot,root,worktree),/package.*differs/i);
});

test('matches Pi loading of TypeScript package self-reference import conditions', async () => {
 const {DefaultResourceLoader}=await import('@earendil-works/pi-coding-agent');
 const root=mkdtempSync(join(tmpdir(),'extension-graph-ts-condition-')),agentDir=mkdtempSync(join(tmpdir(),'extension-graph-ts-cfg-')),file=join(root,'guard.ts');
 writeFileSync(join(root,'package.json'),JSON.stringify({name:'condition-pkg',type:'module',exports:{'./policy':{'import':'./good.mjs','require':'./unused.cjs'}}}));
 writeFileSync(join(root,'good.mjs'),'export const enabled=true;');writeFileSync(join(root,'unused.cjs'),'module.exports=name=>require(name);');
 writeFileSync(file,"import {enabled} from 'condition-pkg/policy'; export default function(pi:any){if(enabled) pi.on('tool_call',()=>({block:true}));}");
 const loader=new DefaultResourceLoader({cwd:root,agentDir,additionalExtensionPaths:[file],noSkills:true,noContextFiles:true,noPromptTemplates:true,noThemes:true});await loader.reload();
 assert.deepEqual(loader.getExtensions().errors,[]);assert.ok(loader.getExtensions().extensions.some(e=>e.handlers.has('tool_call')));
 assert.doesNotThrow(()=>snapshotExtensionGraph([file],root));
});

test('tracks relative ESM imports containing query strings and fragments', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-query-')),worktree=mkdtempSync(join(tmpdir(),'extension-graph-query-wt-'));
 for(const base of [root,worktree]) {writeFileSync(join(base,'guard.mjs'),"import {enabled} from './policy.mjs?variant=1#section';export default enabled;");writeFileSync(join(base,'policy.mjs'),'export const enabled=true;');}
 const snapshot=snapshotExtensionGraph([join(root,'guard.mjs')],root);assert.equal(snapshot.files.length,2);assert.doesNotThrow(()=>validateExtensionGraph(snapshot,root,worktree));
 writeFileSync(join(worktree,'policy.mjs'),'export const enabled=false;');assert.throws(()=>validateExtensionGraph(snapshot,root,worktree),/differs/i);
});

test('tracks local package imports aliases', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-imports-')),file=join(root,'guard.mjs');
 writeFileSync(join(root,'package.json'),JSON.stringify({name:'alias-pkg',type:'module',imports:{'#policy':'./policy.mjs'}}));writeFileSync(join(root,'policy.mjs'),'export const enabled=true;');
 writeFileSync(file,"import {enabled} from '#policy'; export default enabled;");
 const snapshot=snapshotExtensionGraph([file],root);assert.equal(snapshot.files.length,3);
});

test('resolves NodeNext .mjs and .cjs imports to TypeScript sources', () => {
 const root=mkdtempSync(join(tmpdir(),'extension-graph-nodenext-')),file=join(root,'guard.mts');
 writeFileSync(file,"import {enabled} from './policy.mjs';import options = require('./options.cjs');export default enabled && options;");
 writeFileSync(join(root,'policy.mts'),'export const enabled=true;');writeFileSync(join(root,'options.cts'),'export = true;');
 assert.equal(snapshotExtensionGraph([file],root).files.length,3);
});
