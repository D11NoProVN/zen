// ZenScan Download Server
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const app = express();

const PORT = 8080;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

app.use(express.json());
app.use(express.static(__dirname));

// API: Get list of downloaded files
app.get('/api/files', (req, res) => {
    try {
        const files = fs.readdirSync(DOWNLOAD_DIR)
            .filter(f => f.endsWith('.txt'))
            .map(filename => {
                const filepath = path.join(DOWNLOAD_DIR, filename);
                const stats = fs.statSync(filepath);
                return {
                    name: filename,
                    size: stats.size,
                    modified: stats.mtime,
                    path: filepath
                };
            })
            .sort((a, b) => b.modified - a.modified);
        res.json({ success: true, files });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: Download file from URL
app.post('/api/download', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ success: false, error: 'URL is required' });
    }

    try {
        // Extract filename from URL or generate one
        let filename = path.basename(new URL(url).pathname);
        if (!filename.endsWith('.txt')) {
            filename = `download_${Date.now()}.txt`;
        }

        const filepath = path.join(DOWNLOAD_DIR, filename);

        // Download file
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream',
            timeout: 60000,
            maxContentLength: 500 * 1024 * 1024, // 500MB max
        });

        const writer = fs.createWriteStream(filepath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        const stats = fs.statSync(filepath);
        res.json({
            success: true,
            file: {
                name: filename,
                size: stats.size,
                modified: stats.mtime,
                path: filepath
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: Delete file
app.delete('/api/files/:filename', (req, res) => {
    try {
        const filepath = path.join(DOWNLOAD_DIR, req.params.filename);
        if (fs.existsSync(filepath)) {
            fs.unlinkSync(filepath);
            res.json({ success: true });
        } else {
            res.status(404).json({ success: false, error: 'File not found' });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: Read file content (for scanning)
app.get('/api/files/:filename/content', (req, res) => {
    try {
        const filepath = path.join(DOWNLOAD_DIR, req.params.filename);
        if (fs.existsSync(filepath)) {
            const content = fs.readFileSync(filepath, 'utf8');
            res.json({ success: true, content });
        } else {
            res.status(404).json({ success: false, error: 'File not found' });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`ZenScan Server running at http://localhost:${PORT}`);
});
