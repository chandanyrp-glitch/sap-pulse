require('dotenv').config();
const express  = require('express');
const Parser   = require('rss-parser');
const Anthropic = require('@anthropic-ai/sdk');
const fs   = require('fs');
const path = require('path');
const cron = require('node-cron');
const https = require('https');
const http  = require('http');

const app    = express();
const parser = new Parser({
  timeout: 12000,
  headers: { 'User-Agent': 'SAP-Pulse/1.0' },
  customFields: {
    item: [
      ['media:content',   'mediaContent'],
      ['media:thumbnail', 'mediaThumbnail'],
      ['content:encoded', 'contentEncoded'],
    ]
  }
});
const PORT   = process.env.PORT || 3000;
const CACHE  = path.join(__dirname, 'cache', 'news.json');

const FEEDS = [
  // ── Official SAP sources ──────────────────────────────
  { url: 'https://news.sap.com/feed/',
    source: 'SAP News Center', category: 'Official' },

  { url: 'https://news.sap.com/india/feed/',
    source: 'SAP News India', category: 'Official' },

  // SAP Community Blogs (technology category)
  { url: 'https://community.sap.com/khhcw49343/rss/board?board.id=technology-blog-sap',
    source: 'SAP Community', category: 'Technical' },

  // SAP Developer blog via SAP Community
  { url: 'https://community.sap.com/khhcw49343/rss/board?board.id=developer-blog-sap',
    source: 'SAP Developers', category: 'Technical' },

  // ── Trusted SAP-dedicated media ───────────────────────
  { url: 'https://www.sapinsider.org/feed/',
    source: 'SAP Insider', category: 'Industry' },

  { url: 'https://spendmatters.com/feed/',
    source: 'Spend Matters', category: 'Industry' },
];

// LinkedIn profiles loaded from config
const LINKEDIN_PROFILES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'linkedin-profiles.json'), 'utf8')
);

const SAVED_POSTS_FILE = path.join(__dirname, 'cache', 'saved-posts.json');

let anthropic = null;
if (process.env.ANTHROPIC_API_KEY) {
  anthropic = new Anthropic();
  console.log('[SAP Pulse] Claude API ready – summaries will be AI-generated.');
} else {
  console.log('[SAP Pulse] No ANTHROPIC_API_KEY found – using excerpt fallback.');
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function excerptFallback(text) {
  const words = text.split(' ');
  return words.slice(0, 55).join(' ') + (words.length > 55 ? '...' : '');
}

async function summarise(title, content) {
  const clean = stripHtml(content).substring(0, 2500);
  if (!clean) return 'No content available.';

  if (!anthropic) return excerptFallback(clean);

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 130,
      messages: [{
        role: 'user',
        content: `Summarise this SAP news article in exactly 55–65 words. Be direct and informative. Focus on what changed, what was announced, or why it matters to SAP professionals.\n\nTitle: ${title}\nContent: ${clean}`
      }]
    });
    return msg.content[0].text.trim();
  } catch (err) {
    console.error('[SAP Pulse] Claude error:', err.message);
    return excerptFallback(clean);
  }
}

// ── LinkedIn via RSSHub ──────────────────────────────────
async function fetchLinkedIn() {
  const results = [];
  const RSSHUB  = 'https://rsshub.app/linkedin/user';

  for (const profile of LINKEDIN_PROFILES) {
    try {
      const parsed = await parser.parseURL(`${RSSHUB}/${profile.username}`);
      for (const item of (parsed.items || []).slice(0, 4)) {
        results.push({
          id:       item.guid || item.link || String(Math.random()),
          title:    (item.title || `Post by ${profile.name}`).trim(),
          link:     item.link || `https://linkedin.com/in/${profile.username}`,
          content:  item.contentSnippet || item.content || item.summary || '',
          source:   profile.name,
          subtitle: profile.title,
          category: 'LinkedIn',
          pubDate:  item.pubDate || item.isoDate || new Date().toISOString(),
          avatar:   `https://ui-avatars.com/api/?name=${encodeURIComponent(profile.name)}&background=0077b5&color=fff&size=128`,
        });
      }
      console.log(`  ✓ LinkedIn: ${profile.name}`);
    } catch (err) {
      console.warn(`  ✗ LinkedIn ${profile.name}: ${err.message}`);
    }
  }
  return results;
}

// ── Saved posts helpers ───────────────────────────────────
function loadSavedPosts() {
  if (!fs.existsSync(SAVED_POSTS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(SAVED_POSTS_FILE, 'utf8')); }
  catch { return []; }
}

function writeSavedPosts(posts) {
  fs.writeFileSync(SAVED_POSTS_FILE, JSON.stringify(posts, null, 2));
}

