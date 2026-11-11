import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createChildSession} from '../extensions/src/child.ts';
import {createFakeModel} from './helpers/fake-model.ts';

test('background process remains available after a child completes normally', {timeout:10000,skip:process.platform==='win32'}, async () => {
 const root=mkdtempSync(join(tmpdir(),'subagent-background-')),agentDir=mkdtempSync(join(tmpdir(),'subagent-background-cfg-'));
 const fake=createFakeModel([{content:[{type:'toolCall',id:'launch',name:'bash',arguments:{command:'sleep 20 >/dev/null 2>&1 & echo $! > server.pid'}}]},{content:[{type:'text',text:'done'}]}]);
 let pid=0;
 const child=await createChildSession({cwd:root,agentDir,prompt:'test',model:fake.model,tools:['bash'],ask:async()=>''});
 try {
  child.session.modelRuntime.hasConfiguredAuth=()=>true;child.session.agent.streamFunction=fake.stream;
  await child.session.prompt('Launch a background process');
  pid=Number(readFileSync(join(root,'server.pid'),'utf8'));
  assert.ok(Number.isSafeInteger(pid)&&pid>1,'invalid background process ID');
  await child.dispose();
  assert.doesNotThrow(()=>process.kill(pid,0),'background process did not survive child completion');
 } finally {
  if(pid) {try {process.kill(pid,'SIGKILL');} catch(error) {if((error as NodeJS.ErrnoException).code!=='ESRCH') throw error;}}
  child.session.dispose();rmSync(root,{recursive:true,force:true});rmSync(agentDir,{recursive:true,force:true});
 }
});
