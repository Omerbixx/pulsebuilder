      document.addEventListener('DOMContentLoaded', () => {
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

        const promptTextarea = document.getElementById('prompt-textarea');
        const generateButton = document.getElementById('generate-btn');
        const addDetailsButton = document.getElementById('add-details-btn');
        const referenceFilesInput = document.getElementById('reference-files-input');
        const referenceFilesStatus = document.getElementById('reference-files-status');
        const homeAccountStatus = document.getElementById('home-account-status');
        const homeAccountButton = document.getElementById('home-account-button');
        const recentSitesSection = document.getElementById('recent-sites-section');
        const recentSitesBody = document.getElementById('recent-sites-body');

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

        async function promptCredentials() {
          const email = window.prompt('Email:');
          if (!email) return null;
          const password = window.prompt('Password:');
          if (!password) return null;
          return { email: email.trim(), password };
        }

        async function handleHomeAccountClick() {
          const user = await fetchCurrentUser();
          if (!user) {
            const creds = await promptCredentials();
            if (!creds) return;
            const mode = window.confirm('OK = Sign up, Cancel = Log in') ? 'signup' : 'login';
            const endpoint = mode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
            try {
              const resp = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(creds)
              });
              const data = await resp.json().catch(() => null);
              if (!resp.ok || !data || data.error) {
                window.alert(data && data.error ? data.error : 'Auth failed.');
                return;
              }
              await refreshAccountStatus();
            } catch (_) {
              window.alert('Auth failed.');
            }
            return;
          }

          const choice = window.confirm('OK = Log out, Cancel = stay signed in');
          if (!choice) return;
          try {
            await fetch('/api/auth/logout', {
              method: 'POST',
              credentials: 'include'
            });
          } catch (_) {}
          await refreshAccountStatus();
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
            const sites = Array.isArray(data.sites) ? data.sites.slice(0, 6) : [];
            if (!sites.length) {
              recentSitesBody.textContent = 'No saved sites yet.';
              return;
            }
            recentSitesBody.innerHTML = '';
            sites.forEach((site) => {
              const card = document.createElement('button');
              card.type = 'button';
              card.className = 'w-full text-left panel rounded-2xl px-4 py-3 hover:bg-white transition flex flex-col gap-1';
              const title = document.createElement('div');
              title.className = 'font-semibold text-gray-900';
              const meta = document.createElement('div');
              meta.className = 'text-xs text-gray-500';
              meta.textContent = site.updatedAt ? new Date(site.updatedAt).toLocaleString() : '';
              card.appendChild(title);
              card.appendChild(meta);
              card.addEventListener('click', () => {
                window.open(`/view?site=${encodeURIComponent(site.id)}`, '_blank');
              });
              recentSitesBody.appendChild(card);
            });
          } catch (_) {
            recentSitesBody.textContent = 'Failed to load sites.';
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

        refreshAccountStatus();
      });