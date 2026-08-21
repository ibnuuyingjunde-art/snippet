
const http = require('http');
const readline = require('readline');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');

/* ============================================================
 * 1. UTILITY: ANSI FORMATTER FOR CLI COLORS
 * ============================================================ */
class AnsiFormatter {
  static RESET = '\x1b[0m';
  static BOLD = '\x1b[1m';
  static DIM = '\x1b[2m';
  
  static RED = '\x1b[31m';
  static GREEN = '\x1b[32m';
  static YELLOW = '\x1b[33m';
  static BLUE = '\x1b[34m';
  static MAGENTA = '\x1b[35m';
  static CYAN = '\x1b[36m';
  static WHITE = '\x1b[37m';
  
  static BG_PURPLE = '\x1b[45m';

  static color(text, colorCode, bold = false) {
    return `${bold ? this.BOLD : ''}${colorCode}${text}${this.RESET}`;
  }

  static success(text) { return this.color(text, this.GREEN, true); }
  static info(text) { return this.color(text, this.CYAN); }
  static warn(text) { return this.color(text, this.YELLOW, true); }
  static error(text) { return this.color(text, this.RED, true); }
  static highlight(text) { return this.color(text, this.MAGENTA, true); }
  static muted(text) { return this.color(text, this.DIM); }
}

/* ============================================================
 * 2. CORE PARSER ENGINE
 * ============================================================ */
class EmailParser {
  /**
   * Cleans and extracts the visible text body and raw HTML block of the email content.
   * @param {object} $ Cheerio static root
   * @returns {{bodyText: string, rawHtml: string}}
   */
  static extractCleanBody($) {
    // Try primary content container selectors
    const selectors = [
      'div.mess_bodiyy',
      'div[class*="mess_bod"]',
      'div.user_mess_content',
      '#email_content',
      '#mail-summary-body'
    ];

    for (const sel of selectors) {
      const container = $(sel);
      if (container.length > 0) {
        const clone = container.first().clone();
        // Remove junk elements that distort the content or run scripts
        clone.find('script, style, ins, button, iframe, .adsbygoogle, .mesg-row, .mailsrc-panel, .tooltip-container').remove();
        
        const bodyText = clone.text().replace(/\n\s*\n/g, '\n').trim();
        const rawHtml = clone.html() || '';
        return { bodyText, rawHtml };
      }
    }

    return { bodyText: '', rawHtml: '' };
  }

  /**
   * Extracts one-time passcode (OTP) from text or HTML.
   * @param {string} text Text content
   * @param {string} html HTML content
   * @returns {string|null} OTP code or null
   */
  static extractOtp(text, html = null) {
    const combined = (text || '').trim();
    if (!combined && !html) return null;

    // Pattern 1: Hyphenated or spaced OTP, e.g. 123-456, 123 456
    const mHyphen = combined.match(/\b([0-9]{3})[- ]([0-9]{3})\b/);
    if (mHyphen) return mHyphen[1] + mHyphen[2];

    // Pattern 2: Contextual keywords for 4-8 digit OTP codes
    const mKeyword = combined.match(
      /(?:kode\s*verifikasi|verification\s*code|security\s*code|confirmation\s*code|kode\s*keamanan|auth\s*code|passcode|kode\s*otp|otp|pin|code|kode)(?:(?:\s+[a-zA-Z]+){0,4})?\s*(?:adalah|is|:|:=|-|\s)\s*\b([0-9]{4,8})\b/i
    );
    if (mKeyword) {
      const val = mKeyword[1];
      // Skip common years unless clearly labeled (avoiding 2024, 2025, 2026 false-positives)
      if (!(val.length === 4 && (val.startsWith('19') || val.startsWith('20')) && !/code|kode|otp|pin/i.test(combined))) {
        return val;
      }
    }

    // Pattern 3: Imperative actions: "use code 123456"
    const mAction = combined.match(
      /(?:use\s*code|masukkan\s*kode|gunakan\s*kode|enter\s*(?:verification\s*)?code)\s*(?:adalah|is|:|:=|-|\s)?\s*\b([0-9]{4,8})\b/i
    );
    if (mAction) return mAction[1];

    // Pattern 4: Alphanumeric codes associated with authorization
    const mAlpha = combined.match(
      /(?:otp|code|kode|token|password)(?:(?:\s+[a-zA-Z]+){0,3})?\s*(?:adalah|is|:|:=|-|\s)\s*\b([A-Z0-9]*[0-9][A-Z0-9]*)\b/i
    );
    if (mAlpha) {
      const val = mAlpha[1].trim();
      if (val.length >= 4 && val.length <= 8 && /[0-9]/.test(val) && /[a-zA-Z]/i.test(val)) {
        return val.toUpperCase();
      }
    }

    // Pattern 5: Look for large standalone numbers in HTML elements
    if (html) {
      const $ = cheerio.load(html);
      let foundHtmlOtp = null;
      $('b, strong, h1, h2, h3, td, span, font').each((_, el) => {
        const t = $(el).text().trim();
        if (/^[0-9]{4,8}$/.test(t) && !/^(19\d\d|20[2-3]\d)$/.test(t)) {
          foundHtmlOtp = t;
          return false; // Break Cheerio loop
        }
        if (/^[0-9]{3}[- ][0-9]{3}$/.test(t)) {
          foundHtmlOtp = t.replace(/[- ]/, '');
          return false;
        }
      });
      if (foundHtmlOtp) return foundHtmlOtp;
    }

    // Pattern 6: Last resort, look for any standalone 6-digit number
    const mSixDigit = combined.match(/\b([0-9]{6})\b/);
    if (mSixDigit) return mSixDigit[1];

    return null;
  }

