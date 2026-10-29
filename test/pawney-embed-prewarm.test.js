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
const writesSource=explorer.slice(explorer.indexOf('function createDeveloperModeAccountWrites('),explorer.indexOf('const developerAccountWrites ='));
function installWrites(context){
  context.modeContext=()=>({ownerId:'unit-owner',token:context.authSessionToken(),authenticated:context.state.cloudSyncAuthenticated,available:true,selectedMode:context.developerModeEnabled()});
  vm.runInContext(writesSource+`;globalThis.developerAccountWrites=createDeveloperModeAccountWrites({getContext:modeContext,requestMode:enabled=>apiFetch('/dev-preview/source-model-uid/mode',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled})}),writeProgress:async()=>{}});`,context);
}
const modeAck=()=>({ok:true,status:200,json:async()=>({ok:true,purpose:'aniilogs-dev-source-model-uid',devModeEnabled:true,serverDevModeRevision:1})});

function functionSource(name){
  // Bound top-level declarations rather than counting parameter/object braces.
  // This also preserves the real async keyword on the preview function.
  const declaration=new RegExp(`^(?:async )?function ${name}\\(`,'mu').exec(explorer);
  assert.ok(declaration,`${name} is present`);
  const tail=explorer.slice(declaration.index+declaration[0].length);
  const next=/^(?:async )?function [A-Za-z0-9_]+\(/mu.exec(tail);
  assert.ok(next,`${name} has a bounded following declaration`);
  return explorer.slice(declaration.index,declaration.index+declaration[0].length+next.index).trimEnd();
}

test('public Aniilog offers View Model (no sign-in) and no background Pawney prewarm',()=>{
  // The Aniilog record's model button is public: it opens the released model in
  // embed mode on demand; the old developer-only button is gone from the record.
  assert.match(explorer,/modelButton\.textContent = state\.aniilogModelMode \? "Back to Aniilog UI" : "View Model";/u);
  assert.match(explorer,/url\.searchParams\.set\("embed", "1"\);/u);
  assert.match(explorer,/frame\.setAttribute\("sandbox", "allow-scripts allow-same-origin"\);/u);
  assert.doesNotMatch(explorer,/"Work-in-progress viewer"/u);
  // Developers keep the account-menu ticket preview.
  assert.match(explorer,/openDeveloperModelPreview\(previewButton\)/u);
  assert.doesNotMatch(explorer,/pawney-embed-prewarm|pawneyPrewarm|PawneyPrewarm|PAWNEY_PREWARM|Fast desktop viewer|Preload on desktop Map/u);
  assert.match(explorer,/const handoff = await response\.json\(\);\s*current\(\);\s*if \(!developerModeEnabled\(\) \|\| !state\.cloudSyncAuthenticated \|\| !authSessionToken\(\)\) return;\s*submitDeveloperPreviewHandoff\(handoff, selectedFields\)/u);
  assert.match(explorerHtml,/\.\/app\.js\?v=0.20.3-role-list/u);
  assert.doesNotMatch(functionSource('openDeveloperModelPreview'),/controller\.show\(/u);
  assert.match(client,/form\.method='POST';form\.action=qaOrigin\+embedPath/u);
  assert.match(client,/form\.method='POST';form\.action=qaOrigin\+directPath/u);
  assert.match(client,/if\(event\.origin!==qaOrigin\|\|event\.source!==state\.frame\?\.contentWindow/u);
});

async function runTicketRace({revokeAt=null,selectionContext={formId:'1002603',formKey:'rainbow',
  appearanceId:'sparkling-03',requestedAppearance:'sparkling-01'},
  expectedFields={choice:'1002603:style-01',mode:'lit',gender:'male'},changePendingSelection=false}={}){
  const switches={dev:true,token:'local-test-token'};
  let releaseResponse,releaseJson,apiCalls=0,directSubmits=0,imports=0;
  const context={
    state:{cloudSyncAuthenticated:true},
    developerModeEnabled:()=>switches.dev,
    authSessionToken:()=>switches.token,
    loadPawneyPrewarm:()=>{imports++;throw Error('old prewarm must not open')},
    apiFetch:path=>{apiCalls++;return path.endsWith('/mode')?modeAck():new Promise(resolve=>{releaseResponse=resolve})},
    submitDeveloperPreviewHandoff:(value,fields)=>{
      directSubmits++;assert.equal(value.ticket,'test');
      assert.deepEqual({...fields},expectedFields);
    },
    window:{alert:message=>{throw Error(message)}},
  };
  vm.createContext(context);
  installWrites(context);
  vm.runInContext(functionSource('developerSelectionFieldsV11040')+'\n'+functionSource('openDeveloperModelPreview'),context);
  const button={disabled:false,textContent:'Work-in-progress viewer'};
  const opening=context.openDeveloperModelPreview(button,selectionContext);
  await setImmediate();
  assert.equal(typeof releaseResponse,'function');
  assert.equal(apiCalls,2);
  assert.equal(imports,0,'Pawney must use the same ticket path as all forms');
  if(changePendingSelection)selectionContext.requestedAppearance='sparkling-10';
  if(revokeAt==='response')switches.dev=false;
  releaseResponse({ok:true,json:()=>new Promise(resolve=>{releaseJson=resolve})});
  await setImmediate();
  assert.equal(typeof releaseJson,revokeAt==='response'?'undefined':'function');
  if(revokeAt==='json'){
    context.state.cloudSyncAuthenticated=false;
    switches.token='';
  }
  if(releaseJson)releaseJson({ticket:'test',launchUrl:'https://example.test/redeem'});
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

test('selected requested appearance is snapshotted before the ticket request',()=>
  runTicketRace({changePendingSelection:true}));

test('Settings still requests a ticket without a selected-model payload',()=>
  runTicketRace({selectionContext:null,expectedFields:{}}));

function directHandoffFixture(){
  const ticket='a'.repeat(32)+'.'+'b'.repeat(43);
  const submissions=[],alerts=[],calls=[];
  const doc={body:{append(){}},createElement:tag=>({tag,children:[],
    append(child){this.children.push(child)},remove(){},
    submit(){submissions.push({method:this.method,action:this.action,
      fields:Object.fromEntries(this.children.map(child=>[child.name,child.value]))})},
  })};
  const context={URL,document:doc,window:{alert:message=>alerts.push(message)},
    state:{cloudSyncAuthenticated:true},developerModeEnabled:()=>true,
    authSessionToken:()=> 'local-test-token',
    apiFetch:async(path,options)=>{calls.push({path,options});return path.endsWith('/mode')?modeAck():{ok:true,json:async()=>({ticket,
      launchUrl:'https://aniilogs-renderer-qa-3634150.pages.dev/qa/current3634150/redeem'})}},
  };
  vm.createContext(context);
  installWrites(context);
  for(const name of ['developerSelectionFieldsV11040','submitDeveloperPreviewHandoff','openDeveloperModelPreview'])
    vm.runInContext(functionSource(name),context);
  const button={disabled:false,textContent:'Work-in-progress viewer'};
  return {context,button,ticket,submissions,alerts,calls};
}

test('selected form/style/gender are POST fields; ticket and selection never enter the launch URL',async()=>{
  const fixture=directHandoffFixture();
  await fixture.context.openDeveloperModelPreview(fixture.button,{formId:'1234567',formKey:'rainbow',
    appearanceId:'common',requestedAppearance:'sparkling-05',gender:'male'});
  assert.deepEqual(fixture.submissions,[{method:'POST',
    action:'https://aniilogs-renderer-qa-3634150.pages.dev/qa/current3634150/redeem',
    fields:{ticket:fixture.ticket,choice:'1234567:style-05',mode:'lit',gender:'male'}}]);
  assert.equal(new URL(fixture.submissions[0].action).search,'');
  assert.equal(new URL(fixture.submissions[0].action).hash,'');
  assert.equal(fixture.calls.length,2);
  assert.equal(fixture.calls[0].path,'/dev-preview/source-model-uid/mode');
  assert.equal(fixture.calls[0].options.body,'{"enabled":true}');
  assert.equal(fixture.calls[1].path,'/dev-preview/ticket');
  assert.equal(fixture.calls[1].options.method,'POST');
  assert.equal(fixture.calls[1].options.body,undefined,'source selection does not alter ticket authorization');
});

test('missing public media defaults catalog handoff to Common/male; Settings posts only its ticket',async()=>{
  const fixture=directHandoffFixture();
  for(const appearanceId of [null,undefined]){
    await fixture.context.openDeveloperModelPreview(fixture.button,{formId:'1234567',appearanceId});
    assert.deepEqual(fixture.submissions.at(-1).fields,
      {ticket:fixture.ticket,choice:'1234567:common',mode:'lit',gender:'male'});
  }
  await fixture.context.openDeveloperModelPreview(fixture.button);
  assert.deepEqual(fixture.submissions.at(-1).fields,{ticket:fixture.ticket});
  await fixture.context.openDeveloperModelPreview(fixture.button,{formId:'1234567',appearanceId:'common',gender:'female'});
  assert.equal(fixture.submissions.at(-1).fields.gender,'female');
});

test('unsupported explicit style cannot silently become approved Common or request a ticket',async()=>{
  const fixture=directHandoffFixture();
  for(const requestedAppearance of ['sparkling-13','unknown-style']){
    await fixture.context.openDeveloperModelPreview(fixture.button,{formId:'1234567',formKey:'rainbow',
      appearanceId:'common',requestedAppearance});
  }
  assert.equal(fixture.calls.length,0);assert.equal(fixture.submissions.length,0);
  assert.equal(fixture.alerts.length,2);assert.ok(fixture.alerts.every(message=>message.includes('unsupported')));
  assert.equal(fixture.button.disabled,false);assert.equal(fixture.button.textContent,'Work-in-progress viewer');
});

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
