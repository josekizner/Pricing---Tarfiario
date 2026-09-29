/* ==========================================================================
   TARIFF BUILDER UI — MOND SHIPPING
   Controls the "Criar Tarifário / Space" tab interface.
   ========================================================================== */

/* ──────────────────────────────────────────────────────────────────────────────
   STATE
   ────────────────────────────────────────────────────────────────────────── */

let builderState = {
    agente: '',
    tipo: 'tarifario',       // 'tarifario' | 'space'
    excludeJapan: true,
    accumulate: true,        // Accumulate results across multiple processing runs
    inputMode: 'json',       // 'json' | 'text' (future: 'llm')
    rawJson: null,
    tarifarioLines: [],
    spaceLines: [],
    flags: [],
    engineFlags: [],         // Raw engine validation warnings/errors
    images: [],
    geminiKey: (function() { const k = localStorage.getItem('mond_gemini_api_key') || ''; return (k && !k.startsWith('AQ.')) ? k.trim() : ''; })(),
};

/* ──────────────────────────────────────────────────────────────────────────────
   INITIALIZATION
   ────────────────────────────────────────────────────────────────────────── */

function initBuilderTab() {
    // Type selector buttons
    document.querySelectorAll('#builder-type-selector .builder-type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#builder-type-selector .builder-type-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            builderState.tipo = btn.dataset.tipo;
            updateBuilderPlaceholder();
        });
    });

    // Agent input
    const agenteInput = document.getElementById('builder-agente');
    if (agenteInput) {
        agenteInput.addEventListener('input', (e) => {
            builderState.agente = e.target.value.trim();
        });
    }

    // Japan toggle
    const jpToggle = document.getElementById('builder-exclude-japan');
    if (jpToggle) {
        jpToggle.addEventListener('change', (e) => {
            builderState.excludeJapan = e.target.checked;
        });
    }

    // Accumulate toggle
    const accumulateToggle = document.getElementById('builder-accumulate');
    if (accumulateToggle) {
        accumulateToggle.addEventListener('change', (e) => {
            builderState.accumulate = e.target.checked;
        });
    }

    // Gemini API Key input
    const keyInput = document.getElementById('builder-gemini-key');
    if (keyInput) {
        keyInput.value = builderState.geminiKey;
        keyInput.addEventListener('input', (e) => {
            const val = e.target.value.trim();
            builderState.geminiKey = val;
            localStorage.setItem('mond_gemini_api_key', val);
        });
    }

    // Process button
    const processBtn = document.getElementById('builder-process-btn');
    if (processBtn) {
        processBtn.addEventListener('click', handleProcessClick);
    }

    // Template button
    const templateBtn = document.getElementById('builder-template-btn');
    if (templateBtn) {
        templateBtn.addEventListener('click', () => {
            const textarea = document.getElementById('builder-json-input');
            if (textarea) {
                textarea.value = builderState.tipo === 'space' ? getTemplateSpaceText() : getTemplateText(builderState.tipo);
                textarea.focus();
            }
        });
    }

    // Clear button
    const clearBtn = document.getElementById('builder-clear-btn');
    if (clearBtn) {
        clearBtn.addEventListener('click', handleClearAll);
    }

    // Export buttons
    const exportTarifBtn = document.getElementById('builder-export-tarifario');
    if (exportTarifBtn) exportTarifBtn.addEventListener('click', () => handleExport('tarifario'));
    
    const exportSpaceBtn = document.getElementById('builder-export-space');
    if (exportSpaceBtn) exportSpaceBtn.addEventListener('click', () => handleExport('space'));
    
    const copyTarifBtn = document.getElementById('builder-copy-tarifario');
    if (copyTarifBtn) copyTarifBtn.addEventListener('click', () => handleCopyClipboard('tarifario'));
    
    const copySpaceBtn = document.getElementById('builder-copy-space');
    if (copySpaceBtn) copySpaceBtn.addEventListener('click', () => handleCopyClipboard('space'));

    // Image paste handler (Ctrl+V)
    const imageDropzone = document.getElementById('builder-image-dropzone');
    if (imageDropzone) {
        imageDropzone.addEventListener('click', () => {
            document.getElementById('builder-image-input').click();
        });
        
        imageDropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            imageDropzone.classList.add('drag-over');
        });
        
        imageDropzone.addEventListener('dragleave', () => {
            imageDropzone.classList.remove('drag-over');
        });
        
        imageDropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            imageDropzone.classList.remove('drag-over');
            handleImageFiles(e.dataTransfer.files);
        });
    }

    const imageFileInput = document.getElementById('builder-image-input');
    if (imageFileInput) {
        imageFileInput.addEventListener('change', (e) => {
            handleImageFiles(e.target.files);
        });
    }

    // Paste listener on the whole builder panel for image paste
    const builderPanel = document.getElementById('builder-tab-panel');
    if (builderPanel) {
        builderPanel.addEventListener('paste', (e) => {
            const items = e.clipboardData?.items;
            if (items) {
                for (const item of items) {
                    if (item.type.startsWith('image/')) {
                        e.preventDefault();
                        const file = item.getAsFile();
                        if (file) handleImageFiles([file]);
                        return;
                    }
                }
            }
        });
    }

    // Select all / deselect all for tables
    const selectAllTarif = document.getElementById('builder-select-all-tarif');
    if (selectAllTarif) {
        selectAllTarif.addEventListener('change', (e) => {
            builderState.tarifarioLines.forEach(l => l._selected = e.target.checked);
            renderBuilderTarifarioTable();
        });
    }
    
    const selectAllSpace = document.getElementById('builder-select-all-space');
    if (selectAllSpace) {
        selectAllSpace.addEventListener('change', (e) => {
            builderState.spaceLines.forEach(l => l._selected = e.target.checked);
            renderBuilderSpaceTable();
        });
    }

    updateBuilderPlaceholder();
}