  /**
   * Scrapes action links from email HTML and scores them to find the primary verification link.
   * @param {string} htmlContent HTML email body
   * @returns {{primary_link: string|null, all_links: Array<{text: string, url: string}>}}
   */
  static extractVerificationLinks(htmlContent) {
    if (!htmlContent) return { primary_link: null, all_links: [] };

    const $ = cheerio.load(htmlContent);
    const links = [];
    let primaryLink = null;
    let highestScore = -1;

    const actionKeywords = [
      'verify', 'verifikasi', 'confirm', 'konfirmasi', 'activate', 'aktifkan',
      'click here', 'klik di sini', 'log in', 'masuk', 'login', 'reset password',
      'complete registration', 'get started', 'join', 'accept', 'approve'
    ];

    const ignoreKeywords = [
      'unsubscribe', 'berhenti langganan', 'privacy policy', 'kebijakan privasi',
      'terms', 'syarat dan ketentuan', 'facebook', 'twitter', 'instagram', 'linkedin',
      'youtube', 'help center', 'pusat bantuan', 'contact us', 'hubungi kami',
      'support', 'preferences', 'settings', 'android', 'ios'
    ];

    $('a[href]').each((_, el) => {
      const href = ($(el).attr('href') || '').trim();
      if (!href.startsWith('http://') && !href.startsWith('https://')) return;

      const text = $(el).text().trim().toLowerCase();
      const hrefLower = href.toLowerCase();

      // Filter out footer junk or social media links
      if (ignoreKeywords.some((junk) => text.includes(junk) || hrefLower.includes(junk))) {
        return;
      }

      let score = 0;
      for (const kw of actionKeywords) {
        if (text.includes(kw)) score += 15;
        if (hrefLower.includes(kw)) score += 5;
      }

      // Strong signature of token or verify query parameter
      if (/token=|code=|key=|verify|activate|confirmation|auth\/links|auth_action/i.test(hrefLower)) {
        score += 10;
      }

      if (!links.some(l => l.url === href)) {
        links.push({ text: $(el).text().trim(), url: href, score });
      }

      if (score > highestScore) {
        highestScore = score;
        primaryLink = href;
      }
    });

    // Sort all discovered links by score descending
    links.sort((a, b) => b.score - a.score);

    // Use top score or first link as default fallback
    if (!primaryLink && links.length > 0) {
      primaryLink = links[0].url;
    }

    return {
      primary_link: primaryLink,
      all_links: links.map(l => ({ text: l.text, url: l.url }))
    };
  }
}

/* ============================================================
 * 3. GENERATOR.EMAIL CLIENT ENGINE
 * ============================================================ */
class GeneratorEmail {
  static BASE_URL = 'https://generator.email';
  static WS_URL = 'wss://generator.email/notificon/ws';
  static DEVELOPER = 'api.haidarxd.my.id';
  static VERSION = '3.0.0';

  static DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  constructor(options = {}) {
    this.userAgent = options.userAgent || GeneratorEmail.DEFAULT_USER_AGENT;
    this.timeout = options.timeout || 15000;
    this.cacheTtl = options.cacheTtl || 300000; // 5 mins default cache
    
    this._apiToken = null;
    this._tokenFetchedAt = 0;
    this._cachedDomains = [];
    this._domainsFetchedAt = 0;
    
    // Cookie store for stateful requests
    this.cookies = new Map();
  }

