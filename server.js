
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ROOT = __dirname;

const LANGS = {
  ru: 'Russian',
  en: 'English',
  kk: 'Kazakh',
  zh: 'Simplified Chinese',
  ar: 'Arabic'
};

const ACTIONS = [
  'script',
  'viral',
  'timed',
  'calendar',
  'titles',
  'rewrite'
];

const limits = new Map();

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function limited(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = limits.get(ip) || { start: now, count: 0 };

  if (now - entry.start > 60000) {
    entry = { start: now, count: 0 };
  }

  entry.count++;
  limits.set(ip, entry);
  return entry.count > 10;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';

    req.on('data', chunk => {
      raw += chunk;

      if (raw.length > 20000) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', reject);
  });
}

function promptFor(d) {
  const lang = LANGS[d.language] || 'Russian';

  const context = `
Write entirely in ${lang}.
Be specific, creative, natural and useful.
Never guarantee viral success or a particular number of views.

Topic: ${d.topic}
Platform: ${d.platform || 'TikTok'}
Style: ${d.tone || 'engaging'}
Target audience: ${d.audience || 'general audience'}
`;

  const prompts = {
    script: `
Create a complete video package:
1. Five opening hooks.
2. A ready-to-record script.
3. Suggested on-screen text and subtitles.
4. Visual ideas and editing instructions.
5. A call to action.
6. Three titles and a description.
7. Eight relevant hashtags.
8. Three ideas for follow-up videos.

For long YouTube videos, include a detailed outline,
sections and approximate durations.
${context}
`,

    viral: `
Generate 15 original video ideas.
For each idea include a title, opening hook,
main payoff, suggested format and why viewers
might find it interesting.
Rank the five strongest ideas.
Do not promise viral results.
${context}
`,

    timed: `
Create a detailed editing plan for a video.
Use 30-60 seconds for short-form videos.
For long-form videos, choose a suitable duration.

Include timestamps, voiceover, subtitles,
visuals, cuts, transitions, sound cues,
pacing and a complete spoken script.
${context}
`,

    calendar: `
Create a ${d.days === 30 ? 30 : 7}-day content calendar.
For each day include the topic, hook, format,
outline, call to action, title and hashtags.
Vary the ideas and avoid repetition.
${context}
`,

    titles: `
Generate 20 titles grouped by curiosity,
benefits, storytelling and search intent.
Also create five descriptions, 15 hashtags
and five thumbnail concepts with exact cover text.
${context}
`,

    rewrite: `
Improve the user's draft without changing
its core meaning.

Return:
1. The improved complete version.
2. A stronger opening hook.
3. A clearer structure.
4. Tighter wording.
5. Suggested cuts and editing improvements.
6. A brief explanation of the changes.

Draft:
${d.draft || ''}

${context}
`
  };

  return prompts[d.action] || prompts.script;
}

async function generate(d) {
  if (!API_KEY) {
    throw Object.assign(
      new Error('Add GEMINI_API_KEY in Render Environment.'),
      { status: 503 }
    );
  }

  if (
    typeof d.topic !== 'string' ||
    d.topic.trim().length < 3
  ) {
    throw Object.assign(
      new Error('Enter a topic of at least 3 characters.'),
      { status: 400 }
    );
  }

  if (d.topic.length > 500) {
    throw Object.assign(
      new Error('Topic must be no longer than 500 characters.'),
      { status: 400 }
    );
  }

  if (!ACTIONS.includes(d.action || 'script')) {
    throw Object.assign(
      new Error('Unknown generator action.'),
      { status: 400 }
    );
  }

  if (
    d.action === 'rewrite' &&
    (!d.draft || d.draft.trim().length < 3)
  ) {
    throw Object.assign(
      new Error('Paste a draft to rewrite.'),
      { status: 400 }
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': API_KEY
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text:
                'You are ClipGenius AI, a professional video ' +
                'scriptwriter, content strategist and editing assistant. ' +
                'Follow the requested format. Never guarantee views.'
            }]
          },
          contents: [{
            parts: [{ text: promptFor({
              ...d,
              action: d.action || 'script'
            }) }]
          }],
          generationConfig: {
            temperature: 0.85,
            maxOutputTokens:
              d.action === 'calendar' && d.days === 30
                ? 7000
                : 5000
          }
        }),
        signal: controller.signal
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message =
        data?.error?.message ||
        `Gemini API error (${response.status})`;

      throw Object.assign(new Error(message), { status: 502 });
    }

    const result = (data.candidates || [])
      .flatMap(candidate => candidate.content?.parts || [])
      .map(part => part.text || '')
      .join('\n')
      .trim();

    if (!result) {
      throw Object.assign(
        new Error('Empty AI response. Please try again.'),
        { status: 502 }
      );
    }

    return result;
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, {
      ok: true,
      aiConfigured: Boolean(API_KEY),
      model: MODEL,
      features: ACTIONS
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/generate') {
    if (limited(req)) {
      return send(res, 429, {
        ok: false,
        error: 'Too many requests. Wait one minute and try again.'
      });
    }

    try {
      const data = await readBody(req);
      const result = await generate(data);

      return send(res, 200, {
        ok: true,
        text: result,
        action: data.action || 'script',
        model: MODEL
      });
    } catch (error) {
      return send(res, error.status || 400, {
        ok: false,
        error: error.name === 'AbortError'
          ? 'AI request timed out. Please try again.'
          : error.message || 'Generation failed.'
      });
    }
  }

  let pathname;

  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, { error: 'Invalid URL' });
  }

  if (pathname === '/') pathname = '/index.html';

  const file = path.resolve(ROOT, '.' + pathname);

  if (
    !file.startsWith(ROOT + path.sep) &&
    file !== path.join(ROOT, 'index.html')
  ) {
    return send(res, 403, { error: 'Forbidden' });
  }

  fs.readFile(file, (error, buffer) => {
    if (error) {
      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8'
      });
      return res.end('Not found');
    }

    const ext = path.extname(file);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon'
    };

    res.writeHead(200, {
      'Content-Type':
        types[ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff'
    });

    res.end(buffer);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `ClipGenius AI running on port ${PORT}; ` +
    `model=${MODEL}; keyConfigured=${Boolean(API_KEY)}`
  );
});



      
                
          
      