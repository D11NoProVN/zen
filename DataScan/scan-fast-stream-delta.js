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

module.exports = {
    createDeltaTracker,
    buildDeltaPayload
};