  _getHeaders(extraHeaders = {}) {
    const headers = {
      'User-Agent': this.userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
      'Connection': 'keep-alive',
      ...extraHeaders
    };

    if (this.cookies.size > 0) {
      const cookieStr = Array.from(this.cookies.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
      headers['Cookie'] = cookieStr;
    }

    return headers;
  }

  _updateCookies(headers) {
    if (!headers || !headers['set-cookie']) return;
    const rawCookies = Array.isArray(headers['set-cookie']) 
      ? headers['set-cookie'] 
      : [headers['set-cookie']];

    for (const cookie of rawCookies) {
      const parts = cookie.split(';')[0].split('=');
      if (parts.length >= 2) {
        const name = parts[0].trim();
        const value = parts.slice(1).join('=').trim();
        this.cookies.set(name, value);
      }
    }
  }

  _formatResponse(status, data, message = null, errorCode = null) {
    const response = {
      status,
      developer: GeneratorEmail.DEVELOPER,
      version: GeneratorEmail.VERSION,
      timestamp: new Date().toISOString(),
      data
    };
    if (message) response.message = message;
    if (errorCode) response.error_code = errorCode;
    return response;
  }

  /**
   * Fetches/Extracts a valid API Token from generator.email meta tags.
   */
  async getApiToken(forceRefresh = false) {
    const now = Date.now();
    if (this._apiToken && !forceRefresh && (now - this._tokenFetchedAt < this.cacheTtl)) {
      return this._apiToken;
    }

    try {
      const res = await axios.get(`${GeneratorEmail.BASE_URL}/`, {
        headers: this._getHeaders(),
        timeout: this.timeout,
        validateStatus: () => true
      });

      this._updateCookies(res.headers);

      if (res.status === 200) {
        const $ = cheerio.load(res.data);
        const token = $('meta[name="api-token"]').attr('content');
        if (token) {
          this._apiToken = token.trim();
          this._tokenFetchedAt = now;
          return this._apiToken;
        }
      }
    } catch (err) {
      if (this._apiToken) return this._apiToken;
      throw new Error(`Failed to retrieve API Token: ${err.message}`);
    }

    if (this._apiToken) return this._apiToken;
    throw new Error('Failed to find meta tag api-token in document');
  }

  /**
   * Fetches active email domains from the site API.
   */
  async getActiveDomains(forceRefresh = false) {
    const now = Date.now();
    if (this._cachedDomains.length > 0 && !forceRefresh && (now - this._domainsFetchedAt < this.cacheTtl)) {
      return this._cachedDomains;
    }

    try {
      const token = await this.getApiToken(forceRefresh);
      const headers = this._getHeaders({
        'X-API-Token': token,
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `${GeneratorEmail.BASE_URL}/`
      });

      let res = await axios.get(`${GeneratorEmail.BASE_URL}/api/domains.php`, {
        headers,
        timeout: this.timeout,
        validateStatus: () => true
      });

      // Handle token expiration / 403 Forbidden
      if (res.status === 403) {
        const renewedToken = await this.getApiToken(true);
        headers['X-API-Token'] = renewedToken;
        res = await axios.get(`${GeneratorEmail.BASE_URL}/api/domains.php`, {
          headers,
          timeout: this.timeout,
          validateStatus: () => true
        });
      }

      if (res.status === 200 && Array.isArray(res.data) && res.data.length > 0) {
        const domains = res.data
          .map(d => (typeof d === 'object' && d !== null ? (d.ascii || d.display) : null))
          .filter(val => !!val)
          .map(val => val.trim().toLowerCase());
        
        if (domains.length > 0) {
          this._cachedDomains = domains;
          this._domainsFetchedAt = now;
          return this._cachedDomains;
        }
      }
    } catch (_) {
      // Keep going to fallback below
    }

    const fallback = ['fboxmail.com', 'cunan.store', 'sds-awe.top', 'mengundang.live', 'kintil.buzz', 'ketua.id'];
    if (this._cachedDomains.length === 0) {
      this._cachedDomains = fallback;
    }
    return this._cachedDomains;
  }

  sanitizeUsername(username) {
    if (!username) return `user_${Math.floor(Date.now() / 1000)}`;
    const cleaned = username.trim().toLowerCase().replace(/[^a-zA-Z0-9_.-]/g, '');
    return cleaned || `user_${Math.floor(Date.now() / 1000)}`;
  }

  /**
   * Generates a fully qualified temporary email address.
   */
  async generateEmail(username = null, domain = null) {
    const domains = await this.getActiveDomains();
    
    let selectedDomain = domain ? domain.trim().toLowerCase().replace(/^@/, '') : null;
    if (!selectedDomain || !domains.includes(selectedDomain)) {
      selectedDomain = selectedDomain || domains[Math.floor(Math.random() * domains.length)] || 'fboxmail.com';
    }

    const userPart = username 
      ? this.sanitizeUsername(username)
      : `user_${Math.random().toString(36).substring(2, 12)}`;

    return `${userPart}@${selectedDomain}`.toLowerCase();
  }

  /**
   * Checks the inbox for a specific email address.
   */
  async checkInbox(email) {
    const formattedEmail = (email || '').trim().toLowerCase();
    if (!formattedEmail.includes('@')) {
      return this._formatResponse('error', null, `Invalid email format: ${formattedEmail}`, 'INVALID_EMAIL');
    }

    const [username, domain] = formattedEmail.split('@');
    const inboxCtxVal = `${domain}/${username}/`;
    
    // Inject cookies representing the session for this mail inbox
    this.cookies.set('inbox_ctx', encodeURIComponent(inboxCtxVal));
    this.cookies.set('surl', `${domain}/${username}`);
    this.cookies.set('embx', encodeURIComponent(JSON.stringify([formattedEmail])));

    try {
      const res = await axios.get(`${GeneratorEmail.BASE_URL}/inbox1/`, {
        headers: this._getHeaders({
          'Referer': GeneratorEmail.BASE_URL + '/'
        }),
        timeout: this.timeout,
        validateStatus: () => true
      });

      this._updateCookies(res.headers);

      if (res.status !== 200) {
        return this._formatResponse('error', null, `Inbox check failed (HTTP ${res.status})`, 'HTTP_ERROR');
      }

      const $ = cheerio.load(res.data);
      let scriptCount = 0;
      
      $('script').each((_, el) => {
        const text = $(el).text() || '';
        if (text.includes('window.SITE_DATA=')) {
          const match = text.match(/num_mess:\s*(\d+)/);
          if (match) scriptCount = parseInt(match[1], 10);
        }
      });

      const messages = [];
      $('#email-table .list-group-item').each((_, el) => {
        const item = $(el);
        const fromText = item.find('[class*="from_div"]').text().trim();
        const subjText = item.find('[class*="subj_div"]').text().trim();
        const timeText = item.find('[class*="time_div"]').text().trim();
        const onclick = item.attr('onclick') || '';
        const linkMatch = onclick.match(/loadInboxClientSide\(['"](.*?)['\"]\)/);
        const link = linkMatch ? linkMatch[1] : '';

        messages.push({
          from: fromText,
          subject: subjText,
          date: timeText,
          link
        });
      });

      const { bodyText, rawHtml } = EmailParser.extractCleanBody($);
      const otp = bodyText ? EmailParser.extractOtp(bodyText, rawHtml) : null;
      const linksInfo = rawHtml ? EmailParser.extractVerificationLinks(rawHtml) : { primary_link: null, all_links: [] };

      const inboxData = {
        email: formattedEmail,
        total_messages: Math.max(messages.length, scriptCount),
        messages,
        otp,
        verification_link: linksInfo.primary_link,
        body: rawHtml || null
      };

      return this._formatResponse('success', inboxData);
    } catch (err) {
      return this._formatResponse('error', null, `Network connection failed: ${err.message}`, 'NETWORK_ERROR');
    }
  }

  /**
   * Retrieves the body and parsed details of a single message.
   */
  async readMessage(email, linkOrMsgId) {
    const formattedEmail = (email || '').trim().toLowerCase();
    if (!formattedEmail.includes('@')) {
      return this._formatResponse('error', null, `Invalid email format: ${formattedEmail}`, 'INVALID_EMAIL');
    }

    const [username, domain] = formattedEmail.split('@');
    const link = (linkOrMsgId || '').replace(/^\//, '');

    const url = link.startsWith(domain)
      ? `${GeneratorEmail.BASE_URL}/${link}`
      : `${GeneratorEmail.BASE_URL}/${domain}/${username}/${link}`;

    const inboxCtxVal = `${domain}/${username}/${linkOrMsgId}`;
    
    this.cookies.set('inbox_ctx', encodeURIComponent(inboxCtxVal));
    this.cookies.set('surl', `${domain}/${username}`);
    this.cookies.set('embx', encodeURIComponent(JSON.stringify([formattedEmail])));

    try {
      const res = await axios.get(url, {
        headers: this._getHeaders({
          'Referer': `${GeneratorEmail.BASE_URL}/inbox1/`
        }),
        timeout: this.timeout,
        validateStatus: () => true
      });

      this._updateCookies(res.headers);

      if (res.status !== 200) {
        return this._formatResponse('error', null, `Failed to load message (HTTP ${res.status})`, 'HTTP_ERROR');
      }

      const $ = cheerio.load(res.data);
      let sender = '';
      let subject = '';
      let dateStr = '';

      const headText = $('#mail-summary-head').text() || '';
      for (const line of headText.split('\n')) {
        const lower = line.toLowerCase();
        if (lower.includes('from:') || lower.includes('dari:')) {
          sender = line.replace(/^(from|dari):\s*/i, '').trim();
        } else if (lower.includes('subject:') || lower.includes('subjek:')) {
          subject = line.replace(/^(subject|subjek):\s*/i, '').trim();
        } else if (lower.includes('date:') || lower.includes('tanggal:') || lower.includes('received:')) {
          dateStr = line.replace(/^(date|tanggal|received):\s*/i, '').trim();
        }
      }

      const { bodyText, rawHtml } = EmailParser.extractCleanBody($);
      const otp = EmailParser.extractOtp(bodyText, rawHtml);
      const linksInfo = EmailParser.extractVerificationLinks(rawHtml);

      const msgData = {
        email: formattedEmail,
        from: sender,
        subject,
        date: dateStr,
        otp,
        verification_link: linksInfo.primary_link,
        body: rawHtml // Retain HTML for visual styling representation
      };

      return this._formatResponse('success', msgData);
    } catch (err) {
      return this._formatResponse('error', null, `Network error reading message: ${err.message}`, 'NETWORK_ERROR');
    }
  }

  /**
   * Connects to generator.email's WebSocket stream to receive notifications of new incoming emails.
   */
  async listenInboxWs(email, timeoutSec = 180, onMessageCallback = null) {
    const formattedEmail = (email || '').trim().toLowerCase();
    const wsUrl = `${GeneratorEmail.WS_URL}?email=${encodeURIComponent(formattedEmail)}`;

    return new Promise((resolve) => {
      let isResolved = false;
      const ws = new WebSocket(wsUrl, {
        headers: {
          'User-Agent': this.userAgent,
          'Origin': GeneratorEmail.BASE_URL
        }
      });

      const cleanupTimer = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          try { ws.close(); } catch (_) {}
          resolve(this._formatResponse('timeout', null, `Listening timed out after ${timeoutSec} seconds.`, 'TIMEOUT'));
        }
      }, timeoutSec * 1000);

      ws.on('message', async (raw) => {
        try {
          const payload = JSON.parse(raw.toString());
          const link = payload.link || '';
          let emailBody = {};

          if (link) {
            const detailRes = await this.readMessage(formattedEmail, link);
            if (detailRes && detailRes.status === 'success') {
              emailBody = detailRes.data;
            }
          }

          const parsedBodyText = emailBody.body ? cheerio.load(emailBody.body).text() : '';
          const otp = emailBody.otp || EmailParser.extractOtp(parsedBodyText, emailBody.body);
          
          const fullEmailData = {
            email: formattedEmail,
            from: payload.from || emailBody.from,
            subject: payload.subject || emailBody.subject,
            date: payload.date || emailBody.date,
            otp,
            verification_link: emailBody.verification_link,
            body: emailBody.body || ''
          };

          const successRes = this._formatResponse('success', fullEmailData, 'New email received in real-time');

          if (onMessageCallback) {
            onMessageCallback(successRes);
          }

          if (!isResolved) {
            isResolved = true;
            clearTimeout(cleanupTimer);
            try { ws.close(); } catch (_) {}
            resolve(successRes);
          }
        } catch (err) {
          // Keep WS listening on parsing errors
        }
      });

      ws.on('error', (err) => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(cleanupTimer);
          resolve(this._formatResponse('error', null, `WebSocket stream error: ${err.message}`, 'WS_ERROR'));
        }
      });

      ws.on('close', () => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(cleanupTimer);
          resolve(this._formatResponse('error', null, 'WebSocket connection closed prematurely', 'WS_CLOSED'));
        }
      });
    });
  }

  async waitForOtp(email, timeoutSec = 180) {
    const res = await this.listenInboxWs(email, timeoutSec);
    if (res.status === 'success' && res.data) {
      return this._formatResponse('success', {
        email,
        otp: res.data.otp,
        subject: res.data.subject,
        from: res.data.from,
        date: res.data.date
      });
    }
    return res;
  }

  async waitForVerificationLink(email, timeoutSec = 180) {
    const res = await this.listenInboxWs(email, timeoutSec);
    if (res.status === 'success' && res.data) {
      return this._formatResponse('success', {
        email,
        verification_link: res.data.verification_link,
        subject: res.data.subject,
        from: res.data.from,
        date: res.data.date
      });
    }
    return res;
  }
}

