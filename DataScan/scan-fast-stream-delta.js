function createDeltaTracker(keywordKeys = []) {
    return {
        // Delta tracker no longer needs indices since we splice arrays to free memory!
        isActive: true
    };
}

function buildDeltaPayload(results, tracker) {
    // Splice arrays to completely clear them from server memory!
    // This prevents Out of Memory (OOM) freezing on huge files.
    const newGlobalLines = Array.isArray(results.lines) ? results.lines.splice(0, results.lines.length) : [];
    
    // We must also splice lineDomains so it doesn't stay behind and leak memory
    if (Array.isArray(results.lineDomains)) {
        results.lineDomains.splice(0, results.lineDomains.length);
    }

    const keywordResults = results.perKeyword && typeof results.perKeyword === 'object'
        ? results.perKeyword
        : {};

    const perKeywordDelta = {};

    for (const [kw, kwLinesRaw] of Object.entries(keywordResults)) {
        const kwLines = Array.isArray(kwLinesRaw) ? kwLinesRaw : [];
        const delta = kwLines.splice(0, kwLines.length);

        if (delta.length > 0) {
            perKeywordDelta[kw] = delta;
        }
    }

    return {
        results: newGlobalLines.join('\n'),
        perKeyword: perKeywordDelta
    };
}

function shouldEmitProgress({
    totalLines,
    lastEmittedLines,
    now,
    lastEmittedAt,
    minLineDelta = 10000,
    minIntervalMs = 250,
    force = false
} = {}) {
    const currentTotal = typeof totalLines === 'number' && Number.isFinite(totalLines) ? totalLines : 0;
    const previousTotal = typeof lastEmittedLines === 'number' && Number.isFinite(lastEmittedLines) ? lastEmittedLines : 0;
    const currentTime = typeof now === 'number' && Number.isFinite(now) ? now : 0;
    const previousTime = typeof lastEmittedAt === 'number' && Number.isFinite(lastEmittedAt) ? lastEmittedAt : 0;
    const safeMinLineDelta = typeof minLineDelta === 'number' && Number.isFinite(minLineDelta) ? minLineDelta : 0;
    const safeMinIntervalMs = typeof minIntervalMs === 'number' && Number.isFinite(minIntervalMs) ? minIntervalMs : 0;

    const linesDelta = currentTotal >= previousTotal
        ? currentTotal - previousTotal
        : currentTotal;

    if (linesDelta <= 0) {
        return false;
    }

    if (force) {
        return true;
    }

    const lineTrigger = safeMinLineDelta > 0 && linesDelta >= safeMinLineDelta;
    const elapsedMs = currentTime >= previousTime ? currentTime - previousTime : 0;
    const timeTrigger = safeMinIntervalMs > 0 && elapsedMs >= safeMinIntervalMs;

    return lineTrigger || timeTrigger;
}

module.exports = {
    createDeltaTracker,
    buildDeltaPayload,
    shouldEmitProgress
};
