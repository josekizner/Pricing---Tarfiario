/* ==========================================================================
   TARIFF ENGINE — MOND SHIPPING
   Deterministic pipeline: Raw JSON → Normalize → Expand → Validate → TSV
   Spec §2–§7. No LLM here — pure business rules.
   ========================================================================== */

/* ──────────────────────────────────────────────────────────────────────────────
   UTILITY HELPERS
   ────────────────────────────────────────────────────────────────────────── */

function currentYear() {
    return new Date().getFullYear();
}

function todayStr() {
    const d = new Date();
    return padDate(d.getDate()) + '/' + padDate(d.getMonth() + 1) + '/' + d.getFullYear();
}

function padDate(n) {
    return String(n).padStart(2, '0');
}

function parseMonthName(m) {
    return MONTH_MAP[(m || '').toUpperCase()] || null;
}

/** Strip thousand separators, parse to integer */
function cleanPrice(val) {
    if (val == null) return null;
    const s = String(val).replace(/[,.\s]/g, '').replace(/[^0-9-]/g, '');
    const n = parseInt(s, 10);
    return isNaN(n) ? null : n;
}

/** Check if a value is a skip marker */
function isSkip(val) {
    if (val == null || val === '') return true;
    return RE_SKIP.test(String(val).trim());
}

/* ──────────────────────────────────────────────────────────────────────────────
   §2.1 + §2.2  CARRIER DECODE
   ────────────────────────────────────────────────────────────────────────── */

function decodeCarrier(raw) {
    if (!raw) return { carrier: '', service: null };
    let cleaned = raw.trim().toUpperCase();
    
    // Extract service name before stripping
    const service = extractServiceName(cleaned);
    
    // Strip service suffixes
    for (const re of CARRIER_SERVICE_SUFFIXES) {
        cleaned = cleaned.replace(re, '');
    }
    cleaned = cleaned.trim();
    
    // Lookup in decode table
    const canonical = CARRIER_DECODE[cleaned];
    if (canonical) return { carrier: canonical, service };
    
    // Try without spaces/hyphens
    const noSpace = cleaned.replace(/[\s-]/g, '');
    for (const [key, val] of Object.entries(CARRIER_DECODE)) {
        if (key.replace(/[\s-]/g, '') === noSpace) return { carrier: val, service };
    }
    
    // Unknown carrier — keep as-is, flag it
    return { carrier: cleaned, service, unknown: true };
}

/* ──────────────────────────────────────────────────────────────────────────────
   §2.4  POL DECODE (Origin)
   ────────────────────────────────────────────────────────────────────────── */

function decodePOL(raw, excludeJapan = true) {
    if (!raw) return [];
    const codes = raw.split(/\s*(?:[/,;&+]|\band\b)\s*/i).map(s => s.trim().toUpperCase()).filter(Boolean);
    const result = [];
    
    for (const code of codes) {
        const canonical = POL_DECODE[code];
        if (!canonical) {
            // Try as-is with title case
            result.push(code.charAt(0) + code.slice(1).toLowerCase());
            continue;
        }
        if (canonical === '__SHENZHEN__') {
            result.push('Shekou', 'Yantian');
        } else {
            result.push(canonical);
        }
    }
    
    // Deduplicate
    const unique = [...new Set(result)];
    
    // Filter Japan if toggle is on
    if (excludeJapan) {
        return unique.filter(p => !JAPAN_PORTS.has(p));
    }
    return unique;
}

/* ──────────────────────────────────────────────────────────────────────────────
   §2.5  POD DECODE (Destination)
   ────────────────────────────────────────────────────────────────────────── */

function decodePOD(raw) {
    if (!raw) return [];
    const codes = raw.split(/\s*(?:[/,;&+]|\band\b)\s*/i).map(s => s.trim().toUpperCase()).filter(Boolean);
    const result = [];
    
    for (const code of codes) {
        // Check discard list
        if (DISCARD_POD_CODES[code]) continue;
        
        const canonical = POD_DECODE[code];
        if (canonical) {
            if (!DISCARD_PODS.has(canonical)) {
                result.push(canonical);
            }
        } else {
            // Unknown — keep as-is, title case
            const tc = code.charAt(0) + code.slice(1).toLowerCase();
            if (!DISCARD_PODS.has(tc)) {
                result.push(tc);
            }
        }
    }
    
    return [...new Set(result)];
}

/* ──────────────────────────────────────────────────────────────────────────────
   §3.4  MAP PRICES (raw price keys → canonical containers)
   ────────────────────────────────────────────────────────────────────────── */