/* ──────────────────────────────────────────────────────────────────────────────
   PROCESS CLICK — MAIN HANDLER
   ────────────────────────────────────────────────────────────────────────── */

function handleProcessClick() {
    const textarea = document.getElementById('builder-json-input');
    const text = textarea ? textarea.value.trim() : '';
    const hasImages = builderState.images && builderState.images.length > 0;
    
    if (!text && !hasImages) {
        showToast('⚠️ Cole o texto da cotação, e-mail do agente ou insira imagens.', 'error', 4000);
        return;
    }

    if (!builderState.agente) {
        showToast('⚠️ Preencha o nome do agente.', 'error', 3000);
        document.getElementById('builder-agente')?.focus();
        return;
    }

    if (hasImages) {
        if (!builderState.geminiKey) {
            showToast('⚠️ Informe a chave Gemini API para realizar a extração das imagens.', 'error', 5000);
            document.getElementById('builder-gemini-key')?.focus();
            return;
        }
        runLLMExtraction(text, builderState.images);
        return;
    }

    // Detect input type
    const inputType = detectInputType(text);
    
    if (inputType === 'json') {
        const result = parseManualJSON(text);
        if (!result.success) {
            showToast(`❌ ${result.error}`, 'error', 6000);
            return;
        }
        
        if (!result.validation.valid) {
            const errs = result.validation.errors.slice(0, 3).join('; ');
            showToast(`⚠️ Texto com problemas: ${errs}`, 'warning', 6000);
        }
        
        result.data.agente = builderState.agente;
        if (builderState.tipo) result.data.tipo = builderState.tipo;
        
        builderState.rawJson = result.data;
        runDeterministicPipeline(result.data);
    } else {
        // Plain text
        if (builderState.geminiKey) {
            // Always prefer LLM extraction for high-quality extraction of arbitrary text when Gemini Key is provided
            runLLMExtraction(text, []);
        } else {
            // Fall back to offline Regex parser if no Gemini Key is provided
            const parsedOffers = parseRawText(text);
            if (parsedOffers && parsedOffers.length > 0) {
                const rawJson = {
                    agente: builderState.agente,
                    tipo: builderState.tipo,
                    ofertas: parsedOffers
                };
                builderState.rawJson = rawJson;
                runDeterministicPipeline(rawJson);
            } else {
                showToast('❌ Não foi possível extrair tarifas usando regex. Informe a chave Gemini API para processamento inteligente.', 'error', 6000);
            }
        }
    }
}

async function runLLMExtraction(text, images) {
    const processBtn = document.getElementById('builder-process-btn');
    if (!processBtn) return;
    
    const originalHTML = processBtn.innerHTML;
    processBtn.disabled = true;
    processBtn.innerHTML = `<span class="spinner" style="display:inline-block;width:12px;height:12px;margin-right:8px;vertical-align:middle;"></span><span>Processando com IA...</span>`;
    
    try {
        const result = await extractWithLLM(text, images, builderState.agente, builderState.geminiKey);
        if (result.success) {
            const rawJson = result.data;
            rawJson.agente = builderState.agente;
            rawJson.tipo = builderState.tipo;
            builderState.rawJson = rawJson;
            runDeterministicPipeline(rawJson);
        } else {
            showToast(`❌ Falha na extração inteligente: ${result.error}`, 'error', 7000);
        }
    } catch (err) {
        console.error('LLM Extraction error:', err);
        showToast(`❌ Erro de processamento: ${err.message}`, 'error', 7000);
    } finally {
        processBtn.disabled = false;
        processBtn.innerHTML = originalHTML;
    }
}

/* ──────────────────────────────────────────────────────────────────────────────
   RUN DETERMINISTIC PIPELINE
   ────────────────────────────────────────────────────────────────────────── */

