/**
 * diii web app
 * Minimal serial REPL + script browser iii devices.
 */

class iiiConnection {
    constructor() {
        this.port = null;
        this.preferredPort = null;
        this.reader = null;
        this.writer = null;
        this.readableStreamClosed = null;
        this.writableStreamClosed = null;
        this.isConnected = false;
        this.lineBuffer = '';
        this.partialLineFlushTimer = null;
        this.partialLineFlushDelayMs = 40;
        this.partialLineFlushEnabled = true;
        this.onDataReceived = null;
        this.onConnectionChange = null;
        this._textEncoder = new TextEncoder();
    }

    async connect(port = null) {
        try {
            this.port = port || this.preferredPort;

            if (!this.port) {
                this.port = await navigator.serial.requestPort({
                    filters: [{ usbVendorId: 0xCAFE, usbProductId: 0x1101 }]
                });
            }

            this.preferredPort = this.port;

            await this.port.open({
                baudRate: 115200,
                dataBits: 8,
                stopBits: 1,
                parity: 'none',
                flowControl: 'none'
            });

            this.isConnected = true;

            const textDecoder = new TextDecoderStream();
            this.readableStreamClosed = this.port.readable.pipeTo(textDecoder.writable);
            this.reader = textDecoder.readable.getReader();

            const textEncoder = new TextEncoderStream();
            this.writableStreamClosed = textEncoder.readable.pipeTo(this.port.writable);
            this.writer = textEncoder.writable.getWriter();

            this.startReading();

            if (this.onConnectionChange) {
                this.onConnectionChange(true);
            }

            return true;
        } catch (error) {
            console.error('Connection error:', error);
            const browserError = String(error?.message || error || 'unknown serial error');

            if (this.onConnectionChange) {
                this.onConnectionChange(false, 'connection failed', { browserError, reason: 'connect-failed' });
            }
            return false;
        }
    }

    async startReading() {
        try {
            while (this.isConnected) {
                const { value, done } = await this.reader.read();
                if (done) break;
                if (!value) continue;

                this.lineBuffer += value;

                let newlineIndex = -1;
                while ((newlineIndex = this.lineBuffer.indexOf('\n')) !== -1) {
                    const line = this.lineBuffer.substring(0, newlineIndex);
                    this.lineBuffer = this.lineBuffer.substring(newlineIndex + 1);
                    if (line && this.onDataReceived) {
                        this.onDataReceived(line);
                    }
                }

                if (this.lineBuffer) {
                    this.schedulePartialLineFlush();
                } else {
                    this.clearPartialLineFlush();
                }
            }

            this.flushPartialLineBuffer();
        } catch (error) {
            console.error('Read error:', error);
            if (!this.isConnected) return;

            this.isConnected = false;
            if (this.reader) {
                await this.reader.cancel().catch(() => {});
            }
            if (this.writer) {
                await this.writer.close().catch(() => {});
            }

            this.reader = null;
            this.writer = null;
            this.flushPartialLineBuffer();

            if (this.port) {
                await this.port.close().catch(() => {});
                this.port = null;
            }

            if (this.onConnectionChange) {
                this.onConnectionChange(false, 'disconnected');
            }
        }
    }

    async write(data) {
        if (!this.isConnected || !this.writer) {
            throw new Error('Not connected');
        }

        let payload = String(data);
        const byteLength = this._textEncoder.encode(payload).length;
        if (byteLength % 64 === 0) {
            payload += '\n';
        }

        await this.writer.write(payload);
    }

    async writeLine(line) {
        await this.write(`${line}\n`);
    }

    async disconnect() {
        this.isConnected = false;
        this.clearPartialLineFlush();

        if (this.reader) {
            await this.reader.cancel().catch(() => {});
            await this.readableStreamClosed?.catch(() => {});
        }
        if (this.writer) {
            await this.writer.close().catch(() => {});
            await this.writableStreamClosed?.catch(() => {});
        }
        if (this.port) {
            await this.port.close().catch(() => {});
        }

        this.port = null;
        this.reader = null;
        this.writer = null;
        this.flushPartialLineBuffer();

        if (this.onConnectionChange) {
            this.onConnectionChange(false);
        }
    }

    schedulePartialLineFlush() {
        if (!this.partialLineFlushEnabled) return;

        this.clearPartialLineFlush();

        this.partialLineFlushTimer = setTimeout(() => {
            this.flushPartialLineBuffer();
        }, this.partialLineFlushDelayMs);
    }

    clearPartialLineFlush() {
        if (!this.partialLineFlushTimer) return;
        clearTimeout(this.partialLineFlushTimer);
        this.partialLineFlushTimer = null;
    }

    flushPartialLineBuffer() {
        this.clearPartialLineFlush();

        if (!this.lineBuffer) return;

        const partial = this.lineBuffer;
        this.lineBuffer = '';
        if (partial && this.onDataReceived) {
            this.onDataReceived(partial);
        }
    }
}

class diiiApp {
    constructor() {
        this.iiiDevice = new iiiConnection();
        this.selectedPort = null;
        this.selectedPortInfo = null;
        this.deviceLabelsByPort = new WeakMap();
        this.connectedDeviceLabel = null;
        this.hasConnectedThisSession = false;
        this.pendingConnectAttemptType = null;
        this.autoReconnectEnabled = false;
        this.autoReconnectTimer = null;
        this.reconnectDelayMs = 900;
        this.isManualDisconnect = false;

        this.commandHistory = [];
        this.historyIndex = -1;
        this.currentInput = '';
        this.pendingLuaCapture = null;
        this.luaCaptureSeq = 0;
        this.reconnectAfterRestartTimer = null;
        this.fileEntries = [];
        this.firstBadgeFileNames = new Set();
        this.fileFreeSpaceBytes = null;
        this.openMenuFile = null;
        this.isExplorerCollapsed = true;
        this.fileRunQueue = Promise.resolve();
        this.fileRefreshQueue = Promise.resolve();
        this.fileRefreshInFlight = false;
        this.fileRefreshRequested = false;
        this.pendingSuppressedOutputLines = [];
        this.lastUploadedScript = null;
        this.explorerWidthStorageKey = 'webdiii.explorerWidth';
        this.explorerWidthDefault = 280;
        this.explorerWidthMin = 220;
        this.explorerWidthMax = 520;
        this.isResizingExplorer = false;
        this.explorerResizePointerId = null;
        this.explorerResizeStartX = 0;
        this.explorerResizeStartWidth = this.explorerWidthDefault;

        this.cacheElements();
        this.bindEvents();
        this.restoreExplorerWidth();
        this.setExplorerCollapsed(true);
        this.checkBrowserSupport();
        this.renderFileList();

        this.outputLine('//// welcome. connect to an iii compatible grid or arc to begin.');
    }

