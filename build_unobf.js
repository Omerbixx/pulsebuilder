    try { localStorage.clear(); } catch (_) {}
    try { sessionStorage.clear(); } catch (_) {}
    try {
      const cookies = document.cookie ? document.cookie.split(';') : [];
      for (const c of cookies) {
        const eqPos = c.indexOf('=');
        const name = (eqPos > -1 ? c.substr(0, eqPos) : c).trim();
        if (!name) continue;
        if (name === 'pulse_refs' || name === 'pulse_refs_uses') continue;
        document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
      }
    } catch (_) {}

    async function fetchCurrentUser() {
      try {
        const resp = await fetch('/api/auth/me', {
          method: 'GET',
          credentials: 'include'
        });
        if (!resp.ok) return null;
        const data = await resp.json().catch(() => null);
        if (!data || !data.authenticated) return null;
        return data.user || null;
      } catch (_) {
        return null;
      }
    }

    async function saveCurrentSite() {
      const user = await fetchCurrentUser();
      if (!user) {
        
        return;
      }

      const html = getCurrentHtml();
      if (!html || !html.trim()) {
        window.alert('Nothing to save yet.');
        return;
      }
      
      let counter = 0;
      try {
        const raw = localStorage.getItem('pulse:projectCounter');
        const n = raw ? parseInt(raw, 10) : 0;
        if (Number.isFinite(n) && n >= 0) counter = n;
      } catch (_) {}
      counter += 1;
      try { localStorage.setItem('pulse:projectCounter', String(counter)); } catch (_) {}

      const name = `Project ${counter}`;
      const payload = { html, name };
      const endpoint = '/api/sites';
      const method = 'POST';

      try {
        const resp = await fetch(endpoint, {
          method,
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
        });
        const data = await resp.json().catch(() => null);
        if (!resp.ok || !data || data.error) {
          
        }
      } catch (_) {
        
      }
    }

    const messagesEl = document.getElementById('messages');

    const chatForm = document.getElementById('chat-form');
    const chatInput = document.getElementById('chat-input');
    const chatSendBtn = document.getElementById('chat-send');
    const preview = document.getElementById('preview');
    const openBtn = document.getElementById('open-new-tab');

    let pendingQueryPrompt = null;

    let editorInstance = null;
    let queuedEditorValue = null;
    let applyTimer = null;

    const CHAT_STORAGE_KEY = 'pulse:buildChat:v1';
    let currentSiteId = null;

    let chatHistory = [];

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
        const rawRefId = sessionStorage.getItem('pulse:referenceId');
        if (typeof rawRefId === 'string') referenceId = rawRefId;
      } catch (_) {}

      if (!referenceId) {
        try {
          const rawPayload = sessionStorage.getItem('pulse:referencePayload');

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
                    sessionStorage.setItem('pulse:referenceId', id);
                    sessionStorage.removeItem('pulse:referencePayload');
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

                
                saveCurrentSite();

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
      }
    })();

    (function bootstrapReferenceId() {
      try {
        const url = new URL(window.location.href);
        const ref = url.searchParams.get('ref');
        if (ref && typeof ref === 'string' && ref.trim()) {
          const clean = ref.trim();
          try { sessionStorage.setItem('pulse:referenceId', clean); } catch (_) {}
          url.searchParams.delete('ref');
          window.history.replaceState({}, '', url.pathname + url.search + url.hash);
        }
      } catch (_) {
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
        scheduleAutosave();
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