      document.addEventListener('DOMContentLoaded', () => {
        try { localStorage.clear(); } catch (_) {}
        try { sessionStorage.clear(); } catch (_) {}
        try {
          const cookies = document.cookie ? document.cookie.split(';') : [];
          for (const c of cookies) {
            const eqPos = c.indexOf('=');
            const name = (eqPos > -1 ? c.substr(0, eqPos) : c).trim();
            if (!name) continue;
            if (name === 'pulse_refs' || name === 'pulse_refs_uses' || name === 'pulse_auth') continue;
            document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
          }
        } catch (_) {}

        const promptTextarea = document.getElementById('prompt-textarea');
        const generateButton = document.getElementById('generate-btn');
        const addDetailsButton = document.getElementById('add-details-btn');
        const referenceFilesInput = document.getElementById('reference-files-input');
        const referenceFilesStatus = document.getElementById('reference-files-status');
        const homeAccountStatus = document.getElementById('home-account-status');
        const homeAccountButton = document.getElementById('home-account-button');
        const recentSitesSection = document.getElementById('recent-sites-section');
        const recentSitesBody = document.getElementById('recent-sites-body');
        const recentSitesPrev = document.getElementById('recent-sites-prev');
        const recentSitesNext = document.getElementById('recent-sites-next');
        const recentSitesPageLabel = document.getElementById('recent-sites-page');

        const RECENT_SITES_PER_PAGE = 6;
        let recentSitesAll = [];
        let recentSitesCurrentPage = 1;

        const authModalBackdrop = document.getElementById('auth-modal-backdrop');
        const authModalClose = document.getElementById('auth-modal-close');
        const authModalTitle = document.getElementById('auth-modal-title');
        const authModalSubtitle = document.getElementById('auth-modal-subtitle');
        const authModalError = document.getElementById('auth-modal-error');
        const authModalForm = document.getElementById('auth-modal-form');
        const authModalLogout = document.getElementById('auth-modal-logout');
        const authEmailInput = document.getElementById('auth-email');
        const authPasswordInput = document.getElementById('auth-password');
        const authLoginBtn = document.getElementById('auth-login');
        const authSignupBtn = document.getElementById('auth-signup');
        const authLogoutCancelBtn = document.getElementById('auth-logout-cancel');
        const authLogoutConfirmBtn = document.getElementById('auth-logout-confirm');

        let authModalAuthResolver = null;
        let authModalLogoutResolver = null;

        function openAuthModalBase() {
          if (!authModalBackdrop) return;
          authModalBackdrop.classList.remove('hidden');
          authModalBackdrop.classList.add('flex');
        }

        function closeAuthModal() {
          if (!authModalBackdrop) return;
          authModalBackdrop.classList.add('hidden');
          authModalBackdrop.classList.remove('flex');
          if (authModalError) {
            authModalError.textContent = '';
            authModalError.classList.add('hidden');
          }
          if (authEmailInput) authEmailInput.value = '';
          if (authPasswordInput) authPasswordInput.value = '';
          if (authModalAuthResolver) {
            authModalAuthResolver(null);
            authModalAuthResolver = null;
          }
          if (authModalLogoutResolver) {
            authModalLogoutResolver(false);
            authModalLogoutResolver = null;
          }
        }

        function showAuthFormMode() {
          if (authModalForm) authModalForm.classList.remove('hidden');
          if (authModalLogout) authModalLogout.classList.add('hidden');
          if (authModalTitle) authModalTitle.textContent = 'Sign in to Pulse';
          if (authModalSubtitle) authModalSubtitle.textContent = 'Use your email to log in or create an account.';
        }

        function showLogoutMode() {
          if (authModalForm) authModalForm.classList.add('hidden');
          if (authModalLogout) authModalLogout.classList.remove('hidden');
          if (authModalTitle) authModalTitle.textContent = 'Log out';
          if (authModalSubtitle) authModalSubtitle.textContent = '';
        }

        function showAuthError(message) {
          if (!authModalError) return;
          authModalError.textContent = message || '';
          if (message) {
            authModalError.classList.remove('hidden');
          } else {
            authModalError.classList.add('hidden');
          }
        }

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

        async function promptCredentials() {
          if (!authModalBackdrop || !authModalForm) return null;
          showAuthFormMode();
          showAuthError('');
          openAuthModalBase();

          return new Promise((resolve) => {
            authModalAuthResolver = resolve;

            const handle = (mode) => {
              if (!authEmailInput || !authPasswordInput) {
                resolve(null);
                authModalAuthResolver = null;
                closeAuthModal();
                return;
              }
              const email = authEmailInput.value.trim();
              const password = authPasswordInput.value;
              if (!email || !password) {
                showAuthError('Email and password are required.');
                return;
              }
              showAuthError('');
              const result = { email, password, mode };
              authModalAuthResolver = null;
              closeAuthModal();
              resolve(result);
            };

            if (authLoginBtn) {
              authLoginBtn.onclick = () => handle('login');
            }
            if (authSignupBtn) {
              authSignupBtn.onclick = () => handle('signup');
            }
          });
        }

        async function promptLogoutConfirm() {
          if (!authModalBackdrop || !authModalLogout) return false;
          showLogoutMode();
          showAuthError('');
          openAuthModalBase();

          return new Promise((resolve) => {
            authModalLogoutResolver = resolve;
            if (authLogoutCancelBtn) {
              authLogoutCancelBtn.onclick = () => {
                authModalLogoutResolver = null;
                closeAuthModal();
                resolve(false);
              };
            }
            if (authLogoutConfirmBtn) {
              authLogoutConfirmBtn.onclick = () => {
                authModalLogoutResolver = null;
                closeAuthModal();
                resolve(true);
              };
            }
          });
        }

        async function handleHomeAccountClick() {
          const user = await fetchCurrentUser();
          if (!user) {
            const creds = await promptCredentials();
            if (!creds) return;
            const mode = creds.mode === 'signup' ? 'signup' : 'login';
            const endpoint = mode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
            const payload = { email: creds.email, password: creds.password };
            try {
              const resp = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload)
              });
              const data = await resp.json().catch(() => null);
              if (!resp.ok || !data || data.error) {
                const msg = data && data.error ? data.error : 'Auth failed.';
                showAuthFormMode();
                openAuthModalBase();
                showAuthError(msg);
                return;
              }
              await refreshAccountStatus();
            } catch (_) {
              showAuthFormMode();
              openAuthModalBase();
              showAuthError('Auth failed.');
            }
            return;
          }

          const choice = await promptLogoutConfirm();
          if (!choice) return;
          try {
            await fetch('/api/auth/logout', {
              method: 'POST',
              credentials: 'include'
            });
          } catch (_) {}
          await refreshAccountStatus();
        }

        async function refreshAccountStatus() {
          const user = await fetchCurrentUser();
          if (!homeAccountStatus || !homeAccountButton) return;
          if (!user) {
            homeAccountStatus.textContent = '';
            homeAccountButton.textContent = 'Account';
            if (recentSitesSection) {
              recentSitesSection.classList.add('hidden');
            }
            return;
          }
          homeAccountStatus.textContent = `Signed in as ${user.email || 'user'}`;
          homeAccountButton.textContent = 'Account';
          if (recentSitesSection) {
            recentSitesSection.classList.remove('hidden');
          }
          loadRecentSites();
        }

        async function loadRecentSites() {
          if (!recentSitesBody) return;
          try {
            const resp = await fetch('/api/sites', {
              method: 'GET',
              credentials: 'include'
            });
            const data = await resp.json().catch(() => null);
            if (!resp.ok || !data || data.error) {
              recentSitesBody.textContent = 'Failed to load sites.';
              return;
            }
            const sites = Array.isArray(data.sites) ? data.sites : [];
            if (!sites.length) {
              recentSitesAll = [];
              renderRecentSitesPage();
              return;
            }
            recentSitesAll = sites;
            recentSitesCurrentPage = 1;
            renderRecentSitesPage();
          } catch (_) {
            recentSitesBody.textContent = 'Failed to load sites.';
          }
        }

        function renderRecentSitesPage() {
          if (!recentSitesBody) return;

          const total = recentSitesAll.length;
          if (!total) {
            recentSitesBody.textContent = 'No saved sites yet.';
            if (recentSitesPageLabel) recentSitesPageLabel.textContent = 'Page 1 / 1';
            if (recentSitesPrev) recentSitesPrev.disabled = true;
            if (recentSitesNext) recentSitesNext.disabled = true;
            return;
          }

          const totalPages = Math.max(1, Math.ceil(total / RECENT_SITES_PER_PAGE));
          if (recentSitesCurrentPage > totalPages) recentSitesCurrentPage = totalPages;
          if (recentSitesCurrentPage < 1) recentSitesCurrentPage = 1;

          const start = (recentSitesCurrentPage - 1) * RECENT_SITES_PER_PAGE;
          const end = start + RECENT_SITES_PER_PAGE;
          const slice = recentSitesAll.slice(start, end);

          recentSitesBody.innerHTML = '';
          slice.forEach((site, index) => {
            const globalIndex = start + index;
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'w-full text-left panel rounded-2xl px-4 py-4 hover:bg-white transition flex items-center gap-3 h-24';

            const iconWrap = document.createElement('div');
            iconWrap.className = 'w-10 h-10 rounded-xl bg-black text-white flex items-center justify-center flex-shrink-0';
            const icon = document.createElement('i');
            icon.className = 'fas fa-file-code text-sm';
            iconWrap.appendChild(icon);

            const textWrap = document.createElement('div');
            textWrap.className = 'flex flex-col justify-between flex-1 min-w-0';

            const title = document.createElement('div');
            title.className = 'font-semibold text-gray-900 truncate';
            title.textContent = `Project ${globalIndex + 1}`;

            const meta = document.createElement('div');
            meta.className = 'text-xs text-gray-500';
            meta.textContent = site.updatedAt ? new Date(site.updatedAt).toLocaleString() : '';

            textWrap.appendChild(title);
            textWrap.appendChild(meta);

            card.appendChild(iconWrap);
            card.appendChild(textWrap);

            card.addEventListener('click', () => {
              window.open(`/view?site=${encodeURIComponent(site.id)}`, '_blank');
            });
            recentSitesBody.appendChild(card);
          });

          if (recentSitesPageLabel) {
            recentSitesPageLabel.textContent = `Page ${recentSitesCurrentPage} / ${totalPages}`;
          }
          if (recentSitesPrev) {
            recentSitesPrev.disabled = recentSitesCurrentPage <= 1;
          }
          if (recentSitesNext) {
            recentSitesNext.disabled = recentSitesCurrentPage >= totalPages;
          }
        }

        if (promptTextarea && generateButton) {
          promptTextarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              generateButton.click();
            }
          });
        }

        if (generateButton) {
          generateButton.addEventListener('click', (e) => {
            e.preventDefault();
            const userPrompt = (promptTextarea?.value || '').trim();

            if (!userPrompt) {
              promptTextarea?.focus();
              return;
            }

            let refIdParam = '';
            try {
              const refId = sessionStorage.getItem('pulse:referenceId');
              if (typeof refId === 'string' && refId.trim()) {
                refIdParam = `&ref=${encodeURIComponent(refId.trim())}`;
              }
            } catch (_) {}

            try { sessionStorage.setItem('pulse:lastPrompt', userPrompt); } catch (_) {}
            window.location.href = `/build?query=${encodeURIComponent(userPrompt)}${refIdParam}`;
          });
        }

        if (addDetailsButton && referenceFilesInput) {
          addDetailsButton.addEventListener('click', () => {
            referenceFilesInput.click();
          });

          function readFileAsText(file) {
            return new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () => {
                const text = typeof reader.result === 'string' ? reader.result : '';
                resolve(text);
              };
              reader.onerror = () => resolve('');
              reader.readAsText(file);
            });
          }

          referenceFilesInput.addEventListener('change', async () => {
            const files = Array.from(referenceFilesInput.files || []);
            if (!files.length) return;

            const allowedExts = ['.txt','.md','.html','.css','.js','.json','.xml','.yaml','.yml','.csv','.pdf','.docx','.odt','.rtf'];

            const payloadFiles = [];
            const selectedNames = [];

            for (const file of files) {
              const name = file.name || '';
              const lower = name.toLowerCase();
              const ok = allowedExts.some(ext => lower.endsWith(ext));
              if (!ok || !name) continue;

              selectedNames.push(name);

              const isTextLike = /\.(txt|md|html|css|js|json|xml|yaml|yml|csv)$/i.test(name);
              let content = '';
              if (isTextLike) {
                content = await readFileAsText(file);
              }

              payloadFiles.push({
                name,
                type: file.type || 'application/octet-stream',
                content
              });
            }

            if (!payloadFiles.length) return;

            try {
              if (referenceFilesStatus) {
                referenceFilesStatus.textContent = 'Uploading reference files…';
              }

              const resp = await fetch('/api/references', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ files: payloadFiles })
              });

              if (!resp.ok) {
                if (referenceFilesStatus) {
                  referenceFilesStatus.textContent = 'Failed to attach reference files.';
                }
                return;
              }

              const data = await resp.json().catch(() => null);
              const refId = data && typeof data.id === 'string' ? data.id : '';
              if (refId) {
                try {
                  sessionStorage.setItem('pulse:referenceId', refId);
                  sessionStorage.removeItem('pulse:referencePayload');
                } catch (_) {}
              }

              if (referenceFilesStatus && selectedNames.length) {
                referenceFilesStatus.textContent = 'Attached files: ' + selectedNames.join(', ');
              }
            } catch (_) {
              if (referenceFilesStatus) {
                referenceFilesStatus.textContent = 'Failed to attach reference files.';
              }
            }
          });
        }

        const featureCards = document.querySelectorAll('.feature-card');
        featureCards.forEach(card => {
          card.addEventListener('mouseenter', () => {
            card.classList.add('shadow-lg');
          });
          card.addEventListener('mouseleave', () => {
            card.classList.remove('shadow-lg');
          });
        });

        const hiddenCards = document.querySelectorAll('.feature-card-hidden');
        if ('IntersectionObserver' in window) {
          const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
              if (entry.isIntersecting) {
                entry.target.classList.remove('feature-card-hidden');
                observer.unobserve(entry.target);
              }
            });
          }, { threshold: 0.15 });

          hiddenCards.forEach(card => observer.observe(card));
        } else {
          hiddenCards.forEach(card => card.classList.remove('feature-card-hidden'));
        }

        const backToTop = document.getElementById('back-to-top-link');
        if (backToTop) {
          backToTop.addEventListener('click', (event) => {
            event.preventDefault();
            window.scrollTo({ top: 0, behavior: 'smooth' });
          });

          const toggleBackToTop = () => {
            if (window.scrollY > 400) {
              backToTop.classList.remove('back-to-top-hidden');
              backToTop.classList.add('back-to-top-visible');
            } else {
              backToTop.classList.add('back-to-top-hidden');
              backToTop.classList.remove('back-to-top-visible');
            }
          };

          toggleBackToTop();
          window.addEventListener('scroll', toggleBackToTop);
        }

        const internalLinks = document.querySelectorAll('a[href^="#"]');
        internalLinks.forEach(link => {
          link.addEventListener('click', (event) => {
            const href = link.getAttribute('href');
            if (!href || href === '#') return;
            const target = document.querySelector(href);
            if (target) {
              event.preventDefault();
              target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          });
        });

        const cursorCircle = document.createElement('div');
        cursorCircle.className = 'cursor-circle';
        document.body.appendChild(cursorCircle);

        let lastX = null;
        let lastY = null;

        document.addEventListener('mousemove', (event) => {
          const x = event.clientX;
          const y = event.clientY;
          lastX = x;
          lastY = y;
          cursorCircle.style.transform = `translate(${x}px, ${y}px)`;
        });

        document.addEventListener('touchstart', () => {
          cursorCircle.style.display = 'none';
        }, { once: true });

        if (homeAccountButton) {
          homeAccountButton.addEventListener('click', () => {
            handleHomeAccountClick();
          });
        }

        if (authModalClose) {
          authModalClose.addEventListener('click', () => {
            closeAuthModal();
          });
        }

        if (authModalBackdrop) {
          authModalBackdrop.addEventListener('click', (event) => {
            if (event.target === authModalBackdrop) {
              closeAuthModal();
            }
          });
        }

        if (recentSitesPrev) {
          recentSitesPrev.addEventListener('click', () => {
            if (recentSitesCurrentPage > 1) {
              recentSitesCurrentPage -= 1;
              renderRecentSitesPage();
            }
          });
        }

        if (recentSitesNext) {
          recentSitesNext.addEventListener('click', () => {
            const totalPages = Math.max(1, Math.ceil(recentSitesAll.length / RECENT_SITES_PER_PAGE));
            if (recentSitesCurrentPage < totalPages) {
              recentSitesCurrentPage += 1;
              renderRecentSitesPage();
            }
          });
        }

        refreshAccountStatus();
      });