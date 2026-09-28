/* =====================================================================
   MOND SHIPPING — MOTOR DE REGRAS v2 (Camadas 2 + 3)
   Determinístico, 100% browser, sem API.
   Recebe o JSON da Camada 1 e devolve { linhas, flags }.
   USAR VERBATIM. NÃO reescrever com parser próprio.
   ===================================================================== */

const ARMADOR_ALIASES = {
  'H*M':'HMM','HM*':'HMM','H M':'HMM','HMM':'HMM','MSK':'MAERSK','MAERSK':'MAERSK',
  'HPL':'HAPAG','HPL FAST SERVICE':'HAPAG','HAPAG':'HAPAG','HAPAG-LLOYD':'HAPAG',
  'MSC':'MSC','CMA':'CMA','CMA CGM':'CMA','COSCO':'COSCO','OOCL':'OOCL','ONE':'ONE',
  'YML':'YML','YANG MING':'YML','PIL':'PIL','ZIM':'ZIM','EMC':'EVERGREEN','EVERGREEN':'EVERGREEN','CSSC':'CSSC'
};
const SERVICE_SUFFIXES = ['FAST SERVICE','SANTANA SERVICE','ONLINE'];
const ISPS_TABLE = { 'HMM':25 };                         // COMPLETAR
const HMM_SOUTH_ASIA = { eff_teu:300, isps:25, handling:100 };
const PORTOS_SHENZHEN = ['SHEKOU','YANTIAN','SHENZHEN'];
const DESTINOS_NAO_SERVIDOS = ['ARGENTINA','URUGUAI','URUGUAY','BUENOS AIRES','MONTEVIDEO'];
const CONTAINERS = ["20' DRY","40' DRY","40' HIGH CUBE","40' NOR"];

const HEADER_34 = ['Produto','Cliente','Cidade Coleta','Origem','Destino','Cidade de Entrega','Zipcode Entrega','Armador','Coloader','Agente','Tp Container','Moeda','Vl Minimo','Vl. Frete','Dt Inicio Validade','Dt Fim Validade','Transit Time De','Transit Time Até','Tipo Embarque','Modalidade do Transporte','Free Time','Contrato','Contrato Unico','Mercadoria','Frequência','Limite de Peso','FT LS Destino Compra','FT Destino Compra','FT LS Origem Compra','Tarifa','Transbordo','Taxas','Observacao','FT Combinado Compra'];
const OBRIGATORIOS = ['Produto','Origem','Destino','Armador','Agente','Tp Container','Moeda','Vl. Frete','Dt Inicio Validade','Dt Fim Validade','Tipo Embarque','Free Time','Frequência'];

const up = s => (s ?? '').toString().trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
function formatBR(iso){ if(!iso) return ''; const d=(iso instanceof Date)?iso:new Date(iso+'T00:00:00'); if(isNaN(d))return''; const p=n=>String(n).padStart(2,'0'); return `${p(d.getDate())}/${p(d.getMonth()+1)}/${d.getFullYear()}`; }
const hojeBR = () => formatBR(new Date());

// 3.14 GUARD DE NÚMERO — "7600/7800" NUNCA vira 76007800
function parseNumGuard(raw){
  return String(raw).split(/[\/x×,\s]+/i)
    .map(t => { const n = t.replace(/[^\d.]/g,''); return n ? Number(n) : null; })
    .filter(v => v != null);
}

