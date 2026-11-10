import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as resolveImport } from 'import-meta-resolve';
import { createRequire, builtinModules } from 'node:module';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import { mapWorktreeExtensions } from './inheritance.ts';

type GraphFile={path:string;hash:string;mode:number};
type GraphEdge={from:string;specifier:string;to?:string;mode?:'import'|'require';local?:boolean;external?:{hash?:string;mode?:number}};
export type ExtensionGraph={files:GraphFile[];edges:GraphEdge[]};

function fileHash(path:string) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function inside(root:string,path:string) { const r=relative(root,path);return r!== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); }
function isLocal(specifier:string) { return specifier.startsWith('.') || isAbsolute(specifier) || specifier.startsWith('file://'); }
function localImportBase(from:string,specifier:string,mode:'import'|'require') {
  if(specifier.startsWith('file://')) return fileURLToPath(specifier);
  return mode==='import' ? fileURLToPath(new URL(specifier,pathToFileURL(from))) : resolve(dirname(from),specifier);
}
function resolveLocalImport(from:string,specifier:string,mode:'import'|'require') {
  const base=localImportBase(from,specifier,mode);
  const candidates=[base];
  if (base.endsWith('.mjs')) candidates.push(base.slice(0,-4)+'.mts');
  else if (base.endsWith('.cjs')) candidates.push(base.slice(0,-4)+'.cts');
  else if (base.endsWith('.js')) candidates.push(base.slice(0,-3)+'.ts',base.slice(0,-3)+'.tsx');
  for(const ext of ['.ts','.tsx','.mts','.cts','.js','.jsx','.mjs','.cjs','.json']) candidates.push(base+ext);
  for(const candidate of candidates) { try {if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate);} catch {} }
  try {const resolved=createRequire(from).resolve(specifier);if(isAbsolute(resolved) && statSync(resolved).isFile()) return realpathSync(resolved);} catch {}
  for(const ext of ['.ts','.tsx','.mts','.cts','.js','.jsx','.mjs','.cjs','.json']) {const candidate=join(base,`index${ext}`);try {if(existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate);} catch {}}
  throw new Error(`Cannot resolve local extension import ${specifier} from ${from}`);
}

function resolveBareImport(from:string,specifier:string,mode:'import'|'require'):string | undefined {
  try {
    const resolved=mode==='require' ? createRequire(from).resolve(specifier) : resolveImport(specifier,pathToFileURL(from).href);
    const path=resolved.startsWith('file://') ? fileURLToPath(resolved) : resolved;
    return isAbsolute(path) && statSync(path).isFile() ? realpathSync(path) : undefined;
  } catch {return undefined;}
}
function nearestManifest(from:string,root:string):string | undefined {
  let dir=dirname(from);
  while(inside(root,dir)) {
    const manifest=join(dir,'package.json');if(existsSync(manifest)) return manifest;
    const parent=dirname(dir);if(parent===dir) break;dir=parent;
  }
  return undefined;
}

