import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setImmediate} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import vm from 'node:vm';
import {createPawneyEmbedPrewarm} from '../public/explorer/pawney-embed-prewarm.js';

const explorer=readFileSync(fileURLToPath(new URL('../public/explorer/app.js',import.meta.url)),'utf8');
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

function fixture(){
  const switches={dev:true,token:'local-test-token'};
  const controller={state:{status:'idle'},starts:0,stops:0,
    start(){this.starts++;this.state.status='loading';return Promise.resolve(true)},
    stop(){this.stops++;this.state.status='idle'}};
  const context={
    PAWNEY_PREWARM_DESKTOP:{matches:true},
    pawneyPrewarmController:controller,
    state:{cloudSyncAuthenticated:true,sidebarView:'aniilog',
      catalogSelection:{aniilog:'pawney-form'}},
    developerModeEnabled:()=>switches.dev,
    authSessionToken:()=>switches.token,
    catalogEntriesForView:()=>[
      {id:'pawney-form',form_id:1002603},
      {id:'other-form',form_id:1002604},
    ],
    loadPawneyPrewarm:()=>Promise.resolve(controller),
  };
  vm.createContext(context);
  vm.runInContext(functionSource('pawneyPrewarmEligible')+'\n'+
    functionSource('syncPawneyPrewarm'),context);
  return {context,controller,switches};
}

test('Pawney prewarm starts only for an authenticated desktop Dev Mode Pawney selection',async()=>{
  const {context,controller,switches}=fixture();
  assert.equal(context.pawneyPrewarmEligible(),true);
  context.syncPawneyPrewarm();
  await setImmediate();
  assert.equal(controller.starts,1);
  context.syncPawneyPrewarm();
  await setImmediate();
  assert.equal(controller.starts,1,'re-render must not create a second GPU scene');
  switches.token='';
  assert.equal(context.pawneyPrewarmEligible(),false);
});

test('Dev Mode, logout, selection, page and desktop changes dispose the existing scene',async()=>{
  const {context,controller,switches}=fixture();
  const cases=[
    ()=>{switches.dev=false},
    ()=>{context.state.cloudSyncAuthenticated=false},
    ()=>{context.state.catalogSelection.aniilog='other-form'},
    ()=>{context.state.sidebarView='map'},
    ()=>{context.PAWNEY_PREWARM_DESKTOP.matches=false},
  ];
  for(const change of cases){
    controller.state.status='loading';
    change();
    assert.equal(context.pawneyPrewarmEligible(),false);
    const before=controller.stops;
    context.syncPawneyPrewarm();
    assert.equal(controller.stops,before+1);
    switches.dev=true;
    context.state.cloudSyncAuthenticated=true;
    context.state.catalogSelection.aniilog='pawney-form';
    context.state.sidebarView='aniilog';
    context.PAWNEY_PREWARM_DESKTOP.matches=true;
  }
  await setImmediate();
});

test('UI transition hooks and direct one-use fallback remain wired',()=>{
  assert.match(explorer,/function applyDeveloperVisibility\(\)[\s\S]*?syncPawneyPrewarm\(\);/u);
  assert.match(explorer,/function setSidebarView\(view\)[\s\S]*?state\.sidebarView = nextView;\s*syncPawneyPrewarm\(\);/u);
  assert.match(explorer,/state\.catalogSelection\[view\] = selected\.id;\s*syncPawneyPrewarm\(\);/u);
  assert.match(explorer,/openDeveloperModelPreview\(previewButton, selected\.form_id\)/u);
  assert.match(explorer,/window\.addEventListener\("pagehide", \(\) => pawneyPrewarmController\?\.stop\(\)\)/u);
  assert.match(explorer,/window\.addEventListener\("pageshow", syncPawneyPrewarm\)/u);
  assert.match(explorer,/submitDeveloperPreviewHandoff\(await response\.json\(\)\)/u);
  assert.match(client,/form\.method='POST';form\.action=qaOrigin\+embedPath/u);
  assert.match(client,/form\.method='POST';form\.action=qaOrigin\+directPath/u);
  assert.match(client,/if\(event\.origin!==qaOrigin\|\|event\.source!==state\.frame\?\.contentWindow/u);
});

async function runEligibilityRace(revokeDevMode){
  const switches={dev:true,pawney:true};
  let resolveImport,apiCalls=0,directSubmits=0,shows=0;
  const context={
    state:{cloudSyncAuthenticated:true},
    developerModeEnabled:()=>switches.dev,
    pawneyPrewarmEligible:()=>switches.pawney,
    loadPawneyPrewarm:()=>new Promise(resolve=>{resolveImport=resolve}),
    apiFetch:async()=>{apiCalls++;return {ok:true,
      json:async()=>({ticket:'test',launchUrl:'https://example.test/redeem'})}},
    submitDeveloperPreviewHandoff:()=>{directSubmits++},
    window:{alert:message=>{throw Error(message)}},
  };
  vm.createContext(context);
  vm.runInContext('async '+functionSource('openDeveloperModelPreview'),context);
  const button={disabled:false,textContent:'Work-in-progress viewer'};
  const opening=context.openDeveloperModelPreview(button,1002603);
  assert.equal(typeof resolveImport,'function');
  switches.pawney=false;
  if(revokeDevMode)switches.dev=false;
  resolveImport({show:async()=>{shows++}});
  await opening;
  assert.equal(shows,0,'stale Pawney scene must never open');
  assert.equal(apiCalls,revokeDevMode?0:1);
  assert.equal(directSubmits,revokeDevMode?0:1);
  assert.equal(button.disabled,false);
}

test('selection changing during import falls back to direct handoff',()=>
  runEligibilityRace(false));

test('Dev Mode revocation during import cancels the handoff',()=>
  runEligibilityRace(true));

test('legacy MediaQueryList listeners keep the public app bootable',()=>{
  const start=explorer.indexOf('if (typeof PAWNEY_PREWARM_DESKTOP.addEventListener');
  const end=explorer.indexOf('window.addEventListener("pagehide"',start);
  assert.ok(start>0&&end>start);
  let registered=false;
  const context={PAWNEY_PREWARM_DESKTOP:{addListener:fn=>{registered=typeof fn==='function'}},
    syncPawneyPrewarm:()=>{}};
  vm.createContext(context);
  vm.runInContext(explorer.slice(start,end),context);
  assert.equal(registered,true);
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