function mapPrices(precosRaw, precosRawSeq) {
    if (!precosRaw || typeof precosRaw !== 'object') precosRaw = {};
    const result = {};
    
    // Check if we have precosRawSeq and no explicit container labels in precosRaw
    const keys = Object.keys(precosRaw);
    const hasExplicitLabels = keys.some(key => /20|40|nor|hc|hq|dry|gp/i.test(key));
    
    if (!hasExplicitLabels && precosRawSeq && Array.isArray(precosRawSeq) && precosRawSeq.length > 0) {
        const cleanSeq = precosRawSeq.map(cleanPrice).filter(v => v !== null && v > 0);
        if (cleanSeq.length === 3) {
            result["20' DRY"] = cleanSeq[0];
            result["40' DRY"] = cleanSeq[1];
            result["40' HIGH CUBE"] = cleanSeq[1];
            result["40' NOR"] = cleanSeq[2];
        } else if (cleanSeq.length === 2) {
            result["20' DRY"] = cleanSeq[0];
            result["40' DRY"] = cleanSeq[1];
            result["40' HIGH CUBE"] = cleanSeq[1];
        }
    }
    
    for (const [key, val] of Object.entries(precosRaw)) {
        if (isSkip(val)) continue;
        
        const price = cleanPrice(val);
        if (price === null || price <= 0) continue;
        
        const normalizedKey = key.replace(/['\s]/g, '').toUpperCase();
        const mapped = CONTAINER_KEY_MAP[normalizedKey];
        
        if (mapped === '__40_AND_HC__') {
            // Same price for 40' DRY and 40' HIGH CUBE
            result["40' DRY"] = price;
            result["40' HIGH CUBE"] = price;
        } else if (mapped) {
            result[mapped] = price;
        } else {
            // Try partial matching
            if (/20/.test(key) && /GP|DRY/i.test(key)) {
                result["20' DRY"] = price;
            } else if (/40/.test(key) && /NOR|RF|REEFER/i.test(key)) {
                result["40' NOR"] = price;
            } else if (/40/.test(key) && /HQ|HC|HIGH/i.test(key)) {
                result["40' HIGH CUBE"] = price;
                // If no 40'DRY set yet, same price
                if (!result["40' DRY"]) result["40' DRY"] = price;
            } else if (/40/.test(key) && /GP|DRY/i.test(key)) {
                result["40' DRY"] = price;
            } else if (/40/.test(key)) {
                // Plain "40" — map to both 40' DRY and 40' HIGH CUBE
                result["40' DRY"] = price;
                if (!result["40' HIGH CUBE"]) result["40' HIGH CUBE"] = price;
            } else if (/20/.test(key)) {
                result["20' DRY"] = price;
            }
        }
    }
    
    return result;
}

/* ──────────────────────────────────────────────────────────────────────────────
   §3.5  FREE TIME PARSING
   ────────────────────────────────────────────────────────────────────────── */

function parseFreeTime(ftRaw) {
    if (!ftRaw) return { dry: null, nor: null };
    const s = String(ftRaw).trim();
    
    // "21/DRY,18/NOR"
    const dryMatch = s.match(/(\d+)\s*\/?\s*DRY/i);
    const norMatch = s.match(/(\d+)\s*\/?\s*NOR/i);
    
    if (dryMatch && norMatch) {
        return { dry: parseInt(dryMatch[1]), nor: parseInt(norMatch[1]) };
    }
    
    // "21/DRY&NOR" — both same
    const bothMatch = s.match(/(\d+)\s*\/?\s*DRY\s*[&,]\s*NOR/i);
    if (bothMatch) {
        const val = parseInt(bothMatch[1]);
        return { dry: val, nor: val };
    }
    
    // "21" — single number, applies to both
    const singleMatch = s.match(/^(\d+)$/);
    if (singleMatch) {
        const val = parseInt(singleMatch[1]);
        return { dry: val, nor: val };
    }
    
    // Try to extract any number
    const anyNum = s.match(/(\d+)/);
    if (anyNum) {
        const val = parseInt(anyNum[1]);
        return { dry: val, nor: val };
    }
    
    return { dry: null, nor: null };
}

/* ──────────────────────────────────────────────────────────────────────────────
   §3.6  VALIDITY DATE PARSING
   ────────────────────────────────────────────────────────────────────────── */

function parseValidity(validadeRaw, etdRaw) {
    const year = currentYear();
    let inicio = todayStr();
    let fim = null;
    
    if (validadeRaw) {
        const s = String(validadeRaw).trim();
        
        // "6.22-6.30" or "06.22-06.30" → month.day-month.day
        const rangeMatch = s.match(/(\d{1,2})[.\-/](\d{1,2})\s*[-–]\s*(\d{1,2})[.\-/](\d{1,2})/);
        if (rangeMatch) {
            const m1 = parseInt(rangeMatch[1]);
            const d1 = parseInt(rangeMatch[2]);
            const m2 = parseInt(rangeMatch[3]);
            const d2 = parseInt(rangeMatch[4]);
            inicio = padDate(d1) + '/' + padDate(m1) + '/' + year;
            fim    = padDate(d2) + '/' + padDate(m2) + '/' + year;
            return { inicio, fim };
        }
        
        // "valid to 30/Jun" or "valid to 30 Jun"
        const validToMatch = s.match(RE_VALID_TO);
        if (validToMatch) {
            const day = parseInt(validToMatch[1]);
            const month = parseMonthName(validToMatch[2]);
            if (month) {
                fim = padDate(day) + '/' + padDate(month) + '/' + year;
                return { inicio, fim };
            }
        }
        
        // "ETD 6.29" or "ETD 29/Jun"
        const etdMatch = s.match(RE_ETD_ONLY);
        if (etdMatch) {
            const d = parseInt(etdMatch[1]);
            let m = parseMonthName(etdMatch[2]);
            if (!m) m = parseInt(etdMatch[2]);
            if (m) {
                fim = padDate(d) + '/' + padDate(m) + '/' + year;
                return { inicio, fim };
            }
        }
        
        // Try DD/MM/YYYY or DD-MM-YYYY range
        const fullDateRange = s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\s*[-–a]\s*(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
        if (fullDateRange) {
            const y1 = fullDateRange[3].length === 2 ? '20' + fullDateRange[3] : fullDateRange[3];
            const y2 = fullDateRange[6].length === 2 ? '20' + fullDateRange[6] : fullDateRange[6];
            inicio = padDate(parseInt(fullDateRange[1])) + '/' + padDate(parseInt(fullDateRange[2])) + '/' + y1;
            fim    = padDate(parseInt(fullDateRange[4])) + '/' + padDate(parseInt(fullDateRange[5])) + '/' + y2;
            return { inicio, fim };
        }
        
        // Single date DD/MM/YYYY as fim
        const singleDate = s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
        if (singleDate) {
            const y = singleDate[3].length === 2 ? '20' + singleDate[3] : singleDate[3];
            fim = padDate(parseInt(singleDate[1])) + '/' + padDate(parseInt(singleDate[2])) + '/' + y;
            return { inicio, fim };
        }
    }
    
    // ETD field for sailing-specific
    if (etdRaw) {
        const etdM = String(etdRaw).match(RE_ETD);
        if (etdM) {
            const day = parseInt(etdM[1]);
            const month = parseMonthName(etdM[2]);
            if (month) {
                fim = padDate(day) + '/' + padDate(month) + '/' + year;
                return { inicio, fim };
            }
        }
    }
    
    return { inicio, fim };
}

/* ──────────────────────────────────────────────────────────────────────────────
   §3.7  SURCHARGES — SOMAR vs OBSERVAÇÃO
   ────────────────────────────────────────────────────────────────────────── */

function parseSurcharges(remarkRaw, armador, origens) {
    const result = {
        isps: null,          // ISPS value to add (per box)
        ispsExplicit: false,  // was ISPS explicitly stated?
        eff: null,           // EFF per TEU
        handling: null,      // handling per box
        handlingExcept: [],  // origins to exclude from handling
        kb: null,            // kickback per box
        subIsps: null,       // sub ISPS
        addons: [],          // [{origem, container, valor, unidade}]
        observations: [],    // strings for Observação field
    };
    
    if (!remarkRaw) return result;
    const s = String(remarkRaw);
    
    // ISPS explicit value
    const ispsMatch = s.match(RE_ISPS_VAL);
    if (ispsMatch) {
        result.isps = parseInt(ispsMatch[1]);
        result.ispsExplicit = true;
    }
    
    // "+isps" without value (space on hand style) — use fallback
    if (!result.ispsExplicit && /\+\s*isps/i.test(s)) {
        result.isps = ISPS_FALLBACK[armador] || 0;
        result.ispsExplicit = false;
    }
    
    // EFF
    const effMatch = s.match(RE_EFF);
    if (effMatch) result.eff = parseInt(effMatch[1]);
    
    // Handling
    const handMatch = s.match(RE_HANDLING);
    if (handMatch) {
        result.handling = parseInt(handMatch[1]);
        // Check for "except VN" / "except HCM"
        const exceptMatch = s.match(RE_HANDLING_EXCEPT);
        if (exceptMatch) {
            const excPorts = exceptMatch[1].split(/[,\s]+/).map(c => c.trim()).filter(Boolean);
            for (const exc of excPorts) {
                const decoded = POL_DECODE[exc.toUpperCase()];
                if (decoded && decoded !== '__SHENZHEN__') result.handlingExcept.push(decoded);
                else if (exc.toUpperCase() === 'VN') {
                    result.handlingExcept.push('Ho Chi Minh', 'Hai Phong');
                }
            }
        }
    }
    
    // Kickback
    const kbMatch = s.match(RE_KB);
    if (kbMatch) result.kb = parseInt(kbMatch[1]);
    
    // Sub ISPS
    const subMatch = s.match(RE_SUB_ISPS);
    if (subMatch) result.subIsps = parseInt(subMatch[1]);
    
    // Add-on per origin: "SHEKOU + ADD ON USD 60/CTN"
    const addonCtnMatch = s.match(RE_ADDON_CTN);
    // More specific origin-based add-ons
    const addonOrigRegex = /([A-Z]{2,})\s*\+\s*(?:ADD\s*ON\s*)?(?:USD\s*)?(\d+)\s*\/\s*(40NOR|CTN|BOX|TEU|20GP|DRY)/gi;
    let m;
    while ((m = addonOrigRegex.exec(s)) !== null) {
        const origCode = m[1].toUpperCase();
        const valor = parseInt(m[2]);
        const unit = m[3].toUpperCase();
        const origDecoded = POL_DECODE[origCode];
        
        let container = '*';
        if (unit === '40NOR') container = "40' NOR";
        else if (unit === '20GP') container = "20' DRY";
        else if (unit === 'DRY') container = '__DRY_ALL__';
        
        if (origDecoded && origDecoded !== '__SHENZHEN__') {
            result.addons.push({ origem: origDecoded, container, valor, unidade: 'box' });
        } else if (origDecoded === '__SHENZHEN__') {
            result.addons.push({ origem: 'Shekou', container, valor, unidade: 'box' });
            result.addons.push({ origem: 'Yantian', container, valor, unidade: 'box' });
        }
    }
    
    // Minus per origin: "ex Qingdao, minus USD 100/box"
    const minusMatch = s.match(RE_MINUS_ORIG);
    if (minusMatch) {
        const origCode = minusMatch[1].toUpperCase();
        const valor = -parseInt(minusMatch[2]);
        const origDecoded = POL_DECODE[origCode] || origCode;
        result.addons.push({ origem: origDecoded, container: '*', valor, unidade: 'box' });
    }
    
    // Profit share → DO NOT include (internal commercial info)
    // But check and note it for ourselves
    if (RE_PROFIT_SHARE.test(s)) {
        // Silently skip — not included per spec §4.11
    }
    
    // Everything that goes to OBSERVAÇÃO (not summed)
    const obsPatterns = [
        { re: /OWS\s*(?:USD\s*)?[\d.,]+/i, label: null },
        { re: /GW\s*(?:over|>|less than|<|under)\s*[\d.,]+\s*(?:KGS?|TON|T)/i, label: null },
        { re: /equipment\s*fee[^;.]*/i, label: null },
        { re: /(?:via|t\/s|t\/s via|tranship(?:ment)?)\s+[A-Za-z\s]+/i, label: null },
        { re: /direct/i, label: 'Direct service' },
        { re: /HEA\s*USD\s*\d+\/\d+['']?\s*(?:if|se|when)\s*>?\s*\d+t/i, label: null },
        { re: /no\s+(?:chemical|battery|DG|hazardous)[^;.]*/i, label: null },
        { re: /(?:IOA|RIO|NVT|SSZ|ITJ)\s*(?:via|\/)\s*\w+/i, label: null },
    ];
    
    for (const { re, label } of obsPatterns) {
        const match = s.match(re);
        if (match) {
            result.observations.push(label || match[0].trim());
        }
    }
    
    // No equipment → track separately
    const noEquipMatch = s.match(RE_NO_EQUIP);
    if (noEquipMatch) {
        result.noEquipment = noEquipMatch[1].toUpperCase();
    }
    
    return result;
}

/* ──────────────────────────────────────────────────────────────────────────────
   §4.10  RESOLVE +ISPS for Space on Hand
   ────────────────────────────────────────────────────────────────────────── */

function resolveISPS(basePrice, armador) {
    const isps = ISPS_FALLBACK[armador] || 0;
    return basePrice + isps;
}

/* ──────────────────────────────────────────────────────────────────────────────
   §4.5  PARSE SPACE FRETE
   ────────────────────────────────────────────────────────────────────────── */

function parseSpaceFrete(freteStr, armador) {
    if (!freteStr || /not\s*updated/i.test(freteStr) || freteStr.trim() === '') {
        return { value: null, pending: true };
    }
    
    const s = String(freteStr).trim();
    
    // Check for base+isps pattern
    const ispsToken = s.match(RE_ISPS_TOKEN);
    if (ispsToken) {
        const base = parseInt(ispsToken[1]);
        return { value: resolveISPS(base, armador), pending: false, ispsResolved: true };
    }
    
    // Plain number
    const cleaned = s.replace(/[USD$,.\s]/g, '');
    const n = parseInt(cleaned);
    if (!isNaN(n) && n > 0) {
        return { value: n, pending: false };
    }
    
    return { value: null, pending: true };
}

/* ──────────────────────────────────────────────────────────────────────────────
   §4.4  PARSE VOLUME
   ────────────────────────────────────────────────────────────────────────── */

function parseVolume(volRaw) {
    if (!volRaw) return { qty: null, raw: '' };
    const s = String(volRaw).trim();
    
    // "1+1" → 2, "1+1+1" → 3
    if (/^\d+(\s*\+\s*\d+)+$/.test(s)) {
        const parts = s.split('+').map(p => parseInt(p.trim()));
        const total = parts.reduce((a, b) => a + b, 0);
        return { qty: total, raw: s };
    }
    
    // Plain number
    const n = parseInt(s);
    if (!isNaN(n) && n > 0) {
        return { qty: n, raw: s };
    }
    
    // "N" or unresolved
    return { qty: null, raw: s, unresolved: true };
}

/* ──────────────────────────────────────────────────────────────────────────────
   §4.7  PARSE SPACE ETD
   ────────────────────────────────────────────────────────────────────────── */

function parseSpaceETD(etdRaw) {
    if (!etdRaw) return null;
    const s = String(etdRaw).trim();
    const year = currentYear();
    
    // "25-Jun" → "25/06/2026"
    const m = s.match(RE_ETD);
    if (m) {
        const day = parseInt(m[1]);
        const month = parseMonthName(m[2]);
        if (month) {
            return padDate(day) + '/' + padDate(month) + '/' + year;
        }
    }
    
    // "1-Jul" → "01/07/2026"
    const m2 = s.match(/(\d{1,2})\s*[-/]\s*(\d{1,2})/);
    if (m2) {
        return padDate(parseInt(m2[1])) + '/' + padDate(parseInt(m2[2])) + '/' + year;
    }
    
    return null;
}

/* ──────────────────────────────────────────────────────────────────────────────
   MAIN PIPELINE: processRawOffers
   Takes the JSON "raw offer" from extraction and produces final lines + flags.
   ────────────────────────────────────────────────────────────────────────── */

function processRawOffers(rawJson, options = {}) {
    const excludeJapan = options.excludeJapan !== false;  // default true
    const agente = rawJson.agente || '';
    const tipo = rawJson.tipo || 'tarifario';
    
    const tarifarioLines = [];
    const spaceLines = [];
    const flags = [];
    
    for (const oferta of (rawJson.ofertas || [])) {
        // Decode carrier
        const { carrier, service, unknown: unknownCarrier } = decodeCarrier(oferta.armador_raw);
        if (unknownCarrier) {
            flags.push({ type: 'warning', msg: `Armador desconhecido: "${oferta.armador_raw}" — mantido como "${carrier}"`, oferta });
        }
        
        // Decode origins and destinations
        const origens = decodePOL(oferta.pol_raw, excludeJapan);
        const destinos = decodePOD(oferta.pod_raw);
        
        if (origens.length === 0) {
            flags.push({ type: 'error', msg: `Nenhuma origem válida para: "${oferta.pol_raw}"`, oferta });
            continue;
        }
        if (destinos.length === 0) {
            flags.push({ type: 'error', msg: `Nenhum destino válido para: "${oferta.pod_raw}"`, oferta });
            continue;
        }
        
        // Map prices
        const containers = mapPrices(oferta.precos_raw, oferta.precos_raw_seq);
        
        // Parse free time
        const ft = parseFreeTime(oferta.free_time_raw);
        
        // Parse validity
        const validity = parseValidity(oferta.validade_raw, oferta.etd_raw);
        if (!validity.fim) {
            flags.push({ type: 'warning', msg: `Validade fim não encontrada para ${carrier} ${oferta.pol_raw}→${oferta.pod_raw}`, oferta });
        }
        
        // Parse surcharges
        const surcharges = parseSurcharges(oferta.remark_raw, carrier, origens);
        
        // Build observations
        const obsFragments = [];
        if (service) obsFragments.push(`Serviço: ${service}`);
        if (surcharges.observations.length > 0) obsFragments.push(...surcharges.observations);
        if (oferta.navio_raw) obsFragments.push(`Navio: ${oferta.navio_raw}`);
        
        // ── DETECT TYPE AND EXPAND (§6 Classification) ──
        let isSpace = false;
        let isTarifario = false;
        
        const hasETD = !!(oferta.etd_raw);
        const hasVolume = !!(oferta.volume_raw);
        const hasValidity = !!(oferta.validade_raw);
        const hasRates = !!(containers && Object.keys(containers).length > 0);
        
        if ((hasValidity || hasRates) && !(hasETD && hasVolume)) {
            isTarifario = true;
        } else if (hasETD || hasVolume) {
            isSpace = true;
        } else {
            if (tipo === 'space') isSpace = true;
            else isTarifario = true;
        }
        
        if (isTarifario && !isSpace) {
            // §3.8 Expand: 1 line per carrier × origin × destination × container
            const expanded = expandTarifario(carrier, agente, origens, destinos, containers, ft, validity, surcharges, obsFragments, oferta);
            tarifarioLines.push(...expanded.lines);
            flags.push(...expanded.flags);
        }
        
        if (isSpace) {
            // §4 Space on Hand
            const expanded = expandSpace(carrier, agente, origens, destinos, oferta, ft, surcharges, obsFragments);
            spaceLines.push(...expanded.lines);
            flags.push(...expanded.flags);
        }
    }
    
    // Sort space lines by FRETE ascending (§4.6), PENDING last
    spaceLines.sort((a, b) => {
        if (a.fretePending && !b.fretePending) return 1;
        if (!a.fretePending && b.fretePending) return -1;
        return (a.frete || 0) - (b.frete || 0);
    });
    
    return { tarifarioLines, spaceLines, flags };
}

/* ──────────────────────────────────────────────────────────────────────────────
   §3.8  EXPAND TARIFÁRIO
   1 line per armador × origin × destination × container type
   ────────────────────────────────────────────────────────────────────────── */

function expandTarifario(carrier, agente, origens, destinos, containers, ft, validity, surcharges, obsFragments, oferta) {
    const lines = [];
    const flags = [];
    
    const containerEntries = Object.entries(containers);
    if (containerEntries.length === 0) {
        flags.push({ type: 'error', msg: `Nenhum preço válido encontrado para ${carrier} ${oferta.pol_raw}→${oferta.pod_raw}`, oferta });
        return { lines, flags };
    }
    
    for (const origem of origens) {
        for (const destino of destinos) {
            for (const [containerType, basePrice] of containerEntries) {
                // Check no equipment
                if (surcharges.noEquipment) {
                    const noEquipNorm = surcharges.noEquipment;
                    if (containerType === "40' NOR" && /NOR/i.test(noEquipNorm)) continue;
                }
                
                // Calculate final price with surcharges (§3.7)
                let finalPrice = basePrice;
                
                // ISPS — only if explicitly stated
                if (surcharges.isps != null && surcharges.ispsExplicit) {
                    finalPrice += surcharges.isps;
                }
                
                // EFF (per TEU: 20'=1 TEU, 40'=2 TEUs)
                if (surcharges.eff) {
                    const teu = containerType.startsWith("20'") ? 1 : 2;
                    finalPrice += surcharges.eff * teu;
                }
                
                // Handling (per box)
                if (surcharges.handling && !surcharges.handlingExcept.includes(origem)) {
                    finalPrice += surcharges.handling;
                }
                
                // Kickback (per box)
                if (surcharges.kb) {
                    finalPrice += surcharges.kb;
                }
                
                // Sub ISPS
                if (surcharges.subIsps) {
                    finalPrice += surcharges.subIsps;
                }
                
                // Add-ons per origin (§3.7)
                for (const addon of surcharges.addons) {
                    if (addon.origem === origem || addon.origem === '*') {
                        if (addon.container === '*' || addon.container === containerType) {
                            finalPrice += addon.valor;
                        } else if (addon.container === '__DRY_ALL__' && FT_DRY_CONTAINERS.has(containerType)) {
                            finalPrice += addon.valor;
                        }
                    }
                }
                
                // Free time (§3.5)
                let freeTime = null;
                if (FT_DRY_CONTAINERS.has(containerType)) {
                    freeTime = ft.dry;
                } else if (FT_NOR_CONTAINERS.has(containerType)) {
                    freeTime = ft.nor;
                }
                
                // Flag missing free time
                if (freeTime === null) {
                    flags.push({ type: 'warning', msg: `Free time ausente para ${carrier} ${origem}→${destino} ${containerType}`, oferta });
                }
                
                // Build observation string
                const obs = obsFragments.join('; ');
                
                // Construct the Tarifário line object
                const line = {
                    'Produto':            TARIFARIO_DEFAULTS['Produto'],
                    'Cliente':            '',
                    'Cidade Coleta':      '',
                    'Origem':             origem,
                    'Destino':            destino,
                    'Cidade de Entrega':  '',
                    'Zipcode Entrega':    '',
                    'Armador':            carrier,
                    'Coloader':           '',
                    'Agente':             agente,
                    'Tp Container':       containerType,
                    'Moeda':              'USD',
                    'Vl Minimo':          '',
                    'Vl. Frete':          finalPrice,
                    'Dt Inicio Validade': validity.inicio || todayStr(),
                    'Dt Fim Validade':    validity.fim || '',
                    'Transit Time De':    '',
                    'Transit Time Até':   '',
                    'Tipo Embarque':      'FCL',
                    'Modalidade do Transporte': '',
                    'Free Time':          freeTime || '',
                    'Contrato':           '',
                    'Contrato Unico':     '',
                    'Mercadoria':         '',
                    'Frequência':         'Semanal',
                    'Limite de Peso':     '',
                    'FT LS Destino Compra': '',
                    'FT Destino Compra':  '',
                    'FT LS Origem Compra': '',
                    'Tarifa':             '',
                    'Transbordo':         '',
                    'Taxas':              '',
                    'Observacao':         obs,
                    'FT Combinado Compra': '',
                    // Internal tracking (not exported)
                    _selected: true,
                    _flagged: false,
                };
                
                lines.push(line);
            }
        }
    }
    
    return { lines, flags };
}

/* ──────────────────────────────────────────────────────────────────────────────
   §4  EXPAND SPACE ON HAND
   ────────────────────────────────────────────────────────────────────────── */

function expandSpace(carrier, agente, origens, destinos, oferta, ft, surcharges, obsFragments) {
    const lines = [];
    const flags = [];
    
    // Parse volume
    const vol = parseVolume(oferta.volume_raw);
    if (vol.unresolved) {
        flags.push({ type: 'warning', msg: `Volume não resolvido: "${oferta.volume_raw}" — significado de N?`, oferta });
    }
    
    // Parse ETD
    const etd = parseSpaceETD(oferta.etd_raw);
    
    // Check "valid to" in validade → goes to observation, not ETD (§4.7)
    let validToObs = null;
    if (oferta.validade_raw && RE_VALID_TO.test(String(oferta.validade_raw))) {
        const m = String(oferta.validade_raw).match(RE_VALID_TO);
        if (m) {
            const day = parseInt(m[1]);
            const month = parseMonthName(m[2]);
            if (month) {
                validToObs = `Válido até ${padDate(day)}/${padDate(month)}`;
                if (!etd) {
                    flags.push({ type: 'info', msg: `"valid to ${m[0]}" não é ETD — adicionado à Observação`, oferta });
                }
            }
        }
    }
    
    // Parse prices per container
    const containers = mapPrices(oferta.precos_raw, oferta.precos_raw_seq);
    
    // POD alternatives (§4.8)
    let podAlternatives = null;
    if (oferta.remark_raw) {
        const canChangeMatch = String(oferta.remark_raw).match(RE_CAN_CHANGE);
        if (canChangeMatch) {
            podAlternatives = canChangeMatch[1].trim();
        } else if (RE_CAN_POD.test(oferta.remark_raw)) {
            obsFragments.push('Pode alterar POD');
        }
    }
    
    if (validToObs) obsFragments.push(validToObs);
    
    // Group containers by frete+FT for consolidation (§4.3)
    const groups = {};
    
    for (const [containerType, basePrice] of Object.entries(containers)) {
        // Calculate final frete
        let finalFrete = basePrice;
        
        // Add surcharges (ISPS from +isps pattern)
        if (surcharges.isps != null) {
            finalFrete += surcharges.isps;
        }
        
        // Add-ons per origin apply at expand time (handled in line generation)
        
        // Free time
        let freeTime = null;
        if (FT_DRY_CONTAINERS.has(containerType)) freeTime = ft.dry;
        else if (FT_NOR_CONTAINERS.has(containerType)) freeTime = ft.nor;
        
        const groupKey = `${finalFrete}_${freeTime}`;
        if (!groups[groupKey]) {
            groups[groupKey] = { frete: finalFrete, ft: freeTime, containers: [] };
        }
        groups[groupKey].containers.push(containerType);
    }
    
    // If no containers found, check for standalone frete
    if (Object.keys(containers).length === 0 && oferta.precos_raw) {
        // Try to get a single price
        const singlePrice = parseSpaceFrete(
            typeof oferta.precos_raw === 'object' ? Object.values(oferta.precos_raw)[0] : oferta.precos_raw,
            carrier
        );
        
        for (const origem of origens) {
            for (const destino of destinos) {
                const podStr = podAlternatives ? `${destino} (CAN CHANGE TO ${podAlternatives})` : destino;
                const volStr = vol.qty ? `${vol.qty}*CNT` : (vol.raw || '');
                
                lines.push({
                    agente,
                    pol: origem,
                    pod: podStr,
                    vol: volStr,
                    etd: etd || '',
                    frete: singlePrice.value,
                    fretePending: singlePrice.pending,
                    freeTime: '',
                    armador: carrier,
                    observacao: obsFragments.join('; '),
                    _selected: true,
                });
            }
        }
        
        return { lines, flags };
    }
    
    // Generate lines for each group
    for (const [, group] of Object.entries(groups)) {
        for (const origem of origens) {
            // Apply add-ons per origin
            let adjustedFrete = group.frete;
            for (const addon of surcharges.addons) {
                if (addon.origem === origem || addon.origem === '*') {
                    adjustedFrete += addon.valor;
                }
            }
            
            for (const destino of destinos) {
                const podStr = podAlternatives ? `${destino} (CAN CHANGE TO ${podAlternatives})` : destino;
                
                // Consolidate containers: "3*40HQ" or "2*20GP + 1*40HQ"
                const containerStrParts = [];
                for (const ct of group.containers) {
                    const shortName = ct.replace("' ", "").replace("20' DRY", "20GP").replace("40' DRY", "40GP").replace("40' HIGH CUBE", "40HQ").replace("40' NOR", "40NOR");
                    const volStr = vol.qty ? `${vol.qty}*${shortName}` : shortName;
                    containerStrParts.push(volStr);
                }
                
                lines.push({
                    agente,
                    pol: origem,
                    pod: podStr,
                    vol: containerStrParts.join(' + '),
                    etd: etd || '',
                    frete: adjustedFrete,
                    fretePending: false,
                    freeTime: group.ft || '',
                    armador: carrier,
                    observacao: obsFragments.join('; '),
                    _selected: true,
                });
            }
        }
    }
    
    return { lines, flags };
}

/* ──────────────────────────────────────────────────────────────────────────────
   §3.10 + §4  VALIDATION & FLAGS
   ────────────────────────────────────────────────────────────────────────── */

function validateTarifarioLines(lines) {
    const flags = [];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Check required fields
        for (const field of TARIFARIO_REQUIRED) {
            if (!line[field] && line[field] !== 0) {
                flags.push({ type: 'error', msg: `Linha ${i + 1}: campo obrigatório "${field}" vazio`, lineIndex: i, field });
                line._flagged = true;
            }
        }
        
        // Check for expired validity
        if (line['Dt Fim Validade']) {
            const parts = line['Dt Fim Validade'].split('/');
            if (parts.length === 3) {
                const fimDate = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
                if (fimDate < new Date()) {
                    flags.push({ type: 'warning', msg: `Linha ${i + 1}: validade já vencida (${line['Dt Fim Validade']})`, lineIndex: i, field: 'Dt Fim Validade' });
                }
            }
        }
    }
    
    // Check for duplicate/conflicting prices (same route+container, different price)
    const routeMap = {};
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const key = `${line['Armador']}|${line['Origem']}|${line['Destino']}|${line['Tp Container']}`;
        if (!routeMap[key]) routeMap[key] = [];
        routeMap[key].push({ index: i, price: line['Vl. Frete'] });
    }
    
    for (const [key, entries] of Object.entries(routeMap)) {
        if (entries.length > 1) {
            const prices = new Set(entries.map(e => e.price));
            if (prices.size > 1) {
                flags.push({
                    type: 'warning',
                    msg: `Conflito de preço no mesmo trecho: ${key} — preços: ${[...prices].join(', ')}. Linha mais específica vence.`,
                    lineIndices: entries.map(e => e.index),
                });
            }
        }
    }
    
    return flags;
}

/* ──────────────────────────────────────────────────────────────────────────────
   §7  TSV & CSV EXPORT
   ────────────────────────────────────────────────────────────────────────── */

function valueToCSVField(val) {
    if (val == null) return '';
    let str = String(val);
    if (str.includes(';') || str.includes('\n') || str.includes('"')) {
        str = '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

function toCSV_Tarifario(lines) {
    const header = TARIFARIO_HEADERS.map(valueToCSVField).join(';');
    const rows = lines
        .filter(l => l._selected !== false)
        .map(line => {
            return TARIFARIO_HEADERS.map(h => {
                return valueToCSVField(line[h]);
            }).join(';');
        });
    return header + '\n' + rows.join('\n');
}

function toCSV_Space(lines) {
    const header = SPACE_HEADERS.map(valueToCSVField).join(';');
    const rows = lines
        .filter(l => l._selected !== false)
        .map(line => {
            const fields = [
                line.agente || '',
                line.pol || '',
                line.pod || '',
                line.vol || '',
                line.etd || '',
                line.fretePending ? 'PENDING' : (line.frete || ''),
                line.freeTime || '',
                line.armador || '',
                line.observacao || '',
            ];
            return fields.map(valueToCSVField).join(';');
        });
    return header + '\n' + rows.join('\n');
}

function toTSV_Tarifario(lines) {
    const header = TARIFARIO_HEADERS.join('\t');
    const rows = lines
        .filter(l => l._selected !== false)
        .map(line => {
            return TARIFARIO_HEADERS.map(h => {
                const val = line[h];
                if (val == null) return '';
                return String(val);
            }).join('\t');
        });
    return header + '\n' + rows.join('\n');
}

function toTSV_Space(lines) {
    const header = SPACE_HEADERS.join('\t');
    const rows = lines
        .filter(l => l._selected !== false)
        .map(line => {
            return [
                line.agente || '',
                line.pol || '',
                line.pod || '',
                line.vol || '',
                line.etd || '',
                line.fretePending ? 'PENDING' : (line.frete || ''),
                line.freeTime || '',
                line.armador || '',
                line.observacao || '',
            ].join('\t');
        });
    return header + '\n' + rows.join('\n');
}

/* ──────────────────────────────────────────────────────────────────────────────
   INLINE TESTS (run in browser console with: runEngineTests())
   ────────────────────────────────────────────────────────────────────────── */

function runEngineTests() {
    const results = [];
    const assert = (name, actual, expected) => {
        const pass = JSON.stringify(actual) === JSON.stringify(expected);
        results.push({ name, pass, actual, expected });
        if (!pass) console.error(`❌ ${name}: got`, actual, 'expected', expected);
        else console.log(`✅ ${name}`);
    };
    
    // Carrier decode
    assert('Carrier H*M', decodeCarrier('H*M').carrier, 'HMM');
    assert('Carrier MSK-BR', decodeCarrier('MSK-BR').carrier, 'MAERSK');
    assert('Carrier C*A', decodeCarrier('C*A').carrier, 'CMA');
    assert('Carrier O**L', decodeCarrier('O**L').carrier, 'OOCL');
    assert('Carrier HPL FAST SERVICE', decodeCarrier('HPL FAST SERVICE').carrier, 'HAPAG');
    assert('Service HPL FAST SERVICE', decodeCarrier('HPL FAST SERVICE').service, 'FAST SERVICE');
    assert('Carrier Y*L', decodeCarrier('Y*L').carrier, 'YANG MING');
    assert('Carrier EMC', decodeCarrier('EMC').carrier, 'EVERGREEN');
    
    // POL decode
    assert('POL SHA/NGB/SKU', decodePOL('SHA/NGB/SKU'), ['Shanghai', 'Ningbo', 'Shekou']);
    assert('POL SHENZHEN', decodePOL('SHENZHEN'), ['Shekou', 'Yantian']);
    assert('POL QDO', decodePOL('QDO'), ['Qingdao']);
    assert('POL TXG (Taiwan, not Japan)', decodePOL('TXG', true), ['Taichung']);
    assert('POL JPNGO (Japan excluded)', decodePOL('JPNGO', true), []);
    assert('POL JPNGO (Japan included)', decodePOL('JPNGO', false), ['Nagoya']);
    
    // POD decode
    assert('POD SSZ/IOA/NVT', decodePOD('SSZ/IOA/NVT'), ['Santos', 'Itapoá', 'Navegantes']);
    assert('POD MVD discarded', decodePOD('SSZ/MVD'), ['Santos']);
    
    // Price mapping
    const prices1 = mapPrices({ '20': '7810', '40HQ': '8020', '40NOR': '6920' });
    assert('Prices 20', prices1["20' DRY"], 7810);
    assert('Prices 40HQ→HC', prices1["40' HIGH CUBE"], 8020);
    assert('Prices 40NOR', prices1["40' NOR"], 6920);
    
    const prices2 = mapPrices({ '40GP/40HQ': '8000' });
    assert('Prices 40GP/40HQ→DRY', prices2["40' DRY"], 8000);
    assert('Prices 40GP/40HQ→HC', prices2["40' HIGH CUBE"], 8000);
    
    assert('Skip nil', isSkip('nil'), true);
    assert('Skip --', isSkip('--'), true);
    assert('Skip N/A', isSkip('N/A'), true);
    assert('Not skip 100', isSkip('100'), false);
    
    // Free time
    assert('FT 21/DRY,18/NOR', parseFreeTime('21/DRY,18/NOR'), { dry: 21, nor: 18 });
    assert('FT 21/DRY&NOR', parseFreeTime('21/DRY&NOR'), { dry: 21, nor: 21 });
    assert('FT 21', parseFreeTime('21'), { dry: 21, nor: 21 });
    
    // Validity
    const v1 = parseValidity('6.22-6.30', null);
    assert('Validity range inicio', v1.inicio, padDate(22) + '/06/' + currentYear());
    assert('Validity range fim', v1.fim, padDate(30) + '/06/' + currentYear());
    
    // Volume
    assert('Vol 1+1', parseVolume('1+1').qty, 2);
    assert('Vol 1+1+1', parseVolume('1+1+1').qty, 3);
    assert('Vol 5', parseVolume('5').qty, 5);
    assert('Vol N unresolved', parseVolume('N').unresolved, true);
    
    // ISPS resolve
    assert('ISPS HMM', resolveISPS(8000, 'HMM'), 8025);
    assert('ISPS EVERGREEN', resolveISPS(6800, 'EVERGREEN'), 6800);
    
    // Summary
    const passed = results.filter(r => r.pass).length;
    console.log(`\n─── Engine Tests: ${passed}/${results.length} passed ───`);
    return results;
}