    cacheElements() {
        this.elements = {
            scriptReferenceBtn: document.getElementById('scriptReferenceBtn'),

            splitContainer: document.getElementById('splitContainer'),
            fileExplorerPane: document.getElementById('fileExplorerPane'),
            explorerResizer: document.getElementById('explorerResizer'),
            fileList: document.getElementById('fileList'),
            fileSpaceFooter: document.getElementById('fileSpaceFooter'),
            toggleExplorerBtn: document.getElementById('toggleExplorerBtn'),
            refreshExplorerBtn: document.getElementById('refreshExplorerBtn'),
            explorerChevron: document.getElementById('explorerChevron'),

            connectionBtn: document.getElementById('replConnectionBtn'),
            replStatusPill: document.getElementById('replStatusPill'),
            replStatusIndicator: document.getElementById('replStatusIndicator'),
            replStatusText: document.getElementById('replStatusText'),

            output: document.getElementById('output'),
            replInput: document.getElementById('replInput'),
            replPane: document.getElementById('replPane'),
            uploadBtn: document.getElementById('uploadBtn'),
            restartBtn: document.getElementById('restartBtn'),
            bootloaderBtn: document.getElementById('bootloaderBtn'),
            reformatBtn: document.getElementById('reformatBtn'),
            clearBtn: document.getElementById('clearBtn'),

            fileInput: document.getElementById('fileInput'),

            browserWarning: document.getElementById('browserWarning'),
            closeWarning: document.getElementById('closeWarning')
        };
    }

    bindEvents() {
        const on = (element, eventName, handler) => {
            if (element) element.addEventListener(eventName, handler);
        };

        on(this.elements.connectionBtn, 'click', () => this.toggleConnection());
        on(this.elements.replStatusPill, 'click', () => this.toggleConnection());
        on(this.elements.replInput, 'keydown', (e) => this.handleReplInput(e));
        on(document, 'keydown', (e) => this.handleGlobalShortcuts(e));
        on(this.elements.toggleExplorerBtn, 'click', () => this.toggleExplorer());
        on(this.elements.refreshExplorerBtn, 'click', () => this.requestFileListRefresh());
        on(this.elements.explorerResizer, 'pointerdown', (e) => this.startExplorerResize(e));
        on(this.elements.explorerResizer, 'keydown', (e) => this.handleExplorerResizerKeydown(e));
        on(this.elements.uploadBtn, 'click', () => this.openUploadPicker());
        on(this.elements.restartBtn, 'click', () => this.restartDevice());
        on(this.elements.bootloaderBtn, 'click', () => this.bootloaderDevice());
        on(this.elements.reformatBtn, 'click', () => this.reformatFs());
        on(this.elements.clearBtn, 'click', () => this.clearOutput());
        on(this.elements.fileInput, 'change', (e) => this.handleFileSelect(e));
        on(document, 'click', (e) => this.handleDocumentClick(e));

        on(this.elements.closeWarning, 'click', () => {
            this.elements.browserWarning.style.display = 'none';
        });

        on(this.elements.scriptReferenceBtn, 'click', () => {
            window.open('https://monome.org/docs/iii/code', '_blank');
        });

        this.iiiDevice.onDataReceived = (data) => this.handleiiiOutput(data);
        this.iiiDevice.onConnectionChange = (connected, error, detail) => this.handleConnectionChange(connected, error, detail);

        if ('serial' in navigator) {
            navigator.serial.addEventListener('connect', (event) => this.handleSerialPortConnect(event));
            navigator.serial.addEventListener('disconnect', (event) => this.handleSerialPortDisconnect(event));
        }

        this.setupDragAndDrop();
    }

    checkBrowserSupport() {
        if ('serial' in navigator) return;
        if (this.elements.browserWarning) this.elements.browserWarning.style.display = 'flex';
        if (this.elements.connectionBtn) this.elements.connectionBtn.disabled = true;
        this.outputLine('ERROR: Web Serial API not supported in this browser.');
        this.outputLine('Please use Chrome, Edge, or Opera.');
    }

    toggleExplorer() {
        this.setExplorerCollapsed(!this.isExplorerCollapsed);
    }

    setExplorerCollapsed(collapsed) {
        this.isExplorerCollapsed = Boolean(collapsed);
        this.elements.fileExplorerPane?.classList.toggle('collapsed', this.isExplorerCollapsed);
        this.elements.explorerResizer?.classList.toggle('hidden', this.isExplorerCollapsed);

        if (this.elements.fileExplorerPane) {
            if (this.isExplorerCollapsed) {
                this.elements.fileExplorerPane.style.width = '';
                this.elements.fileExplorerPane.style.minWidth = '';
                this.elements.fileExplorerPane.style.maxWidth = '';
            } else {
                this.restoreExplorerWidth();
            }
        }

        if (this.elements.explorerResizer) {
            this.elements.explorerResizer.setAttribute('aria-hidden', String(this.isExplorerCollapsed));
            this.elements.explorerResizer.setAttribute('aria-disabled', String(this.isExplorerCollapsed));
            this.elements.explorerResizer.tabIndex = this.isExplorerCollapsed ? -1 : 0;
        }
        if (this.elements.toggleExplorerBtn) {
            this.elements.toggleExplorerBtn.setAttribute('aria-expanded', String(!this.isExplorerCollapsed));
        }
        if (this.elements.refreshExplorerBtn) {
            this.elements.refreshExplorerBtn.hidden = this.isExplorerCollapsed;
            this.elements.refreshExplorerBtn.setAttribute('aria-hidden', String(this.isExplorerCollapsed));
            this.elements.refreshExplorerBtn.tabIndex = this.isExplorerCollapsed ? -1 : 0;
        }
        if (this.elements.explorerChevron) {
            this.elements.explorerChevron.textContent = this.isExplorerCollapsed ? '›' : '‹';
        }

        this.updateExplorerResizerA11y();
    }

    clampExplorerWidth(width) {
        const containerWidth = this.elements.splitContainer?.clientWidth || 0;
        const dynamicMax = containerWidth > 0
            ? Math.max(this.explorerWidthMin, containerWidth - 320)
            : this.explorerWidthMax;
        const hardMax = Math.max(this.explorerWidthMin, Math.min(this.explorerWidthMax, dynamicMax));
        return Math.max(this.explorerWidthMin, Math.min(hardMax, Math.round(width)));
    }

    setExplorerWidth(width, { persist = true } = {}) {
        const pane = this.elements.fileExplorerPane;
        if (!pane || !Number.isFinite(Number(width))) return;

        const clamped = this.clampExplorerWidth(Number(width));
        pane.style.width = `${clamped}px`;
        pane.style.minWidth = `${clamped}px`;
        pane.style.maxWidth = `${clamped}px`;
        this.updateExplorerResizerA11y(clamped);

        if (persist) {
            try {
                window.localStorage.setItem(this.explorerWidthStorageKey, String(clamped));
            } catch {
                // ignore localStorage failures
            }
        }
    }

