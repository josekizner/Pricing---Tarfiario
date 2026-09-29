/* ==========================================================================
   APPLICATION LOGIC - MOND SHIPPING RATES DASHBOARD
   ========================================================================== */
console.warn('%c[MOND v1260] Código novo carregado com IndexedDB storage!', 'background: #ff0000; color: white; font-size: 16px; padding: 4px 8px;');

// ==========================================================================
// IndexedDB Storage Helper — replaces localStorage for large datasets
// ==========================================================================
const mondStorage = (() => {
    const DB_NAME = 'MondShippingDB';
    const STORE_NAME = 'appData';
    const DB_VERSION = 1;
    // Keys that should use IndexedDB instead of localStorage (large data)
    const BIG_KEYS = ['mond-rates', 'mond-space', 'mond-operational', 'mond-commercial'];

    function openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function setItem(key, value) {
        // For small keys, still use localStorage
        if (!BIG_KEYS.includes(key)) {
            try { localStorage.setItem(key, value); } catch(e) { console.warn('[Storage] localStorage setItem failed for', key, e.message); }
            return;
        }
        try {
            const db = await openDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                tx.objectStore(STORE_NAME).put(value, key);
                tx.oncomplete = () => { resolve(); };
                tx.onerror = () => { reject(tx.error); };
            });
        } catch (e) {
            console.warn('[IndexedDB] setItem failed for', key, e.message);
        }
    }

    async function getItem(key) {
        // For small keys, still use localStorage
        if (!BIG_KEYS.includes(key)) {
            return localStorage.getItem(key);
        }
        try {
            const db = await openDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const req = tx.objectStore(STORE_NAME).get(key);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => reject(req.error);
            });
        } catch (e) {
            console.warn('[IndexedDB] getItem failed for', key, e.message);
            // Fallback to localStorage
            return localStorage.getItem(key);
        }
    }

    async function removeItem(key) {
        if (!BIG_KEYS.includes(key)) {
            localStorage.removeItem(key);
            return;
        }
        try {
            const db = await openDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                tx.objectStore(STORE_NAME).delete(key);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            console.warn('[IndexedDB] removeItem failed for', key, e.message);
        }
    }

    // Synchronous setter with fire-and-forget async write (for drop-in replacement)
    function setItemSync(key, value) {
        if (!BIG_KEYS.includes(key)) {
            try { localStorage.setItem(key, value); } catch(e) { console.warn('[Storage] quota exceeded for', key); }
            return;
        }
        // Fire and forget — write to IndexedDB in background
        setItem(key, value).catch(e => console.warn('[IndexedDB] bg write failed:', e.message));
    }

    return { setItem, getItem, removeItem, setItemSync, BIG_KEYS };
})();

// Safe fallback for Lucide icons in case CDN is offline or blocked
if (typeof window.lucide === 'undefined') {
    window.lucide = {
        createIcons: function() { console.warn('Lucide icons library not loaded.'); }
    };
}

// Initial Mock Data to populate on first load if localStorage is empty
const MOCK_RATES = [];

// --- Central Shared Cloud Database (JSONBlob) for Team Tariff Sharing ---
const SHARED_CLOUD_DB_URL = 'https://jsonblob.com/api/jsonBlob/019fd3fd-5fac-7287-ab31-b03f92f13595';

async function pushSharedCustomData() {
    try {
        const payload = {
            rates: Array.isArray(appRates) ? appRates : [],
            space: Array.isArray(appSpace) ? appSpace : [],
            updatedAt: new Date().toISOString()
        };
        await fetch(SHARED_CLOUD_DB_URL, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        console.log('[Cloud DB] Tarifários compartilhados salvos na nuvem para toda a equipe!');
    } catch (err) {
        console.warn('[Cloud DB] Erro ao salvar tarifários na nuvem:', err);
    }
}

async function loadSharedCustomData() {
    try {
        const res = await fetch(SHARED_CLOUD_DB_URL, { method: 'GET' });
        if (res.ok) {
            const data = await res.json();
            let updated = false;
            if (data && Array.isArray(data.rates) && data.rates.length > 0) {
                appRates = data.rates.map(r => ({ ...r, source: 'rate' }));
                mondStorage.setItemSync('mond-rates', JSON.stringify(appRates));
                updated = true;
            }
            if (data && Array.isArray(data.space) && data.space.length > 0) {
                appSpace = data.space.map(s => ({ ...s, source: 'space' }));
                mondStorage.setItemSync('mond-space', JSON.stringify(appSpace));
                updated = true;
            }
            if (updated) {
                applyFilters();
                updateDashboardCards();
                console.log(`[Cloud DB] Dados compartilhados recarregados: ${appRates.length} tarifas, ${appSpace.length} spaces.`);
            }
        }
    } catch (err) {
        console.warn('[Cloud DB] Erro ao carregar dados compartilhados da nuvem:', err);
    }
}

/**
 * Robust numeric parser that handles both Brazilian (7.200,50) and English (7,200.50) formats.
 * Detects whether dots/commas are thousand separators or decimal separators.
 * Examples: "7.200" → 7200, "7.200,50" → 7200.5, "7,200.50" → 7200.5, "6500" → 6500
 */
function parseBrNumber(raw) {
    if (raw == null) return 0;
    if (typeof raw === 'number') return isNaN(raw) ? 0 : raw;
    let s = String(raw).trim().replace(/[^0-9.,-]/g, '');
    if (!s) return 0;
    // Remove leading/trailing separators
    s = s.replace(/^[.,]+|[.,]+$/g, '');
    if (!s) return 0;
    const dots = (s.match(/\./g) || []).length;
    const commas = (s.match(/,/g) || []).length;
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    // Pure integer (no dots or commas)
    if (dots === 0 && commas === 0) return parseFloat(s) || 0;
    // Brazilian: "7.200" or "7.200.000" (dot as thousands, no decimal)
    if (dots >= 1 && commas === 0) {
        const parts = s.split('.');
        // If first part has more than 3 digits (e.g. 2367.856), dot is decimal
        if (parts[0].length > 3) {
            return parseFloat(s) || 0;
        }
        const allThousands = parts.slice(1).every(p => p.length === 3);
        if (allThousands && parts.length > 1) {
            const thousandsVal = parseFloat(s.replace(/\./g, '')) || 0;
            // Freight sanity check: single freight is not > 50.000 unless multi-dot
            if (parts.length === 2 && thousandsVal > 50000 && parseFloat(s) >= 10) {
                return parseFloat(s) || 0;
            }
            return thousandsVal;
        }
        // Otherwise dot is decimal: "7.5" → 7.5
        return parseFloat(s) || 0;
    }
    // Brazilian decimal: "7.200,50" or "1.234.567,89"
    if (commas === 1 && lastComma > lastDot) {
        return parseFloat(s.replace(/\./g, '').replace(',', '.')) || 0;
    }
    // English decimal: "7,200.50"
    if (dots === 1 && lastDot > lastComma) {
        return parseFloat(s.replace(/,/g, '')) || 0;
    }
    // Multiple commas, no dots: "1,234,567" → thousands
    if (commas >= 1 && dots === 0) {
        const parts = s.split(',');
        const allThousands = parts.slice(1).every(p => p.length === 3);
        if (allThousands) return parseFloat(s.replace(/,/g, '')) || 0;
        // Single comma with non-3-digit part → decimal: "6,5" → 6.5
        if (commas === 1) return parseFloat(s.replace(',', '.')) || 0;
    }
    // Fallback: remove commas, parse
    return parseFloat(s.replace(/,/g, '')) || 0;
}

const MOCK_SPACE = [];

const MOCK_OPERATIONAL = [];

// App State
let appRates = [];
Object.defineProperty(window, 'appRates', { get: () => appRates, set: (v) => { appRates = v; }, configurable: true });
let appSpace = [];
Object.defineProperty(window, 'appSpace', { get: () => appSpace, set: (v) => { appSpace = v; }, configurable: true });
let appOperational = [];
Object.defineProperty(window, 'appOperational', { get: () => appOperational, set: (v) => { appOperational = v; }, configurable: true });
let appComercial = [];
Object.defineProperty(window, 'appComercial', { get: () => appComercial, set: (v) => { appComercial = v; }, configurable: true });
let activeDb = "apiAll";
let filteredRates = [];
let currentPage = 1;
let rowsPerPage = 25;
let currentSortField = "valor";
let currentSortDirection = "asc";
const colFilters = { origem: "", destino: "", container: "", armador: "", agente: "", freetime: "", obs: "" };
let analysisSortOrder = 'desc';
let analysisGroupBy = 'rota'; // 'rota', 'agente', 'cliente'
let analysisSource = 'operational'; // 'operational', 'commercial'
let analysisBookingFilter = 'all'; // 'all', 'com', 'sem'
// Global selected route pairs (from Top Rotas dashboard list)
window.activeRoutePairs = new Set();
let rankingSortBy = { clientes: 'cntrs', rotas: 'cntrs', agentes: 'cntrs', armadores: 'cntrs' };
let _fallbackApplied = false;

/**
 * FALLBACK: Quando dados operacionais estão desatualizados (>30 dias),
 * complementa com dados da massa comercial recente.
 * Roda após cada sync (operacional ou comercial) — só aplica uma vez.
 */
function runOperationalFallback() {
    if (_fallbackApplied) return;
    if (appOperational.length === 0 || appComercial.length === 0) return;
    
    const opDates = appOperational.map(r => r.inicio).filter(d => d).sort().reverse();
    const latestOpDate = opDates[0] || '1900-01-01';
    const daysSinceLatest = Math.floor((new Date() - new Date(latestOpDate + 'T00:00:00')) / (1000*60*60*24));
    
    if (daysSinceLatest <= 30) return;
    
    console.log(`[FALLBACK] Dados operacionais desatualizados (${daysSinceLatest} dias). Complementando com massa comercial...`);
    
    const comercialFallback = appComercial
        .filter(c => {
            if (!c.inicio || c.inicio <= latestOpDate) return false;
            const analise = (c.analise || '').toLowerCase();
            return analise === 'aprovado';
        })
        .map(c => ({
            ...c,
            source: 'operational',
            _fromCommercialFallback: true,
            processo: c.processo ? `OFT-${c.processo}` : 'N/A',
        }));
    
    if (comercialFallback.length > 0) {
        appOperational = [...appOperational, ...comercialFallback];
        _fallbackApplied = true;
        mondStorage.setItemSync('mond-operational', JSON.stringify(appOperational));
        initFilterDropdowns();
        updateDashboardCards();
        applyFilters();
        console.log(`[FALLBACK] +${comercialFallback.length} registros comerciais adicionados ao operacional`);
        showToast(`⚠️ Dados operacionais desatualizados (último: ${latestOpDate}). ${comercialFallback.length} ofertas comerciais adicionadas como fallback.`, 'warning', 8000);
    }
}

/**
 * PERFORMANCE TIMELINE: Mostra gráfico de linhas com frete médio + volume
 * por mês para um fornecedor/agente/cliente/armador.
 */
let _timelineChart = null;
function showPerformanceTimeline(entityName, filterField) {
    // Select data source based on current active tab
    let sourceData = appOperational;
    if (activeDb === 'commercial') {
        sourceData = appComercial;
    } else if (activeDb === 'apiAll') {
        sourceData = [...appOperational, ...appComercial];
    } else if (activeDb === 'rate') {
        sourceData = appRates;
    } else if (activeDb === 'space') {
        sourceData = appSpace;
    } else if (activeDb === 'all') {
        sourceData = [...appRates, ...appSpace];
    }

    const seen = new Set();
    const entityData = sourceData.filter(r => {
        const val = (r[filterField] || r.armador || r.agente || r.cliente || '').trim().toUpperCase();
        if (val !== entityName.trim().toUpperCase()) return false;
        // Deduplicate
        const key = (r.processo && r.processo !== 'N/A') ? r.processo : (r.id || `${r.origem}-${r.destino}-${r.inicio}-${r.valor}`);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    
    if (entityData.length === 0) return;
    
    // Group by month
    const monthMap = {};
    entityData.forEach(r => {
        const dt = r.inicio || r.fim || r.validade || '';
        if (!dt || dt.length < 7) return;
        const month = dt.substring(0, 7); // YYYY-MM
        if (!monthMap[month]) monthMap[month] = { totalFrete: 0, count: 0, cntrs: 0 };
        const val = r.valor || 0;
        if (val > 0) {
            monthMap[month].totalFrete += val;
            monthMap[month].count++;
        }
        // Use proper container quantity
        const cInfo = typeof getContainerInfo === 'function' ? getContainerInfo(r) : { qty: 1 };
        monthMap[month].cntrs += cInfo.qty;
    });
    
    const months = Object.keys(monthMap).sort();
    if (months.length === 0) return;
    
    const labels = months.map(m => {
        const [y, mo] = m.split('-');
        const moNames = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
        const moNum = String(parseInt(mo)).padStart(2, '0');
        return `${moNum} - ${moNames[parseInt(mo)-1]}/${y.slice(2)}`;
    });
    const avgFretes = months.map(m => monthMap[m].count > 0 ? Math.round(monthMap[m].totalFrete / monthMap[m].count) : 0);
    const volumes = months.map(m => monthMap[m].cntrs);
    
    // Show inline chart container
    const inlineDiv = document.getElementById('performance-timeline-inline');
    if (!inlineDiv) return;
    
    // Styles already injected at load time
    
    document.getElementById('perf-timeline-title-inline').textContent = `📊 Performance: ${entityName}`;
    inlineDiv.style.display = 'block';
    inlineDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
    
    // Destroy old chart
    if (_timelineChart) { _timelineChart.destroy(); _timelineChart = null; }
    
    const ctx = document.getElementById('perf-timeline-canvas-inline').getContext('2d');
    _timelineChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Frete Médio (USD)',
                    data: avgFretes,
                    borderColor: '#4f8cff',
                    backgroundColor: 'rgba(79,140,255,0.1)',
                    borderWidth: 2.5,
                    tension: 0.3,
                    fill: true,
                    yAxisID: 'y',
                    pointRadius: 4,
                    pointBackgroundColor: '#4f8cff',
                },
                {
                    label: 'Containers',
                    data: volumes,
                    borderColor: '#34d399',
                    backgroundColor: 'rgba(52,211,153,0.1)',
                    borderWidth: 2.5,
                    tension: 0.3,
                    fill: true,
                    yAxisID: 'y1',
                    pointRadius: 4,
                    pointBackgroundColor: '#34d399',
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { labels: { color: '#a0a3ab', font: { size: 12 } } },
                tooltip: {
                    backgroundColor: 'rgba(20,22,28,0.95)',
                    titleColor: '#e4e6eb',
                    bodyColor: '#a0a3ab',
                    borderColor: '#2a2d35',
                    borderWidth: 1,
                    callbacks: {
                        label: function(ctx) {
                            if (ctx.datasetIndex === 0) return ` Frete Médio: USD ${ctx.parsed.y.toLocaleString('pt-BR')}`;
                            return ` Containers: ${ctx.parsed.y}`;
                        }
                    }
                }
            },
            scales: {
                x: { ticks: { color: '#6b6e78', font: { size: 11 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: {
                    type: 'linear', position: 'left',
                    title: { display: true, text: 'Frete Médio (USD)', color: '#4f8cff', font: { size: 11 } },
                    ticks: { color: '#4f8cff', font: { size: 11 }, callback: v => 'USD ' + v.toLocaleString('pt-BR') },
                    grid: { color: 'rgba(79,140,255,0.08)' }
                },
                y1: {
                    type: 'linear', position: 'right',
                    title: { display: true, text: 'Containers', color: '#34d399', font: { size: 11 } },
                    ticks: { color: '#34d399', font: { size: 11 } },
                    grid: { drawOnChartArea: false }
                }
            }
        }
    });
}

// Natural Language Processing State
let activeNlpFilters = {
    origem: null,
    destino: null,
    container: null,
    armador: null
};

// DOM Elements
const bodyEl = document.documentElement;
const btnThemeToggle = document.getElementById('btn-theme-toggle');
const btnToggleUpload = document.getElementById('btn-toggle-upload');
const btnCloseUpload = document.getElementById('btn-close-upload');
const uploadSection = document.getElementById('upload-section');
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const uploadStatus = document.getElementById('upload-status');
const statusMessage = document.getElementById('status-message');

const nlpInput = document.getElementById('nlp-input');
const btnClearSearch = document.getElementById('btn-clear-search');
const nlpChipsContainer = document.getElementById('nlp-chips-container');
const nlpChips = document.getElementById('nlp-chips');

const selectOrigem = document.getElementById('filter-origem');
const selectDestino = document.getElementById('filter-destino');
const selectContainer = document.getElementById('filter-container');
const selectArmador = document.getElementById('filter-armador');
const selectValidade = document.getElementById('filter-validade');
const btnResetFilters = document.getElementById('btn-reset-filters');
const selectSortBy = document.getElementById('sort-by');

const resultsCount = document.getElementById('results-count');
const tableBody = document.getElementById('table-body');
const emptyState = document.getElementById('empty-state');
const paginationContainer = document.getElementById('pagination-container');
const paginationInfo = document.getElementById('pagination-info');
const pageNumbersContainer = document.getElementById('page-numbers');
const btnPrevPage = document.getElementById('btn-prev-page');
const btnNextPage = document.getElementById('btn-next-page');
const btnSyncApi = document.getElementById('btn-sync-api');
const apiLoadingOverlay = document.getElementById('api-loading-overlay');

// Cards Elements
const cheapestVal = document.getElementById('cheapest-val');
const cheapestRoute = document.getElementById('cheapest-route');
const freetimeVal = document.getElementById('freetime-val');
const freetimeRoute = document.getElementById('freetime-route');
const insightTitle = document.getElementById('insight-title');
const insightDesc = document.getElementById('insight-desc');
const summaryTotal = document.getElementById('summary-total');
const summaryValidity = document.getElementById('summary-validity');

// Modal Elements
const detailsModal = document.getElementById('details-modal');
const closeModal = document.getElementById('close-modal');
const btnCloseModalFooter = document.getElementById('btn-close-modal-footer');
const mOrigem = document.getElementById('m-origem');
const mDestino = document.getElementById('m-destino');
const mContainer = document.getElementById('m-container');
const mValor = document.getElementById('m-valor');
const mArmador = document.getElementById('m-armador');
const mAgente = document.getElementById('m-agente');
const mFreetime = document.getElementById('m-freetime');
const mValidade = document.getElementById('m-validade');
const mObservacao = document.getElementById('m-observacao');

// Carrier styling helper colors
const CARRIER_COLORS = {
    "CMA CGM": { bg: "rgba(16, 185, 129, 0.12)", color: "#10b981", border: "rgba(16, 185, 129, 0.3)" }, // Green
    "MSC": { bg: "rgba(245, 158, 11, 0.12)", color: "#f59e0b", border: "rgba(245, 158, 11, 0.3)" }, // Gold/Yellow
    "MAERSK": { bg: "rgba(59, 130, 246, 0.12)", color: "#3b82f6", border: "rgba(59, 130, 246, 0.3)" }, // Blue
    "COSCO": { bg: "rgba(139, 92, 246, 0.12)", color: "#8b5cf6", border: "rgba(139, 92, 246, 0.3)" }, // Purple
    "HAPAG-LLOYD": { bg: "rgba(239, 68, 68, 0.12)", color: "#ef4444", border: "rgba(239, 68, 68, 0.3)" }, // Red
    "ONE": { bg: "rgba(236, 72, 153, 0.12)", color: "#ec4899", border: "rgba(236, 72, 153, 0.3)" } // Magenta/Pink
};

/* ==========================================================================
   TOAST NOTIFICATIONS (Non-blocking)
   ========================================================================== */

let activeToastEl = null;
let activeToastTimer = null;

function showToast(message, type = 'info', duration = 4000) {
    hideToast();
    const toast = document.createElement('div');
    toast.className = `toast-notification toast-${type}`;
    toast.innerHTML = `<span>${message}</span>`;
    document.body.appendChild(toast);
    activeToastEl = toast;
    
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });
    
    if (duration > 0) {
        activeToastTimer = setTimeout(() => hideToast(), duration);
    }
}

function hideToast() {
    if (activeToastTimer) { clearTimeout(activeToastTimer); activeToastTimer = null; }
    if (activeToastEl) {
        activeToastEl.classList.remove('show');
        const el = activeToastEl;
        activeToastEl = null;
        setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
    }
}

/* ==========================================================================
   CSV EXPORT UTILITY
   ========================================================================== */

function exportToCSV(headers, rows, filename = 'export.csv') {
    const BOM = '\uFEFF'; // UTF-8 BOM for Excel
    const separator = ';';
    let csv = BOM;
    csv += headers.join(separator) + '\n';
    rows.forEach(row => {
        csv += row.map(cell => {
            const val = String(cell == null ? '' : cell).replace(/"/g, '""');
            return `"${val}"`;
        }).join(separator) + '\n';
    });
    
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    showToast(`✅ Arquivo "${filename}" exportado com sucesso!`, 'success', 3000);
}

// Export current search results (Painel de Consulta)
function exportSearchResults() {
    if (activeDb === "commercial") {
        exportCommercialData();
        return;
    }
    if (activeDb === "operational") {
        exportOperationalData();
        return;
    }
    const data = filteredRates || [];
    if (data.length === 0) {
        showToast('Nenhum dado para exportar.', 'error', 3000);
        return;
    }
    const headers = ['Origem', 'Destino', 'Container', 'Armador', 'Agente', 'Valor (USD)', 'Free Time', 'Validade', 'Observação', 'Fonte'];
    const rows = data.map(r => [
        r.origem, r.destino, r.container, r.armador, r.agente,
        r.valor, r.freetime, r.fim, r.observacao, 
        r.source === 'space' ? 'Space on Hands' : (r.source === 'operational' ? `Operacional (${r.processo})` : (r.source === 'commercial' ? `Comercial (${r.processo})` : 'Tarifário'))
    ]);
    exportToCSV(headers, rows, `tarifas_${new Date().toISOString().split('T')[0]}.csv`);
}

// Export operational processes (Massa Operacional)
function exportOperationalData() {
    if (!appOperational || appOperational.length === 0) {
        showToast('Nenhum dado operacional para exportar.', 'error', 3000);
        return;
    }
    const headers = ['Processo', 'Cliente', 'Armador', 'Agente', 'Origem', 'Destino', 'Containers', 'Abertura', 'Prontidão', 'Previsão Embarque', 'Previsão Atracação', 'Frete Total (USD)', 'Valor Un. (USD)', 'TEUs'];
    const rows = appOperational.map(p => [
        p.processo, p.cliente, p.armador, p.agente, p.origem, p.destino,
        p.container, p.inicio, p.prontidao, p.previsaoEmbarque, p.previsaoAtracacao,
        p.vlCompraFrete, p.valor ? p.valor.toFixed(2) : '0', p.vlTeus
    ]);
    exportToCSV(headers, rows, `massa_operacional_${new Date().toISOString().split('T')[0]}.csv`);
}

// Export commercial offers (Massa Comercial)
function exportCommercialData() {
    if (!appComercial || appComercial.length === 0) {
        showToast('Nenhum dado comercial para exportar.', 'error', 3000);
        return;
    }
    const headers = ['Oferta', 'Cliente', 'Fornecedor', 'Agente', 'Origem', 'Destino', 'Containers', 'Abertura', 'Validade', 'Compra Unit. (USD)', 'Venda Unit. (USD)', 'Total Compra (USD)', 'Total Venda (USD)', 'Status', 'Transit Time'];
    const rows = appComercial.map(p => [
        p.processo, p.cliente, p.armador, p.agente, p.origem, p.destino,
        p.container, p.inicio, p.fim, p.valor ? p.valor.toFixed(2) : '0', p.valorVenda ? p.valorVenda.toFixed(2) : '0',
        p.vlCompraFrete, p.vlVendaFrete, p.analise, p.transitTime
    ]);
    exportToCSV(headers, rows, `massa_comercial_${new Date().toISOString().split('T')[0]}.csv`);
}

// Export analysis/opportunities (Recompra de Fretes)  
function exportAnalysisData() {
    const groupedData = window.currentGroupedData;
    if (!groupedData || groupedData.length === 0) {
        showToast('Nenhuma oportunidade para exportar.', 'error', 3000);
        return;
    }
    const isComm = analysisSource === 'commercial';
    const headers = [
        isComm ? 'Oferta' : 'Processo',
        'Cliente',
        'Rota',
        'Container',
        'Data Abertura',
        'Status',
        'Qtd',
        'Armador Atual',
        'Agente Atual',
        isComm ? 'Compra Atual (USD)' : 'Frete Atual (USD)',
        'Armador Escolhido',
        'Agente Escolhido',
        'Frete Escolhido (USD)',
        'Economia Unitária (USD)',
        'Economia Total (USD)',
        'Observações do Frete Escolhido'
    ];
    
    const rows = [];
    groupedData.forEach((g, gIdx) => {
        const routeOptIdx = window.selectedBenchmarks[gIdx] !== undefined ? window.selectedBenchmarks[gIdx] : 0;
        const routeSelectedOpt = g.savingRates ? g.savingRates[routeOptIdx] : null;

        g.processes.forEach(p => {
            const currentFreight = p.valorUnitario || 0;
            
            let selectedOpt = null;
            if (analysisGroupBy === 'rota') {
                selectedOpt = routeSelectedOpt;
            } else if (analysisGroupBy === 'agente') {
                selectedOpt = p.targetRate;
            } else if (analysisGroupBy === 'cliente') {
                selectedOpt = p.bestOption;
            }
            
            if (!selectedOpt) return;
            
            const newFreight = selectedOpt.valor || 0;
            const diff = Math.max(0, currentFreight - newFreight);
            const qty = p.qty || 1;
            
            rows.push([
                p.processo,
                p.cliente || '',
                g.origem ? `${g.origem} → ${g.destino}` : (p.rota || ''),
                g.container || p.container || '',
                p.inicio || '',
                p.analise || '',
                qty,
                p.armador || '',
                p.agente || '',
                currentFreight ? currentFreight.toFixed(2) : '0.00',
                selectedOpt.armador || '',
                selectedOpt.agente || '',
                newFreight ? newFreight.toFixed(2) : '0.00',
                diff.toFixed(2),
                (diff * qty).toFixed(2),
                selectedOpt.observacao || ''
            ]);
        });
    });
    exportToCSV(headers, rows, `oportunidades_recompra_todas_${new Date().toISOString().split('T')[0]}.csv`);
}

window.exportSingleRouteData = function(gIdx) {
    const groupedData = window.currentGroupedData;
    const g = groupedData[gIdx];
    if (!g) return;
    
    const isComm = analysisSource === 'commercial';
    const headers = [
        isComm ? 'Oferta' : 'Processo',
        'Cliente',
        'Rota',
        'Container',
        'Data Abertura',
        'Status',
        'Qtd',
        'Armador Atual',
        'Agente Atual',
        isComm ? 'Compra Atual (USD)' : 'Frete Atual (USD)',
        'Armador Escolhido',
        'Agente Escolhido',
        'Frete Escolhido (USD)',
        'Economia Unitária (USD)',
        'Economia Total (USD)',
        'Observações do Frete Escolhido'
    ];
    
    const rows = [];
    
    const routeOptIdx = window.selectedBenchmarks[gIdx] !== undefined ? window.selectedBenchmarks[gIdx] : 0;
    const routeSelectedOpt = g.savingRates ? g.savingRates[routeOptIdx] : null;

    g.processes.forEach(p => {
        const currentFreight = p.valorUnitario || 0;
        
        let selectedOpt = null;
        if (analysisGroupBy === 'rota') {
            selectedOpt = routeSelectedOpt;
        } else if (analysisGroupBy === 'agente') {
            selectedOpt = p.targetRate;
        } else if (analysisGroupBy === 'cliente') {
            selectedOpt = p.bestOption;
        }
        
        if (!selectedOpt) return;
        
        const newFreight = selectedOpt.valor || 0;
        const diff = Math.max(0, currentFreight - newFreight);
        const qty = p.qty || 1;
        
        rows.push([
            p.processo,
            p.cliente || '',
            g.origem ? `${g.origem} → ${g.destino}` : (p.rota || ''),
            g.container || p.container || '',
            p.inicio || '',
            p.analise || '',
            qty,
            p.armador || '',
            p.agente || '',
            currentFreight ? currentFreight.toFixed(2) : '0.00',
            selectedOpt.armador || '',
            selectedOpt.agente || '',
            newFreight ? newFreight.toFixed(2) : '0.00',
            diff.toFixed(2),
            (diff * qty).toFixed(2),
            selectedOpt.observacao || ''
        ]);
    });
    
    const labelSanitized = String(g.label || g.origem || 'grupo').replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `recompra_${analysisGroupBy}_${labelSanitized}_${new Date().toISOString().split('T')[0]}.csv`;
    exportToCSV(headers, rows, filename);
};

/* ==========================================================================
   INITIALIZATION & THEME TOGGLE
   ========================================================================== */

// Sync timestamp helpers
function setSyncStatus(key, type, timestamp) {
    if (!timestamp) return;
    const item = {
        type: type,
        timestamp: new Date(timestamp).toISOString()
    };
    localStorage.setItem(`mond-sync-status-${key}`, JSON.stringify(item));
    renderSyncStatus(key);
}

function renderSyncStatus(key) {
    const elId = `sync-ts-${key}`;
    const el = document.getElementById(elId);
    if (!el) return;
    
    const raw = localStorage.getItem(`mond-sync-status-${key}`);
    if (!raw) {
        el.className = 'sync-timestamp sync-never';
        el.innerHTML = '<span class="sync-dot"></span>Nunca sincronizado';
        el.title = 'Os dados não foram sincronizados ou carregados ainda.';
        return;
    }
    
    try {
        const status = JSON.parse(raw);
        const d = new Date(status.timestamp);
        if (isNaN(d.getTime())) throw new Error("Invalid date");
        const pad = n => String(n).padStart(2, '0');
        const timeStr = `${pad(d.getDate())}/${pad(d.getMonth()+1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        
        if (status.type === 'live') {
            el.className = 'sync-timestamp sync-live';
            el.innerHTML = `<span class="sync-dot"></span>API Live: ${timeStr}`;
            el.title = `Dados sincronizados em tempo real direto da API em: ${d.toLocaleString('pt-BR')}`;
        } else {
            el.className = 'sync-timestamp sync-cache';
            el.innerHTML = `<span class="sync-dot"></span>Cache local: ${timeStr}`;
            el.title = `Dados carregados do cache local gerado em: ${d.toLocaleString('pt-BR')}. Clique para atualizar em tempo real.`;
        }
    } catch (e) {
        console.error(e);
        el.className = 'sync-timestamp sync-never';
        el.innerHTML = '<span class="sync-dot"></span>Erro no status';
    }
}

function updateSyncTimestamp(key, elId) {
    const isOp = key.includes('operational') || elId.includes('operational');
    setSyncStatus(isOp ? 'operational' : 'commercial', 'live', new Date());
}

function displaySyncTimestamp(key, elId) {
    const isOp = key.includes('operational') || elId.includes('operational');
    renderSyncStatus(isOp ? 'operational' : 'commercial');
}

function pollSyncStatus(type, onComplete, onError) {
    const interval = setInterval(async () => {
        try {
            const response = await fetch('/api/sync-status');
            if (!response.ok) throw new Error("Erro de conexão com o servidor.");
            const data = await response.json();
            
            const state = data[type]; // 'operational' or 'commercial'
            const timestamp = type === 'operational' ? data.operationalTimestamp : data.commercialTimestamp;
            
            if (state === 'completed' || (state === 'idle' && timestamp)) {
                clearInterval(interval);
                onComplete(timestamp);
            } else if (state === 'failed') {
                clearInterval(interval);
                onError(new Error("O download dos dados na API falhou."));
            }
            // If syncing, we just wait for the next tick
        } catch (e) {
            clearInterval(interval);
            onError(e);
        }
    }, 4000); // Poll every 4 seconds
}



async function fetchOperationalData(showOverlay = true) {
    const syncBtnText = btnSyncApi ? btnSyncApi.querySelector('span') : null;
    if (showOverlay) {
        btnSyncApi.classList.add('loading');
        btnSyncApi.disabled = true;
        if (syncBtnText) syncBtnText.textContent = 'Sincronizando...';
        showToast('Sincronizando dados operacionais com a API em tempo real... Isso pode levar alguns instantes.', 'info', 0);
        
        try {
            const syncResponse = await fetch('/api/sync-operational');
            if (!syncResponse.ok) {
                throw new Error("Erro ao iniciar a sincronização no servidor.");
            }
            const syncRes = await syncResponse.json();
            if (!syncRes.success) {
                throw new Error(syncRes.message || "Erro desconhecido ao iniciar sincronização.");
            }
            
            // Poll for status
            pollSyncStatus('operational', 
                async (timestamp) => {
                    try {
                        // Reload data from cache (now updated)
                        await fetchOperationalData(false);
                        
                        // Explicitly set the status to live with the new timestamp
                        setSyncStatus('operational', 'live', timestamp);
                        
                        btnSyncApi.classList.remove('loading');
                        btnSyncApi.disabled = false;
                        if (syncBtnText) syncBtnText.textContent = 'Sincronizar Operacional';
                        hideToast();
                        showToast(`✅ Sincronização operacional concluída em tempo real!`, 'success', 4000);
                    } catch (e) {
                        btnSyncApi.classList.remove('loading');
                        btnSyncApi.disabled = false;
                        if (syncBtnText) syncBtnText.textContent = 'Sincronizar Operacional';
                        hideToast();
                        showToast("❌ Erro ao ler novos dados operacionais.", 'error', 6000);
                    }
                },
                (error) => {
                    btnSyncApi.classList.remove('loading');
                    btnSyncApi.disabled = false;
                    if (syncBtnText) syncBtnText.textContent = 'Sincronizar Operacional';
                    hideToast();
                    showToast(`❌ Erro no download: ${error.message}`, 'error', 6000);
                }
            );
        } catch (err) {
            btnSyncApi.classList.remove('loading');
            btnSyncApi.disabled = false;
            if (syncBtnText) syncBtnText.textContent = 'Sincronizar Operacional';
            hideToast();
            showToast(`❌ Erro ao iniciar sincronização: ${err.message}`, 'error', 6000);
        }
        return;
    }
    
    // Background/cached load
    try {
        let lastMod = null;
        let url = './operational_cache.json';
        const response = await fetch(url, { method: 'GET' });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        lastMod = response.headers.get('Last-Modified');
        
        const json = await response.json();
        const rawDataList = Array.isArray(json) ? json : (json.data || json.operational || json.commercial || []);
        if (!Array.isArray(rawDataList)) {
            throw new Error("Resposta da API inválida.");
        }
        
        const parseApiDate = (dt) => {
            if (!dt) return "";
            const clean = String(dt).split('T')[0];
            const parsed = parseDate(clean);
            if (parsed.startsWith("0001") || parsed === "1900-01-01" || parsed === "") {
                return "";
            }
            return parsed;
        };
        
        const stripHtml = (html) => {
            if (!html) return "";
            return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
        };


        const hasDateValue = (dt) => {
            if (!dt) return false;
            const s = String(dt).trim();
            if (s === "" || s === "-" || s.startsWith("0001") || s.startsWith("1900-01-01") || s.startsWith("00/00")) {
                return false;
            }
            return true;
        };

        console.log('[DEBUG] Total registros da API/cache:', rawDataList.length);
        const parsedData = rawDataList
            .filter(item => {
                const isMaritime = item.PRODUTO === "Importação Marítima";
                const isFcl = item.DS_TIPO_FRETE === "FCL" || (item.DS_TIPO_FRETE == null && isMaritime);
                
                // Excluir processos cancelados
                const isCancelado = (item.DS_STATUS || '').trim().toLowerCase() === 'cancelado';
                if (isCancelado) return false;
                
                // Nota: processos embarcados NÃO são mais excluídos aqui.
                // A visibilidade é controlada pelo filtro de FASE na UI.
                
                // Filtrar processos antigos: só considerar abertos nos últimos 12 meses
                let isRecent = true;
                if (item.ABERTURA) {
                    const aberturaDate = new Date(String(item.ABERTURA).split('T')[0] + "T00:00:00");
                    if (!isNaN(aberturaDate.getTime())) {
                        const cutoffDate = new Date();
                        cutoffDate.setMonth(cutoffDate.getMonth() - 12);
                        isRecent = aberturaDate >= cutoffDate;
                    }
                }
                
                return isMaritime && isFcl && isRecent;
            })
            .map(item => {
                const totalFreight = item.VL_COMPRA_FRETE;
                const parsedTotal = parseBrNumber(totalFreight);
                const cleanTotal = isNaN(parsedTotal) ? 0 : parsedTotal;
                
                const totalSellFreight = item.VL_VENDA_FRETE;
                const parsedSellTotal = parseBrNumber(totalSellFreight);
                const cleanSellTotal = isNaN(parsedSellTotal) ? 0 : parsedSellTotal;
                
                const qty = getContainerQty(item.DS_QUANTIDADE_CONTAINERS);
                const unitValor = cleanTotal > 0 ? (cleanTotal / qty) : 0;
                const unitValorVenda = cleanSellTotal > 0 ? (cleanSellTotal / qty) : 0;

                return {
                    processo: item.PROCESSO || "N/A",
                    produto: item.PRODUTO || "Importação Marítima",
                    cliente: item.CLIENTE || "N/A",
                    modalidade: item.DS_TIPO_FRETE || "FCL",
                    agente: item.AGENTE || "N/A",
                    armador: item.ARMADOR || "N/A",
                    origem: cleanPortName(item.ORIGEM),
                    destino: cleanPortName(item.DESTINO),
                    moeda: item.DS_MOEDA_INVOICE || "USD",
                    valor: unitValor,
                    valorVenda: unitValorVenda,
                    container: item.DS_QUANTIDADE_CONTAINERS || "40' HIGH CUBE",
                    freetime: 0,
                    inicio: parseApiDate(item.ABERTURA),
                    fim: parseApiDate(item.VALIDADE_FRETE),
                    observacao: "",
                    source: "operational",
                    prontidao: parseApiDate(item.DT_PRONTIDAO_CARGA),
                    previsaoEmbarque: parseApiDate(item.DT_PREVISAO_EMBARQUE),
                    previsaoAtracacao: parseApiDate(item.DT_PREVISAO_ATRACACAO),
                    vlTeus: item.VL_TEUS || 0,
                    vlCompraFrete: cleanTotal,
                    vlVendaFrete: cleanSellTotal,
                    paisOrigem: inferCountry(cleanPortName(item.ORIGEM), item.PAIS_ORIGEM),
                    confirmacaoEmbarque: parseApiDate(item.DT_CONFIRMACAO_EMBARQUE),
                    rawConfirmacaoEmbarque: item.DT_CONFIRMACAO_EMBARQUE || '',
                    confirmacaoAtracacao: parseApiDate(item.DT_CONFIRMACAO_ATRACACAO),
                    rawConfirmacaoAtracacao: item.DT_CONFIRMACAO_ATRACACAO || '',
                    booking: item.BOOKING || '',
                    confirmacaoBooking: parseApiDate(item.DT_CONFIRMACAO_BOOKING),
                    navio: item.NAVIO || '',
                    statusProcesso: item.DS_STATUS || ''
                };
            });
        
        appOperational = parsedData;
        console.log('[DEBUG] Processos operacionais carregados (sem cancelados):', appOperational.length);
        
        // Tentar fallback se comercial já estiver carregado
        runOperationalFallback();
        
        mondStorage.setItemSync('mond-operational', JSON.stringify(appOperational));
        
        // Update UI
        initFilterDropdowns();
        updateDashboardCards();
        applyFilters();
        renderIntelTab();
        renderAnalysisTab();
        
        // Save sync status
        if (showOverlay) {
            setSyncStatus('operational', 'live', new Date());
        } else if (lastMod) {
            setSyncStatus('operational', 'cache', lastMod);
        } else {
            const existing = localStorage.getItem('mond-sync-status-operational');
            if (!existing) {
                setSyncStatus('operational', 'cache', new Date());
            } else {
                renderSyncStatus('operational');
            }
        }
        
        if (showOverlay) {
            hideToast();
            showToast(`✅ Sincronização concluída! ${appOperational.length} processos carregados.`, 'success', 4000);
        }
    } catch (err) {
        console.error("Erro ao sincronizar com a API:", err);
        
        // Fallback checks
        if (!appOperational || appOperational.length === 0) {
            appOperational = [...MOCK_OPERATIONAL];
            mondStorage.setItemSync('mond-operational', JSON.stringify(appOperational));
            initFilterDropdowns();
            updateDashboardCards();
            applyFilters();
            renderIntelTab();
            renderAnalysisTab();
        }
        
        hideToast();
        if (showOverlay) {
            showToast("❌ Erro ao sincronizar dados operacionais. Verifique a conexão com o servidor de APIs.", 'error', 6000);
        } else {
            showToast("ℹ️ O cache local de dados operacionais está sendo gerado em segundo plano. Os dados serão atualizados em instantes.", 'info', 5000);
        }
    } finally {
        if (showOverlay) {
            btnSyncApi.classList.remove('loading');
            btnSyncApi.disabled = false;
            if (syncBtnText) syncBtnText.textContent = 'Sincronizar API';
        }
    }
}

// Global state for selected status filters
let statusFilterActive = false;
let selectedStatus = new Set(); // empty = all selected

// Global state for selected fase (phase) filters
let faseFilterActive = false;
let selectedFases = new Set(); // empty = all selected

// Global state for situação (DS_STATUS_PROCESSO) filter — defaults to showing only "Aberto"
let situacaoFilterActive = true;
let selectedSituacao = new Set(['Aberto']);

async function fetchCommercialData(showOverlay = true) {
    const btnSyncComercial = document.getElementById('btn-sync-comercial');
    const syncBtnText = btnSyncComercial ? btnSyncComercial.querySelector('span') : null;
    if (showOverlay && btnSyncComercial) {
        btnSyncComercial.classList.add('loading');
        btnSyncComercial.disabled = true;
        if (syncBtnText) syncBtnText.textContent = 'Sincronizando...';
        showToast('Sincronizando dados comerciais com a API em tempo real... Isso pode levar alguns instantes.', 'info', 0);
        
        try {
            const syncResponse = await fetch('/api/sync-commercial');
            if (!syncResponse.ok) {
                throw new Error("Erro ao iniciar a sincronização comercial no servidor.");
            }
            const syncRes = await syncResponse.json();
            if (!syncRes.success) {
                throw new Error(syncRes.message || "Erro desconhecido ao iniciar sincronização.");
            }
            
            // Poll for status
            pollSyncStatus('commercial', 
                async (timestamp) => {
                    try {
                        // Reload data from cache (now updated)
                        await fetchCommercialData(false);
                        
                        // Explicitly set the status to live with the new timestamp
                        setSyncStatus('commercial', 'live', timestamp);
                        
                        btnSyncComercial.classList.remove('loading');
                        btnSyncComercial.disabled = false;
                        if (syncBtnText) syncBtnText.textContent = 'Sincronizar Comercial';
                        hideToast();
                        showToast(`✅ Sincronização comercial concluída em tempo real!`, 'success', 4000);
                    } catch (e) {
                        btnSyncComercial.classList.remove('loading');
                        btnSyncComercial.disabled = false;
                        if (syncBtnText) syncBtnText.textContent = 'Sincronizar Comercial';
                        hideToast();
                        showToast("❌ Erro ao ler novos dados comerciais.", 'error', 6000);
                    }
                },
                (error) => {
                    btnSyncComercial.classList.remove('loading');
                    btnSyncComercial.disabled = false;
                    if (syncBtnText) syncBtnText.textContent = 'Sincronizar Comercial';
                    hideToast();
                    showToast(`❌ Erro no download comercial: ${error.message}`, 'error', 6000);
                }
            );
        } catch (err) {
            btnSyncComercial.classList.remove('loading');
            btnSyncComercial.disabled = false;
            if (syncBtnText) syncBtnText.textContent = 'Sincronizar Comercial';
            hideToast();
            showToast(`❌ Erro ao iniciar sincronização comercial: ${err.message}`, 'error', 6000);
        }
        return;
    }
    
    // Background/cached load
    try {
        let lastMod = null;
        let url = './commercial_cache.json';
        const response = await fetch(url, { method: 'GET' });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        lastMod = response.headers.get('Last-Modified');
        
        const json = await response.json();
        const rawDataList = Array.isArray(json) ? json : (json.data || json.commercial || json.operational || []);
        if (!Array.isArray(rawDataList)) {
            throw new Error("Resposta da API inválida.");
        }
        
        const parseApiDate = (dt) => {
            if (!dt) return "";
            const clean = String(dt).split('T')[0];
            const parsed = parseDate(clean);
            if (parsed.startsWith("0001") || parsed === "1900-01-01" || parsed === "") {
                return "";
            }
            return parsed;
        };
        
        const stripHtml = (html) => {
            if (!html) return "";
            return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
        };

        const hasDateValue = (dt) => {
            if (!dt) return false;
            const s = String(dt).trim();
            if (s === "" || s === "-" || s.startsWith("0001") || s.startsWith("1900-01-01") || s.startsWith("00/00")) {
                return false;
            }
            return true;
        };

        const parsedData = rawDataList
            .filter(item => {
                const isMaritime = item.DS_PRODUTO === "IM";
                const isFcl = item.DS_TIPO_FRETE === "FCL" || (item.DS_TIPO_FRETE == null && isMaritime);
                
                // Filtrar ofertas antigas: só considerar abertas nos últimos 12 meses
                let isRecent = true;
                if (item.DT_ABERTURA) {
                    const aberturaDate = new Date(String(item.DT_ABERTURA).split('T')[0] + "T00:00:00");
                    if (!isNaN(aberturaDate.getTime())) {
                        const cutoffDate = new Date();
                        cutoffDate.setMonth(cutoffDate.getMonth() - 12);
                        isRecent = aberturaDate >= cutoffDate;
                    }
                }
                
                return isMaritime && isFcl && isRecent;
            })
            .map(item => {
                const totalFreight = item.VL_COMPRA_FRETE;
                const parsedTotal = parseBrNumber(totalFreight);
                const cleanTotal = isNaN(parsedTotal) ? 0 : parsedTotal;
                
                const totalVenda = item.VL_VENDA_FRETE;
                const parsedVenda = parseBrNumber(totalVenda);
                const cleanVenda = isNaN(parsedVenda) ? 0 : parsedVenda;
                
                const qty = getContainerQty(item.DS_QUANTIDADE_CONTAINERS);
                const unitValor = cleanTotal > 0 ? (cleanTotal / qty) : 0;
                const unitVenda = cleanVenda > 0 ? (cleanVenda / qty) : 0;

                return {
                    processo: item.NR_OFERTA || "N/A",
                    produto: item.DS_PRODUTO || "IM",
                    cliente: item.DS_CLIENTE || "N/A",
                    modalidade: item.DS_TIPO_FRETE || "FCL",
                    agente: item.DS_AGENTE || "N/A",
                    armador: item.DS_FORNECEDOR_FRETE || "N/A",
                    origem: cleanPortName(item.DS_PORTO_ORIGEM),
                    destino: cleanPortName(item.DS_DESTINO),
                    moeda: item.DS_MOEDA_CIF || "USD",
                    valor: unitValor,
                    valorVenda: unitVenda,
                    vlVendaFrete: cleanVenda,
                    vlCompraFrete: cleanTotal,
                    container: item.DS_QUANTIDADE_CONTAINERS || "40' HIGH CUBE",
                    freetime: 0,
                    inicio: parseApiDate(item.DT_ABERTURA),
                    fim: parseApiDate(item.DT_VALIDADE_ATE),
                    observacao: "",
                    source: "commercial",
                    analise: item.DS_ANALISE || "Sem status",
                    transitTime: item.NR_TRANSIT_TIME || "",
                    historico: item.NR_HISTORICO || "",
                    paisOrigem: inferCountry(cleanPortName(item.DS_PORTO_ORIGEM), item.DS_PAIS_ORIGEM)
                };
            });
        
        appComercial = parsedData;
        mondStorage.setItemSync('mond-commercial', JSON.stringify(appComercial));
        
        // Tentar fallback operacional agora que comercial carregou
        runOperationalFallback();
        
        // Update UI
        initFilterDropdowns();
        updateDashboardCards();
        applyFilters();
        renderIntelTab();
        renderAnalysisTab();
        
        // Save sync status
        if (showOverlay) {
            setSyncStatus('commercial', 'live', new Date());
        } else if (lastMod) {
            setSyncStatus('commercial', 'cache', lastMod);
        } else {
            const existing = localStorage.getItem('mond-sync-status-commercial');
            if (!existing) {
                setSyncStatus('commercial', 'cache', new Date());
            } else {
                renderSyncStatus('commercial');
            }
        }
        
        if (showOverlay) {
            hideToast();
            showToast(`✅ Sincronização concluída! ${appComercial.length} ofertas comerciais carregadas.`, 'success', 4000);
        }
    } catch (err) {
        console.error("Erro ao sincronizar com a API Comercial:", err);
        
        // Fallback
        if (!appComercial || appComercial.length === 0) {
            appComercial = [];
            mondStorage.setItemSync('mond-commercial', JSON.stringify(appComercial));
            initFilterDropdowns();
            updateDashboardCards();
            applyFilters();
            renderIntelTab();
            renderAnalysisTab();
        }
        
        hideToast();
        if (showOverlay) {
            showToast("❌ Erro ao sincronizar dados comerciais. Verifique a conexão com o servidor de APIs.", 'error', 6000);
        } else {
            showToast("ℹ️ O cache local de dados comerciais está sendo gerado em segundo plano. Os dados serão atualizados em instantes.", 'info', 5000);
        }
    } finally {
        if (showOverlay && btnSyncComercial) {
            btnSyncComercial.classList.remove('loading');
            btnSyncComercial.disabled = false;
            if (syncBtnText) syncBtnText.textContent = 'Sincronizar Comercial';
        }
    }
}


document.addEventListener('DOMContentLoaded', async () => {
    // Migrate large data from localStorage to IndexedDB (one-time)
    if (!localStorage.getItem('mond-migrated-to-idb')) {
        for (const key of mondStorage.BIG_KEYS) {
            const val = localStorage.getItem(key);
            if (val) {
                await mondStorage.setItem(key, val);
                localStorage.removeItem(key);
                console.log('[Migration] Migrated', key, 'to IndexedDB');
            }
        }
        localStorage.setItem('mond-migrated-to-idb', '1');
    }

    // 1. Theme setup
    const savedTheme = localStorage.getItem('mond-theme') || 'light';
    bodyEl.setAttribute('data-theme', savedTheme);
    
    // Load sync timestamps
    renderSyncStatus('operational');
    renderSyncStatus('commercial');

    // Load snapshots from database/localStorage fallback
    if (window.db && typeof window.db.loadAllSnapshots === 'function') {
        window.db.loadAllSnapshots();
    }
    
    // 2. Load rates from LocalStorage and clean up any remaining mock data if present
    const savedRates = await mondStorage.getItem('mond-rates');
    if (savedRates) {
        try {
            appRates = JSON.parse(savedRates);
            if (Array.isArray(appRates)) {
                // Remove older mock items with mock agents QR TRANS or GLOBAL LOG, and tag source
                appRates = appRates.filter(r => r.agente !== "QR TRANS" && r.agente !== "GLOBAL LOG").map(r => ({ ...r, source: 'rate' }));
            }
            if (!Array.isArray(appRates) || appRates.length === 0) {
                appRates = [...MOCK_RATES];
                mondStorage.setItemSync('mond-rates', JSON.stringify(appRates));
            }
        } catch (e) {
            console.error("Erro ao ler tarifas salvas. Carregando dados padrão.", e);
            appRates = [...MOCK_RATES];
        }
    } else {
        appRates = [...MOCK_RATES];
        mondStorage.setItemSync('mond-rates', JSON.stringify(appRates));
    }

    // Load space data from LocalStorage and clean up any remaining mock data if present
    const savedSpace = await mondStorage.getItem('mond-space');
    if (savedSpace) {
        try {
            appSpace = JSON.parse(savedSpace);
            if (Array.isArray(appSpace)) {
                // Remove older mock items with mock agent REACH, and tag source
                appSpace = appSpace.filter(s => s.agente !== "REACH").map(s => ({ ...s, source: 'space' }));
            }
            if (!Array.isArray(appSpace) || appSpace.length === 0) {
                appSpace = [...MOCK_SPACE];
                mondStorage.setItemSync('mond-space', JSON.stringify(appSpace));
            }
        } catch (e) {
            console.error("Erro ao ler spaces salvas. Carregando dados padrão.", e);
            appSpace = [...MOCK_SPACE];
        }
    } else {
        appSpace = [...MOCK_SPACE];
        mondStorage.setItemSync('mond-space', JSON.stringify(appSpace));
    }
    
    // Load shared team custom tariffs & space from Cloud DB (JSONBlob)
    loadSharedCustomData();
    
    // One-time migration: clear stale operational cache that doesn't properly
    // track embarked/cancelled status. The field _cacheVersion tracks this.
    const OPERATIONAL_CACHE_VERSION = 3; // Bump to force re-fetch after adding raw fields
    const cachedVersion = parseInt(localStorage.getItem('mond-operational-cache-version') || '0', 10);
    if (cachedVersion < OPERATIONAL_CACHE_VERSION) {
        console.log('[Migration] Limpando cache operacional desatualizado (v' + cachedVersion + ' → v' + OPERATIONAL_CACHE_VERSION + ')');
        mondStorage.removeItem('mond-operational');
        localStorage.setItem('mond-operational-cache-version', String(OPERATIONAL_CACHE_VERSION));
    }

    // Load operational data from LocalStorage or fetch from API
    const savedOperational = await mondStorage.getItem('mond-operational');
    if (savedOperational) {
        try {
            appOperational = JSON.parse(savedOperational);
            if (Array.isArray(appOperational)) {
                // Filtrar processos já embarcados ou cancelados do cache
                const _isDate = (d) => {
                    if (!d) return false;
                    const s = String(d).trim();
                    return s !== '' && s !== '-' && !s.startsWith('0001') && !s.startsWith('1900-01-01');
                };
                appOperational = appOperational
                    .filter(o => {
                        // Excluir cancelados
                        if ((o.statusProcesso || '').trim().toLowerCase() === 'cancelado') return false;
                        // Excluir já embarcados (tanto parsed quanto raw)
                        if (_isDate(o.confirmacaoEmbarque) || _isDate(o.rawConfirmacaoEmbarque)) return false;
                        return true;
                    })
                    .map(o => ({
                        ...o, source: 'operational', observacao: '',
                        origem: cleanPortName(o.origem),
                        destino: cleanPortName(o.destino),
                        paisOrigem: inferCountry(cleanPortName(o.origem), o.paisOrigem)
                    }));
            }
            if (!Array.isArray(appOperational) || appOperational.length === 0) {
                appOperational = [];
            }
        } catch (e) {
            console.error("Erro ao ler dados operacionais salvos.", e);
            appOperational = [];
        }
    }
    // Always refresh in background from cache/API to pick up new fields
    fetchOperationalData(false);

    // Load commercial data from LocalStorage or fetch from API
    const savedCommercial = await mondStorage.getItem('mond-commercial');
    if (savedCommercial) {
        try {
            appComercial = JSON.parse(savedCommercial);
            if (Array.isArray(appComercial)) {
                appComercial = appComercial.map(c => ({
                    ...c, source: 'commercial', observacao: '',
                    origem: cleanPortName(c.origem),
                    destino: cleanPortName(c.destino),
                    paisOrigem: inferCountry(cleanPortName(c.origem), c.paisOrigem)
                }));
            }
            if (!Array.isArray(appComercial) || appComercial.length === 0) {
                appComercial = [];
            }
        } catch (e) {
            console.error("Erro ao ler dados comerciais salvos.", e);
            appComercial = [];
        }
    }
    // Always refresh in background from cache/API to pick up new fields
    fetchCommercialData(false);
    
    // 3. Initialize UI elements
    lucide.createIcons();
    initFilterDropdowns();
    initAutocomplete();
    initValidadeDateFilter();
    initObsCategoryFilter();
    initStatusFilter();
    initColumnFilters();
    updateValidadeHeaderLabel();
    initFreightAnalyzer();
    initAiChatbot();
    
    // Initialize abertura date range filter with defaults (3 months ago to today)
    const aberturaDeInput = document.getElementById('filter-abertura-de');
    const aberturaAteInput = document.getElementById('filter-abertura-ate');
    if (aberturaDeInput && aberturaAteInput) {
        const today = new Date();
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
        aberturaDeInput.value = threeMonthsAgo.toISOString().split('T')[0];
        aberturaAteInput.value = today.toISOString().split('T')[0];
        
        aberturaDeInput.addEventListener('change', () => { currentPage = 1; applyFilters(); updateDashboardCards(); });
        aberturaAteInput.addEventListener('change', () => { currentPage = 1; applyFilters(); updateDashboardCards(); });
    }
    
    // Initialize fase multi-select filter
    initFaseFilter();
    
    // Initialize situação (Aberto/Cancelado) filter
    initSituacaoFilter();
    // Load Saved Chat Sessions List
    window.loadChatSessionsList();
    
    // Scan and build dynamic categories from loaded observations database
    window.populateObsCategoryDropdown();
    
    // Auto-switch to Oper. + Comercial tab if no custom Excel rates uploaded yet
    if (appRates.length === 0 && appSpace.length === 0) {
        activeDb = "apiAll";
        document.querySelectorAll('.db-btn').forEach(btn => {
            if (btn.getAttribute('data-db') === 'apiAll') btn.classList.add('active');
            else btn.classList.remove('active');
        });
    }

    updateDashboardCards();
    applyFilters();
    renderIntelTab();
    renderAnalysisTab();
    
    // 4. Initialize Builder Tab (Criar Tarifário / Space)
    if (typeof initBuilderTab === 'function') {
        initBuilderTab();
    }
    
    // 5. Setup listeners
    setupEventListeners();
});

function setupEventListeners() {
    // Theme toggle (removed from UI but kept as safeguard)
    if (btnThemeToggle) {
        btnThemeToggle.addEventListener('click', () => {
            const currentTheme = bodyEl.getAttribute('data-theme');
            const newTheme = currentTheme === 'light' ? 'dark' : 'light';
            bodyEl.setAttribute('data-theme', newTheme);
            localStorage.setItem('mond-theme', newTheme);
        });
    }

    // Upload section toggler
    btnToggleUpload.addEventListener('click', () => {
        uploadSection.classList.toggle('collapsed');
    });
    btnCloseUpload.addEventListener('click', () => {
        uploadSection.classList.add('collapsed');
    });
    // Global Drag & Drop Overlay Logic
    const globalDragOverlay = document.getElementById('global-drag-overlay');
    let dragTimeout;

    window.addEventListener('dragover', (e) => {
        e.preventDefault();
        const types = e.dataTransfer.types;
        const isFileDrag = types && (
            (typeof types.includes === 'function' && types.includes('Files')) || 
            (typeof types.contains === 'function' && types.contains('Files')) || 
            Array.from(types).includes('Files')
        );
        
        if (isFileDrag) {
            globalDragOverlay.classList.add('active');
            clearTimeout(dragTimeout);
            dragTimeout = setTimeout(() => {
                globalDragOverlay.classList.remove('active');
            }, 200);
        }
    });

    window.addEventListener('drop', (e) => {
        e.preventDefault();
        clearTimeout(dragTimeout);
        globalDragOverlay.classList.remove('active');
        if (e.dataTransfer.files.length > 0) {
            processFile(e.dataTransfer.files[0]);
        }
    });

    // Card Dropzone events
    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
    });

    dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('dragover');
    });

    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) {
            processFile(e.dataTransfer.files[0]);
        }
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            processFile(e.target.files[0]);
        }
    });

    // Filter selectors change (on 'input' for instant searchable autocompletes)
    selectOrigem.addEventListener('input', () => { 
        activeNlpFilters.origem = null; 
        window.activeRoutePairs.clear();
        document.querySelectorAll('.ranking-route-item').forEach(item => item.classList.remove('active'));
        hideRouteDetail();
        applyFilters(); 
    });
    selectDestino.addEventListener('input', () => { 
        activeNlpFilters.destino = null; 
        window.activeRoutePairs.clear();
        document.querySelectorAll('.ranking-route-item').forEach(item => item.classList.remove('active'));
        hideRouteDetail();
        applyFilters(); 
    });
    selectContainer.addEventListener('input', () => { activeNlpFilters.container = null; applyFilters(); });
    selectArmador.addEventListener('input', () => { activeNlpFilters.armador = null; applyFilters(); });
    selectValidade.addEventListener('change', (e) => {
        updateValidityFilterUI(e.target.value);
        applyFilters();
    });

    document.querySelectorAll('#validity-pills .pill-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const val = btn.getAttribute('data-value');
            updateValidityFilterUI(val);
            applyFilters();
        });
    });
    
    // Sort Select change handler
    selectSortBy.addEventListener('change', (e) => {
        const [field, direction] = e.target.value.split('-');
        currentSortField = field === 'Vl. Frete' ? 'valor' : field === 'Free Time' ? 'freetime' : field === 'Dt Fim Validade' ? 'fim' : 'armador';
        currentSortDirection = direction;
        applyFilters();
    });

    // Table Column Search Filters input
    document.getElementById('col-filter-origem').addEventListener('input', (e) => { colFilters.origem = e.target.value; applyFilters(); });
    document.getElementById('col-filter-destino').addEventListener('input', (e) => { colFilters.destino = e.target.value; applyFilters(); });
    document.getElementById('col-filter-container').addEventListener('input', (e) => { colFilters.container = e.target.value; applyFilters(); });
    document.getElementById('col-filter-armador').addEventListener('input', (e) => { colFilters.armador = e.target.value; applyFilters(); });
    document.getElementById('col-filter-agente').addEventListener('input', (e) => { colFilters.agente = e.target.value; applyFilters(); });
    document.getElementById('col-filter-freetime').addEventListener('input', (e) => { colFilters.freetime = e.target.value; applyFilters(); });
    document.getElementById('col-filter-obs').addEventListener('input', (e) => { colFilters.obs = e.target.value; applyFilters(); });

    // Table Column sorting headers click
    document.querySelectorAll('th.sortable').forEach(th => {
        th.addEventListener('click', () => {
            const sortField = th.getAttribute('data-sort');
            if (currentSortField === sortField) {
                currentSortDirection = currentSortDirection === "asc" ? "desc" : "asc";
            } else {
                currentSortField = sortField;
                currentSortDirection = "asc";
            }
            
            // Sync with selectSortBy select element
            if (sortField === 'valor') {
                selectSortBy.value = `Vl. Frete-${currentSortDirection}`;
            } else if (sortField === 'freetime') {
                selectSortBy.value = `Free Time-${currentSortDirection}`;
            } else if (sortField === 'fim') {
                selectSortBy.value = `Dt Fim Validade-${currentSortDirection}`;
            } else if (sortField === 'armador') {
                selectSortBy.value = `Armador-${currentSortDirection}`;
            }
            
            applyFilters();
        });
    });

    // Reset filters button
    btnResetFilters.addEventListener('click', () => {
        resetAllFilters();
    });

    // NLP Search Box keyup & input
    nlpInput.addEventListener('input', (e) => {
        const value = e.target.value;
        if (value.trim() !== "") {
            btnClearSearch.classList.add('visible');
            parseNlpQuery(value);
        } else {
            btnClearSearch.classList.remove('visible');
            resetNlpFilters();
        }
    });

    // Clear search button
    btnClearSearch.addEventListener('click', () => {
        nlpInput.value = "";
        btnClearSearch.classList.remove('visible');
        resetNlpFilters();
    });

    // Rows per page selector
    const rowsPerPageSelect = document.getElementById('rows-per-page');
    if (rowsPerPageSelect) {
        rowsPerPageSelect.addEventListener('change', (e) => {
            rowsPerPage = parseInt(e.target.value, 10);
            currentPage = 1;
            renderTable();
        });
    }

    // Cliente filter input listener
    const filterClienteInput = document.getElementById('filter-cliente');
    if (filterClienteInput) {
        filterClienteInput.addEventListener('input', () => {
            currentPage = 1;
            applyFilters();
            updateDashboardCards();
        });
    }

    // País Origem filter input listener
    const filterPaisOrigemInput = document.getElementById('filter-pais-origem');
    if (filterPaisOrigemInput) {
        filterPaisOrigemInput.addEventListener('input', () => {
            currentPage = 1;
            applyFilters();
            updateDashboardCards();
        });
    }

    // Agente top filter input listener
    const filterAgenteTopInput = document.getElementById('filter-agente-top');
    if (filterAgenteTopInput) {
        filterAgenteTopInput.addEventListener('input', () => {
            currentPage = 1;
            applyFilters();
            updateDashboardCards();
        });
    }

    // Pagination controls
    btnPrevPage.addEventListener('click', () => {
        if (currentPage > 1) {
            currentPage--;
            renderTable();
        }
    });

    btnNextPage.addEventListener('click', () => {
        const totalPages = Math.ceil(filteredRates.length / rowsPerPage);
        if (currentPage < totalPages) {
            currentPage++;
            renderTable();
        }
    });

    // Modal close
    closeModal.addEventListener('click', () => {
        detailsModal.classList.remove('open');
    });
    btnCloseModalFooter.addEventListener('click', () => {
        detailsModal.classList.remove('open');
    });
    window.addEventListener('click', (e) => {
        if (e.target === detailsModal) {
            detailsModal.classList.remove('open');
        }
    });

    // Navigation tab switching
    document.querySelectorAll('.tab-link').forEach(link => {
        link.addEventListener('click', () => {
            document.querySelectorAll('.tab-link').forEach(l => l.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
            
            link.classList.add('active');
            const targetId = link.getAttribute('data-tab');
            const targetPanel = document.getElementById(targetId);
            if (targetPanel) {
                targetPanel.classList.remove('hidden');
            }
            
            if (targetId === 'intel-tab-panel') {
                renderIntelTab();
            } else if (targetId === 'analysis-tab-panel') {
                renderAnalysisTab();
            } else if (targetId === 'builder-tab-panel') {
                lucide.createIcons();
            } else if (targetId === 'dashboard-tab-panel') {
                lucide.createIcons();
                // 1. Load historical snapshots from disk
                const loadPromise = (window.db && typeof window.db.loadAllSnapshots === 'function')
                    ? window.db.loadAllSnapshots()
                    : Promise.resolve();
                
                loadPromise.then(() => {
                    // 2. Auto-save today's data from appRates to disk
                    if (typeof autoSaveTodaySnapshots === 'function') {
                        return autoSaveTodaySnapshots();
                    }
                }).then(() => {
                    // 3. Reload snapshots so the newly saved ones are available
                    if (window.db && typeof window.db.loadAllSnapshots === 'function') {
                        return window.db.loadAllSnapshots();
                    }
                }).then(() => {
                    // 4. Render the dashboard with live + historical data
                    if (typeof renderDashboardTab === 'function') {
                        renderDashboardTab();
                    }
                });
            }
        });
    });

    // Database selector buttons
    document.querySelectorAll('#db-selector .db-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#db-selector .db-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeDb = btn.getAttribute('data-db');
            
            // Toggle filter visibility: Validade vs Período de Abertura + Cliente filter
            const filterGroupValidade = document.getElementById('filter-group-validade');
            const filterGroupAbertura = document.getElementById('filter-group-abertura');
            const filterGroupCliente = document.getElementById('filter-group-cliente');
            const filterGroupAgente = document.getElementById('filter-group-agente');
            const isApiTab = (activeDb === 'operational' || activeDb === 'commercial' || activeDb === 'apiAll');
            const filterGroupPaisOrigem = document.getElementById('filter-group-pais-origem');
            
            if (isApiTab) {
                if (filterGroupValidade) filterGroupValidade.style.display = 'none';
                if (filterGroupAbertura) filterGroupAbertura.style.display = 'block';
                if (filterGroupCliente) filterGroupCliente.style.display = 'block';
                if (filterGroupAgente) filterGroupAgente.style.display = 'block';
                if (filterGroupPaisOrigem) filterGroupPaisOrigem.style.display = 'block';
            } else {
                if (filterGroupValidade) filterGroupValidade.style.display = 'block';
                if (filterGroupAbertura) filterGroupAbertura.style.display = 'none';
                if (filterGroupCliente) filterGroupCliente.style.display = 'none';
                if (filterGroupAgente) filterGroupAgente.style.display = 'none';
                if (filterGroupPaisOrigem) filterGroupPaisOrigem.style.display = 'none';
            }
            
            // Toggle Fase filter (only for operational/apiAll — commercial has no booking/embarque)
            const filterGroupFase = document.getElementById('filter-group-fase');
            const isOperationalTab = (activeDb === 'operational' || activeDb === 'apiAll');
            if (filterGroupFase) filterGroupFase.style.display = isOperationalTab ? 'block' : 'none';
            
            // Toggle Situação filter (only for operational/apiAll)
            const filterGroupSituacao = document.getElementById('filter-group-situacao');
            if (filterGroupSituacao) filterGroupSituacao.style.display = isOperationalTab ? 'block' : 'none';
            
            // Toggle Cliente column visibility
            document.querySelectorAll('.col-cliente').forEach(el => {
                el.style.display = isApiTab ? '' : 'none';
            });
            
            // Toggle ETD/ETA/Fase column visibility (operational only)
            document.querySelectorAll('.col-etd, .col-eta, .col-fase').forEach(el => {
                el.style.display = isOperationalTab ? '' : 'none';
            });
            
            // Show/hide freight analyzer for API tabs
            const freightAnalyzer = document.getElementById('freight-analyzer');
            if (freightAnalyzer) {
                freightAnalyzer.style.display = isApiTab ? 'block' : 'none';
            }
            
            // Re-apply filters and update cards for the selected database
            hideRouteDetail();
            const perfInline = document.getElementById('performance-timeline-inline');
            if (perfInline) perfInline.style.display = 'none';
            applyFilters();
            updateDashboardCards();
            updateValidadeHeaderLabel();
            renderAnalyticsDashboard();
        });
    });

    // Sync Operational API button click handler
    btnSyncApi.addEventListener('click', () => {
        fetchOperationalData(true);
    });

    // Sync Commercial API button click handler
    const btnSyncComercial = document.getElementById('btn-sync-comercial');
    if (btnSyncComercial) {
        btnSyncComercial.addEventListener('click', () => {
            fetchCommercialData(true);
        });
    }

    // Analysis Subnav tab switching
    document.querySelectorAll('.analysis-subnav .subnav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.analysis-subnav .subnav-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            const targetSubtab = btn.getAttribute('data-subtab');
            document.querySelectorAll('.subtab-panel').forEach(panel => panel.classList.add('hidden'));
            
            const targetPanel = document.getElementById(`subtab-panel-${targetSubtab}`);
            if (targetPanel) {
                targetPanel.classList.remove('hidden');
            }
            
            renderAnalysisTab();
        });
    });

    // Search and sort listeners for Analysis
    const analysisRouteSearch = document.getElementById('analysis-route-search');
    if (analysisRouteSearch) {
        analysisRouteSearch.addEventListener('input', () => {
            renderAnalysisOpportunities();
        });
    }

    const analysisCompleteSearch = document.getElementById('analysis-complete-search');
    if (analysisCompleteSearch) {
        analysisCompleteSearch.addEventListener('input', () => {
            renderAnalysisComplete();
        });
    }

    const btnSortSaving = document.getElementById('btn-sort-saving');
    if (btnSortSaving) {
        btnSortSaving.addEventListener('click', () => {
            if (analysisSortOrder === 'desc') {
                analysisSortOrder = 'asc';
                const icon = btnSortSaving.querySelector('i');
                if (icon) icon.setAttribute('data-lucide', 'chevron-up');
            } else {
                analysisSortOrder = 'desc';
                const icon = btnSortSaving.querySelector('i');
                if (icon) icon.setAttribute('data-lucide', 'chevron-down');
            }
            lucide.createIcons();
            renderAnalysisOpportunities();
        });
    }

    // Grouping selector buttons
    document.querySelectorAll('.grouping-selector .pill-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.grouping-selector .pill-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            analysisGroupBy = btn.getAttribute('data-group');
            renderAnalysisOpportunities();
        });
    });

    // Analysis Base de Carga selector buttons
    document.querySelectorAll('.analysis-source-selector button').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.analysis-source-selector button').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            analysisSource = btn.getAttribute('data-source');
            
            // Update stats cards labels and values
            const totalProcessesLabel = document.querySelector('.opportunity-card:nth-child(3) .card-label');
            const totalProcessesSubtitle = document.querySelector('.opportunity-card:nth-child(3) .card-meta');
            if (totalProcessesLabel) {
                totalProcessesLabel.textContent = analysisSource === 'commercial' ? 'Ofertas Analisadas' : 'Processos Analisados';
            }
            if (totalProcessesSubtitle) {
                totalProcessesSubtitle.textContent = analysisSource === 'commercial' ? 'Ofertas ativas' : 'Cargas ativas não embarcadas';
            }
            
            renderAnalysisTab();
        });
    });

    // Analysis Booking filter buttons
    document.querySelectorAll('.analysis-booking-filter button').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.analysis-booking-filter button').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            analysisBookingFilter = btn.getAttribute('data-booking');
            renderAnalysisTab();
            applyFilters();
        });
    });

    // Manual simulator select listener
    const simProcessSelect = document.getElementById('sim-process-select');
    if (simProcessSelect) {
        simProcessSelect.addEventListener('change', (e) => {
            onManualSimulatorProcessChange(e.target.value);
        });
    }
}

/* ==========================================================================
   EXCEL & CSV FILE PARSER HELPERS
   ========================================================================== */

const monthMap = {
    'jan': '01', 'january': '01', 'janeiro': '01',
    'feb': '02', 'february': '02', 'fevereiro': '02',
    'mar': '03', 'march': '03', 'marco': '03', 'março': '03',
    'apr': '04', 'april': '04', 'abril': '04',
    'may': '05', 'maio': '05',
    'jun': '06', 'june': '06', 'junho': '06',
    'jul': '07', 'july': '07', 'julho': '07',
    'aug': '08', 'august': '08', 'agosto': '08',
    'sep': '09', 'september': '09', 'setembro': '09',
    'oct': '10', 'october': '10', 'outubro': '10',
    'nov': '11', 'november': '11', 'novembro': '11',
    'dec': '12', 'december': '12', 'dezembro': '12'
};

function normalizeContainer(c) {
    const clean = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean.includes('20DRY') || clean.includes('20GP') || clean.includes('20FT')) {
        return "20' DRY";
    }
    if (clean.includes('40HQ') || clean.includes('40HC') || clean.includes('HIGH') || clean.includes('HC')) {
        return "40' HIGH CUBE";
    }
    if (clean.includes('40NOR') || clean.includes('NOR')) {
        return "40' NOR";
    }
    if (clean.includes('40DRY') || clean.includes('40GP') || clean.includes('40FT')) {
        return "40' DRY";
    }
    if (clean.includes('20')) {
        return "20' DRY";
    }
    if (clean.includes('40')) {
        return "40' DRY";
    }
    return c || "40' HIGH CUBE"; // fallback
}

function getContainerInfo(rate) {
    if (!rate) return { qty: 1, type: "40' HIGH CUBE" };
    let qty = 1;
    let type = "40' HIGH CUBE";
    
    if (rate.source === 'space') {
        qty = rate.qtdSpace || 1;
        type = rate.container || "40' HIGH CUBE";
    } else {
        const fullStr = rate.container || "";
        qty = getContainerQty(fullStr);
        
        // Extract type
        const match = fullStr.trim().match(/^\d+\s*[xX*]\s*(.*)$/);
        if (match) {
            type = match[1].trim();
        } else {
            type = fullStr.trim() || "40' HIGH CUBE";
        }
    }
    
    // Normalize type
    type = normalizeContainer(type);
    
    return { qty, type };
}

// Port name normalization aliases (lowercase key → canonical display name)
const PORT_ALIASES = {
    'tianjinxingang': 'Tianjin Xingang',
    'xingang': 'Tianjin Xingang',
    'xingang,tianjin': 'Tianjin Xingang',
    'tianjin,xingang': 'Tianjin Xingang',
    'tianjin': 'Tianjin Xingang',
    'tianjin binhai': 'Tianjin Xingang',
    'hochiminh': 'Ho Chi Minh',
    'ho chi minh': 'Ho Chi Minh',
    'hamburgo': 'Hamburg',
    'antuerpia': 'Antwerp',
    'londres': 'London',
};

// Port → Country mapping for auto-filling empty paisOrigem
const PORT_TO_COUNTRY = {
    // India
    'mundra': 'Índia', 'nhava sheva': 'Índia', 'chennai': 'Índia', 'kolkata': 'Índia',
    'calcutta': 'Índia', 'bombay': 'Índia', 'mumbai': 'Índia', 'cochin': 'Índia',
    'tuticorin': 'Índia', 'hazira': 'Índia', 'garhi': 'Índia', 'visakhapatnam': 'Índia',
    'madras': 'Índia', 'new delhi': 'Índia', 'delhi': 'Índia', 'ludhiana': 'Índia',
    'bangalore': 'Índia', 'ahmedabad': 'Índia', 'lahore': 'Índia',
    // China
    'shanghai': 'China', 'ningbo': 'China', 'shenzhen': 'China', 'yantian': 'China',
    'shekou': 'China', 'guangzhou': 'China', 'qingdao': 'China', 'tianjin xingang': 'China',
    'xiamen': 'China', 'dalian': 'China', 'fuzhou': 'China', 'nanjing': 'China',
    'nansha': 'China', 'taicang': 'China', 'changzhou': 'China', 'wuhan': 'China',
    'chongqing': 'China', 'changsha': 'China', 'hangzhou': 'China', 'lianyungang': 'China',
    'zhangjiagang': 'China', 'zhanjiang': 'China', 'zhongshan': 'China', 'zhuhai': 'China',
    'nantong': 'China', 'shantou': 'China', 'xiaolan': 'China', 'rongqi': 'China',
    'gaoming': 'China', 'jiangmen': 'China', 'changshu': 'China', 'qinzhou': 'China',
    'foshan': 'China', 'huangpu': 'China', 'beijing': 'China', 'chengdu': 'China',
    'suzhou': 'China', 'wuxi': 'China', 'wenzhou': 'China', 'hong kong': 'China',
    'macau': 'China',
    // Vietnam
    'ho chi minh': 'Vietnã', 'hochiminh': 'Vietnã', 'haiphong': 'Vietnã',
    'vung tau': 'Vietnã',
    // Thailand
    'laem chabang': 'Tailândia', 'lat krabang': 'Tailândia', 'bangkok': 'Tailândia',
    // South Korea
    'busan': 'Coréia do Sul', 'incheon': 'Coréia do Sul', 'seoul': 'Coréia do Sul',
    // Japan
    'tokyo': 'Japão', 'yokohama': 'Japão', 'kobe': 'Japão', 'nagoya': 'Japão',
    'osaka': 'Japão',
    // Taiwan
    'kaohsiung': 'Taiwan', 'keelung': 'Taiwan', 'taichung': 'Taiwan', 'taipei': 'Taiwan',
    // Singapore / Malaysia
    'singapore': 'Cingapura', 'klang': 'Malásia', 'port kelang': 'Malásia',
    'penang': 'Malásia', 'kuala lumpur': 'Malásia',
    // Pakistan
    'karachi': 'Paquistão', 'bin qasim': 'Paquistão', 'port qasim': 'Paquistão',
    // Sri Lanka
    'colombo': 'Sri Lanka',
    // UAE / Middle East
    'jebel ali': 'Emirados Árabes', 'dubai': 'Emirados Árabes',
    'abu dhabi': 'Emirados Árabes',
    // Egypt
    'port said': 'Egito', 'alexandria': 'Egito', 'damietta': 'Egito', 'cairo': 'Egito',
    // Turkey
    'istanbul': 'Turquia', 'izmir': 'Turquia', 'mersin': 'Turquia',
    'gemlik': 'Turquia', 'gebze': 'Turquia', 'ambarli': 'Turquia', 'aliaga': 'Turquia',
    // Europe
    'hamburg': 'Alemanha', 'hamburgo': 'Alemanha', 'bremerhaven': 'Alemanha',
    'rotterdam': 'Holanda', 'antwerp': 'Bélgica', 'antuerpia': 'Bélgica',
    'le havre': 'França', 'genova': 'Itália', 'la spezia': 'Itália',
    'valencia': 'Espanha', 'barcelona': 'Espanha', 'algeciras': 'Espanha',
    'felixstowe': 'Inglaterra', 'london': 'Inglaterra', 'london gateway': 'Inglaterra',
    'leixoes': 'Portugal', 'lisboa': 'Portugal', 'sines': 'Portugal',
    'gdansk': 'Polônia', 'gdynia': 'Polônia',
    // Americas
    'buenos aires': 'Argentina', 'montevidéu': 'Uruguai',
    'santiago': 'Chile', 'san antonio': 'Chile', 'callao': 'Peru',
    'cartagena': 'Colômbia', 'guayaquil': 'Equador',
};

function cleanPortName(str) {
    if (!str) return "";
    let s = String(str)
        .replace(/[\u00A0\u1680\u180E\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    // Extract only the primary port (before any parenthetical like "CAN CHANGE TO")
    const parenMatch = s.match(/^(.+?)\s*\(/);
    if (parenMatch) {
        s = parenMatch[1].trim();
    }
    // Apply port normalization aliases
    const alias = PORT_ALIASES[s.toLowerCase()];
    if (alias) return alias;
    // Apply Title Case normalization: "YANTIAN" → "Yantian", "RIO DE JANEIRO" → "Rio De Janeiro"
    s = s.split(' ').map(w => {
        if (!w) return '';
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }).join(' ');
    return s;
}

// Infer country from port name using PORT_TO_COUNTRY map
function inferCountry(portName, existingCountry) {
    if (existingCountry && existingCountry.trim()) return existingCountry.trim();
    if (!portName) return '';
    const key = portName.trim().toLowerCase();
    return PORT_TO_COUNTRY[key] || '';
}

// Parse a port string into { primary, alternatives[] }
// e.g. "SANTOS (CAN CHANGE TO PARANAGUA/RIO GRANDE/ITAJAI)"
// -> { primary: "SANTOS", alternatives: ["PARANAGUA", "RIO GRANDE", "ITAJAI"], raw: "..." }
function parsePortWithAlternatives(str) {
    if (!str) return { primary: "", alternatives: [], raw: "" };
    const raw = String(str)
        .replace(/[\u00A0\u1680\u180E\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    
    const normalize = (s) => PORT_ALIASES[s.trim().toLowerCase()] || s.trim();
    
    const match = raw.match(/^(.+?)\s*\(\s*(?:CAN CHANGE TO|OPTIONAL|OR)\s+(.+)\s*\)$/i);
    if (match) {
        const primary = normalize(match[1]);
        const altStr = match[2].trim();
        const alternatives = altStr.split(/[\/,]/).map(s => normalize(s)).filter(s => s.length > 0);
        return { primary, alternatives, raw };
    }
    return { primary: normalize(raw), alternatives: [], raw };
}

// Render a port cell with primary port + sub-text for alternatives
function renderPortCell(str) {
    const parsed = parsePortWithAlternatives(str);
    if (parsed.alternatives.length > 0) {
        const altText = parsed.alternatives.join(', ');
        return `<div class="port-cell">
            <span class="route-text">${parsed.primary}</span>
            <span class="port-alternatives" title="${parsed.raw}">↔ ${altText}</span>
        </div>`;
    }
    return `<span class="route-text">${parsed.primary}</span>`;
}

function getContainerQty(containerStr) {
    if (!containerStr) return 1;
    const str = String(containerStr).trim();
    
    // Handle mixed containers separated by '/' (e.g. "1 x 20' Dry /  1 x 40' High Cube")
    const segments = str.split('/');
    let totalQty = 0;
    
    segments.forEach(seg => {
        const match = seg.trim().match(/^(\d+)\s*[xX*]\s*/);
        if (match) {
            totalQty += parseInt(match[1]) || 0;
        }
    });
    
    return totalQty > 0 ? totalQty : 1;
}

function formatContainerShort(containerStr) {
    if (!containerStr) return '1';
    const str = String(containerStr).trim();
    const segments = str.split('/');
    const parts = [];
    segments.forEach(seg => {
        const match = seg.trim().match(/^(\d+)\s*[xX*]\s*(.*)$/);
        if (match) {
            const qty = match[1];
            const type = match[2].trim();
            let shortType = '';
            const upper = type.toUpperCase();
            if (upper.includes('20')) shortType = "20'";
            else if (upper.includes('HIGH') || upper.includes('HC') || upper.includes('HQ')) shortType = "40'HC";
            else if (upper.includes('40')) shortType = "40'";
            else shortType = type.substring(0, 8);
            parts.push(`${qty}x${shortType}`);
        }
    });
    return parts.length > 0 ? parts.join(' + ') : '1';
}

function extractContainerType(str) {
    const clean = String(str || '').toUpperCase();
    if (clean.includes('40HC') || clean.includes('40HQ') || clean.includes('40\' HC') || clean.includes('40\' HIGH') || clean.includes('HIGH CUBE') || clean.includes('X40HC') || clean.includes('X40HQ')) {
        return "40' HIGH CUBE";
    }
    if (clean.includes('40NOR') || clean.includes('40\' NOR') || clean.includes('NOR')) {
        return "40' NOR";
    }
    if (clean.includes('20GP') || clean.includes('20DRY') || clean.includes('20\' DRY') || clean.includes('20\' GP') || clean.includes('20FT')) {
        return "20' DRY";
    }
    if (clean.includes('40DRY') || clean.includes('40GP') || clean.includes('40\' DRY') || clean.includes('40FT')) {
        return "40' DRY";
    }
    if (clean.includes('40')) {
        return "40' HIGH CUBE";
    }
    if (clean.includes('20')) {
        return "20' DRY";
    }
    return "40' HIGH CUBE";
}

function parseEtdDate(val) {
    if (!val) return "";
    if (val instanceof Date) {
        return val.toISOString().split('T')[0];
    }
    try {
        const serial = Number(val);
        if (typeof val === 'number' || (!isNaN(serial) && String(val).trim() !== "" && !isNaN(parseFloat(val)))) {
            const date = new Date(Math.round((serial - 25569) * 86400 * 1000));
            if (!isNaN(date.getTime())) {
                return date.toISOString().split('T')[0];
            }
        }
    } catch (e) {
        console.error("Erro ao converter data serial ETD:", e);
    }
    const str = String(val).trim().toLowerCase();
    
    // Check if it's already YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    
    // Check if it's DD/MM/YYYY
    const brMatch = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (brMatch) {
        const d = String(brMatch[1]).padStart(2, '0');
        const m = String(brMatch[2]).padStart(2, '0');
        return `${brMatch[3]}-${m}-${d}`;
    }
    
    // Check for DD-MONTH (e.g. 21-JUNE or 21-JUN or 19-june)
    const monthTextMatch = str.match(/^(\d{1,2})[-/\s]+([a-z]+)$/i);
    if (monthTextMatch) {
        const d = String(monthTextMatch[1]).padStart(2, '0');
        const mName = monthTextMatch[2];
        const m = monthMap[mName] || '06'; // default to June if not matched
        return `2026-${m}-${d}`;
    }
    
    // Fallback simple parsing
    const dateObj = new Date(val);
    if (!isNaN(dateObj.getTime())) {
        return dateObj.toISOString().split('T')[0];
    }
    
    return str; // return original if all fails
}

function parseDate(val) {
    if (!val) return "";
    if (val instanceof Date) {
        return val.toISOString().split('T')[0];
    }
    try {
        const serial = Number(val);
        if (typeof val === 'number' || (!isNaN(serial) && String(val).trim() !== "" && !isNaN(parseFloat(val)))) {
            const date = new Date(Math.round((serial - 25569) * 86400 * 1000));
            if (!isNaN(date.getTime())) {
                return date.toISOString().split('T')[0];
            }
        }
    } catch (e) {
        console.error("Erro ao converter data serial validade:", e);
    }
    // String parsing
    const str = String(val).trim();
    
    // Check if it matches a date range like "10-16 Jul" or "8-14 JUL"
    const rangeMatch = str.match(/(\d+)\s*[-/a]\s*(\d+)\s*(?:de\s+)?([A-Za-zçãõáéíóú]+)/i);
    if (rangeMatch) {
        const endDay = parseInt(rangeMatch[2], 10);
        const mName = rangeMatch[3].toLowerCase();
        let mNum = monthMap[mName];
        if (!mNum) {
            // Try matching first 3 characters
            mNum = monthMap[mName.substring(0, 3)];
        }
        if (mNum && !isNaN(endDay)) {
            const year = new Date().getFullYear();
            const paddedDay = String(endDay).padStart(2, '0');
            return `${year}-${mNum}-${paddedDay}`;
        }
    }

    const match = str.match(/(\d{4})[-/](\d{2})[-/](\d{2})/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
    const matchBR = str.match(/(\d{2})[-/](\d{2})[-/](\d{4})/);
    if (matchBR) return `${matchBR[3]}-${matchBR[2]}-${matchBR[1]}`;
    return str.split(' ')[0]; // standard string cutoff
}

/* ==========================================================================
   EXCEL & CSV FILE PARSER
   ========================================================================== */

function processFile(file) {
    // Uncollapse upload card so user sees progress/errors
    uploadSection.classList.remove('collapsed');
    uploadStatus.classList.remove('hidden');
    dropzone.classList.add('hidden');
    statusMessage.innerText = "Lendo arquivo " + file.name + "...";

    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            statusMessage.innerText = "Analisando planilha...";
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            
            let sheetsProcessed = [];
            let ratesLoaded = 0;
            let spaceLoaded = 0;
            let operationalLoaded = 0;

            const fileNameUpper = file.name.toUpperCase();
            const fileNameHintSpace = fileNameUpper.includes('SPACE');
            const fileNameHintOperational = fileNameUpper.includes('OPERACIONAL') || fileNameUpper.includes('OPERATIONAL');

            // Arrays to store parsed data from this workbook
            let parsedRates = [];
            let parsedSpace = [];
            let parsedOperational = [];

            let ratesSheetFound = false;
            let spaceSheetFound = false;
            let operationalSheetFound = false;

            // Iterate over all sheets in the workbook
            for (const sheetName of workbook.SheetNames) {
                const worksheet = workbook.Sheets[sheetName];
                const jsonRows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
                if (jsonRows.length < 2) {
                    console.log(`[processFile] Aba "${sheetName}" pulada por conter menos de 2 linhas.`);
                    continue;
                }

                let headerRowIndex = -1;
                let colMap = null;
                let isSpaceSheet = false;
                let isOperationalSheet = false;

                const sheetNameUpper = sheetName.toUpperCase();
                const sheetNameHintSpace = sheetNameUpper.includes('SPACE');

                // Search for headers in the first 10 rows
                for (let r = 0; r < Math.min(10, jsonRows.length); r++) {
                    const row = jsonRows[r];
                    if (!row || row.length === 0) continue;
                    
                    const headers = Array.from(row).map(h => String(h || '').trim().toLowerCase());
                    
                    const getColIndex = (aliases) => {
                        const cleanHeaders = Array.from(headers).map(h => String(h || '').toLowerCase().trim());
                        for (const alias of aliases) {
                            const cleanAlias = String(alias).toLowerCase().trim();
                            const idx = cleanHeaders.indexOf(cleanAlias);
                            if (idx !== -1) return idx;
                        }
                        for (const alias of aliases) {
                            const cleanAlias = String(alias).toLowerCase().trim();
                            for (let i = 0; i < cleanHeaders.length; i++) {
                                const h = cleanHeaders[i];
                                if (!h) continue;
                                if ((cleanAlias === 'validade' || cleanAlias === 'fim' || cleanAlias === 'dt fim') && 
                                    (h.includes('inicio') || h.includes('início') || h.includes('start'))) {
                                    continue;
                                }
                                if ((cleanAlias === 'inicio' || cleanAlias === 'dt inicio') && 
                                    (h.includes('fim') || h.includes('end'))) {
                                    continue;
                                }
                                if (h.includes(cleanAlias)) return i;
                            }
                        }
                        return -1;
                    };

                    const polIdx = getColIndex(['pol']);
                    const podIdx = getColIndex(['pod']);
                    const volIdx = getColIndex(['vol']);
                    const etdIdx = getColIndex(['etd']);
                    const qtdIdx = getColIndex(['qtd', 'quantidade', 'qty']);
                    const tipoCntrIdx = getColIndex(['tipo cntr', 'tipo container', 'tipo de container', 'cntr', 'tp cntr', 'size', 'tipo', 'equip', 'equip.']);

                    const hasOldSpaceHeaders = volIdx !== -1 && etdIdx !== -1;
                    const hasNewSpaceHeaders = (qtdIdx !== -1 || tipoCntrIdx !== -1) && etdIdx !== -1;
                    const hasBasicOrigemDestino = (polIdx !== -1 || getColIndex(['origem', 'origin']) !== -1) && 
                                                  (podIdx !== -1 || getColIndex(['destino', 'destination']) !== -1);

                    const isExplicitRateSheetName = sheetNameUpper.includes('BASE') || 
                                                    sheetNameUpper.includes('FRETES') || 
                                                    sheetNameUpper.includes('TARIFAS') || 
                                                    sheetNameUpper.includes('TARIFARIO') || 
                                                    sheetNameUpper.includes('CONVENCIONAL');

                    // 1. Check if Space on Hand
                    if (hasOldSpaceHeaders || hasNewSpaceHeaders || (sheetNameHintSpace && hasBasicOrigemDestino) || (fileNameHintSpace && hasBasicOrigemDestino && !isExplicitRateSheetName)) {
                        isSpaceSheet = true;
                        headerRowIndex = r;
                        colMap = {
                            agente: getColIndex(['agente', 'agent']),
                            origem: polIdx !== -1 ? polIdx : getColIndex(['origem', 'origin']),
                            destino: podIdx !== -1 ? podIdx : getColIndex(['destino', 'destination']),
                            vol: volIdx,
                            qtd: qtdIdx,
                            tipoCntr: tipoCntrIdx,
                            etd: etdIdx !== -1 ? etdIdx : getColIndex(['etd', 'saida', 'sailing', 'data']),
                            valor: getColIndex(['frete', 'valor', 'price', 'freight', 'vl. frete']),
                            freetime: getColIndex(['free time', 'freetime']),
                            armador: getColIndex(['armador', 'carrier', 'linha']),
                            observacao: getColIndex(['observação', 'observacao', 'obs', 'remarks'])
                        };
                        console.log(`[processFile] Aba "${sheetName}" detectada como SPACE. oldHeaders=${hasOldSpaceHeaders}, newHeaders=${hasNewSpaceHeaders}, sheetHint=${sheetNameHintSpace}`);
                        break;
                    }

                    // 2. Check if Operational
                    const processoIdx = getColIndex(['processo']);
                    const produtoIdx = getColIndex(['produto']);
                    const containersIdx = getColIndex(['containers']);
                    if (processoIdx !== -1 && produtoIdx !== -1 && containersIdx !== -1) {
                        isOperationalSheet = true;
                        headerRowIndex = r;
                        colMap = {
                            processo: processoIdx,
                            produto: produtoIdx,
                            cliente: getColIndex(['cliente']),
                            modalidade: getColIndex(['modalidade de frete', 'modalidade']),
                            agente: getColIndex(['agente', 'agent']),
                            origemCarga: getColIndex(['origem da carga']),
                            origemEmbarque: getColIndex(['origem do embarque']),
                            destino: getColIndex(['destino']),
                            previsaoSaida: getColIndex(['previsão de saída', 'previsao de saida', 'saida', 'etd']),
                            containers: containersIdx,
                            freteFornecedor: getColIndex(['fornecedor do frete']),
                            valorMC: getColIndex(['valor mc']),
                            moedaMC: getColIndex(['moeda mc']),
                            valorInv: getColIndex(['valor inv.']),
                            moedaInv: getColIndex(['moeda inv.']),
                            status: getColIndex(['status']),
                            dataAbertura: getColIndex(['data de abertura'])
                        };
                        console.log(`[processFile] Aba "${sheetName}" detectada como OPERACIONAL.`);
                        break;
                    }
                }

                // 3. Fallback: Check if Conventional Rates
                if (headerRowIndex === -1 && !isSpaceSheet && !isOperationalSheet) {
                    for (let r = 0; r < Math.min(10, jsonRows.length); r++) {
                        const row = jsonRows[r];
                        if (!row || row.length === 0) continue;
                        
                        const headers = Array.from(row).map(h => String(h || '').trim().toLowerCase());
                        
                        const getColIndex = (aliases) => {
                            const cleanHeaders = Array.from(headers).map(h => String(h || '').toLowerCase().trim());
                            for (const alias of aliases) {
                                const cleanAlias = String(alias).toLowerCase().trim();
                                const idx = cleanHeaders.indexOf(cleanAlias);
                                if (idx !== -1) return idx;
                            }
                            for (const alias of aliases) {
                                const cleanAlias = String(alias).toLowerCase().trim();
                                for (let i = 0; i < cleanHeaders.length; i++) {
                                    const h = cleanHeaders[i];
                                    if (!h) continue;
                                    if ((cleanAlias === 'validade' || cleanAlias === 'fim' || cleanAlias === 'dt fim') && 
                                        (h.includes('inicio') || h.includes('início') || h.includes('start'))) {
                                        continue;
                                    }
                                    if ((cleanAlias === 'inicio' || cleanAlias === 'dt inicio') && 
                                        (h.includes('fim') || h.includes('end'))) {
                                        continue;
                                    }
                                    if (h.includes(cleanAlias)) return i;
                                }
                            }
                            return -1;
                        };

                        const tempMap = {
                            agente: getColIndex(['agente']),
                            armador: getColIndex(['armador', 'carrier', 'linha']),
                            origem: getColIndex(['origem', 'origin', 'pol']),
                            destino: getColIndex(['destino', 'destination', 'pod']),
                            moeda: getColIndex(['moeda', 'curr']),
                            valor: getColIndex(['vl. frete', 'vl frete', 'valor', 'frete', 'price', 'value']),
                            container: getColIndex(['tp container', 'tp_container', 'tipo', 'container', 'tipo de container', 'size', 'tp']),
                            freetime: getColIndex(['free time', 'free_time', 'freetime', 'demurrage']),
                            inicio: getColIndex(['dt inicio', 'dt_inicio', 'inicio', 'validade inicio', 'start']),
                            fim: getColIndex(['dt fim', 'dt_fim', 'fim', 'validade fim', 'end', 'validade', 'validity', 'val']),
                            observacao: getColIndex(['obs', 'observacao', 'observacoes', 'notes', 'remarks'])
                        };

                        if (tempMap.origem !== -1 && tempMap.destino !== -1 && tempMap.valor !== -1) {
                            headerRowIndex = r;
                            colMap = tempMap;
                            break;
                        }
                    }
                    if (headerRowIndex !== -1) {
                        console.log(`[processFile] Aba "${sheetName}" detectada como TARIFÁRIO CONVENCIONAL.`);
                    }
                }

                // If headers not found, skip this sheet
                if (headerRowIndex === -1 || !colMap) {
                    console.log(`[processFile] Aba "${sheetName}" ignorada por falta de colunas essenciais.`);
                    continue;
                }

                const prevRatesCount = parsedRates.length;
                const prevSpaceCount = parsedSpace.length;
                const prevOpCount = parsedOperational.length;

                // Parse sheet rows
                for (let i = headerRowIndex + 1; i < jsonRows.length; i++) {
                    const row = jsonRows[i];
                    if (!row || row.length === 0) continue;

                    if (isOperationalSheet) {
                        const prodVal = colMap.produto !== -1 && row[colMap.produto] ? String(row[colMap.produto]).toLowerCase() : "";
                        const modVal = colMap.modalidade !== -1 && row[colMap.modalidade] ? String(row[colMap.modalidade]).toUpperCase() : "";
                        const isMaritime = prodVal.includes('marít') || prodVal.includes('marit') || prodVal.includes('ocean') || prodVal.includes('sea');
                        const isFcl = modVal.includes('FCL') || String(row[colMap.containers] || '').toUpperCase().includes('X40') || String(row[colMap.containers] || '').toUpperCase().includes('X20') || String(row[colMap.containers] || '').toUpperCase().includes('*40') || String(row[colMap.containers] || '').toUpperCase().includes('*20');
                        
                        if (!isMaritime || !isFcl) continue;
                        
                        const polVal = colMap.origemEmbarque !== -1 && row[colMap.origemEmbarque] 
                            ? String(row[colMap.origemEmbarque]).trim() 
                            : (colMap.origemCarga !== -1 && row[colMap.origemCarga] ? String(row[colMap.origemCarga]).trim() : "");
                        const podVal = colMap.destino !== -1 && row[colMap.destino] ? String(row[colMap.destino]).trim() : "";
                        if (!polVal && !podVal) continue;
                        
                        const containersVal = colMap.containers !== -1 ? row[colMap.containers] : "";
                        let qtd = 1;
                        let rawContainer = String(containersVal || '').trim();
                        const match = rawContainer.match(/^(\d+)\s*[xX*]\s*(.*)$/);
                        if (match) {
                            qtd = parseInt(match[1]) || 1;
                            rawContainer = match[2].trim();
                        }
                        const containerNormalized = extractContainerType(rawContainer);
                        
                        let valFrete = 0;
                        let currency = "USD";
                        if (colMap.valorMC !== -1 && row[colMap.valorMC]) {
                            valFrete = parseBrNumber(row[colMap.valorMC]);
                            if (colMap.moedaMC !== -1 && row[colMap.moedaMC]) currency = String(row[colMap.moedaMC]).trim().toUpperCase();
                        } else if (colMap.valorInv !== -1 && row[colMap.valorInv]) {
                            valFrete = parseBrNumber(row[colMap.valorInv]);
                            if (colMap.moedaInv !== -1 && row[colMap.moedaInv]) currency = String(row[colMap.moedaInv]).trim().toUpperCase();
                        }
                        
                        parsedOperational.push({
                            processo: colMap.processo !== -1 && row[colMap.processo] ? String(row[colMap.processo]).trim() : "N/A",
                            produto: colMap.produto !== -1 && row[colMap.produto] ? String(row[colMap.produto]).trim() : "Importação Marítima",
                            cliente: colMap.cliente !== -1 && row[colMap.cliente] ? String(row[colMap.cliente]).trim() : "N/A",
                            modalidade: "FCL",
                            agente: colMap.agente !== -1 && row[colMap.agente] ? String(row[colMap.agente]).trim() : (colMap.freteFornecedor !== -1 && row[colMap.freteFornecedor] ? String(row[colMap.freteFornecedor]).trim() : "N/A"),
                            origem: polVal,
                            destino: podVal,
                            moeda: currency,
                            valor: isNaN(valFrete) ? 0 : valFrete,
                            container: containerNormalized,
                            qtdSpace: qtd,
                            freetime: 0,
                            inicio: "",
                            fim: colMap.previsaoSaida !== -1 ? parseDate(row[colMap.previsaoSaida]) : "",
                            observacao: `Processo: ${colMap.processo !== -1 && row[colMap.processo] ? row[colMap.processo] : 'N/A'} | Cliente: ${colMap.cliente !== -1 && row[colMap.cliente] ? row[colMap.cliente] : 'N/A'}`,
                            source: "operational"
                        });
                        operationalSheetFound = true;
                    } else if (isSpaceSheet) {
                        const polVal = colMap.origem !== -1 ? row[colMap.origem] : "";
                        const podVal = colMap.destino !== -1 ? row[colMap.destino] : "";
                        if (!polVal && !podVal) continue;

                        const freteVal = colMap.valor !== -1 ? row[colMap.valor] : 0;
                        const valFrete = parseBrNumber(freteVal);
                        
                        let qtd = 1;
                        let rawContainer = '';
                        
                        if (colMap.qtd !== -1 || colMap.tipoCntr !== -1) {
                            if (colMap.qtd !== -1 && row[colMap.qtd] != null) {
                                qtd = parseInt(String(row[colMap.qtd]).replace(/[^0-9]/g, '')) || 1;
                            } else if (colMap.vol !== -1 && row[colMap.vol] != null) {
                                qtd = parseInt(String(row[colMap.vol]).replace(/[^0-9]/g, '')) || 1;
                            }
                            if (colMap.tipoCntr !== -1 && row[colMap.tipoCntr]) {
                                rawContainer = String(row[colMap.tipoCntr]).trim();
                            }
                        } else if (colMap.vol !== -1) {
                            const volVal = row[colMap.vol] || '';
                            rawContainer = String(volVal).trim();
                            const match = rawContainer.match(/^(\d+)\s*[xX*]\s*(.*)$/);
                            if (match) {
                                qtd = parseInt(match[1]) || 1;
                                rawContainer = match[2].trim();
                            }
                        }
                        const containerNormalized = normalizeContainer(rawContainer);
                        const etdVal = colMap.etd !== -1 ? row[colMap.etd] : "";
                        const formattedEtd = parseEtdDate(etdVal);
                        
                        parsedSpace.push({
                            agente: colMap.agente !== -1 && row[colMap.agente] ? String(row[colMap.agente]).trim() : "REACH",
                            armador: colMap.armador !== -1 && row[colMap.armador] ? String(row[colMap.armador]).trim() : "N/A",
                            origem: String(polVal).trim(),
                            destino: String(podVal).trim(),
                            moeda: "USD",
                            valor: isNaN(valFrete) ? 0 : valFrete,
                            container: containerNormalized,
                            qtdSpace: qtd,
                            freetime: colMap.freetime !== -1 && row[colMap.freetime] ? parseInt(String(row[colMap.freetime]).replace(/[^0-9]/g, '')) || 0 : 0,
                            inicio: "",
                            fim: formattedEtd,
                            observacao: colMap.observacao !== -1 && row[colMap.observacao] ? String(row[colMap.observacao]).trim() : "",
                            source: "space"
                        });
                        spaceSheetFound = true;
                    } else {
                        const polVal = colMap.origem !== -1 ? row[colMap.origem] : "";
                        const podVal = colMap.destino !== -1 ? row[colMap.destino] : "";
                        if (!polVal && !podVal) continue;

                        const valFrete = parseBrNumber(row[colMap.valor]);
                        const formattedFim = colMap.fim !== -1 ? parseDate(row[colMap.fim]) : "";
                        
                        parsedRates.push({
                            agente: colMap.agente !== -1 && row[colMap.agente] ? String(row[colMap.agente]).trim() : "Mond Shipping",
                            armador: colMap.armador !== -1 && row[colMap.armador] ? String(row[colMap.armador]).trim() : "N/A",
                            origem: String(polVal).trim(),
                            destino: String(podVal).trim(),
                            moeda: colMap.moeda !== -1 && row[colMap.moeda] ? String(row[colMap.moeda]).trim() : "USD",
                            valor: isNaN(valFrete) ? 0 : valFrete,
                            container: colMap.container !== -1 && row[colMap.container] ? String(row[colMap.container]).trim() : "40' DRY",
                            freetime: colMap.freetime !== -1 && row[colMap.freetime] ? parseInt(String(row[colMap.freetime]).replace(/[^0-9]/g, '')) || 0 : 0,
                            inicio: colMap.inicio !== -1 ? parseDate(row[colMap.inicio]) : "",
                            fim: formattedFim,
                            observacao: colMap.observacao !== -1 && row[colMap.observacao] ? String(row[colMap.observacao]).trim() : "",
                            source: "rate"
                        });
                        ratesSheetFound = true;
                    }
                }

                const ratesAdded = parsedRates.length - prevRatesCount;
                const spaceAdded = parsedSpace.length - prevSpaceCount;
                const opAdded = parsedOperational.length - prevOpCount;

                if (isOperationalSheet && opAdded > 0) {
                    sheetsProcessed.push(`${sheetName} (Operacional)`);
                    operationalLoaded += opAdded;
                } else if (isSpaceSheet && spaceAdded > 0) {
                    sheetsProcessed.push(`${sheetName} (Space on Hand)`);
                    spaceLoaded += spaceAdded;
                } else if (!isOperationalSheet && !isSpaceSheet && ratesAdded > 0) {
                    sheetsProcessed.push(`${sheetName} (Tarifário)`);
                    ratesLoaded += ratesAdded;
                }
            }

            if (sheetsProcessed.length === 0) {
                throw new Error("Nenhum dado válido de Tarifas, Space on Hand ou Processos Operacionais foi encontrado em nenhuma das abas da planilha.");
            }

            // Save only the data types that were actually found in the uploaded file
            if (ratesSheetFound && parsedRates.length > 0) {
                appRates = parsedRates;
                mondStorage.setItemSync('mond-rates', JSON.stringify(appRates));
            }
            if (spaceSheetFound && parsedSpace.length > 0) {
                appSpace = parsedSpace;
                mondStorage.setItemSync('mond-space', JSON.stringify(appSpace));
            }
            if (operationalSheetFound && parsedOperational.length > 0) {
                appOperational = parsedOperational;
                mondStorage.setItemSync('mond-operational', JSON.stringify(appOperational));
            }
            
            // Push updated tariffs to central Cloud DB so entire team sees them
            pushSharedCustomData();

            let msgParts = [];
            if (ratesLoaded > 0) msgParts.push(`${ratesLoaded} tarifas`);
            if (spaceLoaded > 0) msgParts.push(`${spaceLoaded} spaces`);
            if (operationalLoaded > 0) msgParts.push(`${operationalLoaded} processos`);
            statusMessage.innerText = `Sucesso! Carregado: ${msgParts.join(' e ')} (Abas: ${sheetsProcessed.join(', ')}).`;

            setTimeout(() => {
                uploadSection.classList.add('collapsed');
                uploadStatus.classList.add('hidden');
                dropzone.classList.remove('hidden');
                
                // Reinitialize everything with new data
                initFilterDropdowns();
                window.populateObsCategoryDropdown();
                updateDashboardCards();
                resetAllFilters();
                renderIntelTab();
                renderAnalysisTab();
            }, 1500);

        } catch (err) {
            console.error(err);
            statusMessage.innerHTML = `<span style="color:var(--danger)">Erro: ${err.message}</span>`;
            setTimeout(() => {
                uploadStatus.classList.add('hidden');
                dropzone.classList.remove('hidden');
            }, 4000);
        }
    };
    
    reader.onerror = function () {
        statusMessage.innerHTML = `<span style="color:var(--danger)">Erro na leitura do arquivo.</span>`;
        setTimeout(() => {
            uploadStatus.classList.add('hidden');
            dropzone.classList.remove('hidden');
        }, 3000);
    };

    reader.readAsArrayBuffer(file);
}

/* ==========================================================================
   NLP - NATURAL LANGUAGE QUERY ENGINE (IA HEURÍSTICA)
   ========================================================================== */

function parseNlpQuery(query) {
    const text = query.toLowerCase().trim();
    
    // Reset temporary NLP filter tags
    resetNlpFilters(false);
    
    // Get unique list of locations from data to perform dictionary match
    const combinedData = [...appRates, ...appSpace, ...appOperational];
    const origens = [...new Set(combinedData.map(r => r.origem.toLowerCase()))];
    const destinos = [...new Set(combinedData.map(r => r.destino.toLowerCase()))];
    const armadores = [...new Set(combinedData.map(r => (r.armador || '').toLowerCase()))];
    
    // Look for origin and destination based on prepositions: "de [POL] para [POD]" ou "[POL] [POD]"
    // First, let's identify any exact matching locations in the string
    let foundOrigem = null;
    let foundDestino = null;
    let foundArmador = null;
    let foundContainer = null;

    // Direct Prepositions analysis
    const deMatch = text.match(/(?:de|desde|pol|origem)\s+([a-z\s\u00C0-\u00FF]+?)(?=\s+(?:para|a|pod|destino|no|com|cma|msc|20|40|$))/i);
    const paraMatch = text.match(/(?:para|a|pod|destino|em|no)\s+([a-z\s\u00C0-\u00FF]+?)(?=\s+(?:de|desde|pol|origem|com|cma|msc|20|40|$))/i);

    if (deMatch) {
        const val = deMatch[1].trim();
        foundOrigem = origens.find(o => o.includes(val) || val.includes(o));
    }
    if (paraMatch) {
        const val = paraMatch[1].trim();
        foundDestino = destinos.find(d => d.includes(val) || val.includes(d));
    }

    // Heuristic: If we don't have explicit prepositions, let's scan word list
    const words = text.split(/[\s,]+/);

    // Filter out filler words
    const fillers = ['de', 'para', 'em', 'um', 'frete', 'melhor', 'mond', 'shipping', 'a', 'com'];
    const activeWords = words.filter(w => !fillers.includes(w));

    // Scan for Container Type indicators (e.g. 20, 40, hc, high, cube, dry)
    if (text.includes('20') && text.includes('dry')) {
        foundContainer = "20' DRY";
    } else if (text.includes('20')) {
        foundContainer = "20' DRY"; // default 20
    } else if ((text.includes('40') && text.includes('hc')) || text.includes('high') || text.includes('cube') || text.includes('hc')) {
        foundContainer = "40' HIGH CUBE";
    } else if (text.includes('40') && text.includes('dry')) {
        foundContainer = "40' DRY";
    } else if (text.includes('40')) {
        // Look up first matching 40 in actual rates
        const match = [...new Set(combinedData.map(r => r.container))].find(c => c.includes('40'));
        foundContainer = match || "40' HIGH CUBE";
    }

    // Scan for Armadores (e.g. CMA, MSC, COSCO, MAERSK, etc.)
    for (const carrier of armadores) {
        if (text.includes(carrier) || carrier.split(' ').some(part => part.length > 2 && text.includes(part))) {
            // Find official name casing from dataset
            const matchItem = combinedData.find(r => (r.armador || '').toLowerCase() === carrier);
            foundArmador = matchItem ? matchItem.armador : "N/A";
            break;
        }
    }

    // If locations were not found via prepositions, match activeWords against unique lists
    if (!foundOrigem) {
        // Try exact match on unique origens
        for (const w of activeWords) {
            const match = origens.find(orig => orig === w || orig.includes(w));
            if (match) {
                const matchItem = combinedData.find(r => r.origem.toLowerCase() === match);
                foundOrigem = matchItem ? matchItem.origem : null;
                break;
            }
        }
    } else {
        // Convert matched lowercase string to actual cased database string
        const matchItem = combinedData.find(r => r.origem.toLowerCase() === foundOrigem);
        foundOrigem = matchItem ? matchItem.origem : null;
    }

    if (!foundDestino) {
        // Try exact match on unique destinos (making sure it is not the same word matching origin)
        for (const w of activeWords) {
            const match = destinos.find(dest => dest === w || dest.includes(w));
            if (match && (!foundOrigem || match !== foundOrigem.toLowerCase())) {
                const matchItem = combinedData.find(r => r.destino.toLowerCase() === match);
                foundDestino = matchItem ? matchItem.destino : null;
                break;
            }
        }
    } else {
        // Convert cased database string
        const matchItem = combinedData.find(r => r.destino.toLowerCase() === foundDestino);
        foundDestino = matchItem ? matchItem.destino : null;
    }

    // Apply parsed values to active NLP Filters
    activeNlpFilters.origem = foundOrigem;
    activeNlpFilters.destino = foundDestino;
    activeNlpFilters.container = foundContainer;
    activeNlpFilters.armador = foundArmador;

    // Render NLP Filter Chips
    renderNlpChips();

    // Trigger grid filter reload
    applyFilters();
}

function renderNlpChips() {
    nlpChips.innerHTML = "";
    let hasChips = false;

    const createChip = (label, val, type) => {
        hasChips = true;
        const chip = document.createElement('div');
        chip.className = 'chip';
        chip.innerHTML = `
            <span><strong>${label}:</strong> ${val}</span>
            <span class="chip-remove" onclick="removeNlpFilter('${type}')">&times;</span>
        `;
        nlpChips.appendChild(chip);
    };

    if (activeNlpFilters.origem) createChip("Origem", activeNlpFilters.origem, "origem");
    if (activeNlpFilters.destino) createChip("Destino", activeNlpFilters.destino, "destino");
    if (activeNlpFilters.container) createChip("Container", activeNlpFilters.container, "container");
    if (activeNlpFilters.armador) createChip("Armador", activeNlpFilters.armador, "armador");

    if (hasChips) {
        nlpChipsContainer.classList.remove('hidden');
    } else {
        nlpChipsContainer.classList.add('hidden');
    }
}

// Global scope helper for chip removal
window.removeNlpFilter = function(type) {
    activeNlpFilters[type] = null;
    renderNlpChips();
    
    // Also remove from query string if user is typing
    let query = nlpInput.value;
    if (type === "origem") query = query.replace(/de\s+\w+/i, '').replace(new RegExp(activeNlpFilters.origem, 'gi'), '');
    if (type === "destino") query = query.replace(/para\s+\w+/i, '').replace(new RegExp(activeNlpFilters.destino, 'gi'), '');
    
    nlpInput.value = query.replace(/\s+/g, ' ').trim();
    if (nlpInput.value === "") {
        btnClearSearch.classList.remove('visible');
    }

    applyFilters();
};

function resetNlpFilters(apply = true) {
    activeNlpFilters = { origem: null, destino: null, container: null, armador: null };
    nlpChipsContainer.classList.add('hidden');
    nlpChips.innerHTML = "";
    if (apply) {
        applyFilters();
    }
}

/* ==========================================================================
   DROPDOWNS & FILTER GRID PROCESS
   ========================================================================== */

function initFilterDropdowns() {
    // Pure free-text inputs are used for advanced filters. Datalists removed to avoid browser popups.
}

function updateValidityFilterUI(value) {
    if (selectValidade) selectValidade.value = value;
    
    const colFilterValidade = document.getElementById('col-filter-validade');
    if (colFilterValidade) colFilterValidade.value = value;
    
    document.querySelectorAll('#validity-pills .pill-btn').forEach(btn => {
        if (btn.getAttribute('data-value') === value) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

function resetAllFilters() {
    selectOrigem.value = "";
    selectDestino.value = "";
    selectContainer.value = "";
    selectArmador.value = "";
    
    // Reset col filters state and UI inputs
    colFilters.origem = "";
    colFilters.destino = "";
    colFilters.container = "";
    colFilters.armador = "";
    colFilters.agente = "";
    colFilters.freetime = "";
    colFilters.obs = "";
    
    document.getElementById('col-filter-origem').value = "";
    document.getElementById('col-filter-destino').value = "";
    document.getElementById('col-filter-container').value = "";
    document.getElementById('col-filter-armador').value = "";
    document.getElementById('col-filter-agente').value = "";
    document.getElementById('col-filter-freetime').value = "";

    // Reset column multi filters
    for (const key of Object.keys(columnMultiFilters)) {
        delete columnMultiFilters[key];
    }
    for (const key of Object.keys(columnMultiFilterActive)) {
        delete columnMultiFilterActive[key];
    }
    document.querySelectorAll('th.col-filterable').forEach(th => {
        th.classList.remove('col-filter-active');
    });

    nlpInput.value = "";
    btnClearSearch.classList.remove('visible');
    resetNlpFilters(false);
    
    // Reset validity filter default
    updateValidityFilterUI("ativas");
    
    // Reset validade date filter
    validadeDateFilterActive = false;
    selectedValidadeDates.clear();
    updateValidadeLabel();
    
    // Reset cliente filter
    const filterClienteEl = document.getElementById('filter-cliente');
    if (filterClienteEl) filterClienteEl.value = '';

    // Reset agente top filter
    const filterAgenteTopEl = document.getElementById('filter-agente-top');
    if (filterAgenteTopEl) filterAgenteTopEl.value = '';

    // Reset país origem filter
    const filterPaisEl = document.getElementById('filter-pais-origem');
    if (filterPaisEl) filterPaisEl.value = '';

    // Reset fase filter
    faseFilterActive = false;
    selectedFases.clear();
    updateFaseLabel();

    // Reset situação filter back to default (Aberto only)
    situacaoFilterActive = true;
    selectedSituacao.clear();
    selectedSituacao.add('Aberto');
    updateSituacaoLabel();

    // Reset sort default
    currentSortField = "valor";
    currentSortDirection = "asc";
    selectSortBy.value = "Vl. Frete-asc";

    // Reset freight target analyzer
    const filterFreightTargetEl = document.getElementById('filter-frete-target');
    if (filterFreightTargetEl) filterFreightTargetEl.value = '';
    const topAnalyzerResultsEl = document.getElementById('top-analyzer-results');
    if (topAnalyzerResultsEl) topAnalyzerResultsEl.style.display = 'none';

    // Reset obs category multi-select to all checked
    document.querySelectorAll('#obs-options input[type="checkbox"]').forEach(cb => cb.checked = true);
    if (typeof updateObsLabel === 'function') updateObsLabel();

    window.activeRoutePairs.clear();
    applyFilters();
}

window.buildSubtableObsDropdownHtml = function(savingRates, gIdx) {
    // Specific cargo segments (highest priority)
    const CARGO_SEGMENTS = [
        { value: 'pneu', label: '🚗 Pneus / Auto', keywords: ['pneu', 'autopeça', 'auto-peça', 'autoparts', 'auto parts', 'autopeças', 'e-goods', 'borracha', 'tire', 'tyre'] },
        { value: 'textil', label: '👕 Têxtil', keywords: ['textil', 'têxtil', 'textile'] },
        { value: 'ows', label: '⚖️ OWS', keywords: ['ows', 'overweight'] },
        { value: 'maquina', label: '⚙️ Máquinas', keywords: ['maquina', 'maquinário', 'machinery', 'metal'] },
        { value: 'imo', label: '☣️ IMO', keywords: ['imo', 'perigosa', 'dangerous'] },
        { value: 'bateria', label: '🔋 Bateria', keywords: ['bateria', 'battery', 'lithium'] },
        { value: 'reefer', label: '❄️ Reefer', keywords: ['reefer', 'refrigerado', 'congelado'] }
    ];
    // Fallback categories (only when no specific cargo found)
    const NAC_KEYWORDS = ['nac', 'named account'];
    const SPOT_KEYWORDS = ['spot', 'promo'];
    
    // Classify each rate with hierarchy: cargo > NAC > spot > geral
    function classifyRate(obs) {
        const obsLower = (obs || '').toLowerCase();
        const cats = new Set();
        
        // 1. Check specific cargo segments first
        CARGO_SEGMENTS.forEach(seg => {
            if (seg.keywords.some(kw => obsLower.includes(kw))) cats.add(seg.value);
        });
        
        // 2. If specific cargo found, return those (ignore NAC/spot)
        if (cats.size > 0) return cats;
        
        // 3. Check NAC (fallback)
        if (NAC_KEYWORDS.some(kw => obsLower.includes(kw))) {
            cats.add('nac');
            return cats;
        }
        
        // 4. Check spot/promo (fallback)
        if (SPOT_KEYWORDS.some(kw => obsLower.includes(kw))) {
            cats.add('promo');
            return cats;
        }
        
        // 5. Nothing matched = Sem Restrição
        cats.add('geral');
        return cats;
    }
    
    // All possible display categories
    const ALL_CATS = [
        { value: 'geral', label: '📦 Sem Restrição' },
        { value: 'nac', label: '🔒 NAC' },
        ...CARGO_SEGMENTS,
        { value: 'promo', label: '⚡ Spot / Promo' }
    ];
    
    // Detect & count
    const detected = new Set();
    const counts = {};
    ALL_CATS.forEach(c => { counts[c.value] = 0; });
    
    savingRates.forEach(opt => {
        const cats = classifyRate(opt.observacao);
        cats.forEach(c => {
            detected.add(c);
            counts[c] = (counts[c] || 0) + 1;
        });
    });
    
    // Build toggle chips
    let html = `<div class="obs-chips-wrapper" data-gidx="${gIdx}">`;
    ALL_CATS.forEach(cat => {
        if (!detected.has(cat.value)) return;
        html += `<button type="button" class="obs-chip active" data-cat="${cat.value}" onclick="toggleObsChip(this, ${gIdx})">${cat.label} <span class="obs-chip-count">${counts[cat.value]}</span></button>`;
    });
    html += `</div>`;
    return html;
};

window.populateObsCategoryDropdown = function() {
    const select = document.getElementById('filter-obs-category');
    if (!select) return;
    
    select.innerHTML = `
        <option value="all">🔍 Qualquer Carga</option>
        <option value="geral">📦 Carga Geral (Sem restrições)</option>
        <option value="pneu">🚗 Pneus / Autopeças</option>
        <option value="solar">☀️ Painel Solar</option>
        <option value="vidro">🥛 Vidro</option>
        <option value="textil">👕 Têxtil</option>
        <option value="ows">⚖️ OWS / Carga Pesada</option>
        <option value="promo">⚡ Promoções / Spot</option>
    `;
    
    const allData = [...appRates, ...appSpace, ...appOperational, ...appComercial];
    
    // Whitelist mapping of commodity words to clean labels
    const whitelist = {
        'imo': { label: '☣️ IMO (Carga Perigosa)', keywords: ['imo', 'perigosa', 'un '] },
        'bateria': { label: '🔋 Bateria / Lithium', keywords: ['bateria', 'battery', 'lithium'] },
        'quimico': { label: '🧪 Químicos', keywords: ['quimico', 'químico', 'chemical'] },
        'madeira': { label: '🪵 Madeira / Celulose', keywords: ['madeira', 'wood', 'papel', 'cellulose'] },
        'alimento': { label: '🍎 Alimentos / Bebidas', keywords: ['alimento', 'food', 'bebida'] },
        'maquina': { label: '⚙️ Maquinário / Aço', keywords: ['maquina', 'maquinario', 'machinery', 'aço', 'metal'] },
        'plastico': { label: '🥤 Plásticos / Resinas', keywords: ['plastico', 'plástico', 'plastic', 'resina'] },
        'borracha': { label: '🛞 Borracha', keywords: ['borracha', 'rubber'] },
        'reefer': { label: '❄️ Carga Refrigerada', keywords: ['reefer', 'rf', 'refrigerado', 'congelado'] }
    };
    
    const detectedCategories = new Set();
    
    allData.forEach(r => {
        if (!r.observacao) return;
        const obsLower = r.observacao.toLowerCase();
        
        Object.entries(whitelist).forEach(([key, info]) => {
            const hasKeyword = info.keywords.some(kw => obsLower.includes(kw));
            if (hasKeyword) {
                detectedCategories.add(key);
            }
        });
    });
    
    if (detectedCategories.size > 0) {
        const optGroup = document.createElement('optgroup');
        optGroup.label = "🏷️ Cargas Especiais Detectadas";
        
        Array.from(detectedCategories).sort().forEach(key => {
            const info = whitelist[key];
            const opt = document.createElement('option');
            opt.value = `custom-${key}`;
            opt.textContent = info.label;
            optGroup.appendChild(opt);
        });
        
        select.appendChild(optGroup);
    }
};

function updateHeaderSortUI() {
    document.querySelectorAll('th.sortable').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
        const field = th.getAttribute('data-sort');
        if (field === currentSortField) {
            th.classList.add(currentSortDirection === 'asc' ? 'sort-asc' : 'sort-desc');
        }
    });
}

// Determine the operational phase of a process
function getProcessPhase(rate) {
    if (rate.confirmacaoAtracacao || rate.rawConfirmacaoAtracacao) return 'atracado';
    if (rate.confirmacaoEmbarque || rate.rawConfirmacaoEmbarque) return 'em-transito';
    if (rate.booking || rate.confirmacaoBooking) return 'pre-com-booking';
    return 'pre-sem-booking';
}

// Get a display label and color for the phase
function getPhaseDisplay(phase) {
    switch (phase) {
        case 'atracado': return { label: 'Atracado', color: '#10b981', bg: 'rgba(16,185,129,0.12)' };
        case 'em-transito': return { label: 'Em Trânsito', color: '#3b82f6', bg: 'rgba(59,130,246,0.12)' };
        case 'pre-com-booking': return { label: 'C/ Booking', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' };
        case 'pre-sem-booking': return { label: 'S/ Booking', color: '#ef4444', bg: 'rgba(239,68,68,0.12)' };
        default: return { label: '-', color: '#888', bg: 'transparent' };
    }
}

function applyFilters() {
    // 1. Fetch current filters (Use NLP filters as override if active)
    const filterOrigem = (activeNlpFilters.origem || selectOrigem.value).trim().toLowerCase();
    const filterDestino = (activeNlpFilters.destino || selectDestino.value).trim().toLowerCase();
    const filterContainer = (activeNlpFilters.container || selectContainer.value).trim().toLowerCase();
    const filterArmador = (activeNlpFilters.armador || selectArmador.value).trim().toLowerCase();
    const filterValidade = selectValidade.value;
    const filterClienteInput = document.getElementById('filter-cliente');
    const filterCliente = filterClienteInput ? filterClienteInput.value.trim().toLowerCase() : '';
    const filterAgenteTopInput = document.getElementById('filter-agente-top');
    const filterAgenteTop = filterAgenteTopInput ? filterAgenteTopInput.value.trim().toLowerCase() : '';
    const filterPaisOrigemInput = document.getElementById('filter-pais-origem');
    const filterPaisOrigem = filterPaisOrigemInput ? filterPaisOrigemInput.value.trim().toLowerCase() : '';
    const obsCategorySelect = document.getElementById('filter-obs-category');
    const filterObsCategory = typeof getSelectedObsCategories === 'function' ? getSelectedObsCategories() : 'all';

    const today = new Date();
    today.setHours(0,0,0,0);

    // Update traditional filters UI selection matching NLP values for clarity
    if (activeNlpFilters.origem) selectOrigem.value = activeNlpFilters.origem;
    if (activeNlpFilters.destino) selectDestino.value = activeNlpFilters.destino;
    if (activeNlpFilters.container) selectContainer.value = activeNlpFilters.container;
    if (activeNlpFilters.armador) selectArmador.value = activeNlpFilters.armador;

    // Show/hide status filter based on active database
    const filterGroupStatus = document.getElementById('filter-group-status');
    if (filterGroupStatus) {
        if (activeDb === "commercial" || activeDb === "all" || activeDb === "apiAll") {
            filterGroupStatus.style.display = "block";
        } else {
            filterGroupStatus.style.display = "none";
        }
    }

    // Abertura date range filter (for operational and commercial)
    const aberturaDeInput = document.getElementById('filter-abertura-de');
    const aberturaAteInput = document.getElementById('filter-abertura-ate');
    const aberturaDeVal = aberturaDeInput ? aberturaDeInput.value : '';
    const aberturaAteVal = aberturaAteInput ? aberturaAteInput.value : '';

    // Select base data based on active database tab
    let baseData = [];
    if (activeDb === "all") {
        const ratesWithTag = appRates.map(r => ({ ...r, source: 'rate' }));
        const spaceWithTag = appSpace.map(s => ({ ...s, source: 'space' }));
        baseData = [...ratesWithTag, ...spaceWithTag];
    } else if (activeDb === "rate") {
        baseData = appRates.map(r => ({ ...r, source: 'rate' }));
    } else if (activeDb === "space") {
        baseData = appSpace.map(s => ({ ...s, source: 'space' }));
    } else if (activeDb === "operational") {
        baseData = appOperational.map(o => ({ ...o, source: 'operational' }));
    } else if (activeDb === "commercial") {
        baseData = appComercial.map(c => ({ ...c, source: 'commercial' }));
    } else if (activeDb === "apiAll") {
        baseData = [
            ...appOperational.map(o => ({ ...o, source: 'operational' })),
            ...appComercial.map(c => ({ ...c, source: 'commercial' }))
        ];
    }

    // Hierarchical obs classification: cargo segment > NAC > spot > geral
    const OBS_CARGO_KW = {
        'pneu': ['pneu', 'autopeça', 'auto-peça', 'autoparts', 'auto parts', 'autopeças', 'e-goods', 'borracha', 'tire', 'tyre'],
        'textil': ['textil', 'têxtil', 'textile'],
        'ows': ['ows', 'overweight'],
        'custom-maquina': ['maquina', 'maquinário', 'machinery', 'metal'],
        'custom-imo': ['imo', 'perigosa', 'dangerous'],
        'custom-bateria': ['bateria', 'battery', 'lithium'],
        'custom-reefer': ['reefer', 'refrigerado', 'congelado']
    };
    const OBS_NAC_KW = ['nac', 'named account'];
    const OBS_SPOT_KW = ['spot', 'promo'];
    
    function classifyObs(obsText) {
        const cats = new Set();
        for (const [cat, kws] of Object.entries(OBS_CARGO_KW)) {
            if (kws.some(kw => obsText.includes(kw))) cats.add(cat);
        }
        if (cats.size > 0) return cats;
        if (OBS_NAC_KW.some(kw => obsText.includes(kw))) { cats.add('nac'); return cats; }
        if (OBS_SPOT_KW.some(kw => obsText.includes(kw))) { cats.add('promo'); return cats; }
        cats.add('geral');
        return cats;
    }

    // 2. Perform filter execution (supporting substring search on both panels and comma-separated lists)
    filteredRates = baseData.filter(rate => {
        // Validity status filtering
        if (rate.fim) {
            const endDate = new Date(rate.fim + "T00:00:00");
            const diffTime = endDate - today;
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            
            if (filterValidade === "ativas" && diffDays < 0) return false;
            if (filterValidade === "ativas_seguras" && diffDays <= 3) return false;
            if (filterValidade === "expirando" && (diffDays < 0 || diffDays > 3)) return false;
            if (filterValidade === "expiradas" && diffDays >= 0) return false;
        } else {
            if (filterValidade === "expirando" || filterValidade === "expiradas" || filterValidade === "ativas_seguras") return false;
        }

        // Semicolon-separated OR matching helper (accent-insensitive)
        // Uses semicolon as separator to avoid conflicts with names containing commas (e.g. "CO.,LTD")
        const stripAccents = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const matchesQuery = (rateVal, filterQuery) => {
            if (!filterQuery) return true;
            const normalizedVal = stripAccents(String(rateVal || '').toLowerCase());
            // Strip trailing separators added by autocomplete selection
            const cleanedQuery = filterQuery.replace(/[;\s]+$/, '').trim();
            if (!cleanedQuery) return true;
            // Split by semicolon for multi-value OR matching
            const parts = cleanedQuery.split(';').map(p => stripAccents(p.trim().toLowerCase())).filter(p => p !== "");
            if (parts.length === 0) return true;
            return parts.some(p => normalizedVal.includes(p));
        };

        // Origin and Dest Pair check (from Top Rotas dashboard select)
        if (window.activeRoutePairs && window.activeRoutePairs.size > 0) {
            const matchesPair = Array.from(window.activeRoutePairs).some(pair => {
                const [pairOrig, pairDest] = pair.split('|');
                const rateOrigClean = cleanPortName(rate.origem).toUpperCase();
                const rateDestClean = cleanPortName(rate.destino).toUpperCase();
                return rateOrigClean.includes(pairOrig) && rateDestClean.includes(pairDest);
            });
            if (!matchesPair) return false;
        } else {
            if (filterOrigem && !matchesQuery(rate.origem, filterOrigem)) return false;
            if (filterDestino && !matchesQuery(rate.destino, filterDestino)) return false;
        }
        
        const containerInfo = getContainerInfo(rate);
        if (filterContainer && !matchesQuery(containerInfo.type, filterContainer)) return false;
        if (filterArmador && !matchesQuery(rate.armador, filterArmador)) return false;
        if (filterCliente && !matchesQuery(rate.cliente, filterCliente)) return false;
        if (filterAgenteTop && !matchesQuery(rate.agente, filterAgenteTop)) return false;
        if (filterPaisOrigem && !matchesQuery(rate.paisOrigem, filterPaisOrigem)) return false;
        
        // Observation Category Filter (HIERARCHICAL: cargo > NAC > spot > geral)
        if (filterObsCategory !== 'all' && Array.isArray(filterObsCategory)) {
            const obsText = (rate.observacao || '').toLowerCase();
            const selectedCats = new Set(filterObsCategory);
            const rateCategories = classifyObs(obsText);
            
            // Rate passes if ANY of its categories is in the selected set
            let matchesAny = false;
            for (const cat of rateCategories) {
                if (selectedCats.has(cat)) { matchesAny = true; break; }
            }
            if (!matchesAny) return false;
        }
        
        // Phase multi-select filter (operational only)
        if (faseFilterActive && rate.source === 'operational') {
            if (selectedFases.size === 0) return false;
            const phase = getProcessPhase(rate);
            if (!selectedFases.has(phase)) return false;
        }
        
        // Situação filter (DS_STATUS_PROCESSO — operational only)
        if (situacaoFilterActive && rate.source === 'operational') {
            if (selectedSituacao.size === 0) return false;
            const sit = (rate.statusProcesso || 'Aberto').trim();
            if (!selectedSituacao.has(sit)) return false;
        }
        
        // Inline column filters
        if (colFilters.origem && !(rate.origem || '').toLowerCase().includes(colFilters.origem.toLowerCase())) return false;
        if (colFilters.destino && !(rate.destino || '').toLowerCase().includes(colFilters.destino.toLowerCase())) return false;
        if (colFilters.container && !containerInfo.type.toLowerCase().includes(colFilters.container.toLowerCase())) return false;
        if (colFilters.armador && !(rate.armador || '').toLowerCase().includes(colFilters.armador.toLowerCase())) return false;
        if (colFilters.agente && !matchesQuery(rate.agente, colFilters.agente)) return false;
        if (colFilters.freetime && !String(rate.freetime || 0).includes(colFilters.freetime.trim())) return false;
        if (colFilters.obs && !(rate.observacao || '').toLowerCase().includes(colFilters.obs.toLowerCase())) return false;
        
        // Validade date multi-select filter
        if (!filterByValidadeDate(rate)) return false;

        // Abertura date range filter (operational / commercial)
        if ((activeDb === 'operational' || activeDb === 'commercial' || activeDb === 'apiAll') && (aberturaDeVal || aberturaAteVal)) {
            const aberturaDate = rate.inicio || '';
            if (!aberturaDate) return false;
            if (aberturaDeVal && aberturaDate < aberturaDeVal) return false;
            if (aberturaAteVal && aberturaDate > aberturaAteVal) return false;
        }

        // Booking filter (Todos / C/ Booking / S/ Booking)
        if (analysisBookingFilter !== 'all') {
            const phase = getProcessPhase(rate);
            const hasBooking = phase === 'pre-com-booking' || phase === 'em-transito' || phase === 'atracado';
            const rateHasBooking = rate.source === 'operational' ? hasBooking : false;
            
            if (analysisBookingFilter === 'com' && !rateHasBooking) return false;
            if (analysisBookingFilter === 'sem' && rateHasBooking) return false;
        }

        // Status/Análise filter
        if (!filterByStatus(rate)) return false;

        // Column multi-select filters (Excel-style)
        if (!filterByColumnMultiSelect(rate)) return false;

        return true;
    });

    // 3. Sort rates using core state
    filteredRates.sort((a, b) => {
        let fieldA = currentSortField;
        let fieldB = currentSortField;

        // If sorting by 'fim' (labeled as Abertura in Operational/Commercial tabs),
        // use 'inicio' for those records since 'inicio' holds the Abertura date.
        if (currentSortField === 'fim') {
            if (a.source === 'operational' || a.source === 'commercial') {
                fieldA = 'inicio';
            }
            if (b.source === 'operational' || b.source === 'commercial') {
                fieldB = 'inicio';
            }
        }

        let valA = a[fieldA];
        let valB = b[fieldB];

        const isDateSort = ['fim', 'previsaoEmbarque', 'previsaoAtracacao', 'inicio'].includes(currentSortField);
        if (isDateSort) {
            if (!valA && !valB) return 0;
            if (!valA) return 1;
            if (!valB) return -1;
            valA = new Date(valA).getTime();
            valB = new Date(valB).getTime();
        } else if (currentSortField === 'valor' || currentSortField === 'freetime' || currentSortField === 'qtd') {
            if (currentSortField === 'qtd') {
                valA = getContainerInfo(a).qty;
                valB = getContainerInfo(b).qty;
            } else {
                valA = Number(valA) || 0;
                valB = Number(valB) || 0;
            }
        } else {
            valA = String(valA || '').toLowerCase();
            valB = String(valB || '').toLowerCase();
        }

        if (valA < valB) return currentSortDirection === 'asc' ? -1 : 1;
        if (valA > valB) return currentSortDirection === 'asc' ? 1 : -1;
        return 0;
    });

    // 4. Update Header indicators
    updateHeaderSortUI();

    // 5. Update count badge
    updateResultsCount();

    // Reset pagination to first page
    currentPage = 1;
    renderTable();
    renderAnalyticsDashboard();

    // Auto-update target freight analysis if visible
    const targetVal = parseFloat(document.getElementById('filter-frete-target')?.value) || 0;
    const resultsEl = document.getElementById('top-analyzer-results');
    if (targetVal > 0 && resultsEl && resultsEl.style.display === 'block') {
        runFreightAnalysisTop();
    }

    // Update top summary cards to reflect filtered data
    updateDashboardCards();
}

window.onObsCategoryFilterChange = function() {
    currentPage = 1;
    applyFilters();
    updateDashboardCards();
};

/* ==========================================================================
   RENDER TABLE & PAGINATION
   ========================================================================== */

function renderTable() {
    tableBody.innerHTML = "";
    
    // Update headers based on active database dynamically
    const thAgenteLabel = document.querySelector('th[data-sort="agente"] .th-label');
    const thValorLabel = document.querySelector('th[data-sort="valor"] .th-label');
    const thFreetimeLabel = document.querySelector('th[data-sort="freetime"] .th-label');
    
    const thValidadeLabel = document.querySelector('th[data-sort="fim"] .th-label');
    
    if (activeDb === 'commercial') {
        if (thAgenteLabel) thAgenteLabel.textContent = "Agente / Oferta";
        if (thValorLabel) thValorLabel.textContent = "Compra / Venda";
        if (thFreetimeLabel) thFreetimeLabel.textContent = "Status";
        if (thValidadeLabel) thValidadeLabel.textContent = "Abertura";
    } else if (activeDb === 'operational') {
        if (thAgenteLabel) thAgenteLabel.textContent = "Agente";
        if (thValorLabel) thValorLabel.textContent = "Valor";
        if (thFreetimeLabel) thFreetimeLabel.textContent = "Free Time";
        if (thValidadeLabel) thValidadeLabel.textContent = "Abertura";
    } else {
        if (thAgenteLabel) thAgenteLabel.textContent = "Agente";
        if (thValorLabel) thValorLabel.textContent = "Valor";
        if (thFreetimeLabel) thFreetimeLabel.textContent = "Free Time";
        if (thValidadeLabel) thValidadeLabel.textContent = "Validade";
    }

    if (filteredRates.length === 0) {
        emptyState.classList.remove('hidden');
        paginationContainer.classList.add('hidden');
        return;
    }

    emptyState.classList.add('hidden');
    paginationContainer.classList.remove('hidden');

    const totalPages = Math.ceil(filteredRates.length / rowsPerPage);
    const startIndex = (currentPage - 1) * rowsPerPage;
    const endIndex = Math.min(startIndex + rowsPerPage, filteredRates.length);

    // Populate pagination information text
    paginationInfo.innerText = `Mostrando ${startIndex + 1} a ${endIndex} de ${filteredRates.length} registros`;

    // Extract rates for this page
    const pageRates = filteredRates.slice(startIndex, endIndex);

    // Gather global minimum freight in current filtered set to highlight it
    const minFreight = Math.min(...filteredRates.map(r => r.valor));

    pageRates.forEach((rate, index) => {
        const isBestRate = rate.valor === minFreight;
        const isExcluded = !!rate._excluded;
        const row = document.createElement('tr');
        if (isExcluded) {
            row.className = "row-excluded";
            row.style.opacity = "0.45";
            row.style.filter = "grayscale(50%)";
            row.style.backgroundColor = "rgba(0,0,0,0.03)";
        } else if (isBestRate) {
            row.className = "highlight-best";
        }

        // Validity calculation and alerts
        const today = new Date();
        today.setHours(0,0,0,0);
        
        // For operational/commercial, show ABERTURA (inicio) date. For others, show validity (fim) date.
        const dateFieldToShow = (rate.source === 'operational' || rate.source === 'commercial') ? rate.inicio : rate.fim;
        
        let validityHtml = `<span class="validity-text var(--text-muted)">-</span>`;
        if (dateFieldToShow) {
            const endDate = new Date(dateFieldToShow + "T00:00:00");
            const diffTime = endDate - today;
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            
            let validityClass = "validity-text";
            let daysLabel = "";

            if (rate.source === 'operational') {
                // For operational: show how many days ago it was opened
                if (diffDays < 0) {
                    daysLabel = `<span class="validity-days" style="color:var(--text-muted)">${Math.abs(diffDays)}d atrás</span>`;
                } else if (diffDays === 0) {
                    daysLabel = `<span class="badge badge-success validity-days">Hoje</span>`;
                } else {
                    daysLabel = `<span class="validity-days" style="color:var(--text-muted)">em ${diffDays}d</span>`;
                }
            } else {
                // For tarifa/space/commercial: expiration logic
                if (diffDays < 0) {
                    validityClass += " text-danger";
                    daysLabel = `<span class="badge badge-danger validity-days">Expirado</span>`;
                } else if (diffDays <= 3) {
                    validityClass += " text-warning";
                    daysLabel = `<span class="badge badge-warning validity-days">${diffDays} dias</span>`;
                } else {
                    daysLabel = `<span class="validity-days" style="color:var(--text-muted)">${diffDays} d.</span>`;
                }
            }

            const formattedDate = dateFieldToShow && dateFieldToShow.includes('-') ? dateFieldToShow.split('-').reverse().slice(0,2).join('/') : (dateFieldToShow || '-'); // DD/MM format
            validityHtml = `
                <div class="validity-container">
                    <span class="${validityClass}">${formattedDate}</span>
                    ${daysLabel}
                </div>
            `;
        }

        // Carrier badge Custom Colors
        const armadorUpper = rate.armador ? rate.armador.toUpperCase() : "N/A";
        let carrierStyle = "background-color: var(--bg-secondary); color: var(--text-secondary);";
        
        // Find matching stylized carrier colors
        for (const [key, design] of Object.entries(CARRIER_COLORS)) {
            if (armadorUpper.includes(key)) {
                carrierStyle = `background-color: ${design.bg}; color: ${design.color}; border: 1px solid ${design.border};`;
                break;
            }
        }

        // Format currency helper
        const formatMoney = (val, currency) => {
            return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(val);
        };

        // Observations inline text with custom tooltip and visual tags/badges
        const hasObs = rate.observacao && rate.observacao.trim() !== "";
        let badgeHtml = "";
        if (hasObs) {
            const obsLower = rate.observacao.toLowerCase();
            if (obsLower.includes("pneu") || obsLower.includes("autopeça") || obsLower.includes("auto-peça") || obsLower.includes("borracha")) {
                badgeHtml += `<span class="badge" style="background:#dc2626; color:#fff; font-size:0.65rem; padding:1px 5px; border-radius:4px; margin-right:4px; font-weight:600; display:inline-block; vertical-align:middle;">🚗 Pneus/Autopeças</span>`;
            }
            if (obsLower.includes("solar") || obsLower.includes("painel")) {
                badgeHtml += `<span class="badge" style="background:#d97706; color:#fff; font-size:0.65rem; padding:1px 5px; border-radius:4px; margin-right:4px; font-weight:600; display:inline-block; vertical-align:middle;">☀️ Painel Solar</span>`;
            }
            if (obsLower.includes("vidro")) {
                badgeHtml += `<span class="badge" style="background:#0891b2; color:#fff; font-size:0.65rem; padding:1px 5px; border-radius:4px; margin-right:4px; font-weight:600; display:inline-block; vertical-align:middle;">🥛 Vidro</span>`;
            }
            if (obsLower.includes("têxtil") || obsLower.includes("textil")) {
                badgeHtml += `<span class="badge" style="background:#059669; color:#fff; font-size:0.65rem; padding:1px 5px; border-radius:4px; margin-right:4px; font-weight:600; display:inline-block; vertical-align:middle;">👕 Têxtil</span>`;
            }
            if (obsLower.includes("ows") || obsLower.includes("gw") || obsLower.includes("peso") || obsLower.includes("weight") || obsLower.includes(">")) {
                badgeHtml += `<span class="badge" style="background:#4b5563; color:#fff; font-size:0.65rem; padding:1px 5px; border-radius:4px; margin-right:4px; font-weight:600; display:inline-block; vertical-align:middle; border:1px solid #6b7280;">⚖️ Peso (OWS)</span>`;
            }
            if (obsLower.includes("promo") || obsLower.includes("spot")) {
                badgeHtml += `<span class="badge" style="background:#7c3aed; color:#fff; font-size:0.65rem; padding:1px 5px; border-radius:4px; margin-right:4px; font-weight:600; display:inline-block; vertical-align:middle;">⚡ Promo/Spot</span>`;
            }
        }
        
        const obsHtml = hasObs 
            ? `<div class="obs-tooltip-wrapper">${badgeHtml}<span class="obs-inline-text">${rate.observacao}</span><div class="obs-tooltip-content">${rate.observacao}</div></div>`
            : `<span class="obs-empty">-</span>`;

        // Source badge (Rate, Space, Operational or Commercial)
        let sourceHtml = "";
        if (rate.source === 'space') {
            sourceHtml = `<div style="margin-top: 4px; display: flex; gap: 4px; align-items: center;">
                             <span class="source-tag source-space">Space</span>
                             <span class="badge badge-info" style="padding: 1px 4px; font-size: 0.6rem; line-height: 1.2;">${rate.qtdSpace || 1} un</span>
                           </div>`;
        } else if (rate.source === 'operational') {
            sourceHtml = `<div style="margin-top: 4px; display: flex; gap: 4px; align-items: center;">
                             <span class="source-tag source-operational">Operação</span>
                             <span class="badge badge-warning" style="padding: 1px 4px; font-size: 0.6rem; line-height: 1.2;">${rate.processo || 'Processo'}</span>
                           </div>`;
        } else if (rate.source === 'commercial') {
            const ofertaNum = rate.processo || 'N/A';
            sourceHtml = `<div style="margin-top: 4px; display: flex; gap: 4px; align-items: center;">
                             <span class="source-tag source-commercial">Oferta</span>
                             <span class="oferta-num" style="font-family: 'Outfit', monospace; font-size: 0.82rem; font-weight: 700; color: var(--primary-light); cursor: pointer; user-select: all; letter-spacing: 0.3px;" title="Clique para copiar" onclick="navigator.clipboard.writeText('${ofertaNum}'); this.style.color='#10b981'; setTimeout(()=>this.style.color='', 800);">${ofertaNum}</span>
                           </div>`;
        } else {
            sourceHtml = `<div style="margin-top: 4px;"><span class="source-tag source-rate">Tarifa</span></div>`;
        }

        let valorCellHtml = "";
        const safeValor = (typeof rate.valor === 'number' && !isNaN(rate.valor)) ? rate.valor : (parseFloat(rate.valor) || 0);
        const safeValorVenda = (typeof rate.valorVenda === 'number' && !isNaN(rate.valorVenda)) ? rate.valorVenda : (parseFloat(rate.valorVenda) || 0);
        const safeMoeda = rate.moeda || 'USD';

        if (rate.source === 'commercial' || rate.source === 'operational') {
            const compraFormatted = safeValor.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
            const vendaFormatted = safeValorVenda.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
            valorCellHtml = `
                <div style="display: flex; flex-direction: column; align-items: flex-end; font-size: 0.85rem; line-height: 1.3;">
                    <span><small style="color:var(--text-muted); font-size:0.7rem;">C:</small> <strong style="color:var(--text-primary);">${safeMoeda} ${compraFormatted}</strong></span>
                    <span><small style="color:var(--text-muted); font-size:0.7rem;">V:</small> <strong style="color:var(--primary-light);">${safeMoeda} ${vendaFormatted}</strong></span>
                </div>
            `;
        } else {
            valorCellHtml = `
                <div class="price-container">
                    <span class="price-currency">${safeMoeda}</span>
                    <span class="price-value">${safeValor.toLocaleString('pt-BR')}</span>
                </div>
            `;
        }

        let freetimeOrStatusHtml = "";
        if (rate.source === 'commercial') {
            const status = rate.analise || "Sem status";
            let statusBadgeClass = "badge-secondary";
            if (status === "Aprovado") statusBadgeClass = "badge-success";
            else if (status === "Reprovado" || status === "Perdido") statusBadgeClass = "badge-danger";
            else if (status === "Em Aberto" || status === "Pendente") statusBadgeClass = "badge-warning";
            
            freetimeOrStatusHtml = `<span class="badge ${statusBadgeClass}" style="padding: 4px 8px; font-size: 0.75rem;">${status}</span>`;
        } else {
            freetimeOrStatusHtml = `<span class="freetime-badge">${rate.freetime || 0}d</span>`;
        }

        const isApiTab = (activeDb === 'operational' || activeDb === 'commercial' || activeDb === 'apiAll');
        const clienteDisplay = isApiTab ? '' : 'display: none;';
        const containerInfo = getContainerInfo(rate);
        const isOperationalTab = (activeDb === 'operational' || activeDb === 'apiAll');
        const etdEtaDisplay = isOperationalTab ? '' : 'display: none;';
        
        // Phase display
        const phase = getProcessPhase(rate);
        const phaseInfo = getPhaseDisplay(phase);
        
        row.innerHTML = `
            <td class="text-center" style="vertical-align: middle; width: 36px; padding: 4px;" onclick="event.stopPropagation();">
                <input type="checkbox" class="row-select-checkbox" data-index="${startIndex + index}" ${isExcluded ? '' : 'checked'} style="cursor: pointer; width: 15px; height: 15px; accent-color: var(--primary);" onchange="toggleRowExclusion(${startIndex + index}, this.checked)" title="${isExcluded ? 'Desmarcado (excluído da análise)' : 'Marcado (incluído na análise)'}">
            </td>
            <td>${renderPortCell(rate.origem)}</td>
            <td>${renderPortCell(rate.destino)}</td>
            <td class="text-center"><span class="badge badge-secondary" style="font-weight: 600; font-size: 0.75rem; padding: 2px 6px;">${containerInfo.qty}</span></td>
            <td><span class="badge badge-info">${containerInfo.type}</span></td>
            <td><span class="carrier-badge" style="${carrierStyle}">${rate.armador}</span></td>
            <td>
                <div style="display: flex; flex-direction: column;">
                    <span class="agent-text">${rate.agente}</span>
                    ${sourceHtml}
                </div>
            </td>
            <td class="col-cliente" style="${clienteDisplay}" title="${rate.cliente || '-'}"><span class="route-text">${rate.cliente || '-'}</span></td>
            <td class="text-right">
                ${valorCellHtml}
            </td>
            <td class="text-center">
                ${freetimeOrStatusHtml}
            </td>
            <td class="text-center">${validityHtml}</td>
            <td class="col-etd text-center" style="${etdEtaDisplay}">${rate.previsaoEmbarque ? rate.previsaoEmbarque.split('-').reverse().slice(0,2).join('/') : '-'}</td>
            <td class="col-eta text-center" style="${etdEtaDisplay}">${rate.previsaoAtracacao ? rate.previsaoAtracacao.split('-').reverse().slice(0,2).join('/') : '-'}</td>
            <td class="col-fase text-center" style="${etdEtaDisplay}">
                <span class="badge" style="background: ${phaseInfo.bg}; color: ${phaseInfo.color}; font-weight: 600; font-size: 0.7rem; padding: 3px 8px; border-radius: 6px; white-space: nowrap;">${phaseInfo.label}</span>
            </td>
            <td class="obs-cell">${obsHtml}</td>
            <td class="text-center">
                <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 0.75rem;" onclick="openDetailsModal(${startIndex + index})">
                    Ver Detalhes
                </button>
            </td>
        `;

        tableBody.appendChild(row);
    });

    // Synchronize header select-all checkbox state
    const chkAll = document.getElementById('chk-select-all-rows');
    if (chkAll) {
        const total = filteredRates.length;
        const active = filteredRates.filter(r => !r._excluded).length;
        chkAll.checked = (total > 0 && active === total);
        chkAll.indeterminate = (active > 0 && active < total);
    }

    // Reinitialize icons in table
    lucide.createIcons();

    // Render page indicators
    renderPaginationButtons(totalPages);
}

function renderPaginationButtons(totalPages) {
    pageNumbersContainer.innerHTML = "";
    
    // Prev / Next button states
    btnPrevPage.disabled = currentPage === 1;
    btnNextPage.disabled = currentPage === totalPages;

    const createPageBtn = (page) => {
        const btn = document.createElement('button');
        btn.className = `page-btn ${page === currentPage ? 'active' : ''}`;
        btn.innerText = page;
        btn.addEventListener('click', () => {
            currentPage = page;
            renderTable();
        });
        pageNumbersContainer.appendChild(btn);
    };

    // Responsive: limit page numbers count if too many
    if (totalPages <= 5) {
        for (let i = 1; i <= totalPages; i++) createPageBtn(i);
    } else {
        // Show current, prev, next and first/last
        if (currentPage > 2) createPageBtn(1);
        if (currentPage > 3) {
            const dots = document.createElement('span');
            dots.innerText = "...";
            dots.style.padding = "0 4px";
            pageNumbersContainer.appendChild(dots);
        }

        const start = Math.max(1, currentPage - 1);
        const end = Math.min(totalPages, currentPage + 1);
        for (let i = start; i <= end; i++) {
            if (i !== 1 && i !== totalPages) createPageBtn(i);
        }

        if (currentPage < totalPages - 2) {
            const dots = document.createElement('span');
            dots.innerText = "...";
            dots.style.padding = "0 4px";
            pageNumbersContainer.appendChild(dots);
        }
        if (currentPage < totalPages - 1) createPageBtn(totalPages);
    }
}

/* ==========================================================================
   ANALYTICS DASHBOARD - RANKING ENGINE
   ========================================================================== */

function renderAnalyticsDashboard() {
    const dashboard = document.getElementById('analytics-dashboard');
    if (!dashboard) return;
    
    const isApiTab = (activeDb === 'operational' || activeDb === 'commercial' || activeDb === 'apiAll');
    dashboard.style.display = isApiTab ? 'block' : 'none';
    if (!isApiTab) return;
    
    const data = filteredRates.length > 0 ? filteredRates.filter(r => !r._excluded) : [];
    // DEBUG: log what data the analytics is using
    const uniqueAgents = [...new Set(data.map(r => r.agente))];
    console.log(`[Analytics Debug] filteredRates: ${filteredRates.length}, data: ${data.length}, agents: ${uniqueAgents.join(', ')}`);
    const filterAgenteDbg = document.getElementById('filter-agente-top');
    console.log(`[Analytics Debug] filter-agente-top value: "${filterAgenteDbg ? filterAgenteDbg.value : 'N/A'}"`);
    if (data.length === 0) {
        document.getElementById('ranking-clientes-list').innerHTML = '<div class="route-no-data">Nenhum dado filtrado</div>';
        document.getElementById('ranking-rotas-list').innerHTML = '<div class="route-no-data">Nenhum dado filtrado</div>';
        document.getElementById('ranking-agentes-list').innerHTML = '<div class="route-no-data">Nenhum dado filtrado</div>';
        document.getElementById('ranking-armadores-list').innerHTML = '<div class="route-no-data">Nenhum dado filtrado</div>';
        return;
    }
    
    // Aggregate by containers AND process/offer count AND MC (profit)
    const isCommercialTab = activeDb === 'commercial';
    const procLabel = isCommercialTab ? 'of' : 'proc';
    
    // Helper to compute MC for a single row
    const getRowMC = (r) => {
        const compra = r.valor || 0;
        const venda = r.valorVenda || 0;
        const qty = getContainerInfo(r).qty;
        if (r.source === 'commercial' || isCommercialTab) {
            // Commercial: MC = (venda - compra) * qty
            return venda > 0 && compra > 0 ? (venda - compra) * qty : 0;
        } else if (r.source === 'operational') {
            // Operational: valor already IS the MC value
            return compra * qty;
        }
        return 0;
    };

    const aggregate = (field, sortKey) => {
        const map = {};
        data.forEach(r => {
            const key = (r[field] || 'N/A').trim();
            if (!key || key === 'N/A') return;
            if (!map[key]) map[key] = { cntrs: 0, procs: 0, mc: 0 };
            map[key].cntrs += getContainerInfo(r).qty;
            map[key].procs += 1;
            map[key].mc += getRowMC(r);
        });
        return Object.entries(map).sort((a, b) => b[1][sortKey] - a[1][sortKey]);
    };
    
    const aggregateRoutes = (sortKey) => {
        const map = {};
        data.forEach(r => {
            const orig = (r.origem || 'N/A');
            const dest = (r.destino || 'N/A');
            const key = `${orig} → ${dest}`;
            if (!map[key]) map[key] = { cntrs: 0, procs: 0, mc: 0, origem: orig, destino: dest };
            map[key].cntrs += getContainerInfo(r).qty;
            map[key].procs += 1;
            map[key].mc += getRowMC(r);
        });
        return Object.entries(map).sort((a, b) => b[1][sortKey] - a[1][sortKey]);
    };
    
    const topClientes = aggregate('cliente', rankingSortBy.clientes);
    const topRoutes = aggregateRoutes(rankingSortBy.rotas);
    const topAgentes = aggregate('agente', rankingSortBy.agentes);
    const topArmadores = aggregate('armador', rankingSortBy.armadores);
    
    // Format MC value
    const fmtMC = (v) => {
        if (v === 0) return '';
        const sign = v >= 0 ? '+' : '';
        return `${sign}R$ ${Math.round(v).toLocaleString('pt-BR')}`;
    };

    // Render ranking list
    const renderList = (containerId, items, filterField) => {
        const container = document.getElementById(containerId);
        if (!container) return;
        
        const maxVal = items.length > 0 ? items[0][1].cntrs : 1;
        
        container.innerHTML = items.map(([name, info]) => {
            const pct = Math.round((info.cntrs / maxVal) * 100);
            const displayName = name.length > 30 ? name.substring(0, 30) + '...' : name;
            const mcText = info.mc !== 0 ? `<small style="color:${info.mc >= 0 ? 'var(--success)' : 'var(--danger)'};font-weight:600;font-size:0.58rem;margin-left:2px">${fmtMC(info.mc)}</small>` : '';
            return `
                <div class="ranking-item" data-filter-field="${filterField}" data-filter-value="${name}" title="${name}">
                    <button class="ranking-chart-btn" data-entity="${name}" data-field="${filterField}" title="Ver performance">📊</button>
                    <div class="ranking-item-row">
                        <span class="ranking-item-name">${displayName}</span>
                        <span class="ranking-item-count">${info.cntrs} <small style="color:var(--text-muted);font-weight:400;font-size:0.58rem">cntrs</small> · ${info.procs} <small style="color:var(--text-muted);font-weight:400;font-size:0.58rem">${procLabel}</small>${mcText}</span>
                    </div>
                    <div class="ranking-item-bar-wrapper">
                        <div class="ranking-item-bar" style="width: ${pct}%"></div>
                    </div>
                </div>
            `;
        }).join('');
        
        // Chart button click handlers
        container.querySelectorAll('.ranking-chart-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation(); // Don't trigger the filter click
                showPerformanceTimeline(btn.dataset.entity, btn.dataset.field);
            });
        });
        
        // Multi-select click handlers
        container.querySelectorAll('.ranking-item').forEach(item => {
            item.addEventListener('click', () => {
                const field = item.dataset.filterField;
                const value = item.dataset.filterValue;
                
                // Toggle this item's active state (multi-select)
                item.classList.toggle('active');
                
                // Collect all active values for this field
                const activeValues = [];
                container.querySelectorAll('.ranking-item.active').forEach(ai => {
                    activeValues.push(ai.dataset.filterValue);
                });
                
                // Set the filter input to comma-separated active values
                const combined = activeValues.join(', ');
                if (field === 'cliente') {
                    const ci = document.getElementById('filter-cliente');
                    if (ci) ci.value = combined;
                } else if (field === 'armador') {
                    selectArmador.value = combined;
                } else if (field === 'agente') {
                    colFilters.agente = combined;
                }
                
                currentPage = 1;
                applyFilters();
                updateDashboardCards();
            });
        });
    };
    
    // Render route list with multi-select
    const renderRouteList = () => {
        const container = document.getElementById('ranking-rotas-list');
        if (!container) return;
        
        const maxVal = topRoutes.length > 0 ? topRoutes[0][1].cntrs : 1;
        
        container.innerHTML = topRoutes.map(([name, info]) => {
            const pct = Math.round((info.cntrs / maxVal) * 100);
            const mcText = info.mc !== 0 ? `<small style="color:${info.mc >= 0 ? 'var(--success)' : 'var(--danger)'};font-weight:600;font-size:0.58rem;margin-left:2px">${fmtMC(info.mc)}</small>` : '';
            return `
                <div class="ranking-item ranking-route-item" data-origem="${info.origem}" data-destino="${info.destino}" title="${name}">
                    <div class="ranking-item-row">
                        <span class="ranking-item-name">${name}</span>
                        <span class="ranking-item-count">${info.cntrs} <small style="color:var(--text-muted);font-weight:400;font-size:0.58rem">cntrs</small> · ${info.procs} <small style="color:var(--text-muted);font-weight:400;font-size:0.58rem">${procLabel}</small>${mcText}</span>
                    </div>
                    <div class="ranking-item-bar-wrapper">
                        <div class="ranking-item-bar" style="width: ${pct}%"></div>
                    </div>
                </div>
            `;
        }).join('');
        
        container.querySelectorAll('.ranking-route-item').forEach(item => {
            item.addEventListener('click', () => {
                // Toggle this item
                item.classList.toggle('active');
                
                const orig = item.dataset.origem;
                const dest = item.dataset.destino;
                const pairKey = `${orig.trim().toUpperCase()}|${dest.trim().toUpperCase()}`;
                
                if (item.classList.contains('active')) {
                    window.activeRoutePairs.add(pairKey);
                } else {
                    window.activeRoutePairs.delete(pairKey);
                }
                
                const activeRoutes = [];
                container.querySelectorAll('.ranking-route-item.active').forEach(ai => {
                    activeRoutes.push({ origem: ai.dataset.origem, destino: ai.dataset.destino });
                });
                
                if (activeRoutes.length === 0) {
                    selectOrigem.value = '';
                    selectDestino.value = '';
                    hideRouteDetail();
                } else {
                    selectOrigem.value = activeRoutes.map(r => r.origem).join(', ');
                    selectDestino.value = activeRoutes.map(r => r.destino).join(', ');
                    showRouteDetail(activeRoutes);
                }
                
                currentPage = 1;
                applyFilters();
                updateDashboardCards();
            });
        });
    };
    
    renderList('ranking-clientes-list', topClientes, 'cliente');
    renderRouteList();
    renderList('ranking-agentes-list', topAgentes, 'agente');
    renderList('ranking-armadores-list', topArmadores, 'armador');
    renderFretesMedios(data);
    
    // Sort toggle click handlers (now with 3 options: cntrs → procs → mc → cntrs)
    const sortMap = {
        'ranking-clientes': 'clientes',
        'ranking-rotas': 'rotas',
        'ranking-agentes': 'agentes',
        'ranking-armadores': 'armadores'
    };
    Object.entries(sortMap).forEach(([cardId, stateKey]) => {
        const toggle = document.querySelector(`#${cardId} .ranking-sort-toggle`);
        if (!toggle) return;
        const currentSort = rankingSortBy[stateKey];
        const bolds = toggle.querySelectorAll('b');
        bolds.forEach(b => b.classList.remove('ranking-sort-active'));
        if (currentSort === 'cntrs' && bolds[0]) bolds[0].classList.add('ranking-sort-active');
        if (currentSort === 'procs' && bolds[1]) bolds[1].classList.add('ranking-sort-active');
        if (currentSort === 'mc' && bolds[2]) bolds[2].classList.add('ranking-sort-active');
        
        toggle.onclick = () => {
            const cycle = ['cntrs', 'procs', 'mc'];
            const idx = cycle.indexOf(rankingSortBy[stateKey]);
            rankingSortBy[stateKey] = cycle[(idx + 1) % cycle.length];
            renderAnalyticsDashboard();
        };
    });
    
    // Export button
    const btnExport = document.getElementById('btn-export-analytics');
    if (btnExport) {
        btnExport.onclick = () => exportAnalyticsDashboard(data, topClientes, topRoutes, topAgentes, topArmadores);
    }
}

function renderFretesMedios(data) {
    const container = document.getElementById('ranking-frete-medio-list');
    if (!container) return;
    
    // Calculate overall averages
    const withCompra = data.filter(r => r.valor > 0);
    const withVenda = data.filter(r => (r.valorVenda || 0) > 0);
    
    const avgCompra = withCompra.length > 0 ? withCompra.reduce((s, r) => s + r.valor, 0) / withCompra.length : 0;
    const avgVenda = withVenda.length > 0 ? withVenda.reduce((s, r) => s + (r.valorVenda || 0), 0) / withVenda.length : 0;
    
    // All agents with at least 2 operations
    const agentMap = {};
    data.forEach(r => {
        if (r.valor <= 0 || !r.agente || r.agente === 'N/A') return;
        if (!agentMap[r.agente]) agentMap[r.agente] = { total: 0, count: 0 };
        agentMap[r.agente].total += r.valor;
        agentMap[r.agente].count++;
    });
    
    // Sort direction state
    const sortAsc = container.dataset.sortAsc !== 'false'; // default: asc (menor primeiro)
    
    const allAgents = Object.entries(agentMap)
        .filter(([, v]) => v.count >= 2)
        .map(([name, v]) => [name, Math.round(v.total / v.count)])
        .sort((a, b) => sortAsc ? a[1] - b[1] : b[1] - a[1]);
    
    const fmt = (v) => v.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    
    let html = `
        <div style="display:flex; gap:6px; margin-bottom:6px;">
            <div style="flex:1; background:var(--bg-secondary); border-radius:6px; padding:5px 8px; text-align:center;">
                <div style="font-size:0.55rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.4px;">Compra Médio</div>
                <div style="font-size:0.88rem; font-weight:800; color:var(--text-primary);">USD ${fmt(avgCompra)}</div>
            </div>
            <div style="flex:1; background:var(--bg-secondary); border-radius:6px; padding:5px 8px; text-align:center;">
                <div style="font-size:0.55rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.4px;">Venda Médio</div>
                <div style="font-size:0.88rem; font-weight:800; color:var(--primary-light);">USD ${fmt(avgVenda)}</div>
            </div>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px;">
            <span style="font-size:0.62rem; color:var(--text-muted); font-weight:600; text-transform:uppercase; letter-spacing:0.3px;">🏆 Melhores Agentes (Menor Compra)</span>
            <button id="btn-sort-agents" style="background:none; border:none; color:var(--primary); cursor:pointer; font-size:0.6rem; font-weight:600; padding:1px 4px;" title="Alternar ordenação">
                ${sortAsc ? '↑ Menor' : '↓ Maior'}
            </button>
        </div>
    `;
    
    if (allAgents.length === 0) {
        html += '<div class="route-no-data">Dados insuficientes</div>';
    } else {
        const maxVal = Math.max(...allAgents.map(a => a[1]));
        const minVal = Math.min(...allAgents.map(a => a[1]));
        html += '<div style="max-height:260px; overflow-y:auto;">';
        allAgents.forEach(([name, avg]) => {
            const displayName = name.length > 25 ? name.substring(0, 25) + '...' : name;
            const range = maxVal - minVal || 1;
            const pct = sortAsc 
                ? Math.round(((maxVal - avg) / range) * 80 + 20) 
                : Math.round((avg / maxVal) * 100);
            html += `
                <div class="ranking-item" title="${name} — Média: USD ${fmt(avg)}">
                    <div class="ranking-item-row">
                        <span class="ranking-item-name">${displayName}</span>
                        <span class="ranking-item-count" style="color:#059669;">$${fmt(avg)}</span>
                    </div>
                    <div class="ranking-item-bar-wrapper">
                        <div class="ranking-item-bar" style="width: ${pct}%; background: linear-gradient(90deg, #10b981, #059669);"></div>
                    </div>
                </div>
            `;
        });
        html += '</div>';
    }
    
    container.innerHTML = html;
    
    // Sort toggle
    const sortBtn = document.getElementById('btn-sort-agents');
    if (sortBtn) {
        sortBtn.addEventListener('click', () => {
            container.dataset.sortAsc = container.dataset.sortAsc === 'false' ? 'true' : 'false';
            renderFretesMedios(data);
        });
    }
}

function exportAnalyticsDashboard(data, topClientes, topRoutes, topAgentes, topArmadores) {
    let csv = 'PAINEL ANALITICO - EXPORTACAO\n\n';
    
    csv += 'TOP CLIENTES (Containers)\n';
    csv += 'Cliente,Containers\n';
    topClientes.forEach(([name, count]) => csv += '"' + name + '",' + count + '\n');
    
    csv += '\nTOP ROTAS (Containers)\n';
    csv += 'Rota,Containers\n';
    topRoutes.forEach(([name, info]) => csv += '"' + name + '",' + info.count + '\n');
    
    csv += '\nTOP AGENTES (Containers)\n';
    csv += 'Agente,Containers\n';
    topAgentes.forEach(([name, count]) => csv += '"' + name + '",' + count + '\n');
    
    csv += '\nTOP ARMADORES (Containers)\n';
    csv += 'Armador,Containers\n';
    topArmadores.forEach(([name, count]) => csv += '"' + name + '",' + count + '\n');
    
    csv += '\nDETALHE DOS DADOS\n';
    csv += 'Origem,Destino,Container,Armador,Agente,Cliente,Compra,Venda,Moeda,Abertura\n';
    data.forEach(r => {
        const cInfo = getContainerInfo(r);
        csv += '"' + r.origem + '","' + r.destino + '","' + cInfo.qty + 'x ' + cInfo.type + '","' + r.armador + '","' + r.agente + '","' + (r.cliente || '') + '",' + r.valor + ',' + (r.valorVenda || 0) + ',"' + r.moeda + '","' + (r.inicio || '') + '"\n';
    });
    
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'painel_analitico_' + activeDb + '_' + new Date().toISOString().split('T')[0] + '.csv';
    a.click();
    URL.revokeObjectURL(url);
    showToast('📊 Painel analítico exportado com sucesso!', 'success', 3000);
}

function showRouteDetail(routes) {
    if (!routes || routes.length === 0) {
        hideRouteDetail();
        return;
    }
    
    // Support legacy call style (origem, destino as separate arguments)
    if (typeof routes === 'string') {
        routes = [{ origem: arguments[0], destino: arguments[1] }];
    } else if (!Array.isArray(routes)) {
        routes = [routes];
    }

    const card = document.getElementById('route-detail-card');
    const grid = document.getElementById('analytics-grid');
    const title = document.getElementById('route-detail-title');
    const subtitle = document.getElementById('route-detail-subtitle');
    const body = document.getElementById('route-detail-body');
    
    if (!card || !body) return;
    
    card.style.display = 'block';
    grid.classList.add('with-detail');
    
    if (routes.length === 1) {
        title.textContent = `${routes[0].origem} → ${routes[0].destino}`;
    } else {
        title.textContent = `${routes.length} Rotas Selecionadas`;
    }
    
    const isCommercial = activeDb === 'commercial';
    subtitle.textContent = isCommercial ? 'Ofertas recentes: Compra vs Venda' : 'Processos recentes: Compra vs Venda';
    
    // Get ALL data for these routes
    const allData = isCommercial ? appComercial : appOperational;
    const routeData = allData
        .filter(r => routes.some(rt => r.origem === rt.origem && r.destino === rt.destino))
        .sort((a, b) => (b.inicio || '').localeCompare(a.inicio || ''))
        .slice(0, 30);
    
    if (routeData.length === 0) {
        body.innerHTML = '<div class="route-no-data">Sem fretes recentes para estas rotas</div>';
        return;
    }
    
    const formatDate = (d) => d && d.includes('-') ? d.split('-').reverse().join('/') : (d || '-');
    const fmt = (v) => v ? v.toLocaleString('pt-BR', {minimumFractionDigits: 0, maximumFractionDigits: 0}) : '-';
    
    // Export button handler
    const exportBtn = card.querySelector('.btn-export-route');
    if (exportBtn) {
        exportBtn.onclick = () => {
            const headers = [isCommercial ? 'Oferta' : 'Processo', 'Cliente', 'Rota', 'Agente', 'Armador', 'Container', 'Abertura', 'Compra Unit.', 'Venda Unit.', isCommercial ? 'Status' : 'Compra Total'];
            const rows = routeData.map(r => {
                const cInfo = getContainerInfo(r);
                return [
                    r.processo, r.cliente, `${r.origem} -> ${r.destino}`, r.agente, r.armador,
                    `${cInfo.qty}x ${cInfo.type}`, r.inicio,
                    r.valor ? r.valor.toFixed(2) : '0',
                    r.valorVenda ? r.valorVenda.toFixed(2) : '0',
                    isCommercial ? (r.analise || '') : (r.vlCompraFrete ? r.vlCompraFrete.toFixed(2) : '0')
                ];
            });
            exportToCSV(headers, rows, `fretes_multiplas_rotas_${new Date().toISOString().split('T')[0]}.csv`);
            showToast('✅ Exportação concluída!', 'success', 2000);
        };
    }
    
    body.innerHTML = `
        <div class="route-freight-table-wrapper">
            <table class="route-freight-table">
                <thead>
                    <tr>
                        <th>${isCommercial ? 'Oferta' : 'Processo'}</th>
                        <th>Cliente</th>
                        <th>Rota</th>
                        <th>Equip.</th>
                        <th>Data</th>
                        <th class="text-right">Compra</th>
                        <th class="text-right">Venda</th>
                        ${isCommercial ? '<th>Status</th>' : ''}
                    </tr>
                </thead>
                <tbody>
                    ${routeData.map((r, idx) => {
                        const cInfo = getContainerInfo(r);
                        const compra = r.valor ? fmt(r.valor) : '-';
                        const venda = r.valorVenda ? fmt(r.valorVenda) : '-';
                        return `
                            <tr class="route-freight-row" data-route-idx="${idx}" title="Clique para ver detalhes">
                                <td><strong class="route-ref-link">${r.processo}</strong></td>
                                <td title="${r.cliente || ''}">${r.cliente || 'N/A'}</td>
                                <td>${r.origem.split(' ')[0]} ➔ ${r.destino.split(' ')[0]}</td>
                                <td>${cInfo.qty}× ${cInfo.type.split(' ')[0]}</td>
                                <td>${formatDate(r.inicio)}</td>
                                <td class="text-right"><span class="route-price-buy">$${compra}</span></td>
                                <td class="text-right"><span class="route-price-sell">$${venda}</span></td>
                                ${isCommercial ? `<td><span class="badge badge-info" style="font-size:0.58rem">${(r.analise || '-').substring(0, 15)}</span></td>` : ''}
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        </div>
    `;
    
    // Click handlers to open modal details
    body.querySelectorAll('.route-freight-row').forEach(row => {
        row.addEventListener('click', () => {
            const idx = parseInt(row.dataset.routeIdx);
            const r = routeData[idx];
            if (!r) return;
            openDetailModal(r);
        });
    });
    
    document.getElementById('route-detail-close').onclick = () => {
        hideRouteDetail();
        selectOrigem.value = '';
        selectDestino.value = '';
        currentPage = 1;
        applyFilters();
        updateDashboardCards();
        renderAnalyticsDashboard();
    };
}

function hideRouteDetail() {
    const card = document.getElementById('route-detail-card');
    const grid = document.getElementById('analytics-grid');
    if (card) card.style.display = 'none';
    if (grid) grid.classList.remove('with-detail');
}

// Open detail modal for a specific record (from route detail / analyzer click)
function openDetailModal(r) {
    // Reuse the existing openDetailsModal by temporarily inserting the record
    const tempIdx = filteredRates.length;
    filteredRates.push(r);
    window.openDetailsModal(tempIdx);
    filteredRates.pop(); // Clean up
}

/* ==========================================================================
   FREIGHT ANALYZER (TOP FILTERS INTEGRATED)
   ========================================================================== */

function initFreightAnalyzer() {
    const btnAnalyze = document.getElementById('btn-analyze-freight-top');
    const inputFreightTarget = document.getElementById('filter-frete-target');
    
    if (btnAnalyze) {
        btnAnalyze.addEventListener('click', () => runFreightAnalysisTop());
    }
    
    if (inputFreightTarget) {
        inputFreightTarget.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                runFreightAnalysisTop();
            }
        });
    }
}

window.runFreightAnalysisTop = function() {
    const valorInput = parseFloat(document.getElementById('filter-frete-target')?.value) || 0;
    const resultsEl = document.getElementById('top-analyzer-results');
    
    if (!resultsEl) return;
    
    if (valorInput <= 0) {
        showToast('Por favor, insira um valor de Frete Alvo válido.', 'error', 3000);
        return;
    }
    
    if (!filteredRates || filteredRates.length === 0) {
        resultsEl.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; width:100%;">
                <div style="color:var(--text-muted); font-size:0.85rem;">Nenhum registro encontrado com os filtros atuais para realizar a análise.</div>
                <button class="btn btn-secondary btn-sm" onclick="document.getElementById('top-analyzer-results').style.display='none';" style="margin:0; padding:2px 8px; font-size:0.75rem;">Fechar</button>
            </div>
        `;
        resultsEl.style.display = 'block';
        return;
    }
    
    // Calculate statistics from currently active filteredRates (excluding deselected outliers)
    const buyValues = filteredRates.filter(r => !r._excluded && r.valor > 0).map(r => r.valor);
    const sellValues = filteredRates.filter(r => !r._excluded && r.valorVenda > 0).map(r => r.valorVenda);
    const avgBuy = buyValues.length > 0 ? buyValues.reduce((a, b) => a + b, 0) / buyValues.length : 0;
    const minBuy = buyValues.length > 0 ? Math.min(...buyValues) : 0;
    const maxBuy = buyValues.length > 0 ? Math.max(...buyValues) : 0;
    const avgSell = sellValues.length > 0 ? sellValues.reduce((a, b) => a + b, 0) / sellValues.length : 0;
    
    const fmt = (v) => v.toLocaleString('pt-BR', {minimumFractionDigits: 0, maximumFractionDigits: 0});
    
    // Verdict
    let verdict = '';
    let verdictClass = '';
    const diff = valorInput - avgBuy;
    const pctDiff = avgBuy > 0 ? ((diff / avgBuy) * 100).toFixed(1) : 0;
    
    if (diff > avgBuy * 0.1) {
        verdict = `⚠️ Frete Alvo de $${fmt(valorInput)} está ACIMA da média de compra (+${pctDiff}%). Média: $${fmt(avgBuy)}. Recomendável renegociar.`;
        verdictClass = 'verdict-warning';
    } else if (diff < -avgBuy * 0.05) {
        verdict = `✅ Frete Alvo de $${fmt(valorInput)} está ABAIXO da média de compra (${pctDiff}%). Excelente oportunidade! Média: $${fmt(avgBuy)}.`;
        verdictClass = 'verdict-good';
    } else {
        verdict = `🔵 Frete Alvo de $${fmt(valorInput)} está dentro da faixa de média de compra ($${fmt(avgBuy)}). Variação: ${pctDiff}%.`;
        verdictClass = 'verdict-neutral';
    }
    
    const labelRegistros = (activeDb === 'rate' || activeDb === 'space' || activeDb === 'all') ? 'Tarifas comparadas' : (activeDb === 'commercial' ? 'Ofertas comparadas' : 'Processos comparados');
    
    resultsEl.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; width:100%;">
            <h4 style="margin:0; font-size:0.925rem; font-weight:600; display:flex; align-items:center; gap:6px; color:var(--text-primary);">
                <i data-lucide="calculator" style="width:16px; height:16px; color:var(--primary);"></i>
                Resultado da Análise de Frete
            </h4>
            <div style="display:flex; gap:6px; margin:0;">
                <button class="btn btn-primary btn-sm" onclick="window.exportTopAnalysisData()" style="margin:0; padding:3px 10px; font-size:0.75rem; font-weight:600; display:flex; align-items:center; gap:4px;">
                    <i data-lucide="download" style="width:12px; height:12px;"></i> Exportar Análise
                </button>
                <button class="btn btn-secondary btn-sm" onclick="document.getElementById('top-analyzer-results').style.display='none';" style="margin:0; padding:3px 10px; font-size:0.75rem;">Ocultar</button>
            </div>
        </div>
        <div class="analyzer-verdict ${verdictClass}" style="margin-bottom:12px; padding:10px 12px; border-radius:6px; font-weight:600; font-size:0.85rem;">
            ${verdict}
        </div>
        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap:10px;">
            <div style="background:var(--card-bg); padding:10px; border-radius:6px; border:1px solid var(--card-border); display:flex; flex-direction:column;">
                <span style="font-size:0.7rem; color:var(--text-secondary); margin-bottom:4px;">${labelRegistros}</span>
                <span style="font-size:1.05rem; font-weight:600; color:var(--text-primary);">${filteredRates.length}</span>
            </div>
            <div style="background:var(--card-bg); padding:10px; border-radius:6px; border:1px solid var(--card-border); display:flex; flex-direction:column;">
                <span style="font-size:0.7rem; color:var(--text-secondary); margin-bottom:4px;">Compra Média</span>
                <span style="font-size:1.05rem; font-weight:600; color:var(--text-primary);">$${fmt(avgBuy)}</span>
            </div>
            <div style="background:var(--card-bg); padding:10px; border-radius:6px; border:1px solid var(--card-border); display:flex; flex-direction:column;">
                <span style="font-size:0.7rem; color:var(--text-secondary); margin-bottom:4px;">Compra Mín → Máx</span>
                <span style="font-size:1.05rem; font-weight:600; color:var(--text-primary);">$${fmt(minBuy)} → $${fmt(maxBuy)}</span>
            </div>
            <div style="background:var(--card-bg); padding:10px; border-radius:6px; border:1px solid var(--card-border); display:flex; flex-direction:column;">
                <span style="font-size:0.7rem; color:var(--text-secondary); margin-bottom:4px;">Venda Média</span>
                <span style="font-size:1.05rem; font-weight:600; color:var(--text-primary);">$${fmt(avgSell)}</span>
            </div>
        </div>
    `;
    
    resultsEl.style.display = 'block';
    lucide.createIcons();
};

window.exportTopAnalysisData = function() {
    const valorInput = parseFloat(document.getElementById('filter-frete-target')?.value) || 0;
    if (valorInput <= 0) {
        showToast('Por favor, defina um Frete Alvo válido para exportar a análise.', 'error', 3000);
        return;
    }
    
    if (!filteredRates || filteredRates.length === 0) {
        showToast('Nenhum registro para exportar.', 'error', 3000);
        return;
    }
    
    const headers = [
        "Processo/Oferta",
        "Tipo",
        "Cliente",
        "Origem",
        "Destino",
        "Container",
        "Qtd",
        "Armador",
        "Agente",
        "Frete Compra",
        "Frete Venda",
        "Frete Alvo",
        "Diferenca Unitario",
        "Ganho Estimado",
        "Fase/Status",
        "Data Abertura/Validade",
        "Observacoes"
    ];
    
    const rows = filteredRates.filter(r => !r._excluded).map(rate => {
        const type = rate.source === 'commercial' ? 'Comercial' : 'Operacional';
        const client = rate.cliente || '-';
        const containerInfo = getContainerInfo(rate);
        const buyVal = rate.valor || 0;
        const sellVal = rate.valorVenda || 0;
        const diff = buyVal > 0 ? valorInput - buyVal : 0;
        const estimatedSaving = diff * containerInfo.qty;
        const dateVal = (rate.source === 'operational' || rate.source === 'commercial') ? (rate.inicio || '') : (rate.fim || '');
        const phase = rate.source === 'operational' ? getProcessPhase(rate) : (rate.analise || 'Sem Status');
        
        return [
            rate.processo || '-',
            type,
            client,
            rate.origem || '-',
            rate.destino || '-',
            containerInfo.type,
            containerInfo.qty,
            rate.armador || '-',
            rate.agente || '-',
            buyVal,
            sellVal,
            valorInput,
            diff,
            estimatedSaving,
            phase,
            dateVal,
            (rate.observacao || '').replace(/[\r\n]+/g, ' ')
        ];
    });
    
    let csvContent = "\ufeff" + headers.join(";") + "\n";
    rows.forEach(row => {
        const formattedRow = row.map(val => {
            if (typeof val === 'number') {
                return val.toString().replace('.', ',');
            }
            let clean = String(val || '').replace(/"/g, '""');
            if (clean.includes(';') || clean.includes('\n')) {
                clean = `"${clean}"`;
            }
            return clean;
        });
        csvContent += formattedRow.join(";") + "\n";
    });
    
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    
    const timestamp = new Date().toISOString().slice(0, 10);
    link.setAttribute("download", `analise_frete_alvo_${valorInput}_USD_${timestamp}.csv`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};

/* ==========================================================================
   DASHBOARD CARDS & INSIGHT GENERATOR (IA OUTLOOK)
   ========================================================================== */

function updateDashboardCards() {
    let activeDataset = [];
    if (activeDb === "all") {
        activeDataset = [...appRates, ...appSpace];
    } else if (activeDb === "rate") {
        activeDataset = appRates;
    } else if (activeDb === "space") {
        activeDataset = appSpace;
    } else if (activeDb === "operational") {
        activeDataset = appOperational;
    } else if (activeDb === "commercial") {
        activeDataset = appComercial;
    }

    // Get card label elements
    const card1Label = document.querySelector('#card-cheapest .card-label');
    const card2Label = document.querySelector('#card-freetime .card-label');
    const card3Label = document.querySelector('#card-opportunity .card-label');
    const card4Label = document.querySelector('#card-summary .card-label');

    // For operational and commercial: show process/client/route analytics
    if (activeDb === 'operational' || activeDb === 'commercial' || activeDb === 'apiAll') {
        const data = (filteredRates.length > 0 ? filteredRates : activeDataset).filter(r => !r._excluded);
        const isCommercial = activeDb === 'commercial';
        const typeLabel = activeDb === 'apiAll' ? 'Processos' : (isCommercial ? 'Ofertas' : 'Processos');

        // Card 1: Total processes/offers + total containers
        let totalContainers = 0;
        data.forEach(r => { totalContainers += getContainerInfo(r).qty; });
        
        if (card1Label) card1Label.textContent = `${typeLabel} Selecionados`;
        cheapestVal.innerText = `${data.length} ${typeLabel}`;
        cheapestRoute.innerText = `${totalContainers} containers no total`;

        // Card 2: Principal Client (by container volume)
        const clientCount = {};
        data.forEach(r => {
            const cli = (r.cliente || 'N/A').trim();
            if (cli && cli !== 'N/A') {
                const qty = getContainerInfo(r).qty;
                if (!clientCount[cli]) clientCount[cli] = { count: 0, containers: 0 };
                clientCount[cli].count++;
                clientCount[cli].containers += qty;
            }
        });
        const sortedClients = Object.entries(clientCount).sort((a, b) => b[1].containers - a[1].containers || b[1].count - a[1].count);
        
        if (card2Label) card2Label.textContent = 'Principal Cliente';
        if (sortedClients.length > 0) {
            const topCli = sortedClients[0];
            freetimeVal.innerText = topCli[0].length > 25 
                ? topCli[0].substring(0, 25) + '...' 
                : topCli[0];
            freetimeRoute.innerText = `${topCli[1].containers} cntrs, ${topCli[1].count} ${typeLabel.toLowerCase()} | ${sortedClients.length} clientes no total`;
        } else {
            freetimeVal.innerText = 'N/A';
            freetimeRoute.innerText = 'Nenhum cliente identificado';
        }

        // Card 3: Maior Rota (by container volume) + clients on that route
        const routeMap = {};
        data.forEach(r => {
            const key = `${(r.origem || 'N/A')} → ${(r.destino || 'N/A')}`;
            if (!routeMap[key]) routeMap[key] = { count: 0, containers: 0, clients: new Set() };
            routeMap[key].count++;
            routeMap[key].containers += getContainerInfo(r).qty;
            if (r.cliente && r.cliente !== 'N/A') routeMap[key].clients.add(r.cliente);
        });
        const sortedRoutes = Object.entries(routeMap).sort((a, b) => b[1].containers - a[1].containers || b[1].count - a[1].count);
        
        if (card3Label) card3Label.textContent = 'Maior Rota';
        if (sortedRoutes.length > 0) {
            const topRoute = sortedRoutes[0];
            insightTitle.innerText = topRoute[0];
            const routeClients = [...topRoute[1].clients].slice(0, 2).join(', ');
            insightDesc.innerText = `${topRoute[1].containers} cntrs, ${topRoute[1].count} ${typeLabel.toLowerCase()} | ${routeClients || 'sem cliente'}`;
        } else {
            insightTitle.innerText = 'Sem dados';
            insightDesc.innerText = 'Nenhuma rota encontrada';
        }

        // Card 4: Total no banco
        if (card4Label) card4Label.textContent = 'Banco de Dados Ativo';
        summaryTotal.innerText = `${activeDataset.length} ${typeLabel}`;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const recentItems = activeDataset.filter(r => {
            if (!r.inicio) return false;
            const d = new Date(r.inicio + "T00:00:00");
            const diff = Math.abs(Math.ceil((today - d) / (1000 * 60 * 60 * 24)));
            return diff <= 30;
        });
        summaryValidity.innerText = `${recentItems.length} abertos nos últimos 30d`;

        return;
    }

    // --- Original logic for tariff/space tabs ---
    if (card1Label) card1Label.textContent = 'Melhor Frete Encontrado';
    if (card2Label) card2Label.textContent = 'Maior Free Time';
    if (card3Label) card3Label.textContent = 'Processos Analisados';
    if (card4Label) card4Label.textContent = 'Banco de Dados Ativo';

    if (activeDataset.length === 0) {
        cheapestVal.innerText = "-";
        cheapestRoute.innerText = "Nenhum registro";
        freetimeVal.innerText = "-";
        freetimeRoute.innerText = "Nenhum registro";
        insightTitle.innerText = "Carregue Dados";
        insightDesc.innerText = "Aguardando planilha...";
        summaryTotal.innerText = "0 registros";
        summaryValidity.innerText = "Sem dados";
        return;
    }

    // 1. Cheapest Freight
    const sortedPrices = [...activeDataset].filter(r => r.valor > 0).sort((a,b) => a.valor - b.valor);
    if (sortedPrices.length > 0) {
        const cheapest = sortedPrices[0];
        cheapestVal.innerText = `${cheapest.moeda} ${cheapest.valor.toLocaleString('pt-BR')}`;
        cheapestRoute.innerText = `${cheapest.origem} ➔ ${cheapest.destino} (${cheapest.container})`;
        
        document.getElementById('card-cheapest').onclick = () => {
            resetAllFilters();
            selectOrigem.value = cheapest.origem;
            selectDestino.value = cheapest.destino;
            applyFilters();
        };
    }

    // 2. Highest Free time
    const sortedFreetime = [...activeDataset].sort((a,b) => b.freetime - a.freetime);
    if (sortedFreetime.length > 0 && sortedFreetime[0].freetime > 0) {
        const bestFreetime = sortedFreetime[0];
        freetimeVal.innerText = `${bestFreetime.freetime} Dias`;
        freetimeRoute.innerText = `${bestFreetime.origem} ➔ ${bestFreetime.destino} via ${bestFreetime.armador}`;
        
        document.getElementById('card-freetime').onclick = () => {
            resetAllFilters();
            selectOrigem.value = bestFreetime.origem;
            selectDestino.value = bestFreetime.destino;
            selectArmador.value = bestFreetime.armador;
            applyFilters();
        };
    } else {
        freetimeVal.innerText = "-";
        freetimeRoute.innerText = "Nenhum registro";
    }

    // 3. AI Opportunity Insight generator
    generateAiInsights(activeDataset);

    // 4. Data Summary Card
    const labelType = activeDb === "all" ? "Tarifas/Spaces" : activeDb === "rate" ? "Tarifas" : "Espaços";
    summaryTotal.innerText = `${activeDataset.length} ${labelType}`;
    
    const today = new Date();
    today.setHours(0,0,0,0);
    const activeItems = activeDataset.filter(r => {
        if (!r.fim) return true;
        const expiry = new Date(r.fim + "T00:00:00");
        return expiry >= today;
    });

    const percentActive = Math.round((activeItems.length / activeDataset.length) * 100);
    summaryValidity.innerText = `${percentActive}% ativos hoje`;
    
    document.getElementById('card-summary').onclick = () => {
        resetAllFilters();
    };
}

function generateAiInsights(dataset) {
    const hc40Rates = dataset.filter(r => (r.container || '').toUpperCase().includes("40' HIGH CUBE") && r.valor > 0);
    
    const getSourceLabel = (src) => {
        if (src === 'space') return 'Space';
        if (src === 'operational') return 'Operacional';
        if (src === 'commercial') return 'Comercial';
        return 'Tarifa';
    };

    if (hc40Rates.length > 0) {
        hc40Rates.sort((a,b) => a.valor - b.valor);
        const bestOpp = hc40Rates[0];
        
        insightTitle.innerText = `Oportunidade 40' HC`;
        insightDesc.innerText = `Frete especial de ${bestOpp.origem} a ${bestOpp.destino} por ${bestOpp.moeda} ${bestOpp.valor.toLocaleString('pt-BR')} (${getSourceLabel(bestOpp.source)})`;
        
        document.getElementById('card-opportunity').onclick = () => {
            resetAllFilters();
            selectOrigem.value = bestOpp.origem;
            selectDestino.value = bestOpp.destino;
            selectContainer.value = bestOpp.container;
            applyFilters();
        };
    } else {
        const sorted = [...dataset].sort((a,b) => a.valor - b.valor);
        if (sorted.length > 0) {
            const bestOpp = sorted[0];
            insightTitle.innerText = `Rota Destaque`;
            insightDesc.innerText = `${bestOpp.origem} para ${bestOpp.destino} com frete de ${bestOpp.moeda} ${bestOpp.valor.toLocaleString('pt-BR')} (${getSourceLabel(bestOpp.source)})`;
            
            document.getElementById('card-opportunity').onclick = () => {
                resetAllFilters();
                selectOrigem.value = bestOpp.origem;
                selectDestino.value = bestOpp.destino;
                applyFilters();
            };
        } else {
            insightTitle.innerText = `Nenhum registro`;
            insightDesc.innerText = `Aguardando dados...`;
        }
    }
}

/* ==========================================================================
   MODAL MANAGER
   ========================================================================== */

window.openDetailsModal = function(index) {
    const rate = filteredRates[index];
    if (!rate) return;

    // Set texts
    mOrigem.innerText = rate.origem;
    mDestino.innerText = rate.destino;
    const cInfo = getContainerInfo(rate);
    mContainer.innerText = `${cInfo.qty} x ${cInfo.type}`;
    
    const formattedPrice = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: rate.moeda, minimumFractionDigits: 0 }).format(rate.valor);
    mValor.innerText = formattedPrice;
    
    mArmador.innerText = rate.armador;
    mAgente.innerText = rate.source === 'space' 
        ? `${rate.agente} (Space on Hand - ${rate.qtdSpace || 1} un)` 
        : (rate.source === 'operational' ? `${rate.agente} (Operacional - Processo ${rate.processo})` : (rate.source === 'commercial' ? `${rate.agente} (Comercial - Oferta ${rate.processo})` : rate.agente));
    mFreetime.innerText = `${rate.freetime || 0} Dias`;
    
    // Validity string
    const formatDateBR = (dt) => dt && dt.includes('-') ? dt.split('-').reverse().join('/') : (dt || '');
    let validityStr = "Sem data de validade informada";
    if (rate.inicio && rate.fim) {
        validityStr = `${formatDateBR(rate.inicio)} até ${formatDateBR(rate.fim)}`;
    } else if (rate.fim) {
        validityStr = `Até ${formatDateBR(rate.fim)} (ETD Fixo)`;
    }
    mValidade.innerText = validityStr;

    // Operational fields populator
    const mProntidao = document.getElementById('m-prontidao');
    const mPrevisaoEmbarque = document.getElementById('m-previsao-embarque');
    const mPrevisaoAtracacao = document.getElementById('m-previsao-atracacao');
    const mVlCompraFrete = document.getElementById('m-vl-compra-frete');

    if (rate.source === 'operational') {
        document.querySelectorAll('.operational-only').forEach(el => el.style.display = 'flex');
        mProntidao.innerText = formatDateBR(rate.prontidao) || 'Não informada';
        mPrevisaoEmbarque.innerText = formatDateBR(rate.previsaoEmbarque) || 'Não informada';
        mPrevisaoAtracacao.innerText = formatDateBR(rate.previsaoAtracacao) || 'Não informada';
        mVlCompraFrete.innerText = rate.vlCompraFrete ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: rate.moeda, minimumFractionDigits: 0 }).format(rate.vlCompraFrete) : 'N/A';
    } else {
        document.querySelectorAll('.operational-only').forEach(el => el.style.display = 'none');
    }

    // Commercial fields populator
    const mValorVenda = document.getElementById('m-valor-venda');
    const mVlVendaFrete = document.getElementById('m-vl-venda-frete');
    const mTransitTime = document.getElementById('m-transit-time');
    const mTransitHistorico = document.getElementById('m-transit-historico');
    const mStatusCota = document.getElementById('m-status-cota');

    if (rate.source === 'commercial') {
        document.querySelectorAll('.commercial-only').forEach(el => el.style.display = 'flex');
        if (mValorVenda) mValorVenda.innerText = rate.valorVenda ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: rate.moeda, minimumFractionDigits: 0 }).format(rate.valorVenda) : 'N/A';
        if (mVlVendaFrete) mVlVendaFrete.innerText = rate.vlVendaFrete ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: rate.moeda, minimumFractionDigits: 0 }).format(rate.vlVendaFrete) : 'N/A';
        if (mTransitTime) mTransitTime.innerText = rate.transitTime ? `${rate.transitTime} dias` : 'N/A';
        if (mTransitHistorico) mTransitHistorico.innerText = rate.historico ? `${rate.historico} dias` : 'N/A';
        if (mStatusCota) mStatusCota.innerText = rate.analise || 'Sem status';
    } else {
        document.querySelectorAll('.commercial-only').forEach(el => el.style.display = 'none');
    }

    // Observations
    if (rate.observacao && rate.observacao.trim() !== "") {
        mObservacao.innerText = rate.observacao;
        mObservacao.style.fontStyle = "normal";
        mObservacao.style.color = "var(--text-primary)";
    } else {
        mObservacao.innerText = "Nenhuma observação ou restrição de agenciamento informada para esta rota comercial.";
        mObservacao.style.fontStyle = "italic";
        mObservacao.style.color = "var(--text-muted)";
    }

    // Show modal
    detailsModal.classList.add('open');
};

/* ==========================================================================
   CUSTOM AUTOCOMPLETE SUGGESTIONS
   ========================================================================== */

function initAutocomplete() {
    setupAutocomplete('filter-origem', 'suggestions-origem', 'origem');
    setupAutocomplete('filter-destino', 'suggestions-destino', 'destino');
    setupAutocomplete('filter-container', 'suggestions-container', 'container');
    setupAutocomplete('filter-armador', 'suggestions-armador', 'armador');
    setupAutocomplete('filter-pais-origem', 'suggestions-pais-origem', 'paisOrigem');
    setupAutocomplete('filter-cliente', 'suggestions-cliente', 'cliente');
    setupAutocomplete('filter-agente-top', 'suggestions-agente-top', 'agente');
}

function setupAutocomplete(inputId, suggestionsId, fieldName) {
    const input = document.getElementById(inputId);
    const suggestionsBox = document.getElementById(suggestionsId);
    if (!input || !suggestionsBox) return;

    let highlightedIndex = -1;
    let suggestionsList = [];

    // Helper to close the suggestions box
    const closeSuggestions = () => {
        suggestionsBox.classList.add('hidden');
        suggestionsBox.innerHTML = '';
        highlightedIndex = -1;
    };

    // Main show suggestions logic
    const showSuggestionsList = () => {
        const text = input.value.trim().toLowerCase();
        
        // 1. Get unique values for this field from the ACTIVE dataset only
        let combinedData = [];
        if (activeDb === 'all') {
            combinedData = [...appRates, ...appSpace];
        } else if (activeDb === 'rate') {
            combinedData = [...appRates];
        } else if (activeDb === 'space') {
            combinedData = [...appSpace];
        } else if (activeDb === 'operational') {
            combinedData = [...appOperational];
        } else if (activeDb === 'commercial') {
            combinedData = [...appComercial];
        } else if (activeDb === 'apiAll') {
            combinedData = [...appOperational, ...appComercial];
        } else {
            combinedData = [...appRates, ...appSpace];
        }
        const seen = new Set();
        const uniqueValues = [];
        const portFields = ['origem', 'destino'];
        combinedData.forEach(r => {
            let val = r[fieldName];
            if (fieldName === 'container') {
                val = getContainerInfo(r).type;
            }
            if (val && val.trim() !== "") {
                const cleaned = portFields.includes(fieldName) ? cleanPortName(val) : val.trim();
                const lower = cleaned.toLowerCase();
                if (!seen.has(lower)) {
                    seen.add(lower);
                    uniqueValues.push(cleaned);
                }
            }
        });
        uniqueValues.sort((a, b) => a.localeCompare(b, 'pt', { sensitivity: 'base' }));

        // 2. Filter list based on last typed query token (supporting semicolon-separated lists)
        const parts = input.value.split(';').map(s => s.trim().toLowerCase()).filter(s => s !== "");
        const typedQuery = input.value.split(';');
        const queryText = typedQuery[typedQuery.length - 1].trim().toLowerCase();

        // Filter out already selected values
        let filteredUnique = uniqueValues.filter(val => {
            const valLower = val.toLowerCase();
            const isSelected = parts.includes(valLower);
            if (isSelected && valLower === queryText) {
                return true;
            }
            return !isSelected;
        });

        if (queryText === "") {
            suggestionsList = filteredUnique.slice(0, 15);
        } else {
            suggestionsList = filteredUnique.filter(val => 
                val.toLowerCase().includes(queryText)
            );
        }

        // 3. Render list
        if (suggestionsList.length === 0) {
            closeSuggestions();
            return;
        }

        suggestionsBox.innerHTML = '';
        suggestionsList.forEach((value, index) => {
            const div = document.createElement('div');
            div.className = 'autocomplete-suggestion';
            div.innerText = value;
            div.addEventListener('click', () => {
                const currentValues = input.value.split(';').map(s => s.trim()).filter(s => s !== "");
                if (currentValues.length > 0) {
                    currentValues[currentValues.length - 1] = value;
                } else {
                    currentValues.push(value);
                }
                const uniqueSelects = [...new Set(currentValues)];
                input.value = uniqueSelects.join('; ') + '; ';

                // Clear active NLP filter tag if user selected a different autocomplete suggestion
                if (fieldName === 'origem') activeNlpFilters.origem = null;
                if (fieldName === 'destino') activeNlpFilters.destino = null;
                if (fieldName === 'container') activeNlpFilters.container = null;
                if (fieldName === 'armador') activeNlpFilters.armador = null;

                applyFilters();
                closeSuggestions();
                // Keep focus for multi-select: user can start typing the next value
                input.focus();
            });
            suggestionsBox.appendChild(div);
        });

        suggestionsBox.classList.remove('hidden');
        highlightedIndex = -1;
    };

    // Hook events
    input.addEventListener('input', () => {
        showSuggestionsList();
    });

    input.addEventListener('focus', () => {
        showSuggestionsList();
    });

    // Blur handler with timeout to allow clicks to register
    input.addEventListener('blur', () => {
        setTimeout(() => {
            input.value = input.value.replace(/;\s*$/, '');
            closeSuggestions();
        }, 250);
    });

    const updateHighlight = (items) => {
        items.forEach((item, index) => {
            if (index === highlightedIndex) {
                item.classList.add('highlighted');
                item.scrollIntoView({ block: 'nearest' });
            } else {
                item.classList.remove('highlighted');
            }
        });
    };

    // Keydown navigation handler
    input.addEventListener('keydown', (e) => {
        const items = suggestionsBox.querySelectorAll('.autocomplete-suggestion');
        if (suggestionsBox.classList.contains('hidden') || items.length === 0) {
            return;
        }

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            highlightedIndex = (highlightedIndex + 1) % items.length;
            updateHighlight(items);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            highlightedIndex = (highlightedIndex - 1 + items.length) % items.length;
            updateHighlight(items);
        } else if (e.key === 'Enter') {
            if (highlightedIndex >= 0 && highlightedIndex < items.length) {
                e.preventDefault();
                items[highlightedIndex].click();
            }
        } else if (e.key === 'Escape') {
            closeSuggestions();
        }
    });
}

/* ==========================================================================
   VALIDADE DATE MULTI-SELECT FILTER (Excel-style)
   ========================================================================== */

// Global state for selected validade dates
let validadeDateFilterActive = false;
let selectedValidadeDates = new Set(); // empty = all selected

function initValidadeDateFilter() {
    const btn = document.getElementById('btn-validade-filter');
    const dropdown = document.getElementById('validade-dropdown');
    const selectAllBtn = document.getElementById('validade-select-all');
    const deselectAllBtn = document.getElementById('validade-deselect-all');
    if (!btn || !dropdown) return;

    // Toggle dropdown
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (dropdown.classList.contains('hidden')) {
            populateValidadeDates();
            dropdown.classList.remove('hidden');
        } else {
            dropdown.classList.add('hidden');
        }
    });

    // Select all
    selectAllBtn.addEventListener('click', () => {
        selectedValidadeDates.clear();
        validadeDateFilterActive = false;
        populateValidadeDates();
        updateValidadeLabel();
        applyFilters();
    });

    // Deselect all
    deselectAllBtn.addEventListener('click', () => {
        const allDates = getAllValidadeDates();
        validadeDateFilterActive = true;
        selectedValidadeDates.clear();
        populateValidadeDates();
        updateValidadeLabel();
        applyFilters();
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
        if (!btn.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.classList.add('hidden');
        }
    });
}

// ── OBS CATEGORY MULTI-SELECT FILTER ────────────────────────────────────────
function getSelectedObsCategories() {
    const checkboxes = document.querySelectorAll('#obs-options input[type="checkbox"]');
    const total = checkboxes.length;
    const checked = [];
    checkboxes.forEach(cb => { if (cb.checked) checked.push(cb.value); });
    if (checked.length === total || checked.length === 0) return 'all';
    return checked;
}

function updateObsLabel() {
    const label = document.getElementById('obs-filter-label');
    if (!label) return;
    const checkboxes = document.querySelectorAll('#obs-options input[type="checkbox"]');
    const total = checkboxes.length;
    const checked = [];
    checkboxes.forEach(cb => { if (cb.checked) checked.push(cb.parentElement.textContent.trim()); });
    if (checked.length === total || checked.length === 0) {
        label.textContent = 'Todas ▼';
    } else if (checked.length <= 2) {
        label.textContent = checked.join(', ');
    } else {
        label.textContent = `${checked.length} de ${total} selecionados`;
    }
}

function initObsCategoryFilter() {
    const btn = document.getElementById('btn-obs-filter');
    const dropdown = document.getElementById('obs-dropdown');
    const selectAllBtn = document.getElementById('obs-select-all');
    const deselectAllBtn = document.getElementById('obs-deselect-all');
    if (!btn || !dropdown) return;

    // Toggle dropdown
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Close other dropdowns
        const valDropdown = document.getElementById('validade-dropdown');
        if (valDropdown) valDropdown.classList.add('hidden');
        dropdown.classList.toggle('hidden');
    });

    // Select all
    selectAllBtn.addEventListener('click', () => {
        dropdown.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
        updateObsLabel();
        applyFilters();
    });

    // Deselect all
    deselectAllBtn.addEventListener('click', () => {
        dropdown.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
        updateObsLabel();
        applyFilters();
    });

    // On checkbox change
    dropdown.addEventListener('change', () => {
        updateObsLabel();
        applyFilters();
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
        if (!btn.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.classList.add('hidden');
        }
    });

    updateObsLabel();
}

function getAllValidadeDates() {
    let combinedData = [];
    if (activeDb === "all") {
        combinedData = [...appRates, ...appSpace];
    } else if (activeDb === "rate") {
        combinedData = appRates;
    } else if (activeDb === "space") {
        combinedData = appSpace;
    } else if (activeDb === "operational") {
        combinedData = appOperational;
    } else if (activeDb === "commercial") {
        combinedData = appComercial;
    }

    const dateMap = {};
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    combinedData.forEach(r => {
        if (r.fim && r.fim.trim() !== '' && r.fim !== '-') {
            // Normalize date format to DD/MM
            let dateKey = r.fim;
            // Try to parse as YYYY-MM-DD
            const parsed = new Date(r.fim + 'T00:00:00');
            if (!isNaN(parsed.getTime())) {
                dateKey = parsed.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
            }
            if (!dateMap[dateKey]) {
                dateMap[dateKey] = { count: 0, rawDate: parsed, expired: false };
            }
            dateMap[dateKey].count++;
            if (!isNaN(parsed.getTime()) && parsed < today) {
                dateMap[dateKey].expired = true;
            }
        }
    });

    // Sort by date
    return Object.entries(dateMap).sort((a, b) => {
        const da = a[1].rawDate, db = b[1].rawDate;
        if (isNaN(da)) return 1;
        if (isNaN(db)) return -1;
        return da - db;
    });
}

function populateValidadeDates() {
    const container = document.getElementById('validade-options');
    if (!container) return;
    container.innerHTML = '';

    const dates = getAllValidadeDates();

    dates.forEach(([dateKey, info]) => {
        const isSelected = !validadeDateFilterActive || selectedValidadeDates.has(dateKey);
        const label = document.createElement('label');
        label.className = `validade-option${info.expired ? ' expired-date' : ''}`;
        label.innerHTML = `
            <span style="display: flex; align-items: center; gap: 8px;">
                <input type="checkbox" ${isSelected ? 'checked' : ''} value="${dateKey}">
                <span>${dateKey}${info.expired ? ' (Expirado)' : ''}</span>
            </span>
            <span class="date-count">${info.count}</span>
        `;
        const checkbox = label.querySelector('input');
        checkbox.addEventListener('change', () => {
            // If filter was inactive (all selected), transition to active
            // by populating the set with all dates first
            if (!validadeDateFilterActive) {
                validadeDateFilterActive = true;
                dates.forEach(([dk]) => selectedValidadeDates.add(dk));
            }
            
            if (checkbox.checked) {
                selectedValidadeDates.add(dateKey);
            } else {
                selectedValidadeDates.delete(dateKey);
            }
            // If all are selected, reset to "all"
            if (selectedValidadeDates.size >= dates.length) {
                validadeDateFilterActive = false;
                selectedValidadeDates.clear();
            }
            updateValidadeLabel();
            applyFilters();
        });
        container.appendChild(label);
    });
}

function updateValidadeLabel() {
    const label = document.getElementById('validade-filter-label');
    if (!label) return;
    if (!validadeDateFilterActive) {
        label.textContent = 'Todas as datas';
    } else if (selectedValidadeDates.size === 0) {
        label.textContent = 'Nenhuma data';
    } else if (selectedValidadeDates.size === 1) {
        label.textContent = [...selectedValidadeDates][0];
    } else {
        label.textContent = `${selectedValidadeDates.size} datas`;
    }
}

function filterByValidadeDate(rate) {
    if (!validadeDateFilterActive) return true;
    if (selectedValidadeDates.size === 0) return false;
    if (!rate.fim || rate.fim.trim() === '' || rate.fim === '-') return false;
    
    // Normalize
    const parsed = new Date(rate.fim + 'T00:00:00');
    if (!isNaN(parsed.getTime())) {
        const dateKey = parsed.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        return selectedValidadeDates.has(dateKey);
    }
    return selectedValidadeDates.has(rate.fim);
}

function initStatusFilter() {
    const btn = document.getElementById('btn-status-filter');
    const dropdown = document.getElementById('status-dropdown');
    const selectAllBtn = document.getElementById('status-select-all');
    const deselectAllBtn = document.getElementById('status-deselect-all');
    if (!btn || !dropdown) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (dropdown.classList.contains('hidden')) {
            populateStatusOptions();
            dropdown.classList.remove('hidden');
        } else {
            dropdown.classList.add('hidden');
        }
    });

    selectAllBtn.addEventListener('click', () => {
        selectedStatus.clear();
        statusFilterActive = false;
        populateStatusOptions();
        updateStatusLabel();
        applyFilters();
    });

    deselectAllBtn.addEventListener('click', () => {
        const statuses = getAllStatuses();
        statusFilterActive = true;
        selectedStatus.clear();
        populateStatusOptions();
        updateStatusLabel();
        applyFilters();
    });

    document.addEventListener('click', (e) => {
        if (!btn.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.classList.add('hidden');
        }
    });
}

/* ==========================================================================
   FASE (PHASE) MULTI-SELECT FILTER
   ========================================================================== */

const FASE_OPTIONS = [
    { value: 'pre-sem-booking', label: 'S/ Booking', color: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
    { value: 'pre-com-booking', label: 'C/ Booking', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
    { value: 'em-transito', label: 'Em Trânsito', color: '#3b82f6', bg: 'rgba(59,130,246,0.12)' },
    { value: 'atracado', label: 'Atracado', color: '#10b981', bg: 'rgba(16,185,129,0.12)' }
];

function initFaseFilter() {
    const btn = document.getElementById('btn-fase-filter');
    const dropdown = document.getElementById('fase-dropdown');
    const selectAllBtn = document.getElementById('fase-select-all');
    const deselectAllBtn = document.getElementById('fase-deselect-all');
    if (!btn || !dropdown) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (dropdown.classList.contains('hidden')) {
            populateFaseOptions();
            dropdown.classList.remove('hidden');
        } else {
            dropdown.classList.add('hidden');
        }
    });

    selectAllBtn.addEventListener('click', () => {
        faseFilterActive = false;
        selectedFases.clear();
        populateFaseOptions();
        updateFaseLabel();
        currentPage = 1;
        applyFilters();
        updateDashboardCards();
    });

    deselectAllBtn.addEventListener('click', () => {
        faseFilterActive = true;
        selectedFases.clear();
        populateFaseOptions();
        updateFaseLabel();
        currentPage = 1;
        applyFilters();
        updateDashboardCards();
    });

    document.addEventListener('click', (e) => {
        if (!btn.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.classList.add('hidden');
        }
    });
}

function populateFaseOptions() {
    const container = document.getElementById('fase-options');
    if (!container) return;
    container.innerHTML = '';

    // Count occurrences of each phase in current operational data
    const phaseCounts = {};
    FASE_OPTIONS.forEach(opt => { phaseCounts[opt.value] = 0; });
    
    const operationalData = appOperational || [];
    operationalData.forEach(r => {
        const phase = getProcessPhase(r);
        if (phaseCounts[phase] !== undefined) {
            phaseCounts[phase]++;
        }
    });

    FASE_OPTIONS.forEach(opt => {
        const count = phaseCounts[opt.value] || 0;
        const isSelected = !faseFilterActive || selectedFases.has(opt.value);
        const label = document.createElement('label');
        label.className = 'validade-option';
        label.innerHTML = `
            <span style="display: flex; align-items: center; gap: 8px;">
                <input type="checkbox" ${isSelected ? 'checked' : ''} value="${opt.value}">
                <span style="display:inline-flex;align-items:center;gap:6px;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${opt.color};"></span>${opt.label}</span>
            </span>
            <span class="date-count">${count}</span>
        `;
        const checkbox = label.querySelector('input');
        checkbox.addEventListener('change', () => {
            if (!faseFilterActive) {
                // First uncheck: activate filter, add all then remove this one
                faseFilterActive = true;
                FASE_OPTIONS.forEach(o => selectedFases.add(o.value));
            }
            
            if (checkbox.checked) {
                selectedFases.add(opt.value);
            } else {
                selectedFases.delete(opt.value);
            }
            // If all are selected again, deactivate filter
            if (selectedFases.size >= FASE_OPTIONS.length) {
                faseFilterActive = false;
                selectedFases.clear();
            }
            updateFaseLabel();
            currentPage = 1;
            applyFilters();
            updateDashboardCards();
        });
        container.appendChild(label);
    });
}

function updateFaseLabel() {
    const label = document.getElementById('fase-filter-label');
    if (!label) return;
    if (!faseFilterActive) {
        label.textContent = 'Todas as Fases';
    } else if (selectedFases.size === 0) {
        label.textContent = 'Nenhuma Fase';
    } else if (selectedFases.size === 1) {
        const val = [...selectedFases][0];
        const opt = FASE_OPTIONS.find(o => o.value === val);
        label.textContent = opt ? opt.label : val;
    } else {
        label.textContent = `${selectedFases.size} fases`;
    }
}

/* ==========================================================================
   SITUAÇÃO (DS_STATUS_PROCESSO) MULTI-SELECT FILTER
   ========================================================================== */

function initSituacaoFilter() {
    const btn = document.getElementById('btn-situacao-filter');
    const dropdown = document.getElementById('situacao-dropdown');
    const selectAllBtn = document.getElementById('situacao-select-all');
    const deselectAllBtn = document.getElementById('situacao-deselect-all');
    if (!btn || !dropdown) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (dropdown.classList.contains('hidden')) {
            populateSituacaoOptions();
            dropdown.classList.remove('hidden');
        } else {
            dropdown.classList.add('hidden');
        }
    });

    selectAllBtn.addEventListener('click', () => {
        situacaoFilterActive = false;
        selectedSituacao.clear();
        populateSituacaoOptions();
        updateSituacaoLabel();
        currentPage = 1;
        applyFilters();
        updateDashboardCards();
    });

    deselectAllBtn.addEventListener('click', () => {
        situacaoFilterActive = true;
        selectedSituacao.clear();
        populateSituacaoOptions();
        updateSituacaoLabel();
        currentPage = 1;
        applyFilters();
        updateDashboardCards();
    });

    document.addEventListener('click', (e) => {
        if (!btn.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.classList.add('hidden');
        }
    });
}

function populateSituacaoOptions() {
    const container = document.getElementById('situacao-options');
    if (!container) return;
    container.innerHTML = '';

    // Count occurrences of each situação in operational data
    const sitCounts = {};
    const operationalData = appOperational || [];
    operationalData.forEach(r => {
        const sit = (r.statusProcesso || 'Aberto').trim();
        sitCounts[sit] = (sitCounts[sit] || 0) + 1;
    });

    // Sort: "Aberto" first, then alphabetical
    const sorted = Object.entries(sitCounts).sort((a, b) => {
        if (a[0] === 'Aberto') return -1;
        if (b[0] === 'Aberto') return 1;
        return a[0].localeCompare(b[0]);
    });

    const SITUACAO_COLORS = {
        'Aberto': { color: '#10b981' },
        'Cancelado': { color: '#ef4444' }
    };

    sorted.forEach(([sitVal, count]) => {
        const isSelected = !situacaoFilterActive || selectedSituacao.has(sitVal);
        const colorInfo = SITUACAO_COLORS[sitVal] || { color: '#888' };
        const label = document.createElement('label');
        label.className = 'validade-option';
        label.innerHTML = `
            <span style="display: flex; align-items: center; gap: 8px;">
                <input type="checkbox" ${isSelected ? 'checked' : ''} value="${sitVal}">
                <span style="display:inline-flex;align-items:center;gap:6px;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${colorInfo.color};"></span>${sitVal}</span>
            </span>
            <span class="date-count">${count}</span>
        `;
        const checkbox = label.querySelector('input');
        checkbox.addEventListener('change', () => {
            if (!situacaoFilterActive) {
                situacaoFilterActive = true;
                sorted.forEach(([sv]) => selectedSituacao.add(sv));
            }
            
            if (checkbox.checked) {
                selectedSituacao.add(sitVal);
            } else {
                selectedSituacao.delete(sitVal);
            }
            if (selectedSituacao.size >= sorted.length) {
                situacaoFilterActive = false;
                selectedSituacao.clear();
            }
            updateSituacaoLabel();
            currentPage = 1;
            applyFilters();
            updateDashboardCards();
        });
        container.appendChild(label);
    });
}

function updateSituacaoLabel() {
    const label = document.getElementById('situacao-filter-label');
    if (!label) return;
    if (!situacaoFilterActive) {
        label.textContent = 'Todos';
    } else if (selectedSituacao.size === 0) {
        label.textContent = 'Nenhum';
    } else if (selectedSituacao.size === 1) {
        label.textContent = [...selectedSituacao][0];
    } else {
        label.textContent = `${selectedSituacao.size} situações`;
    }
}

function getAllStatuses() {
    let combinedData = [];
    if (activeDb === "all") {
        combinedData = [...appRates, ...appSpace];
    } else if (activeDb === "rate") {
        combinedData = appRates;
    } else if (activeDb === "space") {
        combinedData = appSpace;
    } else if (activeDb === "operational") {
        combinedData = appOperational;
    } else if (activeDb === "commercial") {
        combinedData = appComercial;
    } else if (activeDb === "apiAll") {
        combinedData = [...appOperational, ...appComercial];
    }

    const statusMap = {};
    combinedData.forEach(r => {
        const statusVal = (r.analise || 'Sem Status').trim();
        if (!statusMap[statusVal]) {
            statusMap[statusVal] = 0;
        }
        statusMap[statusVal]++;
    });

    return Object.entries(statusMap).sort((a, b) => b[1] - a[1]);
}

function populateStatusOptions() {
    const container = document.getElementById('status-options');
    if (!container) return;
    container.innerHTML = '';

    const statuses = getAllStatuses();

    statuses.forEach(([statusVal, count]) => {
        const isSelected = !statusFilterActive || selectedStatus.has(statusVal);
        const label = document.createElement('label');
        label.className = `validade-option`;
        label.innerHTML = `
            <span style="display: flex; align-items: center; gap: 8px;">
                <input type="checkbox" ${isSelected ? 'checked' : ''} value="${statusVal}">
                <span>${statusVal}</span>
            </span>
            <span class="date-count">${count}</span>
        `;
        const checkbox = label.querySelector('input');
        checkbox.addEventListener('change', () => {
            if (!statusFilterActive) {
                statusFilterActive = true;
                statuses.forEach(([sv]) => selectedStatus.add(sv));
            }
            
            if (checkbox.checked) {
                selectedStatus.add(statusVal);
            } else {
                selectedStatus.delete(statusVal);
            }
            if (selectedStatus.size >= statuses.length) {
                statusFilterActive = false;
                selectedStatus.clear();
            }
            updateStatusLabel();
            applyFilters();
        });
        container.appendChild(label);
    });
}

function updateStatusLabel() {
    const label = document.getElementById('status-filter-label');
    if (!label) return;
    if (!statusFilterActive) {
        label.textContent = 'Todos os Status';
    } else if (selectedStatus.size === 0) {
        label.textContent = 'Nenhum Status';
    } else if (selectedStatus.size === 1) {
        label.textContent = [...selectedStatus][0];
    } else {
        label.textContent = `${selectedStatus.size} status`;
    }
}

function filterByStatus(rate) {
    if (!statusFilterActive) return true;
    if (selectedStatus.size === 0) return false;
    const statusVal = (rate.analise || 'Sem Status').trim();
    return selectedStatus.has(statusVal);
}

/* ==========================================================================
   EXCEL-STYLE COLUMN MULTI-SELECT FILTERS
   ========================================================================== */

// Global state: { fieldName: Set of selected values } — empty set means "all selected"
const columnMultiFilters = {};
const columnMultiFilterActive = {};

function initColumnFilters() {
    // Attach click listeners to filter toggle buttons
    document.querySelectorAll('.col-filter-toggle').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            const field = btn.getAttribute('data-field');
            const th = btn.closest('th');
            const dropdown = th.querySelector('.col-filter-dropdown');
            
            // Close all other dropdowns
            document.querySelectorAll('.col-filter-dropdown').forEach(d => {
                if (d !== dropdown) d.classList.add('hidden');
            });

            if (dropdown.classList.contains('hidden')) {
                populateColumnFilter(field, dropdown);
                dropdown.classList.remove('hidden');
                const searchInput = dropdown.querySelector('.filter-search');
                if (searchInput) setTimeout(() => searchInput.focus(), 50);
            } else {
                dropdown.classList.add('hidden');
            }
        });
    });

    // Close dropdowns on outside click
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.col-filterable')) {
            document.querySelectorAll('.col-filter-dropdown').forEach(d => d.classList.add('hidden'));
        }
    });

    // Prevent sort when clicking inside dropdown
    document.querySelectorAll('.col-filter-dropdown').forEach(d => {
        d.addEventListener('click', (e) => e.stopPropagation());
    });
}

function getColumnUniqueValues(field) {
    // Build data set based on active tab
    let combinedData;
    if (activeDb === 'operational') combinedData = [...appOperational];
    else if (activeDb === 'commercial') combinedData = [...appComercial];
    else if (activeDb === 'apiAll') combinedData = [...appOperational, ...appComercial];
    else if (activeDb === 'rate') combinedData = [...appRates];
    else if (activeDb === 'space') combinedData = [...appSpace];
    else combinedData = [...appRates, ...appSpace];
    
    const caseMap = {};
    const valueMap = {}; // Local declaration to prevent mixing columns!
    const isApiTab = (activeDb === 'operational' || activeDb === 'commercial' || activeDb === 'apiAll');
    
    combinedData.forEach(r => {
        let val = field === 'obs' ? r.observacao : r[field];
        if (field === 'freetime') {
            // For API tabs, this column shows status/phase instead of freetime
            if (isApiTab) {
                if (r.source === 'commercial') {
                    val = r.analise || 'Sem status';
                } else if (r.source === 'operational') {
                    const phase = getProcessPhase(r);
                    val = getPhaseDisplay(phase).label;
                } else {
                    val = String(val || 0) + 'd';
                }
            } else {
                val = String(val || 0) + 'd';
            }
        } else if (field === 'fim') {
            if (val && val.includes('-')) {
                const parts = val.split('-');
                if (parts.length === 3) {
                    val = `${parts[2]}/${parts[1]}/${parts[0]}`;
                }
            } else if (!val || val === '-') {
                val = 'Sem Validade';
            }
        } else if (field === 'container') {
            val = getContainerInfo(r).type;
        } else if (field === 'origem' || field === 'destino') {
            val = cleanPortName(val);
        } else {
            val = String(val || '').trim();
        }
        if (val && val !== '' && val !== 'undefined') {
            const lower = val.toLowerCase();
            if (!caseMap[lower]) {
                caseMap[lower] = val;
            }
            const mappedVal = caseMap[lower];
            if (!valueMap[mappedVal]) valueMap[mappedVal] = 0;
            valueMap[mappedVal]++;
        }
    });

    return Object.entries(valueMap).sort((a, b) => {
        if (field === 'fim') {
            if (a[0] === 'Sem Validade') return 1;
            if (b[0] === 'Sem Validade') return -1;
            const parseDMY = (s) => {
                const p = s.split('/');
                if (p.length === 3) {
                    const d = parseInt(p[0], 10);
                    const m = parseInt(p[1], 10);
                    const y = parseInt(p[2], 10);
                    if (!isNaN(d) && !isNaN(m) && !isNaN(y)) {
                        return new Date(y, m - 1, d).getTime();
                    }
                }
                return 0;
            };
            return parseDMY(a[0]) - parseDMY(b[0]);
        }
        return a[0].localeCompare(b[0], 'pt', { sensitivity: 'base' });
    });
}

function populateColumnFilter(field, dropdown) {
    const values = getColumnUniqueValues(field);
    const isActive = columnMultiFilterActive[field] || false;
    const selected = columnMultiFilters[field] || new Set();

    dropdown.innerHTML = `
        <input type="text" class="filter-search" placeholder="Buscar...">
        <div class="filter-actions">
            <button class="btn-sel-all">Todas</button>
            <button class="btn-desel-all">Nenhuma</button>
        </div>
        <div class="col-filter-options"></div>
    `;

    const searchInput = dropdown.querySelector('.filter-search');
    const optionsContainer = dropdown.querySelector('.col-filter-options');
    const btnAll = dropdown.querySelector('.btn-sel-all');
    const btnNone = dropdown.querySelector('.btn-desel-all');

    const renderOptions = (filterText = '') => {
        optionsContainer.innerHTML = '';
        const filteredValues = filterText 
            ? values.filter(([val]) => val.toLowerCase().includes(filterText.toLowerCase()))
            : values;

        filteredValues.forEach(([val, count]) => {
            const isChecked = !isActive || selected.has(val);
            const label = document.createElement('label');
            label.className = 'col-filter-option';
            label.innerHTML = `
                <input type="checkbox" ${isChecked ? 'checked' : ''} value="${val.replace(/"/g, '&quot;')}">
                <span>${val}</span>
                <span class="opt-count">${count}</span>
            `;
            const checkbox = label.querySelector('input');
            checkbox.addEventListener('change', () => {
                if (!columnMultiFilters[field]) columnMultiFilters[field] = new Set();
                columnMultiFilterActive[field] = true;
                
                if (checkbox.checked) {
                    columnMultiFilters[field].add(val);
                } else {
                    columnMultiFilters[field].delete(val);
                }

                // If all are selected, reset to "all"
                if (columnMultiFilters[field].size >= values.length) {
                    columnMultiFilterActive[field] = false;
                    columnMultiFilters[field] = new Set();
                }

                updateColumnFilterIndicator(field);
                applyFilters();
            });
            optionsContainer.appendChild(label);
        });
    };

    renderOptions();

    searchInput.addEventListener('input', () => renderOptions(searchInput.value));

    btnAll.addEventListener('click', () => {
        columnMultiFilterActive[field] = false;
        columnMultiFilters[field] = new Set();
        renderOptions(searchInput.value);
        updateColumnFilterIndicator(field);
        applyFilters();
    });

    btnNone.addEventListener('click', () => {
        columnMultiFilterActive[field] = true;
        columnMultiFilters[field] = new Set();
        renderOptions(searchInput.value);
        updateColumnFilterIndicator(field);
        applyFilters();
    });
}

function updateColumnFilterIndicator(field) {
    const th = document.querySelector(`th[data-field="${field}"]`);
    if (!th) return;
    if (columnMultiFilterActive[field]) {
        th.classList.add('col-filter-active');
    } else {
        th.classList.remove('col-filter-active');
    }
}

function filterByColumnMultiSelect(rate) {
    for (const field of Object.keys(columnMultiFilterActive)) {
        if (!columnMultiFilterActive[field]) continue;
        const selected = columnMultiFilters[field];
        if (!selected || selected.size === 0) return false; // "Nenhuma" selected
        
        let val;
        if (field === 'freetime') {
            const isApiTab = (activeDb === 'operational' || activeDb === 'commercial' || activeDb === 'apiAll');
            if (isApiTab) {
                if (rate.source === 'commercial') {
                    val = rate.analise || 'Sem status';
                } else if (rate.source === 'operational') {
                    const phase = getProcessPhase(rate);
                    val = getPhaseDisplay(phase).label;
                } else {
                    val = String(rate[field] || 0) + 'd';
                }
            } else {
                val = String(rate[field] || 0) + 'd';
            }
        } else if (field === 'fim') {
            const rawVal = rate[field];
            if (rawVal && rawVal.includes('-')) {
                const parts = rawVal.split('-');
                if (parts.length === 3) {
                    val = `${parts[2]}/${parts[1]}/${parts[0]}`;
                } else {
                    val = rawVal;
                }
            } else {
                val = 'Sem Validade';
            }
                } else if (field === 'container') {
            val = getContainerInfo(rate).type;
        } else if (field === 'obs') {
            val = rate.observacao || '';
        } else if (field === 'origem' || field === 'destino') {
            val = cleanPortName(rate[field]);
        } else {
            val = String(rate[field] || '').trim();
        }
        
        let hasMatch = false;
        for (const sVal of selected) {
            if (sVal.toLowerCase() === val.toLowerCase()) {
                hasMatch = true;
                break;
            }
        }
        if (!hasMatch) return false;
    }
    return true;
}

/* ==========================================================================
   ETD HEADER LABEL SWITCHING
   ========================================================================== */

function updateValidadeHeaderLabel() {
    const thValidade = document.getElementById('th-validade');
    if (!thValidade) return;
    const label = thValidade.querySelector('.th-label');
    if (!label) return;
    
    if (activeDb === 'operational' || activeDb === 'commercial' || activeDb === 'apiAll') {
        label.textContent = 'Abertura';
    } else if (activeDb === 'space') {
        label.textContent = 'ETD';
    } else if (activeDb === 'all') {
        label.textContent = 'Validade / ETD';
    } else {
        label.textContent = 'Validade';
    }
}

/* ==========================================================================
   INTELLIGENCE TAB MANAGER
   ========================================================================== */

function renderIntelTab() {
    initAiBoardTab();
}

window.filterRouteInPainel = function(origem, destino, container) {
    const tabLinkSearch = document.querySelector('.tab-link[data-tab="search-tab-panel"]');
    if (tabLinkSearch) tabLinkSearch.click();
    
    resetAllFilters();
    selectOrigem.value = origem;
    selectDestino.value = destino;
    selectContainer.value = container;
    
    applyFilters();
};

/* ==========================================================================
   RECOMPRA DE FRETES (ANALYSIS TABS) IMPLEMENTATION
   ========================================================================== */

function normalizePortName(name) {
    if (!name) return "";
    let n = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .replace('port', '')
        .replace('terminal', '')
        .trim();
    // Canonical aliases: Tianjin, Xingang, Tianjin Xingang → "tianjin"
    if (n === 'xingang' || n === 'tianjinxingang' || n === 'tianjin') n = 'tianjin';
    // Shenzhen / Shekou / Yantian
    if (n === 'shekou' || n === 'yantian') n = 'shenzhen';
    return n;
}

function getAnalysisData() {
    const rawProcesses = analysisSource === 'commercial' ? appComercial : appOperational;
    
    // Recompra: filtrar apenas processos pendentes (não embarcados, não atracados, últimos 6 meses)
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - 6);
    const isValidDateStr = (d) => {
        if (!d) return false;
        const s = String(d).trim();
        if (s === '' || s === '-' || s.startsWith('0001') || s.startsWith('1900-01-01') || s.startsWith('00/00')) return false;
        return true;
    };
    const today = new Date();
    today.setHours(0,0,0,0);

    const processes = rawProcesses.filter(proc => {
        // Excluir cancelados
        const status = (proc.statusProcesso || '').trim().toLowerCase();
        if (status === 'cancelado') return false;
        // Excluir já embarcados — checar tanto o valor parseado quanto o cru
        if (isValidDateStr(proc.confirmacaoEmbarque) || isValidDateStr(proc.rawConfirmacaoEmbarque)) return false;
        // Excluir já atracados
        if (isValidDateStr(proc.confirmacaoAtracacao) || isValidDateStr(proc.rawConfirmacaoAtracacao)) return false;
        // ETD já passou (≤ hoje) → carga já embarcou ou está embarcando, remover
        if (proc.previsaoEmbarque) {
            const etd = new Date(proc.previsaoEmbarque + "T00:00:00");
            if (!isNaN(etd.getTime()) && etd <= today) return false;
        }
        // Só últimos 6 meses
        if (proc.inicio) {
            const aberturaDate = new Date(proc.inicio + "T00:00:00");
            if (!isNaN(aberturaDate.getTime()) && aberturaDate < cutoffDate) return false;
        }
        return true;
    });
    
    // Filtrar por status de booking (com/sem)
    const filteredByBooking = analysisBookingFilter === 'all' ? processes : processes.filter(proc => {
        const phase = getProcessPhase(proc);
        const hasBooking = phase === 'pre-com-booking' || phase === 'em-transito' || phase === 'atracado';
        return analysisBookingFilter === 'com' ? hasBooking : !hasBooking;
    });
    
    const availableOptions = [...appRates, ...appSpace];
    const groupsMap = {};
    
    filteredByBooking.forEach(proc => {
        const normOrig = normalizePortName(proc.origem);
        const normDest = normalizePortName(proc.destino);
        const normContainer = extractContainerType(proc.container);
        const key = `${normOrig}_${normDest}_${normContainer}`;
        
        if (!groupsMap[key]) {
            groupsMap[key] = {
                origem: proc.origem,
                destino: proc.destino,
                container: normContainer,
                processes: [],
                allRates: [],
                savingRates: [],
                bestOption: null,
                totalSaving: 0
            };
        }
        
        const qty = getContainerQty(proc.container);
        groupsMap[key].processes.push({
            ...proc,
            qty: qty,
            valorUnitario: proc.valor
        });
    });
    
    availableOptions.forEach(opt => {
        const normOrig = normalizePortName(opt.origem);
        const normDest = normalizePortName(opt.destino);
        const normContainer = extractContainerType(opt.container);
        const key = `${normOrig}_${normDest}_${normContainer}`;
        
        if (groupsMap[key]) {
            groupsMap[key].allRates.push(opt);
        }
    });
    
    const activeOpportunities = [];
    
    for (const [key, group] of Object.entries(groupsMap)) {
        if (group.allRates.length === 0) continue;
        
        group.allRates.forEach(opt => {
            let potentialEconomy = 0;
            group.processes.forEach(proc => {
                const diff = proc.valorUnitario - opt.valor;
                if (diff > 0) {
                    potentialEconomy += diff * proc.qty;
                }
            });
            opt.potentialEconomy = potentialEconomy;
        });
        
        group.savingRates = group.allRates
            .filter(opt => opt.potentialEconomy > 0)
            .sort((a, b) => a.valor - b.valor);
            
        if (group.savingRates.length === 0) continue;
        
        group.bestOption = group.savingRates[0];
        
        // Filtrar processos: manter apenas os que têm oportunidade de recompra
        // (frete atual > melhor opção) OU frete zerado (precisa de atenção)
        group.processes = group.processes.filter(proc => {
            return proc.valorUnitario > group.bestOption.valor || proc.valorUnitario === 0;
        });
        
        // Se não sobrou nenhum processo qualificado, pular o grupo
        if (group.processes.length === 0) continue;
        
        let totalSaving = 0;
        group.processes.forEach(proc => {
            const diff = proc.valorUnitario - group.bestOption.valor;
            if (diff > 0) {
                totalSaving += diff * proc.qty;
            }
        });
        group.totalSaving = totalSaving;
        
        activeOpportunities.push(group);
    }
    
    return {
        opportunities: activeOpportunities,
        allPendingProcessesCount: filteredByBooking.length,
        totalEconomyAllRoutes: activeOpportunities.reduce((sum, g) => sum + g.totalSaving, 0)
    };
}

window.copyToClipboard = function(text, elId) {
    navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById(elId);
        if (btn) {
            const oldHtml = btn.innerHTML;
            btn.innerHTML = `<i data-lucide="check" style="color:#10b981; width:12px; height:12px;"></i>`;
            lucide.createIcons();
            setTimeout(() => {
                btn.innerHTML = oldHtml;
                lucide.createIcons();
            }, 1500);
        }
    }).catch(err => {
        console.error("Erro ao copiar: ", err);
    });
};

window.renderAnalysisTab = function() {
    const data = getAnalysisData();
    
    const formatSaving = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(data.totalEconomyAllRoutes);
    
    document.getElementById('analysis-total-saving').innerText = formatSaving;
    document.getElementById('analysis-total-ops').innerText = data.opportunities.length;
    document.getElementById('analysis-total-processes').innerText = data.allPendingProcessesCount;
    
    // Update stats cards labels dynamically
    const totalProcessesLabel = document.querySelector('.opportunity-card:nth-child(3) .card-label');
    const totalProcessesSubtitle = document.querySelector('.opportunity-card:nth-child(3) .card-meta');
    if (totalProcessesLabel) {
        totalProcessesLabel.textContent = analysisSource === 'commercial' ? 'Ofertas Analisadas' : 'Processos Analisados';
    }
    if (totalProcessesSubtitle) {
        totalProcessesSubtitle.textContent = analysisSource === 'commercial' ? 'Ofertas ativas' : 'Cargas ativas não embarcadas';
    }
    
    // Subtab counts (may not exist anymore)
    const subtabCountOpps = document.getElementById('subtab-count-opportunities');
    if (subtabCountOpps) subtabCountOpps.innerText = data.opportunities.length;
    const subtabCountComplete = document.getElementById('subtab-count-complete');
    if (subtabCountComplete) subtabCountComplete.innerText = data.allPendingProcessesCount;
    
    // Always render opportunities (main view)
    renderAnalysisOpportunities();
};

window.renderAnalysisOpportunities = function() {
    const container = document.getElementById('analysis-opportunities-container');
    container.innerHTML = "";
    
    const isObservationNa = (obs) => {
        const clean = String(obs || '').trim().toUpperCase();
        return clean === '' || clean === 'N/A' || clean === 'N.A' || clean === 'N.A.' || clean === 'NA';
    };
    
    const getContainerAbbr = (type) => {
        const t = String(type || '').toUpperCase().trim();
        if (t.includes("40' HIGH CUBE") || t.includes("40HC") || t.includes("40HQ") || t.includes("40' HQ")) return '40HC';
        if (t.includes("20' DRY") || t.includes("20GP") || t.includes("20DRY") || t.includes("20' GP")) return '20GP';
        if (t.includes("40' DRY") || t.includes("40GP") || t.includes("40DRY") || t.includes("40' GP")) return '40GP';
        if (t.includes("40' NOR") || t.includes("40NOR") || t.includes("40' NOR")) return '40NOR';
        return t;
    };
    
    const data = getAnalysisData();
    let opps = data.opportunities;
    
    const searchVal = document.getElementById('analysis-route-search').value.toLowerCase().trim();
    if (searchVal !== "") {
        opps = opps.filter(g => 
            g.origem.toLowerCase().includes(searchVal) || 
            g.destino.toLowerCase().includes(searchVal) ||
            (g.processes && g.processes.some(p => 
                (p.cliente || '').toLowerCase().includes(searchVal) ||
                (p.agente || '').toLowerCase().includes(searchVal) ||
                (p.processo || '').toLowerCase().includes(searchVal)
            )) ||
            (g.savingRates && g.savingRates.some(r =>
                (r.agente || '').toLowerCase().includes(searchVal) ||
                (r.armador || '').toLowerCase().includes(searchVal)
            ))
        );
    }
    
    // Re-group based on analysisGroupBy
    let groupedData = [];
    
    if (analysisGroupBy === 'rota') {
        // Default — already grouped by route
        groupedData = opps;
    } else if (analysisGroupBy === 'agente') {
        // Group by agente (from savingRates — who offers the better rate)
        const agenteMap = {};
        opps.forEach(routeGroup => {
            const matchedProcessesByAgent = {};
            
            routeGroup.savingRates.forEach(rate => {
                const agKey = (rate.agente || 'N/A').trim();
                if (!agenteMap[agKey]) {
                    agenteMap[agKey] = {
                        label: agKey,
                        processes: [],
                        savingRates: [],
                        totalSaving: 0,
                        processCount: 0
                    };
                }
                
                if (!matchedProcessesByAgent[agKey]) {
                    matchedProcessesByAgent[agKey] = new Set();
                }
                
                let potentialEconomy = 0;
                const associatedProcs = [];
                
                routeGroup.processes.forEach(proc => {
                    if (matchedProcessesByAgent[agKey].has(proc.processo)) return;
                    
                    if (proc.valorUnitario > rate.valor || proc.valorUnitario === 0) {
                        const diff = Math.max(0, proc.valorUnitario - rate.valor);
                        const saving = diff * proc.qty;
                        potentialEconomy += saving;
                        
                        associatedProcs.push({
                            ...proc,
                            rota: `${routeGroup.origem} ➔ ${routeGroup.destino}`,
                            targetRate: rate,
                            saving: saving
                        });
                        
                        matchedProcessesByAgent[agKey].add(proc.processo);
                    }
                });
                
                if (potentialEconomy > 0 || associatedProcs.length > 0) {
                    const clonedRate = {
                        ...rate,
                        rota: `${routeGroup.origem} ➔ ${routeGroup.destino}`,
                        container: routeGroup.container,
                        potentialEconomy: potentialEconomy
                    };
                    agenteMap[agKey].savingRates.push(clonedRate);
                    
                    associatedProcs.forEach(p => {
                        agenteMap[agKey].processes.push(p);
                        agenteMap[agKey].totalSaving += p.saving;
                        agenteMap[agKey].processCount++;
                    });
                }
            });
        });
        groupedData = Object.values(agenteMap).filter(ag => ag.processes.length > 0);
    } else if (analysisGroupBy === 'cliente') {
        // Group by cliente (from processes)
        const clienteMap = {};
        opps.forEach(routeGroup => {
            const clients = new Set(routeGroup.processes.map(p => (p.cliente || 'N/A').trim()));
            
            clients.forEach(clKey => {
                if (!clienteMap[clKey]) {
                    clienteMap[clKey] = {
                        label: clKey,
                        processes: [],
                        savingRates: [],
                        totalSaving: 0,
                        processCount: 0
                    };
                }
                
                const clientProcs = routeGroup.processes.filter(p => (p.cliente || 'N/A').trim() === clKey);
                if (clientProcs.length === 0) return;
                
                clientProcs.forEach(proc => {
                    const diff = Math.max(0, proc.valorUnitario - routeGroup.bestOption.valor);
                    const saving = diff * proc.qty;
                    
                    clienteMap[clKey].processes.push({
                        ...proc,
                        rota: `${routeGroup.origem} ➔ ${routeGroup.destino}`,
                        saving: saving,
                        bestOption: routeGroup.bestOption
                    });
                    
                    clienteMap[clKey].totalSaving += saving;
                    clienteMap[clKey].processCount++;
                });
                
                routeGroup.savingRates.forEach(rate => {
                    let potentialEconomy = 0;
                    clientProcs.forEach(proc => {
                        const diff = proc.valorUnitario - rate.valor;
                        if (diff > 0) {
                            potentialEconomy += diff * proc.qty;
                        }
                    });
                    
                    if (potentialEconomy > 0) {
                        clienteMap[clKey].savingRates.push({
                            ...rate,
                            rota: `${routeGroup.origem} ➔ ${routeGroup.destino}`,
                            container: routeGroup.container,
                            potentialEconomy: potentialEconomy
                        });
                    }
                });
            });
        });
        groupedData = Object.values(clienteMap).filter(cl => cl.processes.length > 0);
    }
    
    // Sort by total saving
    // Sort by total saving
    groupedData.sort((a, b) => {
        const sA = a.totalSaving || 0;
        const sB = b.totalSaving || 0;
        return analysisSortOrder === 'desc' ? sB - sA : sA - sB;
    });
    
    // For cliente and agente mode, sort sub-arrays by rota/container to enable Option B subgroup headers
    groupedData.forEach(group => {
        if (group.processes) {
            group.processes.sort((a, b) => {
                const rA = String(a.rota || a.origem && `${a.origem} ➔ ${a.destino}` || '').toLowerCase();
                const rB = String(b.rota || b.origem && `${b.origem} ➔ ${b.destino}` || '').toLowerCase();
                if (rA !== rB) return rA.localeCompare(rB);
                
                const cA = String(a.container || '').toLowerCase();
                const cB = String(b.container || '').toLowerCase();
                if (cA !== cB) return cA.localeCompare(cB);
                
                return String(a.processo || '').localeCompare(String(b.processo || ''));
            });
        }
        if (group.savingRates) {
            group.savingRates.sort((a, b) => {
                return (a.valor || 0) - (b.valor || 0);
            });
        }
    });
    
    window.currentGroupedData = groupedData;
    window.selectedBenchmarks = {};
    
    if (groupedData.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon"><i data-lucide="search-x"></i></div>
                <h3>Nenhuma oportunidade encontrada</h3>
                <p>Não há processos operacionais com opções de tarifas mais econômicas para os filtros aplicados.</p>
            </div>
        `;
        lucide.createIcons();
        return;
    }
    
    const fmtCurrency = (val) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(val);
    const formatDateBR = (dt) => {
        if (!dt || dt.startsWith("0001") || dt === "-") return 'N/A';
        return dt.includes('-') ? dt.split('-').reverse().slice(0, 2).join('/') : dt;
    };
    
    if (analysisGroupBy === 'rota') {
        // ===== GROUP BY ROTA (Split Layout Optimized) =====
        groupedData.forEach((group, gIdx) => {
            window.selectedBenchmarks[gIdx] = 0;
            const accordion = document.createElement('div');
            accordion.className = "route-accordion";
            accordion.id = `opp-accordion-${gIdx}`;
            
            const maxSavingFormatted = fmtCurrency(group.totalSaving);
            const bestRateVal = fmtCurrency(group.bestOption.valor);
            const bestCarrierStr = `${group.bestOption.armador} a ${bestRateVal}`;
            const subtitle = `${group.processes.length} ${analysisSource === 'commercial' ? 'oferta(s)' : 'processo(s)'} · Melhor opção por Rota`;
            
            let optionsCardsHtml = "";
            group.savingRates.forEach((opt, oIdx) => {
                const optValFormatted = fmtCurrency(opt.valor);
                const validity = opt.fim ? opt.fim.split('-').reverse().join('/') : (opt.source === 'space' ? 'ETD Spot' : 'N/A');
                const ftStr = opt.freetime ? `${opt.freetime} dias` : '-';
                const cardClasses = [
                    'benchmark-card',
                    oIdx === 0 ? 'selected' : ''
                ].filter(Boolean).join(' ');
                
                const sourceTag = opt.source === 'space'
                    ? `<span class="source-tag source-space">SPACE</span> <span class="badge badge-info" style="padding: 1px 4px; font-size: 0.6rem; line-height: 1.2;">${opt.qtdSpace || 1} un</span>`
                    : `<span class="source-tag source-rate">TARIFA</span>`;
                
                const obsHtml = !isObservationNa(opt.observacao)
                    ? `<div class="benchmark-card-obs" title="${(opt.observacao || '').replace(/"/g, '&quot;')}">${opt.observacao}</div>`
                    : '';
                
                const validityMs = opt.fim ? new Date(opt.fim).getTime() : (opt.source === 'space' ? Date.now() + 10*24*60*60*1000 : 0);
                
                optionsCardsHtml += `
                    <div class="${cardClasses}" data-index="${oIdx}" data-valor="${opt.valor}" data-freetime="${opt.freetime || 0}" data-source="${opt.source}" data-validity-ms="${validityMs}" data-armador="${(opt.armador || '').toLowerCase()}" data-agente="${(opt.agente || '').toLowerCase()}" data-obs="${(opt.observacao || '').toLowerCase()}" data-saving="${opt.potentialEconomy}" onclick="selectBenchmark(${gIdx}, ${oIdx})">
                        <div class="benchmark-card-header">
                            <div class="benchmark-card-selection">
                                <input type="radio" name="benchmark-radio-${gIdx}" ${oIdx === 0 ? 'checked' : ''} onclick="event.stopPropagation(); selectBenchmark(${gIdx}, ${oIdx})">
                                <div class="benchmark-card-carrier">
                                    <strong>${opt.armador}</strong>
                                    <span class="benchmark-card-agent">${opt.agente}</span>
                                </div>
                            </div>
                            <div class="benchmark-card-price">${optValFormatted}</div>
                        </div>
                        <div class="benchmark-card-body">
                            <div class="benchmark-card-meta">
                                <span>Validade/ETD: <strong>${validity}</strong></span>
                                <span>FT: <strong>${ftStr}</strong></span>
                            </div>
                            ${obsHtml}
                            <div class="benchmark-card-footer">
                                ${sourceTag}
                                <span class="benchmark-card-saving">Ganho total: <strong>+$${opt.potentialEconomy.toLocaleString('pt-BR')}</strong></span>
                            </div>
                        </div>
                    </div>
                `;
            });
            
            let processesRowsHtml = "";
            let subtableHeaderHtml = "";
            let sectionTitleHtml = "";
            
            if (analysisSource === 'commercial') {
                sectionTitleHtml = `Ofertas Detalhadas (${group.processes.length})`;
                subtableHeaderHtml = `<tr>
                    <th class="col-processo" onclick="sortSubtable(this, 0, false, false)" style="cursor:pointer;">Oferta <span class="sort-arrow">↕</span></th>
                    <th class="col-cliente" onclick="sortSubtable(this, 1, false, false)" style="cursor:pointer;">Cliente <span class="sort-arrow">↕</span></th>
                    <th class="col-abertura" onclick="sortSubtable(this, 2, false, true)" style="cursor:pointer;">Abertura <span class="sort-arrow">↕</span></th>
                    <th class="col-status" onclick="sortSubtable(this, 3, false, false)" style="cursor:pointer;">Status <span class="sort-arrow">↕</span></th>
                    <th class="col-qtd text-center" onclick="sortSubtable(this, 4, true, false)" style="cursor:pointer; width:50px;">Qtd <span class="sort-arrow">↕</span></th>
                    <th class="col-armador" onclick="sortSubtable(this, 5, false, false)" style="cursor:pointer;">Agente <span class="sort-arrow">↕</span></th>
                    <th class="col-valor text-right" onclick="sortSubtable(this, 6, true, false)" style="cursor:pointer;">Compra (Un.) <span class="sort-arrow">↕</span></th>
                    <th class="col-valor text-right" onclick="sortSubtable(this, 7, true, false)" style="cursor:pointer;">Venda (Un.) <span class="sort-arrow">↕</span></th>
                    <th class="col-diferenca text-right" onclick="sortSubtable(this, 8, true, false)" style="cursor:pointer;">Diferença Compra <span class="sort-arrow">↕</span></th>
                </tr>`;
                
                group.processes.forEach((proc, pIdx) => {
                    const compValFormatted = fmtCurrency(proc.valorUnitario);
                    const vendValFormatted = fmtCurrency(proc.valorVenda || 0);
                    const difference = Math.max(0, proc.valorUnitario - group.bestOption.valor);
                    const copyBtnId = `copy-btn-${gIdx}-${pIdx}`;
                    
                    processesRowsHtml += `
                        <tr class="process-row" data-val="${proc.valorUnitario}" data-qty="${proc.qty}" data-route="${group.origem} ➔ ${group.destino}" data-container="${group.container}" data-default-saving="${difference * proc.qty}" data-freetime="${proc.freetime || 0}" data-armador="${(proc.armador || '').toLowerCase()}" data-obs="${(proc.observacao || '').toLowerCase()}" onclick="window.filterRatesByRow(this)" style="cursor:pointer;">
                            <td class="col-processo">
                                <div class="process-cell-inline">
                                    <strong>${proc.processo}</strong>
                                    <button class="copy-btn" id="${copyBtnId}" title="Copiar Oferta" onclick="event.stopPropagation(); copyToClipboard('${proc.processo}', '${copyBtnId}')">
                                        <i data-lucide="copy" style="width:12px; height:12px;"></i>
                                    </button>
                                </div>
                            </td>
                            <td class="col-cliente" title="${proc.cliente}"><span class="truncate-cell">${proc.cliente}</span></td>
                            <td class="col-abertura">${formatDateBR(proc.inicio)}</td>
                            <td class="col-status"><span class="badge" style="background-color: var(--bg-secondary); color: var(--text-primary); font-size: 0.7rem;">${proc.analise}</span></td>
                            <td class="col-qtd text-center"><span class="badge badge-secondary" style="font-weight: 600; font-size: 0.75rem; padding: 2px 6px;">${proc.qty}</span></td>
                            <td class="col-armador" title="${proc.agente}"><span class="truncate-cell">${proc.agente}</span></td>
                            <td class="col-valor text-right">${compValFormatted}</td>
                            <td class="col-valor text-right">${vendValFormatted}</td>
                            <td class="col-diferenca text-right cell-difference">${difference > 0 ? `<span class="cell-economy-positive">+$${(difference * proc.qty).toLocaleString('pt-BR')}</span>` : `<span style="color:var(--text-muted); font-size:0.8rem;">$0</span>`}</td>
                        </tr>
                    `;
                });
            } else {
                sectionTitleHtml = `Processos Detalhados (${group.processes.length})`;
                subtableHeaderHtml = `<tr>
                    <th class="col-processo" onclick="sortSubtable(this, 0, false, false)" style="cursor:pointer;">Processo <span class="sort-arrow">↕</span></th>
                    <th class="col-cliente" onclick="sortSubtable(this, 1, false, false)" style="cursor:pointer;">Cliente <span class="sort-arrow">↕</span></th>
                    <th class="col-abertura" onclick="sortSubtable(this, 2, false, true)" style="cursor:pointer;">Abertura <span class="sort-arrow">↕</span></th>
                    <th class="col-ft" onclick="sortSubtable(this, 3, true, false)" style="cursor:pointer;">FT <span class="sort-arrow">↕</span></th>
                    <th class="col-prontidao" onclick="sortSubtable(this, 4, false, true)" style="cursor:pointer;">Prontidão <span class="sort-arrow">↕</span></th>
                    <th class="col-etd" onclick="sortSubtable(this, 5, false, true)" style="cursor:pointer;">ETD <span class="sort-arrow">↕</span></th>
                    <th class="col-validade" onclick="sortSubtable(this, 6, false, true)" style="cursor:pointer;">Validade <span class="sort-arrow">↕</span></th>
                    <th class="col-eta" onclick="sortSubtable(this, 7, false, true)" style="cursor:pointer;">ETA <span class="sort-arrow">↕</span></th>
                    <th class="col-status" onclick="sortSubtable(this, 8, false, false)" style="cursor:pointer;">Status <span class="sort-arrow">↕</span></th>
                    <th class="col-qtd text-center" onclick="sortSubtable(this, 9, true, false)" style="cursor:pointer; width:70px;">Qtd <span class="sort-arrow">↕</span></th>
                    <th class="col-armador" onclick="sortSubtable(this, 10, false, false)" style="cursor:pointer;">Armador Atual <span class="sort-arrow">↕</span></th>
                    <th class="col-valor text-right" onclick="sortSubtable(this, 11, true, false)" style="cursor:pointer;">Valor (Un.) <span class="sort-arrow">↕</span></th>
                    <th class="col-diferenca text-right" onclick="sortSubtable(this, 12, true, false)" style="cursor:pointer;">Diferença <span class="sort-arrow">↕</span></th>
                </tr>`;
                
                group.processes.forEach((proc, pIdx) => {
                    const procValFormatted = fmtCurrency(proc.valorUnitario);
                    const difference = Math.max(0, proc.valorUnitario - group.bestOption.valor);
                    const prontidaoLabel = proc.prontidao ? formatDateBR(proc.prontidao) : '-';
                    const etdLabel = proc.previsaoEmbarque ? formatDateBR(proc.previsaoEmbarque) : '-';
                    const validadeLabel = proc.fim ? formatDateBR(proc.fim) : '-';
                    const etaLabel = proc.previsaoAtracacao ? formatDateBR(proc.previsaoAtracacao) : '-';
                    const phase = getProcessPhase(proc);
                    const phaseInfo = getPhaseDisplay(phase);
                    const statusBadgeHtml = `<span class="badge" style="background: ${phaseInfo.bg}; color: ${phaseInfo.color}; font-weight: 600; font-size: 0.7rem; padding: 3px 8px; border-radius: 6px; white-space: nowrap;">${phaseInfo.label}</span>`;
                    const copyBtnId = `copy-btn-${gIdx}-${pIdx}`;
                    
                    processesRowsHtml += `
                        <tr class="process-row" data-val="${proc.valorUnitario}" data-qty="${proc.qty}" data-route="${group.origem} ➔ ${group.destino}" data-container="${group.container}" data-default-saving="${difference * proc.qty}" data-freetime="${proc.freetime || 0}" data-armador="${(proc.armador || '').toLowerCase()}" data-obs="${(proc.observacao || '').toLowerCase()}" onclick="window.filterRatesByRow(this)" style="cursor:pointer;">
                            <td class="col-processo">
                                <div class="process-cell-inline">
                                    <strong>${proc.processo}</strong>
                                    <button class="copy-btn" id="${copyBtnId}" title="Copiar Processo" onclick="event.stopPropagation(); copyToClipboard('${proc.processo}', '${copyBtnId}')">
                                        <i data-lucide="copy" style="width:12px; height:12px;"></i>
                                    </button>
                                </div>
                            </td>
                            <td class="col-cliente" title="${proc.cliente}"><span class="truncate-cell">${proc.cliente}</span></td>
                            <td class="col-abertura">${formatDateBR(proc.inicio)}</td>
                            <td class="col-ft">${proc.freetime || 0}d</td>
                            <td class="col-prontidao">${prontidaoLabel}</td>
                            <td class="col-etd">${etdLabel}</td>
                            <td class="col-validade">${validadeLabel}</td>
                            <td class="col-eta">${etaLabel}</td>
                            <td class="col-status">${statusBadgeHtml}</td>
                            <td class="col-qtd text-center"><span class="badge badge-secondary" style="font-weight: 600; font-size: 0.75rem; padding: 2px 6px;">${proc.qty}</span></td>
                            <td class="col-armador" title="${proc.armador}"><span class="truncate-cell">${proc.armador}</span></td>
                            <td class="col-valor text-right">${procValFormatted}</td>
                            <td class="col-diferenca text-right cell-difference">${difference > 0 ? `<span class="cell-economy-positive">+$${(difference * proc.qty).toLocaleString('pt-BR')}</span>` : `<span style="color:var(--text-muted); font-size:0.8rem;">$0</span>`}</td>
                        </tr>
                    `;
                });
            }
            
            accordion.innerHTML = `
                <div class="route-accordion-header" id="opp-header-${gIdx}">
                    <div class="route-accordion-title-area">
                        <i data-lucide="chevron-down" class="route-accordion-arrow"></i>
                        <div class="route-info-left">
                            <span class="route-direction-text">${group.origem} ➔ ${group.destino}</span>
                            <span class="route-subtitle-text">${subtitle}</span>
                        </div>
                    </div>
                    <div class="route-info-right">
                        <span class="route-economy-val">${maxSavingFormatted}</span>
                        <span class="route-options-count">${group.savingRates.length} opção(ões)</span>
                    </div>
                </div>
                <div class="route-accordion-body hidden" id="opp-body-${gIdx}">
                    <div class="recompra-split-container">
                        <div class="recompra-left-pane">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                                <h4 class="accordion-section-title" style="margin-bottom:0; margin-top:0;">Opções de Tarifa</h4>
                                <input type="text" class="subtable-filter-input" placeholder="Filtrar tarifas..." onkeyup="filterSubtable(this)" style="padding: 4px 8px; font-size: 0.72rem; border: 1px solid var(--card-border); border-radius: 4px; background: var(--bg-primary); color: var(--text-primary); width: 120px;">
                            </div>
                            ${buildSubtableObsDropdownHtml(group.savingRates, gIdx)}
                            <div class="benchmark-filter-sort-bar" style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 8px;">
                                <select class="subtable-control-select select-sort" onchange="filterAndSortCards(this, ${gIdx})" style="width: 100%; padding: 4px 8px; font-size: 0.72rem; font-weight: 500; border: 1px solid var(--card-border); border-radius: 6px; background: var(--bg-primary); color: var(--text-primary); cursor: pointer; height: 28px;">
                                    <option value="cheapest">Ordenar: Preço ↓</option>
                                    <option value="freetime">Ordenar: FT ↑</option>
                                    <option value="validity">Ordenar: Validade ↑</option>
                                </select>
                                <select class="subtable-control-select select-ft" onchange="filterAndSortCards(this, ${gIdx})" style="width: 100%; padding: 4px 8px; font-size: 0.72rem; font-weight: 500; border: 1px solid var(--card-border); border-radius: 6px; background: var(--bg-primary); color: var(--text-primary); cursor: pointer; height: 28px;">
                                    <option value="all">Todos Free Time</option>
                                    <option value="14">FT >= 14 dias</option>
                                    <option value="21">FT >= 21 dias</option>
                                </select>
                                <select class="subtable-control-select select-source" onchange="filterAndSortCards(this, ${gIdx})" style="width: 100%; padding: 4px 8px; font-size: 0.72rem; font-weight: 500; border: 1px solid var(--card-border); border-radius: 6px; background: var(--bg-primary); color: var(--text-primary); cursor: pointer; height: 28px;">
                                    <option value="all">Fontes de Tarifa</option>
                                    <option value="space">Space on Hand</option>
                                    <option value="rate">Tarifário Comercial</option>
                                </select>
                            </div>
                            <div class="benchmark-cards-list">
                                ${optionsCardsHtml}
                            </div>
                        </div>
                        <div class="recompra-right-pane">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; gap:8px;">
                                <h4 class="accordion-section-title" style="margin-bottom:0; margin-top:0;">${sectionTitleHtml}</h4>
                                <div style="display:flex; align-items:center; gap:6px;">
                                    <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); exportSingleRouteData(${gIdx})" style="padding: 4px 8px; font-size: 0.72rem; display:flex; align-items:center; gap:4px; margin-bottom:0;">
                                        <i data-lucide="download" style="width:12px; height:12px;"></i>
                                        <span>Exportar Rota</span>
                                    </button>
                                    <input type="text" class="subtable-filter-input" placeholder="Filtrar processos..." onkeyup="filterSubtable(this)" style="padding: 4px 8px; font-size: 0.72rem; border: 1px solid var(--card-border); border-radius: 4px; background: var(--bg-primary); color: var(--text-primary); width: 140px; margin-bottom:0;">
                                </div>
                            </div>
                            <div class="analysis-table-container">
                                <table class="analysis-subtable">
                                    <thead>${subtableHeaderHtml}</thead>
                                    <tbody>${processesRowsHtml}</tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            
            container.appendChild(accordion);
            document.getElementById(`opp-header-${gIdx}`).addEventListener('click', () => {
                document.getElementById(`opp-body-${gIdx}`).classList.toggle('hidden');
                accordion.classList.toggle('expanded');
            });
        });
        
    } else if (analysisGroupBy === 'agente') {
        // ===== GROUP BY AGENTE (Split Layout) =====
        groupedData.forEach((agGroup, gIdx) => {
            window.selectedBenchmarks[gIdx] = 0;
            const accordion = document.createElement('div');
            accordion.className = "route-accordion";
            accordion.id = `opp-accordion-${gIdx}`;
            
            const savingFormatted = fmtCurrency(agGroup.totalSaving);
                        const subtitle = `${agGroup.processCount} ${analysisSource === 'commercial' ? 'oferta(s)' : 'processo(s)'} Â· Melhor opÃ§Ã£o com este Agente`;
            
            let optionsCardsHtml = "";
            let lastRouteKey = "";
            agGroup.savingRates.forEach((opt, oIdx) => {
                const optValFormatted = fmtCurrency(opt.valor);
                const validity = opt.fim ? opt.fim.split('-').reverse().join('/') : (opt.source === 'space' ? 'ETD Spot' : 'N/A');
                const ftStr = opt.freetime ? `${opt.freetime} dias` : '-';
                const cardClasses = [
                    'benchmark-card',
                    oIdx === 0 ? 'selected' : ''
                ].filter(Boolean).join(' ');
                
                const routeKey = `${opt.rota} - ${opt.container}`;
                let subgroupHeaderHtml = "";
                if (routeKey !== lastRouteKey) {
                    lastRouteKey = routeKey;
                    subgroupHeaderHtml = `<div class="subgroup-route-header" style="font-weight:600; font-size:0.75rem; color:var(--primary); margin:12px 0 6px 0; padding-bottom:3px; border-bottom:1px dashed var(--card-border);">${opt.rota} (${opt.container})</div>`;
                }
                
                const sourceTag = opt.source === 'space'
                    ? `<span class="source-tag source-space">SPACE</span> <span class="badge badge-info" style="padding: 1px 4px; font-size: 0.6rem; line-height: 1.2;">${opt.qtdSpace || 1} un</span>`
                    : `<span class="source-tag source-rate">TARIFA</span>`;
                
                const obsHtml = !isObservationNa(opt.observacao)
                    ? `<div class="benchmark-card-obs" title="${(opt.observacao || '').replace(/"/g, '&quot;')}">${opt.observacao}</div>`
                    : '';
                
                const validityMs = opt.fim ? new Date(opt.fim).getTime() : (opt.source === 'space' ? Date.now() + 10*24*60*60*1000 : 0);
                
                optionsCardsHtml += subgroupHeaderHtml + `
                    <div class="${cardClasses}" data-index="${oIdx}" data-valor="${opt.valor}" data-freetime="${opt.freetime || 0}" data-source="${opt.source}" data-validity-ms="${validityMs}" data-armador="${(opt.armador || '').toLowerCase()}" data-agente="${(opt.agente || '').toLowerCase()}" data-obs="${(opt.observacao || '').toLowerCase()}" data-saving="${opt.potentialEconomy}" data-route="${opt.rota}" data-container="${opt.container}" onclick="selectBenchmark(${gIdx}, ${oIdx})">
                        <div class="benchmark-card-header">
                            <div class="benchmark-card-selection">
                                <input type="radio" name="benchmark-radio-${gIdx}" ${oIdx === 0 ? 'checked' : ''} onclick="event.stopPropagation(); selectBenchmark(${gIdx}, ${oIdx})">
                                <div class="benchmark-card-carrier">
                                    <strong>${opt.armador}</strong>
                                    <span class="benchmark-card-agent">${opt.rota} · ${opt.container}</span>
                                </div>
                            </div>
                            <div class="benchmark-card-price">${optValFormatted}</div>
                        </div>
                        <div class="benchmark-card-body">
                            <div class="benchmark-card-meta">
                                <span>Validade/ETD: <strong>${validity}</strong></span>
                                <span>FT: <strong>${ftStr}</strong></span>
                            </div>
                            ${obsHtml}
                            <div class="benchmark-card-footer">
                                ${sourceTag}
                                <span class="benchmark-card-saving">Ganho total: <strong>+${opt.potentialEconomy.toLocaleString('pt-BR')}</strong></span>
                            </div>
                        </div>
                    </div>
                `;
            });
            
            let lastRowRouteKey = "";
            if (analysisSource === 'commercial') {
                sectionTitleHtml = `Ofertas Detalhadas (${agGroup.processes.length})`;
                subtableHeaderHtml = `<tr>
                    <th class="col-processo" onclick="sortSubtable(this, 0, false, false)" style="cursor:pointer;">Oferta <span class="sort-arrow">↕</span></th>
                    <th class="col-cliente" onclick="sortSubtable(this, 1, false, false)" style="cursor:pointer;">Cliente <span class="sort-arrow">↕</span></th>
                    <th class="col-rota" onclick="sortSubtable(this, 2, false, false)" style="cursor:pointer;">Rota <span class="sort-arrow">↕</span></th>
                    <th class="col-abertura" onclick="sortSubtable(this, 3, false, true)" style="cursor:pointer;">Abertura <span class="sort-arrow">↕</span></th>
                    <th class="col-status" onclick="sortSubtable(this, 4, false, false)" style="cursor:pointer;">Status <span class="sort-arrow">↕</span></th>
                    <th class="col-qtd text-center" onclick="sortSubtable(this, 5, true, false)" style="cursor:pointer; width:70px;">Qtd <span class="sort-arrow">↕</span></th>
                    <th class="col-container text-center" onclick="sortSubtable(this, 6, false, false)" style="cursor:pointer;">Container <span class="sort-arrow">↕</span></th>
                    <th class="col-armador" onclick="sortSubtable(this, 7, false, false)" style="cursor:pointer;">Agente Atual <span class="sort-arrow">↕</span></th>
                    <th class="col-valor text-right" onclick="sortSubtable(this, 8, true, false)" style="cursor:pointer;">Compra (Un.) <span class="sort-arrow">↕</span></th>
                    <th class="col-valor text-right" onclick="sortSubtable(this, 9, true, false)" style="cursor:pointer;">Venda (Un.) <span class="sort-arrow">↕</span></th>
                    <th class="col-diferenca text-right" onclick="sortSubtable(this, 10, true, false)" style="cursor:pointer;">Diferença Compra <span class="sort-arrow">↕</span></th>
                </tr>`;
                
                agGroup.processes.forEach((proc, pIdx) => {
                    const compValFormatted = fmtCurrency(proc.valorUnitario);
                    const vendValFormatted = fmtCurrency(proc.valorVenda || 0);
                    const copyBtnId = `copy-btn-${gIdx}-${pIdx}`;
                    const cInfo = getContainerInfo(proc);
                    const containerAbbr = getContainerAbbr(cInfo.type);
                    
                    const rowRouteKey = `${proc.rota} - ${containerAbbr}`;
                    let separatorRowHtml = "";
                    if (rowRouteKey !== lastRowRouteKey) {
                        lastRowRouteKey = rowRouteKey;
                        separatorRowHtml = `<tr class="subgroup-table-separator"><td colspan="15" style="background:var(--bg-secondary); font-weight:600; font-size:0.75rem; color:var(--primary); padding:6px 10px; border-top: 1px solid var(--card-border);">${proc.rota} (${containerAbbr})</td></tr>`;
                    }
                    
                    processesRowsHtml += separatorRowHtml + `
                        <tr class="process-row" data-val="${proc.valorUnitario}" data-qty="${proc.qty}" data-route="${proc.rota}" data-container="${cInfo.type}" data-default-saving="${proc.saving}" data-freetime="${proc.freetime || 0}" data-armador="${(proc.armador || '').toLowerCase()}" data-obs="${(proc.observacao || '').toLowerCase()}" onclick="window.filterRatesByRow(this)" style="cursor:pointer;">
                            <td class="col-processo">
                                <div class="process-cell-inline">
                                    <strong>${proc.processo}</strong>
                                    <button class="copy-btn" id="${copyBtnId}" title="Copiar Oferta" onclick="event.stopPropagation(); copyToClipboard('${proc.processo}', '${copyBtnId}')">
                                        <i data-lucide="copy" style="width:12px; height:12px;"></i>
                                    </button>
                                </div>
                            </td>
                            <td class="col-cliente" title="${proc.cliente}"><span class="truncate-cell">${proc.cliente}</span></td>
                            <td class="col-rota" title="${proc.rota}"><span class="truncate-cell">${proc.rota}</span></td>
                            <td class="col-abertura">${formatDateBR(proc.inicio)}</td>
                            <td class="col-status"><span class="badge" style="background-color: var(--bg-secondary); color: var(--text-primary); font-size: 0.7rem;">${proc.analise}</span></td>
                            <td class="col-qtd text-center"><span class="badge badge-secondary" style="font-weight: 600; font-size: 0.75rem; padding: 2px 6px;">${cInfo.qty}</span></td>
                            <td class="col-container text-center"><span class="badge badge-info">${containerAbbr}</span></td>
                            <td class="col-armador" title="${proc.agente}"><span class="truncate-cell">${proc.agente}</span></td>
                            <td class="col-valor text-right">${compValFormatted}</td>
                            <td class="col-valor text-right">${vendValFormatted}</td>
                            <td class="col-diferenca text-right cell-difference">${proc.saving > 0 ? `<span class="cell-economy-positive">+$${proc.saving.toLocaleString('pt-BR')}</span>` : `<span style="color:var(--text-muted); font-size:0.8rem;">$0</span>`}</td>
                        </tr>
                    `;
                });
            } else {
                sectionTitleHtml = `Processos Detalhados (${agGroup.processes.length})`;
                subtableHeaderHtml = `<tr>
                    <th class="col-processo" onclick="sortSubtable(this, 0, false, false)" style="cursor:pointer;">Processo <span class="sort-arrow">↕</span></th>
                    <th class="col-cliente" onclick="sortSubtable(this, 1, false, false)" style="cursor:pointer;">Cliente <span class="sort-arrow">↕</span></th>
                    <th class="col-rota" onclick="sortSubtable(this, 2, false, false)" style="cursor:pointer;">Rota <span class="sort-arrow">↕</span></th>
                    <th class="col-abertura" onclick="sortSubtable(this, 3, false, true)" style="cursor:pointer;">Abertura <span class="sort-arrow">↕</span></th>
                    <th class="col-ft" onclick="sortSubtable(this, 4, true, false)" style="cursor:pointer;">FT <span class="sort-arrow">↕</span></th>
                    <th class="col-prontidao" onclick="sortSubtable(this, 5, false, true)" style="cursor:pointer;">Prontidão <span class="sort-arrow">↕</span></th>
                    <th class="col-etd" onclick="sortSubtable(this, 6, false, true)" style="cursor:pointer;">ETD <span class="sort-arrow">↕</span></th>
                    <th class="col-validade" onclick="sortSubtable(this, 7, false, true)" style="cursor:pointer;">Validade <span class="sort-arrow">↕</span></th>
                    <th class="col-eta" onclick="sortSubtable(this, 8, false, true)" style="cursor:pointer;">ETA <span class="sort-arrow">↕</span></th>
                    <th class="col-status" onclick="sortSubtable(this, 9, false, false)" style="cursor:pointer;">Status <span class="sort-arrow">↕</span></th>
                    <th class="col-qtd text-center" onclick="sortSubtable(this, 10, true, false)" style="cursor:pointer; width:70px;">Qtd <span class="sort-arrow">↕</span></th>
                    <th class="col-container text-center" onclick="sortSubtable(this, 11, false, false)" style="cursor:pointer;">Container <span class="sort-arrow">↕</span></th>
                    <th class="col-armador" onclick="sortSubtable(this, 12, false, false)" style="cursor:pointer;">Armador Atual <span class="sort-arrow">↕</span></th>
                    <th class="col-valor text-right" onclick="sortSubtable(this, 13, true, false)" style="cursor:pointer;">Valor (Un.) <span class="sort-arrow">↕</span></th>
                    <th class="col-diferenca text-right" onclick="sortSubtable(this, 14, true, false)" style="cursor:pointer;">Diferença <span class="sort-arrow">↕</span></th>
                </tr>`;
                
                agGroup.processes.forEach((proc, pIdx) => {
                    const procValFormatted = fmtCurrency(proc.valorUnitario);
                    const prontidaoLabel = proc.prontidao ? formatDateBR(proc.prontidao) : '-';
                    const etdLabel = proc.previsaoEmbarque ? formatDateBR(proc.previsaoEmbarque) : '-';
                    const validadeLabel = proc.fim ? formatDateBR(proc.fim) : '-';
                    const etaLabel = proc.previsaoAtracacao ? formatDateBR(proc.previsaoAtracacao) : '-';
                    const phase = getProcessPhase(proc);
                    const phaseInfo = getPhaseDisplay(phase);
                    const statusBadgeHtml = `<span class="badge" style="background: ${phaseInfo.bg}; color: ${phaseInfo.color}; font-weight: 600; font-size: 0.7rem; padding: 3px 8px; border-radius: 6px; white-space: nowrap;">${phaseInfo.label}</span>`;
                    const copyBtnId = `copy-btn-${gIdx}-${pIdx}`;
                    const cInfo = getContainerInfo(proc);
                    const containerAbbr = getContainerAbbr(cInfo.type);
                    
                    const rowRouteKey = `${proc.rota} - ${containerAbbr}`;
                    let separatorRowHtml = "";
                    if (rowRouteKey !== lastRowRouteKey) {
                        lastRowRouteKey = rowRouteKey;
                        separatorRowHtml = `<tr class="subgroup-table-separator"><td colspan="15" style="background:var(--bg-secondary); font-weight:600; font-size:0.75rem; color:var(--primary); padding:6px 10px; border-top: 1px solid var(--card-border);">${proc.rota} (${containerAbbr})</td></tr>`;
                    }
                    
                    processesRowsHtml += separatorRowHtml + `
                        <tr class="process-row" data-val="${proc.valorUnitario}" data-qty="${proc.qty}" data-route="${proc.rota}" data-container="${cInfo.type}" data-default-saving="${proc.saving}" data-freetime="${proc.freetime || 0}" data-armador="${(proc.armador || '').toLowerCase()}" data-obs="${(proc.observacao || '').toLowerCase()}" onclick="window.filterRatesByRow(this)" style="cursor:pointer;">
                            <td class="col-processo">
                                <div class="process-cell-inline">
                                    <strong>${proc.processo}</strong>
                                    <button class="copy-btn" id="${copyBtnId}" title="Copiar Processo" onclick="event.stopPropagation(); copyToClipboard('${proc.processo}', '${copyBtnId}')">
                                        <i data-lucide="copy" style="width:12px; height:12px;"></i>
                                    </button>
                                </div>
                            </td>
                            <td class="col-cliente" title="${proc.cliente}"><span class="truncate-cell">${proc.cliente}</span></td>
                            <td class="col-rota" title="${proc.rota}"><span class="truncate-cell">${proc.rota}</span></td>
                            <td class="col-abertura">${formatDateBR(proc.inicio)}</td>
                            <td class="col-ft">${proc.freetime || 0}d</td>
                            <td class="col-prontidao">${prontidaoLabel}</td>
                            <td class="col-etd">${etdLabel}</td>
                            <td class="col-validade">${validadeLabel}</td>
                            <td class="col-eta">${etaLabel}</td>
                            <td class="col-status">${statusBadgeHtml}</td>
                            <td class="col-qtd text-center"><span class="badge badge-secondary" style="font-weight: 600; font-size: 0.75rem; padding: 2px 6px;">${cInfo.qty}</span></td>
                            <td class="col-container text-center"><span class="badge badge-info">${containerAbbr}</span></td>
                            <td class="col-armador" title="${proc.armador}"><span class="truncate-cell">${proc.armador}</span></td>
                            <td class="col-valor text-right">${procValFormatted}</td>
                            <td class="col-diferenca text-right cell-difference">${proc.saving > 0 ? `<span class="cell-economy-positive">+$${proc.saving.toLocaleString('pt-BR')}</span>` : `<span style="color:var(--text-muted); font-size:0.8rem;">$0</span>`}</td>
                        </tr>
                    `;
                });
            }
            
            accordion.innerHTML = `
                <div class="route-accordion-header" id="opp-header-${gIdx}">
                    <div class="route-accordion-title-area">
                        <i data-lucide="chevron-down" class="route-accordion-arrow"></i>
                        <div class="route-info-left">
                            <span class="route-direction-text"><i data-lucide="building-2" style="width:16px;height:16px;display:inline;vertical-align:middle;margin-right:4px;"></i> ${agGroup.label}</span>
                            <span class="route-subtitle-text">${subtitle}</span>
                        </div>
                    </div>
                    <div class="route-info-right">
                        <span class="route-economy-val">${savingFormatted}</span>
                        <span class="route-options-count">${agGroup.savingRates.length} opção(ões)</span>
                    </div>
                </div>
                <div class="route-accordion-body hidden" id="opp-body-${gIdx}">
                    <div class="recompra-split-container">
                        <div class="recompra-left-pane">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                                <h4 class="accordion-section-title" style="margin-bottom:0; margin-top:0;">Opções de Tarifa</h4>
                                <input type="text" class="subtable-filter-input" placeholder="Filtrar tarifas..." onkeyup="filterSubtable(this)" style="padding: 4px 8px; font-size: 0.72rem; border: 1px solid var(--card-border); border-radius: 4px; background: var(--bg-primary); color: var(--text-primary); width: 120px;">
                            </div>
                            ${buildSubtableObsDropdownHtml(agGroup.savingRates, gIdx)}
                            <div class="benchmark-filter-sort-bar" style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 8px;">
                                <select class="subtable-control-select select-sort" onchange="filterAndSortCards(this, ${gIdx})" style="width: 100%; padding: 4px 8px; font-size: 0.72rem; font-weight: 500; border: 1px solid var(--card-border); border-radius: 6px; background: var(--bg-primary); color: var(--text-primary); cursor: pointer; height: 28px;">
                                    <option value="cheapest">Ordenar: Preço ↓</option>
                                    <option value="freetime">Ordenar: FT ↑</option>
                                    <option value="validity">Ordenar: Validade ↑</option>
                                </select>
                                <select class="subtable-control-select select-ft" onchange="filterAndSortCards(this, ${gIdx})" style="width: 100%; padding: 4px 8px; font-size: 0.72rem; font-weight: 500; border: 1px solid var(--card-border); border-radius: 6px; background: var(--bg-primary); color: var(--text-primary); cursor: pointer; height: 28px;">
                                    <option value="all">Todos Free Time</option>
                                    <option value="14">FT >= 14 dias</option>
                                    <option value="21">FT >= 21 dias</option>
                                </select>
                                <select class="subtable-control-select select-source" onchange="filterAndSortCards(this, ${gIdx})" style="width: 100%; padding: 4px 8px; font-size: 0.72rem; font-weight: 500; border: 1px solid var(--card-border); border-radius: 6px; background: var(--bg-primary); color: var(--text-primary); cursor: pointer; height: 28px;">
                                    <option value="all">Fontes de Tarifa</option>
                                    <option value="space">Space on Hand</option>
                                    <option value="rate">Tarifário Comercial</option>
                                </select>
                            </div>
                            <div class="benchmark-cards-list">
                                ${optionsCardsHtml}
                            </div>
                        </div>
                        <div class="recompra-right-pane">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; gap:8px;">
                                <h4 class="accordion-section-title" style="margin-bottom:0; margin-top:0;">${sectionTitleHtml}</h4>
                                <div style="display:flex; align-items:center; gap:6px;">
                                    <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); exportSingleRouteData(${gIdx})" style="padding: 4px 8px; font-size: 0.72rem; display:flex; align-items:center; gap:4px; margin-bottom:0;">
                                        <i data-lucide="download" style="width:12px; height:12px;"></i>
                                        <span>Exportar Agente</span>
                                    </button>
                                    <input type="text" class="subtable-filter-input" placeholder="Filtrar processos..." onkeyup="filterSubtable(this)" style="padding: 4px 8px; font-size: 0.72rem; border: 1px solid var(--card-border); border-radius: 4px; background: var(--bg-primary); color: var(--text-primary); width: 170px; margin-bottom:0;">
                                </div>
                            </div>
                            <div class="analysis-table-container">
                                <table class="analysis-subtable">
                                    <thead>${subtableHeaderHtml}</thead>
                                    <tbody>${processesRowsHtml}</tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            
            container.appendChild(accordion);
            document.getElementById(`opp-header-${gIdx}`).addEventListener('click', () => {
                document.getElementById(`opp-body-${gIdx}`).classList.toggle('hidden');
                accordion.classList.toggle('expanded');
            });
        });
        
    } else if (analysisGroupBy === 'cliente') {
        // ===== GROUP BY CLIENTE (Split Layout) =====
        groupedData.forEach((clGroup, gIdx) => {
            window.selectedBenchmarks[gIdx] = 0;
            const accordion = document.createElement('div');
            accordion.className = "route-accordion";
            accordion.id = `opp-accordion-${gIdx}`;
            
            const savingFormatted = fmtCurrency(clGroup.totalSaving);
            const subtitle = `${clGroup.processCount} processo(s) · Melhor opção por Rota`;
            
            let optionsCardsHtml = "";
            let processesRowsHtml = "";
            let lastRouteKey = "";
            clGroup.savingRates.forEach((opt, oIdx) => {
                const optValFormatted = fmtCurrency(opt.valor);
                const validity = opt.fim ? opt.fim.split('-').reverse().join('/') : (opt.source === 'space' ? 'ETD Spot' : 'N/A');
                const ftStr = opt.freetime ? `${opt.freetime} dias` : '-';
                const cardClasses = [
                    'benchmark-card',
                    oIdx === 0 ? 'selected' : ''
                ].filter(Boolean).join(' ');
                
                const routeKey = `${opt.rota} - ${opt.container}`;
                let subgroupHeaderHtml = "";
                if (routeKey !== lastRouteKey) {
                    lastRouteKey = routeKey;
                    subgroupHeaderHtml = `<div class="subgroup-route-header" style="font-weight:600; font-size:0.75rem; color:var(--primary); margin:12px 0 6px 0; padding-bottom:3px; border-bottom:1px dashed var(--card-border);">${opt.rota} (${opt.container})</div>`;
                }
                
                const sourceTag = opt.source === 'space'
                    ? `<span class="source-tag source-space">SPACE</span> <span class="badge badge-info" style="padding: 1px 4px; font-size: 0.6rem; line-height: 1.2;">${opt.qtdSpace || 1} un</span>`
                    : `<span class="source-tag source-rate">TARIFA</span>`;
                
                const obsHtml = !isObservationNa(opt.observacao)
                    ? `<div class="benchmark-card-obs" title="${(opt.observacao || '').replace(/"/g, '&quot;')}">${opt.observacao}</div>`
                    : '';
                
                const validityMs = opt.fim ? new Date(opt.fim).getTime() : (opt.source === 'space' ? Date.now() + 10*24*60*60*1000 : 0);
                
                optionsCardsHtml += subgroupHeaderHtml + `
                    <div class="${cardClasses}" data-index="${oIdx}" data-valor="${opt.valor}" data-freetime="${opt.freetime || 0}" data-source="${opt.source}" data-validity-ms="${validityMs}" data-armador="${(opt.armador || '').toLowerCase()}" data-agente="${(opt.agente || '').toLowerCase()}" data-obs="${(opt.observacao || '').toLowerCase()}" data-saving="${opt.potentialEconomy}" data-route="${opt.rota}" data-container="${opt.container}" onclick="selectBenchmark(${gIdx}, ${oIdx})">
                        <div class="benchmark-card-header">
                            <div class="benchmark-card-selection">
                                <input type="radio" name="benchmark-radio-${gIdx}" ${oIdx === 0 ? 'checked' : ''} onclick="event.stopPropagation(); selectBenchmark(${gIdx}, ${oIdx})">
                                <div class="benchmark-card-carrier">
                                    <strong>${opt.armador}</strong>
                                    <span class="benchmark-card-agent">${opt.rota} · ${opt.container}</span>
                                    <span class="benchmark-card-agent" style="font-size:0.60rem; color:var(--text-muted);">${opt.agente}</span>
                                </div>
                            </div>
                            <div class="benchmark-card-price">${optValFormatted}</div>
                        </div>
                        <div class="benchmark-card-body">
                            <div class="benchmark-card-meta">
                                <span>Validade/ETD: <strong>${validity}</strong></span>
                                <span>FT: <strong>${ftStr}</strong></span>
                            </div>
                            ${obsHtml}
                            <div class="benchmark-card-footer">
                                ${sourceTag}
                                <span class="benchmark-card-saving">Ganho total: <strong>+$${opt.potentialEconomy.toLocaleString('pt-BR')}</strong></span>
                            </div>
                        </div>
                    </div>
                `;
            });
            
            let toggleBtnHtml = "";
            
            let lastRowRouteKey = "";
            if (analysisSource === 'commercial') {
                sectionTitleHtml = `Ofertas Detalhadas (${clGroup.processes.length})`;
                subtableHeaderHtml = `<tr>
                    <th class="col-processo" onclick="sortSubtable(this, 0, false, false)" style="cursor:pointer;">Oferta <span class="sort-arrow">↕</span></th>
                    <th class="col-rota" onclick="sortSubtable(this, 1, false, false)" style="cursor:pointer;">Rota <span class="sort-arrow">↕</span></th>
                    <th class="col-abertura" onclick="sortSubtable(this, 2, false, true)" style="cursor:pointer;">Abertura <span class="sort-arrow">↕</span></th>
                    <th class="col-status" onclick="sortSubtable(this, 3, false, false)" style="cursor:pointer;">Status <span class="sort-arrow">↕</span></th>
                    <th class="col-qtd text-center" onclick="sortSubtable(this, 4, true, false)" style="cursor:pointer; width:70px;">Qtd <span class="sort-arrow">↕</span></th>
                    <th class="col-container text-center" onclick="sortSubtable(this, 5, false, false)" style="cursor:pointer;">Container <span class="sort-arrow">↕</span></th>
                    <th class="col-armador" onclick="sortSubtable(this, 6, false, false)" style="cursor:pointer;">Agente <span class="sort-arrow">↕</span></th>
                    <th class="col-valor text-right" onclick="sortSubtable(this, 7, true, false)" style="cursor:pointer;">Compra (Un.) <span class="sort-arrow">↕</span></th>
                    <th class="col-valor text-right" onclick="sortSubtable(this, 8, true, false)" style="cursor:pointer;">Venda (Un.) <span class="sort-arrow">↕</span></th>
                    <th class="col-diferenca text-right" onclick="sortSubtable(this, 9, true, false)" style="cursor:pointer;">Diferença Compra <span class="sort-arrow">↕</span></th>
                </tr>`;
                
                clGroup.processes.forEach((proc, pIdx) => {
                    const compValFormatted = fmtCurrency(proc.valorUnitario);
                    const vendValFormatted = fmtCurrency(proc.valorVenda || 0);
                    const copyBtnId = `copy-btn-${gIdx}-${pIdx}`;
                    const cInfo = getContainerInfo(proc);
                    const containerAbbr = getContainerAbbr(cInfo.type);
                    
                    const rowRouteKey = `${proc.rota} - ${containerAbbr}`;
                    let separatorRowHtml = "";
                    if (rowRouteKey !== lastRowRouteKey) {
                        lastRowRouteKey = rowRouteKey;
                        separatorRowHtml = `<tr class="subgroup-table-separator"><td colspan="15" style="background:var(--bg-secondary); font-weight:600; font-size:0.75rem; color:var(--primary); padding:6px 10px; border-top: 1px solid var(--card-border);">${proc.rota} (${containerAbbr})</td></tr>`;
                    }
                    
                    processesRowsHtml += separatorRowHtml + `
                        <tr class="process-row" data-val="${proc.valorUnitario}" data-qty="${proc.qty}" data-route="${proc.rota}" data-container="${cInfo.type}" data-default-saving="${proc.saving}" data-freetime="${proc.freetime || 0}" data-armador="${(proc.armador || '').toLowerCase()}" data-obs="${(proc.observacao || '').toLowerCase()}" onclick="window.filterRatesByRow(this)" style="cursor:pointer;">
                            <td class="col-processo">
                                <div class="process-cell-inline">
                                    <strong>${proc.processo}</strong>
                                    <button class="copy-btn" id="${copyBtnId}" title="Copiar Oferta" onclick="event.stopPropagation(); copyToClipboard('${proc.processo}', '${copyBtnId}')">
                                        <i data-lucide="copy" style="width:12px; height:12px;"></i>
                                    </button>
                                </div>
                            </td>
                            <td class="col-rota" title="${proc.rota}"><span class="truncate-cell">${proc.rota}</span></td>
                            <td class="col-abertura">${formatDateBR(proc.inicio)}</td>
                            <td class="col-status"><span class="badge" style="background-color: var(--bg-secondary); color: var(--text-primary); font-size: 0.7rem;">${proc.analise}</span></td>
                            <td class="col-qtd text-center"><span class="badge badge-secondary" style="font-weight: 600; font-size: 0.75rem; padding: 2px 6px;">${cInfo.qty}</span></td>
                            <td class="col-container text-center"><span class="badge badge-info">${containerAbbr}</span></td>
                            <td class="col-armador" title="${proc.agente}"><span class="truncate-cell">${proc.agente}</span></td>
                            <td class="col-valor text-right">${compValFormatted}</td>
                            <td class="col-valor text-right">${vendValFormatted}</td>
                            <td class="col-diferenca text-right cell-difference">${proc.saving > 0 ? `<span class="cell-economy-positive">+$${proc.saving.toLocaleString('pt-BR')}</span>` : `<span style="color:var(--text-muted); font-size:0.8rem;">$0</span>`}</td>
                        </tr>
                    `;
                });
            } else {
                sectionTitleHtml = `Processos Detalhados (${clGroup.processes.length})`;
                subtableHeaderHtml = `<tr>
                    <th class="col-processo" onclick="sortSubtable(this, 0, false, false)" style="cursor:pointer;">Processo <span class="sort-arrow">↕</span></th>
                    <th class="col-rota" onclick="sortSubtable(this, 1, false, false)" style="cursor:pointer;">Rota <span class="sort-arrow">↕</span></th>
                    <th class="col-abertura" onclick="sortSubtable(this, 2, false, true)" style="cursor:pointer;">Abertura <span class="sort-arrow">↕</span></th>
                    <th class="col-ft" onclick="sortSubtable(this, 3, true, false)" style="cursor:pointer;">FT <span class="sort-arrow">↕</span></th>
                    <th class="col-prontidao" onclick="sortSubtable(this, 4, false, true)" style="cursor:pointer;">Prontidão <span class="sort-arrow">↕</span></th>
                    <th class="col-etd" onclick="sortSubtable(this, 5, false, true)" style="cursor:pointer;">ETD <span class="sort-arrow">↕</span></th>
                    <th class="col-validade" onclick="sortSubtable(this, 6, false, true)" style="cursor:pointer;">Validade <span class="sort-arrow">↕</span></th>
                    <th class="col-eta" onclick="sortSubtable(this, 7, false, true)" style="cursor:pointer;">ETA <span class="sort-arrow">↕</span></th>
                    <th class="col-status" onclick="sortSubtable(this, 8, false, false)" style="cursor:pointer;">Status <span class="sort-arrow">↕</span></th>
                    <th class="col-qtd text-center" onclick="sortSubtable(this, 9, true, false)" style="cursor:pointer; width:70px;">Qtd <span class="sort-arrow">↕</span></th>
                    <th class="col-container text-center" onclick="sortSubtable(this, 10, false, false)" style="cursor:pointer;">Container <span class="sort-arrow">↕</span></th>
                    <th class="col-armador" onclick="sortSubtable(this, 11, false, false)" style="cursor:pointer;">Armador Atual <span class="sort-arrow">↕</span></th>
                    <th class="col-valor text-right" onclick="sortSubtable(this, 12, true, false)" style="cursor:pointer;">Valor (Un.) <span class="sort-arrow">↕</span></th>
                    <th class="col-diferenca text-right" onclick="sortSubtable(this, 13, true, false)" style="cursor:pointer;">Diferença <span class="sort-arrow">↕</span></th>
                </tr>`;
                
                clGroup.processes.forEach((proc, pIdx) => {
                    const procValFormatted = fmtCurrency(proc.valorUnitario);
                    const prontidaoLabel = proc.prontidao ? formatDateBR(proc.prontidao) : '-';
                    const etdLabel = proc.previsaoEmbarque ? formatDateBR(proc.previsaoEmbarque) : '-';
                    const validadeLabel = proc.fim ? formatDateBR(proc.fim) : '-';
                    const etaLabel = proc.previsaoAtracacao ? formatDateBR(proc.previsaoAtracacao) : '-';
                    const phase = getProcessPhase(proc);
                    const phaseInfo = getPhaseDisplay(phase);
                    const statusBadgeHtml = `<span class="badge" style="background: ${phaseInfo.bg}; color: ${phaseInfo.color}; font-weight: 600; font-size: 0.7rem; padding: 3px 8px; border-radius: 6px; white-space: nowrap;">${phaseInfo.label}</span>`;
                    const copyBtnId = `copy-btn-${gIdx}-${pIdx}`;
                    const cInfo = getContainerInfo(proc);
                    const containerAbbr = getContainerAbbr(cInfo.type);
                    
                    const rowRouteKey = `${proc.rota} - ${containerAbbr}`;
                    let separatorRowHtml = "";
                    if (rowRouteKey !== lastRowRouteKey) {
                        lastRowRouteKey = rowRouteKey;
                        separatorRowHtml = `<tr class="subgroup-table-separator"><td colspan="15" style="background:var(--bg-secondary); font-weight:600; font-size:0.75rem; color:var(--primary); padding:6px 10px; border-top: 1px solid var(--card-border);">${proc.rota} (${containerAbbr})</td></tr>`;
                    }
                    
                    processesRowsHtml += separatorRowHtml + `
                        <tr class="process-row" data-val="${proc.valorUnitario}" data-qty="${proc.qty}" data-route="${proc.rota}" data-container="${cInfo.type}" data-default-saving="${proc.saving}" data-freetime="${proc.freetime || 0}" data-armador="${(proc.armador || '').toLowerCase()}" data-obs="${(proc.observacao || '').toLowerCase()}" onclick="window.filterRatesByRow(this)" style="cursor:pointer;">
                            <td class="col-processo">
                                <div class="process-cell-inline">
                                    <strong>${proc.processo}</strong>
                                    <button class="copy-btn" id="${copyBtnId}" title="Copiar Processo" onclick="event.stopPropagation(); copyToClipboard('${proc.processo}', '${copyBtnId}')">
                                        <i data-lucide="copy" style="width:12px; height:12px;"></i>
                                    </button>
                                </div>
                            </td>
                            <td class="col-rota" title="${proc.rota}"><span class="truncate-cell">${proc.rota}</span></td>
                            <td class="col-abertura">${formatDateBR(proc.inicio)}</td>
                            <td class="col-ft">${proc.freetime || 0}d</td>
                            <td class="col-prontidao">${prontidaoLabel}</td>
                            <td class="col-etd">${etdLabel}</td>
                            <td class="col-validade">${validadeLabel}</td>
                            <td class="col-eta">${etaLabel}</td>
                            <td class="col-status">${statusBadgeHtml}</td>
                            <td class="col-qtd text-center"><span class="badge badge-secondary" style="font-weight: 600; font-size: 0.75rem; padding: 2px 6px;">${cInfo.qty}</span></td>
                            <td class="col-container text-center"><span class="badge badge-info">${containerAbbr}</span></td>
                            <td class="col-armador" title="${proc.armador}"><span class="truncate-cell">${proc.armador}</span></td>
                            <td class="col-valor text-right">${procValFormatted}</td>
                            <td class="col-diferenca text-right cell-difference">${proc.saving > 0 ? `<span class="cell-economy-positive">+$${proc.saving.toLocaleString('pt-BR')}</span>` : `<span style="color:var(--text-muted); font-size:0.8rem;">$0</span>`}</td>
                        </tr>
                    `;
                });
            }
            
            accordion.innerHTML = `
                <div class="route-accordion-header" id="opp-header-${gIdx}">
                    <div class="route-accordion-title-area">
                        <i data-lucide="chevron-down" class="route-accordion-arrow"></i>
                        <div class="route-info-left">
                            <span class="route-direction-text"><i data-lucide="user" style="width:16px;height:16px;display:inline;vertical-align:middle;margin-right:4px;"></i> ${clGroup.label}</span>
                            <span class="route-subtitle-text">${subtitle}</span>
                        </div>
                    </div>
                    <div class="route-info-right">
                        <span class="route-economy-val">${savingFormatted}</span>
                        <span class="route-options-count">${clGroup.savingRates.length} opção(ões)</span>
                    </div>
                </div>
                <div class="route-accordion-body hidden" id="opp-body-${gIdx}">
                    <div class="recompra-split-container">
                        <div class="recompra-left-pane">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                                <h4 class="accordion-section-title" style="margin-bottom:0; margin-top:0;">Opções de Tarifa</h4>
                                <input type="text" class="subtable-filter-input" placeholder="Filtrar tarifas..." onkeyup="filterSubtable(this)" style="padding: 4px 8px; font-size: 0.72rem; border: 1px solid var(--card-border); border-radius: 4px; background: var(--bg-primary); color: var(--text-primary); width: 120px;">
                            </div>
                            ${buildSubtableObsDropdownHtml(clGroup.savingRates, gIdx)}
                            <div class="benchmark-filter-sort-bar" style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 8px;">
                                <select class="subtable-control-select select-sort" onchange="filterAndSortCards(this, ${gIdx})" style="width: 100%; padding: 4px 8px; font-size: 0.72rem; font-weight: 500; border: 1px solid var(--card-border); border-radius: 6px; background: var(--bg-primary); color: var(--text-primary); cursor: pointer; height: 28px;">
                                    <option value="cheapest">Ordenar: Preço ↓</option>
                                    <option value="freetime">Ordenar: FT ↑</option>
                                    <option value="validity">Ordenar: Validade ↑</option>
                                </select>
                                <select class="subtable-control-select select-ft" onchange="filterAndSortCards(this, ${gIdx})" style="width: 100%; padding: 4px 8px; font-size: 0.72rem; font-weight: 500; border: 1px solid var(--card-border); border-radius: 6px; background: var(--bg-primary); color: var(--text-primary); cursor: pointer; height: 28px;">
                                    <option value="all">Todos Free Time</option>
                                    <option value="14">FT >= 14 dias</option>
                                    <option value="21">FT >= 21 dias</option>
                                </select>
                                <select class="subtable-control-select select-source" onchange="filterAndSortCards(this, ${gIdx})" style="width: 100%; padding: 4px 8px; font-size: 0.72rem; font-weight: 500; border: 1px solid var(--card-border); border-radius: 6px; background: var(--bg-primary); color: var(--text-primary); cursor: pointer; height: 28px;">
                                    <option value="all">Fontes de Tarifa</option>
                                    <option value="space">Space on Hand</option>
                                    <option value="rate">Tarifário Comercial</option>
                                </select>
                            </div>
                            <div class="benchmark-cards-list">
                                ${optionsCardsHtml}
                            </div>
                        </div>
                        <div class="recompra-right-pane">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; gap:8px;">
                                <h4 class="accordion-section-title" style="margin-bottom:0; margin-top:0;">${sectionTitleHtml}</h4>
                                <div style="display:flex; align-items:center; gap:6px;">
                                    <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); exportSingleRouteData(${gIdx})" style="padding: 4px 8px; font-size: 0.72rem; display:flex; align-items:center; gap:4px; margin-bottom:0;">
                                        <i data-lucide="download" style="width:12px; height:12px;"></i>
                                        <span>Exportar Cliente</span>
                                    </button>
                                    <input type="text" class="subtable-filter-input" placeholder="Filtrar processos..." onkeyup="filterSubtable(this)" style="padding: 4px 8px; font-size: 0.72rem; border: 1px solid var(--card-border); border-radius: 4px; background: var(--bg-primary); color: var(--text-primary); width: 170px; margin-bottom:0;">
                                </div>
                            </div>
                            <div class="analysis-table-container">
                                <table class="analysis-subtable">
                                    <thead>${subtableHeaderHtml}</thead>
                                    <tbody>${processesRowsHtml}</tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            
            container.appendChild(accordion);
            document.getElementById(`opp-header-${gIdx}`).addEventListener('click', () => {
                document.getElementById(`opp-body-${gIdx}`).classList.toggle('hidden');
                accordion.classList.toggle('expanded');
            });
        });
    }
    
    lucide.createIcons();
};;

window.notificarOportunidade = function(origem, destino, container, economia) {
    alert(`Notificação enviada com sucesso para a rota ${origem} ➔ ${destino} (${container})! Economia potencial estimada de ${economia}.`);
};

window.renderAnalysisComplete = function() {
    const tbody = document.getElementById('analysis-complete-tbody');
    tbody.innerHTML = "";
    
    const processes = appOperational;
    const availableOptions = [...appRates, ...appSpace];
    
    let filteredProcs = processes;
    const searchVal = document.getElementById('analysis-complete-search').value.toLowerCase().trim();
    if (searchVal !== "") {
        filteredProcs = processes.filter(p => 
            p.processo.toLowerCase().includes(searchVal) ||
            p.cliente.toLowerCase().includes(searchVal) ||
            p.origem.toLowerCase().includes(searchVal) ||
            p.destino.toLowerCase().includes(searchVal)
        );
    }
    
    if (filteredProcs.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="10" class="text-center" style="color:var(--text-muted); padding:24px;">Nenhum processo pendente encontrado para os filtros aplicados.</td>
            </tr>
        `;
        return;
    }
    
    filteredProcs.forEach((proc, idx) => {
        const normOrig = normalizePortName(proc.origem);
        const normDest = normalizePortName(proc.destino);
        const normContainer = extractContainerType(proc.container);
        
        const matchingRates = availableOptions.filter(opt => 
            normalizePortName(opt.origem) === normOrig &&
            normalizePortName(opt.destino) === normDest &&
            extractContainerType(opt.container) === normContainer
        );
        
        let bestOpt = null;
        if (matchingRates.length > 0) {
            matchingRates.sort((a,b) => a.valor - b.valor);
            bestOpt = matchingRates[0];
        }
        
        const qty = getContainerQty(proc.container);
        const presentValFormatted = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(proc.valor * qty);
        
        let bestTarifaStr = `<span style="color:var(--text-muted);">Indisponível</span>`;
        let economyStr = `<span style="color:var(--text-muted);">-</span>`;
        let actionBtnHtml = `<span style="color:var(--text-muted);">-</span>`;
        
        if (bestOpt) {
            bestTarifaStr = `${bestOpt.armador} (${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(bestOpt.valor)})`;
            const diff = proc.valor - bestOpt.valor;
            if (diff > 0) {
                const totalSaving = diff * qty;
                economyStr = `<strong class="cell-economy-positive">+$$${totalSaving.toLocaleString('pt-BR')}</strong>`;
                actionBtnHtml = `
                    <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 0.75rem;" onclick="filterRouteInPainel('${proc.origem}', '${proc.destino}', '${normContainer}')">
                        Recomprar
                    </button>
                `;
            } else {
                economyStr = `<span style="color:var(--text-muted);">Melhor frete ativo</span>`;
            }
        }
        
        const copyBtnId = `copy-complete-btn-${idx}`;
        
        const row = document.createElement('tr');
        const cInfo = getContainerInfo(proc);
        row.innerHTML = `
            <td>
                <strong>${proc.processo}</strong>
                <button class="copy-btn" id="${copyBtnId}" title="Copiar Processo" onclick="event.stopPropagation(); copyToClipboard('${proc.processo}', '${copyBtnId}')">
                    <i data-lucide="copy" style="width:12px; height:12px;"></i>
                </button>
            </td>
            <td>${proc.cliente}</td>
            <td>${proc.origem}</td>
            <td>${proc.destino}</td>
            <td class="text-center"><span class="badge badge-secondary" style="font-weight: 600; font-size: 0.75rem; padding: 2px 6px;">${cInfo.qty}</span></td>
            <td><span class="badge badge-info">${cInfo.type}</span></td>
            <td>${proc.armador}</td>
            <td class="text-right">${presentValFormatted}</td>
            <td class="text-right">${bestTarifaStr}</td>
            <td class="text-right">${economyStr}</td>
            <td class="text-center">${actionBtnHtml}</td>
        `;
        tbody.appendChild(row);
    });
    
    lucide.createIcons();
};

window.renderAnalysisManual = function() {
    const select = document.getElementById('sim-process-select');
    const prevSelection = select.value;
    
    select.innerHTML = '<option value="">Selecione um processo...</option>';
    
    appOperational.forEach((proc, idx) => {
        const option = document.createElement('option');
        option.value = idx;
        option.innerText = `${proc.processo} - ${proc.cliente} (${proc.origem} ➔ ${proc.destino})`;
        select.appendChild(option);
    });
    
    if (prevSelection !== "" && parseInt(prevSelection) < appOperational.length) {
        select.value = prevSelection;
        onManualSimulatorProcessChange(prevSelection);
    } else {
        document.getElementById('sim-process-details').classList.add('hidden');
        document.getElementById('sim-rates-tbody').innerHTML = `
            <tr>
                <td colspan="7" class="text-center" style="color:var(--text-muted); padding:24px;">Selecione um processo operacional ao lado para iniciar a simulação.</td>
            </tr>
        `;
    }
};

window.onManualSimulatorProcessChange = function(indexVal) {
    const detailsCard = document.getElementById('sim-process-details');
    const tbody = document.getElementById('sim-rates-tbody');
    
    if (indexVal === "") {
        detailsCard.classList.add('hidden');
        tbody.innerHTML = `
            <tr>
                <td colspan="7" class="text-center" style="color:var(--text-muted); padding:24px;">Selecione um processo operacional ao lado para iniciar a simulação.</td>
            </tr>
        `;
        return;
    }
    
    const idx = parseInt(indexVal);
    const proc = appOperational[idx];
    if (!proc) return;
    
    const qty = getContainerQty(proc.container);
    const unitPrice = proc.valor;
    
    detailsCard.classList.remove('hidden');
    document.getElementById('sim-info-cliente').innerText = proc.cliente;
    document.getElementById('sim-info-rota').innerText = `${proc.origem} ➔ ${proc.destino}`;
    document.getElementById('sim-info-container').innerText = proc.container;
    document.getElementById('sim-info-qtd').innerText = qty;
    document.getElementById('sim-info-armador').innerText = proc.armador || 'N/A';
    document.getElementById('sim-info-valor').innerText = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(unitPrice);
    
    const normOrig = normalizePortName(proc.origem);
    const normDest = normalizePortName(proc.destino);
    const normContainer = extractContainerType(proc.container);
    
    const availableOptions = [...appRates, ...appSpace];
    const matchingRates = availableOptions.filter(opt => 
        normalizePortName(opt.origem) === normOrig &&
        normalizePortName(opt.destino) === normDest &&
        extractContainerType(opt.container) === normContainer
    );
    
    if (matchingRates.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="7" class="text-center" style="color:var(--text-muted); padding:24px;">Nenhuma tarifa ou space cadastrado para a rota ${proc.origem} ➔ ${proc.destino} (${normContainer}).</td>
            </tr>
        `;
        return;
    }
    
    matchingRates.sort((a,b) => a.valor - b.valor);
    
    tbody.innerHTML = "";
    
    matchingRates.forEach((opt, oIdx) => {
        const row = document.createElement('tr');
        
        const optValFormatted = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(opt.valor);
        const validity = opt.fim ? opt.fim.split('-').reverse().join('/') : (opt.source === 'space' ? 'ETD Spot' : 'N/A');
        const ftStr = opt.freetime ? `${opt.freetime} dias` : '-';
        
        const diffUnit = unitPrice - opt.valor;
        let diffUnitHtml = "";
        let diffTotalHtml = "";
        
        if (diffUnit > 0) {
            row.className = oIdx === 0 ? "row-cheapest" : "";
            diffUnitHtml = `<strong style="color:#10b981;">+$${diffUnit.toLocaleString('pt-BR')}</strong>`;
            diffTotalHtml = `<strong style="color:#10b981;">+$${(diffUnit * qty).toLocaleString('pt-BR')}</strong>`;
        } else if (diffUnit === 0) {
            diffUnitHtml = `<span style="color:var(--text-muted);">Mesmo valor</span>`;
            diffTotalHtml = `<span style="color:var(--text-muted);">-</span>`;
        } else {
            diffUnitHtml = `<span style="color:var(--danger);">-$${Math.abs(diffUnit).toLocaleString('pt-BR')}</span>`;
            diffTotalHtml = `<span style="color:var(--danger);">-$${Math.abs(diffUnit * qty).toLocaleString('pt-BR')}</span>`;
        }
        
        row.innerHTML = `
            <td><strong>${opt.source === 'space' ? 'Space on Hand' : 'Tarifário'}</strong></td>
            <td><strong>${opt.armador}</strong><br><span style="font-size:0.75rem; color:var(--text-muted);">${opt.agente}</span></td>
            <td class="text-right"><strong style="color:var(--primary-light);">${optValFormatted}</strong></td>
            <td class="text-center">${ftStr}</td>
            <td>${validity}</td>
            <td class="text-right">${diffUnitHtml}</td>
            <td class="text-right">${diffTotalHtml}</td>
        `;
        tbody.appendChild(row);
    });
};

window.sortSubtable = function(thElement, colIndex, isNumeric, isDate) {
    const table = thElement.closest('table');
    const tbody = table.querySelector('tbody');
    const rows = Array.from(tbody.querySelectorAll('tr'));
    const isAsc = !thElement.classList.contains('sort-asc');
    
    table.querySelectorAll('th').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
        const arrow = th.querySelector('.sort-arrow');
        if (arrow) arrow.innerHTML = '↕';
    });
    
    thElement.classList.add(isAsc ? 'sort-asc' : 'sort-desc');
    const arrow = thElement.querySelector('.sort-arrow');
    if (arrow) arrow.innerHTML = isAsc ? '▲' : '▼';
    
    rows.sort((rowA, rowB) => {
        const cellA = rowA.cells[colIndex];
        const cellB = rowB.cells[colIndex];
        if (!cellA || !cellB) return 0;
        
        const valA = cellA.innerText.trim();
        const valB = cellB.innerText.trim();
        
        if (isNumeric) {
            const parseNum = (str) => {
                let clean = str.replace(/[+$d\s]/g, '').replace(/%/g, '').trim();
                if (clean.includes(',') && clean.includes('.')) {
                    clean = clean.replace(/\./g, '').replace(',', '.');
                } else if (clean.includes(',')) {
                    const afterComma = clean.split(',')[1];
                    if (afterComma && afterComma.length === 3) {
                        clean = clean.replace(/,/g, '');
                    } else {
                        clean = clean.replace(',', '.');
                    }
                } else if (clean.includes('.')) {
                    const afterDot = clean.split('.')[1];
                    if (afterDot && afterDot.length === 3) {
                        clean = clean.replace(/\./g, '');
                    }
                }
                const p = parseFloat(clean);
                return isNaN(p) ? 0 : p;
            };
            return (parseNum(valA) - parseNum(valB)) * (isAsc ? 1 : -1);
        }
        
        if (isDate) {
            const parseDt = (str) => {
                if (!str || str.toLowerCase().includes('não') || str.toLowerCase().includes('n/a') || str === '-') return new Date(0);
                const parts = str.split('/');
                if (parts.length === 2) {
                    return new Date(new Date().getFullYear(), parseInt(parts[1]) - 1, parseInt(parts[0]));
                } else if (parts.length === 3) {
                    return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
                }
                return new Date(0);
            };
            return (parseDt(valA) - parseDt(valB)) * (isAsc ? 1 : -1);
        }
        
        return valA.localeCompare(valB, 'pt-BR') * (isAsc ? 1 : -1);
    });
    
    rows.forEach(row => tbody.appendChild(row));
};

window.filterSubtable = function(inputElement) {
    const rawQuery = inputElement.value.toLowerCase().trim();
    const pane = inputElement.closest('.recompra-left-pane, .recompra-right-pane, .route-accordion-body');
    if (!pane) return;
    
    const cards = pane.querySelectorAll('.benchmark-card');
    const table = pane.querySelector('table');
    const rows = table ? table.querySelectorAll('tbody tr') : [];
    
    if (rawQuery === "") {
        if (cards.length > 0) {
            cards.forEach(card => {
                card.classList.remove('hidden-row');
                if (card.classList.contains('extra-option-card') && pane.dataset.expanded !== "true") {
                    card.classList.add('collapsed-option');
                }
            });
        } else {
            rows.forEach(row => {
                row.classList.remove('hidden-row');
            });
        }
        return;
    }
    
    const terms = rawQuery.split(/\s+/);
    const rules = []; // functions that must evaluate to true
    const negations = []; // functions that must evaluate to false
    
    terms.forEach(term => {
        if (term === "") return;
        
        let isNegated = false;
        let cleanTerm = term;
        if (term.startsWith('-') || term.startsWith('!')) {
            isNegated = true;
            cleanTerm = term.substring(1);
        }
        
        if (cleanTerm === "") return;
        
        // Parse comparison operator: e.g. >7200, <7500, ft>15, valor<8000
        const compMatch = cleanTerm.match(/^(?:([a-z]+)[:=])?([<>]=?|=)?([0-9]+)$/);
        if (compMatch) {
            const field = compMatch[1]; // e.g. 'ft', 'freetime', 'frete', 'valor'
            const op = compMatch[2] || '=';
            const numVal = parseInt(compMatch[3], 10);
            
            const predicate = (el) => {
                let targetPrice = 0;
                let targetFT = 0;
                
                if (el.classList.contains('benchmark-card')) {
                    targetPrice = parseFloat(el.getAttribute('data-valor') || '0');
                    targetFT = parseInt(el.getAttribute('data-freetime') || '0', 10);
                } else {
                    targetPrice = parseFloat(el.getAttribute('data-val') || '0');
                    targetFT = parseInt(el.getAttribute('data-freetime') || '0', 10);
                }
                
                let testVal = targetPrice;
                if (field === 'ft' || field === 'freetime') {
                    testVal = targetFT;
                } else if (field === 'frete' || field === 'valor' || field === 'val') {
                    testVal = targetPrice;
                } else if (!field) {
                    testVal = targetPrice; // default if operator is written standalone
                }
                
                if (op === '>') return testVal > numVal;
                if (op === '<') return testVal < numVal;
                if (op === '>=') return testVal >= numVal;
                if (op === '<=') return testVal <= numVal;
                if (op === '=') return testVal === numVal;
                return false;
            };
            
            if (isNegated) {
                negations.push(predicate);
            } else {
                rules.push(predicate);
            }
        } else {
            // Field prefix or text matching
            const colonIdx = cleanTerm.indexOf(':');
            let field = null;
            let textQuery = cleanTerm;
            
            if (colonIdx > 0) {
                field = cleanTerm.substring(0, colonIdx);
                textQuery = cleanTerm.substring(colonIdx + 1);
            }
            
            const predicate = (el) => {
                let obsVal = "";
                let armadorVal = "";
                let agenteVal = "";
                let fullText = el.innerText.toLowerCase();
                
                if (el.classList.contains('benchmark-card')) {
                    obsVal = (el.getAttribute('data-obs') || '');
                    armadorVal = (el.getAttribute('data-armador') || '');
                    agenteVal = (el.getAttribute('data-agente') || '');
                } else {
                    obsVal = (el.getAttribute('data-obs') || '');
                    armadorVal = (el.getAttribute('data-armador') || '');
                    agenteVal = (el.getAttribute('data-agente') || '');
                }
                
                if (field === 'obs' || field === 'observacao') {
                    return obsVal.includes(textQuery);
                } else if (field === 'armador' || field === 'carrier') {
                    return armadorVal.includes(textQuery);
                } else if (field === 'agente' || field === 'agent') {
                    return agenteVal.includes(textQuery);
                } else if (field === 'cliente' || field === 'client') {
                    const cell = el.querySelector('.col-cliente');
                    return cell ? cell.innerText.toLowerCase().includes(textQuery) : fullText.includes(textQuery);
                } else if (field === 'processo' || field === 'oferta') {
                    const cell = el.querySelector('.col-processo');
                    return cell ? cell.innerText.toLowerCase().includes(textQuery) : fullText.includes(textQuery);
                } else {
                    return fullText.includes(textQuery);
                }
            };
            
            if (isNegated) {
                negations.push(predicate);
            } else {
                rules.push(predicate);
            }
        }
    });
    
    if (cards.length > 0) {
        cards.forEach(card => {
            const matchesRules = rules.every(rule => rule(card));
            const matchesNegations = negations.some(neg => neg(card));
            if (matchesRules && !matchesNegations) {
                card.classList.remove('hidden-row');
                card.classList.remove('collapsed-option');
            } else {
                card.classList.add('hidden-row');
            }
        });
    } else {
        rows.forEach(row => {
            const matchesRules = rules.every(rule => rule(row));
            const matchesNegations = negations.some(neg => neg(row));
            if (matchesRules && !matchesNegations) {
                row.classList.remove('hidden-row');
            } else {
                row.classList.add('hidden-row');
            }
        });
    }
};

window.toggleExtraOptions = function(btnElement) {
    const wrapper = btnElement.closest('.toggle-options-wrapper');
    const pane = btnElement.closest('.recompra-left-pane');
    
    if (pane) {
        const cardsList = pane.querySelector('.benchmark-cards-list');
        const isExpanded = pane.dataset.expanded === "true";
        const extraCards = cardsList.querySelectorAll('.extra-option-card');
        const totalCount = extraCards.length;
        
        if (isExpanded) {
            pane.dataset.expanded = "false";
            extraCards.forEach(card => {
                card.classList.add('collapsed-option');
            });
            btnElement.querySelector('.btn-text').innerText = `Mostrar todas as opções (+${totalCount})`;
        } else {
            pane.dataset.expanded = "true";
            extraCards.forEach(card => {
                card.classList.remove('collapsed-option');
            });
            btnElement.querySelector('.btn-text').innerText = "Mostrar menos opções";
        }
    } else {
        // Fallback for tables (if any)
        const tableContainer = wrapper.previousElementSibling;
        if (tableContainer) {
            const table = tableContainer.querySelector('table');
            if (table) {
                const isExpanded = table.dataset.expanded === "true";
                const extraRows = table.querySelectorAll('.extra-option-row');
                const totalCount = extraRows.length;
                
                if (isExpanded) {
                    table.dataset.expanded = "false";
                    extraRows.forEach(row => {
                        row.classList.add('collapsed-option');
                    });
                    btnElement.querySelector('.btn-text').innerText = `Mostrar todas as opções (+${totalCount})`;
                } else {
                    table.dataset.expanded = "true";
                    extraRows.forEach(row => {
                        row.classList.remove('collapsed-option');
                    });
                    btnElement.querySelector('.btn-text').innerText = "Mostrar menos opções";
                }
            }
        }
    }
};

window.selectBenchmark = function(gIdx, oIdx) {
    window.selectedBenchmarks[gIdx] = oIdx;
    
    const accordionBody = document.getElementById(`opp-body-${gIdx}`);
    if (!accordionBody) return;
    
    // Update selected class on cards
    const cardsList = accordionBody.querySelector('.benchmark-cards-list');
    if (cardsList) {
        const cards = cardsList.querySelectorAll('.benchmark-card');
        cards.forEach((card) => {
            const cardDataIdx = parseInt(card.getAttribute('data-index'), 10);
            const radio = card.querySelector('input[type="radio"]');
            if (cardDataIdx === oIdx) {
                card.classList.add('selected');
                if (radio) radio.checked = true;
            } else {
                card.classList.remove('selected');
                if (radio) radio.checked = false;
            }
        });
    }
    
    // Get the selected rate card details
    const group = window.currentGroupedData[gIdx];
    if (!group) return;
    const selectedOpt = group.savingRates[oIdx];
    if (!selectedOpt) return;
    
    const cardVal = selectedOpt.valor;
    const cardRoute = (selectedOpt.rota || '').trim();
    const cardContainer = (selectedOpt.container || '').trim();
    
    const rows = accordionBody.querySelectorAll('.process-row');
    let accordionTotalSaving = 0;
    
    rows.forEach(row => {
        const val = parseFloat(row.dataset.val) || 0;
        const qty = parseFloat(row.dataset.qty) || 0;
        const route = (row.dataset.route || '').trim();
        const container = (row.dataset.container || '').trim();
        const defaultSaving = parseFloat(row.dataset.defaultSaving) || 0;
        
        let matches = false;
        if (analysisGroupBy === 'rota') {
            matches = true; // All rows in this accordion match the route/container of this group
        } else {
            // Check if route and container match the selected card
            matches = route === cardRoute && container === cardContainer;
        }
        
        let saving = 0;
        if (matches) {
            row.classList.add('matching-row');
            row.style.opacity = "1";
            
            const diff = val === 0 ? 0 : Math.max(0, val - cardVal);
            saving = diff * qty;
            
            const diffCell = row.querySelector('.cell-difference');
            if (diffCell) {
                if (saving > 0) {
                    diffCell.innerHTML = `<span class="cell-economy-positive">+$${saving.toLocaleString('pt-BR')}</span>`;
                } else {
                    diffCell.innerHTML = `<span style="color:var(--text-muted); font-size:0.8rem;">$0</span>`;
                }
            }
        } else {
            row.classList.remove('matching-row');
            row.style.opacity = "0.35"; // Dim non-matching row
            saving = defaultSaving; // Keeps its pre-calculated best option saving
            
            // Restore default saving cell display
            const diffCell = row.querySelector('.cell-difference');
            if (diffCell) {
                if (saving > 0) {
                    diffCell.innerHTML = `<span class="cell-economy-positive">+$${saving.toLocaleString('pt-BR')}</span>`;
                } else {
                    diffCell.innerHTML = `<span style="color:var(--text-muted); font-size:0.8rem;">$0</span>`;
                }
            }
        }
        
        accordionTotalSaving += saving;
    });
    
    // Update the total saving shown in the accordion header!
    const header = document.getElementById(`opp-header-${gIdx}`);
    if (header) {
        const economySpan = header.querySelector('.route-economy-val');
        if (economySpan) {
            economySpan.innerText = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(accordionTotalSaving);
        }
    }
    
    // Update overall dashboard saving
    window.updateOverallDashboardSaving();
};

window.updateOverallDashboardSaving = function() {
    let grandTotal = 0;
    const economyElements = document.querySelectorAll('.route-economy-val');
    economyElements.forEach(el => {
        const text = el.innerText.trim();
        const clean = text.replace(/[^0-9]/g, '');
        const val = parseFloat(clean);
        if (!isNaN(val)) grandTotal += val;
    });
    const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(grandTotal);
    const totalSavingEl = document.getElementById('analysis-total-saving');
    if (totalSavingEl) {
        totalSavingEl.innerText = fmt;
    }
};

// Toggle obs chip and re-filter cards
window.toggleObsChip = function(btn, gIdx) {
    btn.classList.toggle('active');
    // Create a fake element with closest() support to trigger filterAndSortCards
    const pane = btn.closest('.recompra-left-pane');
    if (!pane) return;
    filterAndSortCardsFromPane(pane, gIdx);
};

window.filterAndSortCardsFromPane = function(pane, gIdx) {
    const sortVal = pane.querySelector('.select-sort').value;
    const ftVal = pane.querySelector('.select-ft').value;
    const sourceVal = pane.querySelector('.select-source').value;
    
    // Read active chips for obs filter
    const chipsWrapper = pane.querySelector('.obs-chips-wrapper');
    const activeChips = new Set();
    if (chipsWrapper) {
        chipsWrapper.querySelectorAll('.obs-chip.active').forEach(c => activeChips.add(c.getAttribute('data-cat')));
    }
    const totalChips = chipsWrapper ? chipsWrapper.querySelectorAll('.obs-chip').length : 0;
    const obsFilterAll = activeChips.size === totalChips || activeChips.size === 0;
    
    // Hierarchical cargo classification (same as buildSubtableObsDropdownHtml)
    const CARGO_KW = {
        'pneu': ['pneu', 'autopeça', 'auto-peça', 'autoparts', 'auto parts', 'autopeças', 'e-goods', 'borracha', 'tire', 'tyre'],
        'textil': ['textil', 'têxtil', 'textile'],
        'ows': ['ows', 'overweight'],
        'maquina': ['maquina', 'maquinário', 'machinery', 'metal'],
        'imo': ['imo', 'perigosa', 'dangerous'],
        'bateria': ['bateria', 'battery', 'lithium'],
        'reefer': ['reefer', 'refrigerado', 'congelado']
    };
    const NAC_KW = ['nac', 'named account'];
    const SPOT_KW = ['spot', 'promo'];
    
    function classifyCard(obsText) {
        const cats = new Set();
        for (const [cat, kws] of Object.entries(CARGO_KW)) {
            if (kws.some(kw => obsText.includes(kw))) cats.add(cat);
        }
        if (cats.size > 0) return cats;
        if (NAC_KW.some(kw => obsText.includes(kw))) { cats.add('nac'); return cats; }
        if (SPOT_KW.some(kw => obsText.includes(kw))) { cats.add('promo'); return cats; }
        cats.add('geral');
        return cats;
    }
    
    const cardsList = pane.querySelector('.benchmark-cards-list');
    const cards = Array.from(cardsList.querySelectorAll('.benchmark-card'));
    
    // 1. Filter
    cards.forEach(card => {
        const freetime = parseInt(card.getAttribute('data-freetime') || '0', 10);
        const source = card.getAttribute('data-source');
        const obsText = (card.getAttribute('data-obs') || '').toLowerCase();
        
        let show = true;
        
        // Freetime filter
        if (ftVal !== 'all') {
            const minFt = parseInt(ftVal, 10);
            if (freetime < minFt) show = false;
        }
        
        // Source filter
        if (sourceVal !== 'all') {
            if (source !== sourceVal) show = false;
        }
        
        // Obs chip multi-select filter (hierarchical)
        if (!obsFilterAll) {
            const cardCats = classifyCard(obsText);
            let matchesAny = false;
            for (const cat of cardCats) {
                if (activeChips.has(cat)) { matchesAny = true; break; }
            }
            if (!matchesAny) show = false;
        }
        
        if (show) {
            card.classList.remove('hidden-row');
        } else {
            card.classList.add('hidden-row');
        }
    });
    
    // 2. Sort
    cards.sort((a, b) => {
        if (sortVal === 'cheapest') {
            const valA = parseFloat(a.getAttribute('data-valor') || '0');
            const valB = parseFloat(b.getAttribute('data-valor') || '0');
            return valA - valB;
        } else if (sortVal === 'freetime') {
            const ftA = parseInt(a.getAttribute('data-freetime') || '0', 10);
            const ftB = parseInt(b.getAttribute('data-freetime') || '0', 10);
            return ftB - ftA; // descending
        } else if (sortVal === 'validity') {
            const msA = parseFloat(a.getAttribute('data-validity-ms') || '0');
            const msB = parseFloat(b.getAttribute('data-validity-ms') || '0');
            return msB - msA; // descending
        }
        return 0;
    });
    
    // Append sorted cards back to container
    cards.forEach(card => cardsList.appendChild(card));
    
    // 3. Auto-select first visible card if current selection is now hidden
    const visibleCards = cards.filter(card => !card.classList.contains('hidden-row'));
    if (visibleCards.length > 0) {
        const selectedVisible = visibleCards.find(card => card.classList.contains('selected'));
        if (!selectedVisible) {
            const firstCardIdx = parseInt(visibleCards[0].getAttribute('data-index'), 10);
            selectBenchmark(gIdx, firstCardIdx);
        }
    }
};

// Bridge: the sort/ft/source dropdowns still call filterAndSortCards(element, gIdx)
window.filterAndSortCards = function(element, gIdx) {
    const pane = element.closest('.recompra-left-pane');
    if (!pane) return;
    filterAndSortCardsFromPane(pane, gIdx);
};

window.filterRatesByRow = function(rowEl) {
    const route = rowEl.dataset.route;
    const container = rowEl.dataset.container;
    const accordionBody = rowEl.closest('.route-accordion-body');
    if (!accordionBody) return;
    
    // Highlight the clicked row, remove from others in this subtable
    const allRows = accordionBody.querySelectorAll('.process-row');
    allRows.forEach(r => {
        if (r === rowEl) {
            r.classList.add('selected-row');
            r.style.background = 'var(--bg-secondary)';
            r.style.borderLeft = '3px solid var(--primary)';
        } else {
            r.classList.remove('selected-row');
            r.style.background = '';
            r.style.borderLeft = '';
        }
    });
    
    // Filter the rate cards in the left pane
    const cards = accordionBody.querySelectorAll('.benchmark-card');
    const headerTitle = accordionBody.querySelector('.accordion-section-title'); // "Opções de Tarifa"
    
    // Check if we already have a reset button next to "Opções de Tarifa"
    let resetBtn = accordionBody.querySelector('.btn-reset-rates-filter');
    if (!resetBtn) {
        // Insert a small reset link/button
        const titleContainer = headerTitle.parentElement;
        resetBtn = document.createElement('button');
        resetBtn.className = 'btn btn-secondary btn-sm btn-reset-rates-filter';
        resetBtn.innerHTML = '<i data-lucide="eye" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:3px;"></i> Ver Todas';
        resetBtn.style.padding = '2px 6px';
        resetBtn.style.fontSize = '0.65rem';
        resetBtn.style.margin = '0 0 0 8px';
        resetBtn.style.display = 'inline-block';
        resetBtn.onclick = () => {
            // Reset cards visibility
            cards.forEach(c => {
                c.style.display = 'block';
                c.style.opacity = '1';
                c.style.border = '';
                c.style.transform = '';
            });
            // Show all subtable route headers
            accordionBody.querySelectorAll('.subgroup-route-header').forEach(h => h.style.display = 'block');
            resetBtn.remove();
            
            // Remove highlighted rows styling
            allRows.forEach(r => {
                r.classList.remove('selected-row');
                r.style.background = '';
                r.style.borderLeft = '';
            });
            
            lucide.createIcons();
        };
        titleContainer.appendChild(resetBtn);
        lucide.createIcons();
    }
    
    // Show only cards matching route and container
    cards.forEach(c => {
        const cardRoute = c.getAttribute('data-route') || '';
        const cardContainer = c.getAttribute('data-container') || '';
        
        // Match route (looser matching for ports aliases) and container type
        const matchesRoute = cardRoute.toLowerCase().trim() === route.toLowerCase().trim();
        const matchesContainer = cardContainer.toLowerCase().trim() === container.toLowerCase().trim();
        
        if (matchesRoute && matchesContainer) {
            c.style.display = 'block';
            c.style.opacity = '1';
            c.style.border = '2px solid var(--primary)';
        } else {
            c.style.display = 'none';
        }
    });
    
    // Hide all subtable headers on the left except the active one
    accordionBody.querySelectorAll('.subgroup-route-header').forEach(h => {
        const headerText = h.textContent.toLowerCase();
        if (headerText.includes(route.toLowerCase()) && headerText.includes(container.toLowerCase())) {
            h.style.display = 'block';
        } else {
            h.style.display = 'none';
        }
    });
};

/* ==========================================================================
   AI ASSISTANT CHATBOT (MOND AI)
   ========================================================================= */

let aiChatHistory = [];

window.initAiChatbot = function() {
    const btnOpen = document.getElementById('btn-open-ai-chat');
    const btnClose = document.getElementById('btn-close-ai-chat');
    const btnSend = document.getElementById('btn-send-ai-chat');
    const drawer = document.getElementById('ai-chat-drawer');
    const input = document.getElementById('ai-chat-input');
    const messagesContainer = document.getElementById('ai-chat-messages');
    
    if (!btnOpen || !btnClose || !drawer || !input) return;
    
    // Check if Gemini key exists (use fallback if empty)
    const geminiKey = localStorage.getItem('mond_gemini_api_key') || 'AQ.Ab8RN6J0PYZAkHWq43h80TYstW_rvvbIp3gu3KUs9_aMq1u81w';
    
    btnOpen.addEventListener('click', () => {
        drawer.classList.add('active-chat');
        input.focus();
        lucide.createIcons();
    });
    
    btnClose.addEventListener('click', () => {
        drawer.classList.remove('active-chat');
    });
    
    input.addEventListener('input', () => {
        btnSend.disabled = input.value.trim() === "";
    });
    
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            triggerSend();
        }
    });
    
    btnSend.addEventListener('click', () => {
        triggerSend();
    });
    
    function triggerSend() {
        const text = input.value.trim();
        if (text === "") return;
        
        input.value = "";
        btnSend.disabled = true;
        
        // Add user message to UI
        appendChatMessage('user', text);
        
        // Send to Gemini
        sendChatMessageToAi(text);
    }
};

function appendChatMessage(role, text) {
    const messagesContainer = document.getElementById('ai-chat-messages');
    const typingIndicator = document.getElementById('ai-chat-typing');
    
    const msgDiv = document.createElement('div');
    msgDiv.className = `ai-message ${role}`;
    
    // Basic Markdown format helper (bullet points, bold)
    let formattedText = text
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.1);padding:2px 4px;border-radius:4px;font-family:monospace;">$1</code>')
        .replace(/\n- (.*?)/g, '<br>• $1')
        .replace(/\n\* (.*?)/g, '<br>• $1')
        .replace(/\n\d+\.\s(.*?)/g, (match, p1) => `<br>${match.trim()}`)
        .replace(/\n/g, '<br>');
    
    msgDiv.innerHTML = `
        ${formattedText}
        <span class="ai-message-time">${new Date().toLocaleTimeString('pt-BR', {hour: '2-digit', minute:'2-digit'})}</span>
    `;
    
    messagesContainer.insertBefore(msgDiv, typingIndicator);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function getAiContext() {
    // 1. Current Active/Filtered View Summary
    const totalFiltered = filteredRates.length;
    const activeTabLabel = activeDb === 'apiAll' ? 'Operacional + Comercial' : (activeDb === 'commercial' ? 'Comercial' : (activeDb === 'operational' ? 'Operacional' : 'Tarifário/Space'));
    
    let context = `--- PARTE 1: RECORTE ATIVO/FILTRADO NA TELA DO USUÁRIO ---\n`;
    context += `- Aba selecionada: ${activeTabLabel}\n`;
    context += `- Total de registros exibidos sob os filtros atuais: ${totalFiltered}\n`;
    
    if (totalFiltered > 0) {
        context += `- Amostra dos primeiros 25 registros filtrados:\n`;
        filteredRates.slice(0, 25).forEach(r => {
            const cInfo = getContainerInfo(r);
            context += `  * [FILTRADO] Ref: ${r.processo || 'N/A'} | ${r.origem} ➔ ${r.destino} | Container: ${cInfo.qty}x ${cInfo.type} | Compra: USD ${r.valor || 0} | Venda: USD ${r.valorVenda || 0} | FT: ${r.freetime || 0}d | Agente: ${r.agente || 'N/A'} | Armador: ${r.armador || 'N/A'}\n`;
        });
    }
    context += `\n`;
    
    // 2. Full System Database Context (Full RAG Access)
    context += `--- PARTE 2: BANCO DE DADOS COMPLETO (INTEGRAL) ---\n`;
    context += `Abaixo está o resumo consolidado de todo o banco de dados carregado no portal. Use estes dados para responder sobre portos, agentes, fretes e históricos mesmo que não estejam filtrados na tela atual.\n\n`;
    
    // Group all rates/spaces by route to give a complete view
    const allRatesCombined = [...appRates, ...appSpace];
    const fullRoutes = {};
    const fullAgentsSummary = {};
    
    allRatesCombined.forEach(r => {
        if (!r.origem || !r.destino) return;
        const key = `${r.origem.trim().toUpperCase()} ➔ ${r.destino.trim().toUpperCase()}`;
        if (!fullRoutes[key]) {
            fullRoutes[key] = { buyRates: [], sellRates: [], count: 0, agents: new Set(), carriers: new Set(), freeTimes: [] };
        }
        if (r.valor > 0) fullRoutes[key].buyRates.push(r.valor);
        if (r.valorVenda > 0) fullRoutes[key].sellRates.push(r.valorVenda);
        if (r.agente) fullRoutes[key].agents.add(r.agente.trim());
        if (r.armador) fullRoutes[key].carriers.add(r.armador.trim());
        if (r.freetime) {
            const ftVal = parseInt(r.freetime, 10);
            if (!isNaN(ftVal)) fullRoutes[key].freeTimes.push(ftVal);
        }
        fullRoutes[key].count++;
        
        // Agent specific metrics aggregation
        if (r.agente) {
            const ag = r.agente.trim().toUpperCase();
            if (!fullAgentsSummary[ag]) {
                fullAgentsSummary[ag] = { buyRates: [], freeTimes: [], count: 0 };
            }
            if (r.valor > 0) fullAgentsSummary[ag].buyRates.push(r.valor);
            if (r.freetime) {
                const ftVal = parseInt(r.freetime, 10);
                if (!isNaN(ftVal)) fullAgentsSummary[ag].freeTimes.push(ftVal);
            }
            fullAgentsSummary[ag].count++;
        }
    });
    
    context += `RESUMO DE TODAS AS ROTAS DO TARIFÁRIO/SPACE EM BANCO (${Object.keys(fullRoutes).length} rotas):\n`;
    Object.entries(fullRoutes).forEach(([route, stats]) => {
        const avgBuy = stats.buyRates.length > 0 ? stats.buyRates.reduce((a,b)=>a+b, 0)/stats.buyRates.length : 0;
        const minBuy = stats.buyRates.length > 0 ? Math.min(...stats.buyRates) : 0;
        const maxBuy = stats.buyRates.length > 0 ? Math.max(...stats.buyRates) : 0;
        const avgFT = stats.freeTimes.length > 0 ? (stats.freeTimes.reduce((a,b)=>a+b, 0)/stats.freeTimes.length).toFixed(0) : 'N/A';
        const agentsList = Array.from(stats.agents).slice(0, 4).join(', ');
        const carriersList = Array.from(stats.carriers).slice(0, 4).join(', ');
        
        context += `- ROTA: ${route} | Total Linhas: ${stats.count} | Compra Média: USD ${avgBuy.toFixed(0)} (Min: USD ${minBuy} -> Max: USD ${maxBuy}) | FT Médio: ${avgFT} dias | Agentes: [${agentsList}] | Armadores: [${carriersList}]\n`;
    });
    
    // Group operational data by POL -> POD | Container
    const fullOpRoutes = {};
    appOperational.forEach(op => {
        if (!op.origem || !op.destino) return;
        const key = `${op.origem.trim().toUpperCase()} ➔ ${op.destino.trim().toUpperCase()}`;
        if (!fullOpRoutes[key]) {
            fullOpRoutes[key] = { volume: 0, count: 0, clients: new Set(), buyRates: [], sellRates: [] };
        }
        const cInfo = getContainerInfo(op);
        fullOpRoutes[key].volume += cInfo.qty;
        fullOpRoutes[key].count++;
        if (op.cliente) fullOpRoutes[key].clients.add(op.cliente.trim());
        if (op.valor > 0) fullOpRoutes[key].buyRates.push(op.valor);
        if (op.valorVenda > 0) fullOpRoutes[key].sellRates.push(op.valorVenda);
    });
    
    context += `\nRESUMO DE TODA A MASSA OPERACIONAL (PROCESSOS HISTÓRICOS EM BANCO):\n`;
    Object.entries(fullOpRoutes).forEach(([route, stats]) => {
        const avgBuy = stats.buyRates.length > 0 ? stats.buyRates.reduce((a,b)=>a+b,0)/stats.buyRates.length : 0;
        const avgSell = stats.sellRates.length > 0 ? stats.sellRates.reduce((a,b)=>a+b,0)/stats.sellRates.length : 0;
        const clientsList = Array.from(stats.clients).slice(0, 3).join(', ');
        context += `- OPERACIONAL ROTA: ${route} | Total Cargas: ${stats.volume} containers | Nº Processos: ${stats.count} | Compra Média: USD ${avgBuy.toFixed(0)} | Venda Média: USD ${avgSell.toFixed(0)} | Clientes: [${clientsList}]\n`;
    });
    
    // Commercial offers summary
    const fullComRoutes = {};
    appComercial.forEach(c => {
        if (!c.origem || !c.destino) return;
        const key = `${c.origem.trim().toUpperCase()} ➔ ${c.destino.trim().toUpperCase()}`;
        if (!fullComRoutes[key]) {
            fullComRoutes[key] = { count: 0, buyRates: [], sellRates: [] };
        }
        fullComRoutes[key].count++;
        if (c.valor > 0) fullComRoutes[key].buyRates.push(c.valor);
        if (c.valorVenda > 0) fullComRoutes[key].sellRates.push(c.valorVenda);
    });
    
    context += `\nRESUMO DE TODAS AS OFERTAS COMERCIAIS EM BANCO:\n`;
    Object.entries(fullComRoutes).forEach(([route, stats]) => {
        const avgBuy = stats.buyRates.length > 0 ? stats.buyRates.reduce((a,b)=>a+b,0)/stats.buyRates.length : 0;
        context += `- COMERCIAL ROTA: ${route} | Cotações: ${stats.count} | Compra Média: USD ${avgBuy.toFixed(0)}\n`;
    });
    
    // 3. Consolidated Agent purchase and free time metrics
    context += `\nMETRICAS CONSOLIDADAS DE COMPRA E FREE TIME POR AGENTE EM PORTAL:\n`;
    Object.entries(fullAgentsSummary).forEach(([ag, stats]) => {
        const avgBuy = stats.buyRates.length > 0 ? stats.buyRates.reduce((a,b)=>a+b,0)/stats.buyRates.length : 0;
        const avgFT = stats.freeTimes.length > 0 ? (stats.freeTimes.reduce((a,b)=>a+b,0)/stats.freeTimes.length).toFixed(1) : 'N/A';
        context += `- Agente: ${ag} | Qtd Linhas: ${stats.count} | Compra Média: USD ${avgBuy.toFixed(0)} | FT Médio: ${avgFT} dias\n`;
    });
    
    return context;
}

async function sendChatMessageToAi(userMessage) {
    const geminiKey = localStorage.getItem('mond_gemini_api_key') || 'AQ.Ab8RN6J0PYZAkHWq43h80TYstW_rvvbIp3gu3KUs9_aMq1u81w';
    const typingIndicator = document.getElementById('ai-chat-typing');
    
    if (typingIndicator) typingIndicator.style.display = 'flex';
    
    // Format active context
    const dataContext = getAiContext();
    
    // System instructions matching user request specifications
    const systemPrompt = `Você é o analista de pricing sênior da Mond Shipping, freight forwarder de Itajaí/SC especializado em importação marítima Ásia → Brasil. Você responde perguntas estratégicas do time de pricing e diretoria com base exclusivamente nos dados do portal interno (tarifários, consulta de fretes, space on hands, massa operacional e comercial).

Como você raciocina:
- Você tem acesso completo a todo o banco de dados carregado na Mond Shipping (nas duas partes do contexto: Parte 1 com os dados atualmente filtrados na tela e Parte 2 com o resumo integral consolidado de todo o banco de dados do portal). Responda diretamente e com autoridade sobre qualquer porto, agente ou rota solicitada pelo usuário, sem dar desculpas ou avisos desnecessários sobre filtros da tela.
- IMPORTANTE: Nunca dê instruções de navegação sobre como usar os filtros do portal (como "digite Salvador no campo de destino") ou notas técnicas sugerindo alterar filtros, a menos que o usuário peça ajuda especificamente sobre como operar a tela. Foque 100% na resposta analítica e de negócios sobre fretes, agentes e rotas.
- DIRETRIZ CRÍTICA DE OBSERVAÇÕES: A coluna "Observacao" do tarifário contém restrições de commodity obrigatórias (ex: se é exclusivo para pneus, autopeças, solar, vidro ou têxtil), tarifas promocionais/spot e regras de peso máximo ou sobretaxas (OWS/GW). Sempre verifique esse campo com atenção máxima e cite estas condições ao sugerir qualquer frete de compra, deixando claro se o frete atende ou não o tipo de mercadoria pretendida.
- Toda afirmação vem de número agregado dos dados, nunca de suposição. Se disser que um agente é o melhor em algo, mostre a métrica (menor frete médio, maior volume, melhor free time) e o recorte (rota, período, container) tirados diretamente do contexto fornecido.
- "Melhor" precisa de critério explícito. Custo mais baixo, confiabilidade de espaço, free time e volume são coisas diferentes — deixe claro qual está usando.
- Sempre segmente por rota (POL→POD), tipo de container (priorize 40'HC como balizador) e janela de validade. Um agente forte no Sudeste da China pode ser fraco no Norte da China.
- Ao comparar agentes ou armadores, use o frete médio de compra por container e o spread compra vs venda. Aponte quem entrega a menor compra por lane.
- Considere commodity: NAC restrito (têxtil, pneu, eletrônico, autopeça, solar, linha branca) não se compara com carga geral. Separe.
- Se os dados forem insuficientes para concluir (poucos processos, lane sem histórico), diga isso de forma clara em vez de inventar.

Formato da resposta: direto e objetivo, começando pela conclusão, seguida das 2 ou 3 evidências numéricas que a sustentam. Português do Brasil, linguagem de mercado (FAK, NAC, base port, gamble, extra loader, etc.), sem enrolação.`;

    const activeTurnText = `CONTEXTO ATUALIZADO DE FRETE NO PAINEL:\n${dataContext}\n\nPERGUNTA: ${userMessage}`;
    
    aiChatHistory.push({
        role: "user",
        parts: [{ text: activeTurnText }]
    });
    
    // Keep full conversation history without message truncation to allow long chats
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${geminiKey}`;
    
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                contents: aiChatHistory,
                systemInstruction: {
                    parts: [{ text: systemPrompt }]
                }
            })
        });
        
        if (typingIndicator) typingIndicator.style.display = 'none';
        
        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error?.message || `HTTP ${response.status}`);
        }
        
        const resJson = await response.json();
        const responseText = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (!responseText) {
            throw new Error("Gemini API retornou uma resposta vazia.");
        }
        
        appendChatMessage('bot', responseText);
        aiChatHistory.push({
            role: "model",
            parts: [{ text: responseText }]
        });
        
    } catch (err) {
        if (typingIndicator) typingIndicator.style.display = 'none';
        console.error("Erro na comunicação com o Analista IA:", err);
        appendChatMessage('bot', `❌ Ocorreu um erro ao processar sua pergunta: ${err.message}`);
        aiChatHistory.pop();
    }
};

/* ==========================================================================
   MOND AI BOARD EXPANDED PANEL LOGIC (CHAT, KANBAN, SKETCHPAD)
   ========================================================================== */

let aiBoardChatHistory = [];
let kanbanCards = {
    oportunidades: [],
    negociacao: [],
    fechado: []
};

// Sketchpad variables
let sketchDrawing = false;
let sketchColor = "#3b82f6";
let sketchSize = 5;
let sketchCanvas = null;
let sketchCtx = null;

window.activeChatSessionId = 'current';

window.persistActiveChatHistory = function() {
    try {
        if (window.activeChatSessionId === 'current') {
            localStorage.setItem('mond_ai_board_chat_history', JSON.stringify(aiBoardChatHistory));
        } else {
            const saved = localStorage.getItem('mond_ai_saved_chat_sessions');
            if (saved) {
                const sessions = JSON.parse(saved);
                const foundIndex = sessions.findIndex(s => s.id === window.activeChatSessionId);
                if (foundIndex !== -1) {
                    sessions[foundIndex].history = aiBoardChatHistory;
                    localStorage.setItem('mond_ai_saved_chat_sessions', JSON.stringify(sessions));
                }
            }
        }
    } catch (e) {
        console.warn("Failed to persist chat history", e);
    }
};

window.loadChatSessionsList = function() {
    const select = document.getElementById('select-ai-chat-sessions');
    if (!select) return;
    
    select.innerHTML = '<option value="current">Conversa Atual</option>';
    
    const saved = localStorage.getItem('mond_ai_saved_chat_sessions');
    if (saved) {
        try {
            const sessions = JSON.parse(saved);
            sessions.forEach(sess => {
                const opt = document.createElement('option');
                opt.value = sess.id;
                opt.textContent = sess.title;
                select.appendChild(opt);
            });
        } catch(e) {
            console.error("Failed to parse chat sessions", e);
        }
    }
    
    select.value = window.activeChatSessionId;
    
    const deleteBtn = document.getElementById('btn-delete-chat-session');
    if (deleteBtn) {
        deleteBtn.style.display = window.activeChatSessionId === 'current' ? 'none' : 'flex';
    }
};

window.saveCurrentChatSession = function() {
    const title = prompt("Digite um nome para esta conversa:", "Análise Salvador " + new Date().toLocaleDateString('pt-BR'));
    if (!title) return;
    
    let sessions = [];
    const saved = localStorage.getItem('mond_ai_saved_chat_sessions');
    if (saved) {
        try {
            sessions = JSON.parse(saved);
        } catch(e) {}
    }
    
    const newSession = {
        id: 'session-' + Date.now(),
        title: title,
        history: JSON.parse(JSON.stringify(aiBoardChatHistory))
    };
    
    sessions.push(newSession);
    localStorage.setItem('mond_ai_saved_chat_sessions', JSON.stringify(sessions));
    
    window.activeChatSessionId = newSession.id;
    window.loadChatSessionsList();
    window.switchChatSession(newSession.id);
    
    showToast("Conversa salva com sucesso!", "success", 2000);
};

window.switchChatSession = function(sessionId) {
    window.activeChatSessionId = sessionId;
    
    const deleteBtn = document.getElementById('btn-delete-chat-session');
    if (deleteBtn) {
        deleteBtn.style.display = sessionId === 'current' ? 'none' : 'flex';
    }
    
    if (sessionId === 'current') {
        const savedHistory = localStorage.getItem('mond_ai_board_chat_history');
        aiBoardChatHistory = savedHistory ? JSON.parse(savedHistory) : [];
    } else {
        const saved = localStorage.getItem('mond_ai_saved_chat_sessions');
        if (saved) {
            try {
                const sessions = JSON.parse(saved);
                const found = sessions.find(s => s.id === sessionId);
                if (found) {
                    aiBoardChatHistory = found.history || [];
                }
            } catch(e) {
                console.error("Failed to load selected session history", e);
            }
        }
    }
    
    renderChatMessagesFromHistory();
};

window.deleteChatSession = function() {
    const sessionId = window.activeChatSessionId;
    if (sessionId === 'current') return;
    
    if (!confirm("Tem certeza que deseja excluir esta conversa salva?")) return;
    
    const saved = localStorage.getItem('mond_ai_saved_chat_sessions');
    if (saved) {
        try {
            let sessions = JSON.parse(saved);
            sessions = sessions.filter(s => s.id !== sessionId);
            localStorage.setItem('mond_ai_saved_chat_sessions', JSON.stringify(sessions));
        } catch(e) {}
    }
    
    window.activeChatSessionId = 'current';
    window.loadChatSessionsList();
    window.switchChatSession('current');
    
    showToast("Conversa excluída.", "info", 2000);
};

window.configureGeminiApiKey = function() {
    const currentKey = localStorage.getItem('mond_gemini_api_key') || 'AQ.Ab8RN6J0PYZAkHWq43h80TYstW_rvvbIp3gu3KUs9_aMq1u81w';
    const newKey = prompt("Cole sua Chave API do Gemini aqui:", currentKey);
    if (newKey !== null) {
        const trimmed = newKey.trim();
        if (trimmed) {
            localStorage.setItem('mond_gemini_api_key', trimmed);
            const builderInput = document.getElementById('builder-gemini-key');
            if (builderInput) builderInput.value = trimmed;
            showToast("Chave API atualizada com sucesso!", "success", 2000);
        } else {
            localStorage.removeItem('mond_gemini_api_key');
            const builderInput = document.getElementById('builder-gemini-key');
            if (builderInput) builderInput.value = '';
            showToast("Restaurada chave API padrão.", "info", 2000);
        }
    }
};

window.initAiBoardTab = function() {
    const chatInput = document.getElementById('ai-board-chat-input');
    const btnSend = document.getElementById('btn-send-ai-board-chat');
    
    if (chatInput && btnSend) {
        if (!window.aiBoardListenersWired) {
            btnSend.addEventListener('click', () => triggerBoardChatSend());
            chatInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    triggerBoardChatSend();
                }
            });
            window.aiBoardListenersWired = true;
        }
    }
    
    // Load Kanban
    loadKanbanFromStorage();
    renderKanbanColumns();
    
    // Load Saved Chat Sessions List
    window.loadChatSessionsList();
    
    // Load Chat History from LocalStorage
    const savedHistory = localStorage.getItem('mond_ai_board_chat_history');
    if (savedHistory) {
        try {
            aiBoardChatHistory = JSON.parse(savedHistory);
            renderChatMessagesFromHistory();
        } catch(e) {
            console.error("Failed to load chat history", e);
        }
    }
    
    // Initialize Sketchpad Canvas
    setTimeout(initSketchpadCanvas, 150); // Small timeout to ensure tab transition completes and width is active
};

function triggerBoardChatSend() {
    const chatInput = document.getElementById('ai-board-chat-input');
    if (!chatInput) return;
    const text = chatInput.value.trim();
    if (text === "") return;
    
    chatInput.value = "";
    appendBoardChatMessage('user', text);
    sendBoardChatMessageToAi(text);
}

window.sendQuickBoardPrompt = function(promptText) {
    appendBoardChatMessage('user', promptText);
    sendBoardChatMessageToAi(promptText);
};

window.clearAiBoardChat = function() {
    aiBoardChatHistory = [];
    window.persistActiveChatHistory();
    const chatMessages = document.getElementById('ai-board-chat-messages');
    if (chatMessages) {
        chatMessages.innerHTML = `
            <div class="ai-message bot">
                Olá! Este é o seu espaço de trabalho expandido. 
                Aqui você tem o modelo **Gemini 3.1 Pro** com contexto de toda a listagem ativa. 
                Você pode me fazer perguntas profundas sobre rotas, spreads, agentes e armadores, e salvar insights ou criar cards diretamente no Kanban ao lado.
                <span class="ai-message-time">Agora</span>
            </div>
            <div class="ai-typing-indicator" id="ai-board-chat-typing">
                <div class="ai-typing-dot"></div>
                <div class="ai-typing-dot"></div>
                <div class="ai-typing-dot"></div>
            </div>
        `;
    }
};

function renderChatMessagesFromHistory() {
    const chatMessages = document.getElementById('ai-board-chat-messages');
    const typingIndicator = document.getElementById('ai-board-chat-typing');
    if (!chatMessages) return;
    
    chatMessages.innerHTML = "";
    
    aiBoardChatHistory.forEach(msg => {
        const role = msg.role === 'model' ? 'bot' : 'user';
        let text = msg.parts?.[0]?.text || "";
        
        // Hide context setup headers from user bubbles
        if (role === 'user') {
            const idx = text.indexOf('\n\nPERGUNTA: ');
            if (idx !== -1) {
                text = text.substring(idx + '\n\nPERGUNTA: '.length);
            }
        }
        
        const msgDiv = document.createElement('div');
        msgDiv.className = `ai-message ${role}`;
        
        let formattedText = text
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.1);padding:2px 4px;border-radius:4px;font-family:monospace;">$1</code>')
            .replace(/\n- (.*?)/g, '<br>• $1')
            .replace(/\n\* (.*?)/g, '<br>• $1')
            .replace(/\n\d+\.\s(.*?)/g, (match, p1) => `<br>${match.trim()}`)
            .replace(/\n/g, '<br>');
            
        let saveBtnHtml = '';
        if (role === 'bot') {
            saveBtnHtml = `
                <button class="save-insight-btn" onclick="window.saveInsightFromBubble(this)">
                    <i data-lucide="plus" style="width:12px;height:12px;"></i> Salvar no Board
                </button>
            `;
        }
        
        msgDiv.innerHTML = `
            ${formattedText}
            ${saveBtnHtml}
            <span class="ai-message-time">Salvo</span>
        `;
        chatMessages.appendChild(msgDiv);
    });
    
    if (typingIndicator) {
        chatMessages.appendChild(typingIndicator);
    }
    
    chatMessages.scrollTop = chatMessages.scrollHeight;
    lucide.createIcons();
}

function appendBoardChatMessage(role, text) {
    const chatMessages = document.getElementById('ai-board-chat-messages');
    const typingIndicator = document.getElementById('ai-board-chat-typing');
    if (!chatMessages) return;
    
    const msgDiv = document.createElement('div');
    msgDiv.className = `ai-message ${role}`;
    
    // Basic Markdown parser for chatbot board
    let formattedText = text
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.1);padding:2px 4px;border-radius:4px;font-family:monospace;">$1</code>')
        .replace(/\n- (.*?)/g, '<br>• $1')
        .replace(/\n\* (.*?)/g, '<br>• $1')
        .replace(/\n\d+\.\s(.*?)/g, (match, p1) => `<br>${match.trim()}`)
        .replace(/\n/g, '<br>');
        
    // Add "Salvar no Board" button for assistant responses
    let saveBtnHtml = '';
    if (role === 'bot') {
        saveBtnHtml = `
            <button class="save-insight-btn" onclick="window.saveInsightFromBubble(this)">
                <i data-lucide="plus" style="width:12px;height:12px;"></i> Salvar no Board
            </button>
        `;
    }
    
    msgDiv.innerHTML = `
        ${formattedText}
        ${saveBtnHtml}
        <span class="ai-message-time">${new Date().toLocaleTimeString('pt-BR', {hour: '2-digit', minute:'2-digit'})}</span>
    `;
    
    chatMessages.insertBefore(msgDiv, typingIndicator);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    lucide.createIcons();
}

async function sendBoardChatMessageToAi(userMessage) {
    const geminiKey = localStorage.getItem('mond_gemini_api_key') || 'AQ.Ab8RN6J0PYZAkHWq43h80TYstW_rvvbIp3gu3KUs9_aMq1u81w';
    const typingIndicator = document.getElementById('ai-board-chat-typing');
    
    if (typingIndicator) typingIndicator.style.display = 'flex';
    
    const dataContext = getAiContext();
    
    const systemPrompt = `Você é o analista de pricing sênior da Mond Shipping, freight forwarder de Itajaí/SC especializado em importação marítima Ásia → Brasil. Você responde perguntas estratégicas do time de pricing e diretoria com base exclusivamente nos dados do portal interno (tarifários, consulta de fretes, space on hands, massa operacional e comercial).

Como você raciocina:
- Você tem acesso completo a todo o banco de dados carregado na Mond Shipping (nas duas partes do contexto: Parte 1 com os dados atualmente filtrados na tela e Parte 2 com o resumo integral consolidado de todo o banco de dados do portal). Responda diretamente e com autoridade sobre qualquer porto, agente ou rota solicitada pelo usuário, sem dar desculpas ou avisos desnecessários sobre filtros da tela.
- IMPORTANTE: Nunca dê instruções de navegação sobre como usar os filtros do portal (como "digite Salvador no campo de destino") ou notas técnicas sugerindo alterar filtros, a menos que o usuário peça ajuda especificamente sobre como operar a tela. Foque 100% na resposta analítica e de negócios sobre fretes, agentes e rotas.
- DIRETRIZ CRÍTICA DE OBSERVAÇÕES: A coluna "Observacao" do tarifário contém restrições de commodity obrigatórias (ex: se é exclusivo para pneus, autopeças, solar, vidro ou têxtil), tarifas promocionais/spot e regras de peso máximo ou sobretaxas (OWS/GW). Sempre verifique esse campo com atenção máxima e cite estas condições ao sugerir qualquer frete de compra, deixando claro se o frete atende ou não o tipo de mercadoria pretendida.
- Toda afirmação vem de número agregado dos dados, nunca de suposição. Se disser que um agente é o melhor em algo, mostre a métrica (menor frete médio, maior volume, melhor free time) e o recorte (rota, período, container) tirados diretamente do contexto fornecido.
- "Melhor" precisa de critério explícito. Custo mais baixo, confiabilidade de espaço, free time e volume são coisas diferentes — deixe claro qual está usando.
- Sempre segmente por rota (POL→POD), tipo de container (priorize 40'HC como balizador) e janela de validade. Um agente forte no Sudeste da China pode ser fraco no Norte da China.
- Ao comparar agentes ou armadores, use o frete médio de compra por container e o spread compra vs venda. Aponte quem entrega a menor compra por lane.
- Considere commodity: NAC restrito (têxtil, pneu, eletrônico, autopeça, solar, linha branca) não se compara com carga geral. Separe.
- Se os dados forem insuficientes para concluir (poucos processos, lane sem histórico), diga isso de forma clara em vez de inventar.

Formato da resposta: direto e objetivo, começando pela conclusão, seguida das 2 ou 3 evidências numéricas que a sustentam. Português do Brasil, linguagem de mercado (FAK, NAC, base port, gamble, extra loader, etc.), sem enrolação.`;

    const activeTurnText = `CONTEXTO ATUALIZADO DE FRETE NO PAINEL:\n${dataContext}\n\nPERGUNTA: ${userMessage}`;
    
    aiBoardChatHistory.push({
        role: "user",
        parts: [{ text: activeTurnText }]
    });
    
    // Keep full conversation history without message truncation to allow long chats
    
    // Save state after user query input
    window.persistActiveChatHistory();
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${geminiKey}`;
    
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                contents: aiBoardChatHistory,
                systemInstruction: {
                    parts: [{ text: systemPrompt }]
                }
            })
        });
        
        if (typingIndicator) typingIndicator.style.display = 'none';
        
        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error?.message || `HTTP ${response.status}`);
        }
        
        const resJson = await response.json();
        const responseText = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (!responseText) {
            throw new Error("Gemini API retornou uma resposta vazia.");
        }
        
        appendBoardChatMessage('bot', responseText);
        aiBoardChatHistory.push({
            role: "model",
            parts: [{ text: responseText }]
        });
        
        // Save state after assistant reply response
        window.persistActiveChatHistory();
        
    } catch (err) {
        if (typingIndicator) typingIndicator.style.display = 'none';
        console.error("Erro na comunicação com o Analista IA no Board:", err);
        appendBoardChatMessage('bot', `❌ Ocorreu um erro ao processar sua pergunta: ${err.message}`);
        aiBoardChatHistory.pop();
    }
}

// ==========================================
// KANBAN SYSTEM
// ==========================================
function loadKanbanFromStorage() {
    const saved = localStorage.getItem('mond_ai_kanban_board');
    if (saved) {
        try {
            kanbanCards = JSON.parse(saved);
        } catch (e) {
            console.error("Failed to parse Kanban data", e);
        }
    } else {
        kanbanCards = {
            oportunidades: [
                { id: "k-1", title: "Negociação Ningbo 40'HC", text: "Agente Helka com frete de compra médio USD 4.300. Buscar renegociação para Salvador." }
            ],
            negociacao: [],
            fechado: []
        };
    }
}

function saveKanbanToStorage() {
    localStorage.setItem('mond_ai_kanban_board', JSON.stringify(kanbanCards));
}

function renderKanbanColumns() {
    const cols = ['oportunidades', 'negociacao', 'fechado'];
    cols.forEach(col => {
        const container = document.getElementById(`kanban-col-${col}`);
        if (!container) return;
        container.innerHTML = "";
        
        const list = kanbanCards[col] || [];
        list.forEach(card => {
            const cardEl = document.createElement('div');
            cardEl.className = 'kanban-card';
            cardEl.draggable = true;
            cardEl.id = card.id;
            cardEl.setAttribute('ondragstart', 'window.dragKanbanCardStart(event)');
            
            cardEl.innerHTML = `
                <button class="kanban-card-delete" onclick="window.deleteKanbanCard('${col}', '${card.id}')">&times;</button>
                <div class="kanban-card-title">${card.title}</div>
                <div class="kanban-card-text">${card.text}</div>
            `;
            container.appendChild(cardEl);
        });
    });
}

window.addNewKanbanCard = function() {
    const titleInput = document.getElementById('kanban-modal-title');
    const colSelect = document.getElementById('kanban-modal-col');
    const textInput = document.getElementById('kanban-modal-text');
    const modal = document.getElementById('kanban-modal');
    
    if (titleInput && colSelect && textInput && modal) {
        titleInput.value = "Novo Card";
        colSelect.value = "oportunidades";
        textInput.value = "";
        
        modal.style.display = 'flex';
    }
};

window.saveInsightFromBubble = function(btnElement) {
    // Grab text selection first
    const selection = window.getSelection().toString().trim();
    
    let textToSave = "";
    if (selection) {
        textToSave = selection;
    } else {
        const parentMsg = btnElement.closest('.ai-message');
        if (parentMsg) {
            const clone = parentMsg.cloneNode(true);
            const btn = clone.querySelector('.save-insight-btn');
            if (btn) btn.remove();
            const time = clone.querySelector('.ai-message-time');
            if (time) time.remove();
            
            textToSave = clone.innerText.trim();
        }
    }
    
    const titleInput = document.getElementById('kanban-modal-title');
    const colSelect = document.getElementById('kanban-modal-col');
    const textInput = document.getElementById('kanban-modal-text');
    const modal = document.getElementById('kanban-modal');
    
    if (titleInput && colSelect && textInput && modal) {
        titleInput.value = "Análise IA - " + new Date().toLocaleDateString('pt-BR');
        colSelect.value = "oportunidades";
        textInput.value = textToSave;
        
        modal.style.display = 'flex';
    }
};

window.saveInsightToKanban = function(insightText) {
    const titleInput = document.getElementById('kanban-modal-title');
    const colSelect = document.getElementById('kanban-modal-col');
    const textInput = document.getElementById('kanban-modal-text');
    const modal = document.getElementById('kanban-modal');
    
    if (titleInput && colSelect && textInput && modal) {
        titleInput.value = "Análise IA - " + new Date().toLocaleDateString('pt-BR');
        colSelect.value = "oportunidades";
        textInput.value = insightText.replace(/\\'/g, "'").replace(/&quot;/g, '"');
        
        modal.style.display = 'flex';
    }
};

window.closeKanbanModal = function() {
    const modal = document.getElementById('kanban-modal');
    if (modal) {
        modal.style.display = 'none';
    }
};

window.saveKanbanModalCard = function() {
    const titleInput = document.getElementById('kanban-modal-title');
    const colSelect = document.getElementById('kanban-modal-col');
    const textInput = document.getElementById('kanban-modal-text');
    const modal = document.getElementById('kanban-modal');
    
    if (titleInput && colSelect && textInput) {
        const title = titleInput.value.trim();
        const col = colSelect.value;
        const text = textInput.value.trim();
        
        if (!title || !text) {
            showToast("Por favor, preencha o título e o conteúdo.", "error", 2000);
            return;
        }
        
        const newCard = {
            id: 'k-' + Date.now(),
            title: title,
            text: text
        };
        
        if (!kanbanCards[col]) kanbanCards[col] = [];
        kanbanCards[col].push(newCard);
        saveKanbanToStorage();
        renderKanbanColumns();
        
        if (modal) modal.style.display = 'none';
        showToast("Card adicionado ao board!", "success", 2000);
    }
};

window.deleteKanbanCard = function(col, id) {
    if (!confirm("Excluir este card do quadro?")) return;
    kanbanCards[col] = (kanbanCards[col] || []).filter(c => c.id !== id);
    saveKanbanToStorage();
    renderKanbanColumns();
};

// Drag and drop events
window.dragKanbanCardStart = function(ev) {
    ev.dataTransfer.setData("text", ev.target.id);
};

window.allowKanbanDrop = function(ev) {
    ev.preventDefault();
};

window.dropKanbanCard = function(ev, targetCol) {
    ev.preventDefault();
    const cardId = ev.dataTransfer.getData("text");
    if (!cardId) return;
    
    let foundCard = null;
    const cols = ['oportunidades', 'negociacao', 'fechado'];
    for (const col of cols) {
        const index = kanbanCards[col].findIndex(c => c.id === cardId);
        if (index !== -1) {
            foundCard = kanbanCards[col][index];
            kanbanCards[col].splice(index, 1);
            break;
        }
    }
    
    if (foundCard) {
        kanbanCards[targetCol].push(foundCard);
        saveKanbanToStorage();
        renderKanbanColumns();
    }
};

// ==========================================
// WHITEBOARD SKETCHPAD
// ==========================================
function initSketchpadCanvas() {
    sketchCanvas = document.getElementById('sketch-canvas');
    if (!sketchCanvas) return;
    sketchCtx = sketchCanvas.getContext('2d');
    
    const parent = sketchCanvas.parentElement;
    sketchCanvas.width = parent.clientWidth;
    sketchCanvas.height = 180;
    
    if (!window.sketchpadListenersWired) {
        const colorInput = document.getElementById('sketch-color');
        if (colorInput) {
            colorInput.addEventListener('change', (e) => {
                sketchColor = e.target.value;
            });
        }
        
        const sizeInput = document.getElementById('sketch-size');
        if (sizeInput) {
            sizeInput.addEventListener('change', (e) => {
                sketchSize = parseInt(e.target.value, 10);
            });
        }
        
        sketchCanvas.addEventListener('mousedown', startDrawing);
        sketchCanvas.addEventListener('mousemove', draw);
        sketchCanvas.addEventListener('mouseup', stopDrawing);
        sketchCanvas.addEventListener('mouseout', stopDrawing);
        
        sketchCanvas.addEventListener('touchstart', startDrawingTouch, { passive: false });
        sketchCanvas.addEventListener('touchmove', drawTouch, { passive: false });
        sketchCanvas.addEventListener('touchend', stopDrawing);
        
        window.sketchpadListenersWired = true;
    }
    
    const savedImg = localStorage.getItem('mond_ai_whiteboard_img');
    if (savedImg) {
        const img = new Image();
        img.onload = function() {
            sketchCtx.drawImage(img, 0, 0);
        };
        img.src = savedImg;
    }
}

function startDrawing(e) {
    sketchDrawing = true;
    draw(e);
}

function startDrawingTouch(e) {
    sketchDrawing = true;
    drawTouch(e);
}

function draw(e) {
    if (!sketchDrawing) return;
    const rect = sketchCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    sketchCtx.lineWidth = sketchSize;
    sketchCtx.lineCap = 'round';
    sketchCtx.strokeStyle = sketchColor;
    
    sketchCtx.lineTo(x, y);
    sketchCtx.stroke();
    sketchCtx.beginPath();
    sketchCtx.moveTo(x, y);
}

function drawTouch(e) {
    if (!sketchDrawing) return;
    e.preventDefault();
    const touch = e.touches[0];
    const rect = sketchCanvas.getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;
    
    sketchCtx.lineWidth = sketchSize;
    sketchCtx.lineCap = 'round';
    sketchCtx.strokeStyle = sketchColor;
    
    sketchCtx.lineTo(x, y);
    sketchCtx.stroke();
    sketchCtx.beginPath();
    sketchCtx.moveTo(x, y);
}

function stopDrawing() {
    if (!sketchDrawing) return;
    sketchDrawing = false;
    sketchCtx.beginPath();
    
    try {
        localStorage.setItem('mond_ai_whiteboard_img', sketchCanvas.toDataURL());
    } catch (err) {
        console.warn("Could not save whiteboard drawing:", err);
    }
}

window.clearSketchpad = function() {
    if (sketchCanvas && sketchCtx) {
        sketchCtx.clearRect(0, 0, sketchCanvas.width, sketchCanvas.height);
        localStorage.removeItem('mond_ai_whiteboard_img');
    }
};

/* ==========================================================================
   OUTLIER SELECTION & DESELECTION (EXCEL-STYLE)
   ========================================================================== */
window.toggleRowExclusion = function(globalIndex, isChecked) {
    if (filteredRates[globalIndex]) {
        filteredRates[globalIndex]._excluded = !isChecked;
    }
    const chkAll = document.getElementById('chk-select-all-rows');
    if (chkAll) {
        const total = filteredRates.length;
        const active = filteredRates.filter(r => !r._excluded).length;
        chkAll.checked = active === total;
        chkAll.indeterminate = active > 0 && active < total;
    }
    renderTable();
    renderAnalyticsDashboard();
    updateDashboardCards();
    updateResultsCount();
};

window.toggleSelectAllRows = function(isChecked) {
    filteredRates.forEach(r => {
        r._excluded = !isChecked;
    });
    renderTable();
    renderAnalyticsDashboard();
    updateDashboardCards();
    updateResultsCount();
};

window.autoDeselectOutliers = function() {
    if (!filteredRates || filteredRates.length < 4) {
        if (typeof showToast === 'function') showToast('ℹ️ É necessário pelo menos 4 registros para calcular outliers.', 'info', 3000);
        return;
    }

    const buyVals = filteredRates.map(r => r.valor || 0).filter(v => v > 0).sort((a, b) => a - b);
    if (buyVals.length < 4) {
        if (typeof showToast === 'function') showToast('ℹ️ Dados insuficientes para remover outliers.', 'info', 3000);
        return;
    }

    const q1 = buyVals[Math.floor(buyVals.length * 0.25)];
    const q3 = buyVals[Math.floor(buyVals.length * 0.75)];
    const iqr = q3 - q1;
    const lowerFence = Math.max(0, q1 - 1.5 * iqr);
    const upperFence = q3 + 1.5 * iqr;

    let outlierCount = 0;
    filteredRates.forEach(r => {
        const val = r.valor || 0;
        if (val > 0 && (val < lowerFence || val > upperFence)) {
            r._excluded = true;
            outlierCount++;
        } else {
            r._excluded = false;
        }
    });

    const chkAll = document.getElementById('chk-select-all-rows');
    if (chkAll) {
        chkAll.checked = outlierCount === 0;
        chkAll.indeterminate = outlierCount > 0 && outlierCount < filteredRates.length;
    }

    renderTable();
    renderAnalyticsDashboard();
    updateDashboardCards();
    updateResultsCount();

    if (typeof showToast === 'function') {
        if (outlierCount > 0) {
            showToast(`✅ ${outlierCount} outlier(s) desmarcado(s) com sucesso! (Faixa aceitável: $${Math.round(lowerFence)} - $${Math.round(upperFence)})`, 'success', 5000);
        } else {
            showToast(`ℹ️ Nenhum outlier fora da curva encontrado no conjunto atual.`, 'info', 3000);
        }
    }
};

function updateResultsCount() {
    if (!resultsCount) return;
    const total = filteredRates.length;
    const active = filteredRates.filter(r => !r._excluded).length;
    if (total === 0) {
        resultsCount.innerText = "0 encontrados";
        resultsCount.className = "badge badge-danger";
    } else if (active < total) {
        resultsCount.innerText = `${active} de ${total} na análise (${total - active} desmarcados)`;
        resultsCount.className = "badge badge-warning";
    } else {
        resultsCount.innerText = `${total} encontrados`;
        resultsCount.className = "badge badge-info";
    }
}



