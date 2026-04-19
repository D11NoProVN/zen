const fs = require('node:fs');
const path = require('node:path');
const unzipper = require('unzipper');
const { createExtractorFromFile } = require('node-unrar-js');
const {
    ensureDownloadBasename,
    getUniqueDownloadFilename
} = require('./scan-request-utils');

const { pipeline } = require('node:stream/promises');

class ArchiveExtractionError extends Error {}

class ArchivePasswordRequiredError extends ArchiveExtractionError {
    constructor(message = 'Mật khẩu giải nén không đúng hoặc chưa được cung cấp') {
        super(message);
        this.name = 'ArchivePasswordRequiredError';
    }
}

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
        files: createdFiles.map(f => ({
            name: path.basename(f.filepath),
            path: f.filepath,
            size: fs.statSync(f.filepath).size
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

    const message = err?.message || '';
    if (err?.reason === 'ERAR_MISSING_PASSWORD' || err?.reason === 'ERAR_BAD_PASSWORD' || message.includes('MISSING_PASSWORD') || message.includes('BAD_PASSWORD') || message.includes('Password') || message.includes('password')) {
        return new ArchivePasswordRequiredError();
    }

    return new ArchiveExtractionError(message ? `${fallbackMessage}: ${message}` : fallbackMessage);
}

async function extractZipArchive({ archivePath, downloadDir, password }) {
    const directory = await unzipper.Open.file(archivePath);
    const createdFiles = [];

    try {
        for (const entry of directory.files) {
            if (entry.type !== 'File') continue;
            const parsed = path.parse(entry.path);
            if (parsed.ext.toLowerCase() !== '.txt') continue;

            const safeName = ensureDownloadBasename(parsed.base);
            const target = getUniqueDownloadFilename(downloadDir, safeName);
            const writer = fs.createWriteStream(target.filepath);
            const stream = entry.stream(password);
            await pipeline(stream, writer);
            createdFiles.push(target);
        }

        return finalizeExtraction({ archivePath, archiveType: 'zip', createdFiles });
    } catch (err) {
        cleanupCreatedFiles(createdFiles);
        const normalizedErr = normalizeArchiveError(err, 'Failed to extract zip archive');
        if (!(normalizedErr instanceof ArchivePasswordRequiredError)) {
            cleanupArchiveFile(archivePath);
        }
        throw normalizedErr;
    }
}

async function extractRarArchive({ archivePath, downloadDir, password }) {
    const createdFiles = [];

    try {
        const extractor = await createExtractorFromFile({
            filepath: archivePath,
            targetPath: downloadDir,
            password: password || '',
            filenameTransform: (originalFilename) => {
                const safeName = ensureDownloadBasename(path.basename(originalFilename));
                const target = getUniqueDownloadFilename(downloadDir, safeName);
                createdFiles.push(target);
                return path.basename(target.filepath);
            }
        });

        const extracted = extractor.extract({
            files: (fileHeader) => !fileHeader.flags.directory && path.extname(fileHeader.name).toLowerCase() === '.txt'
        });

        // Iterate over the generator to trigger extraction
        for (const _ of extracted.files) {
            // Extraction happens directly to disk via targetPath
        }

        return finalizeExtraction({ archivePath, archiveType: 'rar', createdFiles });
    } catch (err) {
        cleanupCreatedFiles(createdFiles);
        const normalizedErr = normalizeArchiveError(err, 'Failed to extract rar archive');
        if (!(normalizedErr instanceof ArchivePasswordRequiredError)) {
            cleanupArchiveFile(archivePath);
        }
        throw normalizedErr;
    }
}

async function extractDownloadedArchive({ archivePath, archiveType, downloadDir, password }) {
    if (archiveType === 'zip') {
        return extractZipArchive({ archivePath, downloadDir, password });
    }

    if (archiveType === 'rar') {
        return extractRarArchive({ archivePath, downloadDir, password });
    }

    throw new ArchiveExtractionError(`Unsupported archive type: ${archiveType}`);
}

module.exports = {
    ArchiveExtractionError,
    ArchivePasswordRequiredError,
    detectDownloadedArchiveType,
    extractDownloadedArchive
};
