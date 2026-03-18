const { useState, useEffect, useCallback, useRef, useMemo } = React;

/* ═══════════════════════════════════════════════════════════
   LOCAL SERVER SYNC LAYER
   Connects to the Node.js server on the same LAN via WebSocket.
   No internet required — works entirely on local network.

   Deduplication is handled server-side (UUID + content hash).
   Client queues changes locally when the server is unreachable
   and flushes them automatically on reconnect.
   ═══════════════════════════════════════════════════════════ */

const SNAPSHOT_KEY = 'fnd_local_snapshot';
const QUEUE_KEY    = 'fnd_sync_queue';

function saveLocalSnapshot(data) {
  try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({...data, _savedAt: new Date().toISOString()})); } catch(e) {}
}
function loadLocalSnapshot() {
  try { return JSON.parse(localStorage.getItem(SNAPSHOT_KEY)||'null'); } catch { return null; }
}

class ServerSync {
  constructor({ onData, onStatus, onDevices }) {
    this.onData    = onData;
    this.onStatus  = onStatus;
    this.onDevices = onDevices;
    this.deviceId   = this._getOrCreateDeviceId();
    this.deviceName = localStorage.getItem('fnd_device_name') || '';
    this.ws         = null;
    this._reconnectTimer = null;
    this.queue      = this._loadQueue();
    this._connect();
  }

  _getOrCreateDeviceId() {
    let id = localStorage.getItem('fnd_device_id');
    if (!id) {
      id = 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      localStorage.setItem('fnd_device_id', id);
    }
    return id;
  }

  _loadQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
  }
  _saveQueue() {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(this.queue)); } catch {}
  }
  _clearQueue() {
    this.queue = [];
    localStorage.removeItem(QUEUE_KEY);
  }

  _connect() {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url   = `${proto}//${location.host}`;
    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      this.onStatus('offline');
      this._scheduleReconnect(5000);
      return;
    }

    this.ws.onopen = () => {
      this.onStatus('connecting');
      this.ws.send(JSON.stringify({
        type:       'register',
        deviceId:   this.deviceId,
        deviceName: this.deviceName || this.deviceId,
      }));
    };

    this.ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'full_sync') {
        this.onData(msg.data, 'full');
        this.onStatus('synced');
        this._flushQueue();
      }
      if (msg.type === 'sync_batch') {
        this.onData(msg.changes, 'patch');
      }
      if (msg.type === 'sync_ack') {
        const acked = new Set(msg.accepted);
        this.queue = this.queue.filter(c => !acked.has(c.id));
        this._saveQueue();
        this.onStatus('synced');
      }
      if (msg.type === 'delete') {
        this.onData([{ id: msg.id, _delete: true }], 'patch');
      }
      if (msg.type === 'devices') {
        this.onDevices(msg.devices);
      }
    };

    this.ws.onclose = () => {
      this.onStatus('offline');
      this._scheduleReconnect(3000);
    };

    this.ws.onerror = () => {
      this.onStatus('offline');
      try { this.ws.close(); } catch {}
    };
  }

  _scheduleReconnect(ms) {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this._connect(), ms);
  }

  /** Push a change to the server. Queues locally if offline. */
  push(change) {
    change._deviceId  = this.deviceId;
    change._updatedAt = new Date().toISOString();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'sync_batch', changes: [change], deviceId: this.deviceId }));
      this.onStatus('saving');
    } else {
      if (!this.queue.some(c => c.id === change.id)) {
        this.queue.push(change);
        this._saveQueue();
      }
      this.onStatus('offline');
    }
  }

  /** Notify server to soft-delete an entry; also broadcasts to other clients. */
  pushDelete(id) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'delete', id, deviceId: this.deviceId }));
    }
  }

  _flushQueue() {
    if (this.queue.length === 0 || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'sync_batch', changes: this.queue, deviceId: this.deviceId }));
  }

  /** Force a full re-sync from the server via REST (fallback when WS is down). */
  async fetchFull() {
    try {
      this.onStatus('saving');
      const r = await fetch('/api/data');
      if (!r.ok) throw new Error('server error');
      const { data } = await r.json();
      this.onData(data, 'full');
      this.onStatus('synced');
    } catch {
      this.onStatus('offline');
    }
  }

  get connected() { return this.ws?.readyState === WebSocket.OPEN; }

  setDeviceName(name) {
    this.deviceName = name;
    localStorage.setItem('fnd_device_name', name);
  }
}

/* ═══════════════════════════════════════════════════════════
   CONSTANTS & TOKENS
   ═══════════════════════════════════════════════════════════ */
const C = { bg:"#030712", surface:"#0f172a", card:"#111827", border:"#1e293b", muted:"#6b7280", text:"#f1f5f9", sub:"#94a3b8", green:"#6EE7B7", greenDk:"#065f46", amber:"#fbbf24", amberDk:"#92400e", purple:"#a5b4fc", teal:"#86efac", red:"#f87171" };
const IS = { width:"100%", background:"#1e293b", border:`1px solid ${C.border}`, borderRadius:8, color:C.text, padding:"10px 12px", fontSize:14, outline:"none", boxSizing:"border-box", fontFamily:"inherit" };
const LS = { display:"block", color:C.sub, fontSize:11, marginBottom:4, fontWeight:700, letterSpacing:"0.07em", textTransform:"uppercase" };

// Check-in wizard constants
const SYMPTOMS = ["Seizures / Episodes","Tremors","Brain Fog","Fatigue","Headache / Migraine","Dizziness","Tingling / Numbness","Vision Changes","Speech Difficulties","Weakness","Pain","Nausea","Anxiety / Mood"];
const EMOTIONS = ["Grateful","Hopeful","Calm","Tired","Frustrated","Anxious","Sad","Overwhelmed","Proud","Loved","Isolated","Content"];
const SLEEP_QUALITY = ["Poor","Fair","Good","Great"];
const MOODS = [{ emoji:"😄", label:"Great", score:5 },{ emoji:"🙂", label:"Good", score:4 },{ emoji:"😐", label:"Okay", score:3 },{ emoji:"😞", label:"Low", score:2 },{ emoji:"😣", label:"Awful", score:1 }];
const FLARE_PRESET = { mood:1, sleep:4, sleepQuality:"Poor", symptoms:Object.fromEntries(SYMPTOMS.map(s=>[s,3])), emotions:["Overwhelmed","Frustrated","Tired"], notes:"Flare day — auto-filled" };

/* ═══════════════════════════════════════════════════════════
   UTILITIES
   ═══════════════════════════════════════════════════════════ */
const fmtTime  = iso => new Date(iso).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
const fmtDate  = iso => new Date(iso).toLocaleDateString([],{month:"short",day:"numeric"});
const fmtFull  = iso => `${fmtDate(iso)} ${fmtTime(iso)}`;
const nowISO   = ()  => new Date().toISOString();
const localISO = (d=new Date()) => { const off=d.getTimezoneOffset()*60000; return new Date(d-off).toISOString().slice(0,16); };
const uid = () => (typeof crypto!=='undefined'&&crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36)+Math.random().toString(36).slice(2);
const toYMD    = d   => { const p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; };

function startOf(unit,d=new Date()){const x=new Date(d);x.setHours(0,0,0,0);if(unit==="week")x.setDate(x.getDate()-x.getDay());if(unit==="month")x.setDate(1);return x;}
function filterFrom(items,start){return items.filter(e=>new Date(e.timestamp)>=start);}
function loggedBefore(items,ts,hours=4){const t=new Date(ts),cut=new Date(t-hours*3600000);return items.filter(e=>{const d=new Date(e.timestamp);return d>=cut&&d<=t;});}
function useDesktop(){const[v,setV]=useState(()=>window.innerWidth>=768);useEffect(()=>{const fn=()=>setV(window.innerWidth>=768);window.addEventListener('resize',fn);return()=>window.removeEventListener('resize',fn);},[]);return v;}
function useChartFont(){const[w,setW]=useState(()=>window.innerWidth);useEffect(()=>{const fn=()=>setW(window.innerWidth);window.addEventListener('resize',fn);return()=>window.removeEventListener('resize',fn);},[]);const cf=(base)=>Math.round(Math.max(base,Math.min(base*2,base+(w-320)/120)));return{axisLabel:cf(9),barLabel:cf(10),chartSub:cf(9),legend:cf(10),annotation:cf(11)};}
function mergeByKey(a, b, keyFn){ const seen=new Set(a.map(keyFn)); return [...a,...b.filter(x=>x&&!seen.has(keyFn(x)))]; }
function toCSV(rows,cols){const esc=v=>'"'+String(v??'').replace(/"/g,'""')+'"';return[cols.map(esc).join(','),...rows.map(r=>cols.map(c=>esc(r[c])).join(','))].join('\n');}
function downloadFile(content,name,type){
  try{
    // Use share API if available (Android PWA) — more reliable than anchor click
    if(navigator.share&&navigator.canShare){
      const file=new File([content],name,{type});
      if(navigator.canShare({files:[file]})){
        navigator.share({files:[file],title:name}).catch(()=>{});
        return;
      }
    }
  }catch(e){}
  // Fallback: anchor click
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([content],{type}));
  a.download=name;
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);document.body.removeChild(a);},1000);
}

/* ═══════════════════════════════════════════════════════════
   PRIMITIVES
   ═══════════════════════════════════════════════════════════ */
function Modal({title,subtitle,onClose,children}){
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.82)",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center",padding:12}}>
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:18,width:"100%",maxWidth:"min(560px,94vw)",padding:"clamp(16px,3vw,28px)",maxHeight:"92vh",overflowY:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:subtitle?4:18}}>
          <div><h2 style={{color:C.text,fontSize:17,fontWeight:700,margin:0}}>{title}</h2>{subtitle&&<p style={{color:C.muted,fontSize:12,margin:"3px 0 0"}}>{subtitle}</p>}</div>
          <button onClick={onClose} style={{background:"none",border:"none",color:C.muted,fontSize:22,cursor:"pointer",lineHeight:1}}>✕</button>
        </div>
        {subtitle&&<div style={{marginBottom:14}}/>}
        {children}
      </div>
    </div>
  );
}
function FInput({label,...p}){return <div style={{marginBottom:13}}>{label&&<label style={LS}>{label}</label>}<input style={IS} {...p}/></div>;}
function FSelect({label,children,...p}){return <div style={{marginBottom:13}}>{label&&<label style={LS}>{label}</label>}<select style={IS} {...p}>{children}</select></div>;}
function FTextarea({label,...p}){return <div style={{marginBottom:13}}>{label&&<label style={LS}>{label}</label>}<textarea style={{...IS,minHeight:68,resize:"vertical"}} {...p}/></div>;}
function Btn({children,onClick,variant="primary",small,fullWidth,danger}){
  let bg=C.greenDk,color=C.green,border=`1px solid #059669`;
  if(variant==="secondary"){bg="#1e293b";color=C.sub;border=`1px solid ${C.border}`;}
  if(danger){bg="#7f1d1d";color=C.red;border="1px solid #991b1b";}
  return <button onClick={onClick} onMouseOver={e=>e.currentTarget.style.opacity=".8"} onMouseOut={e=>e.currentTarget.style.opacity="1"} style={{background:bg,color,border,borderRadius:8,cursor:"pointer",padding:small?"6px 12px":"10px 18px",fontSize:small?12:14,fontWeight:600,width:fullWidth?"100%":"auto",transition:"opacity .15s",whiteSpace:"nowrap"}}>{children}</button>;
}

/* ═══════════════════════════════════════════════════════════
   CHARTS
   ═══════════════════════════════════════════════════════════ */
function BarChart({data,color=C.green}){
  const cf=useChartFont();
  const entries=Object.entries(data);
  if(!entries.length)return <p style={{color:C.muted,fontSize:13,textAlign:"center",padding:"16px 0"}}>No events in this period</p>;
  const max=Math.max(1,...entries.map(([,v])=>v));
  return(
    <div>
      <div style={{display:"flex",alignItems:"flex-end",gap:4,height:80,marginBottom:6}}>
        {entries.map(([k,v])=>(
          <div key={k} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
            <span style={{fontSize:10,color:C.sub}}>{v||""}</span>
            <div style={{width:"100%",background:color,borderRadius:4,height:`${(v/max)*64}px`,minHeight:v>0?4:0,transition:"height .4s"}}/>
          </div>
        ))}
      </div>
      <div style={{display:"flex",gap:4}}>
        {entries.map(([k])=><div key={k} style={{flex:1,textAlign:"center",fontSize:cf.axisLabel,color:C.muted,overflow:"hidden",whiteSpace:"nowrap"}}>{k.split(" ")[0]}</div>)}
      </div>
    </div>
  );
}

function SvgTrendLine({values,color=C.green,height=60}){
  if(!values||!values.length)return null;
  const max=Math.max(1,...values);
  const w=300,h=height,pad=6;
  const pts=values.map((v,i)=>`${pad+(i/(values.length-1||1))*(w-2*pad)},${h-pad-(v/max)*(h-2*pad)}`).join(' ');
  return(
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{display:"block"}}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      {values.map((v,i)=>{
        const x=pad+(i/(values.length-1||1))*(w-2*pad);
        const y=h-pad-(v/max)*(h-2*pad);
        return v>0?<circle key={i} cx={x} cy={y} r="3" fill={color}/>:null;
      })}
    </svg>
  );
}

/* ═══════════════════════════════════════════════════════════
   DATETIME PICKER
   ═══════════════════════════════════════════════════════════ */