function convertBRDateToISO(brDate) {
    if (!brDate) return null;
    brDate = String(brDate).trim();
    if (/^\d+(\.\d+)?$/.test(brDate)) {
        const serial = parseFloat(brDate);
        const baseDate = new Date(1899, 11, 30);
        const date = new Date(baseDate.getTime() + serial * 86400000);
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    const parts = brDate.split('/');
    if (parts.length === 3) {
        return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }
    return brDate;
}

function normalizarRawJsonPorts(rawJson) {
    if (!rawJson || !Array.isArray(rawJson.ofertas)) return;
    rawJson.ofertas.forEach(oferta => {
        // 1. Move FAK to notes/comments and remove from destinations
        if (Array.isArray(oferta.destinos)) {
            const cleanDestinos = [];
            oferta.destinos.forEach(d => {
                const name = (typeof d === 'string' ? d : d.nome || '').trim();
                const upperName = name.toUpperCase();
                
                if (upperName === 'FAK') {
                    if (!oferta.notas_raw) oferta.notas_raw = [];
                    if (!oferta.notas_raw.includes('FAK')) {
                        oferta.notas_raw.push('FAK');
                    }
                } else {
                    cleanDestinos.push(d);
                }
            });
            oferta.destinos = cleanDestinos;
        }

        // 2. Decode and normalize origins using POL_DECODE
        if (Array.isArray(oferta.origens)) {
            oferta.origens = oferta.origens.map(o => {
                if (!o) return o;
                const upper = o.toString().toUpperCase().trim();
                const decoded = POL_DECODE[upper];
                if (decoded === '__SHENZHEN__') return 'Shenzhen';
                return decoded || o;
            });
        }

        // 3. Decode and normalize destinations using POD_DECODE
        if (Array.isArray(oferta.destinos)) {
            oferta.destinos = oferta.destinos.map(d => {
                if (!d) return d;
                if (typeof d === 'string') {
                    const upper = d.toString().toUpperCase().trim();
                    return POD_DECODE[upper] || d;
                } else if (typeof d === 'object' && d.nome) {
                    const upper = d.nome.toString().toUpperCase().trim();
                    d.nome = POD_DECODE[upper] || d.nome;
                    return d;
                }
                return d;
            });
        }
    });
}

function inheritFieldsFromBase(rawJson) {
    const flags = [];
    if (!rawJson || !Array.isArray(rawJson.ofertas)) return flags;
    
    // We only perform this inheritance for Zenith, or if origins/free_time/validity are missing/generic
    const isZenith = rawJson.agente && rawJson.agente.toUpperCase().trim() === 'ZENITH';
    if (!isZenith) return flags;

    rawJson.ofertas.forEach(oferta => {
        const norm = normalizarArmador(oferta.armador_raw);
        const armador = norm.armador;

        // Check if origins are missing or generic
        let needsOrigins = false;
        if (!oferta.origens || oferta.origens.length === 0) {
            needsOrigins = true;
        } else {
            const firstOrig = (oferta.origens[0] || '').toString().toLowerCase().trim();
            if (firstOrig === '' || 
                firstOrig.includes('china basic') || 
                firstOrig.includes('basic port') || 
                firstOrig.includes('ex basic') || 
                firstOrig.includes('ex china')) {
                needsOrigins = true;
            }
        }

        // Check if destinations are missing or generic/invalid
        let needsDestinations = false;
        if (!oferta.destinos || oferta.destinos.length === 0) {
            needsDestinations = true;
        } else {
            const hasGenericDest = oferta.destinos.some(d => {
                const name = (typeof d === 'string' ? d : d.nome || '').toLowerCase().trim();
                return name === '' || 
                       name === 'fak' || 
                       name.includes('south brazil') || 
                       name.includes('basic port') || 
                       name.includes('other pod') ||
                       name.includes('outro pod');
            });
            if (hasGenericDest) {
                needsDestinations = true;
            }
        }

        // Check if free time is missing (dry_hc or nor)
        const needsDryFreeTime = !oferta.free_time || oferta.free_time.dry_hc == null;
        const needsNorFreeTime = !oferta.free_time || oferta.free_time.nor == null;
        const needsFreeTime = needsDryFreeTime || needsNorFreeTime;

        // Check if validity is missing
        const needsValidity = !oferta.validade_fim && !oferta.validade_inicio;

        if (needsOrigins || needsDestinations || needsFreeTime || needsValidity) {
            // Find references for this armador grouped by agent to prioritize (Zenith > Helka > Reach)
            const zenithRefs = [];
            const helkaRefs = [];
            const reachRefs = [];

            // 1. Check accumulated lines in builderState.tarifarioLines
            if (builderState.tarifarioLines && builderState.tarifarioLines.length > 0) {
                builderState.tarifarioLines.forEach(line => {
                    const agent = (line['Agente'] || '').toUpperCase().trim();
                    if (line['Armador'] === armador) {
                        const ref = {
                            origem: line['Origem'],
                            destino: line['Destino'],
                            container: line['Tp Container'],
                            freeTime: line['Free Time'],
                            dtIni: line['Dt Inicio Validade'],
                            dtFim: line['Dt Fim Validade']
                        };
                        if (agent === 'ZENITH') zenithRefs.push(ref);
                        else if (agent === 'HELKA') helkaRefs.push(ref);
                        else if (agent === 'REACH') reachRefs.push(ref);
                    }
                });
            }

            // 2. Check latest snapshots of ZENITH/HELKA/REACH in window.db or LocalStorage fallback
            if (window.db && window.db.snapshots && window.db.snapshots.length > 0) {
                ['ZENITH', 'HELKA', 'REACH'].forEach(agent => {
                    const agentSnaps = window.db.snapshots.filter(s => s.agent === agent);
                    if (agentSnaps.length > 0) {
                        agentSnaps.sort((a, b) => b.date.localeCompare(a.date));
                        const latestSnap = agentSnaps[0];
                        if (Array.isArray(latestSnap.data)) {
                            latestSnap.data.forEach(r => {
                                if (r.armador === armador) {
                                    const ref = {
                                        origem: r.origem,
                                        destino: r.destino,
                                        container: r.container,
                                        freeTime: r.freeTime,
                                        dtIni: r.validadeIni || r.dtIni || r.data,
                                        dtFim: r.validadeFim || r.dtFim
                                    };
                                    if (agent === 'ZENITH') zenithRefs.push(ref);
                                    else if (agent === 'HELKA') helkaRefs.push(ref);
                                    else if (agent === 'REACH') reachRefs.push(ref);
                                }
                            });
                        }
                    }
                });
            } else {
                ['ZENITH', 'HELKA', 'REACH'].forEach(agent => {
                    const keys = [];
                    for (let i = 0; i < localStorage.length; i++) {
                        const key = localStorage.key(i);
                        if (key.startsWith(`snapshot:${agent}:`)) {
                            keys.push(key);
                        }
                    }
                    if (keys.length > 0) {
                        keys.sort((a, b) => b.localeCompare(a));
                        const latestKey = keys[0];
                        try {
                            const snap = JSON.parse(localStorage.getItem(latestKey)) || [];
                            snap.forEach(r => {
                                if (r.armador === armador) {
                                    const ref = {
                                        origem: r.origem,
                                        destino: r.destino,
                                        container: r.container,
                                        freeTime: r.freeTime,
                                        dtIni: r.validadeIni || r.dtIni || r.data,
                                        dtFim: r.validadeFim || r.dtFim
                                    };
                                    if (agent === 'ZENITH') zenithRefs.push(ref);
                                    else if (agent === 'HELKA') helkaRefs.push(ref);
                                    else if (agent === 'REACH') reachRefs.push(ref);
                                }
                            });
                        } catch(e) {
                            console.error('Error parsing snapshot for origin recovery', e);
                        }
                    }
                });
            }

            // 3. Check global window.appRates (imported base tariff)
            if (window.appRates && Array.isArray(window.appRates) && window.appRates.length > 0) {
                window.appRates.forEach(r => {
                    const agent = (r.agente || '').toUpperCase().trim();
                    const rArmador = normalizarArmador(r.armador).armador;
                    if (rArmador === armador) {
                        const ref = {
                            origem: r.origem,
                            destino: r.destino,
                            container: r.container,
                            freeTime: r.freetime || r.freeTime,
                            dtIni: r.inicio || r.dtIni,
                            dtFim: r.fim || r.dtFim
                        };
                        if (agent === 'ZENITH') zenithRefs.push(ref);
                        else if (agent === 'HELKA') helkaRefs.push(ref);
                        else if (agent === 'REACH') reachRefs.push(ref);
                    }
                });
            }

            // Select matching reference rows prioritizing Zenith, then Helka, then Reach
            let referenceRows = [];
            let chosenAgent = '';
            if (zenithRefs.length > 0) {
                referenceRows = zenithRefs;
                chosenAgent = 'ZENITH';
            } else if (helkaRefs.length > 0) {
                referenceRows = helkaRefs;
                chosenAgent = 'HELKA';
            } else if (reachRefs.length > 0) {
                referenceRows = reachRefs;
                chosenAgent = 'REACH';
            }

            // Inherit origins
            if (needsOrigins) {
                const recoveredOrigins = new Set();
                referenceRows.forEach(r => {
                    if (r.origem) recoveredOrigins.add(r.origem);
                });
                
                // Fallback to defaults if still empty
                if (recoveredOrigins.size === 0) {
                    const fallbackDict = {
                        'MAERSK': ['Shenzhen', 'Ningbo', 'Shanghai', 'Qingdao', 'Xiamen', 'Xingang'],
                        'COSCO': ['Shenzhen', 'Ningbo', 'Shanghai', 'Qingdao', 'Xiamen', 'Xingang'],
                        'PIL': ['Shenzhen', 'Ningbo', 'Shanghai', 'Qingdao'],
                        'YML': ['Shenzhen', 'Ningbo', 'Shanghai', 'Qingdao'],
                        'CMA': ['Shenzhen', 'Ningbo', 'Shanghai', 'Qingdao', 'Xingang'],
                        'EVERGREEN': ['Shenzhen', 'Ningbo', 'Shanghai', 'Qingdao', 'Xingang'],
                        'ONE': ['Shenzhen', 'Ningbo', 'Shanghai', 'Qingdao', 'Xiamen', 'Xingang'],
                        'HMM': ['Shenzhen', 'Ningbo', 'Shanghai', 'Qingdao', 'Xingang'],
                        'MSC': ['Shenzhen', 'Ningbo', 'Shanghai', 'Qingdao', 'Xiamen', 'Xingang']
                    };
                    const list = fallbackDict[armador] || ['Shenzhen', 'Ningbo', 'Shanghai', 'Qingdao'];
                    list.forEach(o => recoveredOrigins.add(o));
                }

                if (recoveredOrigins.size > 0) {
                    oferta.origens = Array.from(recoveredOrigins);
                    const sourceStr = chosenAgent ? `base para ${chosenAgent}` : 'histórico';
                    flags.push({
                        msg: `ℹ️ Origens herdadas do ${sourceStr} para ${armador}: ${oferta.origens.join(', ')}`
                    });
                }
            }

            // Inherit destinations
            if (needsDestinations) {
                const recoveredDestinations = new Set();
                referenceRows.forEach(r => {
                    if (r.destino) {
                        const upper = r.destino.toString().toUpperCase().trim();
                        const decoded = POD_DECODE[upper] || r.destino;
                        recoveredDestinations.add(decoded);
                    }
                });
                
                // Fallback to defaults if still empty
                if (recoveredDestinations.size === 0) {
                    const fallbackDestDict = {
                        'MAERSK': ['Santos', 'Paranaguá', 'Navegantes', 'Itapoá', 'Itajaí', 'Rio Grande', 'Rio de Janeiro'],
                        'COSCO': ['Santos', 'Paranaguá', 'Navegantes', 'Itapoá', 'Itajaí', 'Rio Grande', 'Rio de Janeiro'],
                        'PIL': ['Santos', 'Paranaguá', 'Navegantes', 'Itapoá', 'Itajaí', 'Rio Grande', 'Rio de Janeiro'],
                        'YML': ['Santos', 'Paranaguá', 'Navegantes', 'Itapoá', 'Itajaí', 'Rio Grande', 'Rio de Janeiro'],
                        'CMA': ['Santos', 'Paranaguá', 'Navegantes', 'Itapoá', 'Itajaí', 'Rio Grande', 'Rio de Janeiro'],
                        'EVERGREEN': ['Santos', 'Paranaguá', 'Navegantes', 'Itapoá', 'Itajaí', 'Rio Grande', 'Rio de Janeiro'],
                        'ONE': ['Santos', 'Paranaguá', 'Navegantes', 'Itapoá', 'Itajaí', 'Rio Grande', 'Rio de Janeiro'],
                        'HMM': ['Santos', 'Paranaguá', 'Navegantes', 'Itapoá', 'Itajaí', 'Rio Grande', 'Rio de Janeiro'],
                        'MSC': ['Santos', 'Paranaguá', 'Navegantes', 'Itapoá', 'Itajaí', 'Rio Grande', 'Rio de Janeiro']
                    };
                    const list = fallbackDestDict[armador] || ['Santos', 'Paranaguá', 'Navegantes', 'Itapoá', 'Itajaí'];
                    list.forEach(d => recoveredDestinations.add(d));
                }

                if (recoveredDestinations.size > 0) {
                    oferta.destinos = Array.from(recoveredDestinations);
                    const sourceStr = chosenAgent ? `histórico para ${chosenAgent}` : 'histórico';
                    flags.push({
                        msg: `ℹ️ Destinos herdados do ${sourceStr} para ${armador}: ${oferta.destinos.join(', ')}`
                    });
                }
            }

            // Inherit Free Time
            if (needsFreeTime && referenceRows.length > 0) {
                let dry_hc_ft = null;
                let nor_ft = null;
                
                referenceRows.forEach(r => {
                    const ctr = (r.container || '').toUpperCase();
                    if (ctr.includes('NOR')) {
                        if (r.freeTime != null && r.freeTime !== '') nor_ft = Number(r.freeTime);
                    } else {
                        if (r.freeTime != null && r.freeTime !== '') dry_hc_ft = Number(r.freeTime);
                    }
                });

                if (!oferta.free_time) oferta.free_time = {};
                let inherited = false;
                if (needsDryFreeTime && dry_hc_ft != null) {
                    oferta.free_time.dry_hc = dry_hc_ft;
                    inherited = true;
                }
                if (needsNorFreeTime && nor_ft != null) {
                    oferta.free_time.nor = nor_ft;
                    inherited = true;
                }
                
                if (inherited) {
                    const sourceStr = chosenAgent ? `base para ${chosenAgent}` : 'base';
                    flags.push({
                        msg: `ℹ️ Free Time herdado da ${sourceStr} para ${armador} (Dry: ${oferta.free_time.dry_hc || '-'} dias, NOR: ${oferta.free_time.nor || '-'} dias)`
                    });
                }
            }

            // Inherit Validity
            if (needsValidity && referenceRows.length > 0) {
                let dtIni = null;
                let dtFim = null;
                for (const r of referenceRows) {
                    if (!dtIni && r.dtIni) dtIni = convertBRDateToISO(r.dtIni);
                    if (!dtFim && r.dtFim) dtFim = convertBRDateToISO(r.dtFim);
                    if (dtIni && dtFim) break;
                }
                
                if (dtIni) oferta.validade_inicio = dtIni;
                if (dtFim) oferta.validade_fim = dtFim;

                const sourceStr = chosenAgent ? `base para ${chosenAgent}` : 'base';
                flags.push({
                    msg: `ℹ️ Validade herdada da ${sourceStr} para ${armador} (Validade: ${oferta.validade_inicio || ''} até ${oferta.validade_fim || ''})`
                });
            }
        }
    });

    return flags;
}

function runDeterministicPipeline(rawJson) {
    try {
        // Inject the "Excluir Japão" checkbox value into rawJson.excluir_japao
        rawJson.excluir_japao = builderState.excludeJapan;

        // Perform port and FAK contract normalization
        normalizarRawJsonPorts(rawJson);

        // Perform fields inheritance for Zenith based on Reach/Helka bases
        const inheritanceFlags = inheritFieldsFromBase(rawJson);

        // Pass rawJson directly to the new verbatim engine
        const { linhas, flags } = processarTarifario(rawJson);

        let finalLines = linhas;
        if (builderState.accumulate) {
            // Append new lines to existing table and deduplicate later
            finalLines = [...builderState.tarifarioLines, ...linhas];
        }

        // Deduplicate lines
        const dedupedLines = dedupeTarifario(finalLines);

        builderState.tarifarioLines = dedupedLines;
        builderState.spaceLines = []; // Clean up space lines
        
        // Map flags (bloqueia: true to 'error', others to 'warning')
        const mappedEngineFlags = [
            ...flags.map(f => ({
                type: f.bloqueia ? 'error' : 'warning',
                msg: f.msg,
                tipo: f.tipo
            })),
            ...inheritanceFlags.map(f => ({
                type: 'info',
                msg: f.msg,
                tipo: 'inheritance'
            }))
        ];

        if (builderState.accumulate) {
            builderState.engineFlags = [...(builderState.engineFlags || []), ...mappedEngineFlags];
        } else {
            builderState.engineFlags = mappedEngineFlags;
        }
        
        // Run validation and render
        revalidateBuilderLines();
        
        const totalLines = dedupedLines.length;
        const flagCount = builderState.flags.length;
        
        if (totalLines === 0) {
            showToast('⚠️ Nenhuma linha gerada. Verifique o texto de entrada.', 'warning', 5000);
        } else {
            showToast(`✅ Processado: ${totalLines} linhas de tarifário no total. ${flagCount > 0 ? flagCount + ' flags.' : ''}`, 'success', 5000);
        }
    } catch (err) {
        console.error('Pipeline error:', err);
        showToast(`❌ Erro no processamento: ${err.message}`, 'error', 8000);
    }
}

function saveAgentSnapshot() {
    if (!builderState.agente || builderState.tarifarioLines.length === 0) return;
    const agentNameUpper = builderState.agente.toUpperCase();
    const todayStr = new Date().toISOString().split('T')[0];
    const key = `snapshot:${agentNameUpper}:${todayStr}`;
    
    const snapshotData = builderState.tarifarioLines.map(line => ({
        agente: line['Agente'] || builderState.agente,
        armador: line['Armador'] || '',
        origem: line['Origem'] || '',
        destino: line['Destino'] || '',
        container: line['Tp Container'] || '',
        frete: line['Vl. Frete'] != null && line['Vl. Frete'] !== '' ? Number(line['Vl. Frete']) : null,
        freeTime: line['Free Time'] != null && line['Free Time'] !== '' ? Number(line['Free Time']) : null,
        validadeFim: line['Dt Fim Validade'] || '',
        obs: line['Observacao'] || '',
        data: todayStr
    }));
    
    if (window.db && typeof window.db.saveSnapshot === 'function') {
        window.db.saveSnapshot(builderState.agente, todayStr, snapshotData);
    } else {
        localStorage.setItem(key, JSON.stringify(snapshotData));
    }
    console.log(`Saved agent snapshot for ${agentNameUpper} under key: ${key}`);
}

function revalidateBuilderLines() {
    // Reset all row flags first
    builderState.tarifarioLines.forEach(l => l._flagged = false);
    
    // Run validation on the current set of lines
    const lineFlags = validateTarifarioLines(builderState.tarifarioLines);
    
    // Filter out engine mandatory field flags since they are recalculating on current state
    const nonObrigatorioEngineFlags = (builderState.engineFlags || []).filter(f => f.tipo !== 'obrigatorio');
    
    builderState.flags = [
        ...nonObrigatorioEngineFlags,
        ...lineFlags.map(f => ({ type: f.type, msg: f.msg }))
    ];
    
    // Render results
    renderBuilderResults();
    
    // Save snapshot to local storage
    saveAgentSnapshot();
}

/* ──────────────────────────────────────────────────────────────────────────────
   RENDER RESULTS
   ────────────────────────────────────────────────────────────────────────── */

function renderBuilderResults() {
    const resultsSection = document.getElementById('builder-results');
    if (resultsSection) resultsSection.style.display = 'block';
    
    renderBuilderFlags();
    renderBuilderTarifarioTable();
    renderBuilderSpaceTable();
    
    // Show/hide sections based on content
    const tarifSection = document.getElementById('builder-tarifario-section');
    const spaceSection = document.getElementById('builder-space-section');
    
    if (tarifSection) tarifSection.style.display = builderState.tarifarioLines.length > 0 ? 'block' : 'none';
    if (spaceSection) spaceSection.style.display = builderState.spaceLines.length > 0 ? 'block' : 'none';
    
    // Update counters
    const tarifCount = document.getElementById('builder-tarif-count');
    const spaceCount = document.getElementById('builder-space-count');
    if (tarifCount) tarifCount.textContent = `${builderState.tarifarioLines.length} linhas`;
    if (spaceCount) spaceCount.textContent = `${builderState.spaceLines.length} linhas`;
    
    // Smooth scroll to results
    resultsSection?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ──────────────────────────────────────────────────────────────────────────────
   RENDER FLAGS
   ────────────────────────────────────────────────────────────────────────── */

function renderBuilderFlags() {
    const container = document.getElementById('builder-flags-list');
    if (!container) return;
    
    const flagsSection = document.getElementById('builder-flags-section');
    
    if (builderState.flags.length === 0) {
        if (flagsSection) flagsSection.style.display = 'none';
        return;
    }
    
    if (flagsSection) flagsSection.style.display = 'block';
    
    const errors = builderState.flags.filter(f => f.type === 'error');
    const warnings = builderState.flags.filter(f => f.type === 'warning');
    const infos = builderState.flags.filter(f => f.type === 'info');
    
    let html = '';
    
    if (errors.length > 0) {
        html += `<div class="builder-flag-group">
            <div class="builder-flag-group-title error"><i data-lucide="alert-circle"></i> ${errors.length} Erro${errors.length > 1 ? 's' : ''}</div>
            ${errors.map(f => `<div class="builder-flag error">${escapeHtml(f.msg)}</div>`).join('')}
        </div>`;
    }
    
    if (warnings.length > 0) {
        html += `<div class="builder-flag-group">
            <div class="builder-flag-group-title warning"><i data-lucide="alert-triangle"></i> ${warnings.length} Aviso${warnings.length > 1 ? 's' : ''}</div>
            ${warnings.map(f => `<div class="builder-flag warning">${escapeHtml(f.msg)}</div>`).join('')}
        </div>`;
    }
    
    if (infos.length > 0) {
        html += `<div class="builder-flag-group">
            <div class="builder-flag-group-title info"><i data-lucide="info"></i> ${infos.length} Informação${infos.length > 1 ? 'ões' : ''}</div>
            ${infos.map(f => `<div class="builder-flag info">${escapeHtml(f.msg)}</div>`).join('')}
        </div>`;
    }
    
    container.innerHTML = html;
    lucide.createIcons({ nodes: container.querySelectorAll('[data-lucide]') });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/* ──────────────────────────────────────────────────────────────────────────────
   RENDER TARIFÁRIO TABLE
   ────────────────────────────────────────────────────────────────────────── */

function renderBuilderTarifarioTable() {
    const tbody = document.getElementById('builder-tarif-tbody');
    if (!tbody) return;
    
    if (builderState.tarifarioLines.length === 0) {
        tbody.innerHTML = '<tr><td colspan="12" class="text-center" style="padding:20px;color:var(--text-muted);">Nenhuma linha de tarifário gerada.</td></tr>';
        return;
    }
    
    // Visible columns (subset of 34)
    const visibleCols = [
        { key: 'Origem', label: 'Origem', width: '100px' },
        { key: 'Destino', label: 'Destino', width: '100px' },
        { key: 'Armador', label: 'Armador', width: '90px' },
        { key: 'Agente', label: 'Agente', width: '100px' },
        { key: 'Tp Container', label: 'Container', width: '100px' },
        { key: 'Vl. Frete', label: 'Frete (USD)', width: '85px', align: 'right' },
        { key: 'Free Time', label: 'FT', width: '45px', align: 'center' },
        { key: 'Dt Inicio Validade', label: 'Início', width: '85px', align: 'center' },
        { key: 'Dt Fim Validade', label: 'Fim', width: '85px', align: 'center' },
        { key: 'Observacao', label: 'Observação', width: '150px' },
    ];
    
    let html = '';
    
    for (let i = 0; i < builderState.tarifarioLines.length; i++) {
        const line = builderState.tarifarioLines[i];
        const flagged = line._flagged ? ' builder-row-flagged' : '';
        const selected = line._selected !== false;
        
        html += `<tr class="builder-data-row${flagged}" data-index="${i}">`;
        html += `<td class="text-center"><input type="checkbox" class="builder-row-check" data-type="tarif" data-idx="${i}" ${selected ? 'checked' : ''}></td>`;
        
        for (const col of visibleCols) {
            const val = line[col.key] ?? '';
            const align = col.align ? ` text-${col.align}` : '';
            const isRequired = TARIFARIO_REQUIRED.has(col.key) && !val && val !== 0;
            const cellClass = isRequired ? ' builder-cell-required' : '';
            
            if (col.key === 'Vl. Frete') {
                html += `<td class="${align}${cellClass}" style="width:${col.width}">
                    <span class="builder-editable" data-type="tarif" data-idx="${i}" data-field="${col.key}">${val ? 'USD ' + Number(val).toLocaleString('en') : ''}</span>
                </td>`;
            } else {
                html += `<td class="${align}${cellClass}" style="width:${col.width}">
                    <span class="builder-editable" data-type="tarif" data-idx="${i}" data-field="${col.key}">${escapeHtml(String(val))}</span>
                </td>`;
            }
        }
        
        html += `<td class="text-center"><button class="builder-row-delete" data-type="tarif" data-idx="${i}" title="Remover"><i data-lucide="trash-2" style="width:13px;height:13px;"></i></button></td>`;
        html += '</tr>';
    }
    
    tbody.innerHTML = html;
    
    // Setup event listeners for checkboxes
    tbody.querySelectorAll('.builder-row-check').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const idx = parseInt(e.target.dataset.idx);
            builderState.tarifarioLines[idx]._selected = e.target.checked;
        });
    });
    
    // Setup click-to-edit
    tbody.querySelectorAll('.builder-editable').forEach(el => {
        el.addEventListener('dblclick', handleCellEdit);
    });
    
    // Setup delete buttons
    tbody.querySelectorAll('.builder-row-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const idx = parseInt(e.currentTarget.dataset.idx);
            builderState.tarifarioLines.splice(idx, 1);
            renderBuilderTarifarioTable();
        });
    });
    
    lucide.createIcons({ nodes: tbody.querySelectorAll('[data-lucide]') });
}

