function createAggregationState(keywordKeys = [], dedup = false) {
    const perKeyword = {};
    const perKeywordCounts = {};

    for (const kw of keywordKeys) {
        perKeyword[kw] = [];
        perKeywordCounts[kw] = 0;
    }

    return {
        total: 0,
        filtered: 0,
        dedup,
        lines: [],
        lineDomains: [],
        perKeyword,
        perKeywordCounts,
        domainCount: new Map(),
        workerSnapshots: new Map(),
        globalSeen: dedup ? new Set() : null,
        perKeywordSeen: dedup ? {} : null
    };
}

function getWorkerSnapshot(state, workerId) {
    if (!state.workerSnapshots.has(workerId)) {
        state.workerSnapshots.set(workerId, {
            total: 0,
            filtered: 0,
            domainCount: {}
        });
    }

    return state.workerSnapshots.get(workerId);
}

function cumulativeDelta(currentValue, previousValue) {
    if (typeof currentValue !== 'number') return 0;
    if (typeof previousValue !== 'number') return currentValue;

    if (currentValue >= previousValue) {
        return currentValue - previousValue;
    }

    // If the counter unexpectedly resets, treat as a fresh baseline.
    return currentValue;
}

function applyWorkerProgress(state, workerId, msg) {
    const snapshot = getWorkerSnapshot(state, workerId);

    const totalDelta = cumulativeDelta(msg.total, snapshot.total);
    // When dedup is enabled, we don't use the worker's filtered count directly because
    // workers only dedup locally. We'll derive the global filtered count from unique lines.
    if (!state.dedup) {
        const filteredDelta = cumulativeDelta(msg.filtered, snapshot.filtered);
        state.filtered += filteredDelta;
    }

    state.total += totalDelta;

    snapshot.total = typeof msg.total === 'number' ? msg.total : snapshot.total;
    snapshot.filtered = typeof msg.filtered === 'number' ? msg.filtered : snapshot.filtered;

    const lines = Array.isArray(msg.lines) ? msg.lines : [];
    const lineDomains = Array.isArray(msg.lineDomains) ? msg.lineDomains : [];
    
    if (lines.length > 0) {
        if (state.dedup && state.globalSeen) {
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!state.globalSeen.has(line)) {
                    state.globalSeen.add(line);
                    state.lines.push(line);
                    
                    const lineDomain = lineDomains[i] || null;
                    state.lineDomains.push(lineDomain);
                    if (lineDomain) {
                        const lcDomain = typeof lineDomain === 'string' ? lineDomain.toLowerCase() : null;
                        if (lcDomain) {
                            state.domainCount.set(lcDomain, (state.domainCount.get(lcDomain) || 0) + 1);
                        }
                    }
                    
                    state.filtered++; // Increment global filtered count for each unique line
                }
            }
        } else {
            state.lines.push(...lines);
            if (lineDomains.length === lines.length) {
                state.lineDomains.push(...lineDomains);
            } else {
                state.lineDomains.push(...new Array(lines.length).fill(null));
            }
        }
    }

    const perKeyword = msg.perKeyword && typeof msg.perKeyword === 'object' ? msg.perKeyword : {};
    for (const [kw, kwLinesRaw] of Object.entries(perKeyword)) {
        const kwLines = Array.isArray(kwLinesRaw) ? kwLinesRaw : [];

        if (!state.perKeyword[kw]) {
            state.perKeyword[kw] = [];
            state.perKeywordCounts[kw] = 0;
            if (state.dedup) {
                state.perKeywordSeen[kw] = new Set();
            }
        }

        if (kwLines.length > 0) {
            if (state.dedup && state.perKeywordSeen[kw]) {
                for (const line of kwLines) {
                    if (!state.perKeywordSeen[kw].has(line)) {
                        state.perKeywordSeen[kw].add(line);
                        state.perKeyword[kw].push(line);
                        state.perKeywordCounts[kw]++;
                    }
                }
            } else {
                state.perKeyword[kw].push(...kwLines);
                state.perKeywordCounts[kw] += kwLines.length;
            }
        }
    }

    const domainSnapshot = msg.domainCount && typeof msg.domainCount === 'object' ? msg.domainCount : {};

    if (!state.dedup) {
        for (const [domain, countRaw] of Object.entries(domainSnapshot)) {
            const currentCount = typeof countRaw === 'number' ? countRaw : 0;
            const previousCount = snapshot.domainCount[domain] || 0;
            const delta = cumulativeDelta(currentCount, previousCount);

            if (delta > 0) {
                state.domainCount.set(domain, (state.domainCount.get(domain) || 0) + delta);
            }
        }
    }

    snapshot.domainCount = { ...domainSnapshot };
}

