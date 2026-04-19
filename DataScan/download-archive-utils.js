const fs = require('node:fs');
const path = require('node:path');
const unzipper = require('unzipper');
const { createExtractorFromData } = require('node-unrar-js');
const {
    ensureDownloadBasename,
    getUniqueDownloadFilename
} = require('./scan-request-utils');

class ArchiveExtractionError extends Error {}

function detectDownloadedArchiveType(filename) {
    const lower = String(filename || '').toLowerCase();
    if (lower.endsWith('.zip')) return 'zip';
    if (lower.endsWith('.rar')) return 'rar';
    return null;
}

function buildExtractionResult(archiveType, createdFiles) {
    return {
        archiveType,
        extractedCount: createdFiles.length,
        files: createdFiles.map(file => ({
            name: file.filename,
            size: fs.statSync(file.filepath).size,
            modified: fs.statSync(file.filepath).mtime,
            path: file.filepath
        }))
    };
}

function cleanupCreatedFiles(createdFiles) {
    for (const file of createdFiles) {
        if (fs.existsSync(file.filepath)) {
            fs.unlinkSync(file.filepath);
        }
    }
}

function cleanupArchiveFile(archivePath) {
    if (fs.existsSync(archivePath)) {
        fs.unlinkSync(archivePath);
    }
}

function finalizeExtraction({ archivePath, archiveType, createdFiles }) {
    cleanupArchiveFile(archivePath);

    if (createdFiles.length === 0) {
        throw new ArchiveExtractionError('Archive does not contain any .txt files');
    }

    return buildExtractionResult(archiveType, createdFiles);
}

function normalizeArchiveError(err, fallbackMessage) {
    if (err instanceof ArchiveExtractionError) {
        return err;
    }

    const message = err?.message ? `${fallbackMessage}: ${err.message}` : fallbackMessage;
    return new ArchiveExtractionError(message);
}

async function extractZipArchive({ archivePath, downloadDir }) {
    const directory = await unzipper.Open.file(archivePath);
    const createdFiles = [];

    try {
        for (const entry of directory.files) {
            if (entry.type !== 'File') continue;
            const parsed = path.parse(entry.path);
            if (parsed.ext.toLowerCase() !== '.txt') continue;

            const safeName = ensureDownloadBasename(parsed.base);
            const target = getUniqueDownloadFilename(downloadDir, safeName);
            const content = await entry.buffer();
            fs.writeFileSync(target.filepath, content);
            createdFiles.push(target);
        }

        return finalizeExtraction({ archivePath, archiveType: 'zip', createdFiles });
    } catch (err) {
        cleanupCreatedFiles(createdFiles);
        cleanupArchiveFile(archivePath);
        throw normalizeArchiveError(err, 'Failed to extract zip archive');
    }
}

async function extractRarArchive({ archivePath, downloadDir }) {
    const createdFiles = [];

    try {
        const data = Uint8Array.from(fs.readFileSync(archivePath)).buffer;
        const extractor = await createExtractorFromData({ data });
        const extracted = extractor.extract({
            files: (fileHeader) => !fileHeader.flags.directory && path.extname(fileHeader.name).toLowerCase() === '.txt'
        });

        for (const file of extracted.files) {
            if (!file.extraction) {
                continue;
            }

            const safeName = ensureDownloadBasename(path.basename(file.fileHeader.name));
            const target = getUniqueDownloadFilename(downloadDir, safeName);
            fs.writeFileSync(target.filepath, Buffer.from(file.extraction));
            createdFiles.push(target);
        }

        return finalizeExtraction({ archivePath, archiveType: 'rar', createdFiles });
    } catch (err) {
        cleanupCreatedFiles(createdFiles);
        cleanupArchiveFile(archivePath);
        throw normalizeArchiveError(err, 'Failed to extract rar archive');
    }
}

async function extractDownloadedArchive({ archivePath, archiveType, downloadDir }) {
    if (archiveType === 'zip') {
        return extractZipArchive({ archivePath, downloadDir });
    }

    if (archiveType === 'rar') {
        return extractRarArchive({ archivePath, downloadDir });
    }

    throw new ArchiveExtractionError(`Unsupported archive type: ${archiveType}`);
}

module.exports = {
    ArchiveExtractionError,
    detectDownloadedArchiveType,
    extractDownloadedArchive
};
