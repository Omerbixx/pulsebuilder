
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
 
app.use(express.json({ limit: '2mb' }));

function isSerperEnabled() {
  return !!process.env['SERPER_API_KEY'];
}

// --- Auth & persistence (server-only) ---

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabaseAdmin = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })
  : null;

async function getUserFromRequest(req) {
  if (!supabaseAdmin) return null;
  const cookies = parseCookies(req);
  const token = cookies['pulse_auth'] || '';
  if (!token) return null;
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data || !data.user) return null;
    return data.user;
  } catch (_) {
    return null;
  }
}

function setAuthCookie(res, token) {
  if (!token) return;
  const maxAgeSeconds = 60 * 60 * 24 * 7; // 7 days
  const cookieParts = [
    `pulse_auth=${token}`,
    `Max-Age=${maxAgeSeconds}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (process.env.NODE_ENV === 'production') {
    cookieParts.push('Secure');
  }
  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function clearAuthCookie(res) {
  const parts = [
    'pulse_auth=;',
    'Path=/',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'SameSite=Lax'
  ];
  if (process.env.NODE_ENV === 'production') {
    parts.push('Secure');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

async function requireAuth(req, res, next) {
  const user = await getUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: 'Not authenticated.' });
    return;
  }
  req.user = user;
  next();
}

function extractSearchRequests(text) {
  if (!text || typeof text !== 'string') return [];

  const out = [];

  const infoRe = /<search\.info>([\s\S]*?)<\/search\.info>/gi;
  const imagesRe = /<search\.images>([\s\S]*?)<\/(search\.images|search\.online)>/gi;
  const videosRe = /<search\.videos>([\s\S]*?)<\/search\.videos>/gi;

  let m;
  while ((m = infoRe.exec(text)) !== null) {
    const q = (m[1] || '').trim();
    if (q) out.push({ type: 'info', q });
  }

  while ((m = imagesRe.exec(text)) !== null) {
    const q = (m[1] || '').trim();
    if (q) out.push({ type: 'images', q });
  }

  while ((m = videosRe.exec(text)) !== null) {
    const q = (m[1] || '').trim();
    if (q) out.push({ type: 'videos', q });
  }

  return out;
}

function stripSearchTags(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<search\.info>[\s\S]*?<\/search\.info>/gi, '')
    .replace(/<search\.images>[\s\S]*?<\/(search\.images|search\.online)>/gi, '')
    .replace(/<search\.videos>[\s\S]*?<\/search\.videos>/gi, '')
    .trim();
}

function stripSearchTagsFromStream(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<search\.info>[\s\S]*?<\/search\.info>\s*/gi, '')
    .replace(/<search\.images>[\s\S]*?<\/(search\.images|search\.online)>\s*/gi, '')
    .replace(/<search\.videos>[\s\S]*?<\/search\.videos>\s*/gi, '');
}

function createSearchTagStreamFilter() {
  const startInfo = '<search.info>';
  const startImages = '<search.images>';
  const startVideos = '<search.videos>';
  const endInfo = '</search.info>';
  const endImages = '</search.images>';
  const endOnline = '</search.online>';
  const endVideos = '</search.videos>';
  const allTags = [startInfo, startImages, startVideos, endInfo, endImages, endOnline, endVideos].map((s) =>
    s.toLowerCase()
  );
  const maxTagLen = Math.max(...allTags.map((s) => s.length));

  let carry = '';
  let mode = null; // 'info' | 'images' | 'videos' | null

  function longestPartialSuffix(s) {
    const lower = s.toLowerCase();
    let best = 0;
    for (const tag of allTags) {
      const maxK = Math.min(tag.length - 1, lower.length);
      for (let k = maxK; k >= 1; k--) {
        if (lower.endsWith(tag.slice(0, k))) {
          if (k > best) best = k;
          break;
        }
      }
    }
    return best;
  }

  return function filterChunk(chunk) {
    const incoming = typeof chunk === 'string' ? chunk : '';
    if (!incoming && !carry) return '';

    let text = carry + incoming;
    carry = '';

    let out = '';
    let i = 0;

    while (i < text.length) {
      if (!mode) {
        const idx = text.toLowerCase().indexOf('<search.', i);
        if (idx === -1) {
          out += text.slice(i);
          i = text.length;
          break;
        }

        out += text.slice(i, idx);
        const restLower = text.slice(idx).toLowerCase();

        if (restLower.startsWith(startInfo)) {
          mode = 'info';
          i = idx + startInfo.length;
          continue;
        }

        if (restLower.startsWith(startImages)) {
          mode = 'images';
          i = idx + startImages.length;
          continue;
        }

        if (restLower.startsWith(startVideos)) {
          mode = 'videos';
          i = idx + startVideos.length;
          continue;
        }

        // Not an exact start tag; emit one char to avoid infinite loop.
        out += text.slice(idx, idx + 1);
        i = idx + 1;
        continue;
      }

      // Inside a search tag block: drop everything until the corresponding end tag.
      const restLower = text.slice(i).toLowerCase();

      if (mode === 'info') {
        const endIdx = restLower.indexOf(endInfo);
        if (endIdx === -1) {
          // Still inside block; drop remainder.
          i = text.length;
          break;
        }
        i = i + endIdx + endInfo.length;
        mode = null;
        continue;
      }

      if (mode === 'images') {
        let endIdx = restLower.indexOf(endImages);
        let endLen = endImages.length;
        const altIdx = restLower.indexOf(endOnline);
        if (endIdx === -1 || (altIdx !== -1 && altIdx < endIdx)) {
          endIdx = altIdx;
          endLen = endOnline.length;
        }

        if (endIdx === -1) {
          i = text.length;
          break;
        }

        i = i + endIdx + endLen;
        mode = null;
        continue;
      }

      if (mode === 'videos') {
        const endIdx = restLower.indexOf(endVideos);
        if (endIdx === -1) {
          i = text.length;
          break;
        }

        i = i + endIdx + endVideos.length;
        mode = null;
        continue;
      }
    }

    // Prevent partial tag fragments from leaking across chunk boundaries.
    if (!mode && out) {
      const k = longestPartialSuffix(out.slice(-maxTagLen));
      if (k > 0) {
        carry = out.slice(-k);
        out = out.slice(0, -k);
      }
    } else if (mode && text) {
      // If we're inside a tag block, keep a small tail just in case the closing tag starts at boundary.
      carry = text.slice(Math.max(0, text.length - maxTagLen));
    }

    return out;
  };
}

async function serperRequest(pathname, q, page) {
  const key = process.env['SERPER_API_KEY'];
  if (!key) return null;
  if (!q || typeof q !== 'string') return null;

  try {
    const resp = await fetch(`https://google.serper.dev/${pathname}`, {
      method: 'POST',
      headers: {
        'X-API-KEY': key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(
        page && Number.isFinite(page) && page > 1
          ? { q, page: Math.floor(page) }
          : { q }
      )
    });
    if (!resp.ok) return null;
    return await resp.json().catch(() => null);
  } catch (_) {
    return null;
  }
}