/* ──────────────────────────────────────────────────────────────────────────────
   RENDER SPACE TABLE
   ────────────────────────────────────────────────────────────────────────── */

function renderBuilderSpaceTable() {
    const tbody = document.getElementById('builder-space-tbody');
    if (!tbody) return;
    
    if (builderState.spaceLines.length === 0) {
        tbody.innerHTML = '<tr><td colspan="11" class="text-center" style="padding:20px;color:var(--text-muted);">Nenhuma linha de Space on Hand gerada.</td></tr>';
        return;
    }
    
    const spaceCols = [
        { key: 'agente', label: 'Agente', width: '90px' },
        { key: 'pol', label: 'POL', width: '100px' },
        { key: 'pod', label: 'POD', width: '120px' },
        { key: 'vol', label: 'VOL', width: '80px', align: 'center' },
        { key: 'etd', label: 'ETD', width: '80px', align: 'center' },
        { key: 'frete', label: 'Frete', width: '75px', align: 'right' },
        { key: 'freeTime', label: 'FT', width: '45px', align: 'center' },
        { key: 'armador', label: 'Armador', width: '90px' },
        { key: 'observacao', label: 'Observação', width: '150px' },
    ];
    
    let html = '';
    
    for (let i = 0; i < builderState.spaceLines.length; i++) {
        const line = builderState.spaceLines[i];
        const selected = line._selected !== false;
        
        html += `<tr class="builder-data-row" data-index="${i}">`;
        html += `<td class="text-center"><input type="checkbox" class="builder-row-check" data-type="space" data-idx="${i}" ${selected ? 'checked' : ''}></td>`;
        
        for (const col of spaceCols) {
            let val = line[col.key] ?? '';
            const align = col.align ? ` text-${col.align}` : '';
            
            if (col.key === 'frete') {
                val = line.fretePending ? 'PENDING' : (val ? Number(val).toLocaleString('en') : '');
                const pendingClass = line.fretePending ? ' builder-cell-pending' : '';
                html += `<td class="${align}${pendingClass}" style="width:${col.width}">
                    <span class="builder-editable" data-type="space" data-idx="${i}" data-field="${col.key}">${val}</span>
                </td>`;
            } else {
                html += `<td class="${align}" style="width:${col.width}">
                    <span class="builder-editable" data-type="space" data-idx="${i}" data-field="${col.key}">${escapeHtml(String(val))}</span>
                </td>`;
            }
        }
        
        html += `<td class="text-center"><button class="builder-row-delete" data-type="space" data-idx="${i}" title="Remover"><i data-lucide="trash-2" style="width:13px;height:13px;"></i></button></td>`;
        html += '</tr>';
    }
    
    tbody.innerHTML = html;
    
    // Event listeners
    tbody.querySelectorAll('.builder-row-check').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const idx = parseInt(e.target.dataset.idx);
            builderState.spaceLines[idx]._selected = e.target.checked;
        });
    });
    
    tbody.querySelectorAll('.builder-editable').forEach(el => {
        el.addEventListener('dblclick', handleCellEdit);
    });
    
    tbody.querySelectorAll('.builder-row-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const idx = parseInt(e.currentTarget.dataset.idx);
            builderState.spaceLines.splice(idx, 1);
            renderBuilderSpaceTable();
        });
    });
    
    lucide.createIcons({ nodes: tbody.querySelectorAll('[data-lucide]') });
}

