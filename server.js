const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const MOND_TOKEN = process.env.MOND_API_TOKEN || 'b2e7c1f4-8a2d-4e3b-9c6a-7f1e2d5a9b3c';
const OPERATIONAL_URL = 'https://server-mond.tail46f98e.ts.net/api/operacional';
const COMMERCIAL_URL = 'https://server-mond.tail46f98e.ts.net/api/comercial';

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Helper to get file modified time
function getFileTimestamp(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            const stats = fs.statSync(filePath);
            return stats.mtime.toISOString();
        }
    } catch (e) {
        // ignore
    }
    return null;
}

const syncStatus = {
    operational: 'idle',
    commercial: 'idle',
    operationalTimestamp: getFileTimestamp(path.join(__dirname, 'operational_cache.json')),
    commercialTimestamp: getFileTimestamp(path.join(__dirname, 'commercial_cache.json'))
};

// GET /api/sync-status
app.get('/api/sync-status', (req, res) => {
    const opTs = syncStatus.operationalTimestamp || getFileTimestamp(path.join(__dirname, 'operational_cache.json'));
    const comTs = syncStatus.commercialTimestamp || getFileTimestamp(path.join(__dirname, 'commercial_cache.json'));
    const responseData = {
        operational: syncStatus.operational,
        commercial: syncStatus.commercial,
        operationalTimestamp: opTs,
        commercialTimestamp: comTs
    };
    if (syncStatus.operational === 'completed') syncStatus.operational = 'idle';
    if (syncStatus.commercial === 'completed') syncStatus.commercial = 'idle';
    res.json(responseData);
});

// Sync Operational Background Task
async function triggerSyncOperational() {
    if (syncStatus.operational === 'syncing') return;
    syncStatus.operational = 'syncing';
    try {
        const response = await fetch(OPERATIONAL_URL, {
            headers: { 'Authorization': `Bearer ${MOND_TOKEN}` }
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const text = await response.text();
        JSON.parse(text); // validate
        const tempPath = path.join(__dirname, 'operational_cache.json.tmp');
        const targetPath = path.join(__dirname, 'operational_cache.json');
        fs.writeFileSync(tempPath, text, 'utf-8');
        fs.renameSync(tempPath, targetPath);
        syncStatus.operational = 'completed';
        syncStatus.operationalTimestamp = new Date().toISOString();
        console.log('[Sync] Operational data successfully updated.');
    } catch (err) {
        console.error('[Sync] Operational sync failed:', err.message);
        syncStatus.operational = 'failed';
        setTimeout(() => { if (syncStatus.operational === 'failed') syncStatus.operational = 'idle'; }, 8000);
    }
}

// GET /api/sync-operational
app.get('/api/sync-operational', (req, res) => {
    triggerSyncOperational();
    res.json({ success: true, message: 'Sincronização operacional iniciada.' });
});

// Sync Commercial Background Task
async function triggerSyncCommercial() {
    if (syncStatus.commercial === 'syncing') return;
    syncStatus.commercial = 'syncing';
    try {
        const response = await fetch(COMMERCIAL_URL, {
            headers: { 'Authorization': `Bearer ${MOND_TOKEN}` }
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const text = await response.text();
        JSON.parse(text); // validate
        const tempPath = path.join(__dirname, 'commercial_cache.json.tmp');
        const targetPath = path.join(__dirname, 'commercial_cache.json');
        fs.writeFileSync(tempPath, text, 'utf-8');
        fs.renameSync(tempPath, targetPath);
        syncStatus.commercial = 'completed';
        syncStatus.commercialTimestamp = new Date().toISOString();
        console.log('[Sync] Commercial data successfully updated.');
    } catch (err) {
        console.error('[Sync] Commercial sync failed:', err.message);
        syncStatus.commercial = 'failed';
        setTimeout(() => { if (syncStatus.commercial === 'failed') syncStatus.commercial = 'idle'; }, 8000);
    }
}

// GET /api/sync-commercial
app.get('/api/sync-commercial', (req, res) => {
    triggerSyncCommercial();
    res.json({ success: true, message: 'Sincronização comercial iniciada.' });
});

// GET /api/get-snapshots
app.get('/api/get-snapshots', (req, res) => {
    try {
        const snapDir = path.join(__dirname, 'snapshots');
        if (!fs.existsSync(snapDir)) {
            return res.json([]);
        }
        const files = fs.readdirSync(snapDir);
        const snapshots = [];
        for (const file of files) {
            const match = file.match(/^snapshot_([^_]+)_(\d{4}-\d{2}-\d{2})\.json$/);
            if (match) {
                const agent = match[1];
                const date = match[2];
                try {
                    const raw = fs.readFileSync(path.join(snapDir, file), 'utf-8');
                    const clean = raw.replace(/^\uFEFF/, '').trim();
                    const parsed = JSON.parse(clean);
                    snapshots.push({
                        key: `snapshot:${agent.toUpperCase()}:${date}`,
                        agent: agent.toUpperCase(),
                        date: date,
                        data: parsed
                    });
                } catch (parseErr) {
                    console.warn(`[Snapshot] Error parsing ${file}:`, parseErr.message);
                }
            }
        }
        res.json(snapshots);
    } catch (err) {
        console.error('[Snapshot] Failed to read snapshots:', err);
        res.status(500).json({ error: 'Erro ao listar snapshots.' });
    }
});

// POST /api/save-snapshot
app.post('/api/save-snapshot', (req, res) => {
    try {
        const agent = (req.headers['x-agent-name'] || req.body?.agent || 'AGENT').toString().toUpperCase().trim();
        const date = (req.headers['x-snapshot-date'] || req.body?.date || new Date().toISOString().slice(0, 10)).toString().trim();
        const data = req.body?.data !== undefined ? req.body.data : req.body;

        const snapDir = path.join(__dirname, 'snapshots');
        if (!fs.existsSync(snapDir)) {
            fs.mkdirSync(snapDir, { recursive: true });
        }

        const fileName = `snapshot_${agent}_${date}.json`;
        const filePath = path.join(snapDir, fileName);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        console.log(`[Snapshot] Saved ${filePath}`);
        res.json({ success: true, file: fileName });
    } catch (err) {
        console.error('[Snapshot] Failed to save snapshot:', err);
        res.status(500).json({ error: 'Erro ao salvar snapshot.' });
    }
});

// Static files
app.use(express.static(path.join(__dirname)));

// SPA fallback for HTML5 history API
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
});