async function runSearches(requests) {
  const results = [];

  for (const r of requests) {
    if (r.type === 'images') {
      const pages = [1];
      const allImages = [];
      for (const page of pages) {
        const data = await serperRequest('images', r.q, page);
        const images = Array.isArray(data?.images) ? data.images : [];
        allImages.push(...images);
      }
      const imageUrls = allImages
        .map((img) => img?.imageUrl)
        .filter(Boolean)
        .slice(0, 10);
      results.push({ type: 'images', q: r.q, raw: null, imageUrls });
      continue;
    }

    if (r.type === 'info') {
      const pages = [1];
      const allOrganic = [];
      for (const page of pages) {
        const data = await serperRequest('search', r.q, page);
        const organic = Array.isArray(data?.organic) ? data.organic : [];
        allOrganic.push(...organic);
      }
      const organic = allOrganic.slice(0, 50);
      results.push({ type: 'info', q: r.q, raw: null, organic });
      continue;
    }

    if (r.type === 'videos') {
      const pages = [1];
      const allVideos = [];
      for (const page of pages) {
        const data = await serperRequest('videos', r.q, page);
        const videos = Array.isArray(data?.videos) ? data.videos : [];
        allVideos.push(...videos);
      }
      const videoLinks = allVideos
        .map((v) => v?.link)
        .filter(Boolean)
        .slice(0, 5);
      results.push({ type: 'videos', q: r.q, raw: null, videoLinks });
    }
  }

  return results;
}

function readSystemPrompt() {
  try {
    return fs.readFileSync(path.join(__dirname, 'system.md'), 'utf8');
  } catch (_) {
    return '';
  }
}