/* ──────────────────────────────────────────────────────────────────────────────
   INLINE CELL EDITING
   ────────────────────────────────────────────────────────────────────────── */

function handleCellEdit(e) {
    const el = e.currentTarget;
    const type = el.dataset.type;
    const idx = parseInt(el.dataset.idx);
    const field = el.dataset.field;
    
    const lines = type === 'tarif' ? builderState.tarifarioLines : builderState.spaceLines;
    const line = lines[idx];
    if (!line) return;
    
    const currentVal = String(line[field] ?? '');
    
    // Replace span with input
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentVal;
    input.className = 'builder-cell-input';
    input.style.width = '100%';
    
    const parent = el.parentNode;
    parent.replaceChild(input, el);
    input.focus();
    input.select();
    
    const save = () => {
        const newVal = input.value.trim();
        line[field] = field === 'Vl. Frete' || field === 'frete' || field === 'Free Time' || field === 'freeTime'
            ? (newVal === '' ? '' : (isNaN(Number(newVal)) ? newVal : Number(newVal)))
            : newVal;
        
        // Re-run validation on the table to update error flags in real-time
        if (type === 'tarif') revalidateBuilderLines();
        else renderBuilderSpaceTable();
    };
    
    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        if (e.key === 'Escape') {
            if (type === 'tarif') renderBuilderTarifarioTable();
            else renderBuilderSpaceTable();
        }
    });
}

