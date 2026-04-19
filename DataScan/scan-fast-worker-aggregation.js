function createAggregationState(keywordKeys = []) {
    const perKeyword = {};
    const perKeywordCounts = {};

    for (const kw of keywordKeys) {
        perKeyword[kw] = [];
        perKeywordCounts[kw] = 0;
    }

    return {
        total: 0,
        filtered: 0,
        lines: [],
        lineDomains: [],
        perKeyword,
        perKeywordCounts,
        domainCount: new Map(),
        workerSnapshots: new Map()
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
    const filteredDelta = cumulativeDelta(msg.filtered, snapshot.filtered);

    state.total += totalDelta;
    state.filtered += filteredDelta;

    snapshot.total = typeof msg.total === 'number' ? msg.total : snapshot.total;
    snapshot.filtered = typeof msg.filtered === 'number' ? msg.filtered : snapshot.filtered;

    const lines = Array.isArray(msg.lines) ? msg.lines : [];
    const lineDomains = Array.isArray(msg.lineDomains) ? msg.lineDomains : [];
    if (lines.length > 0) {
        state.lines.push(...lines);

        if (lineDomains.length === lines.length) {
            state.lineDomains.push(...lineDomains);
        } else {
            state.lineDomains.push(...new Array(lines.length).fill(null));
        }
    }

    const perKeyword = msg.perKeyword && typeof msg.perKeyword === 'object' ? msg.perKeyword : {};
    for (const [kw, kwLinesRaw] of Object.entries(perKeyword)) {
        const kwLines = Array.isArray(kwLinesRaw) ? kwLinesRaw : [];

        if (!state.perKeyword[kw]) {
            state.perKeyword[kw] = [];
            state.perKeywordCounts[kw] = 0;
        }

        if (kwLines.length > 0) {
            state.perKeyword[kw].push(...kwLines);
            state.perKeywordCounts[kw] += kwLines.length;
        }
    }

    const domainSnapshot = msg.domainCount && typeof msg.domainCount === 'object' ? msg.domainCount : {};

    for (const [domain, countRaw] of Object.entries(domainSnapshot)) {
        const currentCount = typeof countRaw === 'number' ? countRaw : 0;
        const previousCount = snapshot.domainCount[domain] || 0;
        const delta = cumulativeDelta(currentCount, previousCount);

        if (delta > 0) {
            state.domainCount.set(domain, (state.domainCount.get(domain) || 0) + delta);
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
    state.filtered = state.lines.length;

    for (const [kw, lines] of Object.entries(state.perKeyword)) {
        state.perKeywordCounts[kw] = Array.isArray(lines) ? lines.length : 0;
    }
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