function getApiKeys() {
  const raw = process.env['BIXX_API_KEY'];
  if (!raw) return [];

  // Support either a single key or a JSON array of keys.
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((k) => typeof k === 'string' && k.trim().length > 0);
    }
  } catch (_) {
    // Not JSON; fall through and treat as single key.
  }

  if (typeof raw === 'string' && raw.trim().length > 0) return [raw.trim()];
  return [];
}

function getApiKeysShuffled() {
  const keys = getApiKeys().slice();
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = keys[i];
    keys[i] = keys[j];
    keys[j] = tmp;
  }
  return keys;
}

async function getClient(apiKey) {
  const mod = await import('@cerebras/cerebras_cloud_sdk');
  const ProviderClient = mod.default || mod;
  return new ProviderClient({
    apiKey
  });
}

function isRateLimitError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.status === 429) return true;
  const code = err?.error?.code || err?.code;
  if (code && typeof code === 'string' && code.toLowerCase().includes('too_many')) return true;
  return false;
}

async function planSearches(aiClient, systemPrompt, userText, currentHtml) {
  if (!isSerperEnabled()) return [];

  try {
    const plannerMessages = [
      {
        role: 'system',
        content: systemPrompt || ''
      },
      {
        role: 'user',
        content: `User request:\n${stripSearchTags(userText)}\n\nCurrent HTML (if any, line-numbered):\n\n\`\`\`html\n${currentHtmlNumbered || ''}\n\`\`\`\n`
      }
    ];

    const resp = await aiClient.chat.completions.create({
      messages: plannerMessages,
      model: 'qwen-3-235b-a22b-instruct-2507',
      stream: false,
      max_completion_tokens: 400,
      temperature: 0.2,
      top_p: 0.8
    });

    const text = resp?.choices?.[0]?.message?.content || '';
    return extractSearchRequests(text);
  } catch (_) {
    return [];
  }
}

function formatSearchContext(searchResults) {
  let ctx = '';

  for (const r of searchResults) {
    if (r.type === 'info') {
      ctx += `\n[Web info for: ${r.q}]\n`;
      for (const item of r.organic || []) {
        const title = item?.title || '';
        const link = item?.link || '';
        const snippet = item?.snippet || '';
        ctx += `- ${title} (${link})\n  ${snippet}\n`;
      }
    }

    if (r.type === 'images') {
      const count = Array.isArray(r.imageUrls) ? r.imageUrls.length : 0;
      ctx += `\n[Image results for: ${r.q}]\n`;
      ctx += `- Total image links available: ${count}\n`;
      for (const u of r.imageUrls || []) {
        ctx += `- ${u}\n`;
      }
    }

    if (r.type === 'videos') {
      const count = Array.isArray(r.videoLinks) ? r.videoLinks.length : 0;
      ctx += `\n[Video results for: ${r.q}]\n`;
      ctx += `- Total video links available: ${count}\n`;
      for (const link of r.videoLinks || []) {
        ctx += `- ${link}\n`;
      }
    }
  }

  return ctx.trim();
}

function getNoLeakSystemAddon() {
  return (
    'Rules:\n' +
    '- Never show <search.info>, <search.images>, or <search.videos> tags to the user.\n' +
    '- Do NOT output any <search.*> tags in the final answer. Tags are only allowed in the separate tool-request step.\n' +
    '- You MAY surface image, video, or info URLs to the user when it clearly helps them use or download assets.\n' +
    '- When using internet results, prefer summarizing and grouping them by query instead of dumping huge unstructured lists.\n'
  );
}

function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  if (!header || typeof header !== 'string') return {};
  const out = {};
  const parts = header.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    out[name] = value;
  }
  return out;
}

function verifyTurnstileSession(value, maxAgeMs) {
  if (!value || typeof value !== 'string') return false;
  const secret = getTurnstileSessionSecret();
  if (!secret) return false;

  const parts = value.split('.');
  if (parts.length !== 2) return false;
  const ts = parts[0];
  const sig = parts[1];
  if (!ts || !sig) return false;

  const expected = crypto.createHmac('sha256', secret).update(ts).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))) return false;

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  const now = Date.now();
  if (maxAgeMs && maxAgeMs > 0 && now - tsNum > maxAgeMs) return false;
  return true;
}

function signTurnstileSession(ts) {
  const secret = getTurnstileSessionSecret();
  if (!secret) return '';

  const tsString = typeof ts === 'number' && Number.isFinite(ts) ? String(ts) : String(Date.now());
  const sig = crypto.createHmac('sha256', secret).update(tsString).digest('hex');
  return `${tsString}.${sig}`;
}

