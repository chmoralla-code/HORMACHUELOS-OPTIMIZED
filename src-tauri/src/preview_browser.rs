use crate::design_source::{DesignDomContext, DesignRect};
use serde::{Deserialize, Serialize};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl,
};

const BROWSER_LABEL_PREFIX: &str = "preview-browser-";
const BROWSER_EVENT: &str = "preview-browser-event";
const BROWSER_INSPECTION_SCHEME: &str = "horma-preview-inspect";
const MAX_BROWSER_URL_LEN: usize = 8_192;
const MAX_INSPECTION_URL_LEN: usize = 24_000;
const MAX_BROWSER_CAPTURE_PIXELS: f64 = 8_000_000.0;
const MAX_BROWSER_CAPTURE_SIDE: f64 = 4_096.0;

/// Runs in the isolated Browser-tab webview. It never receives Tauri command
/// access: the only outbound channel is a bounded custom navigation that the
/// Rust navigation handler cancels and converts into an inspection event.
const BROWSER_INSPECTION_SCRIPT: &str = r#"
(() => {
  if (window.top !== window || window.__hormaPreviewInspection) return;

  const PREFIX = 'horma-preview-inspect://target/';
  const INTERACTIVE = "a,button,input,select,textarea,summary,label,[role='button'],[role='link'],[role='tab'],[tabindex]";
  const state = {
    mode: 'off',
    chromeVisible: true,
    hoverNode: null,
    selectedNode: null,
    hoverTimer: 0,
    lastHoverSignature: '',
    feedback: null,
    raf: 0,
    pointerRaf: 0,
    pointerTarget: null,
  };

  const clip = (value, max = 180) => String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, max);

  const cssPath = (element) => {
    if (!element || element.nodeType !== 1) return '';
    if (element.id) return '#' + CSS.escape(element.id);
    const parts = [];
    for (let current = element; current && current !== document.body && parts.length < 6; current = current.parentElement) {
      let part = current.tagName.toLowerCase();
      const classes = Array.from(current.classList || [])
        .filter((name) => name && !name.startsWith('horma-browser-inspect'))
        .slice(0, 2);
      if (classes.length) part += classes.map((name) => '.' + CSS.escape(name)).join('');
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((item) => item.tagName === current.tagName);
        if (siblings.length > 1 && !classes.length) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  };

  const featureFromTarget = (raw) => {
    if (!raw || raw.nodeType !== 1 || raw === document.documentElement || raw === document.body) return null;
    for (let current = raw; current && current !== document.body; current = current.parentElement) {
      if (current.matches && current.matches(INTERACTIVE)) return current;
      const rect = current.getBoundingClientRect();
      const text = clip(current.innerText || current.textContent, 120);
      const display = getComputedStyle(current).display || '';
      if (!display.startsWith('inline') && rect.width >= 24 && rect.height >= 18 && text) return current;
    }
    return raw;
  };

  const sourceHints = (node) => {
    let sourceFile = '';
    let sourceLine = null;
    let sourceColumn = null;
    try {
      const vue = node.__vueParentComponent;
      sourceFile = clip(vue && vue.type && vue.type.__file, 500);
    } catch {}
    try {
      const key = Object.keys(node).find((name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
      let fiber = key ? node[key] : null;
      for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
        const source = fiber._debugSource;
        if (source && source.fileName) {
          sourceFile = clip(source.fileName, 500);
          sourceLine = Number(source.lineNumber) || null;
          sourceColumn = Number(source.columnNumber) || null;
          break;
        }
      }
    } catch {}
    return { sourceFile, sourceLine, sourceColumn };
  };

  const describe = (node, includeRuntimeHints = true) => {
    const rect = node.getBoundingClientRect();
    const clone = node.cloneNode(true);
    clone.querySelectorAll?.('[id^="horma-browser-inspect-"]').forEach((item) => item.remove());
    const styleSelectors = [];
    let visited = 0;
    if (includeRuntimeHints) {
      for (const sheet of Array.from(document.styleSheets || [])) {
        let rules;
        try { rules = Array.from(sheet.cssRules || []); } catch { continue; }
        for (const rule of rules) {
          if (++visited > 600 || styleSelectors.length >= 16) break;
          const selector = rule.selectorText;
          if (!selector) continue;
          try { if (node.matches(selector)) styleSelectors.push(clip(selector, 240)); } catch {}
        }
        if (visited > 600 || styleSelectors.length >= 16) break;
      }
    }
    return {
      tag: clip(node.tagName, 40).toLowerCase(),
      text: clip(node.innerText || node.textContent, 180),
      selector: cssPath(node),
      domContext: {
        id: clip(node.id, 100),
        classes: Array.from(node.classList || []).map((value) => clip(value, 100)).filter(Boolean).slice(0, 16),
        role: clip(node.getAttribute('role'), 80),
        ariaLabel: clip(node.getAttribute('aria-label'), 180),
        testId: clip(node.getAttribute('data-testid'), 120),
        name: clip(node.getAttribute('name'), 120),
        href: clip(node.getAttribute('href') || node.getAttribute('action'), 240),
        html: clip(clone.outerHTML, 1200),
      },
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      styleSelectors: Array.from(new Set(styleSelectors)),
      ...(includeRuntimeHints ? sourceHints(node) : { sourceFile: '', sourceLine: null, sourceColumn: null }),
    };
  };

  const report = (phase, target) => {
    try {
      const payload = target ? `?payload=${encodeURIComponent(JSON.stringify(target))}` : '';
      window.location.assign(`${PREFIX}${phase}${payload}`);
    } catch {}
  };

  const ensureUi = () => {
    if (!document.documentElement) return null;
    let root = document.getElementById('horma-browser-inspect-root');
    if (root) return root;
    const cssText = `
      #horma-browser-inspect-root { all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; pointer-events: none !important; font-family: Inter, ui-sans-serif, system-ui, sans-serif !important; color-scheme: dark !important; }
      #horma-browser-inspect-box { all: initial !important; position: fixed !important; display: none !important; box-sizing: border-box !important; border: 2px solid #72b1ff !important; border-radius: 5px !important; background: rgba(84,156,255,.08) !important; box-shadow: 0 0 0 1px rgba(255,255,255,.92),0 0 0 5px rgba(90,160,255,.18),0 10px 28px rgba(18,92,186,.3) !important; pointer-events: none !important; }
      #horma-browser-inspect-box[data-source="true"] { border-color: #66dfb8 !important; background: rgba(54,190,149,.08) !important; box-shadow: 0 0 0 1px rgba(241,255,249,.94),0 0 0 5px rgba(65,206,162,.18),0 10px 28px rgba(24,125,96,.28) !important; }
      #horma-browser-inspect-box[data-selected="true"] { background: rgba(84,156,255,.14) !important; }
      #horma-browser-inspect-badge { all: initial !important; position: fixed !important; top: 12px !important; right: 12px !important; display: flex !important; align-items: center !important; gap: 7px !important; max-width: calc(100vw - 24px) !important; padding: 7px 10px !important; border: 1px solid rgba(119,181,255,.58) !important; border-radius: 8px !important; color: #eef7ff !important; background: rgba(8,18,34,.94) !important; box-shadow: 0 10px 30px rgba(0,0,0,.4) !important; font: 600 11px/1.25 ui-monospace,SFMono-Regular,Consolas,monospace !important; }
      #horma-browser-inspect-badge strong { all: initial !important; color: #91c7ff !important; font: 800 10px/1 ui-monospace,SFMono-Regular,Consolas,monospace !important; letter-spacing: .06em !important; text-transform: uppercase !important; }
      #horma-browser-inspect-root[data-mode="source"] #horma-browser-inspect-badge { border-color: rgba(102,223,184,.62) !important; background: rgba(6,27,22,.95) !important; }
      #horma-browser-inspect-root[data-mode="source"] #horma-browser-inspect-badge strong { color: #79edc9 !important; }
      #horma-browser-inspect-hud { all: initial !important; position: fixed !important; display: none !important; width: max-content !important; max-width: min(360px,calc(100vw - 16px)) !important; padding: 7px 9px !important; border: 1px solid rgba(91,211,176,.68) !important; border-radius: 8px !important; color: #eafff7 !important; background: rgba(6,24,20,.97) !important; box-shadow: 0 12px 30px rgba(0,0,0,.46) !important; font: 600 10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; }
      #horma-browser-inspect-hud span { all: initial !important; display: block !important; overflow: hidden !important; color: #d7fff2 !important; font: inherit !important; text-overflow: ellipsis !important; white-space: nowrap !important; }
      #horma-browser-inspect-hud span[data-kind="style"] { color: #b9d7ff !important; }
      #horma-browser-inspect-hud span[data-kind="backend"] { color: #ffd8a8 !important; }
      #horma-browser-inspect-hud span[data-kind="likely"], #horma-browser-inspect-hud span[data-kind="target"] { opacity: .82 !important; }
    `;
    const style = document.createElement('style');
    style.id = 'horma-browser-inspect-style';
    style.textContent = cssText;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(cssText);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch {}
    root = document.createElement('div');
    root.id = 'horma-browser-inspect-root';
    const box = document.createElement('div');
    box.id = 'horma-browser-inspect-box';
    const badge = document.createElement('div');
    badge.id = 'horma-browser-inspect-badge';
    badge.append(document.createElement('strong'), document.createElement('span'));
    const hud = document.createElement('div');
    hud.id = 'horma-browser-inspect-hud';
    root.append(box, badge, hud);
    document.documentElement.append(style, root);
    return root;
  };

  const draw = () => {
    state.raf = 0;
    const root = ensureUi();
    if (!root) return;
    const visible = state.mode !== 'off' && state.chromeVisible;
    root.style.setProperty('display', visible ? 'block' : 'none', 'important');
    if (!visible) return;
    root.dataset.mode = state.mode;
    const badge = root.querySelector('#horma-browser-inspect-badge');
    badge.querySelector('strong').textContent = state.mode === 'source' ? 'Source Lens' : 'Design';
    badge.querySelector('span').textContent = state.mode === 'source'
      ? 'Hover to map code · click to select · Esc to exit'
      : 'Click an element to edit · Esc to exit';
    const node = state.selectedNode || state.hoverNode;
    const box = root.querySelector('#horma-browser-inspect-box');
    const hud = root.querySelector('#horma-browser-inspect-hud');
    if (!node || !node.isConnected) {
      box.style.setProperty('display', 'none', 'important');
      hud.style.setProperty('display', 'none', 'important');
      return;
    }
    const rect = node.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
      box.style.setProperty('display', 'none', 'important');
      hud.style.setProperty('display', 'none', 'important');
      return;
    }
    box.style.setProperty('display', 'block', 'important');
    box.style.setProperty('left', `${Math.max(0, rect.left)}px`, 'important');
    box.style.setProperty('top', `${Math.max(0, rect.top)}px`, 'important');
    box.style.setProperty('width', `${Math.max(1, Math.min(innerWidth - Math.max(0, rect.left), rect.width))}px`, 'important');
    box.style.setProperty('height', `${Math.max(1, Math.min(innerHeight - Math.max(0, rect.top), rect.height))}px`, 'important');
    box.dataset.source = String(state.mode === 'source');
    box.dataset.selected = String(Boolean(state.selectedNode));

    const target = {
      tag: clip(node.tagName, 40).toLowerCase(),
      text: clip(node.innerText || node.textContent, 180),
      selector: cssPath(node),
    };
    let lines = state.feedback && state.feedback.selector === target.selector
      ? state.feedback.lines
      : [{ kind: 'target', text: `<${target.tag}>${target.text ? ` · ${target.text.slice(0, 62)}` : ''}` }];
    if (state.mode === 'source' && (!state.feedback || state.feedback.selector !== target.selector)) {
      lines = [{ kind: 'target', text: 'Locating source…' }, ...lines];
    }
    hud.replaceChildren(...lines.slice(0, 4).map((line) => {
      const item = document.createElement('span');
      item.dataset.kind = line.kind || 'target';
      item.textContent = clip(line.text, 260);
      return item;
    }));
    hud.style.setProperty('display', 'block', 'important');
    const left = Math.max(8, Math.min(rect.left, innerWidth - Math.min(360, hud.offsetWidth || 320) - 8));
    const below = rect.bottom + 9;
    const top = below + 80 < innerHeight ? below : Math.max(8, rect.top - Math.max(48, hud.offsetHeight || 54) - 9);
    hud.style.setProperty('left', `${left}px`, 'important');
    hud.style.setProperty('top', `${top}px`, 'important');
  };

  const scheduleDraw = () => {
    if (!state.raf) state.raf = requestAnimationFrame(draw);
  };

  const processPointerMove = () => {
    state.pointerRaf = 0;
    if (state.mode === 'off') return;
    const node = featureFromTarget(state.pointerTarget);
    if (!node) return;
    state.hoverNode = node;
    if (state.selectedNode && state.selectedNode !== node) state.selectedNode = null;
    scheduleDraw();
    if (state.mode !== 'source') return;
    const rect = node.getBoundingClientRect();
    const signature = `${cssPath(node)}|${Math.round(rect.x / 3)}|${Math.round(rect.y / 3)}`;
    if (signature === state.lastHoverSignature) return;
    state.lastHoverSignature = signature;
    window.clearTimeout(state.hoverTimer);
    state.hoverTimer = window.setTimeout(() => {
      if (state.mode === 'source' && node.isConnected && state.lastHoverSignature === signature) report('hover', describe(node));
    }, 220);
  };

  const onPointerMove = (event) => {
    if (state.mode === 'off') return;
    state.pointerTarget = event.target;
    if (!state.pointerRaf) state.pointerRaf = requestAnimationFrame(processPointerMove);
  };

  const onClick = (event) => {
    if (state.mode === 'off' || event.button !== 0) return;
    const node = featureFromTarget(event.target);
    if (!node) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    state.selectedNode = node;
    state.hoverNode = node;
    state.feedback = null;
    scheduleDraw();
    report('select', describe(node));
  };

  const onKeyDown = (event) => {
    if (state.mode === 'off' || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    report('cancel', null);
  };

  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', scheduleDraw, true);
  window.addEventListener('resize', scheduleDraw, true);

  window.__hormaPreviewInspection = {
    setMode(mode) {
      const nextMode = mode === 'source' || mode === 'design' ? mode : 'off';
      if (state.mode === nextMode) {
        scheduleDraw();
        return;
      }
      state.mode = nextMode;
      state.hoverNode = null;
      state.selectedNode = null;
      state.lastHoverSignature = '';
      state.feedback = null;
      window.clearTimeout(state.hoverTimer);
      scheduleDraw();
    },
    setFeedback(feedback) {
      state.feedback = feedback && Array.isArray(feedback.lines) ? feedback : null;
      scheduleDraw();
    },
    setChromeVisible(visible) {
      state.chromeVisible = Boolean(visible);
      scheduleDraw();
    },
  };
})();
"#;

/// Preview-only DOM controller injected into each isolated Browser tab. It has
/// no Tauri capability and cannot reach the desktop or other application tabs.
const BROWSER_COMPUTER_SCRIPT: &str = r###"
(() => {
  if (window.top !== window || window.__hormaPreviewComputerUse) return;
  const QUERY = "a[href],button,input,textarea,select,summary,[contenteditable='true'],[role='button'],[role='link'],[role='checkbox'],[role='radio'],[role='tab'],[role='menuitem'],[tabindex]:not([tabindex='-1']),canvas,video";
  const probes={console:[],network:[],inflight:0,last:Date.now()};
  const pushProbe=(list,item)=>{list.push(item);if(list.length>16)list.shift()};
  try{const wrap=(level,fn)=>(...a)=>{pushProbe(probes.console,{level,text:String(a.map(v=>typeof v==='string'?v:JSON.stringify(v)).join(' ')).slice(0,180)});fn.apply(console,a)};console.error=wrap('error',console.error.bind(console));console.warn=wrap('warn',console.warn.bind(console))}catch{}
  addEventListener('error',e=>pushProbe(probes.console,{level:'error',text:String(e.message||'error').slice(0,180)}));
  addEventListener('unhandledrejection',e=>pushProbe(probes.console,{level:'error',text:String(e.reason||'rejection').slice(0,180)}));
  if(typeof fetch==='function'){const f=fetch.bind(window);window.fetch=async(input,init)=>{probes.inflight++;try{const r=await f(input,init);pushProbe(probes.network,{method:String((init&&init.method)||'GET'),url:String(input&&input.url||input).slice(0,180),status:r.status,ok:r.ok});return r}catch(err){pushProbe(probes.network,{method:'GET',url:String(input).slice(0,180),status:0,ok:false});throw err}finally{probes.inflight=Math.max(0,probes.inflight-1);probes.last=Date.now()}}}
  let recorded=[],recording=false,recordCleanup=null;
  const startRec=()=>{recordCleanup?.();recorded=[];recording=true;const click=e=>{if(!e.isTrusted||!e.target)return;recorded.push({type:'click',selector:cssPath(e.target)})};const change=e=>{if(!e.isTrusted||!e.target)return;const el=e.target;recorded.push(el.type==='file'?{type:'upload',selector:cssPath(el),fixture:'tiny.png'}:{type:'set_value',selector:cssPath(el),value:el.type==='password'?'':String(el.value||'').slice(0,512)})};const key=e=>{if(!e.isTrusted||!['Enter','Tab','Escape'].includes(e.key))return;recorded.push({type:'key',selector:cssPath(e.target||document.body),keys:e.key})};document.addEventListener('click',click,true);document.addEventListener('change',change,true);document.addEventListener('keydown',key,true);recordCleanup=()=>{document.removeEventListener('click',click,true);document.removeEventListener('change',change,true);document.removeEventListener('keydown',key,true)}};
  const stopRec=()=>{recordCleanup?.();recordCleanup=null;recording=false;const out=recorded.slice(0,48);recorded=[];return out};
  const a11y=()=>{const out=[],push=(el,rule,message)=>{if(out.length<16)out.push({el,rule,message,tag:el.tagName.toLowerCase(),selector:cssPath(el)})};if(!clip(document.documentElement.getAttribute('lang'),16))push(document.documentElement,'html-has-lang','The document html element has no lang attribute.');document.querySelectorAll('img').forEach((el,i)=>{if(i>80||!visible(el))return;if(!(el.getAttribute('alt')||el.getAttribute('aria-label')))push(el,'image-alt','Visible image is missing an accessible name.')});document.querySelectorAll('button,a[href],[role=button]').forEach((el,i)=>{if(i>80||!visible(el))return;if(!clip(el.getAttribute('aria-label')||el.innerText,40))push(el,'control-name','Interactive control is missing an accessible name.')});return out};
  const fixture=name=>{if(name==='sample.csv')return new File(['name,value\\npreview,1\\n'],'sample.csv',{type:'text/csv'});if(name==='note.txt')return new File(['Hormachuelos Preview fixture\\n'],'note.txt',{type:'text/plain'});const png=Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137,0,0,0,13,73,68,65,84,120,156,99,248,207,192,0,0,3,1,1,0,24,221,141,176,0,0,0,0,73,69,78,68,174,66,96,130]);return new File([png],'tiny.png',{type:'image/png'})};
  const scrollPos=el=>({x:Math.round(el.scrollLeft||0),y:Math.round(el.scrollTop||0),maxX:Math.max(0,Math.round(el.scrollWidth-el.clientWidth)),maxY:Math.max(0,Math.round(el.scrollHeight-el.clientHeight))});
  const scrollInfo=el=>{if(!el||el===document.body||el===document.documentElement)return null;const p=scrollPos(el),s=getComputedStyle(el);return((p.maxX>1&&/^(auto|scroll|overlay)$/.test(s.overflowX))||(p.maxY>1&&/^(auto|scroll|overlay)$/.test(s.overflowY)))?p:null};
  const scrollable=el=>!!scrollInfo(el);
  const canMove=(p,dx,dy)=>(dx>0&&p.x<p.maxX-1)||(dx<0&&p.x>1)||(dy>0&&p.y<p.maxY-1)||(dy<0&&p.y>1);
  const scrollCandidates=el=>{const out=[],seen=new Set();for(let n=el;n;n=n.parentElement){const p=scrollInfo(n);if(!seen.has(n)&&p){seen.add(n);out.push({target:n,position:p,kind:'nested'})}}const page=document.scrollingElement;if(page&&!seen.has(page))out.push({target:page,position:scrollPos(page),kind:'page'});return out};
  const chooseScroll=(list,dx,dy)=>{if(!list.length)return null;return list.find(c=>canMove(c.position,dx,dy))||list[0]};
  const refs = new Map();
  let generation = 0, cursor = null, badge = null, point = {x:32,y:32};
  const clip=(v,n=160)=>String(v||'').replace(/\s+/g,' ').trim().slice(0,n);
  const clamp=(v,a,b)=>Math.min(b,Math.max(a,Number.isFinite(Number(v))?Number(v):a));
  const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>=1&&r.height>=1&&r.bottom>=0&&r.right>=0&&r.top<=innerHeight&&r.left<=innerWidth&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>.01};
  const editable=el=>!!el&&(el.matches('input,textarea')||el.isContentEditable);
  const cssPath=el=>{if(el.id){try{const s='#'+CSS.escape(el.id);if(document.querySelectorAll(s).length===1)return s}catch{}}const p=[];for(let n=el;n&&n!==document.documentElement&&p.length<5;n=n.parentElement){let s=n.tagName.toLowerCase(),q=n.parentElement;if(q){const peers=Array.from(q.children).filter(x=>x.tagName===n.tagName);if(peers.length>1)s+=`:nth-of-type(${peers.indexOf(n)+1})`}p.unshift(s);const candidate=p.join(' > ');try{if(document.querySelectorAll(candidate).length===1)return candidate}catch{}}return p.join(' > ')};
  let targetFx=null,labelFx=null,styleFx=null,settleTimer=null,transients=[],currentTimer=null,currentReject=null,currentAnimation=null;
  const reduced=()=>!!matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ensureFx=()=>{if(cursor&&cursor.isConnected&&targetFx?.isConnected)return;const style=document.createElement('style');style.dataset.hormaComputerUse='true';style.textContent=`
#__horma_browser_cursor,#__horma_browser_target,#__horma_browser_badge,.__horma_browser_fx{box-sizing:border-box!important;pointer-events:none!important;user-select:none!important;font-family:ui-monospace,Consolas,monospace!important}
#__horma_browser_cursor{position:fixed!important;z-index:2147483646!important;left:0!important;top:0!important;width:52px!important;height:52px!important;opacity:0;transform:translate3d(32px,32px,0);will-change:transform,opacity;contain:layout style paint;isolation:isolate;transition:opacity .16s ease}
#__horma_browser_cursor[data-visible='true']{opacity:1}
#__horma_browser_cursor:before{content:'';position:absolute;inset:1px 17px 15px 1px;border-radius:7px 58% 58% 58%;background:linear-gradient(145deg,#f7feff,#68e7ff 42%,#7b61ff);clip-path:polygon(0 0,100% 69%,57% 74%,39% 100%);box-shadow:0 0 0 2px #03101ee6,0 0 12px rgba(87,221,255,.82);transform-origin:7px 7px;transition:transform .12s cubic-bezier(.16,1,.3,1),opacity .12s ease}
#__horma_browser_cursor:after{content:'';position:absolute;left:-12px;top:-12px;width:48px;height:48px;border:1px solid rgba(108,234,255,.7);border-radius:50%;opacity:.2;transform:scale(.72);transition:transform .16s cubic-bezier(.16,1,.3,1),opacity .16s ease}
#__horma_browser_cursor[data-gesture='approach']:after{opacity:.82;transform:scale(1)}
#__horma_browser_cursor[data-gesture='hover']:before{transform:scale(1.06) rotate(-2deg)}
#__horma_browser_cursor[data-gesture='press']:before{transform:scale(.86) rotate(-3deg)}
#__horma_browser_cursor[data-gesture='click']:before{animation:__horma_browser_click .22s cubic-bezier(.16,1,.3,1)}
#__horma_browser_core{position:absolute;left:5px;top:5px;width:7px;height:7px;border-radius:50%;background:#fff;box-shadow:0 0 0 2px rgba(83,224,255,.5),0 0 12px #fff}
#__horma_browser_label{position:absolute;left:28px;top:30px;white-space:nowrap;padding:4px 7px;border:1px solid rgba(123,230,255,.76);border-radius:999px;background:#07121ef2;color:#effdff;font:800 9px/1 ui-monospace,Consolas,monospace!important;letter-spacing:.08em;box-shadow:0 4px 12px rgba(0,0,0,.38);opacity:0;transform:translate3d(0,4px,0);transition:transform .14s cubic-bezier(.16,1,.3,1),opacity .14s ease}
#__horma_browser_cursor[data-label-x='left'] #__horma_browser_label{left:auto;right:32px}
#__horma_browser_cursor[data-label-y='up'] #__horma_browser_label{top:auto;bottom:32px}
#__horma_browser_cursor[data-busy='true'] #__horma_browser_label{opacity:1;transform:translate3d(0,0,0)}
#__horma_browser_target{position:fixed!important;z-index:2147483644!important;left:0!important;top:0!important;opacity:0;border:1px solid rgba(108,234,255,.94);border-radius:12px;background:linear-gradient(135deg,rgba(108,234,255,.06),rgba(123,97,255,.045));box-shadow:0 0 0 1px rgba(3,10,20,.82),0 0 0 4px rgba(108,234,255,.11),0 0 18px rgba(92,133,255,.22);transform:translate3d(0,0,0) scale(.97);will-change:transform,opacity;contain:layout style paint;transition:opacity .14s ease,transform .16s cubic-bezier(.16,1,.3,1)}
#__horma_browser_target:before{content:'';position:absolute;inset:-3px;border-radius:inherit;background:linear-gradient(#6ceaff,#6ceaff) left top/14px 2px no-repeat,linear-gradient(#6ceaff,#6ceaff) left top/2px 14px no-repeat,linear-gradient(#8d73ff,#8d73ff) right top/14px 2px no-repeat,linear-gradient(#8d73ff,#8d73ff) right top/2px 14px no-repeat,linear-gradient(#8d73ff,#8d73ff) left bottom/14px 2px no-repeat,linear-gradient(#8d73ff,#8d73ff) left bottom/2px 14px no-repeat,linear-gradient(#6ceaff,#6ceaff) right bottom/14px 2px no-repeat,linear-gradient(#6ceaff,#6ceaff) right bottom/2px 14px no-repeat}
#__horma_browser_target[data-visible='true']{opacity:.9;transform:translate3d(var(--horma-x),var(--horma-y),0) scale(1)}
#__horma_browser_target[data-gesture='press']{opacity:1;transform:translate3d(var(--horma-x),var(--horma-y),0) scale(.985)}
#__horma_browser_target[data-gesture='click']{border-color:#a58bff;box-shadow:0 0 0 1px rgba(3,10,20,.82),0 0 0 5px rgba(141,115,255,.18),0 0 22px rgba(108,234,255,.28)}
#__horma_browser_target[data-gesture='boundary']{border-color:#ffbf69}
#__horma_browser_target_label{position:absolute;right:8px;top:-11px;padding:3px 7px;border-radius:999px;background:#07121ef2;color:#dffcff;border:1px solid rgba(108,234,255,.65);font:800 9px/1 ui-monospace,Consolas,monospace!important;letter-spacing:.08em}
#__horma_browser_badge{position:fixed!important;z-index:2147483647!important;left:18px!important;bottom:18px!important;max-width:min(360px,calc(100vw - 36px));padding:9px 13px;border:1px solid rgba(107,222,255,.46);border-radius:999px;background:#05101cf2;color:#e9fcff;font:700 12px/1.25 ui-monospace,Consolas,monospace!important;letter-spacing:.05em;box-shadow:0 10px 28px rgba(0,0,0,.32)}
.__horma_browser_trail{position:fixed!important;z-index:2147483643!important;left:0!important;top:0!important;width:7px!important;height:7px!important;border-radius:50%;background:#8bf0ff;box-shadow:0 0 8px #6d8cff;will-change:transform,opacity;contain:strict}
.__horma_browser_wave{position:fixed!important;z-index:2147483645!important;left:0!important;top:0!important;width:20px!important;height:20px!important;margin:-10px;border:2px solid #79efff;border-radius:50%;box-shadow:0 0 0 2px rgba(126,92,255,.42),0 0 16px rgba(105,103,255,.55);will-change:transform,opacity;contain:strict}
.__horma_browser_scroll{position:fixed!important;z-index:2147483645!important;left:0!important;top:0!important;color:#effdff;background:#07121ee8;border:1px solid #6ceaff;border-radius:999px;padding:5px 8px;font:900 13px/1 ui-monospace,Consolas,monospace!important;will-change:transform,opacity;contain:layout style paint}
@keyframes __horma_browser_click{0%{transform:scale(.86)}55%{transform:scale(1.08)}100%{transform:scale(1)}}@media(prefers-reduced-motion:reduce){#__horma_browser_cursor:before,#__horma_browser_cursor:after,#__horma_browser_target,#__horma_browser_label{animation:none!important;transition-duration:.01ms!important}.__horma_browser_trail,.__horma_browser_wave{display:none!important}}`;styleFx=style;(document.head||document.documentElement).appendChild(style);cursor=document.createElement('div');cursor.id='__horma_browser_cursor';cursor.setAttribute('aria-hidden','true');const core=document.createElement('span');core.id='__horma_browser_core';labelFx=document.createElement('span');labelFx.id='__horma_browser_label';labelFx.textContent='AI';cursor.append(core,labelFx);targetFx=document.createElement('div');targetFx.id='__horma_browser_target';targetFx.setAttribute('aria-hidden','true');const targetLabel=document.createElement('span');targetLabel.id='__horma_browser_target_label';targetLabel.textContent='TARGET';targetFx.append(targetLabel);targetFx._label=targetLabel;badge=document.createElement('div');badge.id='__horma_browser_badge';badge.setAttribute('aria-hidden','true');badge.textContent='AI cursor · Preview Browser only';(document.body||document.documentElement).append(targetFx,cursor,badge);installTakeover()};
  const hide=()=>{if(cursor){cursor.dataset.visible='false';cursor.dataset.busy='false';cursor.dataset.gesture='idle'}if(targetFx)targetFx.dataset.visible='false'};
  const destroyFx=()=>{if(settleTimer)clearTimeout(settleTimer);settleTimer=null;if(currentTimer)clearTimeout(currentTimer);currentTimer=null;if(currentReject){const reject=currentReject;currentReject=null;reject(Error('Preview Computer Use stopped.'))}currentAnimation?.cancel?.();currentAnimation=null;transients.splice(0).forEach(el=>el.remove());if(typeof document.removeEventListener==='function')['pointermove','pointerdown','wheel','keydown'].forEach(type=>document.removeEventListener(type,takeover,true));targetFx?.remove();cursor?.remove();badge?.remove();styleFx?.remove();targetFx=cursor=badge=styleFx=labelFx=null};
  const takeover=e=>{if(e.isTrusted!==false)hide()};
  const installTakeover=()=>{if(typeof document.addEventListener==='function')['pointermove','pointerdown','wheel','keydown'].forEach(type=>document.addEventListener(type,takeover,true))};
  const status=(text,active=false)=>{ensureFx();badge.textContent='AI cursor · '+text;badge.dataset.active=String(active);cursor.dataset.busy=String(active||cursor.dataset.gesture!=='idle')};
  const gesture=(name,label=name.toUpperCase())=>{ensureFx();cursor.dataset.visible='true';cursor.dataset.busy=String(name!=='idle');cursor.dataset.gesture=name;labelFx.textContent='AI · '+label};
  const place=p=>{point={x:clamp(p.x,0,Math.max(0,innerWidth-1)),y:clamp(p.y,0,Math.max(0,innerHeight-1))};ensureFx();cursor.style.transform=`translate3d(${point.x}px,${point.y}px,0)`;cursor.dataset.labelX=point.x>innerWidth-150?'left':'right';cursor.dataset.labelY=point.y>innerHeight-56?'up':'down'};
  const feature=el=>{for(let n=el,d=0;n&&d<8;n=n.parentElement,d++){if(n===document.body||n===document.documentElement)break;try{if(n.matches("button,a[href],input,textarea,select,summary,[contenteditable='true'],[role='button'],[role='link'],[role='checkbox'],[role='radio'],[role='tab'],[role='menuitem']"))return n}catch{}}return el&&el!==document.body&&el!==document.documentElement?el:null};
  const showTarget=(el,state)=>{ensureFx();el=feature(el);if(!el){targetFx.dataset.visible='false';return}const r=el.getBoundingClientRect();if(r.width<1||r.height<1)return;const p=6,x=clamp(r.left-p,2,Math.max(2,innerWidth-6)),y=clamp(r.top-p,2,Math.max(2,innerHeight-6)),w=clamp(r.width+p*2,8,Math.max(8,innerWidth-x-2)),h=clamp(r.height+p*2,8,Math.max(8,innerHeight-y-2));if(typeof targetFx.style.setProperty==='function'){targetFx.style.setProperty('--horma-x',x+'px');targetFx.style.setProperty('--horma-y',y+'px')}else{targetFx.style['--horma-x']=x+'px';targetFx.style['--horma-y']=y+'px'};targetFx.style.width=w+'px';targetFx.style.height=h+'px';targetFx.dataset.gesture=state;targetFx.dataset.visible='true';targetFx._label.textContent=String(state).toUpperCase()};
  const transient=(el,ttl)=>{el.dataset.hormaAiFx='transient';transients.push(el);while(transients.length>8)transients.shift()?.remove();setTimeout(()=>{el.remove();transients=transients.filter(v=>v!==el)},ttl)};
  const trail=(a,b)=>{if(reduced())return;const dist=Math.hypot(b.x-a.x,b.y-a.y);if(dist<52)return;const count=Math.min(3,Math.max(2,Math.round(dist/180)+1));for(let i=1;i<=count;i++){const q=i/(count+1),x=a.x+(b.x-a.x)*q,y=a.y+(b.y-a.y)*q,d=document.createElement('i');d.className='__horma_browser_trail';(document.body||document.documentElement).appendChild(d);transient(d,340);d.animate?.([{opacity:.72,transform:`translate3d(${x}px,${y}px,0) scale(1)`},{opacity:0,transform:`translate3d(${x-4}px,${y-4}px,0) scale(.12)`}],{duration:300,easing:'cubic-bezier(.16,1,.3,1)',fill:'forwards'})}};
  const wave=p=>{if(reduced())return;const w=document.createElement('i');w.className='__horma_browser_wave';(document.body||document.documentElement).appendChild(w);transient(w,520);w.animate?.([{opacity:.9,transform:`translate3d(${p.x}px,${p.y}px,0) scale(.35)`},{opacity:0,transform:`translate3d(${p.x}px,${p.y}px,0) scale(3.5)`}],{duration:460,easing:'cubic-bezier(.16,1,.3,1)',fill:'forwards'})};
  const scrollCue=(p,x,y,boundary)=>{const c=document.createElement('i'),horizontal=Math.abs(x)>Math.abs(y),label=horizontal?(x>=0?'→':'←'):(y>=0?'↓':'↑');c.className='__horma_browser_scroll';c.textContent=boundary?'!'+label:label;(document.body||document.documentElement).appendChild(c);transient(c,380);const dx=horizontal?Math.sign(x||1)*11:0,dy=horizontal?0:Math.sign(y||1)*11;c.animate?.([{opacity:.92,transform:`translate3d(${p.x+18}px,${p.y+18}px,0)`},{opacity:0,transform:`translate3d(${p.x+18+dx}px,${p.y+18+dy}px,0)`}],{duration:reduced()?1:340,easing:'cubic-bezier(.16,1,.3,1)',fill:'forwards'})};
  const move=async(p,own,ms)=>{if(own!==generation)throw Error('Preview Computer Use stopped.');ensureFx();const end={x:clamp(p.x,0,innerWidth-1),y:clamp(p.y,0,innerHeight-1)},dist=Math.hypot(end.x-point.x,end.y-point.y),requested=ms==null?45+dist*.22:Number(ms),duration=reduced()||dist<2?0:(requested===0?0:clamp(requested,45,120));gesture('approach','TARGET');trail(point,end);if(duration&&cursor.animate){const start={...point},lean=clamp((end.x-start.x)/Math.max(1,dist)*4,-4,4),a=cursor.animate([{transform:`translate3d(${start.x}px,${start.y}px,0) rotate(0deg)`},{transform:`translate3d(${(start.x+end.x)/2}px,${Math.min(start.y,end.y)-Math.min(18,dist*.06)}px,0) rotate(${lean}deg)`},{transform:`translate3d(${end.x}px,${end.y}px,0) rotate(0deg)`}],{duration,easing:'cubic-bezier(.16,1,.3,1)',fill:'forwards'});currentAnimation=a;try{await a.finished}catch{if(own!==generation)throw Error('Preview Computer Use stopped.')}finally{if(currentAnimation===a)currentAnimation=null}}if(own!==generation)throw Error('Preview Computer Use stopped.');place(end)};
  const sleep=(ms,own)=>new Promise((resolve,reject)=>{if(own!==generation)return reject(Error('Preview Computer Use stopped.'));currentReject=reject;currentTimer=setTimeout(()=>{currentTimer=null;currentReject=null;own===generation?resolve():reject(Error('Preview Computer Use stopped.'))},ms)});
  const resolve=(a,end=false)=>{const ref=end?a.end_ref:a.ref,selector=end?a.end_selector:a.selector,explicit=!!(ref||selector),x=Number(end?a.end_x:a.x),y=Number(end?a.end_y:a.y);let el=ref?refs.get(ref):null;if(el&&!el.isConnected){refs.delete(ref);el=null}if(ref&&!el&&!selector)throw Error('Stale Preview ref "'+ref+'". Call computer_observe again.');if(!el&&selector){try{el=document.querySelector(selector)}catch{throw Error('Invalid Preview Browser selector.')}}if(!el&&Number.isFinite(x)&&Number.isFinite(y))el=document.elementFromPoint(x,y);if(!el&&explicit)throw Error('The requested Preview target is no longer available. Call computer_observe again.');if(!el&&!end)el=document.activeElement;if(el){const r=el.getBoundingClientRect();return{el,point:{x:Number.isFinite(x)?x:r.left+r.width/2,y:Number.isFinite(y)?y:r.top+r.height/2}}}if(Number.isFinite(x)&&Number.isFinite(y))return{el:null,point:{x,y}};throw Error('Preview Browser action needs a ref, selector, or x/y coordinates.')};
  const pointer=(el,type,p,button=0)=>{const init={bubbles:true,cancelable:true,composed:true,clientX:p.x,clientY:p.y,button,buttons:type.endsWith('down')?1<<button:0,pointerId:1,pointerType:'mouse',isPrimary:true};try{el.dispatchEvent(new PointerEvent(type,init))}catch{el.dispatchEvent(new MouseEvent(type.replace('pointer','mouse'),init))}};
  const hoverEvents=(el,p,button=0)=>{['pointerover','pointerenter','pointermove'].forEach(v=>pointer(el,v,p,button));const init={bubbles:true,cancelable:true,composed:true,clientX:p.x,clientY:p.y,button};['mouseover','mouseenter','mousemove'].forEach(v=>el.dispatchEvent(new MouseEvent(v,init)))};
  const typeText=(el,text,clear)=>{el.focus?.({preventScroll:true});if(el.matches('input,textarea')){const start=clear?0:(el.selectionStart??el.value.length),end=clear?el.value.length:(el.selectionEnd??start);el.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:text}));el.setRangeText(text,start,end,'end');el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));el.dispatchEvent(new Event('change',{bubbles:true}))}else{if(clear){const r=document.createRange();r.selectNodeContents(el);const q=getSelection();q.removeAllRanges();q.addRange(r)}el.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:text}));if(!document.execCommand('insertText',false,text))el.textContent=clear?text:(el.textContent||'')+text;el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}))}};
  const setValue=(el,value)=>{const tag=el.tagName.toLowerCase();el.focus?.({preventScroll:true});if(tag==='select'){const option=Array.from(el.options).find(v=>v.value===String(value)||clip(v.label||v.textContent)===clip(value));if(!option)throw Error('Select option was not found in the active Preview field.');el.value=option.value}else if(el.matches('input,textarea')){const proto=Object.getPrototypeOf(el)?.constructor?.prototype,descriptor=proto?Object.getOwnPropertyDescriptor(proto,'value'):null;descriptor?.set?.call(el,String(value));if(el.value!==String(value))el.value=String(value)}else if(el.isContentEditable)el.textContent=String(value);else throw Error('set_value requires an input, textarea, select, or contenteditable target.');el.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertReplacementText',data:String(value)}));el.dispatchEvent(new Event('change',{bubbles:true,composed:true}));const actual='value'in el?String(el.value):clip(el.textContent,240),sensitive=el.matches('input')&&String(el.type).toLowerCase()==='password',valid=typeof el.checkValidity==='function'?el.checkValidity():true;return{value:sensitive?'[redacted]':actual,inputType:el.matches('input')?el.type:tag,valid,validationMessage:valid?'':clip(el.validationMessage,240)}};
  const keyPress=(el,chord)=>{const parts=String(chord).split('+').map(v=>v.trim()).filter(Boolean),key=parts.pop()||chord,mods=parts.map(v=>v.toLowerCase()),init={key:key==='Space'?' ':key,code:key==='Space'?'Space':key,bubbles:true,cancelable:true,ctrlKey:mods.includes('ctrl')||mods.includes('control'),altKey:mods.includes('alt'),shiftKey:mods.includes('shift')};const allowed=el.dispatchEvent(new KeyboardEvent('keydown',init));if(allowed&&init.ctrlKey&&String(key).toLowerCase()==='a'&&editable(el)){if(el.matches('input,textarea'))el.select();else{const r=document.createRange();r.selectNodeContents(el);const q=getSelection();q.removeAllRanges();q.addRange(r)}}else if(allowed&&(key==='Enter'||key==='Space')){if(el.matches('button,a[href]'))el.click();else if(key==='Enter'&&editable(el))el.closest('form')?.requestSubmit()}else if(allowed&&key==='Tab'){const all=Array.from(document.querySelectorAll(QUERY)).filter(v=>visible(v)&&v.tabIndex>=0),i=Math.max(0,all.indexOf(el));all[(i+(init.shiftKey?-1:1)+all.length)%all.length]?.focus()}else if(allowed&&['ArrowUp','ArrowDown'].includes(key)&&el.matches('input[type=number],input[type=range],input[type=date],input[type=time],input[type=datetime-local]')){key==='ArrowUp'?el.stepUp?.():el.stepDown?.();el.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true}));el.dispatchEvent(new Event('change',{bubbles:true,composed:true}))}el.dispatchEvent(new KeyboardEvent('keyup',init))};
  const effectiveVisible=el=>{if(!visible(el))return false;let r=el.getBoundingClientRect(),l=Math.max(0,r.left),t=Math.max(0,r.top),rr=Math.min(innerWidth,r.right),b=Math.min(innerHeight,r.bottom);for(let n=el.parentElement,d=0;n&&d<8;n=n.parentElement,d++){if(n.getAttribute('aria-hidden')==='true'||n.hasAttribute('inert'))return false;const q=getComputedStyle(n),br=n.getBoundingClientRect();if(q.display==='none'||q.visibility==='hidden'||Number(q.opacity||1)<=.01)return false;if(/^(hidden|clip|auto|scroll|overlay)$/.test(q.overflowX)){l=Math.max(l,br.left);rr=Math.min(rr,br.right)}if(/^(hidden|clip|auto|scroll|overlay)$/.test(q.overflowY)){t=Math.max(t,br.top);b=Math.min(b,br.bottom)}if(rr-l<1||b-t<1)return false}return true};
  const semantic=()=>{const out=[],seen=new Set(),root=document.body||document.documentElement;if(!root||typeof document.createTreeWalker!=='function')return out;const walker=document.createTreeWalker(root,typeof NodeFilter==='undefined'?1:NodeFilter.SHOW_ELEMENT),selector="h1,h2,h3,h4,h5,h6,p,li,label,legend,th,td,[role='heading'],[role='alert'],[role='status'],[role='dialog']";let scanned=0,total=0;while(scanned<240&&out.length<32){const el=walker.nextNode();if(!el)break;scanned++;try{if(!el.matches(selector)||!effectiveVisible(el))continue}catch{continue}const text=clip(el.innerText||el.textContent,240);if(!text||seen.has(text)||total+text.length>6000)continue;seen.add(text);total+=text.length;const r=el.getBoundingClientRect();out.push({tag:el.tagName.toLowerCase(),role:clip(el.getAttribute('role')||el.tagName.toLowerCase(),48),text,selector:cssPath(el),rect:{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}})}return out};
  const check=(a,t)=>{const e=a.expect||{},el=t.el,actual={visible:!!el&&effectiveVisible(el),enabled:!!el&&!el.disabled,checked:!!el&&'checked'in el?!!el.checked:false,text:clip(el?.innerText||el?.textContent,500),value:el&&el.matches?.('input')&&String(el.type).toLowerCase()==='password'?'[redacted]':el&&'value'in el?String(el.value):'',url:location.href,title:document.title},match=a.match==='equals'?((x,y)=>String(x)===String(y)):((x,y)=>String(x).toLowerCase().includes(String(y).toLowerCase())),fail=[];['visible','enabled','checked'].forEach(k=>{if(typeof e[k]==='boolean'&&actual[k]!==e[k])fail.push(k)});['text','value','url','title'].forEach(k=>{if(e[k]!=null&&!match(actual[k],e[k]))fail.push(k)});const r=el?.getBoundingClientRect?.();return{passed:!fail.length,failures:fail,expected:e,actual,rect:r&&r.width>0&&r.height>0?{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}:null}};
  const observe=()=>{refs.clear();const elements=[],interactive=[],scrollables=[],positions=new Map(),inspected=new Set(),addAncestors=seed=>{for(let n=seed;n&&inspected.size<480;n=n.parentElement){if(inspected.has(n))break;inspected.add(n);const p=scrollInfo(n);if(p&&!positions.has(n)){positions.set(n,p);scrollables.push(n)}}};addAncestors(document.elementFromPoint(point.x,point.y));let scanned=0;for(const el of document.querySelectorAll(QUERY)){if(scanned>=320||interactive.length>=80)break;scanned++;if(!visible(el))continue;interactive.push(el);addAncestors(el)}const emitted=new Set();for(const el of [...scrollables,...interactive]){if(elements.length>=80)break;if(emitted.has(el)||!visible(el))continue;emitted.add(el);const ref='p'+(elements.length+1),r=el.getBoundingClientRect(),input=el,p=positions.get(el);refs.set(ref,el);const item={ref,tag:el.tagName.toLowerCase(),role:clip(el.getAttribute('role')||el.tagName.toLowerCase(),48),name:p?(clip(el.getAttribute('aria-label')||el.getAttribute('title')||el.id)||'Scrollable region'):clip(el.getAttribute('aria-label')||el.getAttribute('title')||el.getAttribute('alt')||input.placeholder||el.innerText||el.textContent||input.name||el.id),selector:cssPath(el),rect:{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)},disabled:!!input.disabled};if(p){item.scrollable=true;item.scroll=p}if(typeof input.checked==='boolean')item.checked=input.checked;if(item.tag==='input'){item.inputType=clip(input.type||'text',32);item.required=!!input.required;if(clip(input.min))item.min=clip(input.min,80);if(clip(input.max))item.max=clip(input.max,80);if(clip(input.step))item.step=clip(input.step,40)}if('value'in input&&input.type!=='password'&&clip(input.value))item.value=clip(input.value,120);elements.push(item)}status('Observed '+elements.length+' target'+(elements.length===1?'':'s'));const issues=a11y().map(item=>{let ref='';for(const [k,v] of refs){if(v===item.el){ref=k;break}}if(!ref&&elements.length<80){ref='p'+(elements.length+1);refs.set(ref,item.el)}return{ref:ref||undefined,rule:item.rule,message:item.message,selector:item.selector,tag:item.tag}});return{scope:'active-preview-tab-only',tabKind:'browser',title:clip(document.title,200),url:location.href,viewport:{width:innerWidth,height:innerHeight,scrollX:Math.round(scrollX),scrollY:Math.round(scrollY),devicePixelRatio},cursor:{x:Math.round(point.x),y:Math.round(point.y)},elements,content:semantic(),a11y:issues,console:probes.console.filter(v=>v.level==='error').slice(-16),network:probes.network.filter(v=>!v.ok).slice(-16),hint:'Use refs with computer_actions. a11y lists bounded accessibility hits with the same refs. Prefer wait_for over wait. upload uses tiny.png, sample.csv, or note.txt. viewport.scrollY is page-only.'}};
  const settleScroll=own=>new Promise((resolve,reject)=>{if(own!==generation)return reject(Error('Preview Computer Use stopped.'));if(typeof requestAnimationFrame!=='function')return resolve();let n=0;const tick=()=>{if(own!==generation)return reject(Error('Preview Computer Use stopped.'));if(++n>=2)resolve();else requestAnimationFrame(tick)};requestAnimationFrame(tick)});
  const action=async(a,own)=>{const duration=a.duration_ms==null?undefined:clamp(a.duration_ms,0,900);if(a.type==='record'){if(a.state==='stop')return{recorded:stopRec()};startRec();return{recording:true}}if(a.type==='wait'){await sleep(clamp(a.duration_ms??180,0,10000),own);return{}}if(a.type==='wait_for'){const timeout=clamp(a.duration_ms??4000,50,10000),started=Date.now();let last={passed:false};while(Date.now()-started<=timeout){if(own!==generation)throw Error('Preview Computer Use stopped.');if(a.expect&&Object.keys(a.expect).length)last=check(a,resolve(a));else last={passed:probes.inflight===0&&Date.now()-probes.last>=220,expected:{network_idle:true}};if(last.passed)return{...last,waitedMs:Date.now()-started,timedOut:false};await sleep(48,own)}return{...last,waitedMs:Date.now()-started,timedOut:true,passed:false}}if(a.type==='upload'){const name=['tiny.png','sample.csv','note.txt'].includes(a.fixture)?a.fixture:'tiny.png',t=resolve(a),el=t.el;if(!el||el.tagName.toLowerCase()!=='input'||String(el.type).toLowerCase()!=='file')throw Error('upload requires an observed file input.');const dt=new DataTransfer();dt.items.add(fixture(name));el.files=dt.files;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return{fixture:name,files:el.files.length}}if(a.type==='scroll'){const explicit=!!(a.ref||a.selector);let t;if(explicit||(Number.isFinite(Number(a.x))&&Number.isFinite(Number(a.y))))t=resolve(a);else t={el:document.elementFromPoint(point.x,point.y)||document.scrollingElement,point};showTarget(t.el,'scroll');gesture('scroll','SCROLL');await move(t.point,own,duration);const dx=clamp(a.delta_x??0,-4000,4000),dy=clamp(a.delta_y??520,-4000,4000),candidate=chooseScroll(scrollCandidates(t.el),dx,dy);if(!candidate)throw Error('No scrollable region is available in the active Preview tab.');showTarget(candidate.kind==='page'?t.el:candidate.target,'scroll');const before=scrollPos(candidate.target),wheelTarget=t.el||document.elementFromPoint(t.point.x,t.point.y);wheelTarget?.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:t.point.x,clientY:t.point.y,deltaX:dx,deltaY:dy}));candidate.target.scrollBy({left:dx,top:dy,behavior:'auto'});let after=scrollPos(candidate.target),moved=Math.abs(after.x-before.x)>1||Math.abs(after.y-before.y)>1;if(!moved){await settleScroll(own);after=scrollPos(candidate.target);moved=Math.abs(after.x-before.x)>1||Math.abs(after.y-before.y)>1}showTarget(candidate.kind==='page'?t.el:candidate.target,moved?'scroll':'boundary');scrollCue(t.point,after.x-before.x||dx,after.y-before.y||dy,!moved);return{target:candidate.kind,selector:candidate.kind==='page'?null:cssPath(candidate.target),requested:{x:dx,y:dy},before,after,applied:{x:after.x-before.x,y:after.y-before.y},moved,boundary:!moved}}if(a.type==='drag'){const q=resolve(a),e=resolve(a,true);if(!q.el)throw Error('Drag start target was not found.');showTarget(q.el,'drag');gesture('drag','DRAG');await move(q.point,own,duration);pointer(q.el,'pointerdown',q.point);q.el.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true}));await move(e.point,own,duration??120);const out=e.el||document.elementFromPoint(e.point.x,e.point.y)||q.el;showTarget(out,'drag');pointer(out,'pointermove',e.point);out.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,clientX:e.point.x,clientY:e.point.y}));out.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,clientX:e.point.x,clientY:e.point.y}));pointer(out,'pointerup',e.point);q.el.dispatchEvent(new DragEvent('dragend',{bubbles:true}));return{}}const t=resolve(a);showTarget(t.el,a.type);const fast=['type','key','set_value','check'].includes(a.type)&&duration==null?0:duration;await move(t.point,own,fast);if(!t.el)return{};if(a.type==='move'||a.type==='hover'){gesture('hover','HOVER');showTarget(t.el,'hover');hoverEvents(t.el,t.point);return{}}if(a.type==='click'){const button=a.button==='right'?2:a.button==='middle'?1:0;gesture('hover','CLICK');showTarget(t.el,'hover');hoverEvents(t.el,t.point,button);gesture('press','CLICK');showTarget(t.el,'press');if(!reduced())await sleep(58,own);pointer(t.el,'pointerdown',t.point,button);t.el.focus?.({preventScroll:true});pointer(t.el,'pointerup',t.point,button);if(button===0){const count=a.clicks===2?2:1;for(let i=0;i<count;i++)t.el.click?.();if(count===2)t.el.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,clientX:t.point.x,clientY:t.point.y}))}else if(button===2)t.el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:t.point.x,clientY:t.point.y,button:2}));else t.el.dispatchEvent(new MouseEvent('auxclick',{bubbles:true,cancelable:true,clientX:t.point.x,clientY:t.point.y,button:1}));gesture('click','DONE');showTarget(t.el,'click');wave(t.point);if(a.clicks===2)setTimeout(()=>wave(t.point),110);return{}}if(a.type==='set_value'){gesture('type','SET');showTarget(t.el,'type');return setValue(t.el,String(a.value??a.text??''))}if(a.type==='type'){const el=editable(t.el)?t.el:document.activeElement;if(!editable(el))throw Error('Type target is not editable.');gesture('type','TYPE');showTarget(el,'type');typeText(el,String(a.text??''),!!a.clear);return{value:el.matches('input')&&String(el.type).toLowerCase()==='password'?'[redacted]':el.matches('input,textarea')?el.value:clip(el.textContent,240)}}if(a.type==='key'){gesture('key','KEY');showTarget(t.el,'key');t.el.focus?.({preventScroll:true});keyPress(t.el,String(a.keys||''));return{}}if(a.type==='check'){gesture('hover','CHECK');showTarget(t.el,'hover');return check(a,t)}return{}};
  window.__hormaPreviewComputerUse={stop(){generation++;destroyFx();return{ok:true,scope:'active-preview-tab-only'}},observe,async actions(args){try{generation++;if(currentTimer)clearTimeout(currentTimer);if(currentReject){const reject=currentReject;currentReject=null;reject(Error('Preview Computer Use superseded.'))}currentAnimation?.cancel?.();currentAnimation=null;const own=generation;if(!refs.size)observe();const list=Array.isArray(args?.actions)?args.actions:[],results=[];for(let i=0;i<list.length;i++){if(own!==generation)throw Error('Preview Computer Use stopped.');status(`${i+1}/${list.length} · ${list[i].type}`,true);const detail=await action(list[i],own)||{};results.push({index:i,type:list[i].type,ok:true,...detail})}status(`Complete · ${list.length} action${list.length===1?'':'s'}`);const failed=results.filter(v=>v.type==='check'&&v.passed===false);if(settleTimer)clearTimeout(settleTimer);settleTimer=setTimeout(()=>{settleTimer=null;hide()},900);return{ok:failed.length===0,passed:failed.length===0,failedChecks:failed.length,scope:'active-preview-tab-only',completed:list.length,results,cursor:{x:Math.round(point.x),y:Math.round(point.y)}}}catch(error){destroyFx();throw error}},handle(op,args){if(op==='observe')return Promise.resolve(observe());if(op==='actions')return this.actions(args);if(op==='stop')return Promise.resolve(this.stop());return Promise.reject(Error('Unsupported Preview Computer Use operation.'))}};
})();
"###;
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewBrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewBrowserEvent {
    label: String,
    kind: &'static str,
    url: Option<String>,
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<PreviewBrowserTarget>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewBrowserTarget {
    tag: String,
    text: String,
    selector: String,
    #[serde(default)]
    dom_context: DesignDomContext,
    rect: DesignRect,
    #[serde(default)]
    style_selectors: Vec<String>,
    #[serde(default)]
    source_file: String,
    source_line: Option<u32>,
    source_column: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewBrowserFeedbackLine {
    kind: String,
    text: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewBrowserFeedback {
    selector: String,
    lines: Vec<PreviewBrowserFeedbackLine>,
}

fn ensure_main_caller(caller: &Webview) -> Result<(), String> {
    if caller.label() == "main" {
        Ok(())
    } else {
        Err("Browser controls are available only to the Hormachuelos app shell.".into())
    }
}

fn validate_label(label: &str) -> Result<(), String> {
    let suffix = label
        .strip_prefix(BROWSER_LABEL_PREFIX)
        .ok_or_else(|| "Invalid preview browser label.".to_string())?;
    if suffix.is_empty()
        || label.len() > 96
        || !suffix
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_'))
    {
        return Err("Invalid preview browser label.".into());
    }
    Ok(())
}

fn parse_browser_url(raw: &str) -> Result<tauri::Url, String> {
    let value = raw.trim();
    if value.is_empty() || value.len() > MAX_BROWSER_URL_LEN || value.contains('\0') {
        return Err("Enter a valid web address.".into());
    }
    let url = tauri::Url::parse(value).map_err(|_| "Enter a valid web address.".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Only safe http:// and https:// web addresses are supported.".into());
    }
    Ok(url)
}

fn validate_bounds(bounds: PreviewBrowserBounds) -> Result<PreviewBrowserBounds, String> {
    let values = [bounds.x, bounds.y, bounds.width, bounds.height];
    if values.iter().any(|value| !value.is_finite())
        || bounds.x < 0.0
        || bounds.y < 0.0
        || bounds.width < 2.0
        || bounds.height < 2.0
        || bounds.x > 32_768.0
        || bounds.y > 32_768.0
        || bounds.width > 32_768.0
        || bounds.height > 32_768.0
    {
        return Err("Invalid preview browser bounds.".into());
    }
    Ok(bounds)
}

fn compact(value: &str, max: usize) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

fn sanitize_target(mut target: PreviewBrowserTarget) -> Option<PreviewBrowserTarget> {
    let rect_values = [
        target.rect.x,
        target.rect.y,
        target.rect.width,
        target.rect.height,
    ];
    if rect_values.iter().any(|value| !value.is_finite())
        || target.rect.width < 1.0
        || target.rect.height < 1.0
    {
        return None;
    }
    target.rect.x = target.rect.x.clamp(-32_768.0, 32_768.0);
    target.rect.y = target.rect.y.clamp(-32_768.0, 32_768.0);
    target.rect.width = target.rect.width.clamp(1.0, 32_768.0);
    target.rect.height = target.rect.height.clamp(1.0, 32_768.0);
    target.tag = compact(&target.tag.to_ascii_lowercase(), 40);
    target.text = compact(&target.text, 180);
    target.selector = compact(&target.selector, 600);
    if target.tag.is_empty() || target.selector.is_empty() {
        return None;
    }
    target.dom_context.id = compact(&target.dom_context.id, 100);
    target.dom_context.classes = target
        .dom_context
        .classes
        .iter()
        .map(|value| compact(value, 100))
        .filter(|value| !value.is_empty())
        .take(16)
        .collect();
    target.dom_context.role = compact(&target.dom_context.role, 80);
    target.dom_context.aria_label = compact(&target.dom_context.aria_label, 180);
    target.dom_context.test_id = compact(&target.dom_context.test_id, 120);
    target.dom_context.name = compact(&target.dom_context.name, 120);
    target.dom_context.href = compact(&target.dom_context.href, 240);
    target.dom_context.html = compact(&target.dom_context.html, 1_200);
    target.style_selectors = target
        .style_selectors
        .iter()
        .map(|value| compact(value, 240))
        .filter(|value| !value.is_empty())
        .take(16)
        .collect();
    target.source_file = compact(&target.source_file, 500);
    target.source_line = target.source_line.filter(|value| *value <= 10_000_000);
    target.source_column = target.source_column.filter(|value| *value <= 1_000_000);
    Some(target)
}

fn inspection_navigation(
    url: &tauri::Url,
) -> Option<Result<(&'static str, Option<PreviewBrowserTarget>), String>> {
    if url.scheme() != BROWSER_INSPECTION_SCHEME {
        return None;
    }
    if url.as_str().len() > MAX_INSPECTION_URL_LEN || url.host_str() != Some("target") {
        return Some(Err("Invalid Browser inspection event.".into()));
    }
    let kind = match url.path().trim_matches('/') {
        "hover" => "inspect-hover",
        "select" => "inspect-select",
        "cancel" => return Some(Ok(("inspect-cancel", None))),
        _ => return Some(Err("Invalid Browser inspection event.".into())),
    };
    let payload = url
        .query_pairs()
        .find(|(key, _)| key == "payload")
        .map(|(_, value)| value.into_owned())
        .ok_or_else(|| "Browser inspection target is missing.".to_string());
    Some(payload.and_then(|payload| {
        serde_json::from_str::<PreviewBrowserTarget>(&payload)
            .map_err(|_| "Browser inspection target is invalid.".to_string())
            .and_then(|target| {
                sanitize_target(target)
                    .map(|target| (kind, Some(target)))
                    .ok_or_else(|| "Browser inspection target is invalid.".to_string())
            })
    }))
}

fn sanitize_feedback(mut feedback: PreviewBrowserFeedback) -> PreviewBrowserFeedback {
    feedback.selector = compact(&feedback.selector, 600);
    feedback.lines = feedback
        .lines
        .into_iter()
        .map(|line| PreviewBrowserFeedbackLine {
            kind: match line.kind.as_str() {
                "frontend" | "style" | "backend" | "likely" => line.kind,
                _ => "target".into(),
            },
            text: compact(&line.text, 260),
        })
        .filter(|line| !line.text.is_empty())
        .take(4)
        .collect();
    feedback
}

fn emit_browser_event(
    app: &AppHandle,
    label: impl Into<String>,
    kind: &'static str,
    url: Option<String>,
    title: Option<String>,
    target: Option<PreviewBrowserTarget>,
) {
    let _ = app.emit_to(
        "main",
        BROWSER_EVENT,
        PreviewBrowserEvent {
            label: label.into(),
            kind,
            url,
            title,
            target,
        },
    );
}

fn get_browser(app: &AppHandle, label: &str) -> Result<Webview, String> {
    validate_label(label)?;
    app.get_webview(label)
        .ok_or_else(|| "That browser tab is no longer available.".to_string())
}

fn validate_capture_rect(rect: DesignRect) -> Result<DesignRect, String> {
    let values = [rect.x, rect.y, rect.width, rect.height];
    if values.iter().any(|value| !value.is_finite())
        || rect.x < 0.0
        || rect.y < 0.0
        || rect.width < 1.0
        || rect.height < 1.0
        || rect.width > MAX_BROWSER_CAPTURE_SIDE
        || rect.height > MAX_BROWSER_CAPTURE_SIDE
        || rect.width * rect.height > MAX_BROWSER_CAPTURE_PIXELS
    {
        return Err("The selected Browser feature is outside the capture limit.".into());
    }
    Ok(rect)
}

fn capture_page_offset(metrics: &serde_json::Value) -> Result<(f64, f64), String> {
    let viewport = metrics
        .get("cssVisualViewport")
        .or_else(|| metrics.get("visualViewport"))
        .ok_or_else(|| "Browser viewport metrics are missing.".to_string())?;
    let page_x = viewport
        .get("pageX")
        .and_then(serde_json::Value::as_f64)
        .ok_or_else(|| "Browser horizontal viewport offset is missing.".to_string())?;
    let page_y = viewport
        .get("pageY")
        .and_then(serde_json::Value::as_f64)
        .ok_or_else(|| "Browser vertical viewport offset is missing.".to_string())?;
    if !page_x.is_finite()
        || !page_y.is_finite()
        || !(0.0..=10_000_000.0).contains(&page_x)
        || !(0.0..=10_000_000.0).contains(&page_y)
    {
        return Err("Browser viewport offsets are invalid.".into());
    }
    Ok((page_x, page_y))
}

#[cfg(windows)]
async fn call_browser_devtools_with_timeout(
    webview: &Webview,
    method: &str,
    parameters: serde_json::Value,
    timeout: std::time::Duration,
) -> Result<serde_json::Value, String> {
    use std::sync::{Arc, Mutex};
    use tokio::sync::oneshot;
    use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, CoTaskMemPWSTR};

    let (sender, receiver) = oneshot::channel::<Result<serde_json::Value, String>>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let callback_sender = sender.clone();
    let method = method.to_string();
    let parameters = parameters.to_string();
    webview
        .with_webview(move |platform| {
            let result = (|| -> Result<(), String> {
                let core = unsafe { platform.controller().CoreWebView2() }
                    .map_err(|error| format!("Could not access the Browser webview: {error}"))?;
                let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |status, result_json| {
                        let result = status
                            .map_err(|error| format!("Browser capture failed: {error}"))
                            .and_then(|_| {
                                serde_json::from_str::<serde_json::Value>(&result_json)
                                    .map_err(|error| format!("Invalid Browser capture: {error}"))
                            });
                        if let Ok(mut guard) = callback_sender.lock() {
                            if let Some(sender) = guard.take() {
                                let _ = sender.send(result);
                            }
                        }
                        Ok(())
                    },
                ));
                let method = CoTaskMemPWSTR::from(method.as_str());
                let parameters = CoTaskMemPWSTR::from(parameters.as_str());
                unsafe {
                    core.CallDevToolsProtocolMethod(
                        *method.as_ref().as_pcwstr(),
                        *parameters.as_ref().as_pcwstr(),
                        &handler,
                    )
                }
                .map_err(|error| format!("Could not start Browser capture: {error}"))?;
                Ok(())
            })();
            if let Err(error) = result {
                if let Ok(mut guard) = sender.lock() {
                    if let Some(sender) = guard.take() {
                        let _ = sender.send(Err(error));
                    }
                }
            }
        })
        .map_err(|error| format!("Could not schedule Browser capture: {error}"))?;

    tokio::time::timeout(timeout, receiver)
        .await
        .map_err(|_| "Browser screenshot timed out.".to_string())?
        .map_err(|_| "Browser screenshot was cancelled.".to_string())?
}