/* ──────────────────────────────────────────────────────────────────────────────
   IMAGE HANDLING
   ────────────────────────────────────────────────────────────────────────── */

function handleImageFiles(files) {
    if (!files || files.length === 0) return;
    
    for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        
        const reader = new FileReader();
        reader.onload = (e) => {
            builderState.images.push({
                name: file.name,
                type: file.type,
                dataUrl: e.target.result,
            });
            renderImagePreviews();
        };
        reader.readAsDataURL(file);
    }
}

function renderImagePreviews() {
    const container = document.getElementById('builder-image-previews');
    if (!container) return;
    
    if (builderState.images.length === 0) {
        container.innerHTML = '';
        return;
    }
    
    let html = '';
    for (let i = 0; i < builderState.images.length; i++) {
        const img = builderState.images[i];
        html += `<div class="builder-image-thumb">
            <img src="${img.dataUrl}" alt="${escapeHtml(img.name)}" title="${escapeHtml(img.name)}">
            <button class="builder-image-remove" data-idx="${i}" title="Remover">&times;</button>
        </div>`;
    }
    container.innerHTML = html;
    
    container.querySelectorAll('.builder-image-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const idx = parseInt(e.currentTarget.dataset.idx);
            builderState.images.splice(idx, 1);
            renderImagePreviews();
        });
    });
}

