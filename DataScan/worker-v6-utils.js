function stripUrlFromKeyword(kw) {
    return kw
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/^\/\//, '')
        .replace(/\/+$/, '')
        .toLowerCase();
}

function parseStripUrlLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;

    const noProtocol = trimmed
        .replace(/^https?:\/\//i, '')
        .replace(/^\/\//, '');

    const firstSlash = noProtocol.indexOf('/');
    const firstColon = noProtocol.indexOf(':');

    if (firstSlash !== -1 && (firstColon === -1 || firstSlash < firstColon)) {
        const pathColon = noProtocol.indexOf(':', firstSlash + 1);
        if (pathColon !== -1) {
            const userPass = noProtocol.slice(pathColon + 1);
            if (!userPass.includes(':')) return null;

            return {
                urlPartLower: noProtocol.slice(0, pathColon).replace(/\/+$/, ''),
                credentialsLower: userPass,
                credentialsOriginal: trimmed.slice(trimmed.length - userPass.length)
            };
        }
    }

    const parts = noProtocol.split(':');
    if (parts.length < 3) return null;

    let credentialsStart = parts.length - 2;
    if (parts.length >= 4 && /^\d+$/.test(parts[1])) {
        credentialsStart = 2;
    }

    const userPassParts = parts.slice(credentialsStart);
    if (userPassParts.length < 2) return null;

    return {
        urlPartLower: parts.slice(0, credentialsStart).join(':').replace(/\/+$/, ''),
        credentialsLower: userPassParts.join(':'),
        credentialsOriginal: trimmed.split(':').slice(credentialsStart).join(':')
    };
}

function extractDomain(line) {
    const match = line.match(/(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})/i);
    return match ? match[1].toLowerCase() : null;
}

function parseKeywordsForLegacyWorker(rawText, stripUrl) {
    return rawText
        .split('\n')
        .map(k => k.trim())
        .filter(Boolean)
        .map(k => stripUrl ? stripUrlFromKeyword(k) : k.toLowerCase());
}

function processLegacyScanLine({ line, keywords, excludeKeywords, stripUrl, dedup, seenSet }) {
    const rawLine = typeof line === 'string' ? line.trim() : '';
    if (!rawLine) return null;

    const safeKeywords = Array.isArray(keywords) ? keywords : [];
    const safeExcludeKeywords = Array.isArray(excludeKeywords) ? excludeKeywords : [];

    if (stripUrl) {
        const parsed = parseStripUrlLine(rawLine.toLowerCase());
        if (!parsed) return null;

        const { urlPartLower, credentialsLower } = parsed;
        if (safeExcludeKeywords.some(ex => urlPartLower.includes(ex) || credentialsLower.includes(ex))) {
            return null;
        }

        const matchedKeyword = safeKeywords.find(kw => urlPartLower.includes(kw) || credentialsLower.includes(kw));
        if (!matchedKeyword) return null;

        const outputLine = parsed.credentialsOriginal;
        if (dedup) {
            if (seenSet.has(outputLine)) return null;
            seenSet.add(outputLine);
        }

        return {
            matchedKeyword,
            outputLine,
            domain: extractDomain(rawLine)
        };
    }

    const lineLower = rawLine.toLowerCase();
    if (safeExcludeKeywords.some(ex => lineLower.includes(ex))) {
        return null;
    }

    const matchedKeyword = safeKeywords.find(kw => lineLower.includes(kw));
    if (!matchedKeyword) return null;

    const outputLine = rawLine;
    if (dedup) {
        if (seenSet.has(outputLine)) return null;
        seenSet.add(outputLine);
    }

    return {
        matchedKeyword,
        outputLine,
        domain: extractDomain(rawLine)
    };
}

module.exports = {
    stripUrlFromKeyword,
    parseStripUrlLine,
    extractDomain,
    parseKeywordsForLegacyWorker,
    processLegacyScanLine
};
