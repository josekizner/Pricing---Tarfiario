/* ==========================================================================
   LLM EXTRACT — MOND SHIPPING TARIFF BUILDER
   ========================================================================== */

/**
 * System prompt for LLM extraction (§8 of spec / Section 4 of brief).
 */
const LLM_SYSTEM_PROMPT = `Você extrai dados de cotações de frete marítimo (texto ou imagem) e devolve APENAS um JSON.
Você é um TRANSCRITOR, não um intérprete. NUNCA some surcharges ao frete, NUNCA decida qual
contêiner recebe qual preço, NUNCA calcule validade, NUNCA normalize nome de armador, NUNCA
junte portos (mantenha Shekou/Yantian como vieram). Só capture o que está escrito; null no que faltar.

Devolva este JSON (sem markdown, sem texto ao redor):
{ "agente": "<nome do agente>", "tipo": "tarifario",
  "ofertas": [ {
    "armador_raw": "<como aparece, ex 'MSK','H*M','PIL'>",
    "origens": ["<portos de origem como escritos>"],
    "destinos": ["<destino simples>", {"nome":"<porto>","delta20":<n>,"delta40":<n>}],
    "precos": { "20dry":<n|null>, "40dry":<n|null>, "40hc":<n|null>, "40nor":<n|null> },
    "precos_raw_seq": [<valores de frete na ordem em que aparecem>],
    "validade_inicio": "<yyyy-mm-dd|null>", "validade_fim": "<yyyy-mm-dd|null>", "etd": "<yyyy-mm-dd|null>",
    "free_time": { "dry_hc": <n|null>, "nor": <n|null> },
    "surcharges": [ {"raw":"<texto cru, ex '+isps','OWS USD400/box'>","valor":<n|null>,"unidade":"box|ctn|teu|kg|null"} ],
    "notas_raw": ["<condições soltas, ex 'PP +USD100/box','pneus','mbl cc'>"]
  } ]
}

REGRAS DE CAPTURA CRÍTICAS:
- NÚMEROS SEPARADOS POR / x × OU ESPAÇO SÃO VALORES DISTINTOS. "7600/7800" => dois números
  [7600,7800], JAMAIS 76007800. "8300/8500/8500" => [8300,8500,8500].
- Preço rotulado: 20'/20GP=20dry; 40'/40DRY=40dry; 40HC/40GP/40HQ=40hc; NOR/40NOR=40nor.
  Sem rótulo: preencha precos_raw_seq na ordem. "nil"/"-"/"*" => null.
- Diferencial por destino: "SUAPE +600/600", "VITORIA +800/1000" => objeto destino com delta20/delta40.
  O destino base (ex SSZ/PNG/Rio Grande) vai como string.
- Datas => yyyy-mm-dd. Se só houver validade final, preencha validade_fim e deixe validade_inicio null.
- Um objeto em "ofertas" por armador. Se o email tem vários armadores, vários objetos.
- Em dúvida de leitura, prefira null a chutar.`;

/**
 * Validate that a parsed JSON matches the expected raw offer schema.
 * Returns { valid: boolean, errors: string[] }
 */
function validateRawOfferSchema(json) {
    const errors = [];
    
    if (!json || typeof json !== 'object') {
        errors.push('JSON inválido: deve ser um objeto');
        return { valid: false, errors };
    }
    
    if (!json.agente || typeof json.agente !== 'string') {
        errors.push('Campo "agente" ausente ou não é string');
    }
    
    if (!json.tipo || json.tipo !== 'tarifario') {
        errors.push('Campo "tipo" deve ser "tarifario"');
    }
    
    if (!Array.isArray(json.ofertas)) {
        errors.push('Campo "ofertas" deve ser um array');
        return { valid: errors.length === 0, errors };
    }
    
    for (let i = 0; i < json.ofertas.length; i++) {
        const o = json.ofertas[i];
        if (!o.armador_raw) errors.push(`Oferta ${i + 1}: "armador_raw" ausente`);
        if (!Array.isArray(o.origens) || o.origens.length === 0) errors.push(`Oferta ${i + 1}: "origens" ausente ou vazio`);
        if (!Array.isArray(o.destinos) || o.destinos.length === 0) errors.push(`Oferta ${i + 1}: "destinos" ausente ou vazio`);
    }
    
    return { valid: errors.length === 0, errors };
}