function getTurnstileSiteKey() {
  const raw = process.env['TURNSTILE_SITE_KEY'] || '';
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed || trimmed.startsWith('#')) return '';
  return trimmed;
}

function getTurnstileSessionSecret() {
  const raw = process.env['TURNSTILE_SESSION_SECRET'] || process.env['TURNSTILE_SECRET_KEY'] || '';
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed || trimmed.startsWith('#')) return '';
  return trimmed;
}

function isTurnstileConfigured() {
  function isValid(v) {
    if (!v || typeof v !== 'string') return false;
    const trimmed = v.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('#')) return false;
    return true;
  }

  const site = process.env['TURNSTILE_SITE_KEY'];
  const secret = process.env['TURNSTILE_SECRET_KEY'] || process.env['TURNSTILE_SESSION_SECRET'];
  return isValid(site) && isValid(secret);
}

async function verifyTurnstileToken(token, remoteIp) {
  const secret = process.env['TURNSTILE_SECRET_KEY'];
  if (!isTurnstileConfigured()) {
    return { success: true, data: { disabled: true } };
  }
  if (!secret || !token) return { success: false };

  try {
    const params = new URLSearchParams();
    params.append('secret', secret);
    params.append('response', token);
    if (remoteIp) params.append('remoteip', remoteIp);

    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
    });

    if (!resp.ok) return { success: false };
    const data = await resp.json().catch(() => null);
    if (!data || typeof data.success !== 'boolean') return { success: false };
    return { success: !!data.success, data };
  } catch (_) {
    return { success: false };
  }
}

app.get('/api/health', (req, res) => {
  res.status(200).json({ ok: true });
});

app.get('/api/turnstile/site-key', (req, res) => {
  const siteKey = getTurnstileSiteKey();
  if (!siteKey) {
    res.status(404).json({ error: 'Turnstile not configured.' });
    return;
  }
  res.json({ siteKey });
});

