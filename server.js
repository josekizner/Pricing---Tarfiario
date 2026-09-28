const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.static(path.join(__dirname)));

app.get('/api/sync-status', (req, res) => {
    res.json({
        operational: 'idle',
        commercial: 'idle',
        operationalTimestamp: new Date().toISOString(),
        commercialTimestamp: new Date().toISOString()
    });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