function extractDomain(line) {
    if (typeof line !== 'string') return null;

    const match = line.match(/(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})/i);
    return match ? match[1].toLowerCase() : null;
}

function rebuildDomainCountFromLines(lines) {
    const rebuiltDomainCount = new Map();
    const safeLines = Array.isArray(lines) ? lines : [];

    for (const line of safeLines) {
        const domain = extractDomain(line);
        if (domain) {
            rebuiltDomainCount.set(domain, (rebuiltDomainCount.get(domain) || 0) + 1);
        }
    }

    return rebuiltDomainCount;
}

function rebuildDomainCountFromLineDomains(lineDomains) {
    const rebuiltDomainCount = new Map();
    const safeLineDomains = Array.isArray(lineDomains) ? lineDomains : [];

    for (const domainRaw of safeLineDomains) {
        const domain = typeof domainRaw === 'string' ? domainRaw.toLowerCase() : null;
        if (domain) {
            rebuiltDomainCount.set(domain, (rebuiltDomainCount.get(domain) || 0) + 1);
        }
    }

    return rebuiltDomainCount;
}

function dedupeAggregatedResults(state, keywordKeys = []) {
    const seen = new Set();
    const dedupedLines = [];
    const dedupedLineDomains = [];

    for (let i = 0; i < state.lines.length; i++) {
        const line = state.lines[i];
        if (seen.has(line)) continue;
        seen.add(line);
        dedupedLines.push(line);
        dedupedLineDomains.push(state.lineDomains[i] || null);
    }

    state.lines = dedupedLines;
    state.lineDomains = dedupedLineDomains;

    for (const kw of keywordKeys) {
        const kwSeen = new Set();
        state.perKeyword[kw] = (state.perKeyword[kw] || []).filter(line => {
            if (kwSeen.has(line)) return false;
            kwSeen.add(line);
            return true;
        });
    }
}

function stripUrlFromKeyword(kw) {
    return kw
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/^\/\//, '')
        .replace(/\/+$/, '')
        .toLowerCase();
}

function mapKeywordPayloadToClientKeywords(payload, clientKeywords, stripUrl) {
    if (!stripUrl) {
        return {
            perKeyword: payload.perKeyword || {},
            perKeywordCounts: payload.perKeywordCounts || {}
        };
    }

    const remappedKeywordResults = {};
    const remappedKeywordCounts = {};
    const safePerKeyword = payload.perKeyword && typeof payload.perKeyword === 'object' ? payload.perKeyword : {};
    const safePerKeywordCounts = payload.perKeywordCounts && typeof payload.perKeywordCounts === 'object' ? payload.perKeywordCounts : {};
    const safeClientKeywords = Array.isArray(clientKeywords) ? clientKeywords : [];

    for (const clientKeyword of safeClientKeywords) {
        const normalizedKeyword = stripUrlFromKeyword(clientKeyword);
        remappedKeywordResults[clientKeyword] = safePerKeyword[normalizedKeyword] || [];
        remappedKeywordCounts[clientKeyword] = safePerKeywordCounts[normalizedKeyword] || 0;
    }

    return {
        perKeyword: remappedKeywordResults,
        perKeywordCounts: remappedKeywordCounts
    };
}

function finalizeAggregatedTotals(state) {
    // Array lengths are 0 because arrays are consumed by buildDeltaPayload dynamically.
    // The state.filtered and state.perKeywordCounts are already incremented correctly during applyWorkerProgress.
}

function toTopDomains(state, limit = 10) {
    return Array.from(state.domainCount.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);
}

module.exports = {
    createAggregationState,
    applyWorkerProgress,
    dedupeAggregatedResults,
    mapKeywordPayloadToClientKeywords,
    rebuildDomainCountFromLineDomains,
    rebuildDomainCountFromLines,
    finalizeAggregatedTotals,
    toTopDomains
};
