/* =====================================================================
   MOND SHIPPING — AGENT DASHBOARD CONTROLLER v2 (dashboard_controller.js)
   Renders the restructured Agent Dashboard: Rankings, Comparison, Leaderboard.
   ===================================================================== */

// ── BASE PORT CONSTANTS ────────────────────────────────────────────────────
const BP_ORIGINS = ['NINGBO', 'SHANGHAI', 'SHENZHEN', 'SHEKOU', 'YANTIAN'];
const BP_DESTINATIONS = ['SANTOS', 'ITAPOA', 'ITAPOÁ', 'NAVEGANTES'];

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

// ── CONTAINER NORMALIZATION (self-contained, no dependency on app.js) ────────
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

// Normalize a row's container field in-place
function normalizeRow(r) {
    if (r.container) r.container = normalizeContainerDash(r.container);
    return r;
}

// 1.1 DATABASE PERSISTENCE WRAPPER (window.db)
window.db = {
    snapshots: [],
    
    async loadAllSnapshots() {
        try {
            const res = await fetch('/api/get-snapshots');
            if (res.ok) {
                const data = await res.json();
                this.snapshots = data;
                console.log('Snapshots loaded from server:', this.snapshots.length);
                return this.snapshots;
            }
        } catch (e) {
            console.warn('Failed to load snapshots from server, falling back to localStorage:', e);
        }
        const list = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            const match = key.match(/^snapshot:([^:]+):(\d{4}-\d{2}-\d{2})$/);
            if (match) {
                try {
                    const content = JSON.parse(localStorage.getItem(key)) || [];
                    list.push({ key, agent: match[1], date: match[2], data: content });
                } catch (err) { console.error('Error parsing localStorage snapshot:', key, err); }
            }
        }
        this.snapshots = list;
        console.log('Snapshots loaded from localStorage:', this.snapshots.length);
        return this.snapshots;
    },
    
    async saveSnapshot(agent, date, data) {
        const key = `snapshot:${agent.toUpperCase()}:${date}`;
        try { localStorage.setItem(key, JSON.stringify(data)); } catch (err) { console.error('Failed to save to localStorage:', err); }
        try {
            const res = await fetch('/api/save-snapshot', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Agent-Name': agent.toUpperCase(), 'X-Snapshot-Date': date },
                body: JSON.stringify(data)
            });
            if (res.ok) {
                console.log('Snapshot saved to server.');
                const idx = this.snapshots.findIndex(s => s.key === key);
                if (idx > -1) { this.snapshots[idx].data = data; }
                else { this.snapshots.push({ key, agent: agent.toUpperCase(), date, data }); }
                return true;
            }
        } catch (err) { console.warn('Failed to save snapshot to server:', err); }
        return false;
    },
    
    getSnapshotData(key) {
        const found = this.snapshots.find(s => s.key === key);
        let data = [];
        if (found) data = found.data || [];
        else { try { data = JSON.parse(localStorage.getItem(key)) || []; } catch (e) { data = []; } }
        // Normalize containers on read
        return data.map(normalizeRow);
    },

    clearAllSnapshots() {
        // Clear from localStorage
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('snapshot:')) keysToRemove.push(key);
        }
        keysToRemove.forEach(k => localStorage.removeItem(k));
        this.snapshots = [];
        console.log(`Cleared ${keysToRemove.length} snapshots from localStorage.`);
    }
};

// ══ ONE-TIME WIPE: Clear old snapshots with dirty container names ══
(function() {
    const WIPE_FLAG = 'dashboard_snapshot_wipe_v4';
    if (!localStorage.getItem(WIPE_FLAG)) {
        console.log('One-time snapshot wipe: clearing old data with unnormalized containers...');
        if (window.db) window.db.clearAllSnapshots();
        localStorage.setItem(WIPE_FLAG, Date.now().toString());
    }
})();

// ── LIVE DATA BRIDGE ────────────────────────────────────────────────────────
// Agents to exclude from dashboard (not real forwarding agents)
const EXCLUDED_AGENTS = new Set(['CHINA GLOBAL', 'N/A', '']);

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