function DateTimePicker({value,onChange}){
  const parts=value?value.split("T"):["",""];
  const dateVal=parts[0]||"";
  const timeVal=parts[1]||"";
  const today=toYMD(new Date());
  const initH=timeVal?parseInt(timeVal.split(":")[0]):new Date().getHours();
  const initM=timeVal?parseInt(timeVal.split(":")[1]):0;
  const[step,setStep]=useState("hour");
  const[selH,setSelH]=useState(initH);
  const[selM,setSelM]=useState(initM);
  // Sync slider state if the value prop changes externally (e.g. quick-time buttons)
  useEffect(()=>{
    const tv=value?value.split("T")[1]||"":"";
    if(tv){setSelH(parseInt(tv.split(":")[0]));setSelM(parseInt(tv.split(":")[1]));}
  },[value]);
  const pad=n=>String(n).padStart(2,"0");
  const fmt12=h=>({h12:h%12||12,ap:h>=12?"PM":"AM"});
  const{h12,ap}=fmt12(selH);
  const setDate=v=>onChange(`${v}T${pad(selH)}:${pad(selM)}`);
  const commitTime=(h,m)=>onChange(`${dateVal||today}T${pad(h)}:${pad(m)}`);
  const onHourChange=h=>{setSelH(h);commitTime(h,selM);};
  const onMinChange=m=>{setSelM(m);commitTime(selH,m);};
  const readableDate=dateVal?new Date(dateVal+"T00:00:00").toLocaleDateString([],{weekday:"short",month:"short",day:"numeric",year:"numeric"}):"Pick a date";
  const btnStyle=active=>({flex:1,padding:"11px 0",borderRadius:10,cursor:"pointer",fontSize:13,fontWeight:700,border:`1px solid ${active?C.green:C.border}`,background:active?C.greenDk:"#1e293b",color:active?C.green:C.muted,transition:"all 0.15s"});
  return(
    <div style={{marginBottom:16}}>
      <div style={{marginBottom:14}}>
        <div style={{color:C.muted,fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:5}}>{readableDate}</div>
        <input type="date" value={dateVal} max={today} onChange={e=>setDate(e.target.value)} style={{background:"#1e293b",border:`1px solid ${C.border}`,borderRadius:10,color:C.text,padding:"12px 14px",fontSize:15,outline:"none",width:"100%",boxSizing:"border-box",colorScheme:"dark",display:"block"}}/>
      </div>
      <div style={{textAlign:"center",marginBottom:12,padding:"12px",background:"#060d12",borderRadius:12,border:`1px solid ${C.border}`}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:4}}>
          <button onClick={()=>setStep("hour")} style={{background:"none",border:"none",cursor:"pointer",padding:0}}>
            <span style={{fontSize:42,fontWeight:800,fontVariantNumeric:"tabular-nums",letterSpacing:-1,color:step==="hour"?C.green:C.sub}}>{pad(h12)}</span>
          </button>
          <span style={{fontSize:34,fontWeight:700,color:"#2d5040",padding:"0 2px"}}>:</span>
          <button onClick={()=>setStep("minute")} style={{background:"none",border:"none",cursor:"pointer",padding:0}}>
            <span style={{fontSize:42,fontWeight:800,fontVariantNumeric:"tabular-nums",letterSpacing:-1,color:step==="minute"?C.green:C.sub}}>{pad(selM)}</span>
          </button>
          <span style={{fontSize:18,fontWeight:700,color:C.muted,marginLeft:4}}>{ap}</span>
        </div>
      </div>
      <div style={{display:"flex",gap:8,marginBottom:12}}>
        <button style={btnStyle(step==="hour")} onClick={()=>setStep("hour")}>Set Hour</button>
        <button style={btnStyle(step==="minute")} onClick={()=>setStep("minute")}>Set Minute</button>
      </div>
      {step==="hour"&&(
        <div>
          <input type="range" min={0} max={23} value={selH} onChange={e=>onHourChange(+e.target.value)} style={{width:"100%",accentColor:C.green}}/>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:C.muted,marginTop:4}}>
            <span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>11pm</span>
          </div>
        </div>
      )}
      {step==="minute"&&(
        <div>
          <input type="range" min={0} max={59} value={selM} onChange={e=>onMinChange(+e.target.value)} style={{width:"100%",accentColor:C.green}}/>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:C.muted,marginTop:4}}>
            <span>:00</span><span>:15</span><span>:30</span><span>:45</span><span>:59</span>
          </div>
        </div>
      )}
      <div style={{display:"flex",gap:6,marginTop:12,flexWrap:"wrap"}}>
        {[["Now",0],["5m ago",-5],["15m ago",-15],["30m ago",-30],["1h ago",-60]].map(([lbl,off])=>(
          <button key={lbl} onClick={()=>{const d=new Date();d.setMinutes(d.getMinutes()+off);const s=localISO(d);onChange(s);const p=s.split("T")[1];setSelH(parseInt(p));setSelM(parseInt(p.split(":")[1]));}}
            style={{flex:1,background:"#1e293b",border:`1px solid ${C.border}`,borderRadius:6,color:C.sub,fontSize:10,fontWeight:600,padding:"5px 0",cursor:"pointer",minWidth:50}}>
            {lbl}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   SEIZURE / EVENT FORM
   ═══════════════════════════════════════════════════════════ */
function SeizureForm({initial={},onSave,onCancel,saveLabel="Save",showTs=true}){
  const[form,setForm]=useState({notes:"",timestamp:initial.timestamp?localISO(new Date(initial.timestamp)):localISO(),...initial});
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  return(
    <div>
      {showTs&&<div style={{marginBottom:16}}>
        <label style={LS}>Date & Time</label>
        <DateTimePicker value={form.timestamp} onChange={v=>set("timestamp",v)}/>
      </div>}
      <FTextarea label="Notes (triggers, posture, activity, post-ictal state…)" placeholder="Optional — add context about this event" value={form.notes} onChange={e=>set("notes",e.target.value)}/>
      <div style={{display:"flex",gap:10,marginTop:6}}>
        <Btn onClick={onCancel} variant="secondary" fullWidth>Cancel</Btn>
        <Btn onClick={()=>onSave({...form,timestamp:new Date(form.timestamp).toISOString()})} fullWidth>{saveLabel}</Btn>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   CHECK-IN WIZARD
   ═══════════════════════════════════════════════════════════ */
function CheckInWizard({userInfo,onSave,onCancel}){
  const[step,setStep]=useState(0);
  const[data,setData]=useState({mood:null,symptoms:{},sleep:7,sleepQuality:null,emotions:[],notes:""});
  const[saving,setSaving]=useState(false);
  const steps=["Mood","Symptoms","Sleep","Feelings"];
  function flareDay(){setData({...FLARE_PRESET});setStep(3);}
  function toggleSym(name,val){setData(p=>({...p,symptoms:{...p.symptoms,[name]:p.symptoms[name]===val?0:val}}));}
  function toggleEmotion(e){setData(p=>({...p,emotions:p.emotions.includes(e)?p.emotions.filter(x=>x!==e):[...p.emotions,e]}));}
  async function save(){
    setSaving(true);
    await onSave({id:uid(),timestamp:nowISO(),userName:userInfo?.name||"",userEmail:userInfo?.email||"",...data});
    setSaving(false);
  }
  return(
    <Modal title="Daily Check-in" subtitle={`Step ${step+1} of 4 — ${steps[step]}`} onClose={onCancel}>
      {/* Flare banner */}
      <div onClick={flareDay} style={{background:"linear-gradient(120deg,#2a0808,#450a0a)",border:"1px solid #7f1d1d",borderRadius:12,padding:"12px 14px",display:"flex",alignItems:"center",gap:10,cursor:"pointer",marginBottom:16}}>
        <span style={{fontSize:22}}>🔥</span>
        <div style={{flex:1}}><div style={{fontSize:13,fontWeight:700,color:C.red}}>Flare Day</div><div style={{fontSize:11,color:"#fca5a5",marginTop:1}}>One tap — fills all severe symptoms</div></div>
        <span style={{color:C.red,fontSize:16}}>›</span>
      </div>
      {/* Steps progress */}
      <div style={{display:"flex",gap:5,marginBottom:20}}>
        {steps.map((s,i)=><div key={s} style={{flex:1,height:3,borderRadius:2,background:i<step?"#34d399":i===step?"#38bdf8":C.border,transition:"background .3s"}}/>)}
      </div>
      {/* Step 0 — Mood */}
      {step===0&&(
        <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8,marginBottom:16}}>
          {MOODS.map(m=>(
            <div key={m.score} onClick={()=>setData(p=>({...p,mood:m.score}))} style={{aspectRatio:"1",borderRadius:12,border:`2px solid ${data.mood===m.score?"#38bdf8":C.border}`,background:data.mood===m.score?"rgba(56,189,248,.1)":C.surface,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:3,cursor:"pointer"}}>
              <span style={{fontSize:22}}>{m.emoji}</span><span style={{fontSize:10,color:C.muted,fontWeight:600}}>{m.label}</span>
            </div>
          ))}
        </div>
      )}
      {/* Step 1 — Symptoms */}
      {step===1&&(
        <div style={{maxHeight:360,overflowY:"auto"}}>
          {SYMPTOMS.map(s=>(
            <div key={s} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,padding:"8px 0",borderBottom:`1px solid ${C.border}`}}>
              <span style={{fontSize:13,fontWeight:500,flex:1}}>{s}</span>
              <div style={{display:"flex",gap:4}}>
                {[1,2,3].map(n=>{
                  const colors=["","#34d399","#fbbf24","#f87171"];
                  const bgs=["","#042512","#1c1206","#2a0505"];
                  const sel=data.symptoms[s]===n;
                  return <button key={n} onClick={()=>toggleSym(s,n)} style={{width:34,height:34,borderRadius:8,border:`1.5px solid ${sel?colors[n]:C.border}`,background:sel?bgs[n]:"#1e293b",color:sel?colors[n]:C.muted,fontSize:12,fontWeight:700,cursor:"pointer"}}>{n}</button>;
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      {/* Step 2 — Sleep */}
      {step===2&&(
        <div>
          <div style={{textAlign:"center",fontSize:48,fontWeight:800,color:"#38bdf8",fontVariantNumeric:"tabular-nums",marginBottom:8}}>{data.sleep}h</div>
          <div style={{display:"flex",gap:12,marginBottom:16}}>
            <button onClick={()=>setData(p=>({...p,sleep:Math.max(0,p.sleep-.5)}))} style={{flex:1,height:52,borderRadius:12,border:`1.5px solid ${C.border}`,background:"#1e293b",color:C.text,fontSize:26,cursor:"pointer"}}>−</button>
            <button onClick={()=>setData(p=>({...p,sleep:Math.min(14,p.sleep+.5)}))} style={{flex:1,height:52,borderRadius:12,border:`1.5px solid ${C.border}`,background:"#1e293b",color:C.text,fontSize:26,cursor:"pointer"}}>+</button>
          </div>
          <label style={LS}>Sleep quality</label>
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
            {SLEEP_QUALITY.map(q=>(
              <button key={q} onClick={()=>setData(p=>({...p,sleepQuality:q}))} style={{padding:"10px 4px",borderRadius:10,border:`1.5px solid ${data.sleepQuality===q?"#818cf8":C.border}`,background:data.sleepQuality===q?"rgba(129,140,248,.12)":"#1e293b",color:data.sleepQuality===q?"#818cf8":C.muted,fontSize:12,fontWeight:700,cursor:"pointer"}}>{q}</button>
            ))}
          </div>
        </div>
      )}
      {/* Step 3 — Emotions + notes */}
      {step===3&&(
        <div>
          <label style={LS}>How are you feeling emotionally?</label>
          <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:16}}>
            {EMOTIONS.map(e=>(
              <div key={e} onClick={()=>toggleEmotion(e)} style={{padding:"7px 14px",borderRadius:20,border:`1.5px solid ${data.emotions.includes(e)?"#818cf8":C.border}`,background:data.emotions.includes(e)?"rgba(129,140,248,.12)":"#1e293b",color:data.emotions.includes(e)?"#818cf8":C.muted,fontSize:13,fontWeight:500,cursor:"pointer"}}>{e}</div>
            ))}
          </div>
          <FTextarea label="Notes (optional)" placeholder="Anything else to capture…" value={data.notes} onChange={e=>setData(p=>({...p,notes:e.target.value}))}/>
        </div>
      )}
      {/* Navigation */}
      <div style={{display:"flex",gap:10,marginTop:16}}>
        {step>0&&<Btn onClick={()=>setStep(p=>p-1)} variant="secondary" fullWidth>← Back</Btn>}
        {step<3?<Btn onClick={()=>setStep(p=>p+1)} fullWidth disabled={step===0&&data.mood===null}>Next →</Btn>
          :<Btn onClick={save} fullWidth>{saving?"Saving…":"✓ Save Check-in"}</Btn>}
      </div>
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════════════
   LIBRARY MODAL
   ═══════════════════════════════════════════════════════════ */
function LibraryModal({type,library,onSave,onClose}){
  const isMed=type==="med";
  const[items,setItems]=useState((library||[]).filter(Boolean));
  const[name,setName]=useState("");
  const[detail,setDetail]=useState("");
  const[editing,setEditing]=useState(null);
  const handleAdd=()=>{if(!name.trim())return;setItems(x=>[...x,{id:uid(),name:name.trim(),detail:detail.trim()}]);setName("");setDetail("");};
  const handleDel=id=>setItems(x=>x.filter(i=>i.id!==id));
  const handleEditSave=()=>{setItems(x=>x.map(i=>i.id===editing.id?editing:i));setEditing(null);};
  return(
    <Modal title={isMed?"Medication Library":"Food Library"} subtitle={`Manage saved ${isMed?"medications":"foods"}`} onClose={()=>{onSave(items);onClose();}}>
      <div style={{marginBottom:14}}>
        <FInput label={isMed?"Medication Name":"Food / Meal"} placeholder={isMed?"e.g. Clonazepam":"e.g. Chicken soup"} value={name} onChange={e=>setName(e.target.value)}/>
        <FInput label={isMed?"Dose (optional)":"Category (optional)"} placeholder={isMed?"e.g. 0.5mg":""} value={detail} onChange={e=>setDetail(e.target.value)}/>
        <Btn onClick={handleAdd} fullWidth>+ Add to Library</Btn>
      </div>
      <div style={{maxHeight:300,overflowY:"auto"}}>
        {items.filter(Boolean).map(item=>(
          <div key={item.id} style={{background:"#0a0f1a",border:`1px solid ${C.border}`,borderRadius:8,padding:"9px 12px",marginBottom:6,display:"flex",alignItems:"center",gap:8}}>
            {editing?.id===item.id?(
              <div style={{flex:1,display:"flex",gap:6}}>
                <input style={{...IS,flex:2,padding:"5px 8px",fontSize:13}} value={editing.name} onChange={e=>setEditing(v=>({...v,name:e.target.value}))}/>
                <input style={{...IS,flex:1,padding:"5px 8px",fontSize:13}} value={editing.detail} onChange={e=>setEditing(v=>({...v,detail:e.target.value}))}/>
                <Btn onClick={handleEditSave} small>Save</Btn>
              </div>
            ):(
              <>
                <div style={{flex:1}}>
                  <span style={{color:isMed?C.purple:C.teal,fontWeight:600,fontSize:13}}>{item.name}</span>
                  {item.detail&&<span style={{color:C.muted,fontSize:12,marginLeft:6}}>{item.detail}</span>}
                </div>
                <button onClick={()=>setEditing({...item})} style={{background:"#1e293b",border:`1px solid ${C.border}`,borderRadius:6,color:C.sub,cursor:"pointer",fontSize:12,width:28,height:28}}>✏️</button>
                <button onClick={()=>handleDel(item.id)} style={{background:"#1e293b",border:`1px solid ${C.border}`,borderRadius:6,color:"#4b5563",cursor:"pointer",fontSize:12,width:28,height:28}}>🗑</button>
              </>
            )}
          </div>
        ))}
        {items.filter(Boolean).length===0&&<p style={{color:C.muted,fontSize:13,textAlign:"center",padding:"16px 0"}}>Library is empty</p>}
      </div>
      <div style={{marginTop:14}}><Btn onClick={()=>{onSave(items);onClose();}} fullWidth>Done</Btn></div>
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════════════
   QUICK LOG MODAL (med / food)
   ═══════════════════════════════════════════════════════════ */
function QuickLogModal({type,library,onLog,onClose,onOpenLibrary}){
  const isMed=type==="med";
  const[selected,setSelected]=useState(null);
  const[selTime,setSelTime]=useState(localISO());
  const[selNotes,setSelNotes]=useState("");
  const[customMode,setCustomMode]=useState(false);
  const[cName,setCName]=useState("");const[cDetail,setCDetail]=useState("");const[cTime,setCTime]=useState(localISO());const[cNotes,setCNotes]=useState("");
  const TimeField=({value,onChange})=>(
    <div style={{marginBottom:13}}>
      <label style={LS}>Time logged</label>
      <DateTimePicker value={value} onChange={onChange}/>
    </div>
  );
  if(selected){return(
    <Modal title={`Log ${isMed?"Medication":"Meal"}`} subtitle={`${selected.name}${selected.detail?` · ${selected.detail}`:""}`} onClose={onClose}>
      <TimeField value={selTime} onChange={setSelTime}/>
      <FTextarea label="Notes" placeholder={isMed?"Side effects, with food…":"Any reactions, portion size…"} value={selNotes} onChange={e=>setSelNotes(e.target.value)}/>
      <div style={{display:"flex",gap:10,marginTop:6}}>
        <Btn onClick={()=>setSelected(null)} variant="secondary" fullWidth>Back</Btn>
        <Btn onClick={()=>{onLog({id:uid(),name:selected.name,detail:selected.detail||"",notes:selNotes,timestamp:new Date(selTime).toISOString()});onClose();}} fullWidth>Log It</Btn>
      </div>
    </Modal>
  );}
  if(customMode){return(
    <Modal title={`Custom ${isMed?"Medication":"Meal"}`} onClose={onClose}>
      <FInput label={isMed?"Medication Name":"Food / Meal"} value={cName} onChange={e=>setCName(e.target.value)}/>
      <FInput label={isMed?"Dose":"Category (optional)"} value={cDetail} onChange={e=>setCDetail(e.target.value)}/>
      <TimeField value={cTime} onChange={setCTime}/>
      <FTextarea label="Notes" value={cNotes} onChange={e=>setCNotes(e.target.value)}/>
      <div style={{display:"flex",gap:10,marginTop:6}}>
        <Btn onClick={()=>setCustomMode(false)} variant="secondary" fullWidth>Back</Btn>
        <Btn onClick={()=>{if(!cName.trim())return;onLog({id:uid(),name:cName.trim(),detail:cDetail.trim(),notes:cNotes,timestamp:new Date(cTime).toISOString()});onClose();}} fullWidth>Log It</Btn>
      </div>
    </Modal>
  );}
  return(
    <Modal title={`Log ${isMed?"Medication":"Meal"}`} onClose={onClose}>
      {(library||[]).filter(Boolean).length===0?(
        <div style={{textAlign:"center",padding:"16px 0 10px"}}>
          <p style={{color:C.muted,fontSize:13,marginBottom:14}}>Your {isMed?"medication":"food"} library is empty.</p>
          <Btn onClick={onOpenLibrary} fullWidth>Open Library to Add Items →</Btn>
        </div>
      ):(
        <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:16}}>
          {(library||[]).filter(Boolean).map(item=>(
            <button key={item.id} onClick={()=>{setSelected(item);setSelTime(localISO());setSelNotes("");}} style={{background:isMed?"#0f0f2e":"#052e16",border:`1px solid ${isMed?"#312e81":"#166534"}`,borderRadius:99,padding:"7px 14px",cursor:"pointer"}}>
              <span style={{color:isMed?C.purple:C.teal,fontWeight:600,fontSize:13}}>{item.name}</span>
              {item.detail&&<span style={{color:C.muted,fontSize:11,marginLeft:6}}>{item.detail}</span>}
            </button>
          ))}
        </div>
      )}
      <div style={{display:"flex",gap:8,marginTop:4}}>
        <Btn onClick={()=>{setCustomMode(true);setCTime(localISO());}} variant="secondary" fullWidth small>+ Custom Entry</Btn>
        <Btn onClick={onOpenLibrary} variant="secondary" fullWidth small>{(library||[]).filter(Boolean).length?"Edit Library":"Open Library"}</Btn>
      </div>
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════════════
   EDIT MODALS
   ═══════════════════════════════════════════════════════════ */
function EditEventModal({e,onSave,onClose}){
  const[form,setForm]=useState({...e,timestamp:localISO(new Date(e.timestamp))});
  return(
    <Modal title="Edit Event" onClose={onClose}>
      <SeizureForm initial={form} onSave={data=>onSave({...e,...data,pending:false})} onCancel={onClose} saveLabel="Save Changes"/>
    </Modal>
  );
}
function EditMedModal({e,onSave,onClose}){
  const[form,setForm]=useState({...e,timestamp:localISO(new Date(e.timestamp))});
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  return(
    <Modal title="Edit Medication" onClose={onClose}>
      <FInput label="Name" value={form.name} onChange={e=>set("name",e.target.value)}/>
      <FInput label="Dose" value={form.detail||""} onChange={e=>set("detail",e.target.value)}/>
      <div style={{marginBottom:13}}><label style={LS}>Date & Time</label><DateTimePicker value={form.timestamp} onChange={v=>set("timestamp",v)}/></div>
      <FTextarea label="Notes" value={form.notes||""} onChange={e=>set("notes",e.target.value)}/>
      <div style={{display:"flex",gap:10,marginTop:6}}>
        <Btn onClick={onClose} variant="secondary" fullWidth>Cancel</Btn>
        <Btn onClick={()=>onSave({...form,timestamp:new Date(form.timestamp).toISOString()})} fullWidth>Save Changes</Btn>
      </div>
    </Modal>
  );
}
function EditFoodModal({e,onSave,onClose}){
  const[form,setForm]=useState({...e,timestamp:localISO(new Date(e.timestamp))});
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  return(
    <Modal title="Edit Meal" onClose={onClose}>
      <FInput label="Food / Meal" value={form.name} onChange={e=>set("name",e.target.value)}/>
      <FInput label="Category" value={form.detail||""} onChange={e=>set("detail",e.target.value)}/>
      <div style={{marginBottom:13}}><label style={LS}>Date & Time</label><DateTimePicker value={form.timestamp} onChange={v=>set("timestamp",v)}/></div>
      <FTextarea label="Notes" value={form.notes||""} onChange={e=>set("notes",e.target.value)}/>
      <div style={{display:"flex",gap:10,marginTop:6}}>
        <Btn onClick={onClose} variant="secondary" fullWidth>Cancel</Btn>
        <Btn onClick={()=>onSave({...form,timestamp:new Date(form.timestamp).toISOString()})} fullWidth>Save Changes</Btn>
      </div>
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════════════
   ROW COMPONENTS
   ═══════════════════════════════════════════════════════════ */
function RowActions({onEdit,onDelete}){
  return(
    <div style={{display:"flex",gap:4,flexShrink:0,marginLeft:8}}>
      <button onClick={onEdit} style={{background:"#1e293b",border:`1px solid ${C.border}`,borderRadius:7,color:C.sub,cursor:"pointer",fontSize:13,width:30,height:30,display:"flex",alignItems:"center",justifyContent:"center"}}>✏️</button>
      <button onClick={onDelete} style={{background:"#1e293b",border:`1px solid ${C.border}`,borderRadius:7,color:"#4b5563",cursor:"pointer",fontSize:13,width:30,height:30,display:"flex",alignItems:"center",justifyContent:"center"}}>🗑</button>
    </div>
  );
}
function EventRow({e,onDelete,onEdit}){
  const timeStr=fmtTime(e.timestamp);
  return(
    <div style={{background:"#0a0f1a",border:`1px solid ${e.pending?"#92400e":C.border}`,borderRadius:8,padding:"9px 12px",marginBottom:5,cursor:"pointer"}} onClick={onEdit}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
        <div style={{flex:1,minWidth:0,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          <span style={{color:C.text,fontWeight:700,fontSize:13,flexShrink:0}}>{timeStr}</span>
          <span style={{color:C.green,fontSize:12,fontWeight:600}}>⚡ FND Event</span>
          {e.pending&&<span style={{background:"#78350f",color:C.amber,fontSize:10,padding:"2px 7px",borderRadius:99,fontWeight:700}}>Needs details</span>}
          {e.notes&&<span style={{color:C.sub,fontSize:12,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:200}}>· {e.notes}</span>}
        </div>
        <RowActions onEdit={onEdit} onDelete={e2=>{e2.stopPropagation();onDelete(e.id);}}/>
      </div>
    </div>
  );
}
function MedRow({e,onDelete,onEdit}){
  return(
    <div style={{background:"#0a0f1a",border:`1px solid ${C.border}`,borderRadius:8,padding:"9px 12px",marginBottom:5,cursor:"pointer"}} onClick={onEdit}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
        <div style={{flex:1,minWidth:0,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          <span style={{color:C.text,fontWeight:700,fontSize:13,flexShrink:0}}>{fmtTime(e.timestamp)}</span>
          <span style={{color:C.purple,fontSize:12,fontWeight:600}}>💊 {e.name}</span>
          {e.detail&&<span style={{color:C.muted,fontSize:12}}>· {e.detail}</span>}
          {e.notes&&<span style={{color:C.sub,fontSize:12,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:180}}>· {e.notes}</span>}
        </div>
        <RowActions onEdit={onEdit} onDelete={e2=>{e2.stopPropagation();onDelete(e.id);}}/>
      </div>
    </div>
  );
}
function FoodRow({e,onDelete,onEdit}){
  return(
    <div style={{background:"#0a0f1a",border:`1px solid ${C.border}`,borderRadius:8,padding:"9px 12px",marginBottom:5,cursor:"pointer"}} onClick={onEdit}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
        <div style={{flex:1,minWidth:0,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          <span style={{color:C.text,fontWeight:700,fontSize:13,flexShrink:0}}>{fmtTime(e.timestamp)}</span>
          <span style={{color:C.teal,fontSize:12,fontWeight:600}}>🍽 {e.name}</span>
          {e.detail&&<span style={{color:C.muted,fontSize:12}}>· {e.detail}</span>}
          {e.notes&&<span style={{color:C.sub,fontSize:12,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:180}}>· {e.notes}</span>}
        </div>
        <RowActions onEdit={onEdit} onDelete={e2=>{e2.stopPropagation();onDelete(e.id);}}/>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   TRENDS TAB
   ═══════════════════════════════════════════════════════════ */
function TrendsTab({events,food}){
  const cf=useChartFont();
  const desk=useDesktop();
  const[window,setWindow]=useState(30);
  const[section,setSection]=useState("time");
  const[offset,setOffset]=useState(0);
  const cutoff=new Date(Date.now()-window*864e5);
  const evts=window===9999?events:events.filter(e=>new Date(e.timestamp)>=cutoff);
  const CLUSTER_GAP=30;
  const sorted=[...evts].sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
  const clusters=[];let cur=[];
  sorted.forEach(e=>{if(!cur.length||new Date(e.timestamp)-new Date(cur[cur.length-1].timestamp)<=CLUSTER_GAP*60000){cur.push(e);}else{clusters.push(cur);cur=[e];}});
  if(cur.length)clusters.push(cur);
  const clustered=clusters.filter(c=>c.length>=2);
  const bigClusters=clusters.filter(c=>c.length>=5);
  const eventsInClusters=clustered.reduce((s,c)=>s+c.length,0);
  const isolated=evts.length-eventsInClusters;
  const minsOfDay=evts.map(e=>{const t=new Date(e.timestamp);return t.getHours()*60+t.getMinutes();});
  const buckets=Array.from({length:8},(_,i)=>{const startH=i*3;const count=minsOfDay.filter(m=>m>=startH*60&&m<(startH+3)*60).length;const label=["12-3a","3-6a","6-9a","9a-12p","12-3p","3-6p","6-9p","9p-12a"][i];return{label,count,startM:startH*60};});
  const maxB=Math.max(1,...buckets.map(b=>b.count));
  const peak=buckets.reduce((a,b)=>b.count>a.count?b:a,buckets[0]);
  const byDayOfWeek=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((name,i)=>{const dayEvts=evts.filter(e=>new Date(e.timestamp).getDay()===i);const weeksInWindow=Math.max(1,window/7);return{name,raw:dayEvts.length,avg:dayEvts.length/weeksInWindow};});
  const maxDow=Math.max(1,...byDayOfWeek.map(d=>d.avg));
  const peakDay=byDayOfWeek.reduce((a,b)=>b.avg>a.avg?b:a,byDayOfWeek[0]);
  const quietDay=byDayOfWeek.reduce((a,b)=>b.avg<a.avg?b:a,byDayOfWeek[0]);
  const wkdAvg=(byDayOfWeek[1].avg+byDayOfWeek[2].avg+byDayOfWeek[3].avg+byDayOfWeek[4].avg+byDayOfWeek[5].avg)/5;
  const weAvg=(byDayOfWeek[0].avg+byDayOfWeek[6].avg)/2;
  const wkdDiff=wkdAvg>0?Math.round(((weAvg-wkdAvg)/wkdAvg)*100):null;
  const insightParts=[];
  if(evts.length>5){
    insightParts.push(`${peak.label.replace('-',' – ')} is the peak 3-hour window (${evts.length?Math.round(peak.count/evts.length*100):0}% of events).`);
    insightParts.push(`${peakDay.name} has the most events on average.`);
  }
  if(clustered.length>0)insightParts.push(`${clustered.length} cluster${clustered.length>1?"s":""} detected (2+ events within ${CLUSTER_GAP} min).`);
  if(wkdDiff!==null&&Math.abs(wkdDiff)>=20)insightParts.push(`${wkdDiff<0?"Weekdays":"Weekends"} see notably more events (${Math.abs(wkdDiff)}% difference).`);
  const cardStyle={background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:16,marginBottom:14};
  const secLabel=(t)=><div style={{color:C.sub,fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:12}}>{t}</div>;
  const sectionBtn=(id,label)=>(
    <button onClick={()=>setSection(id)} style={{flex:1,padding:"7px 0",borderRadius:8,cursor:"pointer",fontSize:12,fontWeight:700,background:section===id?C.card:"transparent",color:section===id?C.text:C.muted,border:"none"}}>{label}</button>
  );
  // Week/Month/Year trend strips
  // weekTrend: 8 complete Mon-Sun weeks, index 7 = most recent completed+current week
  const weekTrend=Array.from({length:8},(_,wi)=>{
    const weeksAgo=7-wi+offset;
    const end=new Date();
    end.setDate(end.getDate()-weeksAgo*7);
    end.setHours(23,59,59,999);
    const start=new Date(end);
    start.setDate(start.getDate()-6);
    start.setHours(0,0,0,0);
    return events.filter(e=>{const t=new Date(e.timestamp);return t>=start&&t<=end;}).length;
  });
  const monthTrend=Array.from({length:8},(_,mi)=>{const ref=new Date();ref.setDate(1);ref.setMonth(ref.getMonth()-(offset+7-mi));const start=new Date(ref);start.setHours(0,0,0,0);const end=new Date(ref.getFullYear(),ref.getMonth()+1,0,23,59,59,999);return{cnt:events.filter(e=>{const t=new Date(e.timestamp);return t>=start&&t<=end;}).length,label:ref.toLocaleDateString([],{month:"short"})};});
  return(
    <div>
      {/* Section tabs — always visible */}
      <div style={{display:"flex",background:"#1e293b",borderRadius:10,padding:3,marginBottom:14,gap:3}}>
        {sectionBtn("time","🕐 Time")}
        {sectionBtn("weekly","📅 Weekly")}
        {sectionBtn("monthly","📆 Monthly")}
        {sectionBtn("food","🍽 Food")}
      </div>

      {/* ── Time Analysis ── */}
      {section==="time"&&(
        <div>
          {/* Window buttons nested here only */}
          <div style={{display:"flex",gap:6,marginBottom:14}}>
            {[[30,"30d"],[90,"90d"],[180,"6mo"],[365,"1yr"],[9999,"All"]].map(([d,l])=>(
              <button key={d} onClick={()=>setWindow(d)} style={{flex:1,padding:"6px 0",borderRadius:8,cursor:"pointer",fontSize:12,fontWeight:700,background:window===d?C.greenDk:"#1e293b",color:window===d?C.green:C.muted,border:window===d?"1px solid #059669":`1px solid ${C.border}`}}>{l}</button>
            ))}
          </div>
          {insightParts.length>0&&(
            <div style={{background:"#0a1628",border:"1px solid #1e3a5f",borderRadius:12,padding:14,marginBottom:14}}>
              <div style={{color:"#93c5fd",fontSize:12,fontWeight:700,marginBottom:6}}>💡 Key Findings — last {window===9999?"all time":`${window} days`} ({evts.length} events)</div>
              {insightParts.map((p,i)=><div key={i} style={{color:C.muted,fontSize:12,lineHeight:1.6,marginBottom:i<insightParts.length-1?6:0}}>• {p}</div>)}
            </div>
          )}
          <div style={cardStyle}>
            {secLabel("3-Hour Distribution")}
            <div style={{display:"flex",gap:3,alignItems:"flex-end",height:desk?180:70,marginBottom:6}}>
              {buckets.map((b,i)=>{const barH=b.count===0?3:Math.max(6,Math.round((b.count/maxB)*(desk?176:66)));const isPeak=b.startM===peak.startM;return(
                <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
                  {b.count>0&&<span style={{fontSize:cf.barLabel,color:isPeak?C.text:C.muted,fontWeight:isPeak?700:400}}>{b.count}</span>}
                  <div style={{width:"100%",borderRadius:"3px 3px 0 0",background:"#1d4ed8",opacity:isPeak?1:0.45,height:barH,boxShadow:isPeak?"0 0 10px #1d4ed888":""}}/>
                </div>
              );})}
            </div>
            <div style={{display:"flex",gap:3,marginBottom:10}}>
              {buckets.map((b,i)=><div key={i} style={{flex:1,textAlign:"center",fontSize:cf.axisLabel,color:b.startM===peak.startM?C.amber:C.muted,fontWeight:b.startM===peak.startM?700:400}}>{b.label}</div>)}
            </div>
            <div style={{color:C.muted,fontSize:11,lineHeight:1.6,borderTop:`1px solid ${C.border}`,paddingTop:10}}>
              Peak window is <span style={{color:C.amber,fontWeight:700}}>{peak.label.replace('-',' – ')}</span> with {peak.count} event{peak.count!==1?"s":""} ({evts.length?Math.round(peak.count/evts.length*100):0}% of total). {evts.length>0&&`Across all ${evts.length} events in this period.`}
            </div>
          </div>
          <div style={cardStyle}>
            {secLabel("Day of Week")}
            <div style={{display:"flex",gap:4,alignItems:"flex-end",height:desk?120:60,marginBottom:6}}>
              {byDayOfWeek.map((d,i)=>{const h=d.avg===0?2:Math.max(5,Math.round((d.avg/maxDow)*(desk?116:56)));const isWeekend=i===0||i===6;const isPeak=d.name===peakDay.name;return(
                <div key={d.name} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                  {d.raw>0&&<span style={{fontSize:cf.barLabel,color:isPeak?C.teal:C.muted,fontWeight:isPeak?700:400}}>{d.raw}</span>}
                  <div style={{width:"100%",borderRadius:"3px 3px 0 0",background:isPeak?C.teal:isWeekend?"#6366f1":"#1d4ed8",opacity:isPeak?1:0.55,height:h}}/>
                </div>
              );})}
            </div>
            <div style={{display:"flex",gap:4,marginBottom:10}}>
              {byDayOfWeek.map((d,i)=><div key={i} style={{flex:1,textAlign:"center",fontSize:cf.axisLabel,color:d.name===peakDay.name?C.amber:C.muted,fontWeight:d.name===peakDay.name?700:400}}>{d.name}</div>)}
            </div>
            <div style={{color:C.muted,fontSize:11,lineHeight:1.6,borderTop:`1px solid ${C.border}`,paddingTop:10}}>
              <span style={{color:C.teal,fontWeight:700}}>{peakDay.name}</span> is your busiest day · <span style={{color:C.sub,fontWeight:700}}>{quietDay.name}</span> is typically quietest.
              {wkdDiff!==null&&Math.abs(wkdDiff)>=10&&<span> Weekdays average <span style={{color:C.sub,fontWeight:700}}>{Math.abs(wkdDiff)}% {wkdDiff<0?"fewer":"more"}</span> events per day than weekends.</span>}
            </div>
          </div>
          <div style={cardStyle}>
            {secLabel("Clustering")}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:12}}>
              {[{label:"Isolated",value:isolated,sub:"single events",color:C.green},{label:"Clusters",value:clustered.length,sub:`≥2 within ${CLUSTER_GAP}min`,color:C.amber},{label:"Large (5+)",value:bigClusters.length,sub:"in one burst",color:C.red}].map(({label,value,sub,color})=>(
                <div key={label} style={{background:"#0a0f1a",border:`1px solid ${C.border}`,borderRadius:10,padding:"10px"}}>
                  <div style={{color:C.muted,fontSize:9,fontWeight:700,textTransform:"uppercase",marginBottom:2}}>{label}</div>
                  <div style={{color,fontSize:desk?28:20,fontWeight:800,lineHeight:1}}>{value}</div>
                  <div style={{color:C.muted,fontSize:10,marginTop:2}}>{sub}</div>
                </div>
              ))}
            </div>
            <div style={{color:C.muted,fontSize:11,lineHeight:1.6,borderTop:`1px solid ${C.border}`,paddingTop:10}}>
              {clustered.length===0
                ? "No clusters detected — all events in this period appear to be isolated."
                : `${eventsInClusters} of ${evts.length} events (${evts.length?Math.round(eventsInClusters/evts.length*100):0}%) occurred in groups of 2 or more within ${CLUSTER_GAP} minutes of each other.${bigClusters.length>0?` ${bigClusters.length} burst${bigClusters.length!==1?"s":""} of 5+ events detected.`:""}`
              }
            </div>
          </div>
        </div>
      )}

      {/* ── Weekly ── */}
      {section==="weekly"&&(()=>{
        const totalEvents=weekTrend.reduce((s,v)=>s+v,0);
        const avgPerWeek=(totalEvents/8).toFixed(1);
        const thisWeek=weekTrend[7];
        const prevWeek=weekTrend[6];
        const weekDiff=thisWeek-prevWeek;
        const peakWeekVal=Math.max(...weekTrend);
        const peakWeekIdx=weekTrend.lastIndexOf(peakWeekVal);
        const weeksAgoLabel=7-peakWeekIdx===0?"this week":7-peakWeekIdx===1?"last week":`${7-peakWeekIdx} weeks ago`;
        return(
          <div>
            {/* Summary stats */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:14}}>
              {[
                {label:"This week",val:thisWeek,color:C.green,sub:"events so far"},
                {label:"8-wk avg",val:avgPerWeek,color:C.teal,sub:"events per week"},
                {label:"vs last week",val:weekDiff===0?"=":`${weekDiff>0?"+":""}${weekDiff}`,color:weekDiff<0?C.green:weekDiff>0?C.red:C.muted,sub:weekDiff===0?"no change":weekDiff<0?"fewer events":"more events"},
              ].map(({label,val,color,sub})=>(
                <div key={label} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"12px 14px",textAlign:"center"}}>
                  <div style={{color:C.muted,fontSize:10,textTransform:"uppercase",fontWeight:700,letterSpacing:"0.06em",marginBottom:4}}>{label}</div>
                  <div style={{color,fontSize:desk?28:22,fontWeight:800,lineHeight:1}}>{val}</div>
                  <div style={{color:C.muted,fontSize:10,marginTop:3}}>{sub}</div>
                </div>
              ))}
            </div>
            <div style={cardStyle}>
              {secLabel("8-Week Trend")}
              <div style={{color:C.muted,fontSize:11,marginBottom:12,lineHeight:1.6}}>
                Each bar is one 7-day week. The rightmost bar is the current week (partial). Bars are rate-normalised so a partial current week isn't unfairly low.
              </div>
              <SvgTrendLine values={weekTrend} color={C.green} height={desk?120:60}/>
              <div style={{display:"flex",justifyContent:"space-between",marginTop:6}}>
                <span style={{color:C.muted,fontSize:cf.axisLabel}}>8 wks ago</span>
                <span style={{color:C.green,fontSize:cf.axisLabel,fontWeight:700}}>This week</span>
              </div>
              <div style={{color:C.muted,fontSize:11,lineHeight:1.6,borderTop:`1px solid ${C.border}`,paddingTop:10,marginTop:10}}>
                Peak week was <span style={{color:C.amber,fontWeight:700}}>{peakWeekVal} events</span> ({weeksAgoLabel}).
                {" "}8-week average: <span style={{color:C.teal,fontWeight:700}}>{avgPerWeek} events/week</span>.
                {weekDiff!==0&&<span> This week is {Math.abs(weekDiff)} event{Math.abs(weekDiff)!==1?"s":""} <span style={{color:weekDiff<0?C.green:C.red,fontWeight:700}}>{weekDiff<0?"below":"above"}</span> last week.</span>}
              </div>
            </div>
            {/* Week breakdown table */}
            <div style={cardStyle}>
              {secLabel("Week by Week")}
              <div style={{color:C.muted,fontSize:11,marginBottom:10}}>Most recent 8 weeks, newest first.</div>
              {[...weekTrend].reverse().map((cnt,i)=>{
                const wAgo=i;
                const label=wAgo===0?"This week":wAgo===1?"Last week":`${wAgo} weeks ago`;
                const pct=peakWeekVal>0?Math.round((cnt/peakWeekVal)*100):0;
                return(
                  <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 0",borderBottom:`1px solid ${C.border}`}}>
                    <div style={{minWidth:90,fontSize:12,color:wAgo===0?C.green:C.muted,fontWeight:wAgo===0?700:400}}>{label}</div>
                    <div style={{flex:1,height:6,background:"#1e293b",borderRadius:3,overflow:"hidden"}}>
                      <div style={{height:"100%",width:`${pct}%`,background:wAgo===0?C.green:C.teal,borderRadius:3,transition:"width .3s"}}/>
                    </div>
                    <div style={{minWidth:28,textAlign:"right",fontSize:13,fontWeight:700,color:wAgo===0?C.green:C.sub}}>{cnt}</div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* ── Monthly ── */}
      {section==="monthly"&&(()=>{
        const totalMonthly=monthTrend.reduce((s,m)=>s+m.cnt,0);
        const avgPerMonth=(totalMonthly/8).toFixed(1);
        const thisMonth=monthTrend[7];
        const prevMonth=monthTrend[6];
        const monthDiff=thisMonth.cnt-prevMonth.cnt;
        const peakMonth=monthTrend.reduce((a,b)=>b.cnt>a.cnt?b:a,monthTrend[0]);
        const quietMonth=monthTrend.reduce((a,b)=>b.cnt<a.cnt?b:a,monthTrend[0]);
        return(
          <div>
            {/* Summary stats */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:14}}>
              {[
                {label:thisMonth.label,val:thisMonth.cnt,color:C.green,sub:"events this month"},
                {label:"8-mo avg",val:avgPerMonth,color:C.teal,sub:"events per month"},
                {label:"vs last month",val:monthDiff===0?"=":`${monthDiff>0?"+":""}${monthDiff}`,color:monthDiff<0?C.green:monthDiff>0?C.red:C.muted,sub:monthDiff===0?"no change":monthDiff<0?"fewer events":"more events"},
              ].map(({label,val,color,sub})=>(
                <div key={label} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"12px 14px",textAlign:"center"}}>
                  <div style={{color:C.muted,fontSize:10,textTransform:"uppercase",fontWeight:700,letterSpacing:"0.06em",marginBottom:4}}>{label}</div>
                  <div style={{color,fontSize:desk?28:22,fontWeight:800,lineHeight:1}}>{val}</div>
                  <div style={{color:C.muted,fontSize:10,marginTop:3}}>{sub}</div>
                </div>
              ))}
            </div>
            <div style={cardStyle}>
              {secLabel("8-Month Trend")}
              <div style={{color:C.muted,fontSize:11,marginBottom:12,lineHeight:1.6}}>
                Each point is one calendar month. The rightmost point is the current month (partial). Useful for spotting seasonal patterns or gradual changes over time.
              </div>
              <SvgTrendLine values={monthTrend.map(m=>m.cnt)} color={C.green} height={desk?120:60}/>
              <div style={{display:"flex",marginTop:6}}>
                {monthTrend.map((m,i)=><span key={i} style={{flex:1,textAlign:"center",fontSize:cf.axisLabel,color:i===7?C.green:C.muted,fontWeight:i===7?700:400}}>{m.label}</span>)}
              </div>
              <div style={{color:C.muted,fontSize:11,lineHeight:1.6,borderTop:`1px solid ${C.border}`,paddingTop:10,marginTop:10}}>
                Highest month: <span style={{color:C.amber,fontWeight:700}}>{peakMonth.label} ({peakMonth.cnt} events)</span>.
                {" "}Lowest: <span style={{color:C.green,fontWeight:700}}>{quietMonth.label} ({quietMonth.cnt} events)</span>.
                {" "}8-month average: <span style={{color:C.teal,fontWeight:700}}>{avgPerMonth}/month</span>.
              </div>
            </div>
            {/* Month breakdown table */}
            <div style={cardStyle}>
              {secLabel("Month by Month")}
              <div style={{color:C.muted,fontSize:11,marginBottom:10}}>Most recent 8 months, newest first.</div>
              {[...monthTrend].reverse().map((m,i)=>{
                const pct=peakMonth.cnt>0?Math.round((m.cnt/peakMonth.cnt)*100):0;
                const isCurrent=i===0;
                return(
                  <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 0",borderBottom:`1px solid ${C.border}`}}>
                    <div style={{minWidth:52,fontSize:12,color:isCurrent?C.green:C.muted,fontWeight:isCurrent?700:400}}>{m.label}{isCurrent?" *":""}</div>
                    <div style={{flex:1,height:6,background:"#1e293b",borderRadius:3,overflow:"hidden"}}>
                      <div style={{height:"100%",width:`${pct}%`,background:isCurrent?C.green:C.teal,borderRadius:3}}/>
                    </div>
                    <div style={{minWidth:28,textAlign:"right",fontSize:13,fontWeight:700,color:isCurrent?C.green:C.sub}}>{m.cnt}</div>
                  </div>
                );
              })}
              <div style={{color:"#374151",fontSize:10,marginTop:8}}>* current month (partial)</div>
            </div>
          </div>
        );
      })()}

      {/* ── Food Correlations ── */}
      {section==="food"&&(()=>{
        const correlations=evts.map(ev=>({event:ev,priorFood:loggedBefore(food,ev.timestamp,4)})).filter(c=>c.priorFood.length>0);
        const foodFreq={};
        correlations.forEach(({priorFood})=>{priorFood.forEach(f=>{foodFreq[f.name]=(foodFreq[f.name]||0)+1;});});
        const topFoods=Object.entries(foodFreq).sort((a,b)=>b[1]-a[1]).slice(0,10);
        const coveredEvents=correlations.length;
        const maxFreq=topFoods.length?topFoods[0][1]:1;
        return(
          <div>
            {/* Explainer */}
            <div style={{background:"#0a1628",border:"1px solid #1e3a5f",borderRadius:12,padding:14,marginBottom:14}}>
              <div style={{color:"#93c5fd",fontSize:12,fontWeight:700,marginBottom:4}}>ℹ️ How this works</div>
              <div style={{color:C.muted,fontSize:12,lineHeight:1.7}}>
                Any food logged within <span style={{color:C.text,fontWeight:600}}>4 hours before</span> a seizure event is counted as a potential correlate. A high count doesn't confirm causation — it just shows which foods frequently appear in that window.
                {food.length===0&&<span style={{display:"block",marginTop:6,color:C.amber}}> Start logging meals to see correlations.</span>}
              </div>
            </div>
            {/* Stats strip */}
            {coveredEvents>0&&(
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
                <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"12px 14px",textAlign:"center"}}>
                  <div style={{color:C.muted,fontSize:10,textTransform:"uppercase",fontWeight:700,letterSpacing:"0.06em",marginBottom:4}}>Events with food data</div>
                  <div style={{color:C.teal,fontSize:desk?28:22,fontWeight:800,lineHeight:1}}>{coveredEvents}</div>
                  <div style={{color:C.muted,fontSize:10,marginTop:3}}>of {evts.length} total ({evts.length?Math.round(coveredEvents/evts.length*100):0}%)</div>
                </div>
                <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"12px 14px",textAlign:"center"}}>
                  <div style={{color:C.muted,fontSize:10,textTransform:"uppercase",fontWeight:700,letterSpacing:"0.06em",marginBottom:4}}>Unique foods seen</div>
                  <div style={{color:C.amber,fontSize:desk?28:22,fontWeight:800,lineHeight:1}}>{Object.keys(foodFreq).length}</div>
                  <div style={{color:C.muted,fontSize:10,marginTop:3}}>in the 4h window</div>
                </div>
              </div>
            )}
            <div style={cardStyle}>
              {secLabel("Most Frequent Before Events")}
              {topFoods.length===0?(
                <p style={{color:C.muted,fontSize:13,textAlign:"center",padding:"16px 0"}}>
                  {food.length===0?"No meals logged yet — add meals to track correlations.":"No food logged within 4h of any events in this period."}
                </p>
              ):(
                <div>
                  <div style={{color:C.muted,fontSize:11,marginBottom:12,lineHeight:1.6}}>
                    Showing top {topFoods.length} food{topFoods.length!==1?"s":""} most frequently logged in the 4 hours before a seizure. Bar width shows relative frequency.
                  </div>
                  {topFoods.map(([name,count],i)=>{
                    const pct=Math.round((count/maxFreq)*100);
                    const pctOfEvents=evts.length?Math.round((count/evts.length)*100):0;
                    return(
                      <div key={name} style={{marginBottom:12}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:4}}>
                          <span style={{color:C.teal,fontSize:13,fontWeight:600}}>{name}</span>
                          <div style={{display:"flex",gap:12,alignItems:"baseline"}}>
                            <span style={{color:C.muted,fontSize:11}}>{pctOfEvents}% of events</span>
                            <span style={{color:C.sub,fontSize:13,fontWeight:700}}>{count}×</span>
                          </div>
                        </div>
                        <div style={{height:6,background:"#1e293b",borderRadius:3,overflow:"hidden"}}>
                          <div style={{height:"100%",width:`${pct}%`,background:i===0?"#f59e0b":C.teal,borderRadius:3,transition:"width .3s"}}/>
                        </div>
                      </div>
                    );
                  })}
                  {topFoods.length>0&&(
                    <div style={{color:"#374151",fontSize:11,marginTop:10,lineHeight:1.6,borderTop:`1px solid ${C.border}`,paddingTop:10}}>
                      Share this list with your neurologist — they may recognise dietary triggers relevant to FND or related conditions.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   LOG / HISTORY TAB
   ═══════════════════════════════════════════════════════════ */
const DAYS_PER_PAGE=14;
function Pager({page,setPage,total,pages,unit="results"}){
  if(pages<=1)return null;
  return(
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:12,padding:"10px 14px",background:C.card,border:`1px solid ${C.border}`,borderRadius:10}}>
      <button onClick={()=>setPage(p=>Math.max(0,p-1))} disabled={page===0} style={{background:page===0?"transparent":"#1e293b",border:`1px solid ${page===0?"transparent":C.border}`,borderRadius:7,color:page===0?"#2d3748":C.sub,padding:"5px 14px",cursor:page===0?"default":"pointer",fontWeight:700,fontSize:13}}>‹ Prev</button>
      <span style={{color:C.muted,fontSize:12}}>Page {page+1} of {pages} · {total} {unit}</span>
      <button onClick={()=>setPage(p=>Math.min(pages-1,p+1))} disabled={page===pages-1} style={{background:page===pages-1?"transparent":"#1e293b",border:`1px solid ${page===pages-1?"transparent":C.border}`,borderRadius:7,color:page===pages-1?"#2d3748":C.sub,padding:"5px 14px",cursor:page===pages-1?"default":"pointer",fontWeight:700,fontSize:13}}>Next ›</button>
    </div>
  );
}

function LogTab({events,pending,meds,food,delEvent,delPending,delMed,delFood,setEditing,approveAll}){
  const[logTab,setLogTab]=useState("events");
  const[search,setSearch]=useState("");
  const[sortDir,setSortDir]=useState("desc");
  const[showPending,setShowPending]=useState(false);
  const[dateFrom,setDateFrom]=useState("");
  const[dateTo,setDateTo]=useState("");
  const[showRange,setShowRange]=useState(false);
  const[evtPage,setEvtPage]=useState(0);
  const[medPage,setMedPage]=useState(0);
  const[foodPage,setFoodPage]=useState(0);
  const q=search.trim().toLowerCase();
  const resetPages=()=>{setEvtPage(0);setMedPage(0);setFoodPage(0);};
  const inRange=(ts)=>{if(dateFrom&&new Date(ts)<new Date(dateFrom+"T00:00:00"))return false;if(dateTo&&new Date(ts)>new Date(dateTo+"T23:59:59"))return false;return true;};
  const rangeActive=dateFrom||dateTo;
  const filteredEvtsFinal=[...pending,...events].filter(e=>{if(showPending&&!e.pending)return false;if(!inRange(e.timestamp))return false;if(q&&!fmtFull(e.timestamp).toLowerCase().includes(q)&&!(e.notes||"").toLowerCase().includes(q))return false;return true;}).sort((a,b)=>sortDir==="desc"?new Date(b.timestamp)-new Date(a.timestamp):new Date(a.timestamp)-new Date(b.timestamp));
  const filteredMeds=[...meds].filter(e=>{if(!inRange(e.timestamp))return false;if(!q)return true;return fmtFull(e.timestamp).toLowerCase().includes(q)||(e.name||"").toLowerCase().includes(q);}).sort((a,b)=>sortDir==="desc"?new Date(b.timestamp)-new Date(a.timestamp):new Date(a.timestamp)-new Date(b.timestamp));
  const filteredFood=[...food].filter(e=>{if(!inRange(e.timestamp))return false;if(!q)return true;return fmtFull(e.timestamp).toLowerCase().includes(q)||(e.name||"").toLowerCase().includes(q);}).sort((a,b)=>sortDir==="desc"?new Date(b.timestamp)-new Date(a.timestamp):new Date(a.timestamp)-new Date(b.timestamp));
  const groupItems=(items)=>{const map={};items.forEach(e=>{const d=new Date(e.timestamp);const key=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;if(!map[key])map[key]={key,date:new Date(d.getFullYear(),d.getMonth(),d.getDate()),items:[]};map[key].items.push(e);});const groups=Object.values(map).sort((a,b)=>sortDir==="desc"?b.date-a.date:a.date-b.date);groups.forEach(g=>g.items.sort((a,b)=>sortDir==="desc"?new Date(b.timestamp)-new Date(a.timestamp):new Date(a.timestamp)-new Date(b.timestamp)));return groups;};
  const evtGroups=groupItems(filteredEvtsFinal);
  const medGroups=groupItems(filteredMeds);
  const foodGroups=groupItems(filteredFood);
  const evtPages=Math.max(1,Math.ceil(evtGroups.length/DAYS_PER_PAGE));
  const medPages=Math.max(1,Math.ceil(medGroups.length/DAYS_PER_PAGE));
  const foodPages=Math.max(1,Math.ceil(foodGroups.length/DAYS_PER_PAGE));
  function DayGroup({group,renderRow}){
    const[collapsed,setCollapsed]=useState(false);
    const today=new Date();today.setHours(0,0,0,0);
    const yesterday=new Date(today);yesterday.setDate(today.getDate()-1);
    const isToday=group.date.getTime()===today.getTime();
    const isYesterday=group.date.getTime()===yesterday.getTime();
    const dateLabel=isToday?"Today":isYesterday?"Yesterday":group.date.toLocaleDateString([],{weekday:"long",month:"long",day:"numeric",year:"numeric"});
    const hasPending=group.items.some(e=>e.pending);
    return(
      <div style={{marginBottom:10}}>
        <button onClick={()=>setCollapsed(c=>!c)} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",background:C.card,border:`1px solid ${hasPending?"#92400e":C.border}`,borderRadius:collapsed?10:"10px 10px 0 0",padding:"10px 14px",cursor:"pointer",textAlign:"left"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <span style={{color:isToday?C.green:C.text,fontWeight:800,fontSize:14}}>{dateLabel}</span>
            <span style={{background:"#1e293b",color:C.muted,fontSize:11,fontWeight:700,padding:"2px 8px",borderRadius:99}}>{group.items.length}</span>
            {hasPending&&<span style={{background:"#78350f",color:C.amber,fontSize:10,padding:"2px 7px",borderRadius:99,fontWeight:700}}>pending</span>}
          </div>
          <span style={{color:C.muted,fontSize:12}}>{collapsed?"▸":"▾"}</span>
        </button>
        {!collapsed&&(
          <div style={{background:"#060d12",border:`1px solid ${hasPending?"#92400e":C.border}`,borderTop:"none",borderRadius:"0 0 10px 10px",padding:"8px 10px"}}>
            {group.items.map(e=>renderRow(e))}
          </div>
        )}
      </div>
    );
  }
  const allTs=[...events,...meds,...food].map(e=>new Date(e.timestamp)).filter(d=>!isNaN(d));
  const minDate=allTs.length?toYMD(new Date(Math.min(...allTs))):"";
  const maxDate=toYMD(new Date());
  return(
    <div>
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"12px 16px",marginBottom:12,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div><div style={{color:C.muted,fontSize:10,textTransform:"uppercase",fontWeight:700,letterSpacing:"0.06em"}}>Total Seizures Logged</div><div style={{color:C.green,fontSize:28,fontWeight:800,lineHeight:1.1}}>{events.length+pending.length}</div></div>
        <div style={{display:"flex",gap:12,textAlign:"center"}}>
          {pending.length>0&&<div><div style={{color:C.amber,fontSize:16,fontWeight:800}}>{pending.length}</div><div style={{color:C.muted,fontSize:10}}>pending</div></div>}
          <div><div style={{color:C.teal,fontSize:16,fontWeight:800}}>{events.length}</div><div style={{color:C.muted,fontSize:10}}>logged</div></div>
        </div>
      </div>
      <div style={{position:"relative",marginBottom:10}}>
        <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",fontSize:14,pointerEvents:"none"}}>🔍</span>
        <input value={search} onChange={e=>{setSearch(e.target.value);resetPages();}} placeholder="Search by date, notes…" style={{width:"100%",background:"#1e293b",border:`1px solid ${C.border}`,borderRadius:10,color:C.text,padding:"9px 10px 9px 32px",fontSize:13,outline:"none",boxSizing:"border-box"}}/>
        {search&&<button onClick={()=>{setSearch("");resetPages();}} style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:16}}>✕</button>}
      </div>
      <div style={{display:"flex",gap:6,marginBottom:rangeActive||showRange?0:12,alignItems:"center",flexWrap:"wrap"}}>
        <button onClick={()=>{setSortDir(d=>d==="desc"?"asc":"desc");resetPages();}} style={{background:"#1e293b",border:`1px solid ${C.border}`,borderRadius:8,color:C.sub,padding:"6px 10px",cursor:"pointer",fontSize:12,fontWeight:700}}>{sortDir==="desc"?"↓ Newest":"↑ Oldest"}</button>
        <button onClick={()=>{setShowRange(v=>!v);}} style={{background:showRange||rangeActive?C.greenDk:"#1e293b",border:`1px solid ${showRange||rangeActive?"#059669":C.border}`,borderRadius:8,color:showRange||rangeActive?C.green:C.sub,padding:"6px 10px",cursor:"pointer",fontSize:12,fontWeight:700}}>📅 Date Range{rangeActive?" ●":""}</button>
        {pending.length>0&&<button onClick={()=>{setShowPending(v=>!v);resetPages();}} style={{background:showPending?"#78350f":"#1e293b",border:`1px solid ${showPending?"#b45309":C.border}`,borderRadius:8,color:showPending?C.amber:C.sub,padding:"6px 10px",cursor:"pointer",fontSize:12,fontWeight:700}}>⏳ Pending ({pending.length})</button>}
        {pending.length>1&&<button onClick={approveAll} style={{background:"#052e16",border:"1px solid #166534",borderRadius:8,color:C.green,padding:"6px 10px",cursor:"pointer",fontSize:12,fontWeight:700}}>✓ Approve All</button>}
      </div>
      {showRange&&(
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 14px",marginBottom:12}}>
          <div style={{display:"flex",gap:10}}>
            <div style={{flex:1}}><div style={{color:C.muted,fontSize:10,fontWeight:700,textTransform:"uppercase",marginBottom:4}}>FROM</div><input type="date" value={dateFrom} min={minDate} max={dateTo||maxDate} onChange={e=>{setDateFrom(e.target.value);resetPages();}} style={{...IS,padding:"8px 10px",colorScheme:"dark"}}/></div>
            <div style={{flex:1}}><div style={{color:C.muted,fontSize:10,fontWeight:700,textTransform:"uppercase",marginBottom:4}}>TO</div><input type="date" value={dateTo} min={dateFrom||minDate} max={maxDate} onChange={e=>{setDateTo(e.target.value);resetPages();}} style={{...IS,padding:"8px 10px",colorScheme:"dark"}}/></div>
          </div>
          {rangeActive&&<button onClick={()=>{setDateFrom("");setDateTo("");setShowRange(false);resetPages();}} style={{marginTop:8,background:"none",border:`1px solid ${C.border}`,borderRadius:6,color:C.muted,cursor:"pointer",fontSize:11,padding:"3px 10px",fontWeight:700}}>Clear ✕</button>}
        </div>
      )}
      <div style={{display:"flex",background:"#1e293b",borderRadius:10,padding:3,marginBottom:14,marginTop:showRange?0:12,gap:3}}>
        {[["events",`Events (${filteredEvtsFinal.length})`],["meds",`Meds (${filteredMeds.length})`],["food",`Meals (${filteredFood.length})`]].map(([t,l])=>(
          <button key={t} onClick={()=>{setLogTab(t);resetPages();}} style={{flex:1,padding:"7px 0",borderRadius:8,cursor:"pointer",fontSize:12,fontWeight:700,background:logTab===t?C.card:"transparent",color:logTab===t?C.text:C.muted,border:"none"}}>{l}</button>
        ))}
      </div>
      {logTab==="events"&&(evtGroups.length===0?<p style={{color:"#374151",fontSize:13,textAlign:"center",padding:"30px 0"}}>{q||showPending||rangeActive?"No matching events":"Nothing logged yet"}</p>:<>{evtGroups.slice(evtPage*DAYS_PER_PAGE,(evtPage+1)*DAYS_PER_PAGE).map(g=><DayGroup key={g.key} group={g} renderRow={e=><EventRow key={e.id} e={e} onDelete={e.pending?delPending:delEvent} onEdit={()=>setEditing({type:e.pending?'pendingEvent':'event',item:e})}/>}/>)}<Pager page={evtPage} setPage={setEvtPage} total={evtGroups.length} pages={evtPages} unit="days"/></>)}
      {logTab==="meds"&&(medGroups.length===0?<p style={{color:"#374151",fontSize:13,textAlign:"center",padding:"30px 0"}}>No medications logged</p>:<>{medGroups.slice(medPage*DAYS_PER_PAGE,(medPage+1)*DAYS_PER_PAGE).map(g=><DayGroup key={g.key} group={g} renderRow={e=><MedRow key={e.id} e={e} onDelete={delMed} onEdit={()=>setEditing({type:'med',item:e})}/>}/>)}<Pager page={medPage} setPage={setMedPage} total={medGroups.length} pages={medPages} unit="days"/></>)}
      {logTab==="food"&&(foodGroups.length===0?<p style={{color:"#374151",fontSize:13,textAlign:"center",padding:"30px 0"}}>No meals logged</p>:<>{foodGroups.slice(foodPage*DAYS_PER_PAGE,(foodPage+1)*DAYS_PER_PAGE).map(g=><DayGroup key={g.key} group={g} renderRow={e=><FoodRow key={e.id} e={e} onDelete={delFood} onEdit={()=>setEditing({type:'food',item:e})}/>}/>)}<Pager page={foodPage} setPage={setFoodPage} total={foodGroups.length} pages={foodPages} unit="days"/></>)}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   PHYSICIAN REPORT
   ═══════════════════════════════════════════════════════════ */
function buildReport(events,meds,food){
  const now=new Date();
  const dateStr=toYMD(now);
  const L=[];
  const hr1="═".repeat(60);
  const hr2="─".repeat(60);
  L.push(hr1);
  L.push("FND TRACKER — PHYSICIAN REPORT");
  L.push(`Generated: ${now.toLocaleDateString([],{weekday:"long",year:"numeric",month:"long",day:"numeric"})} at ${fmtTime(now.toISOString())}`);
  L.push(hr1);
  L.push("");
  if(events.length===0){L.push("No events recorded.");return{text:L.join('\n'),dateStr};}
  const sorted=[...events].sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
  const firstDate=new Date(sorted[0].timestamp);
  const lastDate=new Date(sorted[sorted.length-1].timestamp);
  const spanDays=Math.max(1,Math.round((lastDate-firstDate)/864e5)+1);
  L.push("SUMMARY");L.push(hr2);
  L.push(`Total events: ${events.length}`);
  L.push(`Date range: ${fmtDate(sorted[0].timestamp)} – ${fmtDate(sorted[sorted.length-1].timestamp)} (${spanDays} days)`);
  L.push(`Daily average: ${(events.length/spanDays).toFixed(2)} events/day`);
  const last30=events.filter(e=>new Date(e.timestamp)>=new Date(Date.now()-30*864e5));
  L.push(`Last 30 days: ${last30.length} events`);
  L.push("");
  L.push("TIME OF DAY DISTRIBUTION");L.push(hr2);
  const zones=[{label:"Night (12am–6am)",startH:0,endH:6},{label:"Morning (6am–12pm)",startH:6,endH:12},{label:"Afternoon (12pm–6pm)",startH:12,endH:18},{label:"Evening (6pm–12am)",startH:18,endH:24}];
  zones.forEach(z=>{const cnt=events.filter(e=>{const h=new Date(e.timestamp).getHours();return h>=z.startH&&h<z.endH;}).length;const pct=Math.round((cnt/events.length)*100);L.push(`  ${z.label}: ${cnt} (${pct}%)`);});
  L.push("");
  if(meds.length>0){
    L.push("MEDICATIONS LOGGED");L.push(hr2);
    const medCounts={};meds.forEach(m=>{const k=m.name+(m.detail?` ${m.detail}`:"");medCounts[k]=(medCounts[k]||0)+1;});
    Object.entries(medCounts).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>L.push(`  ${k}: ${v} doses`));
    L.push("");
  }
  L.push("RECENT EVENTS (last 30 days)");L.push(hr2);
  last30.sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp)).slice(0,50).forEach(e=>{L.push(`  ${fmtFull(e.timestamp)}${e.notes?`  — ${e.notes}`:""}`);});
  if(last30.length>50)L.push(`  … and ${last30.length-50} more`);
  L.push("");L.push(hr1);
  L.push("Report generated by FND Tracker.");
  return{text:L.join('\n'),dateStr};
}

/* ═══════════════════════════════════════════════════════════
   EXPORT TAB (includes Import)
   ═══════════════════════════════════════════════════════════ */
function ExportTab({events,meds,food,onReset,onImport,deviceName,onRenameDevice,showFlash}){
  const[confirmReset,setConfirmReset]=useState(false);
  const[editingName,setEditingName]=useState(false);
  const[nameInput,setNameInput]=useState(deviceName||'');
  const[importState,setImportState]=useState(null);
  const[importError,setImportError]=useState(null);
  const[showFormat,setShowFormat]=useState(false);
  const[openSection,setOpenSection]=useState(null);
  const fileRef=useRef(null);
  const toggle=s=>setOpenSection(o=>o===s?null:s);

  // ── CSV parsing ──────────────────────────────────────────
  const parseCSV=(text)=>{
    const lines=text.trim().split(/\r?\n/);
    if(lines.length<2)return[];
    const headers=lines[0].split(',').map(h=>h.trim().toLowerCase().replace(/[^a-z0-9_]/g,''));
    return lines.slice(1).map(line=>{
      const cols=[];let cur='';let inQ=false;
      for(let i=0;i<line.length;i++){
        if(line[i]==='"'){inQ=!inQ;}
        else if(line[i]===','&&!inQ){cols.push(cur.trim());cur='';}
        else cur+=line[i];
      }
      cols.push(cur.trim());
      const obj={};headers.forEach((h,i)=>{obj[h]=cols[i]||'';});
      return obj;
    }).filter(r=>Object.values(r).some(v=>v));
  };
  const rowToEvent=(row)=>{
    let ts=null;
    if(row.timestamp)ts=new Date(row.timestamp);
    else if(row.date){const ds=row.date.trim(),ti=(row.time||'00:00').trim();ts=new Date(`${ds}T${ti}`);if(isNaN(ts))ts=new Date(ds);}
    if(!ts||isNaN(ts))return null;
    return{id:uid(),timestamp:ts.toISOString(),notes:row.notes||row.note||''};
  };
  const rowToMed=(row)=>{const b=rowToEvent(row);if(!b)return null;const name=row.name||row.medication||row.med||'';if(!name)return null;return{...b,name,detail:row.detail||row.dose||'',notes:row.notes||row.note||''};};
  const rowToFood=(row)=>{const b=rowToEvent(row);if(!b)return null;const name=row.name||row.food||row.item||'';if(!name)return null;return{...b,name,detail:row.detail||'',category:row.category||''};};

  const handleFileSelect=(e)=>{
    const file=e.target.files[0];if(!file)return;
    setImportError(null);
    const reader=new FileReader();
    reader.onload=(ev)=>{
      try{
        const text=ev.target.result;
        const rows=parseCSV(text);
        if(!rows.length){setImportError("No data rows found. Check the file has a header row and at least one data row.");return;}
        const headers=Object.keys(rows[0]);
        const fname=file.name.toLowerCase();
        let type='events';
        if(fname.includes('med'))type='meds';
        else if(fname.includes('food')||fname.includes('meal'))type='food';
        else if(headers.some(h=>['name','medication','med'].includes(h))&&!headers.some(h=>['food','item','category'].includes(h)))type='meds';
        else if(headers.some(h=>['food','item','category'].includes(h)))type='food';
        let evts=[],meds_=[],food_=[];
        if(type==='meds')meds_=rows.map(rowToMed).filter(Boolean);
        else if(type==='food')food_=rows.map(rowToFood).filter(Boolean);
        else evts=rows.map(rowToEvent).filter(Boolean);
        const total=evts.length+meds_.length+food_.length;
        if(!total){setImportError("Rows found but could not be parsed. See the format guide.");return;}
        setImportState({data:{events:evts,meds:meds_,food:food_},filename:file.name,type});
      }catch(err){setImportError("Could not read file: "+err.message);}
    };
    reader.readAsText(file);e.target.value="";
  };

  const confirmImport=()=>{
    if(!importState)return;
    const hasData=events.length>0||meds.length>0||food.length>0;
    onImport(importState.data,hasData?"merge":"replace");
    setImportState(null);setImportError(null);
  };

  const AccordionHeader=({id,icon,title,desc,color="#93c5fd"})=>{
    const open=openSection===id;
    return(
      <button onClick={()=>toggle(id)} style={{width:"100%",display:"flex",alignItems:"center",gap:12,background:"none",border:"none",cursor:"pointer",textAlign:"left",padding:0}}>
        <div style={{width:36,height:36,borderRadius:10,background:open?color+"22":"#1e293b",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0,border:`1px solid ${open?color:C.border}`}}>{icon}</div>
        <div style={{flex:1}}>
          <div style={{color:open?color:C.text,fontWeight:700,fontSize:14}}>{title}</div>
          <div style={{color:C.muted,fontSize:11,marginTop:1}}>{desc}</div>
        </div>
        <div style={{color:C.muted,fontSize:14,fontWeight:700}}>{open?"▲":"▼"}</div>
      </button>
    );
  };

  const allTs=[...events,...meds,...food].map(e=>new Date(e.timestamp)).filter(d=>!isNaN(d));
  const earliest=allTs.length?new Date(Math.min(...allTs)):null;
  const latest=allTs.length?new Date(Math.max(...allTs)):null;
  const spanDays=earliest&&latest?Math.round((latest-earliest)/864e5)+1:0;

  return(
    <div style={{display:"flex",flexDirection:"column",gap:12}}>

      {/* Dataset overview */}
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:16}}>
        <div style={{color:C.muted,fontSize:10,textTransform:"uppercase",fontWeight:700,letterSpacing:"0.07em",marginBottom:12}}>Dataset Overview</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:spanDays>0?12:0}}>
          {[{icon:"⚡",label:"Events",value:events.length,color:C.green},{icon:"💊",label:"Medications",value:meds.length,color:C.purple},{icon:"🍽",label:"Meals",value:food.length,color:C.teal}].map(({icon,label,value,color})=>(
            <div key={label} style={{background:"#0a0f1a",border:`1px solid ${C.border}`,borderRadius:10,padding:"10px 12px",textAlign:"center"}}>
              <div style={{fontSize:18,marginBottom:4}}>{icon}</div>
              <div style={{color,fontSize:22,fontWeight:800,lineHeight:1}}>{value}</div>
              <div style={{color:C.muted,fontSize:10,marginTop:3}}>{label}</div>
            </div>
          ))}
        </div>
        {spanDays>0&&<div style={{color:C.muted,fontSize:11,textAlign:"center"}}>{fmtDate(earliest.toISOString())} – {fmtDate(latest.toISOString())} · {spanDays} days of data</div>}
      </div>

      {/* Export accordion */}
      <div style={{background:C.card,border:`1px solid ${openSection==="export"?C.green:C.border}`,borderRadius:12,padding:16}}>
        <AccordionHeader id="export" icon="📤" title="Export" desc="Download your data as CSV or a physician report" color={C.green}/>
        {openSection==="export"&&(
          <div style={{marginTop:14,display:"flex",flexDirection:"column",gap:10}}>
            <div style={{background:"#0a0f1a",border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 14px"}}>
              <div style={{color:C.sub,fontSize:12,fontWeight:700,marginBottom:6}}>📋 Physician Report</div>
              <div style={{color:C.muted,fontSize:11,marginBottom:10}}>Readable summary with time-of-day analysis — ideal for your medical team.</div>
              <Btn onClick={()=>{const{text,dateStr}=buildReport(events,meds,food);downloadFile(text,`fnd-physician-report-${dateStr}.txt`,'text/plain');}} fullWidth small>⬇ Download Report (.txt)</Btn>
            </div>
            <div style={{background:"#0a0f1a",border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 14px"}}>
              <div style={{color:C.sub,fontSize:12,fontWeight:700,marginBottom:6}}>📑 CSV Export</div>
              <div style={{color:C.muted,fontSize:11,marginBottom:10}}>Raw data — opens in Excel or Google Sheets, or re-import here.</div>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                <Btn onClick={()=>{const rows=[...events.map(e=>({type:'event',timestamp:e.timestamp,date:fmtDate(e.timestamp),time:fmtTime(e.timestamp),name:'',detail:'',notes:e.notes||''})),...meds.map(m=>({type:'med',timestamp:m.timestamp,date:fmtDate(m.timestamp),time:fmtTime(m.timestamp),name:m.name||'',detail:m.detail||'',notes:m.notes||''})),...food.map(f=>({type:'food',timestamp:f.timestamp,date:fmtDate(f.timestamp),time:fmtTime(f.timestamp),name:f.name||'',detail:f.detail||'',notes:f.notes||''}))].sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));downloadFile(toCSV(rows,['type','timestamp','date','time','name','detail','notes']),`fnd-export-${Date.now()}.csv`,'text/csv');}} fullWidth small>⬇ All data (.csv)</Btn>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
                  <Btn onClick={()=>{const rows=events.map(e=>({timestamp:e.timestamp,date:fmtDate(e.timestamp),time:fmtTime(e.timestamp),notes:e.notes||''}));downloadFile(toCSV(rows,['timestamp','date','time','notes']),`fnd-events-${Date.now()}.csv`,'text/csv');}} variant="secondary" fullWidth small>⬇ Events</Btn>
                  <Btn onClick={()=>{const rows=meds.map(m=>({timestamp:m.timestamp,date:fmtDate(m.timestamp),time:fmtTime(m.timestamp),name:m.name,detail:m.detail||'',notes:m.notes||''}));downloadFile(toCSV(rows,['timestamp','date','time','name','detail','notes']),`fnd-meds-${Date.now()}.csv`,'text/csv');}} variant="secondary" fullWidth small>⬇ Meds</Btn>
                  <Btn onClick={()=>{const rows=food.map(f=>({timestamp:f.timestamp,date:fmtDate(f.timestamp),time:fmtTime(f.timestamp),name:f.name,detail:f.detail||'',notes:f.notes||''}));downloadFile(toCSV(rows,['timestamp','date','time','name','detail','notes']),`fnd-food-${Date.now()}.csv`,'text/csv');}} variant="secondary" fullWidth small>⬇ Food</Btn>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Import accordion */}
      <div style={{background:C.card,border:`1px solid ${openSection==="import"?"#93c5fd":C.border}`,borderRadius:12,padding:16}}>
        <AccordionHeader id="import" icon="📥" title="Import" desc="Load events, medications or meals from a CSV file" color="#93c5fd"/>
        {openSection==="import"&&(
          <div style={{marginTop:14}}>
            {/* Format guide */}
            <button onClick={()=>setShowFormat(f=>!f)} style={{width:"100%",textAlign:"left",background:"#0a1628",border:`1px solid ${showFormat?"#3b82f6":C.border}`,borderRadius:8,padding:"8px 12px",cursor:"pointer",marginBottom:10,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{color:"#93c5fd",fontSize:12,fontWeight:700}}>ℹ️ CSV format guide</span>
              <span style={{color:C.muted,fontSize:11}}>{showFormat?"▲ hide":"▼ show"}</span>
            </button>
            {showFormat&&(
              <div style={{background:"#060d1a",border:"1px solid #1e3a5f",borderRadius:8,padding:12,marginBottom:10,fontSize:11,lineHeight:1.8}}>
                <div style={{color:"#93c5fd",fontWeight:700,marginBottom:6}}>File type is detected from filename:</div>
                <div style={{color:C.muted,marginBottom:10}}>
                  <span style={{color:C.text}}>"med"</span> → Medications · <span style={{color:C.text}}>"food"/"meal"</span> → Meals · Everything else → Events
                </div>
                {[
                  {title:"⚡ Events",sample:"date,time,notes\n2025-03-01,14:32,woke up with headache"},
                  {title:"💊 Medications",sample:"date,time,name,detail,notes\n2025-03-01,08:00,Keppra,500mg,with food"},
                  {title:"🍽 Meals",sample:"date,time,name,category,notes\n2025-03-01,12:30,Pasta,gluten,"},
                ].map(({title,sample})=>(
                  <div key={title} style={{marginBottom:10}}>
                    <div style={{color:"#93c5fd",fontWeight:700,marginBottom:4}}>{title}</div>
                    <div style={{background:"#0f172a",borderRadius:6,padding:"6px 8px",fontFamily:"monospace",color:C.green,fontSize:10,overflowX:"auto",whiteSpace:"pre"}}>{sample}</div>
                  </div>
                ))}
              </div>
            )}
            {/* File picker / merge preview */}
            {!importState?(
              <div>
                {importError&&<div style={{color:"#f87171",fontSize:12,marginBottom:10,padding:"8px 12px",background:"#450a0a",borderRadius:8}}>{importError}</div>}
                <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={handleFileSelect} style={{display:"none"}}/>
                <Btn onClick={()=>fileRef.current.click()} fullWidth>📂 Choose CSV File</Btn>
              </div>
            ):(()=>{
              const hasData=events.length>0||meds.length>0||food.length>0;
              const d=importState.data;
              const incoming=d.events.length+d.meds.length+d.food.length;
              const evtKey=e=>new Date(e.timestamp).toISOString().slice(0,16);
              const itemKey=e=>`${new Date(e.timestamp).toISOString().slice(0,16)}|${(e.name||"").toLowerCase().trim()}`;
              const newEvts=d.events.filter(e=>!new Set(events.map(evtKey)).has(evtKey(e))).length;
              const newMeds=d.meds.filter(e=>!new Set(meds.map(itemKey)).has(itemKey(e))).length;
              const newFood=d.food.filter(e=>!new Set(food.map(itemKey)).has(itemKey(e))).length;
              const newTotal=newEvts+newMeds+newFood;
              const dupes=incoming-newTotal;
              return(
                <div>
                  <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:"10px 14px",marginBottom:12}}>
                    <div style={{color:C.text,fontWeight:700,fontSize:13,marginBottom:4}}>📄 {importState.filename}</div>
                    <div style={{color:C.muted,fontSize:12,marginBottom:4}}>Detected: <span style={{color:C.amber,fontWeight:700}}>{importState.type==="meds"?"Medications":importState.type==="food"?"Meals":"FND Events"}</span></div>
                    <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
                      {d.events.length>0&&<span style={{color:C.muted,fontSize:12}}>⚡ {d.events.length} events</span>}
                      {d.meds.length>0&&<span style={{color:C.muted,fontSize:12}}>💊 {d.meds.length} meds</span>}
                      {d.food.length>0&&<span style={{color:C.muted,fontSize:12}}>🍽 {d.food.length} meals</span>}
                    </div>
                  </div>
                  <div style={{background:hasData?"#0a1628":"#0c1a10",border:`1px solid ${hasData?"#1e3a5f":"#1a3a20"}`,borderRadius:10,padding:"12px 14px",marginBottom:12}}>
                    {hasData?(
                      <>
                        <div style={{color:"#93c5fd",fontWeight:700,fontSize:13,marginBottom:6}}>🔀 Merge preview</div>
                        <div style={{display:"flex",flexDirection:"column",gap:4}}>
                          <div style={{display:"flex",justifyContent:"space-between",fontSize:12}}><span style={{color:C.muted}}>New records</span><span style={{color:C.green,fontWeight:700}}>{newTotal}</span></div>
                          {dupes>0&&<div style={{display:"flex",justifyContent:"space-between",fontSize:12}}><span style={{color:C.muted}}>Already present (skipped)</span><span style={{color:"#4b5563",fontWeight:700}}>{dupes}</span></div>}
                          {newEvts>0&&<div style={{display:"flex",justifyContent:"space-between",fontSize:11}}><span style={{color:"#374151"}}>⚡ Events</span><span style={{color:C.sub}}>+{newEvts}</span></div>}
                          {newMeds>0&&<div style={{display:"flex",justifyContent:"space-between",fontSize:11}}><span style={{color:"#374151"}}>💊 Meds</span><span style={{color:C.sub}}>+{newMeds}</span></div>}
                          {newFood>0&&<div style={{display:"flex",justifyContent:"space-between",fontSize:11}}><span style={{color:"#374151"}}>🍽 Meals</span><span style={{color:C.sub}}>+{newFood}</span></div>}
                          {newTotal===0&&<div style={{color:C.amber,fontSize:12,marginTop:4}}>⚠ All records already exist — nothing new to add.</div>}
                        </div>
                      </>
                    ):(
                      <div style={{color:C.green,fontWeight:700,fontSize:13}}>✅ Ready — {incoming} record{incoming!==1?"s":""} will be loaded</div>
                    )}
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <Btn onClick={()=>{setImportState(null);setImportError(null);}} variant="secondary" fullWidth>Cancel</Btn>
                    <Btn onClick={confirmImport} fullWidth style={{opacity:!hasData||newTotal>0?1:0.4,pointerEvents:!hasData||newTotal>0?"auto":"none"}}>
                      {hasData?`🔀 Merge${newTotal>0?` (+${newTotal})`:""}`:"✅ Import"}
                    </Btn>
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* Device Identity */}
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:16}}>
        <div style={{color:C.muted,fontSize:10,textTransform:"uppercase",fontWeight:700,letterSpacing:"0.07em",marginBottom:12}}>This Device</div>
        {editingName?(
          <div>
            <FInput label="Device / Person Name" value={nameInput} onChange={e=>setNameInput(e.target.value)} autoFocus/>
            <div style={{display:"flex",gap:8}}>
              <Btn onClick={()=>setEditingName(false)} variant="secondary" fullWidth>Cancel</Btn>
              <Btn onClick={()=>{if(!nameInput.trim())return;onRenameDevice(nameInput.trim());setEditingName(false);showFlash('Device name updated');}} fullWidth>Save</Btn>
            </div>
          </div>
        ):(
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <div style={{flex:1}}>
              <div style={{fontWeight:600,fontSize:14}}>{deviceName||"Unknown device"}</div>
              <div style={{color:C.muted,fontSize:11,marginTop:1}}>Name shown on entries from this device</div>
            </div>
            <Btn onClick={()=>{setNameInput(deviceName||'');setEditingName(true);}} variant="secondary" small>Rename</Btn>
          </div>
        )}
      </div>

      {/* Reset */}
      <div style={{background:"#0d0505",border:`1px solid ${confirmReset?"#dc2626":"#3f1a1a"}`,borderRadius:12,padding:16}}>
        <button onClick={()=>setConfirmReset(v=>!v)} style={{width:"100%",display:"flex",alignItems:"center",gap:12,background:"none",border:"none",cursor:"pointer",textAlign:"left",padding:0}}>
          <div style={{width:36,height:36,borderRadius:10,background:confirmReset?"#450a0a":"#1e0a0a",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0,border:`1px solid ${confirmReset?"#dc2626":"#7f1d1d"}`}}>⚠️</div>
          <div style={{flex:1}}><div style={{color:"#f87171",fontWeight:700,fontSize:14}}>Reset App Data</div><div style={{color:C.muted,fontSize:11,marginTop:1}}>Permanently clear all local and server records</div></div>
          <div style={{color:C.muted,fontSize:14,fontWeight:700}}>{confirmReset?"▲":"▼"}</div>
        </button>
        {confirmReset&&(
          <div style={{marginTop:14}}>
            <div style={{color:C.amber,fontSize:12,lineHeight:1.6,marginBottom:12}}>This will permanently delete all your data from Google Drive. Export a backup first.</div>
            <div style={{display:"flex",gap:8}}>
              <Btn onClick={()=>setConfirmReset(false)} variant="secondary" fullWidth>Cancel</Btn>
              <Btn onClick={onReset} danger fullWidth>Yes, Reset Everything</Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   DEVICE SETUP SCREEN
   One-time setup: just give this device a name.
   No accounts, no internet required.
   ═══════════════════════════════════════════════════════════ */
function DeviceSetup({onReady}){
  const[name,setName]=useState('');
  return(
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:"100vh",background:C.bg,color:C.text,padding:"24px",textAlign:"center"}}>
      <div style={{fontSize:"2.5rem",marginBottom:12}}>⚡</div>
      <h1 style={{fontWeight:800,fontSize:"1.5rem",marginBottom:8,color:C.green}}>FND Tracker</h1>
      <p style={{color:C.muted,fontSize:13,marginBottom:6,lineHeight:1.6,maxWidth:340}}>Give this device a name so entries are labelled correctly when syncing between devices.</p>
      <p style={{color:"#374151",fontSize:12,marginBottom:24,maxWidth:320}}>The server must be running on the same network — open the URL it printed at startup.</p>
      <div style={{width:"100%",maxWidth:360}}>
        <FInput label="Device / Person Name" placeholder="e.g. Sarah's Phone, Caregiver Tablet…" value={name} onChange={e=>setName(e.target.value)} autoFocus/>
        <Btn onClick={()=>{const n=name.trim();if(!n)return;localStorage.setItem('fnd_device_name',n);onReady(n);}} fullWidth disabled={!name.trim()}>Start →</Btn>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   MAIN APP
   ═══════════════════════════════════════════════════════════ */
function App(){
  const cf=useChartFont();
  const desk=useDesktop();

  // ── Device identity ─────────────────────────────────────
  const[deviceName,setDeviceName]=useState(()=>localStorage.getItem('fnd_device_name')||'');
  const[appReady,setAppReady]=useState(()=>!!localStorage.getItem('fnd_device_name'));

  // ── Sync state ──────────────────────────────────────────
  const[syncStatus,setSyncStatus]=useState('offline');
  const[lastSynced,setLastSynced]=useState(null);
  const[connectedDevices,setConnectedDevices]=useState([]);
  const syncRef=useRef(null);

  // ── App data — pre-populate from local snapshot if available ─
  const _snap = loadLocalSnapshot();
  const[events,setEvents]=useState(()=>(_snap?.events||[]).sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp)));
  const[pending,setPending]=useState(()=>(_snap?.pending||[]).sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp)));
  const[meds,setMeds]=useState(()=>(_snap?.meds||[]).sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp)));
  const[food,setFood]=useState(()=>(_snap?.food||[]).sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp)));
  const[medLib,setMedLib]=useState(()=>_snap?.medLib||[]);
  const[foodLib,setFoodLib]=useState(()=>_snap?.foodLib||[]);
  const[checkins,setCheckins]=useState(()=>(_snap?.checkins||[]).sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp)));
  const[tab,setTab]=useState("home");
  const[modal,setModal]=useState(null);
  const[revIdx,setRevIdx]=useState(0);
  const[flash,setFlash]=useState(null);
  const[editing,setEditing]=useState(null);

  const showFlash=(msg,color=C.green)=>{setFlash({msg,color});setTimeout(()=>setFlash(null),2500);};

  // ── Boot: remove loader immediately (data already in state from snapshot) ──
  useEffect(()=>{
    document.getElementById('root-loader')?.remove();
  },[]);

  // ── Process incoming server data ───────────────────────────
  const applyServerData = useCallback((payload, mode) => {
    const byTs = (a,b) => new Date(b.timestamp) - new Date(a.timestamp);
    if (mode === 'full') {
      const merge = (local, remote) => {
        const ids = new Set(local.map(x => x.id));
        return [...local, ...remote.filter(x => x && !ids.has(x.id))];
      };
      setEvents(ev  => merge(ev,  payload.events   ||[]).sort(byTs));
      setMeds(m     => merge(m,   payload.meds     ||[]).sort(byTs));
      setFood(f     => merge(f,   payload.food     ||[]).sort(byTs));
      setCheckins(c => merge(c,   payload.checkins ||[]).sort(byTs));
      setLastSynced(new Date().toISOString());
    } else if (mode === 'patch') {
      for (const change of payload) {
        if (change._delete) {
          const rmId = change.id;
          setEvents(ev  => ev.filter(x => x.id !== rmId));
          setMeds(m     => m.filter(x => x.id !== rmId));
          setFood(f     => f.filter(x => x.id !== rmId));
          setCheckins(c => c.filter(x => x.id !== rmId));
          setPending(p  => p.filter(x => x.id !== rmId));
          continue;
        }
        const upsert = (setter) => setter(arr => {
          if (arr.some(x => x.id === change.id))
            return arr.map(x => x.id === change.id ? change : x).sort(byTs);
          return [change, ...arr].sort(byTs);
        });
        if (change._type === 'event')   upsert(setEvents);
        else if (change._type === 'med')   upsert(setMeds);
        else if (change._type === 'food')  upsert(setFood);
        else if (change._type === 'checkin') upsert(setCheckins);
      }
    }
  }, []);

  // ── Initialise sync engine once device is named ────────────
  useEffect(() => {
    if (!appReady) return;
    const sync = new ServerSync({
      onData: applyServerData,
      onStatus: s => { setSyncStatus(s); if (s === 'synced') setLastSynced(new Date().toISOString()); },
      onDevices: setConnectedDevices,
    });
    syncRef.current = sync;
    return () => { try { sync.ws?.close(); } catch {} };
  }, [appReady, applyServerData]);

  // ── Data mutation helpers ─────────────────────────────────
  // Each helper: (1) updates local state immediately, (2) saves snapshot
  // for offline resilience, (3) pushes the change to the server.
  const snap=()=>({events,pending,meds,food,medLib,foodLib,checkins});
  const byTs=(a,b)=>new Date(b.timestamp)-new Date(a.timestamp);

  const addEvent=e=>{const n=[e,...events].sort(byTs);setEvents(n);saveLocalSnapshot({...snap(),events:n});syncRef.current?.push({...e,_type:'event'});showFlash("⚡ Event logged");};
  const addMed=e=>{const n=[e,...meds].sort(byTs);setMeds(n);saveLocalSnapshot({...snap(),meds:n});syncRef.current?.push({...e,_type:'med'});showFlash("💊 Medication logged",C.purple);};
  const addFood=e=>{const n=[e,...food].sort(byTs);setFood(n);saveLocalSnapshot({...snap(),food:n});syncRef.current?.push({...e,_type:'food'});showFlash("🍽 Meal logged",C.teal);};
  const addCheckin=async c=>{const n=[c,...checkins];setCheckins(n);saveLocalSnapshot({...snap(),checkins:n});syncRef.current?.push({...c,_type:'checkin'});showFlash("✓ Check-in saved");};
  const delEvent=id=>{const n=events.filter(e=>e.id!==id);setEvents(n);saveLocalSnapshot({...snap(),events:n});syncRef.current?.pushDelete(id);};
  const delPending=id=>{const n=pending.filter(e=>e.id!==id);setPending(n);syncRef.current?.pushDelete(id);};
  const delMed=id=>{const n=meds.filter(e=>e.id!==id);setMeds(n);saveLocalSnapshot({...snap(),meds:n});syncRef.current?.pushDelete(id);};
  const delFood=id=>{const n=food.filter(e=>e.id!==id);setFood(n);saveLocalSnapshot({...snap(),food:n});syncRef.current?.pushDelete(id);};
  const saveMedLib=lib=>{const clean=(lib||[]).filter(Boolean);setMedLib(clean);saveLocalSnapshot({...snap(),medLib:clean});};
  const saveFoodLib=lib=>{const clean=(lib||[]).filter(Boolean);setFoodLib(clean);saveLocalSnapshot({...snap(),foodLib:clean});};
  const updateEvent=updated=>{
    const np=pending.filter(e=>e.id!==updated.id);
    const ne=[updated,...events.filter(e=>e.id!==updated.id)].sort(byTs);
    setPending(np);setEvents(ne);setEditing(null);
    saveLocalSnapshot({...snap(),events:ne,pending:np});
    syncRef.current?.push({...updated,_type:'event'});
    showFlash("✅ Event updated");
  };
  const updateMed=updated=>{const n=meds.map(e=>e.id===updated.id?updated:e).sort(byTs);setMeds(n);setEditing(null);saveLocalSnapshot({...snap(),meds:n});syncRef.current?.push({...updated,_type:'med'});showFlash("✅ Medication updated",C.purple);};
  const updateFood=updated=>{const n=food.map(e=>e.id===updated.id?updated:e).sort(byTs);setFood(n);setEditing(null);saveLocalSnapshot({...snap(),food:n});syncRef.current?.push({...updated,_type:'food'});showFlash("✅ Meal updated",C.teal);};

  const quickLog=()=>{
    const e={id:uid(),timestamp:nowISO(),pending:true,userName:deviceName};
    const np=[e,...pending];setPending(np);
    saveLocalSnapshot({...snap(),pending:np});
    syncRef.current?.push({...e,_type:'event'});
    showFlash(syncRef.current?.connected?"⚡ Event timestamped!":"⚡ Timestamped (queued)",syncRef.current?.connected?C.green:C.amber);
  };
  const openReview=()=>{setRevIdx(0);setModal("review");};
  const handleReviewSave=details=>{
    const saved={...pending[revIdx],...details,pending:false};
    const ne=[saved,...events.filter(e=>e.id!==saved.id)].sort(byTs);
    const np=pending.filter((_,i)=>i!==revIdx);
    setEvents(ne);setPending(np);
    saveLocalSnapshot({...snap(),events:ne,pending:np});
    syncRef.current?.push({...saved,_type:'event'});
    if(!np.length){setModal(null);showFlash("✅ All events reviewed!");}
    else setRevIdx(i=>Math.min(i,np.length-1));
  };
  const handleReviewSkip=()=>{
    const n=[...pending.slice(0,revIdx),...pending.slice(revIdx+1),pending[revIdx]];
    setPending(n);
    if(revIdx>=n.length)setRevIdx(0);
    if(n.length===1){setModal(null);showFlash("Saved for later",C.amber);}
  };
  const approveAll=()=>{
    const approved=pending.map(e=>({...e,pending:false}));
    const ne=[...approved,...events].sort(byTs);
    setEvents(ne);setPending([]);
    saveLocalSnapshot({...snap(),events:ne,pending:[]});
    approved.forEach(e=>syncRef.current?.push({...e,_type:'event'}));
    showFlash(`✅ Approved ${approved.length} event${approved.length!==1?"s":""}!`);
  };
  const resetApp=()=>{
    setEvents([]);setPending([]);setMeds([]);setFood([]);setMedLib([]);setFoodLib([]);setCheckins([]);
    saveLocalSnapshot({events:[],pending:[],meds:[],food:[],medLib:[],foodLib:[],checkins:[]});
    showFlash("🗑 All local data cleared",C.amber);
  };
  const handleImport=(imported,mode)=>{
    const byId=e=>e.id;
    const dedup=(existing,incoming)=>{const ids=new Set(existing.map(byId));return[...existing,...incoming.filter(e=>e&&!ids.has(byId(e)))];};
    if(mode==="replace"){
      const ne=imported.events||[];const nm=imported.meds||[];const nf=imported.food||[];
      setEvents(ne.sort(byTs));setMeds(nm.sort(byTs));setFood(nf.sort(byTs));
      saveLocalSnapshot({events:ne,pending:[],meds:nm,food:nf,medLib,foodLib,checkins});
      ne.forEach(e=>syncRef.current?.push({...e,_type:'event'}));
      nm.forEach(m=>syncRef.current?.push({...m,_type:'med'}));
      nf.forEach(f=>syncRef.current?.push({...f,_type:'food'}));
      showFlash(`✅ Replaced with ${ne.length} events, ${nm.length} meds, ${nf.length} meals`);
    }else{
      const ne=dedup(events,imported.events||[]).sort(byTs);
      const nm=dedup(meds,imported.meds||[]).sort(byTs);
      const nf=dedup(food,imported.food||[]).sort(byTs);
      setEvents(ne);setMeds(nm);setFood(nf);
      const added=(ne.length-events.length)+(nm.length-meds.length)+(nf.length-food.length);
      saveLocalSnapshot({...snap(),events:ne,meds:nm,food:nf});
      ne.filter(e=>!events.some(x=>x.id===e.id)).forEach(e=>syncRef.current?.push({...e,_type:'event'}));
      nm.filter(m=>!meds.some(x=>x.id===m.id)).forEach(m=>syncRef.current?.push({...m,_type:'med'}));
      nf.filter(f=>!food.some(x=>x.id===f.id)).forEach(f=>syncRef.current?.push({...f,_type:'food'}));
      showFlash(`✅ Merged — ${added} new record${added!==1?"s":""} added`);
    }
  };
  const handleRenameDevice=name=>{setDeviceName(name);syncRef.current?.setDeviceName(name);};
  const manualSync=()=>syncRef.current?.fetchFull()||showFlash('Reconnecting…',C.amber);

  // ── Computed ──────────────────────────────────────────────
  const todayEvents=filterFrom(events,startOf("day"));
  const weekEvents=filterFrom(events,startOf("week"));
  const now7start=new Date();now7start.setDate(now7start.getDate()-6);now7start.setHours(0,0,0,0);
  const pri7start=new Date();pri7start.setDate(pri7start.getDate()-13);pri7start.setHours(0,0,0,0);
  const pri7end=new Date();pri7end.setDate(pri7end.getDate()-7);pri7end.setHours(23,59,59,999);
  const last7=events.filter(e=>new Date(e.timestamp)>=now7start).length;
  const prev7=events.filter(e=>{const t=new Date(e.timestamp);return t>=pri7start&&t<=pri7end;}).length;
  const avgLast7=(last7/7).toFixed(1);
  const trendDiff=last7-prev7;
  const trendPct=prev7>0?Math.round(Math.abs(trendDiff/prev7)*100):null;
  const trendUp=trendDiff>0,trendDown=trendDiff<0,trendFlat=trendDiff===0;
  const reviewing=modal==="review"&&pending[revIdx];

  // ── Render gate ───────────────────────────────────────────
  // Show DeviceSetup on first launch (no device name stored yet)
  if(!appReady) return <DeviceSetup onReady={name=>{setDeviceName(name);setAppReady(true);}}/>;

  // ── Sync status label ─────────────────────────────────────
  const queueLen=syncRef.current?.queue?.length||0;
  const syncLabel=syncStatus==='saving'?'Saving…':syncStatus==='connecting'?'Connecting…':syncStatus==='offline'&&queueLen>0?`${queueLen} queued`:syncStatus==='offline'?'Offline':'✓ Synced';
  const syncColor=syncStatus==='offline'?C.amber:syncStatus==='synced'?C.green:C.sub;
  const userInfo={name:deviceName,email:''};

  // ── HOME CONTENT ──────────────────────────────────────────
  const pad2=n=>String(n).padStart(2,'0');
  const fmtMins=m=>{const h=Math.floor(m/60),min=m%60;return h===0?`12:${pad2(min)}am`:h<12?`${h}:${pad2(min)}am`:h===12?`12:${pad2(min)}pm`:`${h-12}:${pad2(min)}pm`;};
  const minsOfDay=events.map(e=>{const t=new Date(e.timestamp);return t.getHours()*60+t.getMinutes();});
  const sortedMins=[...minsOfDay].sort((a,b)=>a-b);
  const medMins=sortedMins.length?sortedMins.length%2===0?Math.round((sortedMins[sortedMins.length/2-1]+sortedMins[sortedMins.length/2])/2):sortedMins[Math.floor(sortedMins.length/2)]:null;
  const last14=Array.from({length:14},(_,i)=>{const d=new Date(Date.now()-(13-i)*864e5);d.setHours(0,0,0,0);const de=new Date(d);de.setHours(23,59,59,999);const cnt=events.filter(e=>{const t=new Date(e.timestamp);return t>=d&&t<=de;}).length;const ord=n=>{const s=['th','st','nd','rd'],v=n%100;return n+(s[(v-20)%10]||s[v]||s[0]);};return{d,cnt,label:ord(d.getDate())};});
  const max14=Math.max(1,...last14.map(d=>d.cnt));
  // Streak = consecutive days with no events, counting backwards from yesterday
  // (today with events doesn't break the streak — you haven't "had a bad day yet")
  let streak=0;const curD=new Date();curD.setHours(0,0,0,0);
  const todayHasEvent=events.some(e=>new Date(e.timestamp).toDateString()===curD.toDateString());
  if(!todayHasEvent){
    // Today is clear — count today + prior clear days
    for(let d=new Date(curD);d>=new Date(curD.getTime()-90*864e5);d.setDate(d.getDate()-1)){
      if(events.some(e=>new Date(e.timestamp).toDateString()===d.toDateString()))break;
      streak++;
    }
  }
  const clearDays30=Array.from({length:30},(_,i)=>{const d=new Date(Date.now()-i*864e5);d.setHours(0,0,0,0);return !events.some(e=>new Date(e.timestamp).toDateString()===d.toDateString());}).filter(Boolean).length;
  const last30=events.filter(e=>new Date(e.timestamp)>=new Date(Date.now()-30*864e5));
  const prior30=events.filter(e=>{const t=new Date(e.timestamp);return t>=new Date(Date.now()-60*864e5)&&t<new Date(Date.now()-30*864e5);});
  const avg30=(last30.length/30).toFixed(1);
  const monthDiff=last30.length-prior30.length;
  const monthPct=prior30.length>0?Math.round(Math.abs(monthDiff/prior30.length)*100):null;
  const sortedEvts=[...events].sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
  let longestGapDays=0;
  for(let i=1;i<sortedEvts.length;i++){const gap=(new Date(sortedEvts[i].timestamp)-new Date(sortedEvts[i-1].timestamp))/(864e5);if(gap>longestGapDays)longestGapDays=gap;}
  const dowCounts=Array.from({length:7},(_,i)=>events.filter(e=>new Date(e.timestamp).getDay()===i).length);
  const dowNames=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const peakDow=dowCounts.indexOf(Math.max(...dowCounts));
  const quietDow=dowCounts.indexOf(Math.min(...dowCounts));
  const maxDow=Math.max(1,...dowCounts);

  const homeContent=(
    <div>
      {pending.length>0&&(
        <button onClick={openReview} style={{width:"100%",background:"linear-gradient(135deg,#78350f,#92400e)",border:"1px solid #b45309",borderRadius:12,padding:"13px 16px",marginBottom:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",textAlign:"left"}}>
          <div><div style={{color:C.amber,fontWeight:700,fontSize:14}}>🕐 {pending.length} event{pending.length>1?"s":""} need{pending.length===1?"s":""} details</div><div style={{color:"#d97706",fontSize:12,marginTop:2}}>Tap to add notes</div></div>
          <div style={{background:"#b45309",borderRadius:99,minWidth:28,height:28,display:"flex",alignItems:"center",justifyContent:"center",color:"#fef3c7",fontWeight:800,fontSize:14,flexShrink:0}}>{pending.length}</div>
        </button>
      )}
      <div style={{display:"grid",gridTemplateColumns:desk?"repeat(4,1fr)":"1fr 1fr",gap:10,marginBottom:14}}>
        {[{label:"Today",color:todayEvents.length===0?C.green:C.amber,val:todayEvents.length,sub:todayEvents.length===0?"clear 🌙":"events today"},{label:"This Week",color:C.teal,val:weekEvents.length,sub:"events this week"},{label:"30-Day Avg",color:monthDiff<0?C.green:monthDiff>0?C.red:C.amber,val:avg30,sub:monthPct!=null?`${monthDiff>0?"↑":"↓"} ${monthPct}% vs prior 30d`:"per day"},{label:"Meds Today",color:C.purple,val:filterFrom(meds,startOf("day")).length,sub:"taken today"}].map(({label,color,val,sub})=>(
          <div key={label} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"14px 16px"}}>
            <div style={{color:C.muted,fontSize:10,textTransform:"uppercase",fontWeight:700,marginBottom:4,letterSpacing:"0.06em"}}>{label}</div>
            <div style={{color,fontSize:desk?36:26,fontWeight:800,lineHeight:1}}>{val}</div>
            <div style={{color:C.muted,fontSize:11,marginTop:4}}>{sub}</div>
          </div>
        ))}
      </div>
      {/* 14-day overview */}
      <div style={{background:C.card,border:`1px solid ${trendDown?C.green:trendUp?C.red:C.border}`,borderRadius:12,padding:16,marginBottom:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
          <div>
            <div style={{color:C.muted,fontSize:10,textTransform:"uppercase",fontWeight:700,letterSpacing:"0.06em",marginBottom:4}}>14-Day Overview</div>
            <div style={{display:"flex",alignItems:"baseline",gap:8}}>
              <span style={{color:C.text,fontSize:desk?34:24,fontWeight:800,lineHeight:1}}>{avgLast7}</span>
              <span style={{color:C.muted,fontSize:11}}>/day avg (last 7)</span>
              <span style={{color:trendDown?C.green:trendUp?C.red:C.muted,fontSize:15,fontWeight:700}}>{trendDown?"↓":trendUp?"↑":"→"} {trendFlat?"stable":trendPct!=null?`${trendPct}%`:"—"}</span>
            </div>
          </div>
          <div style={{display:"flex",gap:10,alignItems:"center"}}>
            {medMins!==null&&<div style={{textAlign:"right"}}><div style={{color:C.muted,fontSize:9,fontWeight:700,textTransform:"uppercase"}}>Median time</div><div style={{color:C.amber,fontSize:14,fontWeight:800}}>{fmtMins(medMins)}</div></div>}
            <div style={{textAlign:"right"}}><div style={{color:C.muted,fontSize:9,fontWeight:700,textTransform:"uppercase"}}>Clear (30d)</div><div style={{color:C.teal,fontSize:14,fontWeight:800}}>{clearDays30}</div></div>
            {streak>0&&<div style={{background:"#052e16",border:`1px solid ${C.green}`,borderRadius:8,padding:"5px 12px",textAlign:"center"}}><div style={{color:C.green,fontSize:16,fontWeight:800,lineHeight:1}}>{streak}d</div><div style={{color:C.muted,fontSize:9,fontWeight:700,marginTop:2}}>STREAK</div></div>}
          </div>
        </div>
        <div style={{display:"flex",gap:4,alignItems:"flex-end",height:desk?90:54,marginBottom:6}}>
          {last14.map(({d,cnt},i)=>{const isToday=i===13;const isThisWeek=i>=7;const col=cnt===0?"#1e293b":isToday?C.green:"#1d4ed8";const opacity=cnt===0?1:isToday?1:isThisWeek?0.85:0.45;return(<div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2,height:"100%",justifyContent:"flex-end"}}>{cnt>0&&<span style={{fontSize:cf.barLabel,color:isToday?C.green:C.muted,fontWeight:700,lineHeight:1}}>{cnt}</span>}<div style={{width:"100%",borderRadius:"3px 3px 0 0",background:col,opacity,height:cnt===0?3:`${Math.max(5,Math.round((cnt/max14)*100))}%`,boxShadow:isToday&&cnt>0?`0 0 10px ${C.green}66`:""}}/></div>);})}
        </div>
        <div style={{display:"flex",gap:4}}>{last14.map(({label},i)=><div key={i} style={{flex:1,textAlign:"center",fontSize:cf.axisLabel,color:i===13?C.green:i>=7?C.sub:C.muted,fontWeight:i===13?700:400,lineHeight:1.2}}>{label}</div>)}</div>
        <div style={{display:"flex",gap:4,marginTop:4}}><div style={{flex:7,textAlign:"center",fontSize:9,color:C.muted,borderTop:`1px solid ${C.border}`,paddingTop:3}}>prior week</div><div style={{flex:7,textAlign:"center",fontSize:9,color:C.sub,borderTop:"1px solid #1d4ed8",paddingTop:3}}>this week → today</div></div>
      </div>
      {/* Stat tiles */}
      <div style={{display:"grid",gridTemplateColumns:desk?"1fr 1fr 1fr 1fr":"1fr 1fr",gap:10,marginBottom:14}}>
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"14px 16px"}}><div style={{color:C.muted,fontSize:10,textTransform:"uppercase",fontWeight:700,letterSpacing:"0.06em",marginBottom:4}}>Longest Gap</div><div style={{color:C.teal,fontSize:desk?32:22,fontWeight:800,lineHeight:1}}>{longestGapDays>0?`${Math.round(longestGapDays)}d`:"—"}</div><div style={{color:C.muted,fontSize:11,marginTop:4}}>between events</div></div>
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"14px 16px"}}><div style={{color:C.muted,fontSize:10,textTransform:"uppercase",fontWeight:700,letterSpacing:"0.06em",marginBottom:4}}>Total Recorded</div><div style={{color:C.sub,fontSize:desk?32:22,fontWeight:800,lineHeight:1}}>{events.length}</div><div style={{color:C.muted,fontSize:11,marginTop:4}}>all time</div></div>
        <div style={{background:streak>0?"#052e16":C.card,border:`1px solid ${streak>0?C.green:C.border}`,borderRadius:12,padding:"14px 16px"}}><div style={{color:C.muted,fontSize:10,textTransform:"uppercase",fontWeight:700,letterSpacing:"0.06em",marginBottom:4}}>{streak>0?"Streak":"Clear Days (30d)"}</div><div style={{color:streak>0?C.green:C.teal,fontSize:desk?32:22,fontWeight:800,lineHeight:1}}>{streak>0?`${streak}d`:clearDays30}</div><div style={{color:C.muted,fontSize:11,marginTop:4}}>{streak>0?"seizure-free 🌙":"days without events"}</div></div>
        {/* Sync status tile */}
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"14px 16px",cursor:"pointer"}} onClick={manualSync}>
          <div style={{color:C.muted,fontSize:10,textTransform:"uppercase",fontWeight:700,letterSpacing:"0.06em",marginBottom:4}}>Server Sync</div>
          <div style={{color:syncColor,fontSize:desk?20:16,fontWeight:800,lineHeight:1.2}}>{syncLabel}</div>
          <div style={{color:C.muted,fontSize:11,marginTop:4}}>{connectedDevices.length>0?`${connectedDevices.length} device${connectedDevices.length!==1?'s':''} online`:lastSynced?`Last: ${fmtTime(lastSynced)}`:"Tap to refresh"}</div>
        </div>
      </div>
    </div>
  );

  const tabs=[{id:"home",label:"Home",icon:"🏠"},{id:"trends",label:"Trends",icon:"📊"},{id:"log",label:"History",icon:"📋"},{id:"export",label:"Import/Export",icon:"📤"}];
  const tabContent=(
    <>
      {tab==="home"&&homeContent}
      {tab==="trends"&&<TrendsTab events={events} food={food}/>}
      {tab==="log"&&<LogTab events={events} pending={pending} meds={meds} food={food} delEvent={delEvent} delPending={delPending} delMed={delMed} delFood={delFood} setEditing={setEditing} approveAll={approveAll}/>}
      {tab==="export"&&<ExportTab events={events} meds={meds} food={food} onReset={resetApp} onImport={handleImport} deviceName={deviceName} onRenameDevice={handleRenameDevice} showFlash={showFlash}/>}
    </>
  );

  const modals=(
    <>
      {modal==="med"&&<QuickLogModal type="med" library={medLib} onLog={addMed} onClose={()=>setModal(null)} onOpenLibrary={()=>setModal("medLib")}/>}
      {modal==="food"&&<QuickLogModal type="food" library={foodLib} onLog={addFood} onClose={()=>setModal(null)} onOpenLibrary={()=>setModal("foodLib")}/>}
      {modal==="medLib"&&<LibraryModal type="med" library={medLib} onSave={saveMedLib} onClose={()=>setModal(null)}/>}
      {modal==="foodLib"&&<LibraryModal type="food" library={foodLib} onSave={saveFoodLib} onClose={()=>setModal(null)}/>}
      {modal==="checkin"&&<CheckInWizard userInfo={userInfo} onSave={async c=>{await addCheckin(c);setModal(null);}} onCancel={()=>setModal(null)}/>}
      {modal==="review"&&reviewing&&(
        <Modal title="Add Event Details" subtitle={`Logged at ${fmtFull(reviewing.timestamp)} · ${revIdx+1} of ${pending.length}`} onClose={()=>setModal(null)}>
          <div style={{background:"#1e293b",borderRadius:99,height:4,marginBottom:20}}><div style={{background:C.green,borderRadius:99,height:"100%",transition:"width .35s ease",width:`${((revIdx+1)/pending.length)*100}%`}}/></div>
          <SeizureForm key={reviewing.id} initial={{timestamp:reviewing.timestamp}} showTs={false} onSave={handleReviewSave} onCancel={()=>setModal(null)} saveLabel={pending.length>1?"Save & Next →":"Save Event"}/>
          {pending.length>1&&<button onClick={handleReviewSkip} style={{width:"100%",marginTop:8,background:"none",border:"none",color:C.muted,fontSize:12,cursor:"pointer",padding:"6px 0"}}>Skip for now →</button>}
        </Modal>
      )}
      {editing?.type==='event'&&<EditEventModal e={editing.item} onSave={updateEvent} onClose={()=>setEditing(null)}/>}
      {editing?.type==='pendingEvent'&&<EditEventModal e={editing.item} onSave={updateEvent} onClose={()=>setEditing(null)}/>}
      {editing?.type==='med'&&<EditMedModal e={editing.item} onSave={updateMed} onClose={()=>setEditing(null)}/>}
      {editing?.type==='food'&&<EditFoodModal e={editing.item} onSave={updateFood} onClose={()=>setEditing(null)}/>}
    </>
  );

  const flashBanner=flash&&(
    <div style={{position:"fixed",top:16,left:"50%",transform:"translateX(-50%)",background:C.card,border:`1px solid ${flash.color}`,color:flash.color,padding:"10px 20px",borderRadius:99,zIndex:200,fontWeight:700,fontSize:14,whiteSpace:"nowrap",animation:"fadeIn .2s ease",boxShadow:"0 4px 20px rgba(0,0,0,.4)"}}>{flash.msg}</div>
  );

  const SIDEBAR_W=220;

  // ── Desktop layout ────────────────────────────────────────
  if(desk) return(
    <div style={{display:"flex",minHeight:"100vh",background:C.bg,color:C.text,fontFamily:"DM Sans,Segoe UI,sans-serif"}}>
      {flashBanner}
      <aside style={{width:SIDEBAR_W,flexShrink:0,background:"#060d12",borderRight:`1px solid ${C.border}`,display:"flex",flexDirection:"column",position:"fixed",top:0,left:0,height:"100vh",zIndex:40,overflowY:"auto"}}>
        <div style={{padding:"26px 18px 16px"}}>
          <div style={{color:C.green,fontWeight:800,fontSize:18,letterSpacing:-0.5}}>⚡ FND Tracker</div>
          <div style={{color:"#374151",fontSize:11,marginTop:3}}>{new Date().toLocaleDateString([],{weekday:"long",month:"long",day:"numeric"})}</div>
          <div style={{marginTop:14,background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"10px 14px",display:"flex",gap:12,alignItems:"center"}}>
            <div style={{textAlign:"center"}}><div style={{color:C.green,fontSize:32,fontWeight:800,lineHeight:1}}>{todayEvents.length}</div><div style={{color:C.muted,fontSize:12}}>today</div></div>
            <div style={{height:32,width:1,background:C.border}}/>
            <div style={{textAlign:"center"}}><div style={{color:C.teal,fontSize:26,fontWeight:800,lineHeight:1}}>{events.length}</div><div style={{color:C.muted,fontSize:12}}>total</div></div>
          </div>
        </div>
        <nav style={{flex:1,padding:"4px 10px"}}>
          {tabs.map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)} style={{width:"100%",display:"flex",alignItems:"center",gap:11,padding:"10px 12px",marginBottom:3,borderRadius:10,cursor:"pointer",background:tab===t.id?C.greenDk:"transparent",border:tab===t.id?"1px solid #059669":"1px solid transparent",color:tab===t.id?C.green:C.muted,fontWeight:tab===t.id?700:400,fontSize:13,textAlign:"left"}}>
              <span style={{fontSize:17,flexShrink:0}}>{t.icon}</span>
              <span style={{flex:1}}>{t.label}</span>
              {t.id==="log"&&pending.length>0&&<span style={{background:"#b45309",color:"#fef3c7",fontSize:9,fontWeight:800,borderRadius:99,minWidth:18,height:18,display:"flex",alignItems:"center",justifyContent:"center",padding:"0 4px"}}>{pending.length}</span>}
            </button>
          ))}
        </nav>
        <div style={{padding:"12px 10px 24px",borderTop:`1px solid ${C.border}`}}>
          <div style={{color:C.muted,fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:10,paddingLeft:4}}>Quick Log</div>
          <button onClick={quickLog} style={{width:"100%",background:`linear-gradient(135deg,${C.greenDk},#047857)`,border:"2px solid #059669",borderRadius:12,padding:"12px 14px",cursor:"pointer",display:"flex",alignItems:"center",gap:10,marginBottom:8,boxShadow:"0 0 14px rgba(110,231,183,0.15)"}}>
            <span style={{fontSize:22}}>⚡</span>
            <div><div style={{color:C.green,fontWeight:800,fontSize:13,lineHeight:1}}>Log Event</div><div style={{color:"#34d399",fontSize:10,marginTop:1}}>Tap to timestamp</div></div>
          </button>
          <button onClick={()=>setModal("checkin")} style={{width:"100%",background:"#0a1628",border:"1px solid #1e3a5f",borderRadius:9,padding:"9px 12px",cursor:"pointer",display:"flex",alignItems:"center",gap:9,marginBottom:7}}>
            <span style={{fontSize:17}}>📋</span><span style={{color:"#93c5fd",fontWeight:700,fontSize:12}}>Daily Check-in</span>
          </button>
          <button onClick={()=>setModal("med")} style={{width:"100%",background:"#0f0f2e",border:"1px solid #312e81",borderRadius:9,padding:"9px 12px",cursor:"pointer",display:"flex",alignItems:"center",gap:9,marginBottom:7}}>
            <span style={{fontSize:17}}>💊</span><span style={{color:C.purple,fontWeight:700,fontSize:12}}>Medication</span>
          </button>
          <button onClick={()=>setModal("food")} style={{width:"100%",background:"#052e16",border:"1px solid #166534",borderRadius:9,padding:"9px 12px",cursor:"pointer",display:"flex",alignItems:"center",gap:9}}>
            <span style={{fontSize:17}}>🍽</span><span style={{color:C.teal,fontWeight:700,fontSize:12}}>Log Meal</span>
          </button>
        </div>
        <div style={{padding:"10px 18px 20px",borderTop:`1px solid ${C.border}`}}>
          <button onClick={manualSync} style={{width:"100%",background:"none",border:`1px solid ${C.border}`,borderRadius:8,padding:"7px 12px",cursor:"pointer",display:"flex",alignItems:"center",gap:8,color:syncColor,fontSize:12,fontWeight:600}}>
            <span>{syncStatus==='synced'?'✓':'⏳'}</span><span style={{flex:1}}>{syncLabel}</span>
          </button>
          {connectedDevices.length>0&&<div style={{color:C.muted,fontSize:10,textAlign:"center",marginTop:5}}>{connectedDevices.map(d=>d.name||d.id).join(' · ')}</div>}
        </div>
      </aside>
      <main style={{marginLeft:SIDEBAR_W,flex:1,minHeight:"100vh"}}>
        <div style={{position:"sticky",top:0,zIndex:30,background:C.bg,borderBottom:`1px solid ${C.border}`,padding:"15px 32px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div style={{color:C.text,fontWeight:700,fontSize:17}}>{tabs.find(t=>t.id===tab)?.icon} {tabs.find(t=>t.id===tab)?.label}</div>
          <div style={{color:C.muted,fontSize:12}}>{events.length} events · {meds.length} meds · {food.length} meals · {checkins.length} check-ins</div>
        </div>
        <div style={{width:"100%",padding:"24px 32px",flex:1}}>{tabContent}</div>
      </main>
      {modals}
      <style>{`@keyframes fadeIn{from{opacity:0;transform:translateX(-50%) translateY(-8px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}`}</style>
    </div>
  );

  // ── Mobile layout ─────────────────────────────────────────
  return(
    <div style={{background:C.bg,minHeight:"100vh",color:C.text,fontFamily:"DM Sans,Segoe UI,sans-serif",maxWidth:480,margin:"0 auto",position:"relative",paddingBottom:148}}>
      {flashBanner}
      <div style={{padding:"20px 18px 0",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{color:C.green,fontWeight:800,fontSize:22,letterSpacing:-0.5}}>⚡ FND Tracker</div>
          <div style={{color:"#374151",fontSize:12}}>{new Date().toLocaleDateString([],{weekday:"long",month:"long",day:"numeric"})}</div>
        </div>
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"6px 14px",textAlign:"center",cursor:"pointer"}} onClick={manualSync}>
          <div style={{color:C.green,fontSize:22,fontWeight:800,lineHeight:1}}>{todayEvents.length}</div>
          <div style={{color:C.muted,fontSize:10}}>today</div>
          <div style={{color:syncColor,fontSize:9,marginTop:1}}>{connectedDevices.length>0?`${connectedDevices.length} online`:syncLabel}</div>
        </div>
      </div>
      <div style={{padding:"14px 18px"}}>{tabContent}</div>
      {/* Bottom action bar */}
      <div style={{position:"fixed",bottom:0,left:"50%",transform:"translateX(-50%)",width:"min(480px,100%)",zIndex:50}}>
        <div style={{background:C.surface,borderTop:`1px solid ${C.border}`,padding:"10px 14px",display:"flex",gap:8,alignItems:"stretch"}}>
          {/* ⚡ Log Event — primary CTA */}
          <button onClick={quickLog} style={{flex:"0 0 auto",background:`linear-gradient(135deg,${C.greenDk},#047857)`,border:"2px solid #059669",borderRadius:14,padding:"12px 14px",cursor:"pointer",display:"flex",alignItems:"center",gap:8,boxShadow:"0 0 18px rgba(110,231,183,0.18)"}}>
            <span style={{fontSize:24}}>⚡</span>
            <div><div style={{color:C.green,fontWeight:800,fontSize:13,lineHeight:1}}>Log Event</div><div style={{color:"#34d399",fontSize:10,marginTop:2}}>Tap to timestamp</div></div>
          </button>
          <div style={{flex:1,display:"flex",flexDirection:"column",gap:6}}>
            <button onClick={()=>setModal("checkin")} style={{flex:1,background:"#0a1628",border:"1px solid #1e3a5f",borderRadius:10,padding:"8px 10px",cursor:"pointer",display:"flex",alignItems:"center",gap:7}}>
              <span style={{fontSize:15}}>📋</span><span style={{color:"#93c5fd",fontWeight:700,fontSize:12}}>Check-in</span>
            </button>
            <div style={{display:"flex",gap:6,flex:1}}>
              <button onClick={()=>setModal("med")} style={{flex:1,background:"#0f0f2e",border:"1px solid #312e81",borderRadius:10,padding:"7px 8px",cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>
                <span style={{fontSize:14}}>💊</span><span style={{color:C.purple,fontWeight:700,fontSize:11}}>Meds</span>
              </button>
              <button onClick={()=>setModal("food")} style={{flex:1,background:"#052e16",border:"1px solid #166534",borderRadius:10,padding:"7px 8px",cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>
                <span style={{fontSize:14}}>🍽</span><span style={{color:C.teal,fontWeight:700,fontSize:11}}>Meal</span>
              </button>
            </div>
          </div>
        </div>
        {/* Bottom tab nav */}
        <div style={{background:C.bg,borderTop:`1px solid ${C.card}`,display:"flex"}}>
          {tabs.map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)} style={{flex:1,padding:"10px 0",background:"none",border:"none",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:2,position:"relative"}}>
              <span style={{fontSize:16}}>{t.icon}</span>
              <span style={{fontSize:9,color:tab===t.id?C.green:"#4b5563",fontWeight:600}}>{t.label}</span>
              {t.id==="log"&&pending.length>0&&<span style={{position:"absolute",top:6,right:"16%",background:"#b45309",color:"#fef3c7",fontSize:8,fontWeight:800,borderRadius:99,minWidth:15,height:15,display:"flex",alignItems:"center",justifyContent:"center",padding:"0 3px"}}>{pending.length}</span>}
            </button>
          ))}
        </div>
      </div>
      {modals}
      <style>{`@keyframes fadeIn{from{opacity:0;transform:translateX(-50%) translateY(-8px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}`}</style>
    </div>
  );
}

try{
  const root=ReactDOM.createRoot(document.getElementById('root'));
  root.render(<App/>);
  document.getElementById('root-loader')?.remove();
}catch(e){
  const loader=document.getElementById('root-loader');
  if(loader){
    loader.style.display='flex';
    loader.innerHTML=`<div style="padding:20px;max-width:90vw;text-align:left;font-family:monospace;background:#111827;border-radius:8px;border:1px solid #7f1d1d;color:#f87171;font-size:12px;overflow-wrap:break-word">
      <div style="font-size:16px;margin-bottom:8px">⚠️ App failed to load</div>
      <div>${e.message}</div>
      <div style="margin-top:8px;color:#6b7280;font-size:10px">${(e.stack||'').slice(0,400)}</div>
      <button onclick="location.reload()" style="margin-top:12px;padding:8px 16px;border-radius:8px;border:1px solid #374151;background:#1f2937;color:#e5e7eb;cursor:pointer;font-family:inherit">Reload</button>
    </div>`;
  }
}