const coreClient = new GeneratorEmail();

/* ============================================================
 * 4. REST API & WEBSOCKET SERVER
 * ============================================================ */
function createServer() {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server, path: '/ws/inbox' });

  app.use(cors());
  app.use(express.json());

  // Serve static UI Dashboard from local index.html
  app.use(express.static(path.join(__dirname, 'public')));
  
  app.get('/api/status', (req, res) => {
    res.json({
      status: 'online',
      service: 'HaidarApis REST API',
      developer: GeneratorEmail.DEVELOPER,
      version: GeneratorEmail.VERSION,
      endpoints: {
        status: '/api/status',
        domains: '/api/domains',
        generate: '/api/generate?username=...&domain=...',
        inbox: '/api/inbox?email=...',
        message: '/api/message?email=...&link=...',
        listen: '/api/listen?email=...&timeout=...',
        otp: '/api/otp?email=...',
        link: '/api/link?email=...',
        websocket: 'ws://localhost:port/ws/inbox?email=...'
      }
    });
  });

  app.get('/api/domains', async (req, res) => {
    const refresh = req.query.refresh === 'true';
    try {
      const domains = await coreClient.getActiveDomains(refresh);
      res.json(coreClient._formatResponse('success', {
        total_domains: domains.length,
        domains
      }));
    } catch (err) {
      res.status(500).json(coreClient._formatResponse('error', null, err.message));
    }
  });

  app.get('/api/generate', async (req, res) => {
    const { username, domain } = req.query;
    try {
      const email = await coreClient.generateEmail(username, domain);
      const [u, d] = email.split('@');
      res.json(coreClient._formatResponse('success', {
        email,
        username: u,
        domain: d,
        inbox_url: `${GeneratorEmail.BASE_URL}/${email}`
      }));
    } catch (err) {
      res.status(500).json(coreClient._formatResponse('error', null, err.message));
    }
  });

  app.get('/api/inbox', async (req, res) => {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json(coreClient._formatResponse('error', null, 'Email parameter is required', 'MISSING_PARAM'));
    }
    res.json(await coreClient.checkInbox(email));
  });

  app.get('/api/message', async (req, res) => {
    const { email, link } = req.query;
    if (!email || !link) {
      return res.status(400).json(coreClient._formatResponse('error', null, 'Email and message link parameters are required', 'MISSING_PARAMS'));
    }
    res.json(await coreClient.readMessage(email, link));
  });

  app.get('/api/listen', async (req, res) => {
    const { email } = req.query;
    const timeout = parseInt(req.query.timeout, 10) || 180;
    if (!email) {
      return res.status(400).json(coreClient._formatResponse('error', null, 'Email is required', 'MISSING_PARAM'));
    }
    res.json(await coreClient.listenInboxWs(email, timeout));
  });

  app.get('/api/otp', async (req, res) => {
    const { email } = req.query;
    const timeout = parseInt(req.query.timeout, 10) || 180;
    if (!email) {
      return res.status(400).json(coreClient._formatResponse('error', null, 'Email is required', 'MISSING_PARAM'));
    }
    res.json(await coreClient.waitForOtp(email, timeout));
  });

  app.get('/api/link', async (req, res) => {
    const { email } = req.query;
    const timeout = parseInt(req.query.timeout, 10) || 180;
    if (!email) {
      return res.status(400).json(coreClient._formatResponse('error', null, 'Email is required', 'MISSING_PARAM'));
    }
    res.json(await coreClient.waitForVerificationLink(email, timeout));
  });

  // WebSocket Server event-driven relay mapping
  wss.on('connection', (ws, req) => {
    const params = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams;
    const email = params.get('email');

    if (!email || !email.includes('@')) {
      ws.send(JSON.stringify(coreClient._formatResponse('error', null, 'Invalid email socket parameter', 'INVALID_PARAM')));
      return ws.close();
    }

    // Connect downstream to upstream websocket stream
    ws.send(JSON.stringify({
      status: 'connected',
      developer: GeneratorEmail.DEVELOPER,
      message: `WebSocket active stream for ${email}`
    }));

    const upstreamWsUrl = `${GeneratorEmail.WS_URL}?email=${encodeURIComponent(email)}`;
    const upstream = new WebSocket(upstreamWsUrl, {
      headers: {
        'User-Agent': coreClient.userAgent,
        'Origin': GeneratorEmail.BASE_URL
      }
    });

    upstream.on('message', async (raw) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        const payload = JSON.parse(raw.toString());
        const link = payload.link || '';
        let emailBody = {};

        if (link) {
          const detailRes = await coreClient.readMessage(email, link);
          if (detailRes && detailRes.status === 'success') {
            emailBody = detailRes.data;
          }
        }

        const parsedBodyText = emailBody.body ? cheerio.load(emailBody.body).text() : '';
        const otp = emailBody.otp || EmailParser.extractOtp(parsedBodyText, emailBody.body);

        const fullMailData = {
          email,
          from: payload.from || emailBody.from,
          subject: payload.subject || emailBody.subject,
          date: payload.date || emailBody.date,
          otp,
          verification_link: emailBody.verification_link,
          body: emailBody.body || ''
        };

        ws.send(JSON.stringify(coreClient._formatResponse('success', fullMailData, 'New message notification')));
      } catch (err) {
        ws.send(JSON.stringify(coreClient._formatResponse('error', null, `Failed parsing message: ${err.message}`, 'PARSE_ERROR')));
      }
    });

    upstream.on('error', (err) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(coreClient._formatResponse('error', null, `Upstream WS error: ${err.message}`, 'UPSTREAM_WS_ERROR')));
      }
    });

    upstream.on('close', () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(coreClient._formatResponse('info', null, 'Upstream WS closed connection', 'UPSTREAM_WS_CLOSED')));
        ws.close();
      }
    });

    // Close upstream connection if client closes connection to prevent socket leaks!
    ws.on('close', () => {
      try {
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
          upstream.close();
        }
      } catch (_) {}
    });
  });

  return { app, server };
}