async function autoSaveTodaySnapshots() {
    const todayStr = new Date().toISOString().split('T')[0];
    const byAgent = getLiveDataByAgent();
    for (const [agent, rows] of Object.entries(byAgent)) {
        if (rows.length === 0) continue;
        if (window.db && typeof window.db.saveSnapshot === 'function') {
            await window.db.saveSnapshot(agent, todayStr, rows);
        } else {
            try { localStorage.setItem(`snapshot:${agent}:${todayStr}`, JSON.stringify(rows)); } catch(e) {}
        }
    }
    console.log(`Auto-saved ${Object.keys(byAgent).length} agent snapshots for ${todayStr}`);
}

function getHistoricalSnapshots() {
    if (window.db && window.db.snapshots && window.db.snapshots.length > 0) {
        return window.db.snapshots.map(s => ({ key: s.key, agent: s.agent, date: s.date }));
    }
    const list = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        const match = key.match(/^snapshot:([^:]+):(\d{4}-\d{2}-\d{2})$/);
        if (match) list.push({ key, agent: match[1], date: match[2] });
    }
    return list;
}

function getGroupedAgentSnapshots() {
    const todayStr = new Date().toISOString().split('T')[0];
    const liveByAgent = getLiveDataByAgent();
    const historicalSnaps = getHistoricalSnapshots();
    const grouped = {};
    for (const [agent, rows] of Object.entries(liveByAgent)) {
        if (!grouped[agent]) grouped[agent] = [];
        grouped[agent].push({ key: `snapshot:${agent}:${todayStr}`, agent, date: todayStr, _liveData: rows });
    }
    historicalSnaps.forEach(s => {
        if (s.date === todayStr) return;
        if (EXCLUDED_AGENTS.has((s.agent || '').toUpperCase())) return;
        if (!grouped[s.agent]) grouped[s.agent] = [];
        grouped[s.agent].push(s);
    });
    for (const agent in grouped) {
        grouped[agent].sort((a, b) => b.date.localeCompare(a.date));
    }
    return grouped;
}

function getSnapshotDataSmart(entry) {
    let data = [];
    if (entry._liveData) data = entry._liveData;
    else if (window.db && typeof window.db.getSnapshotData === 'function') data = window.db.getSnapshotData(entry.key);
    else { try { data = JSON.parse(localStorage.getItem(entry.key)) || []; } catch(e) { data = []; } }
    return data.map(normalizeRow);
}

// ═══════════════════════════════════════════════════════════════════════════
// INIT & MAIN RENDER
// ═══════════════════════════════════════════════════════════════════════════

function initDashboard() {
    ['agent-dash-container-filter', 'agent-dash-obs-filter'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', () => renderDashboardTab());
    });

    ['agent-comp-filter-origem', 'agent-comp-filter-destino'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', () => renderFullComparison());
    });
}

// Obs category filter: same logic as main search tab
const OBS_RESTRICTED_KEYWORDS = ['pneu', 'autopeça', 'auto-peça', 'borracha', 'solar', 'painel', 'vidro', 'textil', 'têxtil', 'ows', 'gw', 'peso', 'weight', 'promo', 'spot'];
const NAC_KEYWORDS = ['nac', 'nacional', 'cabotagem'];

function filterRowsByObs(rows, obsFilter, serviceFilter) {
    let filtered = rows;
    
    // Obs category filter
    if (obsFilter && obsFilter !== 'all') {
        filtered = filtered.filter(r => {
            const obs = (r.observacao || '').toLowerCase();
            if (obsFilter === 'geral') {
                return !OBS_RESTRICTED_KEYWORDS.some(kw => obs.includes(kw));
            } else if (obsFilter === 'pneu') {
                return obs.includes('pneu') || obs.includes('autopeça') || obs.includes('auto-peça') || obs.includes('borracha');
            } else if (obsFilter === 'solar') {
                return obs.includes('solar') || obs.includes('painel');
            } else if (obsFilter === 'vidro') {
                return obs.includes('vidro');
            } else if (obsFilter === 'textil') {
                return obs.includes('textil') || obs.includes('têxtil');
            } else if (obsFilter === 'ows') {
                return obs.includes('ows') || obs.includes('gw') || obs.includes('peso') || obs.includes('weight');
            } else if (obsFilter === 'promo') {
                return obs.includes('promo') || obs.includes('spot');
            }
            return true;
        });
    }
    
    // Service/NAC filter
    if (serviceFilter === 'no-nac') {
        filtered = filtered.filter(r => {
            const obs = (r.observacao || '').toLowerCase();
            return !NAC_KEYWORDS.some(kw => obs.includes(kw));
        });
    } else if (serviceFilter && serviceFilter.startsWith('svc:')) {
        const svcName = serviceFilter.substring(4).replace(/-/g, ' ');
        filtered = filtered.filter(r => {
            const obs = (r.observacao || '').toLowerCase();
            return obs.includes(svcName);
        });
    }
    
    return filtered;
}