/* ──────────────────────────────────────────────────────────────────────────────
   EXPORT HANDLERS
   ────────────────────────────────────────────────────────────────────────── */

function handleExport(type) {
    let csv, filename;
    
    if (type === 'tarifario') {
        const selected = builderState.tarifarioLines.filter(l => l._selected !== false);
        if (selected.length === 0) {
            showToast('⚠️ Nenhuma linha selecionada para exportar.', 'warning', 3000);
            return;
        }
        csv = toTSV(HEADER_34, selected);
        filename = `tarifario_${builderState.agente || 'mond'}_${new Date().toISOString().split('T')[0]}.tsv`;
    } else {
        const selected = builderState.spaceLines.filter(l => l._selected !== false);
        if (selected.length === 0) {
            showToast('⚠️ Nenhuma linha selecionada para exportar.', 'warning', 3000);
            return;
        }
        csv = toCSV_Space(selected);
        filename = `space_${builderState.agente || 'mond'}_${new Date().toISOString().split('T')[0]}.csv`;
    }
    
    // Download file
    const isTsv = filename.endsWith('.tsv');
    const blob = new Blob([isTsv ? csv : '\uFEFF' + csv], { type: isTsv ? 'text/tab-separated-values;charset=utf-8;' : 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    
    showToast(`✅ Arquivo "${filename}" exportado com sucesso!`, 'success', 4000);
}

function handleCopyClipboard(type) {
    let tsv;
    
    if (type === 'tarifario') {
        const selected = builderState.tarifarioLines.filter(l => l._selected !== false);
        if (selected.length === 0) {
            showToast('⚠️ Nenhuma linha selecionada.', 'warning', 3000);
            return;
        }
        tsv = toTSV(HEADER_34, selected);
    } else {
        const selected = builderState.spaceLines.filter(l => l._selected !== false);
        if (selected.length === 0) {
            showToast('⚠️ Nenhuma linha selecionada.', 'warning', 3000);
            return;
        }
        tsv = toTSV_Space(selected);
    }
    
    navigator.clipboard.writeText(tsv).then(() => {
        showToast(`📋 ${type === 'tarifario' ? 'Tarifário' : 'Space on Hand'} copiado para a área de transferência! Cole direto no Excel/Skychart.`, 'success', 4000);
    }).catch(() => {
        // Fallback
        const textarea = document.createElement('textarea');
        textarea.value = tsv;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        showToast(`📋 Copiado para a área de transferência!`, 'success', 3000);
    });
}

/* ──────────────────────────────────────────────────────────────────────────────
   CLEAR ALL
   ────────────────────────────────────────────────────────────────────────── */

function handleClearAll() {
    builderState.rawJson = null;
    builderState.tarifarioLines = [];
    builderState.spaceLines = [];
    builderState.flags = [];
    builderState.engineFlags = [];
    builderState.images = [];
    
    const textarea = document.getElementById('builder-json-input');
    if (textarea) textarea.value = '';
    
    const resultsSection = document.getElementById('builder-results');
    if (resultsSection) resultsSection.style.display = 'none';
    
    renderImagePreviews();
    showToast('🗑️ Dados limpos.', 'info', 2000);
}

/* ──────────────────────────────────────────────────────────────────────────────
   PLACEHOLDER UPDATE
   ────────────────────────────────────────────────────────────────────────── */

function updateBuilderPlaceholder() {
    const textarea = document.getElementById('builder-json-input');
    if (!textarea) return;
    
    if (builderState.tipo === 'space') {
        textarea.placeholder = 'Cole aqui o texto do e-mail de Space on Hand do agente...\n\nDica: clique em "Carregar Exemplo" para ver o formato de texto esperado.';
    } else {
        textarea.placeholder = 'Cole aqui o texto do e-mail de Tarifas do agente...\n\nDica: clique em "Carregar Exemplo" para ver o formato de texto esperado.';
    }
}