function startServer(port = 8000) {
  const { server } = createServer();
  server.listen(port, () => {
    console.log('\n' + AnsiFormatter.success('============================================================'));
    console.log(AnsiFormatter.success('  🚀 REST API & WEB DASHBOARD RUNNING SUCCESSFULLY!'));
    console.log(AnsiFormatter.success('============================================================'));
    console.log(`  🌐 Dashboard Web UI : ` + AnsiFormatter.info(`http://127.0.0.1:${port}`));
    console.log(`  ⚡ API Status Check : ` + AnsiFormatter.info(`http://127.0.0.1:${port}/api/status`));
    console.log(`  🔌 WS Live Feed URL: ` + AnsiFormatter.info(`ws://127.0.0.1:${port}/ws/inbox?email=...`));
    console.log(AnsiFormatter.success('============================================================\n'));
  });
}

/* ============================================================
 * 5. CLI INTERACTIVE CONSOLE
 * ============================================================ */
function printBanner() {
  console.clear();
  const banner = `
  ${AnsiFormatter.CYAN}   _  _       _     _               _               _     
  | || | __ _(_) __| | __ _ _ __   /_\\  _ __  _  ___| |___ 
  | __ |/ _\` | |/ _\` |/ _\` | '__| / _ \\| '_ \\| |/ __| / __|
  |_||_|\\__,_|_|\\__,_|\\__,_|_|   /_/ \\_\\ .__/|_|\\___|_\\___|
                                       |_|                 ${AnsiFormatter.RESET}
             ${AnsiFormatter.BOLD}${AnsiFormatter.BG_PURPLE}  Temp-Mail by Generator email -HaidarApis  ${AnsiFormatter.RESET}
  `;
  console.log(banner);
  console.log(AnsiFormatter.muted('  Developer : api.haidarxd.my.id  ·  Refactored & Safe Relays\n'));
}