/**
 * Parse user-pasted JSON text into a raw offer object.
 * This is the manual (Option C) extraction method.
 */
function parseManualJSON(jsonText) {
    try {
        const parsed = JSON.parse(jsonText);
        const validation = validateRawOfferSchema(parsed);
        return { success: true, data: parsed, validation };
    } catch (e) {
        return { success: false, error: `Erro ao interpretar JSON: ${e.message}`, validation: { valid: false, errors: [e.message] } };
    }
}

/**
 * Try to auto-detect if pasted text is JSON or needs LLM extraction.
 */
function detectInputType(text) {
    const trimmed = (text || '').trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return 'json';
    }
    return 'text';
}

/**
 * Offline Regex-based Text Parser.
 * Scans pasted text to extract quote offers without calling any LLM API.
 */
function parseRawText(text) {
    if (!text) return [];
    
    const lines = text.split('\n').map(l => l.trim());
    const offers = [];
    let currentOffer = null;
    
    function startNewOffer() {
        if (currentOffer && (currentOffer.pol_raw || currentOffer.pod_raw || currentOffer.armador_raw)) {
            offers.push(currentOffer);
        }
        currentOffer = {
            armador_raw: null,
            pol_raw: null,
            pod_raw: null,
            precos_raw: {},
            isps_raw: null,
            free_time_raw: null,
            validade_raw: null,
            volume_raw: null,
            etd_raw: null,
            remark_raw: null,
            navio_raw: null,
            notas_raw: []
        };
    }
    
    startNewOffer();
    
    const carrierNames = ['HMM', 'MAERSK', 'MSK', 'CMA', 'OOCL', 'ONE', 'YANG MING', 'YML', 'EVERGREEN', 'EMC', 'HAPAG', 'HPL', 'MSC', 'ZIM', 'COSCO', 'PIL'];
    
    for (let line of lines) {
        if (!line) continue;
        
        const hasPOLKey = /^(pol|origin|origem|loading\s*port|origem_raw)\s*[:=\-–]/i.test(line);
        const hasPODKey = /^(pod|destination|destino|discharge\s*port|destino_raw)\s*[:=\-–]/i.test(line);
        const hasCarrierKey = /^(carrier|armador|line|shipping\s*line)\s*[:=\-–]/i.test(line);
        
        if ((hasPOLKey && currentOffer.pol_raw) || 
            (hasCarrierKey && currentOffer.armador_raw) ||
            (hasPODKey && currentOffer.pod_raw)) {
            startNewOffer();
        }
        
        // 1. Carrier
        const carrierMatch = line.match(/^(?:carrier|armador|line|shipping\s*line|vessel\s*line|carrier_raw)\s*[:=\-–]\s*(.+)$/i);
        if (carrierMatch) {
            currentOffer.armador_raw = carrierMatch[1].trim();
            continue;
        }
        
        // 2. POL
        const polMatch = line.match(/^(?:pol|origin|origem|loading\s*port|port\s*of\s*loading|origem_raw)\s*[:=\-–]\s*(.+)$/i);
        if (polMatch) {
            currentOffer.pol_raw = polMatch[1].trim();
            continue;
        }
        
        // 3. POD
        const podMatch = line.match(/^(?:pod|destination|destino|discharge\s*port|port\s*of\s*discharge|destino_raw)\s*[:=\-–]\s*(.+)$/i);
        if (podMatch) {
            currentOffer.pod_raw = podMatch[1].trim();
            continue;
        }
        
        // 4. Validity
        const valMatch = line.match(/^(?:validity|valid\s*to|valid|validade|periodo|period|val)\s*[:=\-–]\s*(.+)$/i);
        if (valMatch) {
            currentOffer.validade_raw = valMatch[1].trim();
            continue;
        }
        
        // 5. Free Time
        const ftMatch = line.match(/^(?:free\s*time|freetime|ft|free-time)\s*[:=\-–]\s*(.+)$/i);
        if (ftMatch) {
            currentOffer.free_time_raw = ftMatch[1].trim();
            continue;
        }
        
        // 6. Volume
        const volMatch = line.match(/^(?:volume|vol|qty|quantity|quantidade)\s*[:=\-–]\s*(.+)$/i);
        if (volMatch) {
            currentOffer.volume_raw = volMatch[1].trim();
            continue;
        }
        
        // 7. ETD
        const etdMatch = line.match(/^(?:etd|departure|saida)\s*[:=\-–]\s*(.+)$/i);
        if (etdMatch) {
            currentOffer.etd_raw = etdMatch[1].trim();
            continue;
        }
        
        // 8. Vessel
        const vslMatch = line.match(/^(?:vessel|navio|vessel\s*name)\s*[:=\-–]\s*(.+)$/i);
        if (vslMatch) {
            currentOffer.navio_raw = vslMatch[1].trim();
            continue;
        }
        
        // 9. ISPS
        const ispsMatch = line.match(/^(?:isps|isps_raw)\s*[:=\-–]\s*(.+)$/i);
        if (ispsMatch) {
            currentOffer.isps_raw = ispsMatch[1].trim();
            continue;
        }
        
        // 10. Remarks
        const remMatch = line.match(/^(?:remark|remarks|notes?|observacao|obs|remark_raw)\s*[:=\-–]\s*(.+)$/i);
        if (remMatch) {
            currentOffer.remark_raw = remMatch[1].trim();
            currentOffer.notas_raw.push(remMatch[1].trim());
            continue;
        }
        
        // 11. Container Prices with label
        const priceLabelMatch = line.match(/^(20\'?(?:dry|gp)?|40\'?(?:dry|gp|hc|hq|nor|rf)?)\s*[:=\-–]\s*([$€\d\s.,kK+-]+)$/i);
        if (priceLabelMatch) {
            let label = priceLabelMatch[1].trim().toUpperCase().replace(/['\s]/g, '');
            if (label === '20GP' || label === '20DRY' || label === '20') label = '20';
            else if (label === '40GP' || label === '40DRY' || label === '40') label = '40';
            else if (label === '40HC' || label === '40HQ') label = '40HQ';
            else if (label === '40NOR' || label === '40RF') label = '40NOR';
            
            const val = priceLabelMatch[2].trim();
            currentOffer.precos_raw[label] = val;
            continue;
        }

        // 12. Inline/Tabular parse (e.g. "SHA SSZ 6100 6200 6800")
        const parts = line.split(/[\s\t]+/).filter(Boolean);
        if (parts.length >= 3) {
            let foundPOL = null;
            let foundPOD = null;
            let prices = [];
            
            for (const part of parts) {
                const upper = part.toUpperCase().replace(/[^A-Z]/g, '');
                if (POL_DECODE && POL_DECODE[upper]) {
                    foundPOL = upper;
                } else if (POD_DECODE && POD_DECODE[upper]) {
                    foundPOD = upper;
                } else {
                    const cleanNum = parseInt(part.replace(/[^\d]/g, ''));
                    if (!isNaN(cleanNum) && cleanNum > 1000) {
                        prices.push(String(cleanNum));
                    }
                }
            }
            
            if (foundPOL && foundPOD) {
                startNewOffer();
                currentOffer.pol_raw = foundPOL;
                currentOffer.pod_raw = foundPOD;
                if (prices.length === 3) {
                    currentOffer.precos_raw['20'] = prices[0];
                    currentOffer.precos_raw['40HQ'] = prices[1];
                    currentOffer.precos_raw['40NOR'] = prices[2];
                } else if (prices.length === 2) {
                    currentOffer.precos_raw['20'] = prices[0];
                    currentOffer.precos_raw['40HQ'] = prices[1];
                }
                startNewOffer();
                continue;
            }
        }
        
        // 13. Check if sequential prices e.g. "5000 / 6000 / 6200"
        const numbers = line.match(/\b\d{4}\b/g);
        if (numbers && (numbers.length === 2 || numbers.length === 3 || numbers.length === 4)) {
            if (numbers.length === 3) {
                currentOffer.precos_raw['20'] = numbers[0];
                currentOffer.precos_raw['40HQ'] = numbers[1];
                currentOffer.precos_raw['40NOR'] = numbers[2];
            } else if (numbers.length === 2) {
                currentOffer.precos_raw['20'] = numbers[0];
                currentOffer.precos_raw['40HQ'] = numbers[1];
            }
            continue;
        }
        
        // 14. Carrier name fallback
        let isCarrierNameOnly = false;
        for (const c of carrierNames) {
            const re = new RegExp('^' + c.replace('*', '\\*') + '$', 'i');
            if (re.test(line)) {
                currentOffer.armador_raw = c;
                isCarrierNameOnly = true;
                break;
            }
        }
        if (isCarrierNameOnly) continue;
        
        // 15. Remarks general line
        if (line.length > 5 && !line.includes(':')) {
            currentOffer.notas_raw.push(line);
        }
    }
    
    if (currentOffer && (currentOffer.pol_raw || currentOffer.pod_raw || currentOffer.armador_raw)) {
        offers.push(currentOffer);
    }
    
    for (const offer of offers) {
        if (offer.notas_raw.length > 0 && !offer.remark_raw) {
            offer.remark_raw = offer.notas_raw.join('; ');
        }
    }
    
    return offers;
}

/**
 * Intelligent extraction using Gemini Multimodal Vision API.
 */
async function extractWithLLM(text, images, agente, geminiKey) {
    if (!geminiKey) {
        return {
            success: false,
            error: 'Chave Gemini API ausente. Por favor, insira sua chave no campo correspondente.'
        };
    }
    
    const parts = [
        { text: LLM_SYSTEM_PROMPT },
        { text: `O ano atual é ${new Date().getFullYear()}. Extraia as ofertas do seguinte agente: ${agente || 'Desconhecido'}` }
    ];
    
    if (text) {
        parts.push({ text: `Texto bruto da cotação:\n${text}` });
    }
    
    if (images && images.length > 0) {
        for (const img of images) {
            const base64Data = img.dataUrl.split(',')[1];
            parts.push({
                inlineData: {
                    mimeType: img.type || 'image/png',
                    data: base64Data
                }
            });
        }
    }
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${geminiKey}`;
    
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                contents: [{ parts }],
                generationConfig: {
                    responseMimeType: 'application/json'
                }
            })
        });
        
        if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`HTTP ${response.status}: ${errBody || response.statusText}`);
        }
        
        const resultJson = await response.json();
        
        if (!resultJson.candidates || resultJson.candidates.length === 0) {
            throw new Error('Gemini API retornou uma resposta sem candidatos.');
        }
        
        const candidateText = resultJson.candidates[0].content.parts[0].text;
        
        let cleanedText = candidateText.trim();
        if (cleanedText.startsWith('```')) {
            cleanedText = cleanedText.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '');
        }
        
        const parsed = JSON.parse(cleanedText);
        
        // Verify output schema
        const validation = validateRawOfferSchema(parsed);
        return {
            success: true,
            data: parsed,
            validation
        };
    } catch (e) {
        console.error('LLM request failed:', e);
        return {
            success: false,
            error: e.message
        };
    }
}

/**
 * Build a template text for the user to fill in.
 */
function getTemplateText(tipo = 'tarifario') {
    return `Prezados, seguem nossas tarifas promocionais válidas até 30 de Junho:

Carrier: HMM
POL: SHANGHAI / NINGBO
POD: SANTOS / IMBITUBA / NAVEGANTES
20GP: USD 7810
40HQ: USD 8020
40NOR: USD 6920
Validity: 22-Jun a 30-Jun
Free time: 21 days dry, 18 days NOR
Remarks: Santos & Navegantes via FL2. Sujeito a taxas locais de destino.

Carrier: MSC
POL: SHANGHAI
POD: PORTONAVE
40HQ: USD 8100
Validity: 30-Jun
Remarks: Apenas cargas secas.`;
}

function getTemplateSpaceText() {
    return `Temos os seguintes espaços confirmados (Space on Hand) disponíveis para fechamento imediato:

Carrier: HMM
POL: SHANGHAI
POD: NAVEGANTES
40HQ: USD 7244
Volume: 2 containers
ETD: 25-Jun
Vessel: CC THORIUM / 0BD0KW1MA
Remarks: Podemos tentar alterar destino para Santos/Paranaguá sob consulta.

Carrier: OOCL
POL: NINGBO
POD: SANTOS
40HQ: USD 7500
Volume: 1 container
ETD: 28-Jun
Vessel: OOCL BRUSSELS / 056E
Remarks: Spot rate, liberação de draft imediata.`;
}
