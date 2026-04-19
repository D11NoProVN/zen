// ZenScan v1.0 — Blob Engine Worker
// Supports: multi-file processing, per-keyword result tracking
importScripts('worker-v6-utils.js');

let isProcessing = false;

self.onmessage = async function (e) {
    const { files, keywords, excludeKeywords, stripUrl, dedup } = e.data;
    if (!files || files.length === 0 || isProcessing) return;

    isProcessing = true;

    let totalLines = 0;
    let filteredLines = 0;
    let bytesProcessed = 0;
    let lastUpdate = Date.now();

    const domainStats = new Map();
    const seenSet = new Set();

    const kwList = Array.isArray(keywords)
        ? keywords.map(k => String(k).trim().toLowerCase()).filter(Boolean)
        : [];

    const exList = typeof excludeKeywords === 'string'
        ? excludeKeywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
        : [];

    // Per-keyword tracking
    const perKeywordBatch = {};  // { kw: [lines] }
    const perKeywordCounts = {}; // { kw: number }
    kwList.forEach(kw => {
        perKeywordBatch[kw] = [];
        perKeywordCounts[kw] = 0;
    });

    let foundLinesBatch = [];

    try {
        // Process each file sequentially
        for (const file of files) {
            const reader = file.stream().getReader();
            const decoder = new TextDecoder('utf-8');
            let partialLine = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                bytesProcessed += value.length;
                const text = decoder.decode(value, { stream: true });
                const combinedText = partialLine + text;
                const lines = combinedText.split(/\r?\n/);
                partialLine = lines.pop();

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (!line || line.length < 3) continue;

                    const cleanLine = line.trim().split(/[\s|]+/)[0];
                    if (!cleanLine.includes(':')) continue;

                    totalLines++;

                    const processed = processLegacyScanLine({
                        line: cleanLine,
                        keywords: kwList,
                        excludeKeywords: exList,
                        stripUrl,
                        dedup,
                        seenSet
                    });
                    if (!processed) continue;

                    const { matchedKeyword, outputLine, domain } = processed;

                    perKeywordBatch[matchedKeyword].push(outputLine);
                    perKeywordCounts[matchedKeyword]++;
                    filteredLines++;

                    if (domain) {
                        domainStats.set(domain, (domainStats.get(domain) || 0) + 1);
                    }

                    foundLinesBatch.push(outputLine);

                    // Batch send
                    if (foundLinesBatch.length >= 10000 || (Date.now() - lastUpdate > 300)) {
                        sendUpdate(
                            totalLines, filteredLines, bytesProcessed,
                            foundLinesBatch.slice(-20), false,
                            foundLinesBatch.join('\n'),
                            domainStats, perKeywordBatch, perKeywordCounts
                        );
                        foundLinesBatch = [];
                        // Clear per-keyword batches (data already sent)
                        kwList.forEach(kw => { perKeywordBatch[kw] = []; });
                        lastUpdate = Date.now();
                    }
                }
            }

            if (partialLine.trim()) {
                const cleanLine = partialLine.trim().split(/[\s|]+/)[0];
                if (cleanLine.includes(':')) {
                    totalLines++;

                    const processed = processLegacyScanLine({
                        line: cleanLine,
                        keywords: kwList,
                        excludeKeywords: exList,
                        stripUrl,
                        dedup,
                        seenSet
                    });

                    if (processed) {
                        const { matchedKeyword, outputLine, domain } = processed;
                        perKeywordBatch[matchedKeyword].push(outputLine);
                        perKeywordCounts[matchedKeyword]++;
                        filteredLines++;

                        if (domain) {
                            domainStats.set(domain, (domainStats.get(domain) || 0) + 1);
                        }

                        foundLinesBatch.push(outputLine);
                    }
                }
            }
        }

        // Final send
        sendUpdate(
            totalLines, filteredLines, bytesProcessed,
            foundLinesBatch.slice(-50), true,
            foundLinesBatch.join('\n'),
            domainStats, perKeywordBatch, perKeywordCounts
        );
    } catch (error) {
        self.postMessage({ type: 'error', message: error.message });
    } finally {
        isProcessing = false;
    }
};

function sendUpdate(total, filtered, bytes, preview, completed, results, domainStats, perKeywordBatch, perKeywordCounts) {
    const topDomains = Array.from(domainStats.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15);

    // Build per-keyword data for this chunk
    const perKeyword = {};
    for (const [kw, lines] of Object.entries(perKeywordBatch)) {
        if (lines.length > 0) perKeyword[kw] = lines;
    }

    self.postMessage({
        type: completed ? 'complete' : 'progress',
        total,
        filtered,
        bytes,
        preview,
        completed,
        results,
        topDomains,
        perKeyword,
        perKeywordCounts: { ...perKeywordCounts },
    });
}