async function fetchAndCache() {
  console.log('\n[SAP Pulse] Refreshing news feeds...');
  const raw = [];

  for (const feed of FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url);
      for (const item of (parsed.items || []).slice(0, 6)) {
        const image =
          item.enclosure?.url ||
          item.mediaContent?.['$']?.url ||
          item.mediaThumbnail?.['$']?.url ||
          extractImage(item.contentEncoded || item.content || '') ||
          null;

        raw.push({
          id:       item.guid || item.link || String(Math.random()),
          title:    (item.title || '').trim(),
          link:     item.link || '#',
          content:  item.contentSnippet || item.content || item.summary || '',
          source:   feed.source,
          category: feed.category,
          pubDate:  item.pubDate || item.isoDate || new Date().toISOString(),
          image,
        });
      }
      console.log(`  ✓ ${feed.source} (${parsed.items?.length || 0} items)`);
    } catch (err) {
      console.warn(`  ✗ ${feed.source}: ${err.message}`);
    }
  }

  // Fetch LinkedIn
  const linkedinItems = await fetchLinkedIn();
  raw.push(...linkedinItems);

  if (!raw.length) {
    console.warn('[SAP Pulse] No items fetched from any feed.');
    return { lastUpdated: new Date().toISOString(), items: [] };
  }

  raw.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  const items = [];
  for (const item of raw.slice(0, 30)) {
    const summary = await summarise(item.title, item.content);
    items.push({ ...item, summary });
    await new Promise(r => setTimeout(r, 250));
  }

  // Save articles immediately so the refresh button responds fast
  const data = { lastUpdated: new Date().toISOString(), items };
  fs.writeFileSync(CACHE, JSON.stringify(data, null, 2));
  console.log(`[SAP Pulse] Cached ${items.length} articles. Fetching images in background...`);

  // Enrich with og:images in background — doesn't block the response
  enrichWithImages(items).then(() => {
    const withImages = items.filter(i => i.image).length;
    fs.writeFileSync(CACHE, JSON.stringify({ lastUpdated: data.lastUpdated, items }, null, 2));
    console.log(`[SAP Pulse] Images done: ${withImages}/${items.length}`);
  }).catch(() => {});

  return data;
}

// Extract first <img> src from HTML
function extractImage(html) {
  const m = (html || '').match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

// Fetch og:image from an article URL (reads only up to </head>)
function fetchOgImage(articleUrl) {
  return new Promise(resolve => {
    try {
      const mod = articleUrl.startsWith('https') ? https : http;
      let data  = '';
      let done  = false;

      const req = mod.get(articleUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SAP-Pulse/1.0)' },
        timeout: 5000,
      }, res => {
        res.on('data', chunk => {
          if (done) return;
          data += chunk.toString();
          if (data.includes('</head>') || data.length > 80000) {
            done = true;
            req.destroy();
          }
        });
        res.on('close', () => {
          if (done || data) {
            const m = data.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                   || data.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
                   || data.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
            resolve(m ? m[1] : null);
          } else resolve(null);
        });
      });
      req.setTimeout(5000, () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
    } catch { resolve(null); }
  });
}

// Fetch og:images in parallel batches
async function enrichWithImages(items) {
  const BATCH = 6;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const images = await Promise.all(batch.map(it => {
      if (it.image || it.category === 'Saved') return Promise.resolve(it.image);
      return fetchOgImage(it.link);
    }));
    images.forEach((img, j) => { if (img) items[i + j].image = img; });
  }
  return items;
}

// ── Routes ──────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/news', (_, res) => {
  const cached = fs.existsSync(CACHE)
    ? JSON.parse(fs.readFileSync(CACHE, 'utf8'))
    : { lastUpdated: null, items: [] };

  // Merge in manually saved posts
  const saved = loadSavedPosts();
  const allItems = [...saved, ...cached.items];
  allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  res.json({ lastUpdated: cached.lastUpdated, items: allItems });
});

app.post('/api/refresh', async (_, res) => {
  try {
    const data = await fetchAndCache();
    res.json({ success: true, count: data.items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save a LinkedIn post manually
app.post('/api/save-post', async (req, res) => {
  const { url, title, note } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const saved  = loadSavedPosts();
  const exists = saved.find(p => p.link === url);
  if (exists) return res.status(409).json({ error: 'Already saved' });

  const post = {
    id:       'saved_' + Date.now(),
    title:    title || 'LinkedIn Post',
    link:     url,
    summary:  note || 'Manually saved LinkedIn post.',
    content:  note || '',
    source:   'Saved by you',
    category: 'Saved',
    pubDate:  new Date().toISOString(),
    saved:    true,
  };

  // Try to auto-summarise if API key available
  if (anthropic && note) {
    post.summary = await summarise(post.title, note);
  }

  saved.unshift(post);
  writeSavedPosts(saved);
  res.json({ success: true, post });
});

// Delete a saved post
app.delete('/api/save-post/:id', (req, res) => {
  const saved   = loadSavedPosts();
  const updated = saved.filter(p => p.id !== req.params.id);
  writeSavedPosts(updated);
  res.json({ success: true });
});

// ── Scheduler: refresh daily at 8 AM ────────────────────
cron.schedule('0 8 * * *', fetchAndCache);

// ── Start ────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n  SAP Pulse  →  http://localhost:${PORT}\n`);
  if (!fs.existsSync(CACHE)) {
    await fetchAndCache();
  }
});
