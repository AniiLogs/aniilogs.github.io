// Dev Mode-only authenticated Pawney preview; no renderer or game data lives here.
// It retains one QA iframe from background preparation through reveal.
const defaultQaOrigin='https://aniilogs-renderer-qa-3634150.pages.dev';
const directPath='/qa/current3634150/redeem';
const embedPath='/qa/current3634150/redeem-embed';
const ticketPattern=/^[A-Za-z0-9_-]{32,128}\.[A-Za-z0-9_-]{43}$/u;

export function createPawneyEmbedPrewarm({apiFetch,eligible,visibleEligible=eligible,
  qaOrigin=defaultQaOrigin,doc=globalThis.document,
  onStatus=()=>{},submitDirect=null}={}){
  if(typeof apiFetch!=='function'||typeof eligible!=='function'||
      typeof visibleEligible!=='function'||!doc)
    throw Error('Aniilog API, eligibility and document required');
  const parsed=new URL(qaOrigin);
  if(parsed.protocol!=='https:'||parsed.hostname!==
      'aniilogs-renderer-qa-3634150.pages.dev'||parsed.port||
      parsed.pathname!=='/'||parsed.search||parsed.hash)
    throw Error('Pinned QA origin required');
  const state={status:'idle',frame:null,panel:null,startedAt:null,
    readyAt:null,openedAt:null,sceneCount:0,channel:null};
  let backdrop=null,pending=null,timeout=null,open=false,disposed=false;
  const update=status=>{state.status=status;onStatus(state)};
  const channel=()=>{
    const raw=new Uint8Array(24);crypto.getRandomValues(raw);
    return 'pawney_'+Array.from(raw,b=>b.toString(16).padStart(2,'0')).join('');
  };
  const ticket=async()=>{
    const response=await apiFetch('/dev-preview/ticket',{method:'POST'});
    if(!response.ok)throw Error('Developer preview ticket unavailable');
    const payload=await response.json();
    const launch=new URL(String(payload.launchUrl||''));
    if(!ticketPattern.test(String(payload.ticket||''))||
        launch.href!==qaOrigin+directPath)
      throw Error('Developer preview handoff changed');
    return payload.ticket;
  };
  const post=type=>{
    if(!state.frame?.contentWindow)return;
    state.frame.contentWindow.postMessage({type,channel:state.channel},qaOrigin);
  };
  const offscreen=()=>{
    if(!state.panel)return;
    // Chrome deprioritizes the nested cross-site GPU frame if it is fully
    // outside the viewport or clipped. Keep its browsing context in view,
    // transparent and inert, so the same GPU device is ready for reveal.
    state.panel.style.left='auto';
    state.panel.style.top='auto';
    state.panel.style.right='12px';
    state.panel.style.bottom='12px';
    state.panel.style.transform='scale(.28)';
    state.panel.style.transformOrigin='bottom right';
    state.panel.style.opacity='0';
    state.panel.style.pointerEvents='none';
    state.panel.setAttribute('aria-hidden','true');
    state.panel.inert=true;
    backdrop.hidden=true;
  };
  const onscreen=()=>{
    if(!state.panel)return;
    state.panel.style.left='50%';
    state.panel.style.top='50%';
    state.panel.style.right='auto';
    state.panel.style.bottom='auto';
    state.panel.style.transform='translate(-50%, -50%)';
    state.panel.style.transformOrigin='center center';
    state.panel.style.opacity='1';
    state.panel.style.pointerEvents='auto';
    state.panel.setAttribute('aria-hidden','false');
    state.panel.inert=false;
    backdrop.hidden=false;
  };
  const removeFrame=()=>{
    if(timeout){clearTimeout(timeout);timeout=null}
    state.frame?.remove();
    state.panel?.remove();
    backdrop?.remove();
    state.frame=null;state.panel=null;backdrop=null;
    state.channel=null;state.sceneCount=0;
  };
  const fail=()=>{
    removeFrame();open=false;update('failed');
  };
  const onMessage=event=>{
    if(event.origin!==qaOrigin||event.source!==state.frame?.contentWindow||
        event.data?.channel!==state.channel)return;
    if(event.data.type==='pawney-qa-failed'){fail();return}
    if(event.data.type!=='pawney-qa-ready'||state.status==='failed')return;
    state.readyAt=performance.now();
    state.sceneCount=event.data.sceneCount===1?1:0;
    if(state.sceneCount!==1){fail();return}
    if(timeout){clearTimeout(timeout);timeout=null}
    if(open){
      post('pawney-qa-show');update('shown');
    }else update('ready');
  };
  doc.defaultView.addEventListener('message',onMessage);
  async function start(){
    if(disposed||!eligible())return false;
    if(state.frame)return true;
    if(pending)return pending;
    pending=(async()=>{
      const oneUse=await ticket();
      if(disposed||!eligible())return false;
      const host=doc.createElement('section');
      host.setAttribute('aria-label','Private Pawney live viewer');
      host.setAttribute('aria-hidden','true');
      host.inert=true;
      Object.assign(host.style,{position:'fixed',left:'auto',top:'auto',
        right:'12px',bottom:'12px',transform:'scale(.28)',
        transformOrigin:'bottom right',pointerEvents:'none',
        opacity:'0',
        width:'min(96vw,800px)',height:'min(94vh,960px)',zIndex:'99999',
        background:'#151520',color:'#f5f0ed',overflow:'hidden',
        boxShadow:'0 4px 24px #0009'});
      const toolbar=doc.createElement('div');
      Object.assign(toolbar.style,{height:'48px',display:'flex',
        alignItems:'center',justifyContent:'space-between',padding:'0 12px'});
      const label=doc.createElement('span');
      label.textContent='Pawney 3D preview · Work in progress';
      const close=doc.createElement('button');
      close.type='button';close.textContent='Close viewer';
      close.addEventListener('click',()=>hide());
      toolbar.append(label,close);
      const frame=doc.createElement('iframe');
      frame.title='Private Pawney live 3D viewer';
      frame.name=channel();
      frame.referrerPolicy='no-referrer';
      frame.allow='webgpu';
      Object.assign(frame.style,{display:'block',width:'100%',
        height:'calc(100% - 48px)',border:'0'});
      host.append(toolbar,frame);
      backdrop=doc.createElement('div');
      backdrop.hidden=true;
      Object.assign(backdrop.style,{position:'fixed',inset:'0',
        zIndex:'99998',background:'rgba(0,0,0,.76)'});
      backdrop.addEventListener('click',()=>hide());
      doc.body.append(backdrop,host);
      state.panel=host;state.frame=frame;state.channel=frame.name;
      state.startedAt=performance.now();
      update('loading');
      const form=doc.createElement('form');
      form.method='POST';form.action=qaOrigin+embedPath;
      form.target=frame.name;form.hidden=true;
      const input=doc.createElement('input');
      input.name='ticket';input.type='hidden';input.value=oneUse;
      form.append(input);doc.body.append(form);
      form.submit();form.remove();
      timeout=setTimeout(()=>{if(state.status==='loading')fail()},45000);
      return true;
    })().catch(error=>{fail();throw error}).finally(()=>{pending=null});
    return pending;
  }
  async function directFallback(){
    const oneUse=await ticket();
    if(disposed||!visibleEligible())return false;
    if(submitDirect){submitDirect({ticket:oneUse,url:qaOrigin+directPath});return}
    const form=doc.createElement('form');
    form.method='POST';form.action=qaOrigin+directPath;form.hidden=true;
    const input=doc.createElement('input');
    input.name='ticket';input.type='hidden';input.value=oneUse;
    form.append(input);doc.body.append(form);form.submit();form.remove();
  }
  async function show(){
    if(disposed||!visibleEligible())return false;
    if(state.status==='failed'){
      await directFallback();return false;
    }
    if(!state.frame){
      try{await start()}
      catch{if(visibleEligible())await directFallback();return false}
    }
    // A route/auth change can happen while the one-use ticket is pending.
    if(!visibleEligible())return false;
    if(!state.frame){await directFallback();return false}
    open=true;state.openedAt=performance.now();
    onscreen();
    if(state.status==='ready'||state.status==='shown'){
      post('pawney-qa-show');update('shown');
    }
    return true;
  }
  function hide(){
    open=false;post('pawney-qa-hide');offscreen();
    if(state.status==='shown')update('ready');
  }
  function stop(){
    open=false;post('pawney-qa-dispose');removeFrame();
    update('idle');
  }
  function destroy(){
    stop();disposed=true;
    doc.defaultView.removeEventListener('message',onMessage);
  }
  return {state,start,show,hide,stop,destroy,directFallback};
}