    restoreExplorerWidth() {
        let restored = this.explorerWidthDefault;

        try {
            const raw = window.localStorage.getItem(this.explorerWidthStorageKey);
            if (raw != null) {
                const parsed = Number.parseInt(raw, 10);
                if (Number.isFinite(parsed)) {
                    restored = parsed;
                }
            }
        } catch {
            // ignore localStorage failures
        }

        this.setExplorerWidth(restored, { persist: false });
    }

    getExplorerWidth() {
        return this.elements.fileExplorerPane?.getBoundingClientRect?.().width || this.explorerWidthDefault;
    }

    updateExplorerResizerA11y(width = this.getExplorerWidth()) {
        const resizer = this.elements.explorerResizer;
        if (!resizer) return;

        const maxWidth = this.clampExplorerWidth(Number.MAX_SAFE_INTEGER);
        const currentWidth = this.clampExplorerWidth(width);
        resizer.setAttribute('aria-valuemin', String(this.explorerWidthMin));
        resizer.setAttribute('aria-valuemax', String(maxWidth));
        resizer.setAttribute('aria-valuenow', String(currentWidth));
        resizer.setAttribute('aria-valuetext', `${currentWidth} pixels`);
    }

    handleExplorerResizerKeydown(event) {
        if (this.isExplorerCollapsed) return;

        const key = event.key;
        const isArrow = key === 'ArrowLeft' || key === 'ArrowRight';
        const isBoundary = key === 'Home' || key === 'End';
        if (!isArrow && !isBoundary) return;

        event.preventDefault();

        const currentWidth = this.getExplorerWidth();
        const step = event.shiftKey ? 48 : 16;

        if (key === 'Home') {
            this.setExplorerWidth(this.explorerWidthMin);
            return;
        }

        if (key === 'End') {
            this.setExplorerWidth(this.clampExplorerWidth(Number.MAX_SAFE_INTEGER));
            return;
        }

        const direction = key === 'ArrowRight' ? 1 : -1;
        this.setExplorerWidth(currentWidth + (direction * step));
    }

    startExplorerResize(event) {
        if (this.isExplorerCollapsed) return;
        if (!this.elements.fileExplorerPane || !this.elements.explorerResizer) return;

        event.preventDefault();

        this.isResizingExplorer = true;
        this.explorerResizePointerId = event.pointerId;
        this.explorerResizeStartX = event.clientX;
        this.explorerResizeStartWidth = this.elements.fileExplorerPane.getBoundingClientRect().width;

        this.elements.explorerResizer.classList.add('dragging');
        this.elements.explorerResizer.setPointerCapture(event.pointerId);
        document.body.classList.add('is-resizing-explorer');

        this.boundExplorerResizeMove = this.boundExplorerResizeMove || ((e) => this.handleExplorerResizeMove(e));
        this.boundExplorerResizeEnd = this.boundExplorerResizeEnd || ((e) => this.endExplorerResize(e));

        window.addEventListener('pointermove', this.boundExplorerResizeMove);
        window.addEventListener('pointerup', this.boundExplorerResizeEnd);
        window.addEventListener('pointercancel', this.boundExplorerResizeEnd);
    }

    handleExplorerResizeMove(event) {
        if (!this.isResizingExplorer) return;
        if (this.explorerResizePointerId != null && event.pointerId !== this.explorerResizePointerId) return;

        const delta = event.clientX - this.explorerResizeStartX;
        this.setExplorerWidth(this.explorerResizeStartWidth + delta);
    }

    endExplorerResize(event) {
        if (!this.isResizingExplorer) return;
        if (event && this.explorerResizePointerId != null && event.pointerId !== this.explorerResizePointerId) return;

        this.isResizingExplorer = false;
        this.explorerResizePointerId = null;

        this.elements.explorerResizer?.classList.remove('dragging');
        document.body.classList.remove('is-resizing-explorer');

        if (event && this.elements.explorerResizer?.hasPointerCapture?.(event.pointerId)) {
            this.elements.explorerResizer.releasePointerCapture(event.pointerId);
        }

        if (this.boundExplorerResizeMove) {
            window.removeEventListener('pointermove', this.boundExplorerResizeMove);
        }
        if (this.boundExplorerResizeEnd) {
            window.removeEventListener('pointerup', this.boundExplorerResizeEnd);
            window.removeEventListener('pointercancel', this.boundExplorerResizeEnd);
        }
    }

    outputText(text, options = {}) {
        const { autoScroll = true } = options;
        if (!this.elements.output) return;
        this.elements.output.appendChild(document.createTextNode(text));
        if (autoScroll) {
            this.elements.output.scrollTop = this.elements.output.scrollHeight;
        }
    }

    outputLine(text, options = {}) {
        this.outputText(`${text}\n`, options);
    }

    outputHTML(html, options = {}) {
        const { autoScroll = true } = options;
        if (!this.elements.output) return;
        const span = document.createElement('span');
        span.innerHTML = html;
        this.elements.output.appendChild(span);
        if (autoScroll) {
            this.elements.output.scrollTop = this.elements.output.scrollHeight;
        }
    }

    clearOutput() {
        if (this.elements.output) this.elements.output.textContent = '';
    }

    handleReplInput(event) {
        const input = this.elements.replInput;
        if (!input) return;

        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            const code = input.value.trim();
            if (!code) return;
            this.sendReplCommand(code);
            return;
        }

        const noModifiers = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;

        if (noModifiers && event.key === 'ArrowUp') {
            event.preventDefault();
            this.navigateReplHistory('up');
            return;
        }

        if (noModifiers && event.key === 'ArrowDown') {
            event.preventDefault();
            this.navigateReplHistory('down');
            return;
        }

