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
    if (lines.length > 0) {
        state.lines.push(...lines);
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
    finalizeAggregatedTotals,
    toTopDomains
};
