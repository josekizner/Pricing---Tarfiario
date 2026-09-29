/* =====================================================================
   MOND SHIPPING — AGENT DASHBOARD CONTROLLER v3 (dashboard_controller.js)
   Dashboard Visual, Intuitivo e Executivo para Análise e Benchmarking de Agentes
   ===================================================================== */

// ── BASE PORT CONSTANTS ────────────────────────────────────────────────────
const BP_ORIGINS = ['NINGBO', 'SHANGHAI', 'SHENZHEN', 'SHEKOU', 'YANTIAN', 'QINGDAO', 'XIAMEN', 'TIANJIN'];
const BP_DESTINATIONS = ['SANTOS', 'ITAPOA', 'ITAPOÁ', 'NAVEGANTES', 'PARANAGUÁ', 'PARANAGUA'];

const REGION_SUDESTE = new Set([
    'SANTOS', 'ITAPOA', 'ITAPOÁ', 'NAVEGANTES', 'ITAJAÍ', 'ITAJAI',
    'PARANAGUÁ', 'PARANAGUA', 'RIO GRANDE', 'RIO DE JANEIRO', 'ITAGUAÍ',
    'ITAGUAI', 'VITÓRIA', 'VITORIA'
]);
const REGION_NORDESTE = new Set([
    'SUAPE', 'PECÉM', 'PECEM', 'SALVADOR', 'MANAUS', 'VILA DO CONDE'
]);
const MAIN_ORIGINS = ['SHANGHAI', 'NINGBO', 'SHENZHEN'];

function isBasePort(origem, destino) {
    const o = (origem || '').toUpperCase().trim();
    const d = (destino || '').toUpperCase().trim();
    const matchO = BP_ORIGINS.some(bp => o.includes(bp));
    const matchD = BP_DESTINATIONS.some(bp => d.includes(bp));
    return matchO && matchD;
}

function getRegion(destino) {
    const d = (destino || '').toUpperCase().trim();
    if (REGION_SUDESTE.has(d)) return 'SUDESTE';
    for (const port of REGION_SUDESTE) { if (d.includes(port)) return 'SUDESTE'; }
    if (REGION_NORDESTE.has(d)) return 'NORDESTE';
    for (const port of REGION_NORDESTE) { if (d.includes(port)) return 'NORDESTE'; }
    return 'OUTRO';
}

function matchesOrigin(origem, mainOrigin) {
    const o = (origem || '').toUpperCase().trim();
    if (mainOrigin === 'SHENZHEN') {
        return o.includes('SHENZHEN') || o.includes('SHEKOU') || o.includes('YANTIAN');
    }
    return o.includes(mainOrigin);
}

function normalizeContainerDash(c) {
    const clean = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean.includes('20DRY') || clean.includes('20GP') || clean.includes('20FT')) return "20' DRY";
    if (clean.includes('40HQ') || clean.includes('40HC') || clean.includes('HIGH') || clean.includes('HC')) return "40' HIGH CUBE";
    if (clean.includes('40NOR') || clean.includes('NOR')) return "40' NOR";
    if (clean.includes('40DRY') || clean.includes('40GP') || clean.includes('40FT')) return "40' DRY";
    if (clean.includes('20')) return "20' DRY";
    if (clean.includes('40')) return "40' DRY";
    return c || "40' HIGH CUBE";
}

function normalizeRow(r) {
    if (r.container) r.container = normalizeContainerDash(r.container);
    return r;
}

// ── SNAPSHOTS & DATA REPOSITORY ──────────────────────────────────────────
window.db = {
    snapshots: [],
    
    async loadAllSnapshots() {
        if (window.BUNDLED_SNAPSHOTS && Array.isArray(window.BUNDLED_SNAPSHOTS) && window.BUNDLED_SNAPSHOTS.length > 0) {
            this.snapshots = window.BUNDLED_SNAPSHOTS;
            console.log('[Dashboard] Carregados', this.snapshots.length, 'snapshots do bundle.');
            return this.snapshots;
        }

        const list = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            const match = key.match(/^snapshot:([^:]+):(\d{4}-\d{2}-\d{2})$/);
            if (match) {
                try {
                    const content = JSON.parse(localStorage.getItem(key)) || [];
                    list.push({ key, agent: match[1], date: match[2], data: content });
                } catch (err) {}
            }
        }
        this.snapshots = list;
        return this.snapshots;
    },
    
    getSnapshotData(key) {
        const found = this.snapshots.find(s => s.key === key);
        let data = [];
        if (found) data = found.data || [];
        else { try { data = JSON.parse(localStorage.getItem(key)) || []; } catch (e) { data = []; } }
        return data.map(normalizeRow);
    }
};

const EXCLUDED_AGENTS = new Set(['CHINA GLOBAL', 'N/A', '', 'DESCONHECIDO']);