        if (this.historyIndex !== -1 && event.key.length === 1) {
            this.historyIndex = -1;
            this.currentInput = '';
        }
    }

    handleGlobalShortcuts(event) {
        if (event.defaultPrevented) return;

        const isConnectToggle = (event.metaKey || event.ctrlKey)
            && event.shiftKey
            && !event.altKey
            && String(event.key).toLowerCase() === 'c';

        if (!isConnectToggle) return;

        event.preventDefault();
        this.toggleConnection();
    }

    navigateReplHistory(direction) {
        const input = this.elements.replInput;
        if (!input || this.commandHistory.length === 0) return;

        if (direction === 'up') {
            if (this.historyIndex === -1) {
                this.currentInput = input.value;
            }
            if (this.historyIndex < this.commandHistory.length - 1) {
                this.historyIndex += 1;
                input.value = this.commandHistory[this.commandHistory.length - 1 - this.historyIndex];
                input.selectionStart = input.selectionEnd = input.value.length;
            }
            return;
        }

        if (this.historyIndex === -1) return;
        this.historyIndex -= 1;
        input.value = this.historyIndex === -1
            ? this.currentInput
            : this.commandHistory[this.commandHistory.length - 1 - this.historyIndex];
        input.selectionStart = input.selectionEnd = input.value.length;
    }

    resetReplInput() {
        this.elements.replInput.value = '';
        this.historyIndex = -1;
        this.currentInput = '';
    }

    async sendReplCommand(code) {
        this.outputLine(`>> ${code}`);
        const isHelpShortcut = /^h$/i.test(code.trim());
        const isUploadShortcut = /^u$/i.test(code.trim());
        const isReUploadShortcut = /^r$/i.test(code.trim());

        if (this.commandHistory.length === 0 || this.commandHistory[this.commandHistory.length - 1] !== code) {
            this.commandHistory.push(code);
        }

        if (isHelpShortcut) {
            this.showHelp();
            this.resetReplInput();
            return;
        }

        if (isUploadShortcut) {
            this.openUploadPicker();
            this.resetReplInput();
            return;
        }

        if (isReUploadShortcut) {
            await this.refreshUploadAndRunLastScript();
            this.resetReplInput();
            return;
        }

        if (!this.iiiDevice.isConnected) {
            this.outputLine('no iii device connected.');
            this.resetReplInput();
            return;
        }

        try {
            const fileSelectMatch = code.match(/^\^\^s\s+(.+)$/);
            if (fileSelectMatch) {
                await this.openAndSelectRemoteFile(fileSelectMatch[1].trim());
                this.resetReplInput();
                return;
            }

            for (const line of code.split('\n')) {
                await this.iiiDevice.writeLine(line);
                await this.delay(1);
            }

            this.resetReplInput();
        } catch (error) {
            this.outputLine(`Error: ${error.message}`);
        }
    }

    async toggleConnection() {
        if (this.iiiDevice.isConnected) {
            await this.disconnect();
            return;
        }
        await this.connect();
    }

    async connect(options = {}) {
        const { auto = false } = options;
        this.pendingConnectAttemptType = auto ? 'auto' : 'manual';

        try {
            if (!auto) {
                this.outputLine('Connecting to iii device...');
            }

            let reconnectPort = this.selectedPort;

            if (reconnectPort && 'serial' in navigator) {
                try {
                    const availablePorts = await navigator.serial.getPorts();
                    const matchingPort = this.findMatchingPort(availablePorts, reconnectPort, this.selectedPortInfo);
                    if (matchingPort) {
                        reconnectPort = matchingPort;
                        this.selectedPort = matchingPort;
                    }
                } catch {
                    // ignore and fall back to the remembered port object
                }
            }

            this.connectedDeviceLabel = reconnectPort
                ? this.getCachedDeviceLabel(reconnectPort)
                : null;

            let connected = await this.iiiDevice.connect(reconnectPort);

            if (!connected && this.selectedPort && !auto) {
                this.selectedPort = null;
                this.selectedPortInfo = null;
                this.connectedDeviceLabel = null;
                connected = await this.iiiDevice.connect();
            }

            if (connected) {
                this.selectedPort = this.iiiDevice.port;
                this.selectedPortInfo = this.getPortInfo(this.selectedPort);
                this.hasConnectedThisSession = true;
                this.autoReconnectEnabled = true;
                this.clearAutoReconnectTimer();
                this.setExplorerCollapsed(false);
                const cachedDeviceType = this.getCachedDeviceLabel(this.selectedPort);
                if (cachedDeviceType) {
                    this.connectedDeviceLabel = cachedDeviceType;
                    this.elements.replStatusText.textContent = cachedDeviceType;
                }

                const deviceType = cachedDeviceType || await this.updateConnectedDeviceLabel();

                if (auto) {
                    if (deviceType) {
                        this.outputLine(`${deviceType} reconnected.`);
                    } else {
                        this.outputLine('Reconnected.');
                    }
                } else if (deviceType) {
                    this.outputLine(`${deviceType} connected! Ready to code.`);
                } else {
                    this.outputLine('Connected! Ready to code.');
                }

                if (!auto) {
                    this.outputLine('Drag and drop a lua file here to auto-upload.');
                    this.outputLine('');
                }

                await this.requestFileListRefresh();
                return true;
            }

            if (auto) {
                this.scheduleAutoReconnect();
            }

            return false;
        } finally {
            this.pendingConnectAttemptType = null;
        }
    }

    async updateConnectedDeviceLabel() {
        if (!this.iiiDevice.isConnected || !this.elements.replStatusText) {
            return null;
        }

        try {
            const lines = await this.executeLuaCapture('print(device_id())');
            const deviceType = lines.map((line) => String(line).trim()).find((line) => line.length > 0);

            if (deviceType) {
                this.cacheDeviceLabel(deviceType, this.iiiDevice.port);
                this.connectedDeviceLabel = deviceType;
                this.elements.replStatusText.textContent = deviceType;
                return deviceType;
            }
        } catch {
            // fall back to cached label below
        }

        const cachedDeviceType = this.getCachedDeviceLabel(this.iiiDevice.port);
        this.connectedDeviceLabel = cachedDeviceType;
        this.elements.replStatusText.textContent = cachedDeviceType || 'connected';
        return cachedDeviceType;
    }

    cacheDeviceLabel(deviceLabel, port) {
        const normalizedLabel = String(deviceLabel || '').trim();
        if (!normalizedLabel || !port) {
            return;
        }

        this.deviceLabelsByPort.set(port, normalizedLabel);
    }

    getCachedDeviceLabel(port) {
        if (!port) {
            return null;
        }

        return this.deviceLabelsByPort.get(port) || null;
    }

    async disconnect(manual = true) {
        this.isManualDisconnect = manual;
        if (manual) {
            this.autoReconnectEnabled = false;
            this.clearAutoReconnectTimer();
        }

        await this.iiiDevice.disconnect();
        this.requestFileListRefresh();
        this.outputLine('');
        this.outputLine('disconnected');
        this.outputLine('');
        this.fileFreeSpaceBytes = null;
        this.fileEntries = [];
        this.updateFileSpaceFooter(null);
        this.renderFileList();
    }

    handleConnectionChange(connected, error, detail = null) {
        if (!this.elements.connectionBtn || !this.elements.replStatusIndicator || !this.elements.replStatusText) return;

        if (connected) {
            this.elements.connectionBtn.textContent = 'disconnect';
            this.elements.replStatusIndicator.classList.add('connected');
            this.elements.replStatusText.textContent = this.connectedDeviceLabel || 'connected';
            this.elements.replInput?.focus();
            this.hasConnectedThisSession = true;
            this.isManualDisconnect = false;
            return;
        }

        this.elements.connectionBtn.textContent = 'connect';
        this.elements.replStatusIndicator.classList.remove('connected');

        const browserError = String(detail?.browserError || '').trim();
        const isConnectFailure = error === 'connection failed';
        const isManualConnectFailure = isConnectFailure && this.pendingConnectAttemptType === 'manual';

        if (isManualConnectFailure || (!this.hasConnectedThisSession && isConnectFailure)) {
            this.elements.replStatusText.textContent = 'connection failed';
            if (browserError) {
                this.outputLine(`Browser error: ${browserError}`);
            }
        } else if (this.hasConnectedThisSession) {
            this.elements.replStatusText.textContent = 'disconnected';
        } else {
            this.elements.replStatusText.textContent = 'not connected';
        }

        if (error && error.includes('disconnected')) {
            this.outputLine('');
            this.outputLine(error);

            if (this.autoReconnectEnabled && !this.isManualDisconnect && this.selectedPort) {
                this.scheduleAutoReconnect();
            }
        }

        this.isManualDisconnect = false;
    }

    handleSerialPortConnect(event) {
        if (!this.autoReconnectEnabled || this.iiiDevice.isConnected || !this.selectedPort) {
            return;
        }

        const eventPort = event?.port;
        if (eventPort && !this.isSamePort(eventPort, this.selectedPort, this.selectedPortInfo)) {
            return;
        }

        this.scheduleAutoReconnect(150);
    }

    async handleSerialPortDisconnect(event) {
        if (!this.selectedPort) {
            return;
        }

        const eventPort = event?.port;
        if (eventPort && !this.isSamePort(eventPort, this.selectedPort, this.selectedPortInfo)) {
            return;
        }

        if (this.autoReconnectEnabled && !this.isManualDisconnect) {
            if (this.iiiDevice.isConnected) {
                await this.disconnect(false);
            }
            this.scheduleAutoReconnect();
        }
    }

    getPortInfo(port) {
        try {
            return port?.getInfo?.() || null;
        } catch {
            return null;
        }
    }

    isSamePort(portA, portB, preferredInfo = null) {
        if (!portA || !portB) return false;
        if (portA === portB) return true;

        const infoA = this.getPortInfo(portA);
        const infoB = preferredInfo || this.getPortInfo(portB);
        if (!infoA || !infoB) return false;

        return infoA.usbVendorId === infoB.usbVendorId
            && infoA.usbProductId === infoB.usbProductId;
    }

    findMatchingPort(ports, preferredPort, preferredInfo = null) {
        if (!Array.isArray(ports) || ports.length === 0) {
            return null;
        }

        const exactMatch = ports.find((port) => port === preferredPort);
        if (exactMatch) return exactMatch;

        if (!preferredInfo) {
            return null;
        }

        return ports.find((port) => {
            const info = this.getPortInfo(port);
            if (!info) return false;

            return info.usbVendorId === preferredInfo.usbVendorId
                && info.usbProductId === preferredInfo.usbProductId;
        }) || null;
    }

    clearAutoReconnectTimer() {
        if (!this.autoReconnectTimer) return;
        clearTimeout(this.autoReconnectTimer);
        this.autoReconnectTimer = null;
    }

    scheduleAutoReconnect(delay = this.reconnectDelayMs) {
        if (!this.autoReconnectEnabled || this.iiiDevice.isConnected || !this.selectedPort || this.autoReconnectTimer) {
            return;
        }

        this.autoReconnectTimer = setTimeout(async () => {
            this.autoReconnectTimer = null;

            if (!this.autoReconnectEnabled || this.iiiDevice.isConnected) {
                return;
            }

            await this.connect({ auto: true });
        }, delay);
    }

    handleiiiOutput(data) {
        const cleaned = String(data).replace(/\r/g, '');
        if (!cleaned) return;

        if (this.handleSuppressedOutputLine(cleaned)) {
            return;
        }

        if (this.handleLuaCaptureLine(cleaned)) {
            return;
        }

        if (!cleaned.includes('^^')) {
            this.outputLine(cleaned);
            return;
        }

        const parts = cleaned.split('^^');
        for (const part of parts) {
            if (!part.trim()) continue;
            const eventMatch = part.match(/^(\w+)\(([^)]*)\)/);

            if (!eventMatch) {
                this.outputLine(part.trim());
                continue;
            }

            const event = eventMatch[1];
            const args = eventMatch[2]
                ? eventMatch[2].split(',').map((item) => item.trim())
                : [];

            this.handleiiiEvent(event, args);
        }
    }

    handleiiiEvent(event, args) {
        this.outputLine(`^^${event}(${args.join(', ')})`);
    }

    getUploadLines(text) {
        return String(text)
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .split('\n')
            .map((line) => line.replace(/\s+$/g, ''));
    }

    formatSizeKb(bytes) {
        const kb = (Number(bytes) || 0) / 1024;
        return `${Math.round(kb)}kb`;
    }

    updateFileSpaceFooter(bytes) {
        if (!this.elements.fileSpaceFooter) return;

        if (!Number.isFinite(Number(bytes))) {
            this.elements.fileSpaceFooter.textContent = 'free space: -- kb';
            return;
        }

        const kb = Math.round(Number(bytes) / 1024);
        this.elements.fileSpaceFooter.textContent = `free space: ${kb} kb`;
    }

    isInitFile(name) {
        return name === 'init.lua' || name === 'init';
    }

    getSortedFileEntries() {
        const entries = [...this.fileEntries];
        return entries.sort((a, b) => {
            const order = (name) => {
                if (this.isInitFile(name)) return 0;
                if (name === 'lib.lua') return 1;
                return 2;
            };

            const rankDiff = order(a.name) - order(b.name);
            if (rankDiff !== 0) return rankDiff;
            return a.name.localeCompare(b.name);
        });
    }

    async openAndSelectRemoteFile(fileName) {
        const normalizedName = String(fileName || '').trim();
        if (!normalizedName) {
            throw new Error('Missing file name for ^^s');
        }

        this.queueSuppressedOutputLine('-- receiving data');
        this.queueSuppressedOutputLine(`-- set filename: ${normalizedName}`);

        await this.iiiDevice.writeLine('^^s');
        await this.delay(100);
        await this.iiiDevice.writeLine(normalizedName);
        await this.delay(100);
        await this.iiiDevice.writeLine('^^f');
        await this.delay(100);
    }

    queueSuppressedOutputLine(line, ttlMs = 2500) {
        const value = String(line || '');
        if (!value) return;
        this.pendingSuppressedOutputLines.push({
            line: value,
            expiresAt: Date.now() + ttlMs
        });
    }

    handleSuppressedOutputLine(line) {
        if (!this.pendingSuppressedOutputLines.length) return false;

        const now = Date.now();
        this.pendingSuppressedOutputLines = this.pendingSuppressedOutputLines.filter((entry) => entry.expiresAt > now);
        const matchIndex = this.pendingSuppressedOutputLines.findIndex((entry) => entry.line === line);
        if (matchIndex === -1) return false;

        this.pendingSuppressedOutputLines.splice(matchIndex, 1);
        return true;
    }

    async sendScriptTextToiii(fileName, text) {
        const lines = this.getUploadLines(text);

        await this.executeLuaCapture(`fs_remove_file(${this.luaQuote(fileName)})`);
        // Match diii upload protocol:
        // ^^s, <filename>, ^^f, ^^s, <file lines>, ^^w
        await this.openAndSelectRemoteFile(fileName);
        await this.iiiDevice.writeLine('^^s');
        await this.delay(100);

        for (const line of lines) {
            await this.iiiDevice.writeLine(line);
            await this.delay(1);
        }

        await this.delay(100);
        await this.iiiDevice.writeLine('^^w');

        // Sync: wait for the device to finish ^^w processing (compilation +
        // LittleFS flash write/erase) before issuing any further commands.
        // A fixed delay is unreliable because LFS block compaction can take
        // longer than any reasonable constant.
        await this.executeLuaCapture('print(1)');
    }

    async uploadTextAsScript(name, text, options = {}) {
        const { refreshList = true } = options;

        if (!this.iiiDevice.isConnected) {
            this.outputLine('Error: Not connected to usb device (click connect in the header)');
            return;
        }

        try {
            this.outputLine(`Uploading ${name}...`);
            await this.sendScriptTextToiii(name, text);
            if (refreshList) {
                await this.requestFileListRefresh();
            }
        } catch (error) {
            this.outputLine(`Upload error: ${error.message}`);
        }
    }

    supportsFileSystemPicker() {
        return typeof window?.showOpenFilePicker === 'function';
    }

    async chooseLuaFileWithHandle() {
        if (!this.supportsFileSystemPicker()) {
            return null;
        }

        try {
            const handles = await window.showOpenFilePicker({
                multiple: false,
                excludeAcceptAllOption: true,
                types: [{
                    description: 'Lua scripts',
                    accept: {
                        'text/plain': ['.lua'],
                        'application/x-lua': ['.lua']
                    }
                }]
            });

            const handle = handles?.[0];
            if (!handle) return null;

            const file = await handle.getFile();
            return { file, handle };
        } catch (error) {
            if (error?.name === 'AbortError') {
                return null;
            }

            this.outputLine(`File picker error: ${error.message}`);
            return null;
        }
    }

    async openUploadPicker() {
        if (this.supportsFileSystemPicker()) {
            const picked = await this.chooseLuaFileWithHandle();
            if (!picked) return;
            await this.uploadSelectedFile(picked.file, { fileHandle: picked.handle });
            return;
        }

        if (!this.elements.fileInput) return;
        this.elements.fileInput.value = '';
        this.elements.fileInput.click();
    }

    cacheLastUploadedScript({ name, text, fileHandle = null }) {
        if (!name || typeof text !== 'string') return;
        this.lastUploadedScript = {
            name,
            text,
            fileHandle
        };
    }

    async uploadSelectedFile(file, options = {}) {
        if (!file) return false;

        if (!file.name.toLowerCase().endsWith('.lua')) {
            this.outputLine('Error: Only .lua files are supported');
            return false;
        }

        try {
            this.setExplorerCollapsed(false);
            const text = await file.text();
            await this.uploadTextAsScript(file.name, text);
            this.cacheLastUploadedScript({
                name: file.name,
                text,
                fileHandle: options.fileHandle || null
            });
            return true;
        } catch (error) {
            this.outputLine(`Upload error: ${error.message}`);
            return false;
        }
    }

    async getRefreshableLastScript() {
        // no previous upload case
        if (!this.lastUploadedScript) {
            this.outputLine('No previous upload found. Use u to pick a lua file first.');
            return null;
        }

        // previous upload exists
        if (this.lastUploadedScript.fileHandle) {
            try {
                const file = await this.lastUploadedScript.fileHandle.getFile();
                
                return {
                    name: file.name,
                    text: await file.text(),
                    fileHandle: this.lastUploadedScript.fileHandle
                };
            } catch (error) {
                this.outputLine(`Refresh error: ${error.message}`);
                return null;
            }
        }

        // this path is hit if browser doesn't support file system access API
        if (!this.supportsFileSystemPicker()) {
            this.openUploadPicker();
            return null;
        }

        // this path is hit if browser DOES support file system access API
        const picked = await this.chooseLuaFileWithHandle();
        if (!picked) return null;

        return {
            name: picked.file.name,
            text: await picked.file.text(),
            fileHandle: picked.handle
        };
    }

    async refreshUploadAndRunLastScript() {
        if (!this.iiiDevice.isConnected) {
            this.outputLine('no iii device connected.');
            return;
        }

        const script = await this.getRefreshableLastScript();
        if (!script) return;

        try {
            this.outputLine(`r: refreshing ${script.name}`);
            this.queueSuppressedOutputLine('-- re-init with no script', 8000);
            this.queueSuppressedOutputLine('-- init: skip script', 8000);
            this.queueSuppressedOutputLine('-- lua lib', 8000);
            await this.iiiDevice.writeLine('^^c');
            await this.delay(200);
            await this.uploadTextAsScript(script.name, script.text, { refreshList: false });
            this.cacheLastUploadedScript({
                name: script.name,
                text: script.text,
                fileHandle: script.fileHandle
            });
            await this.executeLua(`fs_run_file("lib.lua")`);
            await this.executeLua(`fs_run_file(${this.luaQuote(script.name)})`);
            this.requestFileListRefresh().catch((error) => {
                this.outputLine(`File list error: ${error.message}`);
            });
        } catch (error) {
            this.outputLine(`r command error: ${error.message}`);
        }
    }

    async handleFileSelect(event) {
        const file = event.target?.files?.[0];
        if (!file) return;
        await this.uploadSelectedFile(file);
    }

    handleDocumentClick(event) {
        if (!this.openMenuFile) return;
        if (event.target?.closest('.file-row')) return;
        this.openMenuFile = null;
        this.renderFileList();
    }

    renderFileList() {
        if (!this.elements.fileList) return;

        this.elements.fileList.textContent = '';

        if (!this.iiiDevice.isConnected) {
            const empty = document.createElement('div');
            empty.className = 'file-list-empty';
            empty.textContent = 'connect to load files';
            this.elements.fileList.appendChild(empty);
            return;
        }

        if (this.fileEntries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'file-list-empty';
            empty.textContent = 'no files';
            this.elements.fileList.appendChild(empty);
            return;
        }

        const sortedEntries = this.getSortedFileEntries();
        const pinnedCount = sortedEntries.filter((entry) => entry.name === 'lib.lua' || this.isInitFile(entry.name)).length;

        for (let index = 0; index < sortedEntries.length; index += 1) {
            const entry = sortedEntries[index];
            const row = document.createElement('div');
            row.className = 'file-row';

            const main = document.createElement('div');
            main.className = 'file-main';
            const isLibFile = entry.name === 'lib.lua';
            const isInitLuaFile = entry.name === 'init.lua';

            if (!isLibFile && !isInitLuaFile) {
                const playBtn = document.createElement('button');
                playBtn.className = 'file-play-btn';
                playBtn.type = 'button';
                playBtn.textContent = '▶';
                playBtn.setAttribute('aria-label', `run ${entry.name}`);
                playBtn.addEventListener('click', async (event) => {
                    event.stopPropagation();
                    await this.enqueueRunFile(entry.name);
                });
                main.appendChild(playBtn);
            }

            const label = document.createElement('div');
            label.className = 'file-label';
            label.textContent = Number.isFinite(entry.size)
                ? `${entry.name} (${this.formatSizeKb(entry.size)})`
                : entry.name;

            main.appendChild(label);

            if (entry.name !== 'init.lua' && this.firstBadgeFileNames.has(entry.name)) {
                const firstBadge = document.createElement('span');
                firstBadge.className = 'file-first-pill';
                firstBadge.textContent = 'first';
                firstBadge.setAttribute('aria-label', `${entry.name} is configured in init.lua`);
                main.appendChild(firstBadge);
            }

            const menuBtn = document.createElement('button');
            menuBtn.className = 'file-menu-btn';
            menuBtn.type = 'button';
            menuBtn.textContent = '⋯';
            menuBtn.setAttribute('aria-label', `actions for ${entry.name}`);
            menuBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                this.openMenuFile = this.openMenuFile === entry.name ? null : entry.name;
                this.renderFileList();
            });

            const menu = document.createElement('div');
            menu.className = `file-menu${this.openMenuFile === entry.name ? ' open' : ''}`;

            const actions = isInitLuaFile
                ? [
                    { label: 'read', fn: () => this.showFile(entry.name) },
                    { label: 'delete', fn: () => this.deleteFile(entry.name) }
                ]
                : isLibFile
                    ? [
                        { label: 'download', fn: () => this.downloadFile(entry.name) },
                        { label: 'read', fn: () => this.showFile(entry.name) }
                    ]
                    : [
                        { label: 'run', fn: () => this.enqueueRunFile(entry.name) },
                        { label: 'download', fn: () => this.downloadFile(entry.name) },
                        { label: 'first', fn: () => this.configureFirst(entry.name) },
                        { label: 'read', fn: () => this.showFile(entry.name) },
                        { label: 'delete', fn: () => this.deleteFile(entry.name) }
                    ];

            for (const action of actions) {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'file-menu-item';
                item.textContent = action.label;
                item.addEventListener('click', async (event) => {
                    event.stopPropagation();
                    this.openMenuFile = null;
                    this.renderFileList();
                    await action.fn();
                });
                menu.appendChild(item);
            }

            row.appendChild(main);
            row.appendChild(menuBtn);
            row.appendChild(menu);
            this.elements.fileList.appendChild(row);

            if (pinnedCount > 0 && index === pinnedCount - 1 && index < sortedEntries.length - 1) {
                const separator = document.createElement('div');
                separator.className = 'file-list-separator';
                this.elements.fileList.appendChild(separator);
            }
        }
    }

    luaQuote(value) {
        return `'${String(value)
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/\r/g, '\\r')
            .replace(/\n/g, '\\n')}'`;
    }

    handleLuaCaptureLine(line) {
        const capture = this.pendingLuaCapture;
        if (!capture) return false;

        if (line === capture.beginToken) {
            capture.started = true;
            return true;
        }

        if (line === capture.endToken) {
            clearTimeout(capture.timeoutId);
            this.pendingLuaCapture = null;
            capture.resolve(capture.lines);
            return true;
        }

        if (!capture.started) return false;

        capture.lines.push(line);
        return true;
    }

    async executeLua(command) {
        if (!this.iiiDevice.isConnected) {
            throw new Error('Not connected to usb device');
        }

        await this.iiiDevice.writeLine(command);

        return true;
    }

    async executeLuaCapture(commands) {
        if (!this.iiiDevice.isConnected) {
            throw new Error('Not connected to usb device');
        }

        if (this.pendingLuaCapture) {
            throw new Error('Device is busy, please try again');
        }

        const captureId = ++this.luaCaptureSeq;
        const beginToken = `__webdiii_begin:${captureId}`;
        const endToken = `__webdiii_end:${captureId}`;

        const resultPromise = new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.pendingLuaCapture = null;
                reject(new Error('Timed out waiting for device response'));
            }, 7000);

            this.pendingLuaCapture = {
                beginToken,
                endToken,
                started: false,
                lines: [],
                timeoutId,
                resolve,
                reject
            };
        });

        this.iiiDevice.partialLineFlushEnabled = false;
        this.iiiDevice.clearPartialLineFlush();

        try {
            await this.iiiDevice.writeLine(`print(${this.luaQuote(beginToken)})`);

            const lines = Array.isArray(commands)
                ? commands
                : String(commands).split('\n');

            for (const rawLine of lines) {
                const line = String(rawLine).trim();
                if (!line) continue;
                await this.iiiDevice.writeLine(`${line}`);
            }

            await this.iiiDevice.writeLine(`print(${this.luaQuote(endToken)})`);

            return await resultPromise;
        } finally {
            this.iiiDevice.partialLineFlushEnabled = true;
            this.iiiDevice.schedulePartialLineFlush();
        }
    }

    async refreshFileList() {
        if (!this.iiiDevice.isConnected) {
            this.fileEntries = [];
            this.firstBadgeFileNames = new Set();
            this.fileFreeSpaceBytes = null;
            this.updateFileSpaceFooter(null);
            this.renderFileList();
            return;
        }

        try {
            const lsLines = await this.executeLuaCapture(
                'for _, __name in ipairs(fs_list_files()) do local __size = fs_file_size(__name) or 0; print("__webdiii_file\\t" .. __name .. "\\t" .. tostring(__size)) end'
            );
            const memLines = await this.executeLuaCapture('print(fs_free_space())');

            const entries = this.parseFileEntriesFromLs(lsLines);
            this.fileFreeSpaceBytes = this.parseMemoryFooterFromMem(memLines);

            this.fileEntries = entries;

            try {
                await this.refreshFirstBadgeFileNames(entries);
            } catch {
                this.firstBadgeFileNames = new Set();
            }

            this.updateFileSpaceFooter(this.fileFreeSpaceBytes);
            this.renderFileList();
        } catch (error) {
            this.firstBadgeFileNames = new Set();
            this.fileFreeSpaceBytes = null;
            this.updateFileSpaceFooter(null);
            this.outputLine(`File list error: ${error.message}`);
        }
    }

    requestFileListRefresh() {
        this.fileRefreshRequested = true;

        this.fileRefreshQueue = this.fileRefreshQueue
            .catch(() => {})
            .then(async () => {
                if (this.fileRefreshInFlight || !this.fileRefreshRequested) {
                    return;
                }

                this.fileRefreshRequested = false;
                this.fileRefreshInFlight = true;

                try {
                    await this.refreshFileList();
                } finally {
                    this.fileRefreshInFlight = false;
                }

                if (this.fileRefreshRequested) {
                    await this.requestFileListRefresh();
                }
            });

        return this.fileRefreshQueue;
    }

    getFirstRunFileTargetFromInit(initContent) {
        const content = String(initContent || '');
        const withoutBlockComments = content.replace(/--\[\[[\s\S]*?\]\]/g, '');
        const withoutLineComments = withoutBlockComments.replace(/--.*$/gm, '');
        const match = withoutLineComments.match(/fs_run_file\s*\(\s*(['"])([^'"]+)\1\s*\)/);
        return match?.[2]?.trim() || '';
    }

    parseFileEntriesFromLs(lines) {
        const entries = [];
        const seenNames = new Set();

        for (const rawLine of lines) {
            const line = String(rawLine || '').trim();

            if (!line.startsWith('__webdiii_file\t')) continue;

            const parts = line.split('\t');
            if (parts.length < 3) continue;

            const name = String(parts[1] || '').trim();
            const isLua = name.toLowerCase().endsWith('.lua');
            const isInit = name === 'init';
            if (!isLua && !isInit) continue;
            if (seenNames.has(name)) continue;
            seenNames.add(name);

            const parsedSize = Number.parseInt(parts[2], 10);
            entries.push({
                name,
                size: Number.isFinite(parsedSize) ? parsedSize : null
            });
        }

        return entries;
    }

    parseMemoryFooterFromMem(lines) {
        const bytes = Number.parseInt(lines[0], 10);
        return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
    }

    async refreshFirstBadgeFileNames(entries) {
        const hasInitLua = entries.some((entry) => entry.name === 'init.lua');
        if (!hasInitLua) {
            this.firstBadgeFileNames = new Set();
            return;
        }

        const initContent = await this.readRemoteFile('init.lua');
        const targetName = this.getFirstRunFileTargetFromInit(initContent);

        if (!targetName) {
            this.firstBadgeFileNames = new Set();
            return;
        }

        const hasMatchingFile = entries.some((entry) => entry.name === targetName);
        this.firstBadgeFileNames = hasMatchingFile
            ? new Set([targetName])
            : new Set();
    }

    async readRemoteFile(fileName) {
        const lines = await this.executeLuaCapture(`cat(${this.luaQuote(fileName)})`);
        return lines.join('\n');
    }

    async configureFirst(fileName) {
        try {
            await this.executeLuaCapture(`first(${this.luaQuote(fileName)})`);
            this.outputLine(`${fileName} will now run at at startup`);
            await this.requestFileListRefresh();
        } catch (error) {
            this.outputLine(`First error: ${error.message}`);
        }
    }

    async downloadFile(fileName) {
        try {
            const content = await this.readRemoteFile(fileName);
            const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            this.outputLine(`Downloaded ${fileName}`);
        } catch (error) {
            this.outputLine(`Download error: ${error.message}`);
        }
    }

    async showFile(fileName) {
        try {
            if (!this.elements.output) return;

            const topSpacerLine = document.createElement('span');
            topSpacerLine.textContent = '\n';
            this.elements.output.appendChild(topSpacerLine);

            const headerLine = document.createElement('span');
            headerLine.textContent = `${fileName} contents:\n\n`;
            this.elements.output.appendChild(headerLine);

            const lines = await this.executeLuaCapture(`cat(${this.luaQuote(fileName)})`);
            for (const line of lines) {
                this.outputLine(line, { autoScroll: false });
            }

            this.outputText('\n', { autoScroll: false });

            this.elements.output.scrollTop = topSpacerLine.offsetTop;
        } catch (error) {
            this.outputLine(`Show error: ${error.message}`);
        }
    }

    async enqueueRunFile(fileName) {
        const task = async () => {
            await this.runFile(fileName);
        };

        this.fileRunQueue = this.fileRunQueue
            .catch(() => {})
            .then(task);

        return this.fileRunQueue;
    }

    async runFile(fileName) {
        this.queueSuppressedOutputLine('-- re-init with no script', 8000);
        this.queueSuppressedOutputLine('-- init: skip script', 8000);
        this.queueSuppressedOutputLine('-- lua lib', 8000);
        this.outputLine(`running ${fileName}...`);
        await this.iiiDevice.writeLine('^^c');
        await this.delay(500);
        await this.executeLua(`fs_run_file("lib.lua")`);
        await this.delay(500);
        await this.executeLua(`fs_run_file(${this.luaQuote(fileName)})`);
    }

    async deleteFile(fileName) {
        if (!window.confirm(`Delete ${fileName}?`)) {
            return;
        }

        try {
            await this.executeLuaCapture(`fs_remove_file(${this.luaQuote(fileName)})`);
            this.outputLine(`Deleted ${fileName}`);
            await this.requestFileListRefresh();
        } catch (error) {
            this.outputLine(`Delete error: ${error.message}`);
        }
    }

    setupDragAndDrop() {
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
            document.body.addEventListener(eventName, (event) => {
                event.preventDefault();
                event.stopPropagation();
            }, false);
        });

        document.body.addEventListener('drop', async (event) => {
            const files = event.dataTransfer?.files;
            if (!files || files.length === 0) return;

            const file = files[0];
            await this.uploadSelectedFile(file);
        });
    }

    restartDevice() {
        if (!this.iiiDevice.isConnected) {
            this.outputLine('Error: Not connected to usb device');
            return;
        }
        this.outputLine('> ^^r');
        this.iiiDevice.writeLine('^^r');

        if (this.reconnectAfterRestartTimer) {
            clearTimeout(this.reconnectAfterRestartTimer);
        }

        this.reconnectAfterRestartTimer = setTimeout(async () => {
            if (!this.iiiDevice.isConnected) {
                await this.connect({ auto: true });
            }
            this.reconnectAfterRestartTimer = null;
        }, 1000);
    }

    bootloaderDevice() {
        if (!this.iiiDevice.isConnected) {
            this.outputLine('Error: Not connected to usb device');
            return;
        }
        this.outputLine('> ^^b');
        this.iiiDevice.writeLine('^^b');
    }

    async reformatFs() {
        if (!this.iiiDevice.isConnected) {
            this.outputLine('Error: Not connected to usb device');
            return;
        }

        if (!window.confirm('Reformat filesystem? This will erase all files on your iii device.')) {
            return;
        }

        try {
            await this.executeLuaCapture('fs_reformat()');
            this.outputLine('Filesystem reformatted.');
            await this.requestFileListRefresh();
        } catch (error) {
            this.outputLine(`Reformat error: ${error.message}`);
        }
    }

    showHelp() {
        this.outputLine('');
        this.outputLine(' diii helpers:');
        this.outputLine(' h            show this help');
        this.outputLine(' u            open file picker (same as upload button)');
        this.outputLine(' r            re-upload and run last uploaded script');
        this.outputLine(' Cmd/Ctrl+Shift+C  connect/disconnect');
        this.outputLine('');
        this.outputLine(' common iii commands:');
        this.outputLine(' ^^i          init');
        this.outputLine(' ^^c          clean init');
        this.outputLine(' help()       print iii api');
        this.outputLine('');
        this.outputHTML('Docs: <a href="https://monome.org/docs/iii/code" target="_blank" rel="noopener noreferrer">monome.org/docs/iii/code</a>\n');
    }

    delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new diiiApp();

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch((error) => {
            console.error('Service worker registration failed:', error);
        });
    }
});