/** Capture statically resolvable relative dependencies of project-local extension entry points. */
export function snapshotExtensionGraph(entries:string[],root?:string):ExtensionGraph {
  const files:GraphFile[]=[],edges:GraphEdge[]=[],seen=new Set<string>();
  const canonicalRoot=root ? realpathSync(root) : undefined;
  const visit=(path:string)=>{
    const file=realpathSync(path);if(seen.has(file)) return;seen.add(file);
    files.push({path:file,hash:fileHash(file),mode:statSync(file).mode & 0o111});
    const ext=extname(file).toLowerCase();
    if (!['.ts','.tsx','.mts','.cts','.js','.jsx','.mjs','.cjs'].includes(ext)) return;
    const plugins:any[]=['typescript','decorators-legacy','importAttributes'];if(!['.ts','.mts','.cts'].includes(ext)) plugins.push('jsx');
    let ast:any;try {ast=parse(readFileSync(file,'utf8'),{sourceType:'unambiguous',allowReturnOutsideFunction:true,plugins});}
    catch (error) {throw new Error(`Cannot parse extension dependency ${file}: ${error instanceof Error?error.message:String(error)}`);}
    const add=(specifier:unknown,kind:string)=>{
      if(typeof specifier!=='string') throw new Error(`Cannot verify dynamic ${kind} in extension: ${file}`);
      if(!isLocal(specifier)) {
        if(!canonicalRoot) {if(specifier.startsWith('#')) throw new Error(`Cannot verify package import alias ${specifier} in ${file}`);return;}
        if(specifier.startsWith('node:') || builtinModules.includes(specifier)) return;
        const hostPackages=['@earendil-works/pi-ai','@earendil-works/pi-agent-core','@earendil-works/pi-coding-agent','@earendil-works/pi-tui','typebox'];
        if(hostPackages.some(name=>specifier===name || specifier.startsWith(`${name}/`))) return;
        const mode=kind==='require' ? 'require' : 'import';
        const target=resolveBareImport(file,specifier,mode);
        if(specifier.startsWith('#')) {
          const manifest=nearestManifest(file,canonicalRoot);
          if(!manifest || !target) throw new Error(`Cannot resolve package import alias ${specifier} in ${file}`);
          visit(manifest);
        }
        if(target && inside(canonicalRoot,target) && !relative(canonicalRoot,target).split(sep).includes('node_modules')) {
          const manifest=nearestManifest(file,canonicalRoot);if(manifest) visit(manifest);
          edges.push({from:file,specifier,to:target,mode});visit(target);
        } else {
          edges.push({from:file,specifier,to:target,mode,external:target ? {hash:fileHash(target),mode:statSync(target).mode & 0o111} : {}});
        }
        return;
      }
      const mode=kind==='require' ? 'require' : 'import';
      const base=localImportBase(file,specifier,mode);
      let directory=false;try {directory=statSync(base).isDirectory();} catch {}
      if(directory) {const manifest=join(base,'package.json');if(existsSync(manifest)) visit(manifest);}
      const target=resolveLocalImport(file,specifier,mode);edges.push({from:file,specifier,to:target,mode,local:true});visit(target);
    };
    const loaders=new Set<any>(),creators=new Set<any>(),moduleNamespaces=new Set<any>(),moduleObjects=new Set<any>();
    const staticString=(node:any):string | undefined=>{
      if(node?.type==='StringLiteral') return node.value;
      if(node?.type==='TemplateLiteral' && node.expressions.length===0) return node.quasis[0]?.value.cooked ?? undefined;
      if(node?.type==='BinaryExpression' && node.operator==='+') {const left=staticString(node.left),right=staticString(node.right);return left===undefined || right===undefined ? undefined : left+right;}
      return undefined;
    };
    const property=(node:any)=>node?.computed ? staticString(node.property) : node?.property?.name;
    const unwrapped=(node:any):any=>{
      while (node && ['TSAsExpression','TSTypeAssertion','TSNonNullExpression','ParenthesizedExpression'].includes(node.type)) node=node.expression;
      return node?.type==='SequenceExpression' ? unwrapped(node.expressions.at(-1)) : node;
    };
    const binding=(path:any,name:string)=>path.scope.getBinding(name);
    const isLoader=(path:any,raw:any):boolean=>{
      const node=unwrapped(raw);
      if(node?.type==='Identifier') return node.name==='require' && !binding(path,'require') || loaders.has(binding(path,node.name));
      if(node?.type==='MemberExpression' && property(node)==='require' && node.object?.type==='Identifier' && (node.object.name==='module' && !binding(path,'module') || moduleObjects.has(binding(path,node.object.name)))) return true;
      if(node?.type==='CallExpression' && node.callee?.type==='MemberExpression' && property(node.callee)==='bind') return isLoader(path,node.callee.object);
      return false;
    };
    const isModuleObject=(path:any,node:any):boolean=>node?.type==='Identifier' && (node.name==='module' && !binding(path,'module') || moduleObjects.has(binding(path,node.name)));
    const isProcessObject=(path:any,node:any):boolean=>node?.type==='Identifier' && node.name==='process' && !binding(path,'process');
    const isBuiltinModuleCall=(path:any,node:any):boolean=>node?.type==='CallExpression' && node.callee?.type==='MemberExpression' && isProcessObject(path,node.callee.object) && property(node.callee)==='getBuiltinModule' && ['module','node:module'].includes(staticString(node.arguments?.[0]) ?? '');
    const isCreator=(path:any,raw:any):boolean=>{
      const node=unwrapped(raw);
      if(node?.type==='Identifier') return creators.has(binding(path,node.name));
      if(node?.type==='MemberExpression' && property(node)==='createRequire') {
        if(node.object?.type==='Identifier') return moduleNamespaces.has(binding(path,node.object.name));
        return isBuiltinModuleCall(path,node.object) || node.object?.type==='CallExpression' && isLoader(path,node.object.callee) && ['module','node:module'].includes(staticString(node.object.arguments?.[0]) ?? '');
      }
      return false;
    };
    let changed=true;
    while(changed) {
      changed=false;
      const addBinding=(set:Set<any>,value:any)=>{if(value && !set.has(value)) {set.add(value);changed=true;}};
      traverse(ast,{
        ImportDeclaration(path:any) {
          if(!['module','node:module'].includes(path.node.source.value)) return;
          for(const specifier of path.node.specifiers) {
            if(specifier.type==='ImportNamespaceSpecifier' || specifier.type==='ImportDefaultSpecifier') addBinding(moduleNamespaces,binding(path,specifier.local.name));
            else if(specifier.type==='ImportSpecifier' && (specifier.imported.name ?? specifier.imported.value)==='createRequire') addBinding(creators,binding(path,specifier.local.name));
          }
        },
        VariableDeclarator(path:any) {
          const {id,init}=path.node;if(!init) return;
          if(id.type==='Identifier') {
            const target=binding(path,id.name),value=unwrapped(init);
            if(value?.type==='Identifier' && (value.name==='module' && !binding(path,'module') || moduleObjects.has(binding(path,value.name)))) addBinding(moduleObjects,target);
            if(isLoader(path,value) || value?.type==='CallExpression' && isCreator(path,value.callee)) addBinding(loaders,target);
            if(isCreator(path,value)) addBinding(creators,target);
            if(isBuiltinModuleCall(path,value) || value?.type==='CallExpression' && isLoader(path,value.callee) && ['module','node:module'].includes(staticString(value.arguments?.[0]) ?? '')) addBinding(moduleNamespaces,target);
          } else if(id.type==='ObjectPattern' && (isBuiltinModuleCall(path,init) || init.type==='CallExpression' && isLoader(path,init.callee) && ['module','node:module'].includes(staticString(init.arguments?.[0]) ?? ''))) {
            for(const prop of id.properties) if(prop.type==='ObjectProperty' && (prop.key.name ?? prop.key.value)==='createRequire' && prop.value.type==='Identifier') addBinding(creators,binding(path,prop.value.name));
          } else if(id.type==='ObjectPattern' && init.type==='Identifier' && (init.name==='module' && !binding(path,'module') || moduleObjects.has(binding(path,init.name)))) {
            for(const prop of id.properties) if(prop.type==='ObjectProperty' && (prop.key.name ?? prop.key.value)==='require' && prop.value.type==='Identifier') addBinding(loaders,binding(path,prop.value.name));
          } else if(id.type==='ObjectPattern' && init.type==='Identifier' && moduleNamespaces.has(binding(path,init.name))) {
            for(const prop of id.properties) if(prop.type==='ObjectProperty' && (prop.key.name ?? prop.key.value)==='createRequire' && prop.value.type==='Identifier') addBinding(creators,binding(path,prop.value.name));
          }
        },
        AssignmentExpression(path:any) {
          const {left,right}=path.node;if(left.type!=='Identifier') return;
          const target=binding(path,left.name),value=unwrapped(right);
          if(value?.type==='Identifier' && (value.name==='module' && !binding(path,'module') || moduleObjects.has(binding(path,value.name)))) addBinding(moduleObjects,target);
          if(isLoader(path,value) || value?.type==='CallExpression' && isCreator(path,value.callee)) addBinding(loaders,target);
          if(isCreator(path,value)) addBinding(creators,target);
        },
      } as any);
    }
    const safeLoaderReference=(reference:any):boolean=>{
      let current=reference;
      while (current.parentPath) {
        const parent=current.parentPath,node=parent.node;
        if (['TSAsExpression','TSTypeAssertion','TSNonNullExpression','ParenthesizedExpression'].includes(node.type) && node.expression===current.node) {current=parent;continue;}
        if (node.type==='SequenceExpression' && node.expressions.at(-1)===current.node) {current=parent;continue;}
        if (node.type==='VariableDeclarator' && node.init===current.node && node.id.type==='Identifier') return true;
        if (node.type==='AssignmentExpression' && node.right===current.node && node.left.type==='Identifier') return true;
        if (node.type==='CallExpression' && node.callee===current.node) return true;
        if (node.type==='UnaryExpression' && node.operator==='typeof') return true;
        if (node.type==='MemberExpression' && node.object===current.node && property(node)==='resolve' && parent.parentPath?.node.type==='CallExpression' && parent.parentPath.node.callee===node) return true;
        if (node.type==='MemberExpression' && node.object===current.node && property(node)==='bind' && parent.parentPath?.node.type==='CallExpression' && parent.parentPath.node.callee===node) {current=parent.parentPath;continue;}
        return false;
      }
      return false;
    };
    traverse(ast,{
      ImportDeclaration(path:any) {
        const node=path.node;
        if(node.importKind!=='type' && (node.specifiers.length===0 || node.specifiers.some((item:any)=>item.importKind!=='type'))) add(node.source.value,'import');
      },
      ExportNamedDeclaration(path:any) {const node=path.node;if(node.source && node.exportKind!=='type' && (node.specifiers.length===0 || node.specifiers.some((item:any)=>item.exportKind!=='type'))) add(node.source.value,'export');},
      ExportAllDeclaration(path:any) {const node=path.node;if(node.source && node.exportKind!=='type') add(node.source.value,'export');},
      TSImportEqualsDeclaration(path:any) {const node=path.node;if(node.moduleReference?.type==='TSExternalModuleReference' && !node.isTypeOnly && node.importKind!=='type') add(node.moduleReference.expression?.value,'require');},
      ImportExpression(path:any) {add(staticString(path.node.source),'import');},
      ReferencedIdentifier(path:any) {
        if(isLoader(path,path.node) && !safeLoaderReference(path)) throw new Error(`Cannot verify escaped require in extension: ${file}`);
      },
      MemberExpression(path:any) {
        if (path.node.computed && property(path.node)===undefined && (isModuleObject(path,path.node.object) || isProcessObject(path,path.node.object) || path.node.object?.type==='Identifier' && moduleNamespaces.has(binding(path,path.node.object.name)))) throw new Error(`Cannot verify dynamic module property in extension: ${file}`);
        if(isLoader(path,path.node) && !safeLoaderReference(path)) throw new Error(`Cannot verify escaped require in extension: ${file}`);
      },
      CallExpression(path:any) {
        const node=path.node,callee=node.callee;
        if(callee?.type==='MemberExpression' && isProcessObject(path,callee.object) && property(callee)==='getBuiltinModule' && staticString(node.arguments?.[0])===undefined) throw new Error(`Cannot verify dynamic builtin module in extension: ${file}`);
        const direct=isLoader(path,callee);
        const resolved=callee?.type==='MemberExpression' && property(callee)==='resolve' && isLoader(path,callee.object);
        if (direct || resolved) add(staticString(node.arguments?.[0]),'require');
      },
    } as any);
  };
  for(const entry of entries) {
    if (/^(npm:|git:|builtin:|https?:\/\/|ssh:\/\/)/i.test(entry)) continue;
    let path:string;try {path=realpathSync(entry);} catch {throw new Error(`Cannot snapshot extension resource: ${entry}`);}
    if (canonicalRoot && !inside(canonicalRoot,path)) continue;
    if(statSync(path).isFile()) visit(path);
  }
  return {files,edges};
}

