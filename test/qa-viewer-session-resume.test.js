// SOURCE PREP for aniilogs-private-renderer/test/qa-viewer-session-resume.test.js.
// Run only after the reviewed main-app change is applied at that destination.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';

const source=(await readFile(new URL('../public/explorer/app.js',import.meta.url),'utf8')).replaceAll('\r\n','\n');
function region(start,end){const a=source.indexOf(start),z=source.indexOf(end,a+start.length);assert(a>=0&&z>a,'bounded main source: '+start);return source.slice(a,z);}
const helpers=region('function rawViewerSelectionFieldsV73604(','\nconst mainViewerResumeV73604 =');
const {raw,parse,create}=new Function(helpers+';return {raw:rawViewerSelectionFieldsV73604,parse:parseMainViewerResumeV73604,create:createMainViewerResumeV73604};')();
const fields=new Function('rawViewerSelectionFieldsV73604',region('function developerSelectionFieldsV11040(','\nfunction submitDeveloperPreviewHandoff(')+';return developerSelectionFieldsV11040;')(raw);
const createWrites=new Function(region('function createDeveloperModeAccountWrites(', '\nconst developerAccountWrites =')+';return createDeveloperModeAccountWrites;')();
const selection={choice:'1002603:style-00',gender:'female'};
const resumeUrl='https://aniilogs.github.io/explorer/?view=aniilog&resumeViewer=1002603%3Astyle-00&gender=female';
function documentFixture(){const nodes=[],forms=[];return{nodes,forms,body:{prepend:n=>nodes.push(n),append:n=>nodes.push(n)},createElement:tag=>({tag,children:[],setAttribute(k,v){this[k]=v;},append(n){this.children.push(n);},addEventListener(){},remove(){},submit(){forms.push({method:this.method,action:this.action,fields:Object.fromEntries(this.children.map(n=>[n.name,n.value]))});}})};}
const authorizedSource=region('  authorized:()=>developerModeEnabled()','\n  openPreview:').trim().slice('authorized:'.length).replace(/,$/u,'');
const authorize=(state,dev,token)=>new Function('state','developerModeEnabled','authSessionToken','return ('+authorizedSource+');')(state,()=>dev.value,()=>token.value);

test('strict raw resume preserves style00 and uses the same selected-fields constructor with fixed lit mode',()=>{
  assert.deepEqual(fields(selection),{...selection,mode:'lit'});
  assert.deepEqual(fields({formId:'1002603',appearanceId:'common'}),{choice:'1002603:common',mode:'lit',gender:'male'});
  for(const bad of [{...selection,mode:'source'},{...selection,ticket:'not-a-resume-field'},{choice:'1002603:style-13',gender:'female'},{choice:'1002603:style-1',gender:'female'}])assert.throws(()=>fields(bad),/unsupported/);
  for(const query of ['resumeViewer=1002603%3Acommon','resumeViewer=1002603%3Acommon&resumeViewer=1002603%3Astyle-00&gender=male','resumeViewer=1002603%3Acommon&gender=male&gender=female'])assert.equal(parse('https://aniilogs.github.io/explorer/?'+query).context,null);
});

test('actual startup strips resume parameters immediately and fails closed if URL replacement fails',()=>{
  const code=region('const INITIAL_URL_PARAMS =','\nconst REQUESTED_SETTINGS_OPEN');
  function startup(href,fail=false){const calls=[],url=new URL(href),window={location:{href,search:url.search},history:{state:null,replaceState(...args){calls.push(args);if(fail)throw Error('blocked');}}};return{calls,...new Function('window','parseMainViewerResumeV73604',code+';return {parsed:mainViewerResumeRequestV73604,params:INITIAL_URL_PARAMS};')(window,parse)};}
  const r=startup(resumeUrl);assert.deepEqual(r.parsed.context,selection);assert.equal(r.calls.length,1);
  assert.equal(r.calls[0][2],'https://aniilogs.github.io/explorer/?view=aniilog');
  assert(!r.params.has('resumeViewer'));assert(!r.params.has('gender'));
  assert.equal(startup(resumeUrl,true).parsed.context,null);
  const normal=startup('https://aniilogs.github.io/explorer/?gender=female');assert.equal(normal.calls.length,0);assert.equal(normal.params.get('gender'),'female');
});

