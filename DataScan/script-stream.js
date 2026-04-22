// ZenScan v1.0 — Stream Engine (Optimized for Large Files)
document.addEventListener('DOMContentLoaded', () => {
    // ─── DOM Elements ───
    const $ = id => document.getElementById(id);
    const el = {
        selectFileBtn:  $('selectFileBtn'),
        selectedFileInfo: $('selectedFileInfo'),
        selectedFileName: $('selectedFileName'),
        selectedFileSize: $('selectedFileSize'),
        keyword:        $('keyword'),
        excludeKeyword: $('excludeKeyword'),
        stripUrl:       $('stripUrl'),
        dedupToggle:    $('dedupToggle'),
        processBtn:     $('processBtn'),
        stopBtn:        $('stopBtn'),
        clearBtn:       $('clearBtn'),
        downloadBtn:    $('downloadBtn'),
        splitDownloadBtn: $('splitDownloadBtn'),
        copyBtn:        $('copyBtn'),
        totalLines:     $('totalLines'),
        filteredLines:  $('filteredLines'),
        scanSpeed:      $('scanSpeed'),
        dataVolume:     $('dataVolume'),
        consoleOutput:  $('consoleOutput'),
        consoleSearch:  $('consoleSearch'),
        clearConsoleBtn:$('clearConsoleBtn'),
        domainAnalytics:$('domainAnalytics'),
        keywordTags:    $('keywordTags'),
        sessionHistory: $('sessionHistory'),
        statusDot:      $('statusDot'),
        statusText:     $('statusText'),
        progressBar:    $('progressBar'),
        savedBadge:     $('savedBadge'),
        toastContainer: $('toastContainer'),
    };

    // ─── State ───
    let state = {
        selectedFiles: [],
        selectedTotalSize: 0,
        eventSource: null,
        totalCount: 0,
        foundCount: 0,
        lastTotal: 0,
        startTime: 0,
        blobChunks: [],
        perKeywordChunks: {},
        perKeywordCounts: {},
        isProcessing: false,
        speedTimer: null,
        currentScanId: null,
    };

    // ─── Keyword Persistence ───
    const STORAGE_KEY = 'zenscan_keywords';
    const SESSION_KEY = 'zenscan_sessions';
    const ACTIVE_SCAN_KEY = 'zenscan_active_id';

    function loadKeywords() {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            el.keyword.value = saved;
            flashSavedBadge();
        }
    }

    function saveKeywords() {
        const val = el.keyword.value.trim();
        if (val) {
            localStorage.setItem(STORAGE_KEY, val);
            flashSavedBadge();
        }
    }

    function flashSavedBadge() {
        el.savedBadge.classList.add('visible');
        setTimeout(() => el.savedBadge.classList.remove('visible'), 2000);
    }

    let saveDebounce;
    el.keyword.addEventListener('input', () => {
        clearTimeout(saveDebounce);
        saveDebounce = setTimeout(saveKeywords, 800);
    });

    loadKeywords();

    // ─── Parse Keywords ───
    function parseKeywords() {
        return el.keyword.value
            .split('\n')
            .map(k => k.trim())
            .filter(k => k.length > 0);
    }

    // ─── File Selection ───
    el.selectFileBtn.addEventListener('click', async () => {
        try {
            const res = await fetch('/api/files');
            const data = await res.json();

            if (!data.success) {
                notify('Lỗi tải danh sách: ' + data.error, 'error');
                return;
            }

            if (data.files.length === 0) {
                notify('Chưa có file nào trong Downloads!', 'error');
                return;
            }

            showFileSelectionModal(data.files);
        } catch (err) {
            notify('Lỗi kết nối server: ' + err.message, 'error');
        }
    });

    function updateSelectedFilesSummary() {
        if (!state.selectedFiles.length) {
            el.selectedFileInfo.style.display = 'none';
            el.dataVolume.textContent = '0 MB';
            el.processBtn.disabled = true;
            return;
        }

        const totalSize = state.selectedFiles.reduce((sum, file) => sum + (file.size || 0), 0);
        state.selectedTotalSize = totalSize;
        const label = state.selectedFiles.length === 1
            ? state.selectedFiles[0].name
            : `${state.selectedFiles.length} files đã chọn`;
        const sizeLabel = state.selectedFiles.length === 1
            ? formatBytes(totalSize)
            : `${formatBytes(totalSize)} • ${state.selectedFiles.slice(0, 2).map(file => file.name).join(', ')}${state.selectedFiles.length > 2 ? ` +${state.selectedFiles.length - 2}` : ''}`;

        el.selectedFileName.textContent = label;
        el.selectedFileSize.textContent = sizeLabel;
        el.selectedFileInfo.style.display = 'block';
        el.dataVolume.textContent = formatBytes(totalSize);
        el.processBtn.disabled = false;
    }

    // ─── Process Stream ───
    async function startProcess() {
        const keywords = parseKeywords();
        const excludeKeywords = el.excludeKeyword.value.trim();
        const stripUrl = el.stripUrl.checked;
        const dedup = el.dedupToggle.checked;

        if (state.selectedFiles.length === 0 || state.isProcessing) return;
        if (keywords.length === 0) return notify('Chưa nhập keyword!', 'error');

        saveKeywords();

        // Step 1: Initialize scan on server
        const params = new URLSearchParams({
            filenames: JSON.stringify(state.selectedFiles.map(file => file.name)),
            keywords: JSON.stringify(keywords),
            excludeKeywords,
            stripUrl,
            dedup
        });

        try {
            const res = await fetch(`/api/scan-fast?${params}`);
            const data = await res.json();
            if (!data.success) throw new Error(data.error);
            
            state.currentScanId = data.scanId;
            localStorage.setItem(ACTIVE_SCAN_KEY, data.scanId);
            
            attachToScan(data.scanId, keywords);
        } catch (err) {
            notify('Khởi tạo thất bại: ' + err.message, 'error');
        }
    }

    function attachToScan(scanId, keywords) {
        // Reset local state for the new stream
        state.isProcessing = true;
        state.totalCount = 0;
        state.foundCount = 0;
        state.lastTotal = 0;
        state.blobChunks = [];
        state.perKeywordChunks = {};
        state.perKeywordCounts = {};
        state.startTime = Date.now();

        keywords.forEach(kw => {
            state.perKeywordChunks[kw] = [];
            state.perKeywordCounts[kw] = 0;
        });

        el.totalLines.innerText = '0';
        el.filteredLines.innerText = '0';
        el.scanSpeed.innerText = '0';
        el.progressBar.style.width = '0%';
        el.consoleOutput.innerHTML = `<div class="log-line">─── Re-attaching to Scan: ${scanId} ───</div>`;
        renderKeywordTags(keywords);

        el.statusDot.classList.add('active');
        el.statusText.innerText = 'SCANNING...';
        el.processBtn.classList.add('hidden');
        el.stopBtn.classList.remove('hidden');

        state.speedTimer = setInterval(() => {
            const delta = state.totalCount - state.lastTotal;
            el.scanSpeed.innerText = delta.toLocaleString();
            state.lastTotal = state.totalCount;
        }, 1000);

        state.eventSource = new EventSource(`/api/scan-status/${scanId}`);

        state.eventSource.onmessage = (event) => {
            const data = JSON.parse(event.data);

            if (data.type === 'progress' || data.type === 'complete') {
                state.totalCount = data.total;
                state.foundCount = data.filtered;

                el.totalLines.innerText = state.totalCount.toLocaleString();
                el.filteredLines.innerText = state.foundCount.toLocaleString();

                // Simple progress estimation for UI
                el.progressBar.style.width = `${Math.min(99.9, (data.processedFiles / Math.max(1, data.processedFiles)) * 100)}%`;

                if (data.results && data.results.length > 0) {
                    state.blobChunks.push(new Blob([data.results + '\n'], { type: 'text/plain' }));
                }

                if (data.perKeyword) {
                    for (const [kw, lines] of Object.entries(data.perKeyword)) {
                        if (lines.length > 0) {
                            if (!state.perKeywordChunks[kw]) state.perKeywordChunks[kw] = [];
                            state.perKeywordChunks[kw].push(new Blob([lines.join('\n') + '\n'], { type: 'text/plain' }));
                        }
                    }
                }

                if (data.perKeywordCounts) {
                    for (const [kw, count] of Object.entries(data.perKeywordCounts)) {
                        state.perKeywordCounts[kw] = count;
                    }
                    updateKeywordTagCounts();
                }

                if (data.preview && data.preview.length > 0) {
                    renderPreview(data.preview);
                }

                if (data.topDomains) {
                    renderAnalytics(data.topDomains);
                }

                if (data.type === 'complete') {
                    endProcess(true);
                }
            }
        };

        state.eventSource.onerror = () => {
            notify('Mất kết nối với server, đang thử lại...', 'info');
        };
    }

    // Check for active session on boot
    async function checkActiveSession() {
        const savedId = localStorage.getItem(ACTIVE_SCAN_KEY);
        if (!savedId) return;

        try {
            const res = await fetch('/api/scan-active');
            const data = await res.json();
            if (data.success && data.active.some(s => s.id === savedId)) {
                notify('Đang khôi phục phiên scan cũ...', 'success');
                state.currentScanId = savedId;
                // We need keywords to render tags correctly
                const keywords = parseKeywords();
                attachToScan(savedId, keywords);
            } else {
                localStorage.removeItem(ACTIVE_SCAN_KEY);
            }
        } catch (err) {}
    }
    checkActiveSession();

    // ─── Preview ───
    function renderPreview(lines) {
        const frag = document.createDocumentFragment();
        const searchTerm = el.consoleSearch.value.toLowerCase();
        lines.forEach(line => {
            if (searchTerm && !line.toLowerCase().includes(searchTerm)) return;
            const d = document.createElement('div');
            d.className = 'log-line';
            d.textContent = line;
            frag.appendChild(d);
        });
        el.consoleOutput.appendChild(frag);
        el.consoleOutput.scrollTop = el.consoleOutput.scrollHeight;
        while (el.consoleOutput.childNodes.length > 300) {
            el.consoleOutput.removeChild(el.consoleOutput.firstChild);
        }
    }

    el.consoleSearch.addEventListener('input', () => {
        const term = el.consoleSearch.value.toLowerCase();
        const lines = el.consoleOutput.querySelectorAll('.log-line:not(.empty)');
        lines.forEach(line => {
            line.style.display = (!term || line.textContent.toLowerCase().includes(term)) ? '' : 'none';
        });
    });

    el.clearConsoleBtn.addEventListener('click', () => {
        el.consoleOutput.innerHTML = '<div class="log-line empty">Console cleared</div>';
    });

    // ─── Analytics ───
    function renderAnalytics(domains) {
        el.domainAnalytics.innerHTML = '';
        if (!domains || domains.length === 0) {
            el.domainAnalytics.innerHTML = '<div class="analytics-empty">Chưa có dữ liệu</div>';
            return;
        }
        domains.forEach(([name, count]) => {
            const row = document.createElement('div');
            row.className = 'analytics-row';
            row.innerHTML = `<span class="an-name">${escapeHtml(name)}</span><span class="an-count">${count.toLocaleString()}</span>`;
            el.domainAnalytics.appendChild(row);
        });
    }

    // ─── Keyword Tags ───
    function renderKeywordTags(keywords) {
        el.keywordTags.innerHTML = '';
        if (keywords.length === 0) {
            el.keywordTags.innerHTML = '<div class="analytics-empty">Chưa có keyword nào</div>';
            return;
        }
        keywords.forEach(kw => {
            const tag = document.createElement('span');
            tag.className = 'kw-tag';
            tag.dataset.kw = kw;
            tag.innerHTML = `${escapeHtml(kw)} <span class="kw-count" data-kw-count="${kw}">0</span>`;
            tag.title = `Click to download results for "${kw}"`;
            tag.addEventListener('click', () => downloadPerKeyword(kw));
            el.keywordTags.appendChild(tag);
        });
    }

    function updateKeywordTagCounts() {
        for (const [kw, count] of Object.entries(state.perKeywordCounts)) {
            const badge = el.keywordTags.querySelector(`[data-kw-count="${CSS.escape(kw)}"]`);
            if (badge) badge.textContent = count.toLocaleString();
        }
    }

    // ─── End Process ───
    function endProcess(done) {
        state.isProcessing = false;
        clearInterval(state.speedTimer);
        if (state.eventSource) {
            state.eventSource.close();
            state.eventSource = null;
        }

        el.statusDot.classList.remove('active');
        el.statusText.innerText = done ? 'COMPLETED' : 'STOPPED';
        el.processBtn.classList.remove('hidden');
        el.stopBtn.classList.add('hidden');
        el.scanSpeed.innerText = '0';
        if (done) el.progressBar.style.width = '100%';

        if (done) {
            const elapsed = ((Date.now() - state.startTime) / 1000).toFixed(1);
            notify(`Hoàn tất! ${state.foundCount.toLocaleString()} kết quả trong ${elapsed}s`, 'success');
            saveSession();
        }
    }

    // ─── Downloads ───
    el.downloadBtn.addEventListener('click', () => {
        if (state.blobChunks.length === 0) return notify('Không có dữ liệu để tải!', 'error');
        const ts = Date.now();
        downloadBlob(state.blobChunks, `zenscan-all-${ts}.txt`);
        notify('Đã tải file tổng hợp!', 'success');
    });

    el.splitDownloadBtn.addEventListener('click', async () => {
        const kwKeys = Object.keys(state.perKeywordChunks).filter(k => state.perKeywordChunks[k].length > 0);
        if (kwKeys.length === 0) return notify('Không có dữ liệu để tải!', 'error');

        notify('Đang tạo ZIP file...', 'info');

        try {
            const zip = new JSZip();
            const ts = Date.now();

            for (const kw of kwKeys) {
                const blob = new Blob(state.perKeywordChunks[kw], { type: 'text/plain' });
                const safeName = kw.replace(/[^a-z0-9.-]/gi, '_');
                const fileName = `data-${safeName}-${ts}.txt`;
                zip.file(fileName, blob);
            }

            const content = await zip.generateAsync({ type: 'blob' });
            const url = URL.createObjectURL(content);
            const a = document.createElement('a');
            a.href = url;
            a.download = `zenscan-keywords-${ts}.zip`;
            a.click();
            URL.revokeObjectURL(url);
            notify(`Đã tải ZIP với ${kwKeys.length} file!`, 'success');
        } catch (err) {
            notify('JSZip không khả dụng, tải từng file...', 'info');
            const ts = Date.now();
            for (let i = 0; i < kwKeys.length; i++) {
                const kw = kwKeys[i];
                const safeName = kw.replace(/[^a-z0-9.-]/gi, '_');
                setTimeout(() => {
                    downloadBlob(state.perKeywordChunks[kw], `data-${safeName}-${ts}.txt`);
                }, i * 400);
            }
        }
    });

    function downloadPerKeyword(kw) {
        const chunks = state.perKeywordChunks[kw];
        if (!chunks || chunks.length === 0) return notify(`Chưa có dữ liệu cho "${kw}"`, 'error');
        const safeName = kw.replace(/[^a-z0-9.-]/gi, '_');
        downloadBlob(chunks, `data-${safeName}-${Date.now()}.txt`);
        notify(`Đã tải kết quả cho "${kw}"`, 'success');
    }

    function downloadBlob(blobArray, filename) {
        const finalBlob = new Blob(blobArray, { type: 'text/plain' });
        const url = URL.createObjectURL(finalBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    el.copyBtn.addEventListener('click', async () => {
        if (state.blobChunks.length === 0) return notify('Không có dữ liệu để copy!', 'error');

        try {
            const blob = new Blob(state.blobChunks, { type: 'text/plain' });
            const text = await blob.text();
            await navigator.clipboard.writeText(text);
            notify(`Đã copy ${state.foundCount.toLocaleString()} dòng!`, 'success');
        } catch (err) {
            notify('Không thể copy: ' + err.message, 'error');
        }
    });

    // ─── Stop / Reset ───
    el.stopBtn.addEventListener('click', () => {
        endProcess(false);
        notify('Đã dừng scan!', 'error');
    });

    el.processBtn.addEventListener('click', startProcess);
    el.clearBtn.addEventListener('click', resetApp);

    function resetApp() {
        if (state.isProcessing) endProcess(false);

        state.selectedFiles = [];
        state.totalCount = 0;
        state.foundCount = 0;
        state.lastTotal = 0;
        state.blobChunks = [];
        state.perKeywordChunks = {};
        state.perKeywordCounts = {};

        el.selectedFileInfo.style.display = 'none';
        el.excludeKeyword.value = '';
        el.totalLines.innerText = '0';
        el.filteredLines.innerText = '0';
        el.scanSpeed.innerText = '0';
        el.dataVolume.innerText = '0 MB';
        el.progressBar.style.width = '0%';
        el.consoleOutput.innerHTML = '<div class="log-line empty">Chọn file và nhập keyword để bắt đầu...</div>';
        el.domainAnalytics.innerHTML = '<div class="analytics-empty">Chưa có dữ liệu</div>';
        el.keywordTags.innerHTML = '<div class="analytics-empty">Chưa có keyword nào</div>';
        el.consoleSearch.value = '';

        el.statusDot.classList.remove('active');
        el.statusText.innerText = 'READY';
        el.processBtn.disabled = true;
        el.processBtn.classList.remove('hidden');
        el.stopBtn.classList.add('hidden');

        notify('Đã reset! Keywords vẫn được lưu.', 'info');
    }

    // ─── Session History ───
    function saveSession() {
        const sessions = JSON.parse(localStorage.getItem(SESSION_KEY) || '[]');
        sessions.unshift({
            time: new Date().toLocaleString('vi-VN'),
            keywords: parseKeywords().length,
            results: state.foundCount,
            file: state.selectedFiles.length <= 1
                ? (state.selectedFiles[0]?.name || 'Unknown')
                : `${state.selectedFiles[0]?.name || 'Unknown'} +${state.selectedFiles.length - 1}`
        });
        if (sessions.length > 10) sessions.length = 10;
        localStorage.setItem(SESSION_KEY, JSON.stringify(sessions));
        renderSessions();
    }

    function renderSessions() {
        const sessions = JSON.parse(localStorage.getItem(SESSION_KEY) || '[]');
        el.sessionHistory.innerHTML = '';
        if (sessions.length === 0) {
            el.sessionHistory.innerHTML = '<div class="analytics-empty">Chưa có phiên nào</div>';
            return;
        }
        sessions.slice(0, 5).forEach(s => {
            const item = document.createElement('div');
            item.className = 'session-item';
            item.innerHTML = `
                <span class="session-time">${s.time}</span>
                <span class="session-count">${s.results?.toLocaleString() || 0} kết quả</span>
            `;
            el.sessionHistory.appendChild(item);
        });
    }
    renderSessions();

    // ─── Toast System ───
    function notify(msg, type = 'info') {
        const icons = { success: 'fa-check-circle', error: 'fa-exclamation-circle', info: 'fa-info-circle' };
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i> ${escapeHtml(msg)}`;
        el.toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('exit');
            setTimeout(() => toast.remove(), 300);
        }, 3500);

        while (el.toastContainer.childNodes.length > 4) {
            el.toastContainer.removeChild(el.toastContainer.firstChild);
        }
    }

    // ─── Utility ───
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1073741824) return (bytes / 1048576).toFixed(2) + ' MB';
        return (bytes / 1073741824).toFixed(2) + ' GB';
    }
});