/** Check the parent's startup files have not changed and map each local dependency into the worktree. */
export function validateExtensionGraph(graph:ExtensionGraph,root:string,worktree:string) {
  const mapping=new Map<string,string>();
  for(const file of graph.files) {
    let matches=false;try {matches=fileHash(file.path)===file.hash && (statSync(file.path).mode & 0o111)===file.mode;} catch {}
    if(!matches) throw new Error(`Extension dependency changed since parent startup: ${file.path}`);
    const mapped=mapWorktreeExtensions(root,worktree,[file.path])[0];
    mapping.set(file.path,realpathSync(mapped));
  }
  for(const edge of graph.edges) {
    const from=mapping.get(edge.from);if(!from) throw new Error(`Extension import source is missing: ${edge.from}`);
    if(edge.external) {
      const current=edge.to ? resolveBareImport(edge.from,edge.specifier,edge.mode!) : undefined;
      const child=resolveBareImport(from,edge.specifier,edge.mode!);
      if(edge.to && (!current || fileHash(current)!==edge.external.hash || (statSync(current).mode & 0o111)!==edge.external.mode)) throw new Error(`Extension package changed since parent startup: ${edge.specifier}`);
      if((!edge.to && child) || (edge.to && (!child || fileHash(child)!==edge.external.hash || (statSync(child).mode & 0o111)!==edge.external.mode))) throw new Error(`Extension package differs in worktree: ${edge.specifier}`);
    } else {
      const expected=edge.to ? mapping.get(edge.to) : undefined;
      if(!expected || (edge.local ? resolveLocalImport(from,edge.specifier,edge.mode!) : resolveBareImport(from,edge.specifier,edge.mode!))!==expected) throw new Error(`Extension import resolves differently in worktree: ${edge.specifier}`);
    }
  }
}