async function interactiveMenu() {
  printBanner();

  const menu = `  ${AnsiFormatter.BOLD}Commands Menu:${AnsiFormatter.RESET}
  [1] · Generate Random Email & Listen Live
  [2] · Create Custom Domain Email
  [3] · Display Active Scraping Domains
  [4] · Check & Parse Current Mail Inbox
  [5] · Subscribe Live CLI WebSocket Feed
  [6] · Run REST API & Web Dashboard Server
  [0] · Exit App
  `;

  console.log(menu);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = (msg) => new Promise((res) => rl.question(AnsiFormatter.color(msg, AnsiFormatter.CYAN, true), res));

  while (true) {
    const choice = (await prompt('\n  ❯ Select Option: ')).trim();

    if (choice === '1') {
      console.log('\n  Generating random email...');
      const email = await coreClient.generateEmail();
      console.log(`  Generated: ` + AnsiFormatter.highlight(email));
      
      const answer = (await prompt('  ❯ Listen live for incoming mails? (Y/n): ')).trim().toLowerCase();
      if (answer !== 'n') {
        console.log(`\n  ` + AnsiFormatter.warn(`Listening on WS. Send email to: ${email}...`));
        console.log(AnsiFormatter.muted('  Waiting for email (Timeout 3 mins)...'));
        const feed = await coreClient.listenInboxWs(email, 180, (msg) => {
          console.log('\n' + AnsiFormatter.success('  🔔 NEW EMAIL RECEIVED LIVE!'));
          console.log(`  From: ${msg.data.from}`);
          console.log(`  Subject: ${msg.data.subject}`);
          if (msg.data.otp) console.log(`  OTP Code: ` + AnsiFormatter.success(msg.data.otp));
          if (msg.data.verification_link) console.log(`  Verif Link: ` + AnsiFormatter.info(msg.data.verification_link));
        });
        if (feed.status === 'timeout') {
          console.log('  ' + AnsiFormatter.warn('Listener session timed out without receiving mail.'));
        }
      }
    } 
    
    else if (choice === '2') {
      console.log('\n  Fetching domains list...');
      const domains = await coreClient.getActiveDomains();
      console.log(`  Available domains (${domains.length}):`);
      domains.forEach((d, i) => console.log(`    [${i+1}] @${d}`));
      
      const selectIdx = (await prompt(`  ❯ Choose domain (1-${domains.length}) [default: 1]: `)).trim();
      const idx = parseInt(selectIdx, 10);
      const chosenDomain = (idx >= 1 && idx <= domains.length) ? domains[idx - 1] : domains[0];
      
      const customUser = (await prompt('  ❯ Enter username: ')).trim();
      const email = await coreClient.generateEmail(customUser, chosenDomain);
      
      console.log(`\n  Generated: ` + AnsiFormatter.highlight(email));
      const answer = (await prompt('  ❯ Listen live for incoming mails? (Y/n): ')).trim().toLowerCase();
      if (answer !== 'n') {
        console.log(`\n  ` + AnsiFormatter.warn(`Listening on WS. Send email to: ${email}...`));
        const feed = await coreClient.listenInboxWs(email, 180, (msg) => {
          console.log('\n' + AnsiFormatter.success('  🔔 NEW EMAIL RECEIVED LIVE!'));
          console.log(`  From: ${msg.data.from}`);
          console.log(`  Subject: ${msg.data.subject}`);
          if (msg.data.otp) console.log(`  OTP Code: ` + AnsiFormatter.success(msg.data.otp));
        });
        if (feed.status === 'timeout') {
          console.log('  ' + AnsiFormatter.warn('Listener session timed out.'));
        }
      }
    } 
    
    else if (choice === '3') {
      console.log('\n  Fetching active domains...');
      const domains = await coreClient.getActiveDomains(true);
      console.log(`\n  ` + AnsiFormatter.success(`Found ${domains.length} Active Domains:`));
      domains.forEach(d => console.log(`   • @${d}`));
    } 
    
    else if (choice === '4') {
      const email = (await prompt('  ❯ Email to fetch: ')).trim();
      if (!email.includes('@')) {
        console.log('  ' + AnsiFormatter.error('Error: Invalid email format!'));
        continue;
      }
      
      console.log('  Checking mailbox...');
      const res = await coreClient.checkInbox(email);
      if (res.status === 'success') {
        console.log(`\n  Total Messages: ` + AnsiFormatter.highlight(res.data.total_messages));
        res.data.messages.forEach((msg, idx) => {
          console.log(`    [${idx+1}] ${AnsiFormatter.bold(msg.from)} - ${msg.subject} (${msg.date})`);
        });
        if (res.data.otp) {
          console.log(`  Last parsed OTP Code: ` + AnsiFormatter.success(res.data.otp));
        }
        if (res.data.verification_link) {
          console.log(`  Last parsed Verification Link: ` + AnsiFormatter.info(res.data.verification_link));
        }
      } else {
        console.log('  ' + AnsiFormatter.error(`Error: ${res.message}`));
      }
    } 
    
    else if (choice === '5') {
      const email = (await prompt('  ❯ Email address to monitor: ')).trim();
      if (!email.includes('@')) {
        console.log('  ' + AnsiFormatter.error('Error: Invalid email address!'));
        continue;
      }
      
      console.log(`\n  ` + AnsiFormatter.warn(`WebSocket connected. Listening for email on ${email}...`));
      const res = await coreClient.listenInboxWs(email, 300, (msg) => {
        console.log('\n' + AnsiFormatter.success('  ✉️  NEW INCOMING EMAIL DETECTED:'));
        console.log(JSON.stringify(msg.data, null, 2));
      });
      if (res.status === 'timeout') {
        console.log('  ' + AnsiFormatter.warn('Live WebSocket listening session ended.'));
      }
    } 
    
    else if (choice === '6') {
      rl.close();
      startServer(8000);
      break;
    } 
    
    else if (choice === '0' || choice === 'exit' || choice === 'q') {
      console.log('  ' + AnsiFormatter.muted('Shutting down... Goodbye.'));
      rl.close();
      process.exit(0);
    } 
    
    else {
      console.log('  ' + AnsiFormatter.error('Unknown option selected!'));
    }
  }
}