function getLiveDataByAgent() {
    const rates = window.appRates || [];
    const tariffRates = rates.filter(r => !r.source || r.source === 'rate');
    const byAgent = {};
    tariffRates.forEach(r => {
        const agentName = (r.agente || '').toUpperCase().trim();
        if (!agentName || EXCLUDED_AGENTS.has(agentName)) return;
        if (!byAgent[agentName]) byAgent[agentName] = [];
        byAgent[agentName].push({
            agente: agentName,
            armador: (r.armador || '').toUpperCase().trim(),
            origem: r.origem || '',
            destino: r.destino || '',
            container: normalizeContainerDash(r.container || ''),
            frete: r.valor != null && r.valor !== '' && !isNaN(Number(r.valor)) ? Number(r.valor) : null,
            freeTime: r.freetime != null && r.freetime !== '' && !isNaN(Number(r.freetime)) ? Number(r.freetime) : null,
            validadeFim: r.fim || '',
            observacao: r.observacao || '',
            data: new Date().toISOString().split('T')[0]
        });
    });
    return byAgent;
}

function getGroupedAgentSnapshots() {
    const todayStr = new Date().toISOString().split('T')[0];
    const liveByAgent = getLiveDataByAgent();
    const historicalSnaps = (window.db && window.db.snapshots) ? window.db.snapshots : (window.BUNDLED_SNAPSHOTS || []);
    const grouped = {};

    // 1. Live data from active session
    for (const [agent, rows] of Object.entries(liveByAgent)) {
        if (!grouped[agent]) grouped[agent] = [];
        grouped[agent].push({ key: `snapshot:${agent}:${todayStr}`, agent, date: todayStr, _liveData: rows });
    }

    // 2. Historical/Bundled snapshots
    historicalSnaps.forEach(s => {
        const ag = (s.agent || '').toUpperCase().trim();
        if (EXCLUDED_AGENTS.has(ag)) return;
        if (!grouped[ag]) grouped[ag] = [];
        grouped[ag].push(s);
    });

    // 3. Fallback: Extract from active commercial offers if grouped is still empty
    if (Object.keys(grouped).length === 0 && window.appComercial && window.appComercial.length > 0) {
        window.appComercial.forEach(c => {
            const ag = (c.agente || '').toUpperCase().trim();
            if (!ag || EXCLUDED_AGENTS.has(ag) || c.valor <= 0) return;
            if (!grouped[ag]) grouped[ag] = [{ key: `com:${ag}`, agent: ag, date: todayStr, _liveData: [] }];
            grouped[ag][0]._liveData.push({
                agente: ag,
                armador: (c.armador || 'VARIOS').toUpperCase().trim(),
                origem: c.origem || '',
                destino: c.destino || '',
                container: normalizeContainerDash(c.container || "40' HIGH CUBE"),
                frete: Number(c.valor),
                freeTime: Number(c.freetime) || 0,
                validadeFim: c.fim || '',
                observacao: c.observacao || '',
                data: c.inicio || todayStr
            });
        });
    }

    for (const agent in grouped) {
        grouped[agent].sort((a, b) => b.date.localeCompare(a.date));
    }
    return grouped;
}

function getSnapshotDataSmart(entry) {
    let data = [];
    if (entry._liveData) data = entry._liveData;
    else if (window.db && typeof window.db.getSnapshotData === 'function') data = window.db.getSnapshotData(entry.key);
    else if (entry.data) data = entry.data;
    else { try { data = JSON.parse(localStorage.getItem(entry.key)) || []; } catch(e) { data = []; } }
    return data.map(normalizeRow);
}

// ── OBS CATEGORY FILTERING ────────────────────────────────────────────────
const OBS_RESTRICTED_KEYWORDS = ['pneu', 'autopeça', 'auto-peça', 'borracha', 'solar', 'painel', 'vidro', 'textil', 'têxtil', 'ows', 'gw', 'peso', 'weight', 'promo', 'spot'];

function filterRowsByObs(rows, obsFilter) {
    if (!obsFilter || obsFilter === 'all') return rows;
    return rows.filter(r => {
        const obs = (r.observacao || '').toLowerCase();
        if (obsFilter === 'geral') return !OBS_RESTRICTED_KEYWORDS.some(kw => obs.includes(kw));
        if (obsFilter === 'pneu') return obs.includes('pneu') || obs.includes('autopeça') || obs.includes('auto-peça') || obs.includes('borracha');
        if (obsFilter === 'solar') return obs.includes('solar') || obs.includes('painel');
        if (obsFilter === 'vidro') return obs.includes('vidro');
        if (obsFilter === 'textil') return obs.includes('textil') || obs.includes('têxtil');
        if (obsFilter === 'ows') return obs.includes('ows') || obs.includes('gw') || obs.includes('peso') || obs.includes('weight');
        if (obsFilter === 'promo') return obs.includes('promo') || obs.includes('spot');
        return true;
    });
}

