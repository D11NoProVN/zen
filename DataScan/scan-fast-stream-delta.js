function createDeltaTracker(keywordKeys = []) {
    const perKeywordIndex = {};

    for (const key of keywordKeys) {
        perKeywordIndex[key] = 0;
    }

    return {
        globalIndex: 0,
        perKeywordIndex
    };
}

function buildDeltaPayload(results, tracker) {
    const lines = Array.isArray(results.lines) ? results.lines : [];
    const keywordResults = results.perKeyword && typeof results.perKeyword === 'object'
        ? results.perKeyword
        : {};

    if (tracker.globalIndex > lines.length) {
        tracker.globalIndex = lines.length;
    }

    const newGlobalLines = lines.slice(tracker.globalIndex);
    tracker.globalIndex = lines.length;

    const perKeywordDelta = {};

    for (const [kw, kwLinesRaw] of Object.entries(keywordResults)) {
        const kwLines = Array.isArray(kwLinesRaw) ? kwLinesRaw : [];
        const previousIndex = tracker.perKeywordIndex[kw] || 0;
        const safeIndex = previousIndex > kwLines.length ? kwLines.length : previousIndex;

        const delta = kwLines.slice(safeIndex);
        tracker.perKeywordIndex[kw] = kwLines.length;

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