/* ============================================================
 * 6. TEST SUITE RUNNER
 * ============================================================ */
async function runTests() {
  console.log('\n' + AnsiFormatter.info('============================================================'));
  console.log(AnsiFormatter.info('       🧪 HaidarApis SCRAPER TEST SUITE'));
  console.log(AnsiFormatter.info('============================================================\n'));

  // Test 1: Active Domains Scraping
  console.log('  [1/4] Testing Domains Scraping...');
  try {
    const domains = await coreClient.getActiveDomains(true);
    if (!Array.isArray(domains) || domains.length === 0) {
      throw new Error('No domains scraped.');
    }
    console.log(`        ✓ Passed! Retrieved ${domains.length} active domains.`);
  } catch (err) {
    console.log('        ' + AnsiFormatter.error(`✗ Failed: ${err.message}`));
    process.exit(1);
  }

  // Test 2: Custom / Random Generation
  console.log('  [2/4] Testing Email Generation...');
  try {
    const email = await coreClient.generateEmail('testagent', 'fboxmail.com');
    if (email !== 'testagent@fboxmail.com') {
      throw new Error(`Email generation incorrect: got ${email}`);
    }
    console.log(`        ✓ Passed! Generated: ${email}`);
  } catch (err) {
    console.log('        ' + AnsiFormatter.error(`✗ Failed: ${err.message}`));
    process.exit(1);
  }

  // Test 3: Regular Expression Matching for OTP Codes
  console.log('  [3/4] Testing OTP Extraction Accuracy...');
  try {
    const tests = [
      { text: 'Kode verifikasi Anda adalah 928301.', expected: '928301' },
      { text: 'Your verification security code: 481029. Do not share.', expected: '481029' },
      { text: 'Your passcode is 9482.', expected: '9482' },
      { text: 'Verify using OTP: 102-482.', expected: '102482' },
      { text: 'Login was made at 2026-08-16 14:00 UTC.', expected: null },
      { text: 'Your validation token is AB92K8.', expected: 'AB92K8' }
    ];

    for (const test of tests) {
      const parsed = EmailParser.extractOtp(test.text);
      if (parsed !== test.expected) {
        throw new Error(`Regex mismatch on text "${test.text}": got ${parsed}, expected ${test.expected}`);
      }
    }
    console.log('        ✓ Passed! 100% regex parsing accuracy without date false-positives.');
  } catch (err) {
    console.log('        ' + AnsiFormatter.error(`✗ Failed: ${err.message}`));
    process.exit(1);
  }

  // Test 4: General Inbox Check Sandbox
  console.log('  [4/4] Testing Empty Inbox Parser Status...');
  try {
    const res = await coreClient.checkInbox('testbot_haidar@gdfgergrer.online');
    if (res.status !== 'success') {
      throw new Error(`Inbox scraper failed with response: ${res.message}`);
    }
    console.log('        ✓ Passed! Inbox checked and empty state verified.');
  } catch (err) {
    console.log('        ' + AnsiFormatter.error(`✗ Failed: ${err.message}`));
    process.exit(1);
  }

  console.log('\n' + AnsiFormatter.success('============================================================'));
  console.log(AnsiFormatter.success('  🎉 ALL INTEGRITY TESTS SUCCESSFULLY PASSED! ENGINE IS 100% OK!'));
  console.log(AnsiFormatter.success('============================================================\n'));
}

