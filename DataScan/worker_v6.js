// ZenScan v1.0 — Blob Engine Worker
// Supports: multi-file processing, per-keyword result tracking
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

    // Parse keywords — already an array from main thread
    const kwList = Array.isArray(keywords)
        ? keywords.map(k => k.trim().toLowerCase()).filter(k => k)
        : keywords.split(',').map(k => k.trim().toLowerCase()).filter(k => k);

    const exList = excludeKeywords
        ? excludeKeywords.split(',').map(k => k.trim().toLowerCase()).filter(k => k)
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

                    // Extract the first block of text before any whitespace or pipe separator
                    let cleanLine = line.trim().split(/[\s|]+/)[0];
                    if (!cleanLine.includes(':')) continue;

                    const parts = cleanLine.split(':');
                    if (parts.length < 2) continue;

                    totalLines++;

                    // Robust URL Detection
                    let urlPart = '';
                    let userPassPart = '';

                    // For format: http(s)://domain.com:user:pass or domain.com:user:pass
                    if (cleanLine.toLowerCase().startsWith('http')) {
                        // If it has http:// or https://, the URL part is everything up to the last 2 colons
                        // Example: https://www.roblox.com/:Shadowprincesslusi:bombon12#
                        // Parts: ["https", "//www.roblox.com/", "Shadowprincesslusi", "bombon12#"]
                        urlPart = parts.slice(0, parts.length - 2).join(':');
                        userPassPart = parts.slice(-2).join(':');
                    } else {
                        // Standard user:pass or domain:user:pass
                        if (parts.length === 2) {
                            urlPart = parts[0]; 
                            userPassPart = cleanLine; // no separate domain if only user:pass
                        } else {
                            urlPart = parts.slice(0, parts.length - 2).join(':');
                            userPassPart = parts.slice(-2).join(':');
                        }
                    }

                    const urlPartLower = urlPart.toLowerCase();

                    // Check exclusions first
                    const isExcluding = exList.some(ex => urlPartLower.includes(ex));
                    if (isExcluding) continue;

                    // Match each keyword
                    let matchedAny = false;
                    for (const kw of kwList) {
                        if (urlPartLower.includes(kw)) {
                            matchedAny = true;

                            let outputLine = stripUrl ? userPassPart : cleanLine;

                            // Dedup check (global)
                            if (dedup) {
                                if (seenSet.has(outputLine)) continue;
                                seenSet.add(outputLine);
                                if (seenSet.size > 5000000) seenSet.clear();
                            }

                            perKeywordBatch[kw].push(outputLine);
                            perKeywordCounts[kw]++;
                            filteredLines++;

                            // Domain Analytics
                            let domain = 'other';
                            try {
                                const domainMatch = urlPart.match(
                                    /(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]/
                                );
                                if (domainMatch) {
                                    const fullD = domainMatch[0];
                                    const dParts = fullD.split('.');
                                    domain = dParts.length > 2 ? dParts.slice(-2).join('.') : fullD;
                                }
                            } catch (e) {}
                            domainStats.set(domain, (domainStats.get(domain) || 0) + 1);

                            foundLinesBatch.push(outputLine);
                            break; // One keyword match is enough per line
                        }
                    }

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

            // Handle partial line for this file
            if (partialLine.trim()) {
                totalLines++;
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