function stripServiceSuffix(raw){
  let name=(raw??'').toString().trim(), service=null;
  for(const suf of SERVICE_SUFFIXES){ const re=new RegExp('\\s*'+suf.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\s*','i');
    if(re.test(name)){ service=suf; name=name.replace(re,' ').trim(); } }
  return { armador:name, service };
}
function normalizarArmador(raw){
  const { armador:base, service }=stripServiceSuffix(raw);
  const mapped=ARMADOR_ALIASES[up(base)]||ARMADOR_ALIASES[base.toUpperCase()]||null;
  return { armador: mapped||base, service, reconhecido: !!mapped };
}
const normalizarPorto = p => PORTOS_SHENZHEN.includes(up(p)) ? 'Shenzhen' : (p??'').toString().trim();
const isJapao = o => /JAPAN|JAPAO/.test(up(o)) || /(TOKYO|YOKOHAMA|OSAKA|KOBE|NAGOYA|HAKATA|SHIMIZU|MOJI)/.test(up(o));
const servida = d => !DESTINOS_NAO_SERVIDOS.some(x => up(d).includes(x));
const isCSSC = a => up(a)==='CSSC';

// 3.3 preço -> contêiner
function mapearPrecos(precos={}, seq=[]){
  const out={}; const has=v=>v!=null&&v!==''&&!['nil','-','*'].includes(String(v).toLowerCase());
  const setDryHc=v=>{ out["40' DRY"]=v; out["40' HIGH CUBE"]=v; };
  let r=false;
  if(has(precos['20dry'])){ out["20' DRY"]=precos['20dry']; r=true; }
  if(has(precos['40dry'])||has(precos['40hc'])){ setDryHc(has(precos['40dry'])?precos['40dry']:precos['40hc']); r=true; }
  if(has(precos['40nor'])){ out["40' NOR"]=precos['40nor']; r=true; }
  if(!r && Array.isArray(seq)){ const s=seq.filter(has);
    if(s.length===3){ out["20' DRY"]=s[0]; setDryHc(s[1]); out["40' NOR"]=s[2]; }
    else if(s.length===2){ out["20' DRY"]=s[0]; setDryHc(s[1]); }
    else if(s.length===1){ out["20' DRY"]=s[0]; } }
  return out;
}

// 3.5 surcharges
const ADD_PATTERNS=[/\bisps\b/i,/sub\s*isps/i,/\bkb\b/i,/kickback/i,/add[\s-]?on/i];
const NOTE_PATTERNS=[/\bows\b/i,/overweight/i,/\bgw\b/i,/equipment\s*fee/i,/profit\s*share/i,/\bmbl\b/i,/shipper/i,/\bvia\b/i,/\bdirect\b/i,/restri/i,/chemical|quimic/i,/batter|bateria/i,/\beuro\b/i,/shekou/i,/pneus|tire/i];
function classificarSurcharges(surcharges=[], armador){
  let addBox20=0, addBox40=0; const observacoes=[], sflags=[];
  const raws=surcharges.map(s=>(s.raw||'').toLowerCase()).join(' | ');
  if(up(armador)==='HMM' && /eff/.test(raws) && /handl/.test(raws)){
    addBox20 += HMM_SOUTH_ASIA.eff_teu+HMM_SOUTH_ASIA.isps+HMM_SOUTH_ASIA.handling;
    addBox40 += HMM_SOUTH_ASIA.eff_teu*2+HMM_SOUTH_ASIA.isps+HMM_SOUTH_ASIA.handling;
    observacoes.push('HMM South Asia: EFF+ISPS+handling somados ao frete');
    return { addBox20, addBox40, observacoes, sflags };
  }
  for(const s of surcharges){
    const raw=(s.raw||'').toString();
    const isNote=NOTE_PATTERNS.some(re=>re.test(raw));
    const isAdd=ADD_PATTERNS.some(re=>re.test(raw));
    if(isNote && !isAdd){ observacoes.push(raw.trim()); continue; }
    if(isAdd){
      let v=(typeof s.valor==='number')?s.valor:null;
      if(v==null && /isps/i.test(raw)) v=ISPS_TABLE[up(armador)] ?? null;
      if(v==null){ sflags.push(`Surcharge aditivo sem valor: "${raw}"`); continue; }
      addBox20+=v; addBox40+=v; continue;
    }
    sflags.push(`Surcharge não classificado (add ou nota?): "${raw}"`);
  }
  return { addBox20, addBox40, observacoes, sflags };
}
const notasParaObservacao = (notas=[], tipo='tarifario') =>
  notas.map(n=>(n||'').toString().trim()).filter(Boolean)
       .filter(n=>!(tipo==='space' && /profit\s*share/i.test(n)));

function montarLinha34(o){
  const L={}; HEADER_34.forEach(h=>L[h]='');
  L['Produto']='Importação Marítima'; L['Origem']=o.origem; L['Destino']=o.destino;
  L['Armador']=o.armador; L['Agente']=o.agente; L['Tp Container']=o.tpContainer;
  L['Moeda']='USD'; L['Vl. Frete']=o.frete; L['Dt Inicio Validade']=o.dtIni;
  L['Dt Fim Validade']=o.dtFim; L['Tipo Embarque']='FCL'; L['Free Time']=(o.freeTime ?? '');
  L['Frequência']='Semanal'; L['Transbordo']=o.transbordo||''; L['Observacao']=o.observacao||'';
  if(o.transitDe) L['Transit Time De']=o.transitDe; if(o.transitAte) L['Transit Time Até']=o.transitAte;
  return L;
}

// 7 + 3.13 (diferencial por destino)
function processarTarifario(json){
  const linhas=[], flags=[]; const hoje=hojeBR();
  for(const oferta of (json.ofertas||[])){
    const { armador, service, reconhecido }=normalizarArmador(oferta.armador_raw);
    if(!reconhecido) flags.push({ tipo:'armador', msg:`Armador não reconhecido: "${oferta.armador_raw}"`, agente:json.agente });

    let origens=(oferta.origens||[]).map(normalizarPorto);
    if(json.excluir_japao) origens=origens.filter(o=>!isJapao(o));
    origens=[...new Set(origens)];

    // destinos: string (delta 0) ou objeto {nome,delta20,delta40}  -> 3.13
    const destinos=[];
    for(const d of (oferta.destinos||[])){
      if(typeof d==='string'){ if(servida(d)) destinos.push({nome:d,d20:0,d40:0}); }
      else if(servida(d.nome)) destinos.push({nome:d.nome,d20:d.delta20||0,d40:d.delta40||0});
    }

    const base=mapearPrecos(oferta.precos, oferta.precos_raw_seq);
    if(!base["20' DRY"]) flags.push({ tipo:'preco', msg:"Sem preço de 20' DRY", agente:json.agente, armador });

    const sc=classificarSurcharges(oferta.surcharges, armador);
    const obs=[...sc.observacoes, ...notasParaObservacao(oferta.notas_raw,'tarifario'),
               service && up(armador)==='MSC' ? `Serviço: ${service}` : null].filter(Boolean).join(' | ');
    sc.sflags.forEach(m=>flags.push({ tipo:'surcharge', msg:m, agente:json.agente, armador }));

    let dtIni=oferta.validade_inicio?formatBR(oferta.validade_inicio):hoje, dtFim;
    if(isCSSC(armador)){ dtIni=hoje; dtFim=formatBR(oferta.etd); } else dtFim=formatBR(oferta.validade_fim);
    if(!dtFim) flags.push({ tipo:'validade', msg:'Sem validade final', agente:json.agente, armador });

    for(const origem of origens) for(const dst of destinos) for(const ctr of CONTAINERS){
      const p=base[ctr]; if(p==null) continue;
      const is20=ctr.startsWith('20');
      const frete=Number(p) + (is20?dst.d20:dst.d40) + (is20?sc.addBox20:sc.addBox40);
      const ft=ctr.includes('NOR')?(oferta.free_time?.nor):(oferta.free_time?.dry_hc);
      if(ft==null) flags.push({ tipo:'freetime', msg:`Sem free time p/ ${ctr}`, agente:json.agente, armador });
      if(frete>50000) flags.push({ tipo:'valor', msg:`Frete suspeito (${frete}) — possível concatenação`, agente:json.agente, armador });
      linhas.push(montarLinha34({ agente:json.agente, armador, origem, destino:dst.nome, tpContainer:ctr,
        frete, dtIni, dtFim, freeTime:ft, observacao:obs, transbordo:oferta.transbordo,
        transitDe:oferta.transit_time?.de, transitAte:oferta.transit_time?.ate }));
    }
  }
  for(const l of linhas) for(const c of OBRIGATORIOS)
    if(l[c]===''||l[c]==null) flags.push({ tipo:'obrigatorio', bloqueia:true, msg:`Campo obrigatório vazio: ${c}`, agente:json.agente,
      ref:`${l['Armador']} ${l['Origem']}→${l['Destino']} ${l['Tp Container']}` });
  return { linhas, flags };
}

function dedupeTarifario(linhas){
  const seen=new Set(), out=[];
  for(const l of linhas){
    const k=['Agente','Armador','Origem','Destino','Tp Container','Vl. Frete','Dt Inicio Validade','Dt Fim Validade','Free Time','Observacao'].map(c=>l[c]).join('|');
    if(!seen.has(k)){ seen.add(k); out.push(l); }
  }
  return out;
}
function toTSV(header, linhas){ return [header.join('\t'), ...linhas.map(l=>header.map(h=>l[h]??'').join('\t'))].join('\n'); }

if (typeof module!=='undefined') module.exports={ processarTarifario, dedupeTarifario, toTSV, parseNumGuard, normalizarPorto, normalizarArmador, mapearPrecos, HEADER_34 };
