     const messagesEl = document.getElementById('messages');
    const chatForm = document.getElementById('chat-form');
    const chatInput = document.getElementById('chat-input');
    const chatSendBtn = document.getElementById('chat-send');
    const preview = document.getElementById('preview');
    const openBtn = document.getElementById('open-new-tab');
    const toggleBtn = document.getElementById('toggle-view');
    const previewView = document.getElementById('preview-view');
    const codeView = document.getElementById('code-view');
    const previewEmpty = document.getElementById('preview-empty');
    const splitContainer = document.getElementById('split-container');
    const leftPane = document.getElementById('left-pane');
    const rightPane = document.getElementById('right-pane');
    const splitDivider = document.getElementById('split-divider');
    const mobileShowChatBtn = document.getElementById('mobile-show-chat');
    const mobileShowPreviewBtn = document.getElementById('mobile-show-preview');
    let activeView = 'preview';
    let activeMobilePane = 'preview';

    let pendingQueryPrompt = null;

    let editorInstance = null;
    let queuedEditorValue = null;
    let applyTimer = null;
    let isResizing = false;

    const CHAT_STORAGE_KEY = 'pulse:buildChat:v1';
    let chatHistory = [];
    let persistTimer = null;

    function schedulePersistHistory() {
      if (persistTimer) window.clearTimeout(persistTimer);
      persistTimer = window.setTimeout(() => {
        try {
          localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chatHistory));
        } catch (_) {
        }
      }, 120);
    }

    function loadHistory() {
      try {
        const raw = localStorage.getItem(CHAT_STORAGE_KEY);
        const data = raw ? JSON.parse(raw) : null;
        return Array.isArray(data) ? data : [];
      } catch (_) {
        return [];
      }
    }

    function applyChangeLineDirectivesToHtml(sourceText) {
      if (!sourceText) return;
      const html = getCurrentHtml();
      if (typeof html !== 'string' || !html.length) return;

      const re = /<changeline(\d+)>([\s\S]*?)<\/changeline(\d+)>/gi;
      const patches = [];
      let m;
      while ((m = re.exec(sourceText)) !== null) {
        const start = parseInt(m[1], 10);
        const end = parseInt(m[3], 10);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        const content = (m[2] || '').replace(/^\s*\n/, '').replace(/\n\s*$/, '');
        patches.push({ start, end, content });
      }

      if (!patches.length) return [];

      const origLines = html.split('\n');
      const newLines = origLines.slice();

      for (const p of patches) {
        let s = Math.min(p.start, p.end);
        let e = Math.max(p.start, p.end);
        if (s < 1 || s > origLines.length) continue;
        if (e < 1 || e > origLines.length) continue;
        const count = e - s + 1;
        const rawLines = p.content.replace(/\r\n/g, '\n').split('\n');
        const repl = [];
        for (let i = 0; i < count; i++) {
          repl.push(rawLines[i] !== undefined ? rawLines[i] : '');
        }
        for (let i = 0; i < count; i++) {
          newLines[s - 1 + i] = repl[i];
        }
      }

      const updatedHtml = newLines.join('\n');
      if (editorInstance) {
        editorInstance.setValue(updatedHtml);
      } else {
        queuedEditorValue = updatedHtml;
      }
      scheduleApply();

      return patches;
    }

    function showChangeLineStatus(patches) {
      if (!Array.isArray(patches) || !patches.length || !messagesEl) return;

      const labels = patches.map((p) => {
        if (!p || typeof p.start !== 'number' || typeof p.end !== 'number') return null;
        const s = Math.min(p.start, p.end);
        const e = Math.max(p.start, p.end);
        return s === e ? `line ${s}` : `lines ${s}–${e}`;
      }).filter(Boolean);

      if (!labels.length) return;

      const row = document.createElement('div');
      row.className = 'flex justify-start';

      const bubble = document.createElement('div');
      bubble.className = 'max-w-[85%] panel rounded-2xl px-4 py-3';

      const meta = document.createElement('div');
      meta.className = 'text-xs text-gray-600';
      meta.textContent = 'System';

      const title = document.createElement('div');
      title.className = 'mt-1 text-sm text-gray-900';
      title.textContent = 'Applying line changes…';

      const barWrap = document.createElement('div');
      barWrap.className = 'mt-2 h-1.5 w-full rounded-full bg-black/10 overflow-hidden';

      const bar = document.createElement('div');
      bar.className = 'h-full w-1/2 rounded-full bg-black/60 animate-pulse';
      barWrap.appendChild(bar);

      bubble.appendChild(meta);
      bubble.appendChild(title);
      bubble.appendChild(barWrap);
      row.appendChild(bubble);
      messagesEl.appendChild(row);
      scrollMessagesToBottom();

      const summary = labels.length === 1 ? `Updated ${labels[0]}.` : `Updated ${labels.join(', ')}.`;
      window.setTimeout(() => {
        title.textContent = summary;
        barWrap.remove();
      }, 500);
    }

    function updateMobilePaneVisibility() {
      const isMobile = window.innerWidth < 1024;
      if (!leftPane || !rightPane) return;

      if (!isMobile) {
        leftPane.classList.remove('hidden');
        rightPane.classList.remove('hidden');
        return;
      }

      if (activeMobilePane === 'chat') {
        leftPane.classList.remove('hidden');
        rightPane.classList.add('hidden');
      } else {
        rightPane.classList.remove('hidden');
        leftPane.classList.add('hidden');
      }

      if (mobileShowChatBtn && mobileShowPreviewBtn) {
        if (activeMobilePane === 'chat') {
          mobileShowChatBtn.classList.add('button-primary');
          mobileShowChatBtn.classList.remove('button-secondary');
          mobileShowPreviewBtn.classList.add('button-secondary');
          mobileShowPreviewBtn.classList.remove('button-primary');
        } else {
          mobileShowPreviewBtn.classList.add('button-primary');
          mobileShowPreviewBtn.classList.remove('button-secondary');
          mobileShowChatBtn.classList.add('button-secondary');
          mobileShowChatBtn.classList.remove('button-primary');
        }
      }
    }

    if (mobileShowChatBtn) {
      mobileShowChatBtn.addEventListener('click', () => {
        activeMobilePane = 'chat';
        updateMobilePaneVisibility();
      });
    }

    if (mobileShowPreviewBtn) {
      mobileShowPreviewBtn.addEventListener('click', () => {
        activeMobilePane = 'preview';
        updateMobilePaneVisibility();
      });
    }

    function renderHistory() {
      if (!messagesEl) return;
      messagesEl.innerHTML = '';
      for (const m of chatHistory) {
        if (!m || typeof m.text !== 'string') continue;
        const role = m.role === 'user' ? 'user' : 'assistant';
        const row = document.createElement('div');
        row.className = 'flex ' + (role === 'user' ? 'justify-end' : 'justify-start');

        const bubble = document.createElement('div');
        bubble.className = 'max-w-[85%] rounded-2xl px-4 py-3 ' + (role === 'user' ? 'bg-black text-white' : 'panel');

        const meta = document.createElement('div');
        meta.className = 'text-xs ' + (role === 'user' ? 'text-white/70' : 'text-gray-600');
        meta.textContent = role === 'user' ? 'You' : 'Pulse';

        const body = document.createElement('div');
        body.className = 'mt-1 text-sm ' + (role === 'user' ? 'text-white' : 'text-gray-900') + ' whitespace-pre-wrap';
        if (role === 'assistant') {
          renderAssistantFormatted(body, m.text);
        } else {
          body.textContent = m.text;
        }

        bubble.appendChild(meta);
        bubble.appendChild(body);
        row.appendChild(bubble);
        messagesEl.appendChild(row);
      }
      scrollMessagesToBottom();
    }

    function setSendEnabled(enabled) {
      if (!chatSendBtn) return;
      chatSendBtn.disabled = !enabled;
      if (enabled) {
        chatSendBtn.classList.remove('opacity-50');
      } else {
        chatSendBtn.classList.add('opacity-50');
      }
    }

    let isStreaming = false;

    function setStreaming(active) {
      isStreaming = !!active;
      if (active) {
        setSendEnabled(false);
        if (chatInput) {
          chatInput.disabled = true;
        }
      } else {
        setSendEnabled(true);
        if (chatInput) {
          chatInput.disabled = false;
        }
      }
    }

    let activeSearchBubble = null;

    function formatSearchLabel(requests) {
      if (!Array.isArray(requests) || !requests.length) return 'Searching the web…';
      const r = requests[0] || {};
      const q = typeof r.q === 'string' ? r.q : '…';
      const type = r.type === 'images' ? 'images' : 'info';
      return `Searching ${q} ${type}…`;
    }

    function ensureSearchBubble(label) {
      if (!messagesEl) return null;

      if (activeSearchBubble && activeSearchBubble.isConnected) {
        const title = activeSearchBubble.querySelector('[data-role="title"]');
        if (title) title.textContent = label;
        return activeSearchBubble;
      }

      const row = document.createElement('div');
      row.className = 'flex justify-start';

      const bubble = document.createElement('div');
      bubble.className = 'max-w-[85%] panel rounded-2xl px-4 py-3';

      const meta = document.createElement('div');
      meta.className = 'text-xs text-gray-600';
      meta.textContent = 'System';

      const title = document.createElement('div');
      title.className = 'mt-1 text-sm text-gray-900';
      title.setAttribute('data-role', 'title');
      title.textContent = label;

      const barWrap = document.createElement('div');
      barWrap.className = 'mt-2 h-1.5 w-full rounded-full bg-black/10 overflow-hidden';
      barWrap.setAttribute('data-role', 'bar');

      const bar = document.createElement('div');
      bar.className = 'h-full w-1/2 rounded-full bg-black/60 animate-pulse';
      barWrap.appendChild(bar);

      bubble.appendChild(meta);
      bubble.appendChild(title);
      bubble.appendChild(barWrap);
      row.appendChild(bubble);
      messagesEl.appendChild(row);
      scrollMessagesToBottom();

      activeSearchBubble = row;
      return row;
    }

    function finalizeSearchBubble(doneText) {
      if (!activeSearchBubble || !activeSearchBubble.isConnected) return;
      const title = activeSearchBubble.querySelector('[data-role="title"]');
      if (title && doneText) title.textContent = doneText;
      const bar = activeSearchBubble.querySelector('[data-role="bar"]');
      if (bar) bar.remove();
      activeSearchBubble = null;
    }

    function scrollMessagesToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function addMessage(role, text) {
      const normalizedRole = role === 'user' ? 'user' : 'assistant';
      const messageText = String(text || '');
      chatHistory.push({ role: normalizedRole, text: messageText });
      schedulePersistHistory();

      const row = document.createElement('div');
      row.className = 'flex ' + (role === 'user' ? 'justify-end' : 'justify-start');

      const bubble = document.createElement('div');
      bubble.className = 'max-w-[85%] rounded-2xl px-4 py-3 ' + (role === 'user' ? 'bg-black text-white' : 'panel');

      const meta = document.createElement('div');
      meta.className = 'text-xs ' + (role === 'user' ? 'text-white/70' : 'text-gray-600');
      meta.textContent = role === 'user' ? 'You' : 'Pulse';

      const body = document.createElement('div');
      body.className = 'mt-1 text-sm ' + (role === 'user' ? 'text-white' : 'text-gray-900') + ' whitespace-pre-wrap';
      if (normalizedRole === 'assistant') {
        renderAssistantFormatted(body, messageText);
      } else {
        body.textContent = messageText;
      }

      bubble.appendChild(meta);
      bubble.appendChild(body);
      row.appendChild(bubble);
      messagesEl.appendChild(row);
      scrollMessagesToBottom();
    }

    function getCurrentHtml() {
      if (!editorInstance) return '';
      return editorInstance.getValue() || '';
    }

    function getCurrentHtmlWithLineNumbers() {
      const html = getCurrentHtml();
      if (!html) return '';
      const lines = html.split('\n');
      return lines
        .map((line, idx) => `${String(idx + 1).padStart(4, ' ')}: ${line}`)
        .join('\n');
    }

    function applyPreview() {
      const html = getCurrentHtml();
      const hasHtml = !!(html && html.trim().length);
      if (previewEmpty) {
        previewEmpty.style.display = hasHtml ? 'none' : 'flex';
      }
      preview.srcdoc = hasHtml ? html : '';
    }

    function scheduleApply() {
      if (applyTimer) window.clearTimeout(applyTimer);
      applyTimer = window.setTimeout(() => {
        applyPreview();
      }, 120);
    }

    function renderAssistantFormatted(bodyEl, text) {
      if (!bodyEl) return;
      const safe = String(text || '');

      const escaped = safe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      const withNewlines = escaped.replace(/\\n/g, '\n');

      const bolded = withNewlines.replace(/\*\*(.+?)\*\*/g, '<strong>$1<\/strong>');

      const lines = bolded.split(/\r?\n/);

      const htmlLines = lines.map((line) => {
        if (line.startsWith('### ')) {
          const title = line.slice(4).trim();
          return '<h3 class="font-semibold text-sm mb-1">' + title + '<\/h3>';
        }
        return line;
      });

      const html = htmlLines.join('<br/>');
      bodyEl.innerHTML = html;
    }

    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        chatForm.requestSubmit();
      }
    });

    function startAssistantStreamMessage() {
      const msgIndex = chatHistory.push({ role: 'assistant', text: '' }) - 1;
      schedulePersistHistory();

      const row = document.createElement('div');
      row.className = 'flex justify-start';

      const bubble = document.createElement('div');
      bubble.className = 'max-w-[85%] rounded-2xl px-4 py-3 panel';

      const meta = document.createElement('div');
      meta.className = 'text-xs text-gray-600';
      meta.textContent = 'Pulse';

      const body = document.createElement('div');
      body.className = 'mt-1 text-sm text-gray-900 whitespace-pre-wrap';
      body.textContent = '';

      const status = document.createElement('div');
      status.className = 'mt-2 flex items-center gap-2 text-xs text-gray-500 transition-all duration-150';
      status.style.opacity = '0';
      status.style.transform = 'translateY(4px)';

      const dot = document.createElement('span');
      dot.className = 'inline-block w-2.5 h-2.5 rounded-full border border-gray-400 border-t-transparent animate-spin';

      const statusText = document.createElement('span');
      statusText.textContent = 'Writing code';

      status.appendChild(dot);
      status.appendChild(statusText);

      bubble.appendChild(meta);
      bubble.appendChild(body);
      bubble.appendChild(status);
      row.appendChild(bubble);
      messagesEl.appendChild(row);
      scrollMessagesToBottom();

      return { body, msgIndex, statusEl: status };
    }

    async function streamAssistantReply(userText, historySnapshot) {
      let assistantMsg = null;
      let assistantRawText = '';

      const ensureAssistantMsg = () => {
        if (assistantMsg) return assistantMsg;
        assistantMsg = startAssistantStreamMessage();
        assistantMsg.body.textContent = '';
        return assistantMsg;
      };

      const setCodeWritingStatus = (active) => {
        const msg = ensureAssistantMsg();
        if (!msg || !msg.statusEl) return;
        if (active) {
          msg.statusEl.style.opacity = '1';
          msg.statusEl.style.transform = 'translateY(0)';
        } else {
          msg.statusEl.style.opacity = '0';
          msg.statusEl.style.transform = 'translateY(4px)';
        }
      };

      finalizeSearchBubble();

      let didReceiveContent = false;

      let awaitingSearchReady = false;
      let pendingStreamContent = '';

      let textBuffer = '';
      let inCodeBlock = false;
      let editorBuffer = '';
      let pendingEditorFlush = false;

      const flushEditor = () => {
        pendingEditorFlush = false;
        if (!editorInstance) {
          queuedEditorValue = editorBuffer;
          return;
        }
        editorInstance.setValue(editorBuffer);
        scheduleApply();
      };

      const appendChat = (s) => {
        if (!s) return;
        const msg = ensureAssistantMsg();
        assistantRawText += s;
        if (typeof msg.msgIndex === 'number' && chatHistory[msg.msgIndex]) {
          chatHistory[msg.msgIndex].text = assistantRawText;
          schedulePersistHistory();
        }
        renderAssistantFormatted(msg.body, assistantRawText);
        scrollMessagesToBottom();
      };

      const appendEditor = (s) => {
        if (!s) return;
        editorBuffer += s;
        if (!pendingEditorFlush) {
          pendingEditorFlush = true;
          window.requestAnimationFrame(flushEditor);
        }
      };

      const consumeFenceStart = (s) => {
        if (!s.startsWith('```')) return s;
        let rest = s.slice(3);
        if (rest.startsWith('\r\n')) rest = rest.slice(2);
        else if (rest.startsWith('\n')) rest = rest.slice(1);
        else {
          const nl = rest.indexOf('\n');
          if (nl !== -1) rest = rest.slice(nl + 1);
          else rest = '';
        }
        return rest;
      };

      const processStreamText = (incoming) => {
        textBuffer += incoming;

        while (textBuffer.length) {
          if (!inCodeBlock) {
            const idx = textBuffer.indexOf('```');
            if (idx === -1) {
              appendChat(textBuffer);
              textBuffer = '';
              break;
            }

            const before = textBuffer.slice(0, idx);
            appendChat(before);
            textBuffer = consumeFenceStart(textBuffer.slice(idx));

            inCodeBlock = true;
            setCodeWritingStatus(true);
            editorBuffer = '';
          } else {
            const idxEnd = textBuffer.indexOf('```');
            if (idxEnd === -1) {
              appendEditor(textBuffer);
              textBuffer = '';
              break;
            }

            const codePart = textBuffer.slice(0, idxEnd);
            appendEditor(codePart);
            textBuffer = textBuffer.slice(idxEnd + 3);
            if (textBuffer.startsWith('\r\n')) textBuffer = textBuffer.slice(2);
            else if (textBuffer.startsWith('\n')) textBuffer = textBuffer.slice(1);
            inCodeBlock = false;
            setCodeWritingStatus(false);
          }
        }
      };

      let referenceId = '';
      try {
        const rawRefId = localStorage.getItem('pulse:referenceId');
        if (typeof rawRefId === 'string') referenceId = rawRefId;
      } catch (_) {}

      if (!referenceId) {
        try {
          const rawPayload = localStorage.getItem('pulse:referencePayload');
          if (typeof rawPayload === 'string' && rawPayload) {
            const payload = JSON.parse(rawPayload);
            if (payload && Array.isArray(payload.files) && payload.files.length) {
              const resp = await fetch('/api/references', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
              });

              if (resp.ok) {
                const data = await resp.json().catch(() => null);
                const id = data && typeof data.id === 'string' ? data.id : '';
                if (id) {
                  referenceId = id;
                  try {
                    localStorage.setItem('pulse:referenceId', id);
                    localStorage.removeItem('pulse:referencePayload');
                  } catch (_) {}
                }
              }
            }
          }
        } catch (_) {}
      }

      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream'
        },
        body: JSON.stringify({
          message: userText,
          html: getCurrentHtml(),
          htmlNumbered: getCurrentHtmlWithLineNumbers(),
          history: Array.isArray(historySnapshot) ? historySnapshot : [],
          referenceId
        })
      });

      if (!res.ok || !res.body) {
        appendChat(`\n\n(Streaming failed: ${res.status})`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let sseBuffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });

        let sep;
        while ((sep = sseBuffer.indexOf('\n\n')) !== -1) {
          const rawEvent = sseBuffer.slice(0, sep);
          sseBuffer = sseBuffer.slice(sep + 2);

          const lines = rawEvent.split('\n');
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') {
              if (assistantMsg && assistantMsg.body) {
                const raw = assistantRawText || '';
                const patches = applyChangeLineDirectivesToHtml(raw) || [];

                let finalText = raw;
                if (patches.length) {
                  const cleaned = raw.replace(/<changeline\d+>[\s\S]*?<\/changeline\d+>/gi, '').trim();
                  finalText = cleaned;
                  showChangeLineStatus(patches);
                }

                if (typeof assistantMsg.msgIndex === 'number' && chatHistory[assistantMsg.msgIndex]) {
                  chatHistory[assistantMsg.msgIndex].text = finalText;
                  schedulePersistHistory();
                }

                renderAssistantFormatted(assistantMsg.body, finalText);

                if (assistantMsg.statusEl) {
                  let codeText = editorBuffer || getCurrentHtml();
                  let lineCount = 0;
                  if (codeText && typeof codeText === 'string') {
                    lineCount = codeText.split('\n').length;
                  }
                  const safeCount = Number.isFinite(lineCount) && lineCount > 0 ? lineCount : 0;
                  assistantMsg.statusEl.style.opacity = '1';
                  assistantMsg.statusEl.style.transform = 'translateY(0)';

                  if (safeCount > 0) {
                    assistantMsg.statusEl.innerHTML = '<span class="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white text-xs mr-1">✓<\/span>' +
                      'Wrote ' + safeCount + ' lines';
                  } else {
                    assistantMsg.statusEl.innerHTML = '<span class="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white text-xs">✓<\/span>';
                  }
                }
              }
              return;
            }
            try {
              const payload = JSON.parse(data);
              if (payload?.error) {
                appendChat(`\n\n(${payload.error})`);
                return;
              }
              if (payload?.status === 'searching') {
                ensureSearchBubble(formatSearchLabel(payload?.requests));
                awaitingSearchReady = true;
                continue;
              }
              if (payload?.status === 'ready') {
                finalizeSearchBubble('Search complete.');
                awaitingSearchReady = false;
                if (pendingStreamContent) {
                  const tmp = pendingStreamContent;
                  pendingStreamContent = '';
                  didReceiveContent = true;
                  processStreamText(tmp);
                }
                continue;
              }
              if (payload?.content) {
                if (awaitingSearchReady) {
                  pendingStreamContent += payload.content;
                } else {
                  didReceiveContent = true;
                  processStreamText(payload.content);
                }
              }
            } catch (_) {
            }
          }
        }
      }
    }

    chatForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (isStreaming) return;
      const text = (chatInput.value || '').trim();
      if (!text) return;
      addMessage('user', text);
      const historySnapshot = chatHistory.slice(0);
      chatInput.value = '';

      setStreaming(true);
      try {
        finalizeSearchBubble();
        await streamAssistantReply(text, historySnapshot);
      } catch (_) {
        addMessage('assistant', 'Something went wrong while streaming a reply.');
      } finally {
        setStreaming(false);
      }
    });

    (function bootstrapQueryPrompt() {
      try {
        const url = new URL(window.location.href);
        const q = url.searchParams.get('query');
        if (!q) return;
        const prompt = decodeURIComponent(q);
        if (!prompt.trim()) return;
        chatInput.value = prompt;
        pendingQueryPrompt = prompt;
        url.searchParams.delete('query');
        window.history.replaceState({}, '', url.pathname + url.search + url.hash);
      } catch (_) {
        // ignore
      }
    })();

    (function bootstrapReferenceId() {
      try {
        const url = new URL(window.location.href);
        const ref = url.searchParams.get('ref');
        if (ref && typeof ref === 'string' && ref.trim()) {
          const clean = ref.trim();
          try { localStorage.setItem('pulse:referenceId', clean); } catch (_) {}
          url.searchParams.delete('ref');
          window.history.replaceState({}, '', url.pathname + url.search + url.hash);
        }
      } catch (_) {
        // ignore
      }
    })();

    openBtn.addEventListener('click', () => {
      const w = window.open('', '_blank');
      if (!w) {
        addMessage('assistant', 'Popup blocked. Allow popups to open the preview in a new tab.');
        return;
      }
      w.document.open();
      w.document.write(getCurrentHtml());
      w.document.close();
    });

    toggleBtn.addEventListener('click', () => {
      activeView = activeView === 'preview' ? 'code' : 'preview';
      if (activeView === 'code') {
        previewView.classList.add('hidden');
        codeView.classList.remove('hidden');
        toggleBtn.textContent = 'Preview';
      } else {
        codeView.classList.add('hidden');
        previewView.classList.remove('hidden');
        toggleBtn.textContent = 'Code';
      }
    });

    function applyLeftWidth(px) {
      leftPane.style.width = `${px}px`;
      leftPane.style.flex = '0 0 auto';
      rightPane.style.flex = '1 1 auto';
      if (editorInstance) editorInstance.layout();
    }

    function setDraggingState(dragging) {
      isResizing = dragging;
      if (dragging) {
        document.body.classList.add('no-select');
        preview.style.pointerEvents = 'none';
        if (editorInstance) {
          const editorDom = document.getElementById('editor');
          if (editorDom) editorDom.style.pointerEvents = 'none';
        }
      } else {
        document.body.classList.remove('no-select');
        preview.style.pointerEvents = '';
        const editorDom = document.getElementById('editor');
        if (editorDom) editorDom.style.pointerEvents = '';
      }
    }

    if (splitDivider && splitContainer && leftPane) {
      splitDivider.addEventListener('mousedown', (e) => {
        if (window.innerWidth < 1024) return;
        e.preventDefault();
        setDraggingState(true);

        const containerRect = splitContainer.getBoundingClientRect();
        const minLeft = 240;
        const maxLeft = Math.max(320, containerRect.width - 320);

        const onMove = (ev) => {
          if (!isResizing) return;
          const next = Math.min(maxLeft, Math.max(minLeft, ev.clientX - containerRect.left));
          applyLeftWidth(next);
        };

        const onUp = () => {
          setDraggingState(false);
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });
    }

    require.config({
      paths: {
        vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs'
      }
    });

    require(['vs/editor/editor.main'], function () {
      editorInstance = monaco.editor.create(document.getElementById('editor'), {
        value: '',
        language: 'html',
        theme: 'vs',
        automaticLayout: true,
        fontSize: 14,
        minimap: { enabled: true },
        smoothScrolling: true,
        cursorSmoothCaretAnimation: 'on',
        wordWrap: 'on'
      });

      if (typeof queuedEditorValue === 'string' && queuedEditorValue.length) {
        editorInstance.setValue(queuedEditorValue);
        queuedEditorValue = null;
      }

      editorInstance.onDidChangeModelContent(() => {
        scheduleApply();
      });

      applyPreview();
    });
    function initTurnstile() {
      const backdrop = document.getElementById('turnstile-modal-backdrop');
      const container = document.getElementById('turnstile-container');
      if (!backdrop || !container) return;

      function openModal() {
        backdrop.style.display = 'flex';
      }

      function closeModal() {
        backdrop.style.display = 'none';
      }

      async function fetchSiteKey() {
        try {
          const resp = await fetch('/api/turnstile/site-key');
          if (!resp.ok) return '';
          const data = await resp.json().catch(() => null);
          return (data && typeof data.siteKey === 'string') ? data.siteKey : '';
        } catch (_) {
          return '';
        }
      }

      function loadTurnstileScript() {
        return new Promise((resolve, reject) => {
          if (window.turnstile) {
            resolve(window.turnstile);
            return;
          }

          const existing = document.querySelector('script[data-turnstile="true"]');
          if (existing) {
            existing.addEventListener('load', () => resolve(window.turnstile));
            existing.addEventListener('error', () => reject(new Error('Turnstile failed to load')));
            return;
          }

          const script = document.createElement('script');
          script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
          script.async = true;
          script.defer = true;
          script.setAttribute('data-turnstile', 'true');
          script.onload = () => resolve(window.turnstile);
          script.onerror = () => reject(new Error('Turnstile failed to load'));
          document.head.appendChild(script);
        });
      }

      (async () => {
        const siteKey = await fetchSiteKey();
        if (!siteKey) {
          if (typeof setSendEnabled === 'function') {
            setSendEnabled(true);
          }
          if (pendingQueryPrompt && chatForm) {
            chatForm.requestSubmit();
            pendingQueryPrompt = null;
          }
          return;
        }

        try {
          const t = await loadTurnstileScript();
          if (!t) return;

          container.innerHTML = '';
          t.render('#turnstile-container', {
            sitekey: siteKey,
            callback: async function (token) {
              try {
                const resp = await fetch('/api/turnstile/verify', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({ token })
                });
                const data = await resp.json().catch(() => null);
                if (data && data.success) {
                  closeModal();
                  setSendEnabled(true);
                  if (pendingQueryPrompt && chatForm) {
                    chatForm.requestSubmit();
                    pendingQueryPrompt = null;
                  }
                }
              } catch (_) {
              }
            }
          });

          openModal();
        } catch (_) {
        }
      })();
    }

    initTurnstile();

    updateMobilePaneVisibility();
    window.addEventListener('resize', () => {
      updateMobilePaneVisibility();
    });

    (function bootstrapChatHistory() {
      try {
        try {
          localStorage.clear();
        } catch (_) {
        }
      } catch (_) {
      }

      chatHistory = [];
      schedulePersistHistory();
    })();