import { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { realpathSync } from 'node:fs';

/** Resolve configured project extensions without installing missing packages. */
export async function configuredProjectExtensions(cwd:string,agentDir:string,projectTrusted:boolean):Promise<string[]> {
  const settingsManager=SettingsManager.create(cwd,agentDir,{projectTrusted});
  const manager=new DefaultPackageManager({cwd,agentDir,settingsManager});
  const resources=await manager.resolve(async()=> 'skip');
  if (resources.installFailures?.length) throw new Error(`Could not resolve project extensions: ${resources.installFailures.map(f=>f.source).join(', ')}`);
  return [...new Set(resources.extensions.filter(item=>item.enabled && item.metadata.scope==='project').flatMap(item=>[item.path,...(item.metadata.packageRoot ? [item.metadata.packageRoot] : [])]))];
}

/** Capture project and explicit local extension entry points without installing packages. */
export async function snapshotProjectExtensions(cwd:string,agentDir:string,projectTrusted:boolean,root:string,explicitPaths:string[]=[],includeConfigured=true) {
  const {snapshotExtensionGraph}=await import('./extension-graph.ts');
  const settingsManager=SettingsManager.create(cwd,agentDir,{projectTrusted});
  const manager=new DefaultPackageManager({cwd,agentDir,settingsManager});
  const paths=includeConfigured ? await configuredProjectExtensions(cwd,agentDir,projectTrusted) : [];
  const local=explicitPaths.filter(path=>!/^(npm:|git:|builtin:|https?:\/\/|ssh:\/\/)/i.test(path));
  const explicit=local.length ? await manager.resolveExtensionSources(local,{temporary:true}) : undefined;
  const entries=explicit?.extensions.filter(item=>item.enabled).map(item=>item.path) ?? [];
  return {paths,graph:snapshotExtensionGraph([...paths,...entries],root)};
}

/** Require the worktree resolver to select the same mapped project resources. */
export function assertSameProjectExtensions(expected:string[],actual:string[]) {
  const canonical=(paths:string[])=>[...new Set(paths.map(path=>path.startsWith('builtin:') ? path : realpathSync(path)))].sort();
  if (JSON.stringify(canonical(expected))!==JSON.stringify(canonical(actual))) throw new Error('Configured project extensions differ in the worktree');
}