#[cfg(windows)]
async fn call_browser_devtools(
    webview: &Webview,
    method: &str,
    parameters: serde_json::Value,
) -> Result<serde_json::Value, String> {
    call_browser_devtools_with_timeout(
        webview,
        method,
        parameters,
        std::time::Duration::from_secs(3),
    )
    .await
}

#[cfg(windows)]
fn browser_history_action(webview: &Webview, forward: bool) -> Result<(), String> {
    use std::{sync::mpsc, time::Duration};

    let (sender, receiver) = mpsc::channel();
    webview
        .with_webview(move |platform| {
            let result = unsafe {
                platform.controller().CoreWebView2().and_then(|core| {
                    if forward {
                        core.GoForward()
                    } else {
                        core.GoBack()
                    }
                })
            }
            .map_err(|error| error.to_string());
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "The browser did not respond to the history request.".to_string())?
}

#[cfg(not(windows))]
fn browser_history_action(webview: &Webview, forward: bool) -> Result<(), String> {
    let script = if forward {
        "window.history.forward()"
    } else {
        "window.history.back()"
    };
    webview.eval(script).map_err(|error| error.to_string())
}

/// Create an embedded native browser surface over the preview viewport.
///
/// The caller check and URL allow-list are intentionally repeated for every
/// command. Remote pages receive no capability granting them these commands;
/// this guard is a second boundary if a future Tauri configuration changes.
#[tauri::command]
pub async fn create_preview_browser(
    caller: Webview,
    app: AppHandle,
    label: String,
    url: String,
    bounds: PreviewBrowserBounds,
    visible: bool,
) -> Result<(), String> {
    ensure_main_caller(&caller)?;
    validate_label(&label)?;
    let url = parse_browser_url(&url)?;
    let bounds = validate_bounds(bounds)?;

    if let Some(stale) = app.get_webview(&label) {
        stale.close().map_err(|error| error.to_string())?;
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "The main application window is unavailable.".to_string())?;

    let navigation_app = app.clone();
    let navigation_label = label.clone();
    let popup_app = app.clone();
    let popup_label = label.clone();
    let load_app = app.clone();
    let title_app = app.clone();

    let builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(url))
        .focused(false)
        .zoom_hotkeys_enabled(true)
        .devtools(cfg!(debug_assertions))
        .initialization_script(BROWSER_INSPECTION_SCRIPT)
        .initialization_script(BROWSER_COMPUTER_SCRIPT)
        .on_navigation(move |next| {
            if let Some(event) = inspection_navigation(next) {
                if let Ok((kind, target)) = event {
                    emit_browser_event(
                        &navigation_app,
                        navigation_label.clone(),
                        kind,
                        None,
                        None,
                        target,
                    );
                }
                return false;
            }
            if parse_browser_url(next.as_str()).is_ok() {
                true
            } else {
                emit_browser_event(
                    &navigation_app,
                    navigation_label.clone(),
                    "blocked",
                    Some(next.to_string()),
                    None,
                    None,
                );
                false
            }
        })
        .on_new_window(move |next, _features| {
            if parse_browser_url(next.as_str()).is_ok() {
                emit_browser_event(
                    &popup_app,
                    popup_label.clone(),
                    "popup",
                    Some(next.to_string()),
                    None,
                    None,
                );
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |webview, payload| {
            let kind = match payload.event() {
                PageLoadEvent::Started => "loading",
                PageLoadEvent::Finished => "ready",
            };
            emit_browser_event(
                &load_app,
                webview.label().to_string(),
                kind,
                Some(payload.url().to_string()),
                None,
                None,
            );
        })
        .on_document_title_changed(move |webview, title| {
            emit_browser_event(
                &title_app,
                webview.label().to_string(),
                "title",
                webview.url().ok().map(|value| value.to_string()),
                Some(title),
                None,
            );
        });

    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|error| error.to_string())?;
    if !visible {
        webview.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_preview_browser_bounds(
    caller: Webview,
    app: AppHandle,
    label: String,
    bounds: PreviewBrowserBounds,
    visible: bool,
) -> Result<(), String> {
    ensure_main_caller(&caller)?;
    let bounds = validate_bounds(bounds)?;
    let webview = get_browser(&app, &label)?;
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|error| error.to_string())?;
    webview
        .set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(|error| error.to_string())?;
    if visible {
        webview.show().map_err(|error| error.to_string())?;
    } else {
        webview.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_preview_browser_inspection(
    caller: Webview,
    app: AppHandle,
    label: String,
    mode: String,
    feedback: Option<PreviewBrowserFeedback>,
) -> Result<(), String> {
    ensure_main_caller(&caller)?;
    let mode = match mode.as_str() {
        "design" | "source" => mode,
        "off" => "off".to_string(),
        _ => return Err("Unsupported Browser inspection mode.".into()),
    };
    let feedback = feedback.map(sanitize_feedback);
    let mode_json = serde_json::to_string(&mode).map_err(|error| error.to_string())?;
    let feedback_json = serde_json::to_string(&feedback).map_err(|error| error.to_string())?;
    let script = format!(
        r#"(() => {{
  const bridge = window.__hormaPreviewInspection;
  if (!bridge) return;
  bridge.setMode({mode_json});
  bridge.setFeedback({feedback_json});
}})()"#
    );
    get_browser(&app, &label)?
        .eval(script)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn set_preview_browser_inspection_chrome(
    caller: Webview,
    app: AppHandle,
    label: String,
    visible: bool,
) -> Result<(), String> {
    ensure_main_caller(&caller)?;
    let script = format!(
        "window.__hormaPreviewInspection?.setChromeVisible({})",
        if visible { "true" } else { "false" }
    );
    get_browser(&app, &label)?
        .eval(script)
        .map_err(|error| error.to_string())
}

/// Capture only the user-selected rectangle from an isolated Browser tab.
/// The caller cannot choose another window, expand beyond the visible page,
/// or invoke arbitrary DevTools methods.
#[tauri::command]
pub async fn capture_preview_browser_selection(
    caller: Webview,
    app: AppHandle,
    label: String,
    region: DesignRect,
) -> Result<String, String> {
    ensure_main_caller(&caller)?;
    let region = validate_capture_rect(region)?;
    let webview = get_browser(&app, &label)?;

    #[cfg(windows)]
    {
        // DOM inspection reports getBoundingClientRect() coordinates relative
        // to the visible viewport. CDP screenshot clips use document offsets,
        // so add the live visual-viewport scroll immediately before capture.
        let metrics =
            call_browser_devtools(&webview, "Page.getLayoutMetrics", serde_json::json!({})).await?;
        let (page_x, page_y) = capture_page_offset(&metrics)?;
        let response = call_browser_devtools(
            &webview,
            "Page.captureScreenshot",
            serde_json::json!({
                "format": "png",
                "fromSurface": true,
                "captureBeyondViewport": false,
                "clip": {
                    "x": page_x + region.x,
                    "y": page_y + region.y,
                    "width": region.width,
                    "height": region.height,
                    "scale": 1
                }
            }),
        )
        .await?;
        response
            .get("data")
            .and_then(serde_json::Value::as_str)
            .filter(|data| !data.is_empty())
            .map(str::to_string)
            .ok_or_else(|| "Browser screenshot data is missing.".to_string())
    }

    #[cfg(not(windows))]
    {
        let _ = (webview, region);
        Err("Browser feature screenshots are currently available on Windows only.".into())
    }
}

#[tauri::command]
pub async fn navigate_preview_browser(
    caller: Webview,
    app: AppHandle,
    label: String,
    url: String,
) -> Result<(), String> {
    ensure_main_caller(&caller)?;
    let url = parse_browser_url(&url)?;
    get_browser(&app, &label)?
        .navigate(url)
        .map_err(|error| error.to_string())
}

/// Execute a bounded Preview Computer Use request inside one isolated Browser
/// child WebView. Only the trusted main WebView can call this command.
#[tauri::command]
pub async fn preview_browser_computer(
    caller: Webview,
    app: AppHandle,
    label: String,
    operation: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    ensure_main_caller(&caller)?;
    if !matches!(operation.as_str(), "observe" | "actions" | "stop") {
        return Err("Unsupported Preview Computer Use operation.".into());
    }
    let webview = get_browser(&app, &label)?;

    #[cfg(windows)]
    {
        let operation = serde_json::to_string(&operation).map_err(|error| error.to_string())?;
        let args = serde_json::to_string(&args).map_err(|error| error.to_string())?;
        let expression = format!(
            "window.__hormaPreviewComputerUse ? window.__hormaPreviewComputerUse.handle({operation}, {args}) : Promise.reject(new Error('Preview Browser controller is not ready.'))"
        );
        let response = call_browser_devtools_with_timeout(
            &webview,
            "Runtime.evaluate",
            serde_json::json!({
                "expression": expression,
                "awaitPromise": true,
                "returnByValue": true,
                "userGesture": true,
            }),
            std::time::Duration::from_secs(70),
        )
        .await?;
        if let Some(exception) = response.get("exceptionDetails") {
            let message = exception
                .pointer("/exception/description")
                .or_else(|| exception.get("text"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Preview Browser action failed.");
            return Err(message.chars().take(1_000).collect());
        }
        response
            .pointer("/result/value")
            .cloned()
            .ok_or_else(|| "Preview Browser action returned no result.".to_string())
    }

    #[cfg(not(windows))]
    {
        let _ = (webview, operation, args);
        Err("Preview Browser Computer Use currently requires the Windows WebView2 runtime.".into())
    }
}

#[tauri::command]
pub async fn preview_browser_action(
    caller: Webview,
    app: AppHandle,
    label: String,
    action: String,
) -> Result<(), String> {
    ensure_main_caller(&caller)?;
    let webview = get_browser(&app, &label)?;
    match action.as_str() {
        "back" => browser_history_action(&webview, false),
        "forward" => browser_history_action(&webview, true),
        "reload" => webview.reload().map_err(|error| error.to_string()),
        "focus" => webview.set_focus().map_err(|error| error.to_string()),
        _ => Err("Unsupported browser action.".into()),
    }
}

#[tauri::command]
pub async fn close_preview_browser(
    caller: Webview,
    app: AppHandle,
    label: String,
) -> Result<(), String> {
    ensure_main_caller(&caller)?;
    match get_browser(&app, &label) {
        Ok(webview) => webview.close().map_err(|error| error.to_string()),
        Err(error) if error.contains("no longer available") => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_urls_allow_only_credential_free_http_and_https() {
        assert!(parse_browser_url("https://www.google.com/search?q=hormachuelos").is_ok());
        assert!(parse_browser_url("http://localhost:3000").is_ok());
        assert!(parse_browser_url("javascript:alert(1)").is_err());
        assert!(parse_browser_url("file:///C:/Windows/System32/calc.exe").is_err());
        assert!(parse_browser_url("data:text/html,unsafe").is_err());
        assert!(parse_browser_url("https://user:secret@example.com").is_err());
    }

    #[test]
    fn browser_labels_and_bounds_are_bounded() {
        assert!(validate_label("preview-browser-42").is_ok());
        assert!(validate_label("main").is_err());
        assert!(validate_label("preview-browser-../main").is_err());
        assert!(validate_bounds(PreviewBrowserBounds {
            x: 200.0,
            y: 100.0,
            width: 900.0,
            height: 600.0,
        })
        .is_ok());
        assert!(validate_bounds(PreviewBrowserBounds {
            x: -1.0,
            y: 0.0,
            width: 900.0,
            height: 600.0,
        })
        .is_err());
        assert!(validate_capture_rect(DesignRect {
            x: 84.0,
            y: 92.0,
            width: 128.0,
            height: 52.0,
        })
        .is_ok());
        assert!(validate_capture_rect(DesignRect {
            x: 0.0,
            y: 0.0,
            width: 5_000.0,
            height: 52.0,
        })
        .is_err());
        assert_eq!(
            capture_page_offset(&serde_json::json!({
                "cssVisualViewport": { "pageX": 12.5, "pageY": 845.0 }
            }))
            .unwrap(),
            (12.5, 845.0)
        );
        assert!(capture_page_offset(&serde_json::json!({
            "cssVisualViewport": { "pageX": -1.0, "pageY": 0.0 }
        }))
        .is_err());
    }

    #[test]
    fn browser_inspection_navigation_is_bounded_and_typed() {
        let payload = serde_json::json!({
            "tag": "BUTTON",
            "text": "  Publish   now  ",
            "selector": "main > button.publish",
            "domContext": {
                "id": "publish",
                "classes": ["publish", "primary"],
                "role": "button",
                "ariaLabel": "Publish",
                "testId": "publish-action",
                "name": "",
                "href": "/api/publish",
                "html": "<button class=\"publish primary\">Publish now</button>"
            },
            "rect": { "x": 84.0, "y": 92.0, "width": 128.0, "height": 52.0 },
            "styleSelectors": ["button.publish", ".primary"],
            "sourceFile": "src/components/PublishButton.tsx",
            "sourceLine": 42,
            "sourceColumn": 7
        })
        .to_string();
        let mut url = tauri::Url::parse("horma-preview-inspect://target/select").unwrap();
        url.query_pairs_mut().append_pair("payload", &payload);

        let (kind, target) = inspection_navigation(&url).unwrap().unwrap();
        let target = target.unwrap();
        assert_eq!(kind, "inspect-select");
        assert_eq!(target.tag, "button");
        assert_eq!(target.text, "Publish now");
        assert_eq!(target.dom_context.test_id, "publish-action");
        assert_eq!(target.source_line, Some(42));

        let regular = tauri::Url::parse("https://example.com").unwrap();
        assert!(inspection_navigation(&regular).is_none());
        let cancel = tauri::Url::parse("horma-preview-inspect://target/cancel").unwrap();
        assert_eq!(
            inspection_navigation(&cancel).unwrap().unwrap().0,
            "inspect-cancel"
        );
    }
}
