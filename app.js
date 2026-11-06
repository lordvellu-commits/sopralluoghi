"use strict";
/* =====================================================================
   SOPRALLUOGHI PERITI
   Dati: sul telefono (IndexedDB) e su Supabase. Si lavora anche senza
   rete: quello che manca si invia appena la rete torna.
   ===================================================================== */
const CFG=window.CONFIG||{};
const BUCKET="sopralluoghi";
const LIMITE=(Number(CFG.LIMITE_GB)||1)*1024*1024*1024;
const GIORNI_PROMEMORIA=Number(CFG.GIORNI_PROMEMORIA)||2;
const ERA_RECUPERO=/type=recovery/.test(location.hash);
/* ripulisco i valori incollati: spazi, virgolette, pezzi in più dopo l'indirizzo del progetto */
const URL_SB=String(CFG.SUPABASE_URL||"").trim().replace(/^["'\s]+|["'\s]+$/g,"").replace(/\/(rest|auth|storage)\/v1.*$/,"").replace(/\/+$/,"");
const KEY_SB=String(CFG.SUPABASE_KEY||"").replace(/\s+/g,"").replace(/^["']+|["']+$/g,"");
function problemaConfig(){
  if(!URL_SB||!KEY_SB||/INCOLLA/.test(URL_SB+KEY_SB))return"vuota";
  if(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(URL_SB))return`L'indirizzo in config.js non sembra quello di un progetto Supabase (dovrebbe essere tipo https://abcdefgh.supabase.co). Adesso c'è: ${URL_SB}`;
  if(/^sb_secret_/.test(KEY_SB))return"In config.js hai incollato la chiave segreta (sb_secret_…). Va tolta subito e sostituita con la Publishable key (sb_publishable_…).";
  if(!/^sb_publishable_/.test(KEY_SB)&&!/^eyJ/.test(KEY_SB))return"La chiave in config.js non sembra giusta: deve cominciare con sb_publishable_ (oppure con eyJ se è la vecchia chiave anon).";
  return"";}
const PROBLEMA_CONFIG=problemaConfig();
const configOk=!PROBLEMA_CONFIG;
const sb=(configOk&&window.supabase)?supabase.createClient(URL_SB,KEY_SB,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}}):null;
let UTENTE=null;

/* ---------- elenchi ---------- */
const BASE={
  tipi:["Appartamento","Villetta a schiera","Villa singola","Casa indipendente","Porzione di bifamiliare","Attico","Ufficio","Negozio","Capannone","Autorimessa","Altro"],
  stati:["Nuovo","Seminuovo","Usato","Da ristrutturare","Ristrutturato"],
  manut:["Ottimo","Buono","Discreto","Mediocre","Scarso"],
  zone:["Centro","Semicentro","Periferia","Agricola","Suburbana"],
  sempre:["VERIFICA CESPITI"],
  presenti:["Agente","Broker","Proprietario","Acquirente"],
  stanze:["Ingr","Sogg","Cuc","Angolo cott","Pranzo","Cam","Cam matr","Bagno","WC","Rip","Disimp","Corr","Studio","Lav","Balc","Terr","Log","Cant","Gar","Soff","CT","Scala"],
  livelli:["Piano terra","Piano 1","Piano 2","Piano 3","Seminterrato","Cantina","Garage","Soffitta","Sottotetto"]};
const NOMI_ELENCHI=[["presenti","Chi era presente al sopralluogo"],["tipi","Tipo immobile"],["stati","Stato"],["manut","Stato manutentivo (interno e fabbricato)"],["zone","Zona"],["sempre","Documenti da mettere sempre tra i mancanti"],["stanze","Nomi dei vani nello schizzo"],["livelli","Livelli dello schizzo"]];
let L=JSON.parse(JSON.stringify(BASE));
const SINO=[["ascensore","Ascensore comune"],["riscAuton","Riscaldamento autonomo"],["clima","Climatizzazione"],["fotovoltaico","Impianto fotovoltaico"],["solare","Pannelli solari"]];
const MAXKB=250;

/* piccola memoria del browser, per utente */
const chiave=k=>`sopr:${UTENTE?UTENTE.id:"-"}:${k}`;
function leggiCache(k,def=null){try{const v=localStorage.getItem(chiave(k));return v==null?def:JSON.parse(v)}catch(e){return def}}
function scriviCache(k,v){try{localStorage.setItem(chiave(k),JSON.stringify(v))}catch(e){}}
function applicaElenchi(s){L=JSON.parse(JSON.stringify(BASE));if(s)for(const k in BASE)if(Array.isArray(s[k]))L[k]=s[k]}
function salvaElenchi(){scriviCache("elenchi",L);scriviCache("elenchiDaInviare",true);programmaSync(500);return true}

/* ---------- archivio sul telefono (IndexedDB) ---------- */
let db=null; const mem={pratiche:new Map(),foto:new Map()};
function apriDB(uidUtente){return new Promise(res=>{try{const r=indexedDB.open("sopralluoghi-"+uidUtente,1);
  r.onupgradeneeded=()=>{const d=r.result;d.createObjectStore("pratiche",{keyPath:"id"});const f=d.createObjectStore("foto",{keyPath:"id"});f.createIndex("pid","pid")};
  r.onsuccess=()=>{db=r.result;res()};r.onerror=()=>res();}catch(e){res()}})}
function tx(store,mode,fn){return new Promise((res,rej)=>{if(!db){res(fn(null));return}
  try{const t=db.transaction(store,mode);const s=t.objectStore(store);const out=fn(s);t.oncomplete=()=>res(out&&out.result!==undefined?out.result:out);t.onerror=()=>rej(t.error)}catch(e){rej(e)}})}
const salvaPratica=p=>db?tx("pratiche","readwrite",s=>s.put(p)):(mem.pratiche.set(p.id,p),Promise.resolve());
const tuttePratiche=()=>db?tx("pratiche","readonly",s=>s.getAll()):Promise.resolve([...mem.pratiche.values()]);
const getPratica=id=>db?tx("pratiche","readonly",s=>s.get(id)):Promise.resolve(mem.pratiche.get(id));
const salvaFoto=f=>db?tx("foto","readwrite",s=>s.put(f)):(mem.foto.set(f.id,f),Promise.resolve());
const fotoDi=pid=>db?tx("foto","readonly",s=>s.index("pid").getAll(pid)):Promise.resolve([...mem.foto.values()].filter(f=>f.pid===pid));
const tutteFoto=()=>db?tx("foto","readonly",s=>s.getAll()):Promise.resolve([...mem.foto.values()]);
const togliFotoLocale=id=>db?tx("foto","readwrite",s=>s.delete(id)):(mem.foto.delete(id),Promise.resolve());
async function eliminaLocale(id){const fs=await fotoDi(id);for(const f of fs)await togliFotoLocale(f.id);
  if(db)await tx("pratiche","readwrite",s=>s.delete(id));else mem.pratiche.delete(id)}

/* ---------- utilità ---------- */
const $=s=>document.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);
function uuid(){if(crypto.randomUUID)return crypto.randomUUID();const b=crypto.getRandomValues(new Uint8Array(16));b[6]=b[6]&15|64;b[8]=b[8]&63|128;
  const h=[...b].map(x=>x.toString(16).padStart(2,"0")).join("");return`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`}
const cartella=p=>`${p.num||"senza-numero"} - ${p.richiedente||"senza-richiedente"}`.replace(/[\\/:*?"<>|]+/g," ").replace(/\s+/g," ").trim();
function toast(t,ms=2800){const e=$("#toast");e.textContent=t;e.hidden=false;clearTimeout(toast.h);toast.h=setTimeout(()=>e.hidden=true,ms)}
function euro(v){const n=Number(String(v).replace(/\./g,"").replace(",","."));return isFinite(n)&&n>0?"€ "+n.toLocaleString("it-IT",{maximumFractionDigits:0}):""}
const mb=b=>b<1024*1024*1024?(b/1048576).toLocaleString("it-IT",{maximumFractionDigits:b<10485760?1:0})+" MB":(b/1073741824).toLocaleString("it-IT",{maximumFractionDigits:2})+" GB";
const percorsoFoto=f=>`${UTENTE.id}/${f.pid}/${f.id}.jpg`;
const percorsoScheda=p=>`${UTENTE.id}/${p.id}/scheda.pdf`;
function messaggioErrore(e){const m=(e&&(e.message||e.error_description||e.error))||String(e);
  if(/Failed to fetch|NetworkError|Load failed|network/i.test(m))return"connessione assente o instabile";
  if(/exceed|quota|too large|413/i.test(m))return"spazio pieno o file troppo grande";
  if(/JWT|token|not authenticated|401/i.test(m))return"accesso scaduto: esci e rientra";
  return m}

/* modifica di una pratica: si salva sul telefono e si mette in coda per l'invio */
let salvaTimer=null,inSospeso=null;
function salvaDopo(p){p.aggiornata=Date.now();p.daInviare=true;inSospeso=p;clearTimeout(salvaTimer);
  salvaTimer=setTimeout(()=>{inSospeso=null;salvaPratica(p).catch(()=>toast("Non riesco a salvare sul telefono"));programmaSync()},400)}
function salvaSubito(){if(inSospeso){clearTimeout(salvaTimer);const p=inSospeso;inSospeso=null;return salvaPratica(p).then(()=>programmaSync(800))}return Promise.resolve()}

/* ---------- lettura della scheda ---------- */
/* rimette insieme le righe di testo: i pezzi attaccati restano attaccati, quelli staccati prendono uno spazio */
function ricomponi(arr){const rows=[];[...arr].sort((a,b)=>b.y-a.y||a.x-b.x).forEach(i=>{const r=rows.find(r=>Math.abs(r.y-i.y)<3);r?r.p.push(i):rows.push({y:i.y,p:[i]})});
  return rows.map(r=>{r.p.sort((a,b)=>a.x-b.x);let out="",fine=null;for(const i of r.p){if(fine!=null&&(!i.w&&!r.p[0].w?true:i.x-fine>1.2))out+=" ";out+=i.s;fine=i.x+(i.w||0)}return out.replace(/\s+/g," ").trim()}).filter(Boolean)}
/* codice perizia.ABI: tollera spazi o virgola al posto del punto e numeri attaccati davanti (es. il telefono) */
function trovaNumero(testi){for(const t of testi){const re=/(\d{6,})\s*[.,]\s*(\d{5})(?!\d)/g;let m;
  while((m=re.exec(t))){const a=m[1].length>9?m[1].slice(-9):m[1];return a+"."+m[2]}}return""}
function leggiScheda(items){
  const it=items.map(i=>({s:String(i.s).replace(/[\u200b-\u200d\ufeff]/g,"").replace(/\u00a0/g," "),x:i.x,y:i.y,w:i.w||0})).filter(i=>i.s.trim()).map(i=>({...i,s:i.s.trim()}));
  const find=re=>it.find(i=>re.test(i.s));
  const sotto=(lab,dx,dy)=>!lab?[]:it.filter(i=>i!==lab&&i.y<lab.y-1&&i.y>lab.y-dy&&i.x>lab.x-6&&i.x<lab.x+dx).sort((a,b)=>b.y-a.y||a.x-b.x);
  const cli=find(/^CLIENTE$/),tipo=find(/^TIPO OPERAZIONE/),ind=find(/^INDIRIZZO$/);
  const box=cli?it.filter(i=>i.y<cli.y-1&&(!tipo||i.y>tipo.y)&&i.x<(ind?ind.x-5:9999)).sort((a,b)=>b.y-a.y||a.x-b.x):[];
  const righeBox=ricomponi(box);
  const num=trovaNumero([...righeBox,righeBox.join(""),...ricomponi(it)]);
  const indir=ind?it.filter(i=>i.y<ind.y-1&&(!tipo||i.y>tipo.y)&&i.x>ind.x-6).sort((a,b)=>b.y-a.y||a.x-b.x).map(i=>i.s).join(", "):"";
  const dl=find(/^SOPRALLUOGO/);
  const data=((sotto(dl,160,40).map(i=>i.s).find(s=>/\d{2}\/\d{2}\/\d{4}/.test(s))||"").match(/\d{2}\/\d{2}\/\d{4}/)||[""])[0];
  const vl=find(/^VALORE TRANSAZIONE/);
  const vt=(sotto(vl,130,30).map(i=>i.s).find(s=>/\d/.test(s))||"").replace(/[^\d.,]/g,"");
  const righe=[];[...it].sort((a,b)=>b.y-a.y||a.x-b.x).forEach(i=>{const r=righe.find(r=>Math.abs(r.y-i.y)<3);r?r.p.push(i):righe.push({y:i.y,p:[i]})});
  const testo=righe.map(r=>r.p.sort((a,b)=>a.x-b.x).map(i=>i.s).join(" ")).join("\n");
  const mancanti=[];
  for(const m of testo.matchAll(/manca(?:no|nte|nti)?\s*:?\s*([^\n]+)/gi)){
    m[1].split(/,|\+|;|\/|\be\b/).map(s=>s.trim().replace(/[.\s]+$/,"")).filter(s=>s&&s===s.toUpperCase()&&/[A-Z]/.test(s)).forEach(s=>{if(!mancanti.includes(s))mancanti.push(s)});
  }
  const chk=find(/^CHECK LIST/);
  return {num,richiedente:righeBox.find(r=>/[A-Za-zÀ-ÿ]{2}/.test(r))||"",indirizzo:indir,data,vt,mancanti,planCat:/PLAN\.?\s*CAT/.test(testo),anc:{chk:chk?chk.y:null,vt:vl?vl.y:null}};
}
async function leggiPdf(file){
  if(!window.pdfjsLib)throw new Error("lettore PDF non caricato");
  pdfjsLib.GlobalWorkerOptions.workerSrc="lib/pdf.worker.min.js";
  const doc=await pdfjsLib.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
  const pg=await doc.getPage(1);const c=await pg.getTextContent();
  return leggiScheda(c.items.map(i=>({s:i.str,x:i.transform[4],y:i.transform[5],w:i.width||0})));
}


/* ---------- nuova pratica ---------- */
function nuovaPratica(d){const ora=Date.now();return{id:uuid(),creata:ora,aggiornata:ora,daInviare:true,inviata:false,haScheda:false,scaricata:null,
  scheda:d.file||null,anc:d.anc||null,vtDaScheda:!!d.vt,
  num:d.num||"",richiedente:d.richiedente||"",indirizzo:d.indirizzo||"",data:d.data||new Date().toLocaleDateString("it-IT"),
  planCat:!!d.planCat,
  campi:{presenti:[],vt:d.vt||"",tipo:"",tipoAltro:"",stato:"",manInt:"",manEst:"",zona:"",piano:"",interno:"",ascensore:"",riscAuton:"",clima:"",fotovoltaico:"",solare:""},
  appunti:"",
  mancanti:[...(d.mancanti||[]).filter(m=>!L.sempre.includes(m)),...L.sempre].map(n=>({nome:n,fatto:false}))}}

/* ---------- frase per il database ---------- */
function frase(p){
  const c=p.campi;const low=s=>(s||"").toLowerCase();
  const tipo=c.tipo==="Altro"?c.tipoAltro:c.tipo;
  const pezzi=[];
  const pr=(c.presenti||[]).map(low);
  const prT=pr.length>1?pr.slice(0,-1).join(", ")+" e "+pr[pr.length-1]:pr[0];
  pezzi.push(`${p.data||"[data]"} sopralluogo effettuato con ${prT||"[chi era presente]"}`);
  const imm=[low(tipo)||"[tipo immobile]",low(c.stato)||"[stato]",low(c.manInt)||"[st. manutentivo interno]"].join(" ");
  pezzi.push(`${imm} in fabbricato ${low(c.manEst)||"[st. manutentivo esterno]"}`);
  const v=euro(c.vt); if(v)pezzi.push(`compravendita a ${v}`);
  const ap=(p.appunti||"").replace(/\s+/g," ").trim().replace(/[.;,\s]+$/,""); if(ap)pezzi.push(ap);
  const aperti=p.mancanti.filter(m=>!m.fatto).map(m=>m.nome);
  if(aperti.length)pezzi.push(`in attesa di ${aperti.join(", ")}`);
  pezzi.push(aperti.length?"sospesa":"in lavorazione");
  return pezzi.join(", ");
}
const mancaPresenti=p=>!((p.campi.presenti||[]).length);
function bloccaSeManca(p){if(!mancaPresenti(p))return false;toast("Indica prima chi era presente al sopralluogo");const s=document.getElementById("boxPresenti");if(s)s.scrollIntoView({behavior:"smooth",block:"center"});return true}
const statoPratica=p=>p.mancanti.some(m=>!m.fatto)?"sospesa":"in lavorazione";

/* ---------- foto: riduzione sotto i 250 KB ---------- */
let TELA=null;
/* apre la foto: prima il metodo veloce, se il telefono non lo regge quello classico */
async function apriImmagine(file){
  try{const b=await createImageBitmap(file,{imageOrientation:"from-image"});return{img:b,w:b.width,h:b.height,chiudi:()=>{try{b.close()}catch(e){}}}}catch(e){}
  const url=URL.createObjectURL(file);
  try{const img=new Image();img.src=url;await img.decode();return{img,w:img.naturalWidth,h:img.naturalHeight,chiudi:()=>URL.revokeObjectURL(url)}}
  catch(e){URL.revokeObjectURL(url);throw new Error("foto non leggibile")}}
async function riduci(file){
  const im=await apriImmagine(file);
  if(!TELA)TELA=document.createElement("canvas");
  try{let lato=1920,q=.82,blob=null;
    for(let giro=0;giro<12;giro++){
      const k=Math.min(1,lato/Math.max(im.w,im.h)),w=Math.max(1,Math.round(im.w*k)),h=Math.max(1,Math.round(im.h*k));
      TELA.width=w;TELA.height=h;const ctx=TELA.getContext("2d");if(!ctx)throw new Error("memoria del telefono piena");
      ctx.drawImage(im.img,0,0,w,h);
      blob=await new Promise(r=>TELA.toBlob(r,"image/jpeg",q));
      if(blob&&blob.size<=MAXKB*1024)break;
      if(q>.6)q-=.08;else{lato=Math.round(lato*.85);q=.78}}
    if(!blob)throw new Error("riduzione non riuscita");
    return blob}
  finally{im.chiudi();TELA.width=1;TELA.height=1}}
async function dataScatto(file){try{if(window.exifr){const e=await exifr.parse(file,["DateTimeOriginal","CreateDate","DateTime"]);const d=e&&(e.DateTimeOriginal||e.CreateDate||e.DateTime);if(d&&!isNaN(+new Date(d)))return +new Date(d)}}catch(e){}return file.lastModified||Date.now()}


/* ---------- scheda compilata sul modello vuoto (coordinate in punti, origine in alto a sinistra) ---------- */
const POS={
  sino:{ascensore:[201.2,221.2,563.2],riscAuton:[201.2,221.2,571.2],fotovoltaico:[201.2,221.2,579.8],solare:[201.2,221.2,587.5],clima:[336.2,356.5,563.2]},
  colonne:[217.8,260.2,321.8,370.2,431.2],
  stati:[["nuovo"],["seminuovo"],["usato"],["da ristrutturare","da ristrutt."],["ristrutturato"]],
  zone:[["centro"],["semicentro","s.centro"],["periferia"],["agricola","agric."],["suburbana","suburb."]],
  rigaStato:604.0, rigaZona:612.0
};
const AMMESSI="€‘’“”–—…•";
const pulito=s=>String(s||"").replace(/\s+/g," ").trim().replace(/[^\x20-\x7E\xA0-\xFF]/g,ch=>AMMESSI.includes(ch)?ch:"?");
function aCapo(testo,font,size,larghezze){
  const parole=pulito(testo).split(" ").filter(Boolean),righe=[];let r="";
  for(const w of parole){const prova=r?r+" "+w:w;const max=larghezze[Math.min(righe.length,larghezze.length-1)];
    if(font.widthOfTextAtSize(prova,size)<=max||!r)r=prova;else{righe.push(r);r=w}}
  if(r)righe.push(r);return righe;
}
async function pdfCampi(p,modelloBytes,PDFLib,originale){
  const {PDFDocument,StandardFonts,rgb}=PDFLib;const c=p.campi;
  const doc=await PDFDocument.load(modelloBytes);let pg=doc.getPage(0);const H=pg.getHeight();
  // via commenti e riquadri aggiunti sopra il PDF (annotazioni): nella scheda finale resta solo la stampa
  doc.getPages().forEach(x=>x.node.delete(PDFLib.PDFName.of("Annots")));
  const f=await doc.embedFont(StandardFonts.Helvetica),fb=await doc.embedFont(StandardFonts.HelveticaBold);
  const ink=rgb(0.06,0.18,0.5);
  // sulla scheda originale la parte bassa puo' essere spostata: la riallineo sulla riga CHECK LIST (modello vuoto: 280.9) e su VALORE TRANSAZIONE (630.1)
  const a=originale&&p.anc?p.anc:{};const dB=a.chk?280.9-a.chk:0,dV=a.vt?630.1-a.vt:0;
  const T=(s,x,yTop,size=9,font=f)=>{const t=pulito(s);if(t)pg.drawText(t,{x,y:H-yTop,size,font,color:ink})};
  const X=(x,yTop)=>{const a={x:x+1.3,y:H-yTop-5.7},b={x:x+5.7,y:H-yTop-1.3};
    pg.drawLine({start:a,end:b,thickness:1.2,color:ink});pg.drawLine({start:{x:a.x,y:b.y},end:{x:b.x,y:a.y},thickness:1.2,color:ink})};
  // intestazione
  if(!originale){T(p.richiedente,90,114);T(p.num,90,126);
    aCapo(p.indirizzo,f,9,[265]).slice(0,3).forEach((r,i)=>T(r,302,114+12*i));
    T(p.data,408,200);}
  const v=euro(c.vt);if(v&&!(originale&&p.vtDaScheda))T(v,408,229+dV);
  // check list
  for(const k in POS.sino){const [xn,xs,y]=POS.sino[k];if(c[k]==="no")X(xn,y+dB);else if(c[k]==="si")X(xs,y+dB)}
  const segna=(val,tab,riga)=>{const v=(val||"").toLowerCase();const i=tab.findIndex(a=>a.includes(v));if(v&&i>=0){X(POS.colonne[i],riga);return true}return !v};
  const statoSul=segna(c.stato,POS.stati,POS.rigaStato+dB),zonaSul=segna(c.zona,POS.zone,POS.rigaZona+dB);
  T(c.piano,106,609.6+dB,8.5);T(c.interno,176,609.6+dB,8.5);
  // appunti sulla riga e sotto
  let y=651+dB;const sz=8.5,passo=11;
  const scrivi=(testo,font=f,prima=[373],dopo=[412],x1=124,x2=85)=>{aCapo(testo,font,sz,[...prima,...dopo]).forEach((r,i)=>{
    if(y>820){pg=doc.addPage([pg.getWidth(),H]);y=60}T(r,i===0?x1:x2,y,sz,font);y+=passo})};
  if((p.appunti||"").trim())scrivi(p.appunti);else y+=passo;
  // dati in più che sulla scheda non hanno un posto
  y+=8;const etichetta=(lab,val)=>{if(!pulito(val))return;if(y>820){pg=doc.addPage([pg.getWidth(),H]);y=60}
    pg.drawText(lab,{x:85,y:H-y,size:sz,font:fb,color:ink});const w=fb.widthOfTextAtSize(lab+" ",sz);
    aCapo(val,f,sz,[412-w,412]).forEach((r,i)=>{if(i>0&&y>820){pg=doc.addPage([pg.getWidth(),H]);y=60}T(r,i===0?85+w:85,y,sz);y+=passo})};
  etichetta("Presenti al sopralluogo:",(c.presenti||[]).join(", ").toLowerCase());
  etichetta("Tipo immobile:",c.tipo==="Altro"?c.tipoAltro:c.tipo);
  if(!statoSul)etichetta("Stato:",c.stato);
  if(!zonaSul)etichetta("Zona:",c.zona);
  etichetta("St. manutentivo interno:",c.manInt);
  etichetta("St. manutentivo fabbricato:",c.manEst);
  etichetta("Documenti mancanti:",p.mancanti.filter(m=>!m.fatto).map(m=>m.nome).join(", "));
  y+=4;etichetta("Frase per il database:",frase(p));
  return await doc.save();
}
async function schedaCompilata(p,schedaBlob){if(!window.PDFLib)throw new Error("pdf-lib non caricato");
  if(schedaBlob){try{return await pdfCampi(p,new Uint8Array(await schedaBlob.arrayBuffer()),window.PDFLib,true)}catch(e){console.warn(e)}}
  const r=await fetch("modello-scheda.pdf");if(!r.ok)throw new Error("modello della scheda non trovato");
  return pdfCampi(p,new Uint8Array(await r.arrayBuffer()),window.PDFLib,false)}

/* ---------- sincronizzazione con Supabase ---------- */
const STATO={inCorso:false,errore:null,ultimo:null,spazio:null,daInviare:0,avanz:""};
let syncTimer=null,syncDiNuovo=false;
function programmaSync(ms=2500){clearTimeout(syncTimer);syncTimer=setTimeout(sincronizza,ms)}
const datiServer=p=>({creata:p.creata,indirizzo:p.indirizzo,data:p.data,planCat:p.planCat,campi:p.campi,appunti:p.appunti,mancanti:p.mancanti,
  schizzo:p.schizzo||null,anc:p.anc||null,vtDaScheda:!!p.vtDaScheda,scaricata:p.scaricata||null,haScheda:!!p.haScheda});
async function tutteLeRighe(tabella,colonne){const out=[];for(let da=0;;da+=1000){const {data,error}=await sb.from(tabella).select(colonne).range(da,da+999);
  if(error)throw error;out.push(...data);if(data.length<1000)return out}}
function inMemoria(id){if(corrente&&corrente.id===id)return corrente;if(E.p&&E.p.id===id)return E.p;return null}
async function codaEliminazioni(){return leggiCache("eliminazioni",[])}

async function inviaEliminazioni(){let coda=await codaEliminazioni();
  for(const el of [...coda]){
    if(el.tipo==="foto"){const {error}=await sb.storage.from(BUCKET).remove([el.path]);if(error)throw error;
      const {error:e2}=await sb.from("foto").delete().eq("id",el.id);if(e2)throw e2}
    coda=coda.filter(x=>x!==el);scriviCache("eliminazioni",coda)}}
async function inviaPratiche(){
  for(const letta of await tuttePratiche()){if(!letta.daInviare)continue;
    const p=inMemoria(letta.id)||letta,t0=p.aggiornata;
    if(p.scheda&&!p.haScheda){STATO.avanz="Invio la scheda…";disegnaStato();
      const {error}=await sb.storage.from(BUCKET).upload(percorsoScheda(p),p.scheda,{upsert:true,contentType:"application/pdf"});if(error)throw error;p.haScheda=true}
    const {error}=await sb.from("pratiche").upsert({id:p.id,num:p.num,richiedente:p.richiedente,aggiornata:new Date(p.aggiornata).toISOString(),dati:datiServer(p)});
    if(error)throw error;
    p.inviata=true;if(p.aggiornata===t0)p.daInviare=false;
    if(!inSospeso||inSospeso.id!==p.id)await salvaPratica(p)}}
async function inviaFoto(){
  const tutte=(await tutteFoto()).filter(f=>!f.caricata&&f.blob);let i=0;
  for(const f of tutte){i++;const p=await getPratica(f.pid);if(!p||!p.inviata)continue;
    STATO.avanz=`Invio foto ${i} di ${tutte.length}…`;disegnaStato();
    const {error}=await sb.storage.from(BUCKET).upload(percorsoFoto(f),f.blob,{upsert:true,contentType:"image/jpeg"});if(error)throw error;
    const {error:e2}=await sb.from("foto").upsert({id:f.id,pratica:f.pid,quando:new Date(f.quando||Date.now()).toISOString(),byte:f.blob.size});if(e2)throw e2;
    f.caricata=true;await salvaFoto(f)}}
async function inviaElenchi(){if(!leggiCache("elenchiDaInviare",false))return;
  const {error}=await sb.from("profili").update({elenchi:L}).eq("id",UTENTE.id);if(error)throw error;scriviCache("elenchiDaInviare",false)}
async function ricevi(){
  STATO.avanz="Controllo gli aggiornamenti…";disegnaStato();
  const righe=await tutteLeRighe("pratiche","id,num,richiedente,aggiornata,dati");
  const locali=new Map((await tuttePratiche()).map(p=>[p.id,p])),remoti=new Set();
  for(const r of righe){remoti.add(r.id);const l=inMemoria(r.id)||locali.get(r.id),t=Date.parse(r.aggiornata)||0;
    if(l&&l.daInviare)continue;
    if(!l||t>(l.aggiornata||0)){const nuova={...(l||{}),...(r.dati||{}),id:r.id,num:r.num||"",richiedente:r.richiedente||"",aggiornata:t,daInviare:false,inviata:true,scheda:l?l.scheda||null:null};
      if(l&&inMemoria(r.id))Object.assign(l,nuova);await salvaPratica(l&&inMemoria(r.id)?l:nuova)}}
  for(const l of locali.values())if(!remoti.has(l.id)&&l.inviata&&!l.daInviare&&!inMemoria(l.id))await eliminaLocale(l.id);
  const fr=await tutteLeRighe("foto","id,pratica,quando,byte");
  const lf=new Map((await tutteFoto()).map(f=>[f.id,f])),rs=new Set();
  for(const r of fr){rs.add(r.id);if(!lf.has(r.id))await salvaFoto({id:r.id,pid:r.pratica,quando:Date.parse(r.quando)||0,blob:null,caricata:true,byte:r.byte||0})}
  for(const f of lf.values())if(f.caricata&&!rs.has(f.id))await togliFotoLocale(f.id);
  const {data:prof}=await sb.from("profili").select("elenchi,deve_cambiare_password").eq("id",UTENTE.id).maybeSingle();
  if(prof){scriviCache("profilo",prof);if(prof.elenchi&&!leggiCache("elenchiDaInviare",false)){applicaElenchi(prof.elenchi);scriviCache("elenchi",L)}}
  const {data:sp,error:es}=await sb.rpc("spazio_studio");if(!es){STATO.spazio=Number(sp)||0;scriviCache("spazio",STATO.spazio)}}
async function sincronizza(){
  if(!sb||!UTENTE)return;
  if(STATO.inCorso){syncDiNuovo=true;return}
  if(!navigator.onLine){await contaDaInviare();disegnaStato();return}
  STATO.inCorso=true;STATO.errore=null;STATO.avanz="";disegnaStato();
  try{await salvaSubito();await inviaEliminazioni();await inviaPratiche();await inviaFoto();await inviaElenchi();await ricevi();STATO.ultimo=Date.now()}
  catch(e){console.warn(e);STATO.errore=messaggioErrore(e)}
  finally{STATO.inCorso=false;STATO.avanz="";await contaDaInviare();disegnaStato();dopoSync();
    if(syncDiNuovo){syncDiNuovo=false;programmaSync(500)}}}
async function contaDaInviare(){const ps=await tuttePratiche(),fs=await tutteFoto();
  STATO.daInviare=ps.filter(p=>p.daInviare).length+fs.filter(f=>!f.caricata).length+(await codaEliminazioni()).length}
function disegnaStato(){const b=$("#stato");if(!b||!UTENTE){if(b)b.hidden=true;return}b.hidden=false;let t,c;
  if(!navigator.onLine){t=STATO.daInviare?`Senza rete · ${STATO.daInviare} da inviare`:"Senza rete";c="p-warn"}
  else if(STATO.inCorso){t=STATO.avanz||"Sincronizzo…";c="p-mute"}
  else if(STATO.errore){t="Invio non riuscito · tocca per riprovare";c="p-danger"}
  else if(STATO.daInviare){t=`${STATO.daInviare} da inviare`;c="p-warn"}
  else{t="Tutto inviato";c="p-ok"}
  b.textContent=t;b.className="pill statoPill "+c}
function dopoSync(){if(vistaAttuale==="elenco")vistaElenco();else if(vistaAttuale==="pratica"&&corrente&&!caricando)disegnaFoto(corrente)}

/* ---------- viste ---------- */
let corrente=null,urls=[],vistaAttuale="",caricando=false;
function pulisciUrl(){urls.forEach(u=>URL.revokeObjectURL(u));urls=[]}
function mostra(titolo,indietro){$("#titolo").textContent=titolo;$("#btnIndietro").hidden=!indietro;window.scrollTo(0,0)}
const daCancellare=p=>p.scaricata&&Date.now()-p.scaricata>GIORNI_PROMEMORIA*864e5;

function erroreAccesso(e){const m=(e&&e.message)||String(e);
  if(/invalid login credentials/i.test(m))return"Email o password sbagliate (Supabase ha risposto: l'utente non esiste con questa email oppure la password non corrisponde).";
  if(/email not confirmed/i.test(m))return"L'utente esiste ma non è confermato. Su Supabase: Authentication → Users, eliminalo e ricrealo con «Auto Confirm User» spuntato.";
  if(/invalid api key|no api key|apikey/i.test(m))return"Supabase non accetta la chiave scritta in config.js: ricopia la Publishable key (passi 6 e 9).";
  if(/secret/i.test(m))return"In config.js c'è la chiave segreta: va sostituita con la Publishable key.";
  if(/invalid path|not found|404/i.test(m))return"L'indirizzo del progetto in config.js non è giusto: deve essere solo https://xxxx.supabase.co.";
  return"Accesso non riuscito. Messaggio di Supabase: "+m}
function vistaConfig(){vistaAttuale="config";mostra("Sopralluoghi",false);
  $("#app").innerHTML=`<section class="box"><h2>Manca la configurazione</h2>
  <p>${PROBLEMA_CONFIG&&PROBLEMA_CONFIG!=="vuota"?esc(PROBLEMA_CONFIG):"Il sito non sa ancora a quale Supabase collegarsi. Apri il file <span class=\"mono\">config.js</span> su GitHub e incolla l'indirizzo del progetto e la chiave pubblicabile, come spiegato nella guida."}</p></section>`}

function vistaLogin(msg){vistaAttuale="login";mostra("Sopralluoghi",false);$("#chi").textContent="";disegnaStato();
  $("#app").innerHTML=`<section class="box"><h2>Accedi</h2>
    <form id="fLogin" class="list" novalidate>
      <label class="f">Email<input type="email" id="lEmail" autocomplete="username" inputmode="email" required></label>
      <label class="f">Password<input type="password" id="lPw" autocomplete="current-password" required></label>
      <button class="primary" type="submit" id="lEntra">Entra</button>
    </form>
    <button type="button" class="link" id="lDim">Password dimenticata?</button>
    <p class="small" id="lMsg">${esc(msg||"")}</p>
    <p class="small muted">Progetto: <span class="mono">${esc(URL_SB.replace("https://",""))}</span> · chiave <span class="mono">${esc(KEY_SB.slice(0,18))}…</span></p></section>`;
  $("#fLogin").onsubmit=async e=>{e.preventDefault();const em=$("#lEmail").value.trim(),pw=$("#lPw").value;
    if(!em||!pw){$("#lMsg").textContent="Scrivi email e password.";return}
    if(!navigator.onLine){$("#lMsg").textContent="Per il primo accesso serve la rete.";return}
    $("#lEntra").disabled=true;$("#lMsg").textContent="Accesso in corso…";
    const {data,error}=await sb.auth.signInWithPassword({email:em,password:pw});$("#lEntra").disabled=false;
    if(error){$("#lMsg").textContent=erroreAccesso(error);return}
    entra(data.user)};
  $("#lDim").onclick=async()=>{const em=$("#lEmail").value.trim();if(!em){$("#lMsg").textContent="Scrivi prima la tua email, poi tocca di nuovo «Password dimenticata?».";return}
    const {error}=await sb.auth.resetPasswordForEmail(em,{redirectTo:location.origin+location.pathname});
    $("#lMsg").textContent=error?"Invio non riuscito: "+messaggioErrore(error):"Se l'indirizzo è registrato ti arriva una mail con il link per scegliere una nuova password."}}

function vistaPassword(recupero){vistaAttuale="password";mostra("Nuova password",!recupero&&!!UTENTE&&!obbligoPassword);
  $("#app").innerHTML=`<section class="box"><h2>${recupero?"Scegli una nuova password":obbligoPassword?"Cambia la password":"Cambia password"}</h2>
    ${obbligoPassword&&!recupero?`<p class="small">Prima di cominciare scegli una password tua.</p>`:""}
    <form id="fPw" class="list" novalidate>
      <label class="f">Nuova password (almeno 8 caratteri)<input type="password" id="pw1" autocomplete="new-password"></label>
      <label class="f">Ripeti la nuova password<input type="password" id="pw2" autocomplete="new-password"></label>
      <button class="primary" type="submit" id="pwOk">Salva la password</button>
    </form><p class="small" id="pwMsg"></p></section>`;
  $("#fPw").onsubmit=async e=>{e.preventDefault();const a=$("#pw1").value,b=$("#pw2").value;
    if(a.length<8){$("#pwMsg").textContent="La password deve avere almeno 8 caratteri.";return}
    if(a!==b){$("#pwMsg").textContent="Le due password non sono uguali.";return}
    $("#pwOk").disabled=true;$("#pwMsg").textContent="Salvo…";
    const {data,error}=await sb.auth.updateUser({password:a});$("#pwOk").disabled=false;
    if(error){$("#pwMsg").textContent=/different|same/i.test(error.message)?"Scegline una diversa da quella di prima.":"Non riesco a salvarla: "+messaggioErrore(error);return}
    if(recupero)history.replaceState(null,"",location.pathname);
    obbligoPassword=false;await sb.from("profili").update({deve_cambiare_password:false}).eq("id",data.user.id);
    toast("Password salvata");if(!UTENTE)await entra(data.user);else avviaApp()}}

async function vistaElenco(){
  vistaAttuale="elenco";corrente=null;pulisciUrl();mostra("Sopralluoghi",false);
  const ps=(await tuttePratiche()).sort((a,b)=>b.creata-a.creata),fs=await tutteFoto();
  const fotoDaInviare=new Set(fs.filter(f=>!f.caricata).map(f=>f.pid));
  if(vistaAttuale!=="elenco")return;
  const voci=ps.map(p=>{const st=statoPratica(p);return`<button class="card" data-apri="${p.id}">
    <span class="nome">${esc(cartella(p))}</span>
    <span class="row small muted">${esc(p.data)} · <span class="pill ${st==="sospesa"?"p-warn":"p-ok"}">${st}</span>
    ${p.scaricata?`<span class="pill p-mute">scaricata ${new Date(p.scaricata).toLocaleDateString("it-IT")}</span>`:""}
    ${daCancellare(p)?`<span class="pill p-warn">da cancellare</span>`:""}
    ${mancaPresenti(p)?`<span class="pill p-warn">manca chi era presente</span>`:""}
    ${p.daInviare||fotoDaInviare.has(p.id)?`<span class="pill p-mute">da inviare</span>`:""}</span></button>`}).join("");
  const sp=STATO.spazio??leggiCache("spazio",null),pct=sp==null?0:Math.min(100,sp/LIMITE*100),nCanc=ps.filter(daCancellare).length;
  const col=pct>85?"var(--danger)":pct>65?"var(--warn)":"var(--accent)";
  $("#app").innerHTML=`
  <section class="box" aria-label="Spazio usato">
    <div class="row"><h3 class="grow">Spazio usato</h3><span class="mono small">${sp==null?"—":mb(sp)} di ${mb(LIMITE)}</span></div>
    <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}"><i style="width:${Math.max(pct,1)}%;background:${col}"></i></div>
    ${nCanc?`<p class="small"><strong>${nCanc===1?"1 pratica scaricata":nCanc+" pratiche scaricate"}</strong> da più di ${GIORNI_PROMEMORIA} giorni: se è tutto a posto, ${nCanc===1?"cancellala":"cancellale"} per liberare spazio.</p>`:""}
    ${pct>85?`<p class="small" style="color:var(--danger)">Lo spazio sta finendo: senza spazio libero non si caricano più le foto.</p>`:""}
    ${STATO.errore?`<p class="small" style="color:var(--danger)">Ultimo invio non riuscito: ${esc(STATO.errore)}. Riprovo da solo; puoi anche toccare lo stato in alto.</p>`:""}
  </section>
  <section class="box">
    <h2>Nuova pratica</h2>
    <p class="muted small">Carica la scheda sopralluogo in PDF: la pagina legge numero, ABI, richiedente, data e documenti mancanti. Nello ZIP la ritrovi compilata con quello che scrivi al sopralluogo.</p>
    <div class="row">
      <label class="btn primary grow">Carica la scheda<input type="file" id="inScheda" accept="application/pdf,.pdf"></label>
      <button id="btnMano" class="grow">Crea a mano</button>
    </div>
  </section>
  <section class="list" aria-label="Pratiche">
    <h3>Le tue pratiche (${ps.length})</h3>
    ${voci||`<p class="muted">Nessuna pratica. Carica una scheda per iniziare.</p>`}
  </section>
  <div class="row"><button id="btnElenchi">Personalizza gli elenchi</button><button id="btnPw">Cambia password</button><button id="btnEsci">Esci</button></div>
  <div id="confEsci" hidden class="avviso"><p>Hai ${STATO.daInviare} cose ancora da inviare. Se esci restano su questo dispositivo e partono quando rientri.</p>
    <div class="row"><button class="danger solid" id="btnEsciSi">Esci lo stesso</button><button id="btnEsciNo">Resta</button></div></div>`;
  $("#btnElenchi").onclick=vistaElenchi;$("#btnPw").onclick=()=>vistaPassword(false);
  $("#btnEsci").onclick=()=>{if(STATO.daInviare){$("#confEsci").hidden=false}else esci()};
  $("#btnEsciSi").onclick=esci;$("#btnEsciNo").onclick=()=>$("#confEsci").hidden=true;
  $("#inScheda").onchange=async e=>{const f=e.target.files[0];if(!f)return;
    try{const d=await leggiPdf(f);d.file=new Blob([await f.arrayBuffer()],{type:"application/pdf"});if(!d.num&&!d.richiedente)toast("Non trovo i dati nella scheda: completali a mano");vistaConferma(d)}
    catch(err){console.warn(err);toast("Non riesco a leggere questo PDF: completa i dati a mano");vistaConferma({})}};
  $("#btnMano").onclick=()=>vistaConferma({});
  document.querySelectorAll("[data-apri]").forEach(b=>b.onclick=async()=>{const p=await getPratica(b.dataset.apri);if(p)vistaPratica(p)});
}
async function esci(){await salvaSubito();await sb.auth.signOut({scope:"local"});UTENTE=null;db=null;avviata=false;vistaLogin("Sei uscito.")}

function vistaElenchi(){
  vistaAttuale="elenchi";corrente=null;mostra("Elenchi",true);
  $("#app").innerHTML=`<section class="box">
    <h2>Personalizza gli elenchi</h2>
    <p class="muted small">Una voce per riga. Valgono per le pratiche nuove e per i pulsanti di quelle aperte; le scelte già fatte restano.</p>
    ${NOMI_ELENCHI.map(([k,n])=>`<label class="f">${n}<textarea id="el_${k}" rows="6">${esc(L[k].join("\n"))}</textarea></label>`).join("")}
    <div class="row"><button class="primary grow" id="btnSalvaEl">Salva gli elenchi</button><button class="grow" id="btnBaseEl">Torna agli elenchi di partenza</button></div>
  </section>`;
  $("#btnSalvaEl").onclick=()=>{NOMI_ELENCHI.forEach(([k])=>{const v=$("#el_"+k).value.split("\n").map(s=>s.trim()).filter(Boolean);L[k]=k==="sempre"?v.map(s=>s.toUpperCase()):v});
    salvaElenchi();toast("Elenchi salvati");vistaElenco()};
  $("#btnBaseEl").onclick=()=>{L=JSON.parse(JSON.stringify(BASE));salvaElenchi();toast("Elenchi di partenza ripristinati");vistaElenchi()};
}

function vistaConferma(d){
  vistaAttuale="conferma";mostra("Controlla i dati",true);
  const mm=(d.mancanti||[]).join(", ");
  $("#app").innerHTML=`<section class="box">
    <h2>${d.file?"Dati letti dalla scheda":"Nuova pratica a mano"}</h2>
    <p class="muted small">Correggi se serve, poi crea la pratica.</p>
    <div class="grid2">
      <label class="f">Numero perizia.ABI<input type="text" id="cNum" class="mono" value="${esc(d.num)}" placeholder="001234567.01030"></label>
      <label class="f">Data sopralluogo<input type="text" id="cData" value="${esc(d.data||new Date().toLocaleDateString("it-IT"))}"></label>
    </div>
    <label class="f">Richiedente<input type="text" id="cRich" value="${esc(d.richiedente)}"></label>
    <label class="f">Indirizzo<input type="text" id="cInd" value="${esc(d.indirizzo)}"></label>
    <label class="f">Documenti mancanti (separati da virgola)<input type="text" id="cMan" value="${esc(mm)}" placeholder="PLAN CAT, APE"></label>
    ${L.sempre.length?`<p class="small muted">Si aggiungono sempre: ${esc(L.sempre.join(", "))}.</p>`:""}
    <label class="chk"><input type="checkbox" id="cPlan" ${d.planCat?"checked":""}><span>Manca la planimetria catastale (servirà lo schizzo)</span></label>
    <p class="small">Cartella: <span class="mono" id="cCart"></span></p>
    <button class="primary" id="btnCrea">Crea la pratica</button>
  </section>`;
  const aggiorna=()=>$("#cCart").textContent=cartella({num:$("#cNum").value.trim(),richiedente:$("#cRich").value.trim()});
  ["#cNum","#cRich"].forEach(s=>$(s).oninput=aggiorna);aggiorna();
  $("#btnCrea").onclick=async()=>{$("#btnCrea").disabled=true;
    const man=$("#cMan").value.split(",").map(s=>s.trim().toUpperCase()).filter(Boolean);
    const p=nuovaPratica({num:$("#cNum").value.trim(),richiedente:$("#cRich").value.trim(),indirizzo:$("#cInd").value.trim(),data:$("#cData").value.trim(),vt:d.vt,mancanti:man,planCat:$("#cPlan").checked,file:d.file,anc:d.anc});
    await salvaPratica(p);toast("Pratica creata");programmaSync(500);vistaPratica(p)};
}

function chips(nome,opz,val){if(val&&!opz.includes(val))opz=[...opz,val];return`<div class="chips" data-chips="${nome}">${opz.map(o=>`<button type="button" aria-pressed="${o===val}" data-v="${esc(o)}">${esc(o)}</button>`).join("")}</div>`}
const conSchizzo=p=>p.schizzo&&!p.schizzo.livelli.every(livVuoto);

async function vistaPratica(p){
  vistaAttuale="pratica";corrente=p;pulisciUrl();mostra("Pratica",true);
  const c=p.campi;
  $("#app").innerHTML=`
  <section class="box">
    <div class="row"><span class="mono grow" style="word-break:break-word">${esc(cartella(p))}</span></div>
    <div class="small muted">${esc(p.indirizzo)}${p.indirizzo?" · ":""}sopralluogo ${esc(p.data)}</div>
    <div class="avviso" id="promoTop"></div>
  </section>

  <section class="box" id="boxPresenti">
    <h3>Chi era presente al sopralluogo?</h3>
    <p class="small" id="presAvv"></p>
    <div class="chips" id="presenti">${(()=>{const sc=c.presenti||[];return [...L.presenti,...sc.filter(x=>!L.presenti.includes(x))].map(o=>`<button type="button" aria-pressed="${sc.includes(o)}" data-v="${esc(o)}">${esc(o)}</button>`).join("")})()}</div>
  </section>

  <section class="box">
    <h3>Immobile</h3>
    <label class="f">Valore transazione (€)<input type="text" inputmode="numeric" id="fVt" value="${esc(c.vt)}" placeholder="es. 150000"></label>
    <label class="f">Tipo immobile<select id="fTipo"><option value="">Scegli…</option>${(c.tipo&&!L.tipi.includes(c.tipo)?[...L.tipi,c.tipo]:L.tipi).map(t=>`<option ${t===c.tipo?"selected":""}>${esc(t)}</option>`).join("")}</select></label>
    <input type="text" id="fTipoAltro" placeholder="Scrivi il tipo" value="${esc(c.tipoAltro)}" ${c.tipo==="Altro"?"":"hidden"}>
    <div class="f small muted">Stato</div>${chips("stato",L.stati,c.stato)}
    <div class="f small muted">Stato manutentivo interno</div>${chips("manInt",L.manut,c.manInt)}
    <div class="f small muted">Stato manutentivo del fabbricato</div>${chips("manEst",L.manut,c.manEst)}
    <div class="f small muted">Zona</div>${chips("zona",L.zone,c.zona)}
    <div class="grid2">
      <label class="f">Piano (facoltativo)<input type="text" id="fPiano" value="${esc(c.piano)}"></label>
      <label class="f">Interno (facoltativo)<input type="text" id="fInterno" value="${esc(c.interno)}"></label>
    </div>
  </section>

  <section class="box">
    <h3>Check list</h3>
    <div>${SINO.map(([k,n])=>`<div class="sino"><span>${n}</span><div class="seg" data-sino="${k}">
      <button type="button" data-v="no" aria-pressed="${c[k]==="no"}">NO</button><button type="button" data-v="si" aria-pressed="${c[k]==="si"}">SI</button></div></div>`).join("")}</div>
  </section>

  <section class="box">
    <h3>Appunti</h3>
    <p class="small muted">Per dettare tocca il microfono della tastiera. Vanno qui le cose che non stanno nei campi; finiscono nella frase.</p>
    <textarea id="fAppunti" placeholder="es. infissi in legno vetrocamera, cantina con umidità di risalita">${esc(p.appunti)}</textarea>
  </section>

  <section class="box">
    <h3>Documenti mancanti</h3>
    <p class="small muted">Spunta quando arrivano o sono fatti. Con anche uno solo aperto la pratica resta sospesa.</p>
    <div id="docs"></div>
    <div class="row"><input type="text" id="nuovoDoc" class="grow" placeholder="Aggiungi documento"><button id="btnDoc">Aggiungi</button></div>
  </section>

  <section class="box">
    <h3>Frase per il database</h3>
    <div class="frase" id="frase"></div>
    <button class="primary" id="btnCopia">Copia la frase</button>
  </section>

  <section class="box">
    <h3>Foto</h3>
    <p class="small muted">Scatta con la fotocamera normale, poi a fine sopralluogo selezionale tutte dalla galleria. Qui arrivano ridotte sotto i ${MAXKB} KB; gli originali restano nel telefono.</p>
    <label class="btn primary">Aggiungi foto dalla galleria<input type="file" id="inFoto" accept="image/*" multiple></label>
    <div id="avanz" hidden><div class="small muted" id="avanzT"></div><div class="bar"><i id="avanzB"></i></div></div>
    <div class="small muted" id="fotoInfo"></div>
    <div class="fotos" id="fotos"></div>
  </section>

  <section class="box" id="boxSchizzo">
    <h3>Schizzo del rilievo</h3>
    ${p.planCat?`<p class="small">Manca la planimetria catastale: disegna qui il rilievo, piano per piano.</p>`:`<p class="small muted">La planimetria catastale c'è. Se ti serve comunque uno schizzo, puoi farlo qui.</p>`}
    ${conSchizzo(p)?`<p class="small mono">${esc(riassuntoSchizzo(p))}</p>`:""}
    <button class="${p.planCat?"primary":""}" id="btnSchizzo">${conSchizzo(p)?"Apri lo schizzo":p.planCat?"Inizia lo schizzo":"Aggiungi uno schizzo"}</button>
  </section>

  <section class="box">
    <h3>Scarica e chiudi</h3>
    <p class="small muted">Lo ZIP contiene la cartella <span class="mono">${esc(cartella(p))}</span> con foto, scheda compilata${p.scheda||p.haScheda?" (sulla scheda originale)":" (sul modello vuoto)"}, frase, appunti${conSchizzo(p)?" e schizzo del rilievo":""}.</p>
    <button class="primary" id="btnZip">Scarica ZIP</button>
    <p class="small" id="zipInfo">${p.scaricata?"Scaricata il "+new Date(p.scaricata).toLocaleString("it-IT"):"Non ancora scaricata."}</p>
    <div class="row"><button class="danger" id="btnElimina">Elimina pratica</button></div>
    <div id="confElimina" hidden class="avviso">
      <p>Elimino la pratica, le sue foto e la scheda da qui e da Supabase. Gli originali nella galleria del telefono non vengono toccati. ${p.scaricata?"":"<strong>Attenzione: non l'hai ancora scaricata.</strong>"}</p>
      <div class="row"><button class="danger solid" id="btnEliminaSi">Sì, elimina</button><button id="btnEliminaNo">Annulla</button></div>
    </div>
  </section>`;

  if(!Array.isArray(c.presenti))c.presenti=[];
  const aggUI=()=>{$("#frase").textContent=frase(p);disegnaPromo(p);
    const a=$("#presAvv");a.textContent=mancaPresenti(p)?"Obbligatorio: scegli almeno una voce (anche più di una).":"Puoi sceglierne più di una.";a.style.color=mancaPresenti(p)?"var(--danger)":"var(--muted)"};
  const agg=()=>{salvaDopo(p);aggUI()};
  $("#presenti").onclick=e=>{const b=e.target.closest("button");if(!b)return;const v=b.dataset.v;
    c.presenti=c.presenti.includes(v)?c.presenti.filter(x=>x!==v):[...c.presenti,v];
    c.presenti.sort((x,y)=>{const o=[...L.presenti];const ix=o.indexOf(x),iy=o.indexOf(y);return (ix<0?99:ix)-(iy<0?99:iy)});
    b.setAttribute("aria-pressed",c.presenti.includes(v));agg()};
  const bind=(sel,key)=>{$(sel).oninput=e=>{c[key]=e.target.value;agg()}};
  bind("#fVt","vt");bind("#fPiano","piano");bind("#fInterno","interno");bind("#fTipoAltro","tipoAltro");
  $("#fTipo").onchange=e=>{c.tipo=e.target.value;$("#fTipoAltro").hidden=c.tipo!=="Altro";agg()};
  $("#fAppunti").oninput=e=>{p.appunti=e.target.value;agg()};
  document.querySelectorAll("[data-chips]").forEach(g=>g.onclick=e=>{const b=e.target.closest("button");if(!b)return;const k=g.dataset.chips;
    c[k]=c[k]===b.dataset.v?"":b.dataset.v;g.querySelectorAll("button").forEach(x=>x.setAttribute("aria-pressed",x.dataset.v===c[k]));agg()});
  document.querySelectorAll("[data-sino]").forEach(g=>g.onclick=e=>{const b=e.target.closest("button");if(!b)return;const k=g.dataset.sino;
    c[k]=c[k]===b.dataset.v?"":b.dataset.v;g.querySelectorAll("button").forEach(x=>x.setAttribute("aria-pressed",x.dataset.v===c[k]));agg()});
  const disegnaDocs=()=>{$("#docs").innerHTML=p.mancanti.map((m,i)=>`<label class="chk ${m.fatto?"fatto":""}"><input type="checkbox" data-doc="${i}" ${m.fatto?"checked":""}><span>${esc(m.nome)}</span></label>`).join("");
    document.querySelectorAll("[data-doc]").forEach(x=>x.onchange=()=>{p.mancanti[+x.dataset.doc].fatto=x.checked;disegnaDocs();agg()})};
  disegnaDocs();
  $("#btnDoc").onclick=()=>{const v=$("#nuovoDoc").value.trim().toUpperCase();if(!v)return;p.mancanti.push({nome:v,fatto:false});$("#nuovoDoc").value="";disegnaDocs();agg()};
  $("#btnCopia").onclick=async()=>{if(bloccaSeManca(p))return;const t=frase(p);try{await navigator.clipboard.writeText(t);toast("Frase copiata")}
    catch(e){const r=document.createRange();r.selectNodeContents($("#frase"));const s=getSelection();s.removeAllRanges();s.addRange(r);toast("Frase selezionata: copiala dal menu")}};
  $("#inFoto").onchange=e=>caricaFoto(p,[...e.target.files]).then(()=>{e.target.value=""});
  $("#btnZip").onclick=()=>scarica(p);
  $("#btnSchizzo").onclick=()=>apriSchizzo(p);
  $("#btnElimina").onclick=()=>{$("#confElimina").hidden=false;$("#btnElimina").hidden=true};
  $("#btnEliminaNo").onclick=()=>{$("#confElimina").hidden=true;$("#btnElimina").hidden=false};
  $("#btnEliminaSi").onclick=async()=>{const b=$("#btnEliminaSi");b.disabled=true;b.textContent="Elimino…";
    try{if(await eliminaPratica(p)){toast("Pratica eliminata");vistaElenco()}}
    catch(e){toast("Non sono riuscito a eliminarla: "+messaggioErrore(e),4500)}
    finally{b.disabled=false;b.textContent="Sì, elimina"}};
  aggUI();disegnaFoto(p);
}
function disegnaPromo(p){const ap=p.mancanti.filter(m=>!m.fatto).map(m=>m.nome);
  $("#promoTop").innerHTML=ap.length?`<strong>Mancano:</strong> ${esc(ap.join(", "))}`:`<strong>Documenti completi</strong> · pratica in lavorazione`}

const urlFirmati=new Map();
async function urlFoto(fs){const servono=fs.filter(f=>!f.blob&&!(urlFirmati.get(f.id)&&urlFirmati.get(f.id).scad>Date.now()));
  if(servono.length&&navigator.onLine){try{const {data}=await sb.storage.from(BUCKET).createSignedUrls(servono.map(percorsoFoto),3600);
    (data||[]).forEach((d,i)=>{if(d&&d.signedUrl)urlFirmati.set(servono[i].id,{url:d.signedUrl,scad:Date.now()+3300e3})})}catch(e){}}}
async function disegnaFoto(p){
  const fs=(await fotoDi(p.id)).sort((a,b)=>a.quando-b.quando);await urlFoto(fs);
  if(!corrente||corrente.id!==p.id||vistaAttuale!=="pratica")return;pulisciUrl();
  const kb=fs.reduce((s,f)=>s+(f.blob?f.blob.size:f.byte||0),0)/1024,nonInv=fs.filter(f=>!f.caricata).length;
  $("#fotoInfo").textContent=fs.length?`${fs.length} foto · ${Math.round(kb)} KB in tutto${nonInv?` · ${nonInv} ancora da inviare`:" · tutte inviate"}`:"Nessuna foto ancora.";
  $("#fotos").innerHTML=fs.map((f,i)=>{let src="";if(f.blob){src=URL.createObjectURL(f.blob);urls.push(src)}else if(urlFirmati.get(f.id))src=urlFirmati.get(f.id).url;
    return`<figure>${src?`<img src="${src}" alt="Foto ${i+1}" loading="lazy">`:`<div class="ph small muted">serve la rete</div>`}<button data-togli="${f.id}" aria-label="Togli foto ${i+1}">✕</button><figcaption>${Math.round((f.blob?f.blob.size:f.byte||0)/1024)} KB${f.caricata?"":" · da inviare"}</figcaption></figure>`}).join("");
  document.querySelectorAll("[data-togli]").forEach(b=>b.onclick=async()=>{const f=fs.find(x=>x.id===b.dataset.togli);if(!f)return;
    if(f.caricata){const coda=await codaEliminazioni();coda.push({tipo:"foto",id:f.id,path:percorsoFoto(f)});scriviCache("eliminazioni",coda)}
    await togliFotoLocale(f.id);programmaSync(1500);disegnaFoto(p)});
}
async function caricaFoto(p,files){
  if(!files.length)return;caricando=true;$("#avanz").hidden=false;let ok=0,ko=0,motivo="";
  for(let i=0;i<files.length;i++){
    $("#avanzT").textContent=`Riduco la foto ${i+1} di ${files.length}…`;$("#avanzB").style.width=(i/files.length*100)+"%";
    let fatto=false;
    for(let tentativo=0;tentativo<2&&!fatto;tentativo++){
      try{const quando=(await dataScatto(files[i]))+i;const blob=await riduci(files[i]);
        await salvaFoto({id:uuid(),pid:p.id,quando,blob,caricata:false});ok++;fatto=true}
      catch(e){console.warn("foto",i+1,e);motivo=(e&&e.message)||String(e);await new Promise(r=>setTimeout(r,400))}}
    if(!fatto)ko++;
    await new Promise(r=>setTimeout(r,30));
  }
  $("#avanzB").style.width="100%";$("#avanz").hidden=true;caricando=false;
  toast(ko?`${ok} foto aggiunte, ${ko} non riuscite (${motivo}). Riprova a selezionare quelle mancanti.`:`${ok} foto aggiunte`,ko?6000:2800);
  if(corrente&&corrente.id===p.id)disegnaFoto(p);programmaSync(800);
}
async function scaricaDaArchivio(path){const {data,error}=await sb.storage.from(BUCKET).download(path);if(error)throw error;return data}
async function creaZip(p){
  const z=new JSZip();const root=z.folder(cartella(p));
  const fs=(await fotoDi(p.id)).sort((a,b)=>a.quando-b.quando);
  const servono=fs.some(f=>!f.blob)||(!p.scheda&&p.haScheda);
  if(servono&&!navigator.onLine)throw new Error("Per scaricare le foto che non sono su questo dispositivo serve la rete");
  for(let i=0;i<fs.length;i++){const f=fs[i];$("#btnZip").textContent=`Preparo lo ZIP… foto ${i+1} di ${fs.length}`;
    root.file(`Foto al sopralluogo/foto_${String(i+1).padStart(3,"0")}.jpg`,f.blob||await scaricaDaArchivio(percorsoFoto(f)))}
  const scheda=p.scheda||(p.haScheda?await scaricaDaArchivio(percorsoScheda(p)):null);
  root.file("Scheda_compilata.pdf",await schedaCompilata(p,scheda));
  root.file("Frase_database.txt",frase(p)+"\r\n");
  const sk=await pdfSchizzo(p);if(sk)root.file("Schizzo rilievo.pdf",sk);
  if((p.appunti||"").trim())root.file("Appunti.txt",p.appunti.trim()+"\r\n");
  return z.generateAsync({type:"blob",compression:"STORE"});
}
function salvaFile(blob,nome){const u=URL.createObjectURL(blob);const a=document.createElement("a");a.href=u;a.download=nome;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),60000)}
async function scarica(p){
  if(bloccaSeManca(p))return;
  const b=$("#btnZip");b.disabled=true;b.textContent="Preparo lo ZIP…";
  try{const zip=await creaZip(p);salvaFile(zip,cartella(p)+".zip");
    p.scaricata=Date.now();salvaDopo(p);$("#zipInfo").textContent="Scaricata il "+new Date(p.scaricata).toLocaleString("it-IT");toast("ZIP scaricato")}
  catch(e){console.warn(e);toast("Non sono riuscito a preparare lo ZIP: "+messaggioErrore(e),4500)}
  finally{b.disabled=false;b.textContent="Scarica ZIP"}
}
async function eliminaPratica(p){
  if(!navigator.onLine){toast("Per eliminare una pratica serve la rete");return false}
  await salvaSubito();
  const pref=`${UTENTE.id}/${p.id}`;
  const {data:files,error}=await sb.storage.from(BUCKET).list(pref,{limit:1000});if(error)throw error;
  if(files&&files.length){const {error:e2}=await sb.storage.from(BUCKET).remove(files.map(f=>pref+"/"+f.name));if(e2)throw e2}
  const {error:e3}=await sb.from("pratiche").delete().eq("id",p.id);if(e3)throw e3;
  scriviCache("eliminazioni",(await codaEliminazioni()).filter(x=>!x.path.startsWith(pref+"/")));
  await eliminaLocale(p.id);corrente=null;return true;
}

/* ---------- schizzo del rilievo ---------- */
const GRID=0.25, snap=v=>Math.round(v/GRID)*GRID;
const PAL_EDIT={carta:"#FBFCFD",minore:"#E3EAF0",maggiore:"#C9D6E0",ink:"#1B2125",stanza:"#FFFFFF",balc:"#EEF2F5",sel:"#E0AE12",quota:"#1F4E8C",testo:"#1B2125"};
const PAL_STAMPA={carta:"#FFFFFF",ink:"#111111",stanza:"#FFFFFF",balc:"#F2F2F2",sel:"#111111",quota:"#111111",testo:"#111111"};
const fmtM=v=>(Math.round(v*100)/100).toLocaleString("it-IT",{minimumFractionDigits:2,maximumFractionDigits:2});
function nuovoLivello(nome){return{id:uid(),nome,stanze:[],porte:[],quote:[]}}
function schizzoDi(p){if(!p.schizzo)p.schizzo={livelli:[nuovoLivello(L.livelli[0]||"Piano terra")],attivo:0};return p.schizzo}
const livVuoto=l=>!l.stanze.length&&!l.quote.length;
function riassuntoSchizzo(p){if(!p.schizzo)return"";const ls=p.schizzo.livelli.filter(l=>!livVuoto(l));
  if(!ls.length)return"Schizzo vuoto.";return ls.map(l=>`${l.nome}: ${l.stanze.length} ${l.stanze.length===1?"vano":"vani"}`).join(" · ")}

/* geometria della porta, agganciata a un lato della stanza (0 sopra, 1 destra, 2 sotto, 3 sinistra) */
function geomPorta(liv,d){const r=liv.stanze.find(s=>s.id===d.sid);if(!r)return null;
  const lung=d.lato%2?r.h:r.w,larg=Math.min(d.larg,lung),t=Math.max(0,Math.min(d.t,lung-larg));
  let x,y,dx=0,dy=0,nx=0,ny=0;
  if(d.lato===0){x=r.x+t;y=r.y;dx=1;ny=1}else if(d.lato===2){x=r.x+t;y=r.y+r.h;dx=1;ny=-1}
  else if(d.lato===3){x=r.x;y=r.y+t;dy=1;nx=1}else{x=r.x+r.w;y=r.y+t;dy=1;nx=-1}
  return{x,y,x2:x+dx*larg,y2:y+dy*larg,dx,dy,nx,ny,larg,cx:x+dx*larg/2,cy:y+dy*larg/2}}

function renderLivello(ctx,liv,v,o){
  const P=o.pal,X=x=>v.ox+x*v.s,Y=y=>v.oy+y*v.s,muro=Math.max(2,Math.min(6,0.14*v.s));
  ctx.lineJoin="miter";ctx.lineCap="butt";
  // vani
  for(const r of liv.stanze){
    const x=X(r.x),y=Y(r.y),w=r.w*v.s,h=r.h*v.s;
    ctx.fillStyle=r.tipo==="balcone"?P.balc:P.stanza;ctx.fillRect(x,y,w,h);
    if(r.tipo==="balcone"){ctx.save();ctx.beginPath();ctx.rect(x,y,w,h);ctx.clip();ctx.strokeStyle=P.ink;ctx.globalAlpha=.25;ctx.lineWidth=1;
      const passo=Math.max(6,0.3*v.s);for(let k=-h;k<w;k+=passo){ctx.beginPath();ctx.moveTo(x+k,y+h);ctx.lineTo(x+k+h,y);ctx.stroke()}ctx.restore()}
    if(r.tipo==="scala"){ctx.save();ctx.strokeStyle=P.ink;ctx.lineWidth=1;const lungo=r.w>=r.h,n=Math.max(3,Math.round((lungo?r.w:r.h)/0.28));
      for(let i=1;i<n;i++){ctx.beginPath();if(lungo){const xx=x+w*i/n;ctx.moveTo(xx,y);ctx.lineTo(xx,y+h)}else{const yy=y+h*i/n;ctx.moveTo(x,yy);ctx.lineTo(x+w,yy)}ctx.stroke()}
      const dir=r.dir??(lungo?1:0),cx=x+w/2,cy=y+h/2,ux=[0,1,0,-1][dir],uy=[-1,0,1,0][dir],m=(ux?w:h)*.4;
      const ax=cx-ux*m,ay=cy-uy*m,bx=cx+ux*m,by=cy+uy*m;
      ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(ax,ay,3,0,Math.PI*2);ctx.fillStyle=P.ink;ctx.fill();
      ctx.beginPath();ctx.moveTo(ax,ay);ctx.lineTo(bx,by);ctx.lineTo(bx-ux*8-uy*6,by-uy*8+ux*6);ctx.moveTo(bx,by);ctx.lineTo(bx-ux*8+uy*6,by-uy*8-ux*6);ctx.stroke();ctx.restore()}
    ctx.strokeStyle=P.ink;ctx.lineWidth=r.tipo==="balcone"?Math.max(1.5,muro*.5):muro;ctx.strokeRect(x,y,w,h);
  }
  // porte: varco nel muro, anta e arco
  for(const d of liv.porte){const g=geomPorta(liv,d);if(!g)continue;
    ctx.strokeStyle=P.stanza;ctx.lineWidth=muro+2;ctx.beginPath();ctx.moveTo(X(g.x),Y(g.y));ctx.lineTo(X(g.x2),Y(g.y2));ctx.stroke();
    const finale=(d.ap&1)===1,dentro=(d.ap&2)===0,s=dentro?1:-1;
    const hx=finale?g.x2:g.x,hy=finale?g.y2:g.y,ox=finale?g.x:g.x2,oy=finale?g.y:g.y2;
    const ax=hx+g.nx*s*g.larg,ay=hy+g.ny*s*g.larg;
    ctx.strokeStyle=P.ink;ctx.lineWidth=Math.max(1.2,muro*.45);ctx.beginPath();ctx.moveTo(X(hx),Y(hy));ctx.lineTo(X(ax),Y(ay));ctx.stroke();
    const a1=Math.atan2(ay-hy,ax-hx),a2=Math.atan2(oy-hy,ox-hx),cr=(ax-hx)*(oy-hy)-(ay-hy)*(ox-hx);
    ctx.lineWidth=1;ctx.setLineDash([3,3]);ctx.beginPath();ctx.arc(X(hx),Y(hy),g.larg*v.s,a1,a2,cr<0);ctx.stroke();ctx.setLineDash([]);
    if(o.sel&&o.sel.k==="porta"&&o.sel.id===d.id){ctx.strokeStyle=P.sel;ctx.lineWidth=3;ctx.beginPath();ctx.arc(X(g.cx),Y(g.cy),Math.max(14,g.larg*v.s*.75),0,Math.PI*2);ctx.stroke()}
  }
  // nomi dei vani
  for(const r of liv.stanze){if(!r.nome)continue;const fs=Math.max(10,Math.min(22,0.38*v.s));
    ctx.font=`600 ${fs}px Barlow, Arial, sans-serif`;ctx.fillStyle=P.testo;ctx.textAlign="center";ctx.textBaseline="middle";
    const cx=X(r.x+r.w/2),cy=Y(r.y+r.h/2);ctx.save();if(r.tipo==="scala"){ctx.fillStyle=P.stanza;const tw=ctx.measureText(r.nome).width+8;ctx.fillRect(cx-tw/2,cy-fs/2-2,tw,fs+4);ctx.fillStyle=P.testo}
    ctx.fillText(r.nome,cx,cy);ctx.restore()}
  // quote
  const quota=(q,col,txt)=>{const x1=X(q.x1),y1=Y(q.y1),x2=X(q.x2),y2=Y(q.y2),L2=Math.hypot(x2-x1,y2-y1)||1,ux=(x2-x1)/L2,uy=(y2-y1)/L2;
    ctx.strokeStyle=col;ctx.fillStyle=col;ctx.lineWidth=1.4;ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
    for(const [px,py] of [[x1,y1],[x2,y2]]){ctx.beginPath();ctx.moveTo(px-(ux+uy)*5,py-(uy-ux)*5);ctx.lineTo(px+(ux+uy)*5,py+(uy-ux)*5);ctx.stroke()}
    if(txt){const fs=Math.max(11,Math.min(18,0.32*v.s));ctx.font=`600 ${fs}px "JetBrains Mono", Menlo, monospace`;ctx.textAlign="center";ctx.textBaseline="middle";
      const mx=(x1+x2)/2,my=(y1+y2)/2,tw=ctx.measureText(txt).width+8;ctx.save();ctx.translate(mx,my);let ang=Math.atan2(uy,ux);if(ang>Math.PI/2||ang<-Math.PI/2)ang+=Math.PI;ctx.rotate(ang);
      ctx.fillStyle=P.carta;ctx.fillRect(-tw/2,-fs/2-2,tw,fs+4);ctx.fillStyle=col;ctx.fillText(txt,0,0);ctx.restore()}};
  for(const q of liv.quote){const s=o.sel&&o.sel.k==="quota"&&o.sel.id===q.id;quota(q,s?P.sel:P.quota,q.testo?q.testo+" m":"")}
  // selezione di un vano
  if(o.sel&&o.sel.k==="stanza"){const r=liv.stanze.find(s=>s.id===o.sel.id);if(r){
    ctx.strokeStyle=P.sel;ctx.lineWidth=3;ctx.strokeRect(X(r.x)-3,Y(r.y)-3,r.w*v.s+6,r.h*v.s+6);
    for(const [hx,hy] of angoli(r)){ctx.beginPath();ctx.arc(X(hx),Y(hy),9,0,Math.PI*2);ctx.fillStyle=P.sel;ctx.fill();ctx.strokeStyle="#fff";ctx.lineWidth=2;ctx.stroke()}}}
  // forme in corso
  if(o.temp&&o.temp.rect){const r=o.temp.rect;ctx.setLineDash([6,4]);ctx.strokeStyle=P.sel;ctx.lineWidth=2;ctx.strokeRect(X(r.x),Y(r.y),r.w*v.s,r.h*v.s);ctx.setLineDash([]);
    const t=`${fmtM(r.w)} × ${fmtM(r.h)} m`;ctx.font='600 13px "JetBrains Mono", Menlo, monospace';ctx.textAlign="left";ctx.textBaseline="bottom";
    const tw=ctx.measureText(t).width+10;ctx.fillStyle=P.ink;ctx.fillRect(X(r.x),Y(r.y)-24,tw,22);ctx.fillStyle="#fff";ctx.fillText(t,X(r.x)+5,Y(r.y)-5)}
  if(o.temp&&o.temp.quota){const q=o.temp.quota;quota(q,P.sel,"≈ "+fmtM(Math.hypot(q.x2-q.x1,q.y2-q.y1)))}
}
const angoli=r=>[[r.x,r.y],[r.x+r.w,r.y],[r.x+r.w,r.y+r.h],[r.x,r.y+r.h]];

/* ---------- editor ---------- */
const E={p:null,tool:"sel",sel:null,view:{s:40,ox:20,oy:20},ptr:new Map(),drag:null,temp:null,undo:[],dpr:1};
const livCorr=()=>E.p.schizzo.livelli[E.p.schizzo.attivo];
function apriSchizzo(p){
  E.p=p;schizzoDi(p);E.sel=null;E.undo=[];E.tool="sel";
  const ed=$("#editor");ed.hidden=false;document.body.style.overflow="hidden";
  E.cv=$("#tela");E.ctx=E.cv.getContext("2d");
  $("#edTitolo").textContent=cartella(p);
  disegnaLivelli();disegnaStrumenti();ridimensiona();adatta();aggiornaContesto();
}
function chiudiSchizzo(){$("#editor").hidden=true;document.body.style.overflow="";chiudiFoglio();salvaPratica(E.p).catch(()=>{});const p=E.p;E.p=null;if(corrente&&corrente.id===p.id)vistaPratica(p)}
function ridimensiona(){const c=E.cv,b=c.parentElement.getBoundingClientRect();E.dpr=window.devicePixelRatio||1;
  c.width=Math.round(b.width*E.dpr);c.height=Math.round(b.height*E.dpr);c.style.width=b.width+"px";c.style.height=b.height+"px";disegna()}
function bbox(l){let a=[1/0,1/0,-1/0,-1/0];const add=(x,y)=>{a=[Math.min(a[0],x),Math.min(a[1],y),Math.max(a[2],x),Math.max(a[3],y)]};
  l.stanze.forEach(r=>{add(r.x,r.y);add(r.x+r.w,r.y+r.h)});l.quote.forEach(q=>{add(q.x1,q.y1);add(q.x2,q.y2)});return isFinite(a[0])?a:null}
function adatta(){const c=E.cv,w=c.clientWidth,h=c.clientHeight,b=bbox(livCorr());
  if(!b){E.view={s:Math.max(24,Math.min(60,w/10)),ox:w*.08,oy:h*.08};disegna();return}
  const M=1,s=Math.max(10,Math.min(160,Math.min(w/(b[2]-b[0]+2*M),h/(b[3]-b[1]+2*M))));
  E.view={s,ox:(w-(b[2]-b[0])*s)/2-b[0]*s,oy:(h-(b[3]-b[1])*s)/2-b[1]*s};disegna()}
function disegna(){if(!E.p)return;const c=E.cv,ctx=E.ctx,w=c.clientWidth,h=c.clientHeight,v=E.view;
  ctx.setTransform(E.dpr,0,0,E.dpr,0,0);ctx.fillStyle=PAL_EDIT.carta;ctx.fillRect(0,0,w,h);
  const x0=Math.floor(-v.ox/v.s),x1=Math.ceil((w-v.ox)/v.s),y0=Math.floor(-v.oy/v.s),y1=Math.ceil((h-v.oy)/v.s);
  const riga=(px,py,qx,qy,col)=>{ctx.strokeStyle=col;ctx.beginPath();ctx.moveTo(px,py);ctx.lineTo(qx,qy);ctx.stroke()};
  ctx.lineWidth=1;if(v.s*.5>=9)for(let x=x0;x<=x1;x+=.5)if(x%1)riga(v.ox+x*v.s,0,v.ox+x*v.s,h,PAL_EDIT.minore);
  if(v.s*.5>=9)for(let y=y0;y<=y1;y+=.5)if(y%1)riga(0,v.oy+y*v.s,w,v.oy+y*v.s,PAL_EDIT.minore);
  const passo=v.s>=14?1:5;for(let x=Math.floor(x0/passo)*passo;x<=x1;x+=passo)riga(v.ox+x*v.s,0,v.ox+x*v.s,h,PAL_EDIT.maggiore);
  for(let y=Math.floor(y0/passo)*passo;y<=y1;y+=passo)riga(0,v.oy+y*v.s,w,v.oy+y*v.s,PAL_EDIT.maggiore);
  renderLivello(ctx,livCorr(),v,{pal:PAL_EDIT,sel:E.sel,temp:E.temp});
  $("#edScala").textContent=`un quadretto = ${v.s*.5>=9?"0,5 m":passo+" m"}`;
}
const mondo=(cx,cy)=>({x:(cx-E.view.ox)/E.view.s,y:(cy-E.view.oy)/E.view.s});
function puntoCanvas(e){const b=E.cv.getBoundingClientRect();return{x:e.clientX-b.left,y:e.clientY-b.top}}
function memo(){E.undo.push(JSON.stringify(livCorr()));if(E.undo.length>60)E.undo.shift();$("#edAnnulla").disabled=false}
function annulla(){const s=E.undo.pop();if(!s)return;Object.assign(livCorr(),JSON.parse(s));E.sel=null;$("#edAnnulla").disabled=!E.undo.length;aggiornaContesto();disegna();salvaDopo(E.p)}
function trovaStanza(w){const l=livCorr();for(let i=l.stanze.length-1;i>=0;i--){const r=l.stanze[i];if(w.x>=r.x&&w.x<=r.x+r.w&&w.y>=r.y&&w.y<=r.y+r.h)return r}return null}
function trovaPorta(w){const l=livCorr(),tol=Math.max(.45,22/E.view.s);let best=null,bd=1/0;
  for(const d of l.porte){const g=geomPorta(l,d);if(!g)continue;const dd=Math.hypot(w.x-g.cx,w.y-g.cy);if(dd<tol&&dd<bd){bd=dd;best=d}}return best}
function distSeg(px,py,x1,y1,x2,y2){const dx=x2-x1,dy=y2-y1,l2=dx*dx+dy*dy||1e-9;let t=((px-x1)*dx+(py-y1)*dy)/l2;t=Math.max(0,Math.min(1,t));return Math.hypot(px-x1-t*dx,py-y1-t*dy)}
function trovaQuota(w){const tol=16/E.view.s;return livCorr().quote.find(q=>distSeg(w.x,w.y,q.x1,q.y1,q.x2,q.y2)<tol)||null}
function trovaManiglia(c){if(!E.sel||E.sel.k!=="stanza")return -1;const r=livCorr().stanze.find(s=>s.id===E.sel.id);if(!r)return -1;
  return angoli(r).findIndex(([x,y])=>Math.hypot(E.view.ox+x*E.view.s-c.x,E.view.oy+y*E.view.s-c.y)<24)}
function agganciaPunto(w){const tol=Math.max(.3,18/E.view.s);let best=null,bd=1/0;
  for(const r of livCorr().stanze)for(const [x,y] of angoli(r)){const d=Math.hypot(w.x-x,w.y-y);if(d<tol&&d<bd){bd=d;best={x,y}}}
  return best||{x:snap(w.x),y:snap(w.y)}}
function lato(w){const l=livCorr(),tol=Math.max(.4,22/E.view.s);let best=null,bd=1/0;
  for(const r of l.stanze){const lati=[[r.x,r.y,r.x+r.w,r.y],[r.x+r.w,r.y,r.x+r.w,r.y+r.h],[r.x,r.y+r.h,r.x+r.w,r.y+r.h],[r.x,r.y,r.x,r.y+r.h]];
    lati.forEach((s,i)=>{const d=distSeg(w.x,w.y,...s);if(d<tol&&d<bd){bd=d;best={r,i,t:i%2?w.y-r.y:w.x-r.x}}})}return best}

function giu(e){if(!E.p)return;E.cv.setPointerCapture(e.pointerId);const c=puntoCanvas(e);E.ptr.set(e.pointerId,c);
  if(E.ptr.size===2){if(E.drag&&E.drag.memo&&!E.drag.mosso)E.undo.pop();E.temp=null;const [a,b]=[...E.ptr.values()];
    E.drag={m:"pinch",d0:Math.hypot(a.x-b.x,a.y-b.y),c0:{x:(a.x+b.x)/2,y:(a.y+b.y)/2},v0:{...E.view}};disegna();return}
  if(E.ptr.size>2)return;
  const w=mondo(c.x,c.y),l=livCorr();
  if(E.tool==="sel"){
    const hi=trovaManiglia(c);
    if(hi>=0){const r=l.stanze.find(s=>s.id===E.sel.id);memo();E.drag={m:"resize",r,fisso:angoli(r)[(hi+2)%4],memo:true};return}
    const d=trovaPorta(w),q=d?null:trovaQuota(w),r=d||q?null:trovaStanza(w);
    if(d){E.sel={k:"porta",id:d.id};E.drag={m:"tap",c0:c}}
    else if(q){E.sel={k:"quota",id:q.id};memo();E.drag={m:"movequota",q,w0:w,o:{...q},memo:true,c0:c}}
    else if(r){E.sel={k:"stanza",id:r.id};memo();E.drag={m:"move",r,w0:w,o:{x:r.x,y:r.y},memo:true,c0:c}}
    else{E.sel=null;E.drag={m:"pan",c0:c,v0:{...E.view}}}
    aggiornaContesto();disegna();return}
  if(E.tool==="stanza"||E.tool==="balcone"||E.tool==="scala"){const a={x:snap(w.x),y:snap(w.y)};E.drag={m:"nuovo",a};E.temp={rect:{x:a.x,y:a.y,w:0,h:0}};disegna();return}
  if(E.tool==="quota"){const a=agganciaPunto(w);E.drag={m:"quota",a};E.temp={quota:{x1:a.x,y1:a.y,x2:a.x,y2:a.y}};disegna();return}
  if(E.tool==="porta"){E.drag={m:"porta",c0:c};return}
}
function muovi(e){if(!E.ptr.has(e.pointerId)||!E.drag)return;const c=puntoCanvas(e);E.ptr.set(e.pointerId,c);const D=E.drag,w=mondo(c.x,c.y);
  if(D.c0&&Math.hypot(c.x-D.c0.x,c.y-D.c0.y)>6)D.mosso=true;
  if(D.m==="pinch"){if(E.ptr.size<2)return;const [a,b]=[...E.ptr.values()],d=Math.hypot(a.x-b.x,a.y-b.y),m={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
    const s=Math.max(8,Math.min(220,D.v0.s*d/D.d0)),wx=(D.c0.x-D.v0.ox)/D.v0.s,wy=(D.c0.y-D.v0.oy)/D.v0.s;E.view={s,ox:m.x-wx*s,oy:m.y-wy*s}}
  else if(D.m==="pan"){E.view={...D.v0,ox:D.v0.ox+c.x-D.c0.x,oy:D.v0.oy+c.y-D.c0.y}}
  else if(D.m==="move"){D.r.x=snap(D.o.x+w.x-D.w0.x);D.r.y=snap(D.o.y+w.y-D.w0.y)}
  else if(D.m==="movequota"){const dx=snap(w.x-D.w0.x),dy=snap(w.y-D.w0.y);Object.assign(D.q,{x1:D.o.x1+dx,y1:D.o.y1+dy,x2:D.o.x2+dx,y2:D.o.y2+dy})}
  else if(D.m==="resize"){const px=snap(w.x),py=snap(w.y),f=D.fisso;let x=Math.min(px,f[0]),y=Math.min(py,f[1]),ww=Math.abs(px-f[0]),hh=Math.abs(py-f[1]);
    if(ww<.5){ww=.5;if(px<f[0])x=f[0]-.5}if(hh<.5){hh=.5;if(py<f[1])y=f[1]-.5}Object.assign(D.r,{x,y,w:ww,h:hh});D.mosso=true}
  else if(D.m==="nuovo"){const b={x:snap(w.x),y:snap(w.y)};E.temp={rect:{x:Math.min(D.a.x,b.x),y:Math.min(D.a.y,b.y),w:Math.abs(b.x-D.a.x),h:Math.abs(b.y-D.a.y)}}}
  else if(D.m==="quota"){const b=agganciaPunto(w);E.temp={quota:{x1:D.a.x,y1:D.a.y,x2:b.x,y2:b.y}}}
  disegna()}
function su(e){if(!E.ptr.has(e.pointerId))return;E.ptr.delete(e.pointerId);const D=E.drag;
  if(!D)return;if(D.m==="pinch"){if(E.ptr.size===0)E.drag=null;else E.drag={m:"nulla"};return}
  E.drag=null;const l=livCorr();
  if((D.m==="move"||D.m==="movequota"||D.m==="resize")&&!D.mosso){E.undo.pop();$("#edAnnulla").disabled=!E.undo.length}
  if(D.m==="move"||D.m==="movequota"||D.m==="resize"){if(D.mosso)salvaDopo(E.p)}
  if(D.m==="nuovo"){const r=E.temp&&E.temp.rect;E.temp=null;
    if(r&&r.w>=.5&&r.h>=.5){memo();const tipo=E.tool,n={id:uid(),tipo,...r,nome:tipo==="scala"?"Scala":tipo==="balcone"?"Balc":""};l.stanze.push(n);E.sel={k:"stanza",id:n.id};salvaDopo(E.p);
      if(tipo!=="scala")chiediNome(n);E.tool="sel";disegnaStrumenti()}
    else toast("Trascina il dito per disegnare il rettangolo")}
  if(D.m==="quota"){const q=E.temp&&E.temp.quota;E.temp=null;if(q&&Math.hypot(q.x2-q.x1,q.y2-q.y1)>=.3){chiediQuota(q,null)}else toast("Trascina da un punto all'altro della misura")}
  if(D.m==="porta"&&!D.mosso){const w=mondo(D.c0.x,D.c0.y),d=trovaPorta(w);
    if(d){E.sel={k:"porta",id:d.id}}else{const s=lato(w);if(!s)toast("Tocca un muro di una stanza per mettere la porta");else{
      memo();const larg=.8,lung=s.i%2?s.r.h:s.r.w,t=Math.max(0,Math.min(lung-larg,s.t-larg/2));const n={id:uid(),sid:s.r.id,lato:s.i,t:snap(t),larg,ap:0};l.porte.push(n);E.sel={k:"porta",id:n.id};salvaDopo(E.p)}}}
  aggiornaContesto();disegna()}

function eliminaSel(){if(!E.sel)return;const l=livCorr();memo();
  if(E.sel.k==="stanza"){l.stanze=l.stanze.filter(s=>s.id!==E.sel.id);l.porte=l.porte.filter(d=>d.sid!==E.sel.id)}
  if(E.sel.k==="porta")l.porte=l.porte.filter(d=>d.id!==E.sel.id);
  if(E.sel.k==="quota")l.quote=l.quote.filter(q=>q.id!==E.sel.id);
  E.sel=null;aggiornaContesto();disegna();salvaDopo(E.p)}
function aggiornaContesto(){const b=$("#edContesto"),l=livCorr();if(!E.sel){b.innerHTML=`<span class="small muted">${E.tool==="sel"?"Tocca un elemento per modificarlo. Un dito sposta il foglio, due dita ingrandiscono.":aiuto[E.tool]}</span>`;return}
  if(E.sel.k==="stanza"){const r=l.stanze.find(s=>s.id===E.sel.id);b.innerHTML=`<span class="mono small grow">${esc(r.nome||"senza nome")} · ${fmtM(r.w)} × ${fmtM(r.h)}</span>${r.tipo==="scala"?`<button id="cxGiraSc">Gira freccia</button>`:""}<button id="cxNome">Nome</button><button class="danger" id="cxDel">Elimina</button>`;$("#cxNome").onclick=()=>chiediNome(r);
    const gs=$("#cxGiraSc");if(gs)gs.onclick=()=>{memo();const lungo=r.w>=r.h,d=r.dir??(lungo?1:0);r.dir=lungo?(d===1?3:1):(d===0?2:0);disegna();salvaDopo(E.p)}}
  if(E.sel.k==="porta"){b.innerHTML=`<span class="small grow">Porta</span><button id="cxGira">Gira apertura</button><button class="danger" id="cxDel">Elimina</button>`;
    $("#cxGira").onclick=()=>{const d=l.porte.find(x=>x.id===E.sel.id);memo();d.ap=(d.ap+1)%4;disegna();salvaDopo(E.p)}}
  if(E.sel.k==="quota"){const q=l.quote.find(x=>x.id===E.sel.id);b.innerHTML=`<span class="mono small grow">${esc(q.testo)} m</span><button id="cxMis">Misura</button><button class="danger" id="cxDel">Elimina</button>`;$("#cxMis").onclick=()=>chiediQuota(q,q)}
  $("#cxDel").onclick=eliminaSel}
const aiuto={stanza:"Trascina per disegnare la stanza, poi scegli il nome.",balcone:"Trascina per disegnare balcone o terrazzo.",scala:"Trascina per disegnare la scala; la freccia indica da che parte si sale (Gira freccia per cambiarla).",porta:"Tocca il muro dove c'è la porta.",quota:"Trascina da un punto all'altro della misura rilevata."};

/* fogli in basso: nome del vano, misura, livelli */
function apriFoglio(html){const f=$("#edFoglio");f.innerHTML=html;f.hidden=false}
function chiudiFoglio(){const f=$("#edFoglio");f.hidden=true;f.innerHTML=""}
function chiediNome(r){
  apriFoglio(`<h3>Nome del vano</h3><div class="chips" id="fsChips">${L.stanze.map(s=>`<button type="button" data-v="${esc(s)}" aria-pressed="${s===r.nome}">${esc(s)}</button>`).join("")}</div>
  <div class="row"><input type="text" id="fsAltro" class="grow" placeholder="Oppure scrivilo" value="${esc(L.stanze.includes(r.nome)?"":r.nome)}"><button class="primary" id="fsOk">Fatto</button></div>`);
  const fatto=n=>{memo();r.nome=n.trim();chiudiFoglio();aggiornaContesto();disegna();salvaDopo(E.p)};
  $("#fsChips").onclick=e=>{const b=e.target.closest("button");if(b)fatto(b.dataset.v)};
  $("#fsOk").onclick=()=>fatto($("#fsAltro").value)}
function chiediQuota(q,esistente){const stima=fmtM(Math.hypot(q.x2-q.x1,q.y2-q.y1));
  apriFoglio(`<h3>Misura rilevata</h3><p class="small muted">Scrivi la misura presa col metro. Sul foglio è circa ${stima} m.</p>
  <div class="row"><input type="text" inputmode="decimal" id="fqVal" class="grow mono" placeholder="es. 4,20" value="${esc(esistente?esistente.testo:"")}"><span>m</span><button class="primary" id="fqOk">Fatto</button><button id="fqNo">Annulla</button></div>`);
  setTimeout(()=>{const i=$("#fqVal");if(i)i.focus()},50);
  $("#fqOk").onclick=()=>{const t=$("#fqVal").value.trim().replace(".",",");if(!t){toast("Scrivi la misura");return}memo();
    if(esistente)esistente.testo=t;else{const n={id:uid(),...q,testo:t};livCorr().quote.push(n);E.sel={k:"quota",id:n.id};E.tool="sel";disegnaStrumenti()}
    chiudiFoglio();aggiornaContesto();disegna();salvaDopo(E.p)};
  $("#fqNo").onclick=()=>{chiudiFoglio();disegna()}}
function disegnaLivelli(){const s=E.p.schizzo;
  $("#edLivelli").innerHTML=s.livelli.map((l,i)=>`<button type="button" class="tab" aria-pressed="${i===s.attivo}" data-liv="${i}">${esc(l.nome)}</button>`).join("")+`<button type="button" class="tab" id="edAddLiv">+ Livello</button>`;
  $("#edLivelli").querySelectorAll("[data-liv]").forEach(b=>b.onclick=()=>{const i=+b.dataset.liv;if(i===s.attivo){foglioLivello();return}s.attivo=i;E.sel=null;E.undo=[];$("#edAnnulla").disabled=true;disegnaLivelli();aggiornaContesto();adatta();salvaDopo(E.p)});
  $("#edAddLiv").onclick=()=>foglioLivello(true)}
function foglioLivello(nuovo){const s=E.p.schizzo,l=s.livelli[s.attivo];
  apriFoglio(`<h3>${nuovo?"Nuovo livello":"Livello: "+esc(l.nome)}</h3><div class="chips" id="flChips">${L.livelli.map(n=>`<button type="button" data-v="${esc(n)}">${esc(n)}</button>`).join("")}</div>
  <div class="row"><input type="text" id="flAltro" class="grow" placeholder="Oppure scrivilo" value="${nuovo?"":esc(l.nome)}"><button class="primary" id="flOk">${nuovo?"Aggiungi":"Rinomina"}</button><button id="flNo">Chiudi</button></div>
  ${!nuovo&&s.livelli.length>1?`<button class="danger" id="flDel">Elimina questo livello</button>`:""}`);
  const fatto=n=>{n=n.trim();if(!n)return;if(nuovo){s.livelli.push(nuovoLivello(n));s.attivo=s.livelli.length-1;E.undo=[];$("#edAnnulla").disabled=true}else l.nome=n;
    chiudiFoglio();E.sel=null;disegnaLivelli();aggiornaContesto();adatta();salvaDopo(E.p)};
  $("#flChips").onclick=e=>{const b=e.target.closest("button");if(b)fatto(b.dataset.v)};
  $("#flOk").onclick=()=>fatto($("#flAltro").value);$("#flNo").onclick=chiudiFoglio;
  const del=$("#flDel");if(del)del.onclick=()=>{if(del.dataset.ok){s.livelli.splice(s.attivo,1);s.attivo=0;chiudiFoglio();E.sel=null;E.undo=[];disegnaLivelli();aggiornaContesto();adatta();salvaDopo(E.p)}
    else{del.dataset.ok=1;del.textContent="Tocca ancora per eliminare "+l.nome;del.classList.add("solid")}}}
function disegnaStrumenti(){$("#edStrumenti").querySelectorAll("[data-tool]").forEach(b=>b.setAttribute("aria-pressed",b.dataset.tool===E.tool))}

/* ---------- uscita: un PDF con una pagina per livello ---------- */
async function pngLivello(l,titolo){const b=bbox(l);if(!b)return null;const M=1.2,TOP=1.1;
  const wM=b[2]-b[0]+2*M,hM=b[3]-b[1]+2*M+TOP;let s=Math.min(90,2600/wM,2600/hM);
  const cv=document.createElement("canvas");cv.width=Math.round(wM*s);cv.height=Math.round(hM*s);const ctx=cv.getContext("2d");
  ctx.fillStyle="#fff";ctx.fillRect(0,0,cv.width,cv.height);
  renderLivello(ctx,l,{s,ox:(M-b[0])*s,oy:(M+TOP-b[1])*s},{pal:PAL_STAMPA});
  ctx.fillStyle="#111";ctx.textAlign="left";ctx.textBaseline="top";const fs=Math.max(14,Math.min(30,s*.35));
  ctx.font=`600 ${fs}px Barlow, Arial, sans-serif`;ctx.fillText(titolo,s*.4,s*.35);
  ctx.font=`400 ${fs*.7}px Barlow, Arial, sans-serif`;ctx.fillText("Schizzo del rilievo, indicativo: fanno fede le quote rilevate.",s*.4,s*.35+fs*1.25);
  const blob=await new Promise(r=>cv.toBlob(r,"image/png"));return{bytes:new Uint8Array(await blob.arrayBuffer()),w:cv.width,h:cv.height}}
async function pdfSchizzo(p){if(!p.schizzo||!window.PDFLib)return null;const ls=p.schizzo.livelli.filter(l=>!livVuoto(l));if(!ls.length)return null;
  const doc=await PDFLib.PDFDocument.create();
  for(const l of ls){const im=await pngLivello(l,`${cartella(p)} · ${l.nome}`);if(!im)continue;
    const orizz=im.w>im.h,PW=orizz?841.89:595.28,PH=orizz?595.28:841.89,m=28,k=Math.min((PW-2*m)/im.w,(PH-2*m)/im.h);
    const pg=doc.addPage([PW,PH]),img=await doc.embedPng(im.bytes);pg.drawImage(img,{x:(PW-im.w*k)/2,y:PH-m-im.h*k,width:im.w*k,height:im.h*k})}
  return doc.save()}

/* ---------- avvio dell'editor ---------- */
(function(){const cv=$("#tela");
  cv.addEventListener("pointerdown",giu);cv.addEventListener("pointermove",muovi);cv.addEventListener("pointerup",su);cv.addEventListener("pointercancel",su);
  cv.addEventListener("wheel",e=>{e.preventDefault();const c=puntoCanvas(e),v=E.view,s=Math.max(8,Math.min(220,v.s*(e.deltaY<0?1.12:1/1.12)));
    const wx=(c.x-v.ox)/v.s,wy=(c.y-v.oy)/v.s;E.view={s,ox:c.x-wx*s,oy:c.y-wy*s};disegna()},{passive:false});
  $("#edStrumenti").onclick=e=>{const b=e.target.closest("[data-tool]");if(!b)return;E.tool=b.dataset.tool;if(E.tool!=="sel")E.sel=null;disegnaStrumenti();aggiornaContesto();disegna()};
  $("#edAnnulla").onclick=annulla;$("#edAdatta").onclick=adatta;$("#edFine").onclick=chiudiSchizzo;
  window.addEventListener("resize",()=>{if(E.p)ridimensiona()});
})();


/* ---------- avvio ---------- */
let avviata=false,obbligoPassword=false;
async function entra(user){
  UTENTE={id:user.id,email:user.email||""};await apriDB(user.id);
  applicaElenchi(leggiCache("elenchi",null));$("#chi").textContent=UTENTE.email;
  let prof=leggiCache("profilo",null);
  if(navigator.onLine){try{const {data,error}=await sb.from("profili").select("elenchi,deve_cambiare_password").eq("id",user.id).maybeSingle();
    if(!error&&data){prof=data;scriviCache("profilo",data)}}catch(e){}}
  if(prof&&prof.elenchi&&!leggiCache("elenchiDaInviare",false)){applicaElenchi(prof.elenchi);scriviCache("elenchi",L)}
  if(ERA_RECUPERO&&!entra.recuperoFatto){entra.recuperoFatto=true;vistaPassword(true);return}
  if(prof&&prof.deve_cambiare_password){obbligoPassword=true;vistaPassword(false);return}
  avviaApp();
}
function avviaApp(){vistaElenco();contaDaInviare().then(disegnaStato);
  if(avviata){sincronizza();return}avviata=true;sincronizza();
  setInterval(()=>sincronizza(),60000);
  window.addEventListener("online",()=>{disegnaStato();programmaSync(300)});
  window.addEventListener("offline",disegnaStato);
  document.addEventListener("visibilitychange",()=>{if(document.hidden)salvaSubito();else programmaSync(300)});
  window.addEventListener("pagehide",()=>{salvaSubito()});
}
$("#btnIndietro").onclick=()=>{if(vistaAttuale==="password"){vistaElenco();return}salvaSubito().finally(vistaElenco)};
$("#stato").onclick=()=>{if(STATO.errore)toast("Ultimo errore: "+STATO.errore+". Riprovo adesso.",4000);sincronizza()};
(async()=>{
  if("serviceWorker" in navigator)navigator.serviceWorker.register("sw.js").catch(()=>{});
  try{navigator.storage&&navigator.storage.persist&&navigator.storage.persist()}catch(e){}
  if(!sb){vistaConfig();return}
  sb.auth.onAuthStateChange(ev=>{if(ev==="PASSWORD_RECOVERY"&&vistaAttuale!=="password")setTimeout(()=>vistaPassword(true),0)});
  const {data:{session}}=await sb.auth.getSession();
  if(!session){vistaLogin();return}
  await entra(session.user);
})();
