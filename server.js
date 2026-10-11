// ClipGenius AI — minimal production-minded Node.js server (no npm dependencies)
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.GEMINI_API_KEY || "";
const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const ROOT = __dirname;
const MAX_BODY = 12_000;
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 8;
const requests = new Map();

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store"
  });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > MAX_BODY) {
        reject(new Error("Запрос слишком большой"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); }
      catch { reject(new Error("Некорректный JSON")); }
    });
    req.on("error", reject);
  });
}
function rateLimited(ip) {
  const now = Date.now();
  const old = requests.get(ip);
  if (!old || now - old.start >= WINDOW_MS) {
    requests.set(ip, { start: now, count: 1 });
    return false;
  }
  old.count += 1;
  return old.count > MAX_REQUESTS_PER_WINDOW;
}
function makePrompt({ topic, platform, tone, audience }) {
  const toneNames = {
    curious: "любопытный и интригующий, но без кликбейта",
    expert: "экспертный, ясный и практичный",
    fun: "лёгкий, живой и уместно смешной",
    story: "личный рассказ с конкретной деталью"
  };
  return `Ты — опытный редактор коротких видео и контент-стратег. Создай полезный черновик на русском языке.
Тема: ${topic}
Платформа: ${platform}
Стиль: ${toneNames[tone] || toneNames.curious}
Целевая аудитория: ${audience || "люди, которым интересна эта тема"}

Верни:
1. Три варианта заголовка/хука.
2. Один сценарий с таймингом: начало, основная часть, финал/CTA.
3. Идеи визуальных кадров и подсказки по монтажу/субтитрам.
4. Краткое описание публикации.
5. 5-8 релевантных хэштегов (без обещаний просмотров).
6. Три идеи следующих видео по теме.
Не выдумывай факты, статистику, личный опыт автора или гарантии охватов. Если тема требует фактической точности, пометь, что следует проверить. Пиши конкретно, без длинного вступления.`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, 200, { ok: true, aiConfigured: Boolean(API_KEY), model: MODEL });
  }

  if (req.method === "POST" && url.pathname === "/api/generate") {
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").toString().split(",")[0].trim();
    if (rateLimited(ip)) return send(res, 429, { error: "Слишком много запросов. Подожди минуту и попробуй снова." });
    let input;
    try { input = await readJson(req); }
    catch (err) { return send(res, 400, { error: err.message || "Некорректный запрос" }); }

    const topic = typeof input.topic === "string" ? input.topic.trim() : "";
    const platform = typeof input.platform === "string" ? input.platform : "TikTok";
    const tone = typeof input.tone === "string" ? input.tone : "curious";
    const audience = typeof input.audience === "string" ? input.audience.trim() : "";
    const platforms = ["TikTok", "YouTube Shorts", "Instagram Reels", "YouTube — длинное видео"];
    const tones = ["curious", "expert", "fun", "story"];
    if (topic.length < 3 || topic.length > 500) return send(res, 400, { error: "Тема должна содержать от 3 до 500 символов." });
    if (!platforms.includes(platform)) return send(res, 400, { error: "Неизвестная платформа." });
    if (!tones.includes(tone)) return send(res, 400, { error: "Неизвестный стиль." });
    if (audience.length > 150) return send(res, 400, { error: "Описание аудитории слишком длинное." });
    if (!API_KEY) return send(res, 503, { error: "ИИ пока не подключён. В настройках сервера добавь GEMINI_API_KEY." });

    try {
      const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: "Ты создаёшь оригинальные, полезные сценарии для авторов видео. Не обещай просмотры или заработок. Отвечай на русском." }] },
          contents: [{ role: "user", parts: [{ text: makePrompt({ topic, platform, tone, audience }) }] }],
          generationConfig: { temperature: 0.8, maxOutputTokens: 1400 }
        }),
        signal: AbortSignal.timeout(45_000)
      });
      const payload = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        console.error("Gemini API error", upstream.status, payload?.error?.message || "");
        return send(res, 502, { error: "ИИ-провайдер не смог обработать запрос. Проверь API-ключ, доступ к модели и лимиты." });
      }
      const text = (payload.candidates || []).flatMap(c => c.content?.parts || []).map(p => p.text || "").join("\n").trim();
      if (!text) return send(res, 502, { error: "ИИ вернул пустой ответ. Попробуй сформулировать тему иначе." });
      return send(res, 200, { text, model: MODEL });
    } catch (err) {
      console.error("Generation failed", err.message);
      return send(res, 502, { error: "Не удалось связаться с ИИ-провайдером. Попробуй позже." });
    }
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    try {
      const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
      return send(res, 200, html, "text/html; charset=utf-8");
    } catch {
      return send(res, 500, "Не найден index.html", "text/plain; charset=utf-8");
    }
  }
  if (req.method === "GET" && url.pathname === "/favicon.ico") {
    res.writeHead(204); return res.end();
  }
  return send(res, 404, { error: "Не найдено" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ClipGenius AI running on port ${PORT}`);
  console.log(`AI ${API_KEY ? "configured" : "NOT configured — set GEMINI_API_KEY"}`);
});