// ── VIEW SWITCHING ────────────────────────────────────────────────────────
window.currentAgentView = 'cards';

window.switchAgentView = function(viewName) {
    window.currentAgentView = viewName;
    ['cards', 'matchups', 'ranking'].forEach(v => {
        const el = document.getElementById(`agent-view-${v}`);
        const btn = document.getElementById(`btn-agent-view-${v}`);
        if (el) el.style.display = (v === viewName) ? 'block' : 'none';
        if (btn) {
            if (v === viewName) {
                btn.classList.add('active');
                btn.style.background = 'var(--card-bg)';
                btn.style.color = 'var(--primary)';
                btn.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
            } else {
                btn.classList.remove('active');
                btn.style.background = 'transparent';
                btn.style.color = 'var(--text-secondary)';
                btn.style.boxShadow = 'none';
            }
        }
    });
    if (typeof lucide !== 'undefined') lucide.createIcons();
};

// ── FILTER TRIGGER HELPER ─────────────────────────────────────────────────
window.filterByAgentInMainPortal = function(agentName) {
    // Switch to search tab
    const searchTabBtn = document.getElementById('search-tab-link');
    if (searchTabBtn) searchTabBtn.click();
    
    // Set agent input and trigger search
    const agentInput = document.getElementById('filter-agente-top');
    if (agentInput) {
        agentInput.value = agentName;
        agentInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (typeof applyFilters === 'function') applyFilters();
    if (typeof showToast === 'function') {
        showToast(`🔍 Filtrando portal principal pelo agente: ${agentName}`, 'info', 3000);
    }
};

// ── MAIN RENDER FUNCTION ──────────────────────────────────────────────────
function renderDashboardTab() {
    // Make sure snapshots are loaded
    if (window.db && window.db.snapshots.length === 0 && window.BUNDLED_SNAPSHOTS) {
        window.db.snapshots = window.BUNDLED_SNAPSHOTS;
    }

    const grouped = getGroupedAgentSnapshots();
    const porAgente = {};
    const agentsList = [];

    for (const agent in grouped) {
        if (grouped[agent].length > 0) {
            const rows = getSnapshotDataSmart(grouped[agent][0]);
            if (rows.length > 0) {
                agentsList.push(agent);
                porAgente[agent] = rows;
            }
        }
    }
    agentsList.sort();

    // Populate Container Filter
    populateContainerFilter(porAgente);

    // Read user filters
    const searchVal = (document.getElementById('agent-dash-search')?.value || '').trim().toUpperCase();
    const containerFilterVal = (document.getElementById('agent-dash-container-filter')?.value || '').toUpperCase();
    const obsFilter = document.getElementById('agent-dash-obs-filter')?.value || 'all';

    // Filter each agent's rows
    const filteredPorAgente = {};
    for (const [ag, rows] of Object.entries(porAgente)) {
        // If agent name matches search, keep all or filter routes
        let f = rows;
        if (containerFilterVal) f = f.filter(r => (r.container || '').toUpperCase() === containerFilterVal);
        f = filterRowsByObs(f, obsFilter);
        
        if (searchVal) {
            const matchesAgent = ag.includes(searchVal);
            if (!matchesAgent) {
                f = f.filter(r => (r.origem || '').toUpperCase().includes(searchVal) || (r.destino || '').toUpperCase().includes(searchVal));
            }
        }

        if (f.length > 0) filteredPorAgente[ag] = f;
    }

    // Compute route matchups & winners
    const routeMatchups = computeRouteMatchups(filteredPorAgente);

    // Compute agent scorecards & statistics
    const agentStats = computeAgentStats(filteredPorAgente, routeMatchups);

    // Render 1. Podium
    renderAgentPodium(agentStats, routeMatchups);

    // Render 2. Agent Cards View
    renderAgentCardsGrid(agentStats);

    // Render 3. Route Matchup View
    renderRouteMatchupsView(routeMatchups);

    // Render 4. Leaderboard Table
    renderAgentLeaderboardTable(agentStats);

    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function populateContainerFilter(porAgente) {
    const sel = document.getElementById('agent-dash-container-filter');
    if (!sel || sel.children.length > 2) return;
    const currentVal = sel.value;
    const containers = new Set();
    for (const rows of Object.values(porAgente)) {
        rows.forEach(r => { if (r.container) containers.add(r.container.toUpperCase()); });
    }
    let html = '<option value="">Todos Contêineres</option>';
    Array.from(containers).sort().forEach(c => { html += `<option value="${c}">${c}</option>`; });
    sel.innerHTML = html;
    if (currentVal) sel.value = currentVal;
}

// ── MATCHUP & STATISTICS CALCULATORS ──────────────────────────────────────
function computeRouteMatchups(porAgente) {
    // Group quotes by Route: "ORIGEM → DESTINO (CONTAINER)"
    const routes = {};
    for (const [agent, rows] of Object.entries(porAgente)) {
        rows.forEach(r => {
            const frete = Number(r.frete);
            if (!frete || isNaN(frete) || frete < 200 || frete > 25000) return;
            const orig = (r.origem || 'CHINA').toUpperCase().trim();
            const dest = (r.destino || 'BRASIL').toUpperCase().trim();
            const cont = normalizeContainerDash(r.container || "40' HIGH CUBE");
            const key = `${orig} → ${dest} [${cont}]`;

            if (!routes[key]) {
                routes[key] = {
                    key,
                    origem: orig,
                    destino: dest,
                    container: cont,
                    quotes: []
                };
            }
            routes[key].quotes.push({
                agente: agent,
                armador: r.armador || 'N/A',
                frete: frete,
                freeTime: r.freeTime || 0,
                validade: r.validadeFim || ''
            });
        });
    }

    // Sort quotes for each route and pick winners
    const result = {};
    for (const [key, info] of Object.entries(routes)) {
        if (info.quotes.length === 0) continue;
        info.quotes.sort((a, b) => a.frete - b.frete);
        const best = info.quotes[0];
        const worst = info.quotes[info.quotes.length - 1];
        const secondBest = info.quotes[1] || best;
        const avg = info.quotes.reduce((acc, q) => acc + q.frete, 0) / info.quotes.length;

        result[key] = {
            ...info,
            winner: best.agente,
            bestPrice: best.frete,
            worstPrice: worst.frete,
            secondPrice: secondBest.frete,
            avgPrice: Math.round(avg),
            spread: Math.round(worst.frete - best.frete),
            savingVsSecond: Math.round(secondBest.frete - best.frete)
        };
    }
    return result;
}

function computeAgentStats(porAgente, routeMatchups) {
    const stats = {};
    const totalMatchups = Object.keys(routeMatchups).length;

    for (const [agent, rows] of Object.entries(porAgente)) {
        const validRates = rows.filter(r => r.frete != null && !isNaN(r.frete) && r.frete >= 200 && r.frete <= 25000);
        if (validRates.length === 0) continue;

        const prices = validRates.map(r => Number(r.frete));
        const avgFreight = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
        const minFreight = Math.min(...prices);
        const freeTimes = validRates.map(r => Number(r.freeTime) || 0).filter(ft => ft > 0);
        const avgFt = freeTimes.length > 0 ? Math.round(freeTimes.reduce((a, b) => a + b, 0) / freeTimes.length) : 14;

        // Carrier partners
        const carriers = new Set();
        validRates.forEach(r => { if (r.armador && r.armador !== 'N/A') carriers.add(r.armador); });

        // Count route wins
        let wins = 0;
        const wonRoutes = [];
        for (const [routeKey, m] of Object.entries(routeMatchups)) {
            if (m.winner === agent) {
                wins++;
                wonRoutes.push({ route: routeKey, price: m.bestPrice, spread: m.spread });
            }
        }
        wonRoutes.sort((a, b) => b.spread - a.spread);

        // Win rate across quoted routes
        const quotedRoutesCount = new Set(validRates.map(r => `${(r.origem||'').toUpperCase()}→${(r.destino||'').toUpperCase()}`)).size;
        const winRate = quotedRoutesCount > 0 ? Math.round((wins / quotedRoutesCount) * 100) : 0;

        stats[agent] = {
            agent,
            avgFreight,
            minFreight,
            avgFt,
            carriers: Array.from(carriers),
            totalQuotes: validRates.length,
            quotedRoutesCount,
            wins,
            winRate,
            wonRoutes,
            sampleRows: validRates
        };
    }

    return stats;
}

// ── RENDER SEÇÃO 1: PODIUM & DESTAQUES ─────────────────────────────────────
function renderAgentPodium(stats, routeMatchups) {
    const podiumEl = document.getElementById('agent-podium-section');
    if (!podiumEl) return;

    const sortedAgents = Object.values(stats).sort((a, b) => {
        // Sort by win rate and average freight
        if (b.wins !== a.wins) return b.wins - a.wins;
        return a.avgFreight - b.avgFreight;
    });

    if (sortedAgents.length === 0) {
        podiumEl.innerHTML = `
            <div class="card" style="padding:30px; text-align:center; color:var(--text-muted); border-radius:12px;">
                Nenhum agente encontrado com os filtros selecionados.
            </div>`;
        return;
    }

    const first = sortedAgents[0];
    const second = sortedAgents[1] || null;
    const third = sortedAgents[2] || null;

    // Largest spread in entire system
    let maxSpreadRoute = null;
    let maxSpreadVal = 0;
    for (const m of Object.values(routeMatchups)) {
        if (m.spread > maxSpreadVal) {
            maxSpreadVal = m.spread;
            maxSpreadRoute = m;
        }
    }

    podiumEl.innerHTML = `
        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:16px;">
            <!-- 🥇 O Campeão Geral -->
            <div class="card" style="background:linear-gradient(135deg, rgba(234,179,8,0.08), rgba(245,158,11,0.03)); border:2px solid #eab308; border-radius:14px; padding:18px; position:relative; overflow:hidden; box-shadow:0 4px 16px rgba(234,179,8,0.12);">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <span style="display:inline-flex; align-items:center; gap:4px; font-size:0.72rem; font-weight:800; text-transform:uppercase; letter-spacing:0.5px; color:#b45309; background:rgba(234,179,8,0.2); padding:3px 8px; border-radius:6px;">
                            🥇 Campeão em Custo & Domínio
                        </span>
                        <h3 style="font-size:1.25rem; font-weight:800; color:var(--text-primary); margin:8px 0 2px 0;">${first.agent}</h3>
                        <p style="font-size:0.78rem; color:var(--text-secondary); margin:0;">${first.wins} rotas com o menor frete (${first.winRate}% de vitórias)</p>
                    </div>
                    <div style="font-size:2.2rem; line-height:1;">👑</div>
                </div>
                <div style="margin-top:14px; display:flex; gap:16px; align-items:baseline;">
                    <div>
                        <span style="font-size:0.68rem; color:var(--text-muted); text-transform:uppercase; font-weight:700;">Compra Média</span>
                        <div style="font-size:1.35rem; font-weight:900; color:#16a34a;">USD ${first.avgFreight.toLocaleString('pt-BR')}</div>
                    </div>
                    <div>
                        <span style="font-size:0.68rem; color:var(--text-muted); text-transform:uppercase; font-weight:700;">Free Time Médio</span>
                        <div style="font-size:1.1rem; font-weight:800; color:var(--text-primary);">${first.avgFt} dias</div>
                    </div>
                </div>
                <div style="margin-top:12px; padding-top:10px; border-top:1px dashed rgba(234,179,8,0.3); display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-size:0.75rem; color:var(--text-secondary);">Melhor frete a partir de <strong>USD ${first.minFreight.toLocaleString('pt-BR')}</strong></span>
                    <button class="btn btn-sm btn-primary" onclick="window.filterByAgentInMainPortal('${first.agent}')" style="padding:4px 10px; font-size:0.75rem; border-radius:6px; cursor:pointer;">Filtrar</button>
                </div>
            </div>

            <!-- 🥈 Vice-Campeão -->
            ${second ? `
            <div class="card" style="background:linear-gradient(135deg, rgba(148,163,184,0.08), rgba(203,213,225,0.03)); border:1.5px solid #94a3b8; border-radius:14px; padding:18px; position:relative;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <span style="display:inline-flex; align-items:center; gap:4px; font-size:0.72rem; font-weight:800; text-transform:uppercase; letter-spacing:0.5px; color:#475569; background:rgba(148,163,184,0.2); padding:3px 8px; border-radius:6px;">
                            🥈 2º Lugar Geral
                        </span>
                        <h3 style="font-size:1.15rem; font-weight:800; color:var(--text-primary); margin:8px 0 2px 0;">${second.agent}</h3>
                        <p style="font-size:0.78rem; color:var(--text-secondary); margin:0;">${second.wins} rotas vencidas (${second.winRate}% vitórias)</p>
                    </div>
                    <div style="font-size:2rem; line-height:1;">🥈</div>
                </div>
                <div style="margin-top:14px; display:flex; gap:16px; align-items:baseline;">
                    <div>
                        <span style="font-size:0.68rem; color:var(--text-muted); text-transform:uppercase; font-weight:700;">Compra Média</span>
                        <div style="font-size:1.35rem; font-weight:900; color:#0284c7;">USD ${second.avgFreight.toLocaleString('pt-BR')}</div>
                    </div>
                    <div>
                        <span style="font-size:0.68rem; color:var(--text-muted); text-transform:uppercase; font-weight:700;">Free Time</span>
                        <div style="font-size:1.1rem; font-weight:800; color:var(--text-primary);">${second.avgFt} dias</div>
                    </div>
                </div>
                <div style="margin-top:12px; padding-top:10px; border-top:1px dashed rgba(148,163,184,0.3); display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-size:0.75rem; color:var(--text-secondary);">${second.quotedRoutesCount} rotas analisadas</span>
                    <button class="btn btn-sm btn-secondary" onclick="window.filterByAgentInMainPortal('${second.agent}')" style="padding:4px 10px; font-size:0.75rem; border-radius:6px; cursor:pointer;">Filtrar</button>
                </div>
            </div>` : ''}

            <!-- 💰 Maior Oportunidade de Spread / Economia -->
            <div class="card" style="background:linear-gradient(135deg, rgba(16,185,129,0.08), rgba(5,150,105,0.03)); border:1.5px solid #10b981; border-radius:14px; padding:18px; position:relative;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <span style="display:inline-flex; align-items:center; gap:4px; font-size:0.72rem; font-weight:800; text-transform:uppercase; letter-spacing:0.5px; color:#065f46; background:rgba(16,185,129,0.2); padding:3px 8px; border-radius:6px;">
                            ⚡ Maior Economia Identificada
                        </span>
                        <h3 style="font-size:1.1rem; font-weight:800; color:var(--text-primary); margin:8px 0 2px 0;">
                            ${maxSpreadRoute ? maxSpreadRoute.key.split('[')[0] : 'Ningbo → Santos'}
                        </h3>
                        <p style="font-size:0.78rem; color:var(--text-secondary); margin:0;">Vencedor: <strong>${maxSpreadRoute ? maxSpreadRoute.winner : 'South Cargo'}</strong></p>
                    </div>
                    <div style="font-size:2rem; line-height:1;">💰</div>
                </div>
                <div style="margin-top:14px; display:flex; gap:16px; align-items:baseline;">
                    <div>
                        <span style="font-size:0.68rem; color:var(--text-muted); text-transform:uppercase; font-weight:700;">Economia Direta</span>
                        <div style="font-size:1.35rem; font-weight:900; color:#10b981;">
                            USD ${maxSpreadVal.toLocaleString('pt-BR')}
                        </div>
                    </div>
                    <div>
                        <span style="font-size:0.68rem; color:var(--text-muted); text-transform:uppercase; font-weight:700;">Menor Custo</span>
                        <div style="font-size:1.1rem; font-weight:800; color:var(--text-primary);">
                            USD ${maxSpreadRoute ? maxSpreadRoute.bestPrice.toLocaleString('pt-BR') : '—'}
                        </div>
                    </div>
                </div>
                <div style="margin-top:12px; padding-top:10px; border-top:1px dashed rgba(16,185,129,0.3); display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-size:0.75rem; color:var(--text-secondary);">${maxSpreadRoute ? maxSpreadRoute.quotes.length : 0} agentes disputando esta rota</span>
                    <button class="btn btn-sm btn-primary" onclick="window.switchAgentView('matchups')" style="padding:4px 10px; font-size:0.75rem; border-radius:6px; cursor:pointer;">Ver Disputa</button>
                </div>
            </div>
        </div>
    `;
}

// ── RENDER VIEW 1: SCORECARDS DOS AGENTES ─────────────────────────────────
function renderAgentCardsGrid(agentStats) {
    const gridEl = document.getElementById('agent-cards-grid');
    if (!gridEl) return;

    const list = Object.values(agentStats).sort((a, b) => a.avgFreight - b.avgFreight);

    if (list.length === 0) {
        gridEl.innerHTML = `<div style="grid-column:1/-1; padding:40px; text-align:center; color:var(--text-muted);">Nenhum agente localizado.</div>`;
        return;
    }

    gridEl.innerHTML = list.map((st, idx) => {
        const rankMedal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`;
        const carriersBadges = st.carriers.slice(0, 4).map(c => 
            `<span style="background:var(--bg-secondary); border:1px solid var(--card-border); padding:2px 6px; border-radius:4px; font-size:0.68rem; font-weight:600; color:var(--text-secondary);">${c}</span>`
        ).join(' ');

        const topWonRoutesHtml = st.wonRoutes.slice(0, 2).map(r => `
            <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.75rem; padding:4px 0; border-bottom:1px solid rgba(0,0,0,0.03);">
                <span style="color:var(--text-secondary); font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:180px;">${r.route.split('[')[0]}</span>
                <span style="font-weight:700; color:#16a34a;">USD ${r.price.toLocaleString('pt-BR')}</span>
            </div>
        `).join('') || '<div style="font-size:0.72rem; color:var(--text-muted); font-style:italic; padding:4px 0;">Nenhuma rota com menor preço absoluto</div>';

        return `
            <div class="card agent-pro-card" style="padding:18px; border-radius:14px; border:1px solid var(--card-border); background:var(--card-bg); display:flex; flex-direction:column; justify-content:space-between; transition:transform 0.2s, box-shadow 0.2s;">
                <div>
                    <!-- Header -->
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                        <div style="display:flex; align-items:center; gap:8px;">
                            <span style="width:28px; height:28px; border-radius:50%; background:var(--bg-secondary); border:1px solid var(--card-border); display:flex; align-items:center; justify-content:center; font-weight:800; font-size:0.85rem; color:var(--text-primary);">${rankMedal}</span>
                            <h4 style="margin:0; font-size:1.02rem; font-weight:800; color:var(--text-primary); letter-spacing:-0.2px;">${st.agent}</h4>
                        </div>
                        <span style="background:${st.winRate >= 30 ? 'rgba(16,185,129,0.12)' : 'rgba(59,130,246,0.1)'}; color:${st.winRate >= 30 ? '#10b981' : '#3b82f6'}; font-weight:700; font-size:0.72rem; padding:3px 8px; border-radius:20px;">
                            ${st.wins} vitórias (${st.winRate}%)
                        </span>
                    </div>

                    <!-- Metrics Price & Free Time -->
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; background:var(--bg-secondary); padding:10px 12px; border-radius:10px; margin-bottom:12px;">
                        <div>
                            <span style="font-size:0.65rem; color:var(--text-muted); text-transform:uppercase; font-weight:700; display:block;">Compra Média</span>
                            <span style="font-size:1.2rem; font-weight:900; color:#16a34a;">USD ${st.avgFreight.toLocaleString('pt-BR')}</span>
                        </div>
                        <div>
                            <span style="font-size:0.65rem; color:var(--text-muted); text-transform:uppercase; font-weight:700; display:block;">Free Time Médio</span>
                            <span style="font-size:1.05rem; font-weight:800; color:var(--text-primary);">${st.avgFt} dias</span>
                        </div>
                    </div>

                    <!-- Win Rate Visual Progress Bar -->
                    <div style="margin-bottom:12px;">
                        <div style="display:flex; justify-content:space-between; font-size:0.7rem; color:var(--text-muted); font-weight:600; margin-bottom:4px;">
                            <span>Dominância em Rotas</span>
                            <span>${st.wins} de ${st.quotedRoutesCount} rotas cotadas</span>
                        </div>
                        <div style="height:6px; background:var(--bg-secondary); border-radius:3px; overflow:hidden;">
                            <div style="width:${Math.min(100, Math.max(5, st.winRate))}%; height:100%; background:linear-gradient(90deg, #10b981, #0284c7); border-radius:3px;"></div>
                        </div>
                    </div>

                    <!-- Best Winning Routes -->
                    <div style="margin-bottom:14px;">
                        <span style="font-size:0.68rem; font-weight:700; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.4px; display:block; margin-bottom:4px;">Rotas mais competitivas:</span>
                        ${topWonRoutesHtml}
                    </div>
                </div>

                <!-- Footer with Carriers and Action Button -->
                <div>
                    <div style="display:flex; flex-wrap:wrap; gap:4px; margin-bottom:12px; align-items:center;">
                        <span style="font-size:0.68rem; color:var(--text-muted); font-weight:600; margin-right:2px;">Armadores:</span>
                        ${carriersBadges}
                    </div>
                    <button class="btn btn-outline" onclick="window.filterByAgentInMainPortal('${st.agent}')" style="width:100%; height:34px; font-size:0.78rem; font-weight:600; border-radius:8px; display:flex; align-items:center; justify-content:center; gap:6px; cursor:pointer;">
                        <i data-lucide="search" style="width:13px; height:13px;"></i> Ver Tarifas deste Agente
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

// ── RENDER VIEW 2: DISPUTA POR ROTA (MATCHUPS) ────────────────────────────
function renderRouteMatchupsView(routeMatchups) {
    const container = document.getElementById('agent-matchups-container');
    if (!container) return;

    const list = Object.values(routeMatchups).sort((a, b) => b.spread - a.spread);

    if (list.length === 0) {
        container.innerHTML = `<div class="card" style="padding:40px; text-align:center; color:var(--text-muted);">Nenhuma rota com cotações múltiplas encontrada.</div>`;
        return;
    }

    container.innerHTML = list.map(m => {
        const quotesBars = m.quotes.map(q => {
            const isWinner = q.agente === m.winner;
            const diff = q.frete - m.bestPrice;
            const barWidthPercent = Math.max(15, Math.min(100, Math.round((m.bestPrice / q.frete) * 100)));
            const barColor = isWinner ? '#10b981' : diff <= 200 ? '#3b82f6' : '#f59e0b';

            return `
                <div style="display:grid; grid-template-columns: 180px 1fr 140px; gap:12px; align-items:center; padding:6px 0;">
                    <div style="display:flex; align-items:center; gap:6px;">
                        ${isWinner ? '<span style="font-size:0.9rem;">👑</span>' : '<span style="width:16px;"></span>'}
                        <span style="font-size:0.82rem; font-weight:${isWinner ? '800' : '600'}; color:${isWinner ? '#10b981' : 'var(--text-primary)'}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                            ${q.agente}
                        </span>
                        <span style="font-size:0.68rem; color:var(--text-muted); background:var(--bg-secondary); padding:1px 5px; border-radius:4px;">${q.armador}</span>
                    </div>

                    <!-- Visual Comparison Bar -->
                    <div style="background:var(--bg-secondary); height:14px; border-radius:7px; overflow:hidden; position:relative;">
                        <div style="width:${barWidthPercent}%; height:100%; background:${barColor}; border-radius:7px; transition:width 0.3s ease;"></div>
                    </div>

                    <!-- Price & Diff -->
                    <div style="display:flex; justify-content:flex-end; align-items:center; gap:8px;">
                        <span style="font-size:0.9rem; font-weight:800; color:${isWinner ? '#10b981' : 'var(--text-primary)'};">
                            USD ${q.frete.toLocaleString('pt-BR')}
                        </span>
                        ${diff > 0 ? `<span style="font-size:0.72rem; color:#ef4444; font-weight:600;">+USD ${diff.toLocaleString('pt-BR')}</span>` : `<span style="font-size:0.72rem; color:#10b981; font-weight:700; background:rgba(16,185,129,0.12); padding:1px 6px; border-radius:10px;">Melhor</span>`}
                    </div>
                </div>
            `;
        }).join('');

        return `
            <div class="card" style="padding:16px 20px; border-radius:14px; border:1px solid var(--card-border); background:var(--card-bg);">
                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:12px; padding-bottom:10px; border-bottom:1px solid var(--card-border);">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <span style="background:rgba(0,75,135,0.1); color:var(--primary); font-weight:800; font-size:0.78rem; padding:4px 10px; border-radius:6px; letter-spacing:0.5px;">
                            ${m.container}
                        </span>
                        <h4 style="margin:0; font-size:1.05rem; font-weight:800; color:var(--text-primary);">
                            ${m.origem} → ${m.destino}
                        </h4>
                    </div>
                    <div style="display:flex; align-items:center; gap:14px;">
                        <span style="font-size:0.78rem; color:var(--text-secondary);">
                            Vencedor: <strong style="color:#10b981;">${m.winner}</strong> (USD ${m.bestPrice.toLocaleString('pt-BR')})
                        </span>
                        ${m.spread > 0 ? `
                        <span style="background:rgba(16,185,129,0.15); color:#065f46; font-weight:800; font-size:0.75rem; padding:4px 10px; border-radius:8px;">
                            Economia de até USD ${m.spread.toLocaleString('pt-BR')}
                        </span>` : ''}
                    </div>
                </div>

                <div style="display:flex; flex-direction:column;">
                    ${quotesBars}
                </div>
            </div>
        `;
    }).join('');
}

// ── RENDER VIEW 3: LEADERBOARD TABLE ──────────────────────────────────────
function renderAgentLeaderboardTable(agentStats) {
    const tbody = document.getElementById('agent-leaderboard-tbody');
    if (!tbody) return;

    const list = Object.values(agentStats).sort((a, b) => a.avgFreight - b.avgFreight);

    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center" style="padding:30px; color:var(--text-muted);">Nenhum dado encontrado.</td></tr>`;
        return;
    }

    tbody.innerHTML = list.map((st, idx) => {
        const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`;
        const carriersText = st.carriers.slice(0, 3).join(', ') || 'Vários';

        return `
            <tr style="border-bottom:1px solid var(--card-border);">
                <td class="text-center" style="font-weight:800; font-size:0.9rem; padding:10px;">${medal}</td>
                <td style="padding:10px; font-weight:700; color:var(--text-primary);">${st.agent}</td>
                <td class="text-right" style="padding:10px; font-weight:800; color:#16a34a; font-size:0.95rem;">
                    USD ${st.avgFreight.toLocaleString('pt-BR')}
                </td>
                <td class="text-center" style="padding:10px;">
                    <span style="background:${st.winRate >= 30 ? 'rgba(16,185,129,0.12)' : 'rgba(59,130,246,0.1)'}; color:${st.winRate >= 30 ? '#10b981' : '#3b82f6'}; font-weight:700; font-size:0.75rem; padding:3px 8px; border-radius:12px;">
                        ${st.winRate}% (${st.wins} vitórias)
                    </span>
                </td>
                <td class="text-center" style="padding:10px; font-weight:600; color:var(--text-secondary);">${st.quotedRoutesCount} rotas</td>
                <td class="text-center" style="padding:10px; font-size:0.78rem; color:var(--text-muted);">${carriersText}</td>
                <td class="text-center" style="padding:10px;">
                    <button class="btn btn-sm btn-outline" onclick="window.filterByAgentInMainPortal('${st.agent}')" style="padding:4px 12px; font-size:0.75rem; border-radius:6px; cursor:pointer;">
                        Filtrar
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

// ── INITIALIZATION ────────────────────────────────────────────────────────
function initDashboard() {
    ['agent-dash-container-filter', 'agent-dash-obs-filter'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', () => renderDashboardTab());
    });
}

// Auto-run when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        initDashboard();
        if (window.db && typeof window.db.loadAllSnapshots === 'function') {
            window.db.loadAllSnapshots().then(() => renderDashboardTab());
        }
    });
} else {
    initDashboard();
    if (window.db && typeof window.db.loadAllSnapshots === 'function') {
        window.db.loadAllSnapshots().then(() => renderDashboardTab());
    }
}

window.renderDashboardTab = renderDashboardTab;
