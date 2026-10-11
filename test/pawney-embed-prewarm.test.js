import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setImmediate} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import vm from 'node:vm';
import {createPawneyEmbedPrewarm} from '../public/explorer/pawney-embed-prewarm.js';

const explorer=readFileSync(fileURLToPath(new URL('../public/explorer/app.js',import.meta.url)),'utf8');
const explorerHtml=readFileSync(fileURLToPath(new URL('../public/explorer/index.html',import.meta.url)),'utf8');
const client=readFileSync(fileURLToPath(new URL('../public/explorer/pawney-embed-prewarm.js',import.meta.url)),'utf8');

function functionSource(name){
  const start=explorer.indexOf(`function ${name}(`);
  assert.ok(start>=0,`${name} is present`);
  const body=explorer.indexOf('{',start);
  let depth=0;
  for(let i=body;i<explorer.length;i++){
    if(explorer[i]==='{')depth++;
    if(explorer[i]==='}'&&!--depth)return explorer.slice(start,i+1);
  }
  throw Error(`Unterminated ${name}`);
}

test('public Aniilog opens only the current ticket viewer without background Pawney prewarm',()=>{
  assert.match(explorer,/openDeveloperModelPreview\(previewButton, selected\.form_id\)/u);
  assert.match(explorer,/openDeveloperModelPreview\(previewButton\)/u);
  assert.doesNotMatch(explorer,/pawney-embed-prewarm|pawneyPrewarm|PawneyPrewarm|PAWNEY_PREWARM|Fast desktop viewer|Preload on desktop Map/u);
  assert.match(explorer,/const handoff = await response\.json\(\);\s*if \(!developerModeEnabled\(\) \|\| !state\.cloudSyncAuthenticated \|\| !authSessionToken\(\)\) return;\s*submitDeveloperPreviewHandoff\(handoff\)/u);
  assert.match(explorerHtml,/\.\/app\.js\?v=0\.17\.15-no-prewarm/u);
  assert.doesNotMatch(functionSource('openDeveloperModelPreview'),/controller\.show\(/u);
  assert.match(client,/form\.method='POST';form\.action=qaOrigin\+embedPath/u);
  assert.match(client,/form\.method='POST';form\.action=qaOrigin\+directPath/u);
  assert.match(client,/if\(event\.origin!==qaOrigin\|\|event\.source!==state\.frame\?\.contentWindow/u);
});

async function runTicketRace({revokeAt=null}={}){
  const switches={dev:true,token:'local-test-token'};
  let releaseResponse,releaseJson,apiCalls=0,directSubmits=0,imports=0;
  const context={
    state:{cloudSyncAuthenticated:true},
    developerModeEnabled:()=>switches.dev,
    authSessionToken:()=>switches.token,
    loadPawneyPrewarm:()=>{imports++;throw Error('old prewarm must not open')},
    apiFetch:()=>{apiCalls++;return new Promise(resolve=>{releaseResponse=resolve})},
    submitDeveloperPreviewHandoff:value=>{directSubmits++;assert.equal(value.ticket,'test')},
    window:{alert:message=>{throw Error(message)}},
  };
  vm.createContext(context);
  vm.runInContext('async '+functionSource('openDeveloperModelPreview'),context);
  const button={disabled:false,textContent:'Work-in-progress viewer'};
  const opening=context.openDeveloperModelPreview(button,1002603);
  assert.equal(typeof releaseResponse,'function');
  assert.equal(apiCalls,1);
  assert.equal(imports,0,'Pawney must use the same ticket path as all forms');
  if(revokeAt==='response')switches.dev=false;
  releaseResponse({ok:true,json:()=>new Promise(resolve=>{releaseJson=resolve})});
  await setImmediate();
  assert.equal(typeof releaseJson,'function');
  if(revokeAt==='json'){
    context.state.cloudSyncAuthenticated=false;
    switches.token='';
  }
  releaseJson({ticket:'test',launchUrl:'https://example.test/redeem'});
  await opening;
  assert.equal(directSubmits,revokeAt===null?1:0);
  assert.equal(button.disabled,false);
  assert.equal(button.textContent,'Work-in-progress viewer');
}

test('Pawney Dev Mode preview uses the current ticket handoff',()=>
  runTicketRace());

test('Dev Mode revocation during ticket fetch cancels the handoff',()=>
  runTicketRace({revokeAt:'response'}));

test('logout during ticket JSON cancels the handoff',()=>
  runTicketRace({revokeAt:'json'}));

test('background iframe stays invisible and inert, then reveals the same frame',async()=>{
  const qa='https://aniilogs-renderer-qa-3634150.pages.dev';
  const ticket='a'.repeat(32)+'.'+'b'.repeat(43);
  const posts=[];
  const element=tag=>({
    tag,style:{},children:[],attributes:new Map(),listeners:new Map(),removed:false,
    setAttribute(name,value){this.attributes.set(name,value)},
    getAttribute(name){return this.attributes.get(name)},
    addEventListener(type,handler){this.listeners.set(type,handler)},
    append(...children){this.children.push(...children)},
    remove(){this.removed=true},
    submit(){this.submitted=true},
    ...(tag==='iframe'?{contentWindow:{postMessage:(message,origin)=>
      posts.push({message,origin})}}:{}),
  });
  const body=element('body');
  const doc={body,createElement:element,defaultView:{
    addEventListener(){},removeEventListener(){},
  }};
  let requests=0;
  const controller=createPawneyEmbedPrewarm({doc,eligible:()=>true,
    apiFetch:async()=>{requests++;return {ok:true,
      json:async()=>({ticket,launchUrl:qa+'/qa/current3634150/redeem'})}},
  });
  assert.equal(await controller.start(),true);
  const {panel,frame}=controller.state;
  assert.equal(requests,1);
  assert.equal(controller.state.status,'loading');
  assert.equal(panel.style.opacity,'0');
  assert.equal(panel.style.pointerEvents,'none');
  assert.equal(panel.inert,true);
  assert.equal(panel.getAttribute('aria-hidden'),'true');
  assert.equal(body.children[0].hidden,true,'background backdrop stays hidden');
  assert.equal(await controller.show(),true);
  assert.equal(controller.state.frame,frame);
  assert.equal(panel.style.opacity,'1');
  assert.equal(panel.inert,false);
  assert.equal(body.children[0].hidden,false);
  controller.hide();
  assert.equal(panel.style.opacity,'0');
  assert.equal(panel.inert,true);
  assert.equal(body.children[0].hidden,true);
  assert.equal(posts.at(-1).message.type,'pawney-qa-hide');
  controller.destroy();
  assert.equal(panel.removed,true);
  assert.equal(frame.removed,true);
});

test('Reload viewer replaces the retained frame with a fresh one-use POST',async()=>{
  const qa='https://aniilogs-renderer-qa-3634150.pages.dev';
  const tickets=[];
  const elements=[];
  const element=tag=>{
    const node={tag,style:{},children:[],attributes:new Map(),
      listeners:new Map(),removed:false,
      setAttribute(name,value){this.attributes.set(name,value)},
      addEventListener(type,handler){this.listeners.set(type,handler)},
      append(...children){this.children.push(...children)},
      remove(){this.removed=true},
      submit(){this.submitted=true},
      ...(tag==='iframe'?{contentWindow:{postMessage(){}}}:{}),
    };
    elements.push(node);return node;
  };
  const doc={body:element('body'),createElement:element,defaultView:{
    addEventListener(){},removeEventListener(){},
  }};
  const controller=createPawneyEmbedPrewarm({doc,eligible:()=>true,
    apiFetch:async()=>{
      const ticket='a'.repeat(32)+'.'+String(tickets.length+1).repeat(43);
      tickets.push(ticket);
      return {ok:true,json:async()=>({ticket,
        launchUrl:qa+'/qa/current3634150/redeem'})};
    },
  });
  await controller.show();
  const original=controller.state.frame;
  const reloadButton=controller.state.panel.children[0].children[1];
  assert.equal(reloadButton.textContent,'Reload viewer');
  reloadButton.listeners.get('click')();
  await setImmediate();
  assert.equal(tickets.length,2);
  assert.equal(original.removed,true);
  assert.notEqual(controller.state.frame,original);
  assert.equal(controller.state.panel.style.opacity,'1');
  const forms=elements.filter(node=>node.tag==='form');
  assert.equal(forms.length,2);
  assert.deepEqual(forms.map(node=>node.children[0].value),tickets);
  assert.ok(forms.every(node=>node.method==='POST'&&
    node.action===qa+'/qa/current3634150/redeem-embed'));
  controller.destroy();
});

test('stop during ticket fetch cannot resurrect an old iframe',async()=>{
  const qa='https://aniilogs-renderer-qa-3634150.pages.dev';
  const ticket='a'.repeat(32)+'.'+'b'.repeat(43);
  const resolvers=[];
  const element=tag=>({tag,style:{},children:[],
    setAttribute(){},addEventListener(){},append(...children){this.children.push(...children)},
    remove(){},submit(){},
    ...(tag==='iframe'?{contentWindow:{postMessage(){}}}:{})});
  const doc={body:element('body'),createElement:element,defaultView:{
    addEventListener(){},removeEventListener(){},
  }};
  const controller=createPawneyEmbedPrewarm({doc,eligible:()=>true,
    apiFetch:()=>new Promise(resolve=>resolvers.push(resolve)),
  });
  const first=controller.start();
  controller.stop();
  const second=controller.start();
  assert.equal(resolvers.length,2,'restart must mint a new ticket');
  resolvers[0]({ok:true,json:async()=>({ticket,
    launchUrl:qa+'/qa/current3634150/redeem'})});
  assert.equal(await first,false);
  assert.equal(controller.state.frame,null);
  resolvers[1]({ok:true,json:async()=>({ticket,
    launchUrl:qa+'/qa/current3634150/redeem'})});
  assert.equal(await second,true);
  assert.ok(controller.state.frame);
  controller.destroy();
});

test('failed embed uses a fresh one-use direct POST handoff',async()=>{
  const qa='https://aniilogs-renderer-qa-3634150.pages.dev';
  const ticket='a'.repeat(32)+'.'+'b'.repeat(43);
  let requests=0,submitted=null,eligible=true;
  const doc={defaultView:{addEventListener(){},removeEventListener(){}}};
  const controller=createPawneyEmbedPrewarm({
    doc,eligible:()=>eligible,
    apiFetch:async()=>{requests++;return {ok:true,
      json:async()=>({ticket,launchUrl:qa+'/qa/current3634150/redeem'})}},
    submitDirect:value=>{submitted=value},
  });
  controller.state.status='failed';
  assert.equal(await controller.show(),false);
  assert.equal(requests,1);
  assert.deepEqual(submitted,{ticket,url:qa+'/qa/current3634150/redeem'});
  eligible=false;submitted=null;
  assert.equal(await controller.show(),false);
  assert.equal(requests,1,'revoked eligibility must not mint another ticket');
  assert.equal(submitted,null);
  controller.destroy();
});

test('leaving Aniilog while ticket is pending cancels reveal and direct fallback',async()=>{
  const qa='https://aniilogs-renderer-qa-3634150.pages.dev';
  const ticket='a'.repeat(32)+'.'+'b'.repeat(43);
  let releaseTicket,eligible=true,requests=0,directSubmits=0;
  const doc={defaultView:{addEventListener(){},removeEventListener(){}}};
  const controller=createPawneyEmbedPrewarm({
    doc,eligible:()=>eligible,
    apiFetch:()=>{requests++;return new Promise(resolve=>{releaseTicket=resolve})},
    submitDirect:()=>{directSubmits++},
  });
  const showing=controller.show();
  eligible=false;
  releaseTicket({ok:true,json:async()=>({ticket,launchUrl:qa+'/qa/current3634150/redeem'})});
  assert.equal(await showing,false);
  assert.equal(requests,1);
  assert.equal(directSubmits,0);
  assert.equal(controller.state.frame,null);
  controller.destroy();
});

test('early Map eligibility cannot reveal a click that left Aniilog during ticket fetch',async()=>{
  const qa='https://aniilogs-renderer-qa-3634150.pages.dev';
  const ticket='a'.repeat(32)+'.'+'b'.repeat(43);
  let releaseTicket,visible=true,directSubmits=0;
  const element=tag=>({tag,style:{},children:[],attributes:new Map(),
    setAttribute(name,value){this.attributes.set(name,value)},
    addEventListener(){},append(...children){this.children.push(...children)},
    remove(){this.removed=true},submit(){this.submitted=true},
    ...(tag==='iframe'?{contentWindow:{postMessage(){}}}:{})});
  const doc={body:element('body'),createElement:element,defaultView:{
    addEventListener(){},removeEventListener(){},
  }};
  const controller=createPawneyEmbedPrewarm({doc,eligible:()=>true,
    visibleEligible:()=>visible,
    apiFetch:()=>new Promise(resolve=>{releaseTicket=resolve}),
    submitDirect:()=>{directSubmits++},
  });
  const showing=controller.show();
  visible=false;
  controller.hide();
  releaseTicket({ok:true,json:async()=>({ticket,launchUrl:qa+'/qa/current3634150/redeem'})});
  assert.equal(await showing,false);
  assert.equal(controller.state.panel.style.opacity,'0');
  assert.equal(controller.state.panel.inert,true);
  assert.equal(directSubmits,0);
  controller.destroy();
});
