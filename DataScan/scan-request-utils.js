const fs = require('fs');
const path = require('path');

class InvalidRequestError extends Error {}

function stripUrlFromKeyword(kw) {
    return kw
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/^\/\//, '')
        .replace(/\/+$/, '')
        .toLowerCase();
}

function normalizeStringList(value, { stripUrl = false } = {}) {
    const source = Array.isArray(value)
        ? value
        : typeof value === 'string'
            ? value.split(',')
            : [];

    return source.map(item => {
        if (typeof item !== 'string') {
            throw new InvalidRequestError('Keywords and excludes must be strings');
        }

        const trimmed = item.trim();
        if (!trimmed) return null;
        return stripUrl ? stripUrlFromKeyword(trimmed) : trimmed.toLowerCase();
    }).filter(Boolean);
}

function parseJsonArrayQueryParam(rawValue, label) {
    if (rawValue == null || rawValue === '') return [];

    let parsed;
    try {
        parsed = JSON.parse(rawValue);
    } catch {
        throw new InvalidRequestError(`Invalid ${label} query JSON`);
    }

    if (!Array.isArray(parsed)) {
        throw new InvalidRequestError(`${label[0].toUpperCase() + label.slice(1)} must be an array`);
    }

    return parsed;
}

function parseKeywordsQueryParam(rawKeywords) {
    return parseJsonArrayQueryParam(rawKeywords, 'keywords');
}

function parseFilenamesQueryParam(rawFilenames) {
    return parseJsonArrayQueryParam(rawFilenames, 'filenames');
}

function getUniqueUploadFilename(downloadDir, filename) {
    const safeFilename = ensureTxtBasename(filename);
    const parsed = path.parse(safeFilename);
    let candidate = safeFilename;
    let attempt = 1;
    let targetPath = resolveDownloadFilePath(downloadDir, candidate);

    while (fs.existsSync(targetPath)) {
        candidate = `${parsed.name} (${attempt})${parsed.ext}`;
        targetPath = resolveDownloadFilePath(downloadDir, candidate);
        attempt++;
    }

    return {
        filename: candidate,
        filepath: targetPath
    };
}

function normalizeBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        return value.toLowerCase() === 'true';
    }
    return false;
}

function ensureTxtBasename(filename) {
    if (typeof filename !== 'string' || !filename.trim()) {
        throw new InvalidRequestError('Filename is required');
    }

    const trimmed = filename.trim();
    if (trimmed !== path.basename(trimmed) || trimmed.includes('/') || trimmed.includes('\\')) {
        throw new InvalidRequestError('Invalid filename');
    }

    if (!trimmed.toLowerCase().endsWith('.txt')) {
        throw new InvalidRequestError('Only .txt files are allowed');
    }

    return trimmed;
}

function resolveDownloadFilePath(downloadDir, filename) {
    const safeFilename = ensureTxtBasename(filename);
    const resolvedDownloadDir = path.resolve(downloadDir);
    const resolvedFilePath = path.resolve(resolvedDownloadDir, safeFilename);

    if (!resolvedFilePath.startsWith(resolvedDownloadDir + path.sep)) {
        throw new InvalidRequestError('Invalid filename');
    }

    return resolvedFilePath;
}

function normalizeScanPayload(payload = {}) {
    const rawFilenames = Array.isArray(payload.filenames)
        ? payload.filenames
        : payload.filename != null
            ? [payload.filename]
            : [];

    const filenames = Array.from(new Set(rawFilenames.map(item => ensureTxtBasename(item))));
    if (filenames.length === 0) {
        throw new InvalidRequestError('At least one filename is required');
    }

    if (!Array.isArray(payload.keywords)) {
        throw new InvalidRequestError('Keywords must be an array');
    }

    const stripUrl = normalizeBoolean(payload.stripUrl);
    const dedup = normalizeBoolean(payload.dedup);
    const clientKeywords = payload.keywords.map(item => {
        if (typeof item !== 'string') {
            throw new InvalidRequestError('Keywords must be strings');
        }
        return item.trim();
    }).filter(Boolean);

    if (clientKeywords.length === 0) {
        throw new InvalidRequestError('At least one keyword is required');
    }

    const normalizedKeywords = normalizeStringList(clientKeywords, { stripUrl });
    if (normalizedKeywords.length === 0) {
        throw new InvalidRequestError('At least one valid keyword is required');
    }

    const excludeList = normalizeStringList(payload.excludeKeywords || '', { stripUrl });

    return {
        filename: filenames[0],
        filenames,
        clientKeywords,
        normalizedKeywords: Array.from(new Set(normalizedKeywords)),
        excludeList,
        excludeKeywords: excludeList.join(','),
        stripUrl,
        dedup
    };
}

module.exports = {
    InvalidRequestError,
    stripUrlFromKeyword,
    parseKeywordsQueryParam,
    parseFilenamesQueryParam,
    resolveDownloadFilePath,
    getUniqueUploadFilename,
    normalizeScanPayload
};