function renderDashboardTab() {
    const grouped = getGroupedAgentSnapshots();
    const porAgente = {};
    const agentsList = [];

    for (const agent in grouped) {
        if (grouped[agent].length > 0) {
            agentsList.push(agent);
            porAgente[agent] = getSnapshotDataSmart(grouped[agent][0]);
        }
    }
    agentsList.sort();

    if (agentsList.length === 0) {
        const tbEl = document.getElementById('agent-comp-tbody');
        if (tbEl) tbEl.innerHTML = '<tr><td colspan="6" class="text-center" style="padding:40px;color:var(--text-muted);">Nenhum dado de agente carregado.</td></tr>';
        return;
    }

    // Populate container filter
    populateContainerFilter(porAgente);

    // Read filters
    const containerFilterVal = (document.getElementById('agent-dash-container-filter')?.value || '').toUpperCase();
    const obsFilter = document.getElementById('agent-dash-obs-filter')?.value || 'all';

    // Apply all filters to data
    const filteredPorAgente = {};
    for (const [ag, rows] of Object.entries(porAgente)) {
        let f = rows;
        if (containerFilterVal) f = f.filter(r => (r.container || '').toUpperCase() === containerFilterVal);
        f = filterRowsByObs(f, obsFilter, 'all');
        if (f.length > 0) filteredPorAgente[ag] = f;
    }

    // Build BASE PORT filtered data
    const bpPorAgente = {};
    for (const [ag, rows] of Object.entries(filteredPorAgente)) {
        const bp = rows.filter(r => isBasePort(r.origem, r.destino));
        if (bp.length > 0) bpPorAgente[ag] = bp;
    }

    // Render all sections
    renderRankingCards(bpPorAgente, filteredPorAgente);
    renderBasePortsComparison(bpPorAgente, Object.keys(bpPorAgente).sort());
    renderFullComparison(filteredPorAgente, Object.keys(filteredPorAgente).sort(), null);
    renderLeaderboard(bpPorAgente, grouped);
    renderTimeline(grouped);

    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function populateContainerFilter(porAgente) {
    const sel = document.getElementById('agent-dash-container-filter');
    if (!sel) return;
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

// ═══════════════════════════════════════════════════════════════════════════
// SEÇÃO 1: RANKING CARDS (Base Ports only)
// ═══════════════════════════════════════════════════════════════════════════

function renderRankingCards(bpPorAgente, allPorAgente) {
    const agentAvg = {};
    for (const [ag, rows] of Object.entries(bpPorAgente)) {
        const fretes = rows.filter(r => r.frete != null && !isNaN(r.frete)).map(r => Number(r.frete));
        if (fretes.length > 0) agentAvg[ag] = { avg: fretes.reduce((a, b) => a + b, 0) / fretes.length, count: fretes.length };
    }

    // 1. MELHOR GERAL (base ports)
    const globalBest = Object.entries(agentAvg).sort((a, b) => a[1].avg - b[1].avg)[0];
    const elGN = document.getElementById('rank-best-global-name');
    const elGM = document.getElementById('rank-best-global-meta');
    if (globalBest) {
        elGN.textContent = globalBest[0];
        elGM.textContent = `Frete médio: USD ${globalBest[1].avg.toFixed(0)} · ${globalBest[1].count} rotas base`;
    } else { elGN.textContent = '—'; elGM.textContent = 'Sem dados base port'; }

    // 2. MELHOR SUDESTE (base ports → all sudeste)
    const seAvg = calcRegionAvg(bpPorAgente, 'SUDESTE');
    const bestSE = Object.entries(seAvg).sort((a, b) => a[1].avg - b[1].avg)[0];
    const elSN = document.getElementById('rank-best-sudeste-name');
    const elSM = document.getElementById('rank-best-sudeste-meta');
    if (bestSE) { elSN.textContent = bestSE[0]; elSM.textContent = `USD ${bestSE[1].avg.toFixed(0)} · ${bestSE[1].count} rotas`; }
    else { elSN.textContent = '—'; elSM.textContent = 'Santos, Navegantes, Itapoá...'; }

    // 3. MELHOR NORDESTE (uses ALL filtered data, not just base ports)
    const dataForNE = allPorAgente || bpPorAgente;
    const neAvg = calcRegionAvg(dataForNE, 'NORDESTE');
    const bestNE = Object.entries(neAvg).sort((a, b) => a[1].avg - b[1].avg)[0];
    const elNN = document.getElementById('rank-best-nordeste-name');
    const elNM = document.getElementById('rank-best-nordeste-meta');
    if (bestNE) { elNN.textContent = bestNE[0]; elNM.textContent = `USD ${bestNE[1].avg.toFixed(0)} · ${bestNE[1].count} rotas`; }
    else { elNN.textContent = '—'; elNM.textContent = 'Suape, Pecém, Salvador...'; }

    // 4. MELHOR POR ORIGEM
    const elByOrigin = document.getElementById('rank-best-by-origin');
    let originHtml = '';
    MAIN_ORIGINS.forEach(origin => {
        const oAvg = calcOriginAvg(bpPorAgente, origin);
        const best = Object.entries(oAvg).sort((a, b) => a[1].avg - b[1].avg)[0];
        const label = origin.charAt(0) + origin.slice(1).toLowerCase();
        originHtml += `<div class="origin-mini-row">
            <span class="origin-label">${label}</span>
            <span class="origin-winner">${best ? best[0] : '—'} ${best ? '<span style="font-weight:500;font-size:11px;color:var(--text-muted);">USD ' + best[1].avg.toFixed(0) + '</span>' : ''}</span>
        </div>`;
    });
    elByOrigin.innerHTML = originHtml;

    // 5. ROTA MAIS DISPUTADA
    const melhores = window.melhorPorRotaSemArmador ? window.melhorPorRotaSemArmador(bpPorAgente) : {};
    let mostContested = { key: null, count: 0, spread: 0 };
    for (const [k, info] of Object.entries(melhores)) {
        const cnt = info.ranking ? info.ranking.length : 0;
        if (cnt > mostContested.count || (cnt === mostContested.count && info.economia > mostContested.spread)) {
            mostContested = { key: k, count: cnt, spread: info.economia };
        }
    }
    const elCR = document.getElementById('rank-most-contested-route');
    const elCM = document.getElementById('rank-most-contested-meta');
    if (mostContested.key) {
        const p = mostContested.key.split('|');
        elCR.textContent = `${p[0]} → ${p[1]}`;
        elCM.innerHTML = `${mostContested.count} agentes · Spread: <strong>USD ${mostContested.spread.toFixed(0)}</strong>`;
    } else { elCR.textContent = '—'; elCM.textContent = '—'; }

    // 6. MAIOR ECONOMIA
    let maxSav = { key: null, economia: 0, vencedor: '' };
    for (const [k, info] of Object.entries(melhores)) {
        if (info.economia > maxSav.economia) maxSav = { key: k, economia: info.economia, vencedor: info.vencedor };
    }
    const elSR = document.getElementById('rank-max-saving-route');
    const elSMeta = document.getElementById('rank-max-saving-meta');
    if (maxSav.key) {
        const p = maxSav.key.split('|');
        elSR.textContent = `${p[0]} → ${p[1]}`;
        elSMeta.innerHTML = `Economia: <strong style="color:#16a34a;">USD ${maxSav.economia.toFixed(0)}</strong> · Vencedor: ${maxSav.vencedor}`;
    } else { elSR.textContent = '—'; elSMeta.textContent = '—'; }
}

function calcRegionAvg(porAgente, region) {
    const result = {};
    for (const [ag, rows] of Object.entries(porAgente)) {
        const rr = rows.filter(r => getRegion(r.destino) === region && r.frete != null && !isNaN(r.frete));
        if (rr.length > 0) result[ag] = { avg: rr.reduce((s, r) => s + Number(r.frete), 0) / rr.length, count: rr.length };
    }
    return result;
}

function calcOriginAvg(porAgente, mainOrigin) {
    const result = {};
    for (const [ag, rows] of Object.entries(porAgente)) {
        const or = rows.filter(r => matchesOrigin(r.origem, mainOrigin) && r.frete != null && !isNaN(r.frete));
        if (or.length > 0) result[ag] = { avg: or.reduce((s, r) => s + Number(r.frete), 0) / or.length, count: or.length };
    }
    return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// SEÇÃO 2A: BASE PORTS COMPARISON (dedicated section)
// ═══════════════════════════════════════════════════════════════════════════

function renderBasePortsComparison(bpPorAgente, agentsList) {
    const theadRow = document.getElementById('agent-bp-thead-row');
    const tbody = document.getElementById('agent-bp-tbody');
    if (!theadRow || !tbody) return;

    if (agentsList.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center" style="padding:30px;color:var(--text-muted);">Nenhum dado de base port encontrado.</td></tr>';
        return;
    }

    // Build thead
    let hdr = '<th>Origem</th><th>Destino</th><th>Container</th><th>Vencedor</th><th class="text-right">Melhor</th><th class="text-right">Economia</th>';
    agentsList.forEach(ag => {
        const fretes = (bpPorAgente[ag] || []).filter(r => r.frete != null).map(r => Number(r.frete));
        const avg = fretes.length > 0 ? (fretes.reduce((a, b) => a + b, 0) / fretes.length).toFixed(0) : '—';
        hdr += `<th class="text-right"><div class="agent-col-header"><span class="agent-col-header-name">${ag}</span><span class="agent-col-header-avg">Ø USD ${avg}</span></div></th>`;
    });
    hdr += '<th style="min-width:180px;">Observação</th>';
    theadRow.innerHTML = hdr;

    // Build comparison
    const melhores = window.melhorPorRotaSemArmador ? window.melhorPorRotaSemArmador(bpPorAgente) : {};
    const routes = [];
    for (const [key, info] of Object.entries(melhores)) {
        const parts = key.split('|');
        if (parts.length < 3) continue;
        routes.push({ origem: parts[0], destino: parts[1], container: parts[2], key, info });
    }
    routes.sort((a, b) => a.origem.localeCompare(b.origem) || a.destino.localeCompare(b.destino) || a.container.localeCompare(b.container));

    let html = '';
    let lastOrigem = '';
    routes.forEach(r => {
        const curOrigem = r.origem.toUpperCase();
        if (curOrigem !== lastOrigem) {
            html += `<tr class="agent-comp-origin-header"><td colspan="${7 + agentsList.length}"><i data-lucide="navigation"></i> ${r.origem}</td></tr>`;
            lastOrigem = curOrigem;
        }
        const info = r.info;
        const highSav = info.economia > 200;
        html += `<tr class="${highSav ? 'agent-comp-high-saving' : ''}">
            <td>${r.origem}</td><td>${r.destino}</td><td><code style="font-size:11px;">${r.container}</code></td>
            <td><span style="font-weight:600;color:var(--primary,#004b87);">${info.vencedor}</span><br><span style="font-size:10px;color:var(--text-muted);">${info.armadorVencedor || ''}</span></td>
            <td class="text-right" style="font-weight:700;">USD ${info.melhorFrete}</td>
            <td class="text-right" style="font-weight:700;color:${info.economia > 0 ? '#16a34a' : 'var(--text-muted)'};">${info.economia > 0 ? 'USD ' + info.economia.toFixed(0) : '—'}</td>`;

        // Collect obs for this route
        const obsMap = {};
        const agentMap = info.porAgente || {};
        agentsList.forEach(ag => {
            const agInfo = agentMap[ag];
            if (agInfo) {
                const isWin = info.vencedor === ag;
                const cls = isWin ? 'class="text-right agent-comp-winner-cell"' : 'class="text-right"';
                const badge = isWin ? '<span class="agent-comp-winner-badge">VENCEDOR</span><br>' : '';
                const arm = `<span style="font-size:10px;color:var(--text-muted);display:block;">${agInfo.armador}</span>`;
                html += `<td ${cls}>${badge}USD ${agInfo.frete}${arm}</td>`;
                // Find obs from raw data
                const rawRows = (bpPorAgente[ag] || []).filter(row => {
                    const rk = `${row.origem}|${row.destino}|${row.container}`.toUpperCase();
                    return rk === r.key && Number(row.frete) === agInfo.frete;
                });
                if (rawRows.length > 0 && rawRows[0].observacao) {
                    obsMap[ag] = rawRows[0].observacao;
                }
            } else {
                html += '<td class="text-right" style="color:var(--text-muted);">-</td>';
            }
        });

        // Obs column: show all unique obs with agent prefix
        const obsEntries = Object.entries(obsMap);
        let obsHtml = '';
        if (obsEntries.length > 0) {
            obsHtml = obsEntries.map(([ag, obs]) => {
                const short = obs.length > 60 ? obs.substring(0, 57) + '...' : obs;
                return `<span title="${ag}: ${obs.replace(/"/g, '&quot;')}" style="display:block;font-size:11px;line-height:1.3;margin-bottom:2px;"><strong>${ag}:</strong> ${short}</span>`;
            }).join('');
        }
        html += `<td style="font-size:11px;max-width:220px;white-space:normal;">${obsHtml || '<span style="color:var(--text-muted);">—</span>'}</td>`;
        html += '</tr>';
    });

    if (routes.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${7 + agentsList.length}" class="text-center" style="padding:30px;color:var(--text-muted);">Nenhuma rota base port encontrada.</td></tr>`;
    } else {
        tbody.innerHTML = html;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SEÇÃO 2B: COMPARATIVO COMPLETO (todas rotas, com filtros)
// ═══════════════════════════════════════════════════════════════════════════

function renderFullComparison(porAgenteOverride, agentsListOverride, containerFilterOverride) {
    const tbody = document.getElementById('agent-comp-tbody');
    const theadRow = document.getElementById('agent-comp-thead-row');
    if (!tbody || !theadRow) return;

    let porAgente = porAgenteOverride;
    let agentsList = agentsListOverride;
    let containerFilterVal = containerFilterOverride;

    if (!porAgente) {
        const grouped = getGroupedAgentSnapshots();
        porAgente = {};
        agentsList = [];
        for (const agent in grouped) {
            if (grouped[agent].length > 0) {
                agentsList.push(agent);
                porAgente[agent] = getSnapshotDataSmart(grouped[agent][0]);
            }
        }
        agentsList.sort();
        const containerFilterVal = (document.getElementById('agent-dash-container-filter')?.value || '').toUpperCase();
        const obsFilter = document.getElementById('agent-dash-obs-filter')?.value || 'all';
        
        const filtered = {};
        for (const [ag, rows] of Object.entries(porAgente)) {
            let f = rows;
            if (containerFilterVal) f = f.filter(r => (r.container || '').toUpperCase() === containerFilterVal);
            f = filterRowsByObs(f, obsFilter, 'all');
            if (f.length > 0) filtered[ag] = f;
        }
        porAgente = filtered;
        agentsList = Object.keys(porAgente).sort();
    }

    const filteredAgents = Object.keys(porAgente).sort();
    if (filteredAgents.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center" style="padding:40px;color:var(--text-muted);">Nenhum dado disponível.</td></tr>';
        return;
    }

    // Build thead
    let hdr = '<th style="min-width:90px;">Origem</th><th style="min-width:90px;">Destino</th><th>Container</th><th>Vencedor</th><th class="text-right">Melhor</th><th class="text-right">Economia</th>';
    filteredAgents.forEach(ag => {
        const fretes = (porAgente[ag] || []).filter(r => r.frete != null).map(r => Number(r.frete));
        const avg = fretes.length > 0 ? (fretes.reduce((a, b) => a + b, 0) / fretes.length).toFixed(0) : '—';
        hdr += `<th class="text-right"><div class="agent-col-header"><span class="agent-col-header-name">${ag}</span><span class="agent-col-header-avg">Ø USD ${avg}</span></div></th>`;
    });
    hdr += '<th style="min-width:180px;">Observação</th>';
    theadRow.innerHTML = hdr;

    // Build route comparison
    const melhores = window.melhorPorRotaSemArmador ? window.melhorPorRotaSemArmador(porAgente) : {};
    const allRoutes = [];
    for (const [key, info] of Object.entries(melhores)) {
        const parts = key.split('|');
        if (parts.length < 3) continue;
        allRoutes.push({ origem: parts[0], destino: parts[1], container: parts[2], key, info });
    }

    // Text filters
    const filterOrigem = (document.getElementById('agent-comp-filter-origem')?.value || '').trim().toLowerCase();
    const filterDestino = (document.getElementById('agent-comp-filter-destino')?.value || '').trim().toLowerCase();

    allRoutes.sort((a, b) => a.origem.localeCompare(b.origem) || a.destino.localeCompare(b.destino) || a.container.localeCompare(b.container));

    let html = '';
    let lastOrigem = '';
    let rowCount = 0;

    allRoutes.forEach(r => {
        if (filterOrigem && !r.origem.toLowerCase().includes(filterOrigem)) return;
        if (filterDestino && !r.destino.toLowerCase().includes(filterDestino)) return;

        const curOrigem = r.origem.toUpperCase();
        if (curOrigem !== lastOrigem) {
            html += `<tr class="agent-comp-origin-header"><td colspan="${7 + filteredAgents.length}"><i data-lucide="navigation"></i> ${r.origem}</td></tr>`;
            lastOrigem = curOrigem;
        }

        const info = r.info;
        const highSav = info.economia > 200;
        html += `<tr class="${highSav ? 'agent-comp-high-saving' : ''}">
            <td>${r.origem}</td><td>${r.destino}</td><td><code style="font-size:11px;">${r.container}</code></td>
            <td><span style="font-weight:600;color:var(--primary,#004b87);">${info.vencedor}</span><br><span style="font-size:10px;color:var(--text-muted);">${info.armadorVencedor || ''}</span></td>
            <td class="text-right" style="font-weight:700;">USD ${info.melhorFrete}</td>
            <td class="text-right" style="font-weight:700;color:${info.economia > 0 ? '#16a34a' : 'var(--text-muted)'};">${info.economia > 0 ? 'USD ' + info.economia.toFixed(0) : '—'}</td>`;

        const obsMap = {};
        const agentMap = info.porAgente || {};
        filteredAgents.forEach(ag => {
            const agInfo = agentMap[ag];
            if (agInfo) {
                const isWin = info.vencedor === ag;
                const cls = isWin ? 'class="text-right agent-comp-winner-cell"' : 'class="text-right"';
                const badge = isWin ? '<span class="agent-comp-winner-badge">VENCEDOR</span><br>' : '';
                const arm = `<span style="font-size:10px;color:var(--text-muted);display:block;">${agInfo.armador}</span>`;
                html += `<td ${cls}>${badge}USD ${agInfo.frete}${arm}</td>`;
                // Find obs
                const rawRows = (porAgente[ag] || []).filter(row => {
                    const rk = `${row.origem}|${row.destino}|${row.container}`.toUpperCase();
                    return rk === r.key && Number(row.frete) === agInfo.frete;
                });
                if (rawRows.length > 0 && rawRows[0].observacao) obsMap[ag] = rawRows[0].observacao;
            } else {
                html += '<td class="text-right" style="color:var(--text-muted);">-</td>';
            }
        });

        // Obs column
        const obsEntries = Object.entries(obsMap);
        let obsHtml = '';
        if (obsEntries.length > 0) {
            obsHtml = obsEntries.map(([ag, obs]) => {
                const short = obs.length > 60 ? obs.substring(0, 57) + '...' : obs;
                return `<span title="${ag}: ${obs.replace(/"/g, '&quot;')}" style="display:block;font-size:11px;line-height:1.3;margin-bottom:2px;"><strong>${ag}:</strong> ${short}</span>`;
            }).join('');
        }
        html += `<td style="font-size:11px;max-width:220px;white-space:normal;">${obsHtml || '<span style="color:var(--text-muted);">—</span>'}</td>`;
        html += '</tr>';
        rowCount++;
    });

    if (rowCount === 0) {
        tbody.innerHTML = `<tr><td colspan="${7 + filteredAgents.length}" class="text-center" style="padding:30px;color:var(--text-muted);">Nenhuma rota encontrada.</td></tr>`;
    } else {
        tbody.innerHTML = html;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SEÇÃO 3: LEADERBOARD (base ports focused)
// ═══════════════════════════════════════════════════════════════════════════

function renderLeaderboard(bpPorAgente, grouped) {
    const tbody = document.getElementById('agent-leaderboard-tbody');
    if (!tbody) return;

    const agentsList = Object.keys(bpPorAgente);
    if (agentsList.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center" style="padding:30px;color:var(--text-muted);">Sem dados base port.</td></tr>';
        return;
    }

    const melhores = window.melhorPorRotaSemArmador ? window.melhorPorRotaSemArmador(bpPorAgente) : {};
    const totalRoutes = Object.keys(melhores).length;

    const stats = [];
    agentsList.forEach(ag => {
        const rows = bpPorAgente[ag] || [];
        const fretes = rows.filter(r => r.frete != null && !isNaN(r.frete)).map(r => Number(r.frete));
        const avgFrete = fretes.length > 0 ? fretes.reduce((a, b) => a + b, 0) / fretes.length : Infinity;
        const uniqueRoutes = new Set();
        const uniqueArmadores = new Set();
        let victories = 0;
        rows.forEach(r => {
            uniqueRoutes.add(`${r.origem}|${r.destino}|${r.container}`.toUpperCase());
            if (r.armador) uniqueArmadores.add(r.armador.toUpperCase());
        });
        for (const [k, info] of Object.entries(melhores)) { if (info.vencedor === ag) victories++; }
        const victoryPct = totalRoutes > 0 ? (victories / totalRoutes) * 100 : 0;
        stats.push({ agente: ag, avgFrete: avgFrete === Infinity ? null : avgFrete, victoryPct, rotas: uniqueRoutes.size, armadores: uniqueArmadores.size });
    });

    stats.sort((a, b) => {
        if (a.avgFrete === null) return 1;
        if (b.avgFrete === null) return -1;
        return a.avgFrete - b.avgFrete;
    });

    const validFretes = stats.filter(s => s.avgFrete !== null).map(s => s.avgFrete);
    const minF = Math.min(...validFretes);
    const maxF = Math.max(...validFretes);

    let html = '';
    stats.forEach((s, idx) => {
        const pos = idx + 1;
        let posClass = 'agent-lb-pos-other';
        let posText = pos;
        if (pos === 1) { posClass = 'agent-lb-pos-1'; posText = '🏆'; }
        else if (pos === 2) posClass = 'agent-lb-pos-2';
        else if (pos === 3) posClass = 'agent-lb-pos-3';

        const avgText = s.avgFrete !== null ? `USD ${s.avgFrete.toFixed(0)}` : '—';
        let barPct = 0, barClass = 'agent-lb-bar-fill--mid';
        if (s.avgFrete !== null && maxF > minF) {
            barPct = 100 - ((s.avgFrete - minF) / (maxF - minF)) * 80;
            if (pos === 1) barClass = 'agent-lb-bar-fill--best';
            else if (pos >= stats.length - 1) barClass = 'agent-lb-bar-fill--worst';
        } else if (s.avgFrete !== null) { barPct = 100; barClass = 'agent-lb-bar-fill--best'; }

        html += `<tr>
            <td class="text-center"><span class="agent-lb-pos ${posClass}">${posText}</span></td>
            <td style="font-weight:700;font-size:14px;">${s.agente}</td>
            <td><div class="agent-lb-freight-bar"><span class="agent-lb-freight-value">${avgText}</span><div class="agent-lb-bar-track"><div class="agent-lb-bar-fill ${barClass}" style="width:${barPct.toFixed(0)}%;"></div></div></div></td>
            <td class="text-center" style="font-weight:600;">${s.victoryPct.toFixed(1)}%</td>
            <td class="text-center">${s.rotas}</td>
            <td class="text-center">${s.armadores}</td>
        </tr>`;
    });
    tbody.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
// TIMELINE
// ═══════════════════════════════════════════════════════════════════════════

function renderTimeline(grouped) {
    const historyLog = document.getElementById('agent-dash-history-log');
    if (!historyLog) return;
    const allDates = new Set();
    for (const agent in grouped) { grouped[agent].forEach(h => allDates.add(h.date)); }
    const sortedDates = Array.from(allDates).sort((a, b) => b.localeCompare(a));
    let html = '';
    sortedDates.forEach(date => {
        const dayAgents = [];
        for (const agent in grouped) { if (grouped[agent].some(h => h.date === date)) dayAgents.push(agent); }
        if (dayAgents.length > 0) {
            html += `<div class="agent-timeline-item">
                <div class="agent-timeline-date">${formatDateBR(date)}</div>
                <div class="agent-timeline-content">Tarifários atualizados para: ${dayAgents.map(a => `<strong>${a}</strong>`).join(', ')}.</div>
            </div>`;
        }
    });
    historyLog.innerHTML = html || '<p style="color:var(--text-muted);text-align:center;padding:20px;">Nenhum histórico registrado.</p>';
}

function formatDateBR(iso) {
    if (!iso) return '';
    const parts = iso.split('-');
    if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
    return iso;
}

document.addEventListener('DOMContentLoaded', () => { initDashboard(); });