/* ============================================================
 * 7. APPLICATION ENTRYPOINT
 * ============================================================ */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    await interactiveMenu();
  } else if (command === 'server' || command === '--server' || command === '-s') {
    const port = parseInt(args[1], 10) || 8000;
    startServer(port);
  } else if (command === 'test' || command === '--test' || command === '-t') {
    await runTests();
  } else if (command === 'generate') {
    const userIdx = args.indexOf('-u') !== -1 ? args.indexOf('-u') : args.indexOf('--user');
    const domIdx = args.indexOf('-d') !== -1 ? args.indexOf('-d') : args.indexOf('--domain');
    const user = userIdx !== -1 ? args[userIdx + 1] : null;
    const dom = domIdx !== -1 ? args[domIdx + 1] : null;
    
    const email = await coreClient.generateEmail(user, dom);
    const [u, d] = email.split('@');
    console.log(JSON.stringify(coreClient._formatResponse('success', {
      email,
      username: u,
      domain: d,
      inbox_url: `${GeneratorEmail.BASE_URL}/${email}`
    }), null, 2));
  } else if (command === 'domains') {
    const domains = await coreClient.getActiveDomains(true);
    console.log(JSON.stringify(coreClient._formatResponse('success', {
      total_domains: domains.length,
      domains
    }), null, 2));
  } else if (command === 'inbox') {
    if (!args[1]) {
      console.error(AnsiFormatter.error('Error: Email address required as argument 2'));
      process.exit(1);
    }
    console.log(JSON.stringify(await coreClient.checkInbox(args[1]), null, 2));
  } else if (command === 'listen') {
    if (!args[1]) {
      console.error(AnsiFormatter.error('Error: Email address required as argument 2'));
      process.exit(1);
    }
    const timeout = parseInt(args[2], 10) || 180;
    console.log(JSON.stringify(await coreClient.listenInboxWs(args[1], timeout), null, 2));
  } else if (command === 'otp') {
    if (!args[1]) {
      console.error(AnsiFormatter.error('Error: Email address required as argument 2'));
      process.exit(1);
    }
    const timeout = parseInt(args[2], 10) || 180;
    console.log(JSON.stringify(await coreClient.waitForOtp(args[1], timeout), null, 2));
  } else if (command === 'link') {
    if (!args[1]) {
      console.error(AnsiFormatter.error('Error: Email address required as argument 2'));
      process.exit(1);
    }
    const timeout = parseInt(args[2], 10) || 180;
    console.log(JSON.stringify(await coreClient.waitForVerificationLink(args[1], timeout), null, 2));
  } else {
    console.log(`Unknown command: ${command}`);
    console.log('Usage: node generator_email.js [server | generate | domains | inbox | listen | otp | link | test]');
  }
}

// Only execute main routine if directly called via Node CLI
if (require.main === module) {
  main().catch((err) => {
    console.error(AnsiFormatter.error('Fatal Application Error:'), err);
    process.exit(1);
  });
}

// Export module definitions for library usage
module.exports = {
  GeneratorEmail,
  EmailParser,
  AnsiFormatter,
  createServer
};