test('normal public URLs do not launch, alter history or add renewal UI',async()=>{
  const href='https://aniilogs.github.io/explorer/?view=aniilog&gender=female',parsed=parse(href),doc=documentFixture();let opened=0;
  assert.deepEqual(parsed,{hadRequest:false,context:null,cleanUrl:href});
  const owner=create({parsed,doc,authorized:()=>true,openPreview:async()=>opened++});
  owner.noteSignedOut();assert.equal(await owner.afterFreshAccount(),false);assert.equal(opened,0);assert.equal(doc.nodes.length,0);
  const url=new URL(href);owner.attachToSignInReturn(url);assert.equal(url.href,href);
});

test('resume runs once only after the actual fresh-account hook and existing DevMode/auth/token predicate',async()=>{
  const hydrate=region('async function hydrateCloudProgress()','\nfunction clearLocalTracking()');
  const authAt=hydrate.indexOf('const accountResponse = await apiFetch("/auth/me")'),roleAt=hydrate.indexOf('state.developerModeAvailable ='),resumeAt=hydrate.indexOf('await mainViewerResumeV73604.afterFreshAccount()');
  assert(authAt>=0&&roleAt>authAt&&resumeAt>roleAt);
  const state={cloudSyncAuthenticated:false},dev={value:false},token={value:''},doc=documentFixture();let opened=0;
  const owner=create({parsed:parse(resumeUrl),doc,authorized:authorize(state,dev,token),openPreview:async(_button,value)=>{assert.deepEqual(value,selection);opened++;}});
  assert.equal(await owner.afterFreshAccount(),false);state.cloudSyncAuthenticated=true;
  assert.equal(await owner.afterFreshAccount(),false);dev.value=true;
  assert.equal(await owner.afterFreshAccount(),false);token.value='synthetic-in-memory-test-token';
  assert.equal(await owner.afterFreshAccount(),true);assert.equal(await owner.afterFreshAccount(),false);assert.equal(opened,1);
});

test('actual original ticket endpoint and POST form keep credentials out of URLs and selection out of ticket authorization',async()=>{
  const doc=documentFixture(),calls=[],ticket='a'.repeat(32)+'.'+'b'.repeat(43),launchUrl='https://aniilogs-renderer-qa-3634150.pages.dev/qa/current3634150/redeem';
  const body=region('function submitDeveloperPreviewHandoff(','\nfunction signInReturnUrl(');
  const token='synthetic-in-memory-test-token';
  const apiFetch=async(path,options)=>{calls.push({path,options});return{ok:true,json:async()=>path.endsWith('/mode')?{ok:true,purpose:'aniilogs-dev-source-model-uid',devModeEnabled:true,serverDevModeRevision:1}:{ticket,launchUrl}};};
  const writes=createWrites({getContext:()=>({ownerId:'unit-owner',token,authenticated:true,available:true,selectedMode:true}),requestMode:enabled=>apiFetch('/dev-preview/source-model-uid/mode',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled})}),writeProgress:async()=>{}});
  const open=new Function('document','developerModeEnabled','state','developerSelectionFieldsV11040','apiFetch','authSessionToken','window','developerAccountWrites',body+';return openDeveloperModelPreview;')(doc,()=>true,{cloudSyncAuthenticated:true},fields,apiFetch,()=>token,{alert:message=>assert.fail(message)},writes);
  await open({disabled:false,textContent:'Preview'},selection);
  assert.deepEqual(calls,[{path:'/dev-preview/source-model-uid/mode',options:{method:'POST',headers:{'content-type':'application/json'},body:'{"enabled":true}'}},{path:'/dev-preview/ticket',options:{method:'POST'}}]);
  assert.deepEqual(doc.forms,[{method:'POST',action:launchUrl,fields:{ticket,...selection,mode:'lit'}}]);
  assert.equal(new URL(doc.forms[0].action).search,'');assert.equal(new URL(doc.forms[0].action).hash,'');
  assert.match(region('async function apiFetch(','\nfunction developerSelectionFieldsV11040('),/credentials: "omit"/u);
});