app.post('/api/turnstile/verify', async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!token) {
    res.status(400).json({ success: false, error: 'Missing token.' });
    return;
  }

  const remoteIp = req.ip || req.connection?.remoteAddress || undefined;
  const result = await verifyTurnstileToken(token, remoteIp);
  if (!result.success) {
    res.status(400).json({ success: false, error: 'Verification failed.' });
    return;
  }

  const sessionValue = signTurnstileSession(Date.now());
  if (sessionValue) {
    const maxAgeSeconds = 30 * 60;
    const cookieParts = [
      `turnstile_ok=${sessionValue}`,
      `Max-Age=${maxAgeSeconds}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax'
    ];
    if (process.env.NODE_ENV === 'production') {
      cookieParts.push('Secure');
    }
    res.setHeader('Set-Cookie', cookieParts.join('; '));
  }

  res.json({ success: true });
});

// --- Generic auth endpoints (no Supabase exposure to frontend) ---

app.post('/api/auth/signup', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      res.status(500).json({ error: 'Auth not configured.' });
      return;
    }

    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }

    const { data: signUpData, error: signUpError } = await supabaseAdmin.auth.signUp({
      email,
      password
    });

    if (signUpError) {
      res.status(400).json({ error: 'Could not sign up.' });
      return;
    }

    const { data: tokenData, error: tokenError } = await supabaseAdmin.auth.signInWithPassword({
      email,
      password
    });

    if (tokenError || !tokenData || !tokenData.session || !tokenData.session.access_token) {
      res.status(400).json({ error: 'Could not sign in after sign up.' });
      return;
    }

    setAuthCookie(res, tokenData.session.access_token);

    res.json({ ok: true, user: { id: tokenData.user.id, email } });
  } catch (err) {
    res.status(500).json({ error: 'Auth error.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    if (!supabaseAdmin) {
      res.status(500).json({ error: 'Auth not configured.' });
      return;
    }

    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }

    const { data, error } = await supabaseAdmin.auth.signInWithPassword({ email, password });
    if (error || !data || !data.session || !data.session.access_token) {
      res.status(400).json({ error: 'Invalid credentials.' });
      return;
    }

    setAuthCookie(res, data.session.access_token);

    res.json({ ok: true, user: { id: data.user.id, email } });
  } catch (err) {
    res.status(500).json({ error: 'Auth error.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', async (req, res) => {
  if (!supabaseAdmin) {
    res.status(500).json({ error: 'Auth not configured.' });
    return;
  }
  const user = await getUserFromRequest(req);
  if (!user) {
    res.json({ authenticated: false });
    return;
  }
  res.json({ authenticated: true, user: { id: user.id, email: user.email || '' } });
});

app.post('/api/references', async (req, res) => {
  try {
    const body = req.body || {};
    const files = Array.isArray(body.files) ? body.files : [];
    if (!files.length) {
      res.status(400).json({ error: 'No files provided.' });
      return;
    }

    const allowedExts = ['.txt','.md','.html','.css','.js','.json','.xml','.yaml','.yml','.csv','.pdf','.docx','.odt','.rtf'];

    let context = '';
    for (const f of files) {
      if (!f || typeof f.name !== 'string') continue;
      const name = f.name.trim();
      if (!name) continue;
      const lower = name.toLowerCase();
      const ok = allowedExts.some((ext) => lower.endsWith(ext));
      if (!ok) continue;

      const rawContent = typeof f.content === 'string' ? f.content : '';
      const content = rawContent.slice(0, 20000);

      context += `[User file: ${name}]\n`;
      if (content) {
        context += content + '\n\n';
      } else {
        context += '(No text content captured for this file.)\n\n';
      }
    }

    if (!context) {
      res.status(400).json({ error: 'No valid files after filtering.' });
      return;
    }

    // Store reference context in a cookie instead of writing to disk.
    const maxCookieChars = 3500; // keep well under typical cookie size limits per cookie
    const clipped = context.length > maxCookieChars ? context.slice(0, maxCookieChars) : context;
    const value = encodeURIComponent(clipped);

    const cookieParts = [
      `pulse_refs=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=1800' // 30 minutes
    ];
    if (process.env.NODE_ENV === 'production') {
      cookieParts.push('Secure');
    }
    res.setHeader('Set-Cookie', cookieParts.join('; '));

    console.log('[references] Stored context in cookie', {
      approxChars: clipped.length,
      fileCount: files.length
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Error in /api/references:', err);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// --- Site storage endpoints (server-only persistence) ---

app.get('/api/sites', requireAuth, async (req, res) => {
  if (!supabaseAdmin) {
    res.status(500).json({ error: 'Storage not configured.' });
    return;
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('sites')
      .select('id, name, created_at, updated_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) {
      res.status(500).json({ error: 'Failed to load sites.' });
      return;
    }
    res.json({ sites: (data || []).map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load sites.' });
  }
});

app.get('/api/sites/:id', requireAuth, async (req, res) => {
  if (!supabaseAdmin) {
    res.status(500).json({ error: 'Storage not configured.' });
    return;
  }
  const id = req.params.id;
  try {
    const { data, error } = await supabaseAdmin
      .from('sites')
      .select('id, name, html, user_id')
      .eq('id', id)
      .maybeSingle();
    if (error || !data) {
      res.status(404).json({ error: 'Site not found.' });
      return;
    }
    if (data.user_id !== req.user.id) {
      res.status(403).json({ error: 'Forbidden.' });
      return;
    }
    res.json({ id: data.id, name: data.name, html: data.html });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load site.' });
  }
});

app.post('/api/sites', requireAuth, async (req, res) => {
  if (!supabaseAdmin) {
    res.status(500).json({ error: 'Storage not configured.' });
    return;
  }
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const html = typeof req.body?.html === 'string' ? req.body.html : '';
  if (!name || !html) {
    res.status(400).json({ error: 'Name and html are required.' });
    return;
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('sites')
      .insert({ user_id: req.user.id, name, html })
      .select('id, name, created_at, updated_at')
      .maybeSingle();
    if (error || !data) {
      res.status(500).json({ error: 'Failed to save site.' });
      return;
    }
    res.json({
      ok: true,
      site: {
        id: data.id,
        name: data.name,
        createdAt: data.created_at,
        updatedAt: data.updated_at
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save site.' });
  }
});

app.put('/api/sites/:id', requireAuth, async (req, res) => {
  if (!supabaseAdmin) {
    res.status(500).json({ error: 'Storage not configured.' });
    return;
  }
  const id = req.params.id;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : undefined;
  const html = typeof req.body?.html === 'string' ? req.body.html : undefined;
  if (!name && !html) {
    res.status(400).json({ error: 'Nothing to update.' });
    return;
  }
  try {
    const { data: existing, error: loadError } = await supabaseAdmin
      .from('sites')
      .select('id, user_id')
      .eq('id', id)
      .maybeSingle();
    if (loadError || !existing) {
      res.status(404).json({ error: 'Site not found.' });
      return;
    }
    if (existing.user_id !== req.user.id) {
      res.status(403).json({ error: 'Forbidden.' });
      return;
    }

    const updatePayload = {};
    if (name !== undefined) updatePayload.name = name;
    if (html !== undefined) updatePayload.html = html;

    const { data, error } = await supabaseAdmin
      .from('sites')
      .update(updatePayload)
      .eq('id', id)
      .select('id, name, created_at, updated_at')
      .maybeSingle();
    if (error || !data) {
      res.status(500).json({ error: 'Failed to update site.' });
      return;
    }
    res.json({
      ok: true,
      site: {
        id: data.id,
        name: data.name,
        createdAt: data.created_at,
        updatedAt: data.updated_at
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update site.' });
  }
});

// Read-only HTML view of a saved site. Opens in a separate tab.
app.get('/sites/view/:id', requireAuth, async (req, res) => {
  if (!supabaseAdmin) {
    res.status(500).send('Storage not configured.');
    return;
  }
  const id = req.params.id;
  try {
    const { data, error } = await supabaseAdmin
      .from('sites')
      .select('id, html, user_id')
      .eq('id', id)
      .maybeSingle();
    if (error || !data) {
      res.status(404).send('Site not found.');
      return;
    }
    if (data.user_id !== req.user.id) {
      res.status(403).send('Forbidden.');
      return;
    }

    const html = typeof data.html === 'string' ? data.html : '';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html || '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Empty project</title></head><body></body></html>');
  } catch (err) {
    res.status(500).send('Failed to load site.');
  }
});

app.post('/api/chat/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  if (isTurnstileConfigured()) {
    const cookies = parseCookies(req);
    const sessionCookie = cookies['turnstile_ok'] || '';
    const maxAgeMs = 30 * 60 * 1000;
    if (!verifyTurnstileSession(sessionCookie, maxAgeMs)) {
      res.write(`data: ${JSON.stringify({ error: 'Turnstile verification required.' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
  }

  const cookies = parseCookies(req);
  const rawRefCookie = cookies['pulse_refs'] || '';
  let referenceUseCount = 0;
  if (cookies['pulse_refs_uses']) {
    const n = parseInt(cookies['pulse_refs_uses'], 10);
    if (Number.isFinite(n) && n > 0) {
      referenceUseCount = n;
    }
  }

  let referenceContext = '';
  let shouldUseReferenceCookie = false;
  // Only allow reference context to be used for a single chat message.
  if (rawRefCookie && typeof rawRefCookie === 'string' && referenceUseCount < 1) {
    try {
      const decoded = decodeURIComponent(rawRefCookie);
      if (decoded && decoded.trim()) {
        referenceContext = decoded;
        shouldUseReferenceCookie = true;
        console.log('[chat] Loaded referenceContext from cookie', {
          approxChars: referenceContext.length
        });
      }
    } catch (_) {
      referenceContext = '';
      shouldUseReferenceCookie = false;
    }
  }

  const setCookieHeaders = [];
  if (rawRefCookie) {
    if (shouldUseReferenceCookie) {
      const newCount = referenceUseCount + 1;
      // Track that we've used the reference once, then immediately clear it.
      setCookieHeaders.push(
        `pulse_refs_uses=${newCount}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`,
        'pulse_refs=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax',
        'pulse_refs_uses=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax'
      );
    } else {
      setCookieHeaders.push(
        'pulse_refs=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax',
        'pulse_refs_uses=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax'
      );
    }
  }

  if (setCookieHeaders.length) {
    res.setHeader('Set-Cookie', setCookieHeaders);
  }

  res.flushHeaders?.();

  const userText = typeof req.body?.message === 'string' ? req.body.message : '';
  const currentHtmlRaw = typeof req.body?.html === 'string' ? req.body.html : '';
  const currentHtmlNumbered =
    typeof req.body?.htmlNumbered === 'string' && req.body.htmlNumbered
      ? req.body.htmlNumbered
      : currentHtmlRaw;
  const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];

  if (!process.env['BIXX_API_KEY']) {
    console.warn('Chat stream unavailable: missing required server configuration.');
    res.write(`data: ${JSON.stringify({ error: 'Service unavailable.' })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  const apiKeys = getApiKeysShuffled();

  // If a pulse.txt file exists in the project root, stream raw Cerebras text into it.
  const pulseFilePath = path.join(__dirname, 'pulse.txt');
  const hasPulseFile = fs.existsSync(pulseFilePath);

  // We create the write stream lazily inside handleWithKey so it's per-request.
  let pulseWriteStream = null;

  async function handleWithKey(apiKey) {
    const aiClient = await getClient(apiKey);
    const systemPrompt = readSystemPrompt();
    const cleanUserText = stripSearchTags(userText);

    // Lazily create pulse.txt write stream at the start of the request handler
    // so we can capture both planner output (with search tags) and stream tokens.
    if (hasPulseFile && !pulseWriteStream) {
      try {
        pulseWriteStream = fs.createWriteStream(pulseFilePath, {
          encoding: 'utf8',
          flags: 'w'
        });
      } catch (_) {
        pulseWriteStream = null;
      }
    }

    // 1) Ask the model if it wants to use internet tools (returns ONLY search tags).
    const toolRequests = await (async () => {
      if (!isSerperEnabled()) return [];
      try {
        const resp = await aiClient.chat.completions.create({
          model: 'qwen-3-235b-a22b-instruct-2507',
          stream: false,
          max_completion_tokens: 300,
          temperature: 0.2,
          top_p: 0.8,
          messages: [
            {
              role: 'system',
              content: systemPrompt || ''
            },
            ...(() => {
              const out = [];
              const history = rawHistory
                .map((m) => {
                  const role = m?.role === 'assistant' ? 'assistant' : m?.role === 'user' ? 'user' : null;
                  const text = typeof m?.text === 'string' ? m.text : '';
                  if (!role || !text) return null;
                  return { role, text };
                })
                .filter(Boolean)
                .slice(-12);

              if (!history.length) {
                const plannerUserText = referenceContext
                  ? `User reference documents (plans, requirements, or background):\n\n
${referenceContext}\n\nUser request:\n${cleanUserText}`
                  : cleanUserText;
                out.push({ role: 'user', content: plannerUserText });
                return out;
              }

              for (let i = 0; i < history.length; i++) {
                const h = history[i];
                const isLastUser = h.role === 'user' && i === history.length - 1;
                if (isLastUser) {
                  const plannerUserText = referenceContext
                    ? `User reference documents (plans, requirements, or background):\n\n
${referenceContext}\n\nUser request:\n${cleanUserText}`
                    : cleanUserText;
                  out.push({ role: h.role, content: plannerUserText });
                } else {
                  out.push({ role: h.role, content: h.text });
                }
              }
              return out;
            })()
          ]
        });

        const text = resp?.choices?.[0]?.message?.content || '';

        // Write raw planner text (including any <search.*> tags) into pulse.txt
        // before extracting search requests.
        if (pulseWriteStream && text) {
          try {
            pulseWriteStream.write(text + '\n');
          } catch (_) {}
        }

        return extractSearchRequests(text);
      } catch (_) {
        return [];
      }
    })();

    // If the user explicitly included tags, honor them (optional).
    const explicitSearchRequests = extractSearchRequests(userText);
    const searchRequests = explicitSearchRequests.length ? explicitSearchRequests : toolRequests;

    if (isSerperEnabled() && searchRequests.length) {
      res.write(
        `data: ${JSON.stringify({
          status: 'searching',
          requests: searchRequests.map((r) => ({ type: r.type, q: r.q }))
        })}\n\n`
      );
    }

    const searchResults = isSerperEnabled() && searchRequests.length ? await runSearches(searchRequests) : [];
    const searchContext = searchResults.length ? formatSearchContext(searchResults) : '';

    if (isSerperEnabled() && searchRequests.length) {
      res.write(
        `data: ${JSON.stringify({
          status: 'ready',
          requests: searchRequests.map((r) => ({ type: r.type, q: r.q }))
        })}\n\n`
      );
    }

    const messages = [
      {
        role: 'system',
        content: (systemPrompt || '') + '\n\n' + getNoLeakSystemAddon()
      },
      ...(() => {
        const out = [];

        const history = rawHistory
          .map((m) => {
            const role = m?.role === 'assistant' ? 'assistant' : m?.role === 'user' ? 'user' : null;
            const text = typeof m?.text === 'string' ? m.text : '';
            if (!role || !text) return null;
            return { role, text };
          })
          .filter(Boolean)
          .slice(-24);

        if (!history.length) {
          // No prior history: include any referenceContext directly before the main user request.
          if (referenceContext) {
            out.push({
              role: 'user',
              content:
                'Here are reference documents and plans provided by the user. You MUST follow these closely when building or editing the site. Treat them as primary instructions when there is any ambiguity or conflict.\n\n' +
                '```text\n' +
                referenceContext +
                '\n```'
            });
          }

          out.push({
            role: 'user',
            content: `User request:\n${cleanUserText}\n\nCurrent HTML (if any, line-numbered):\n\n\`\`\`html\n${currentHtmlNumbered || ''}\n\`\`\`\n`
          });
          return out;
        }

        for (let i = 0; i < history.length; i++) {
          const h = history[i];
          const isLastUser = h.role === 'user' && i === history.length - 1;

          // Right before the latest user request, inject the reference documents as explicit user content.
          if (isLastUser && referenceContext) {
            out.push({
              role: 'user',
              content:
                'Here are reference documents and plans provided by the user. You MUST follow these closely when building or editing the site. Treat them as primary instructions when there is any ambiguity or conflict.\n\n' +
                '```text\n' +
                referenceContext +
                '\n```'
            });
          }

          const content = isLastUser
            ? `${h.text}\n\nCurrent HTML (if any, line-numbered):\n\n\`\`\`html\n${currentHtmlNumbered || ''}\n\`\`\`\n`
            : h.text;
          out.push({ role: h.role, content });
        }

        return out;
      })(),
      ...(referenceContext
        ? [
            {
              role: 'system',
              content:
                'User reference documents (hidden context from uploaded files). Use these as background knowledge when helping the user and resolving ambiguities:\n\n' +
                referenceContext
            }
          ]
        : []),
      ...(searchContext
        ? [
            {
              role: 'system',
              content:
                'Internet results (hidden context). Use these to answer, but NEVER quote them or list URLs:\n\n' +
                searchContext
            }
          ]
        : [])
    ];

    const stream = await aiClient.chat.completions.create({
      messages,
      model: 'qwen-3-235b-a22b-instruct-2507',
      stream: true,
      max_completion_tokens: 20000,
      temperature: 0.7,
      top_p: 0.8
    });

    req.on('close', () => {
      try {
        res.end();
      } catch (_) {}
    });

    const streamFilter = createSearchTagStreamFilter();

    for await (const chunk of stream) {
      const token = chunk?.choices?.[0]?.delta?.content || '';
      if (!token) continue;

      // Write raw Cerebras text token directly to pulse.txt (no formatting or filtering).
      if (pulseWriteStream) {
        try {
          pulseWriteStream.write(token);
        } catch (_) {}
      }

      const safeToken = streamFilter(token);
      if (!safeToken) continue;
      res.write(`data: ${JSON.stringify({ content: safeToken })}\n\n`);
    }

    if (pulseWriteStream) {
      try {
        pulseWriteStream.end();
      } catch (_) {}
    }

    res.write('data: [DONE]\n\n');
    res.end();
  }

  try {
    const keys = getApiKeysShuffled();
    if (!keys.length) {
      throw new Error('Missing BIXX_API_KEY.');
    }

    let lastErr = null;
    const total = keys.length;
    // Start from a random index so traffic is spread across keys
    const startIndex = Math.floor(Math.random() * total);

    for (let offset = 0; offset < total; offset++) {
      const i = (startIndex + offset) % total;
      const key = keys[i];
      const keyNumber = i + 1;
      console.log(`Testing with key ${keyNumber}`);
      try {
        await handleWithKey(key);
        console.log('ok');
        lastErr = null;
        return;
      } catch (err) {
        lastErr = err;
        if (!isRateLimitError(err)) {
          throw err;
        }
        console.log("We're experiencing high traffic right now! Please try again soon.");
        console.log('Continue testing.');
        // Rate-limited for this key; try the next one.
        continue;
      }
    }

    throw lastErr || new Error('All API keys are rate-limited.');
  } catch (err) {
    console.error('Chat stream failed:', err);
    const message = (err && err.error && err.error.message) || err.message || 'Service unavailable.';
    res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/build', (req, res) => {
  const rawQuery = typeof req.query?.query === 'string' ? req.query.query : '';
  const trimmed = rawQuery.trim();
  const siteId = typeof req.query?.site === 'string' ? req.query.site.trim() : '';

  if (!trimmed && !siteId) {
    return res.redirect(302, '/');
  }

  res.sendFile(path.join(__dirname, 'public', 'build.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}

module.exports = app;

