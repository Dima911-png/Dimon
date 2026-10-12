
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.GEMINI_API_KEY || "";
const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const ROOT = __dirname;
const MAX_BODY = 12000;
const WINDOW_MS = 60000;
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

  res.end(
    type.startsWith("application/json")
      ? JSON.stringify(body)
      : body
  );
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let finished = false;

    req.on("data", chunk => {
      if (finished) return;

      raw += chunk.toString("utf8");

      if (Buffer.byteLength(raw, "utf8") > MAX_BODY) {
        finished = true;
        reject(new Error("Запрос слишком большой"));
        req.resume();
      }
    });

    req.on("end", () => {
      if (finished) return;

      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new Error("Некорректный JSON"));
      }
    });

    req.on("error", err => {
      if (!finished) reject(err);
    });
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
    curious: "интригующий, вызывающий любопытство без кликбейта",
    expert: "экспертный, ясный и практичный",
    fun: "живой, энергичный и уместно смешной",
    story: "личный рассказ с конкретными деталями"
  };

  const platformNames = {
    "TikTok": "TikTok: динамичный вертикальный ролик с сильным началом",
    "YouTube Shorts": "YouTube Shorts: короткое видео с быстрым темпом и ясным финалом",
    "Instagram Reels": "Instagram Reels: визуально привлекательный вертикальный ролик",
    "YouTube — длинное видео": "YouTube: подробное видео с логичной структурой и раскрытием темы"
  };

  return `Ты — профессиональный сценарист, редактор видео и контент-стратег.

Создай оригинальный, конкретный и полезный материал, который автор сможет использовать для подготовки видео.

ТЕМА: ${topic}
ПЛАТФОРМА: ${platformNames[platform] || platform}
СТИЛЬ: ${toneNames[tone] || toneNames.curious}
ЦЕЛЕВАЯ АУДИТОРИЯ: ${audience || "люди, которым интересна эта тема"}

ГЛАВНЫЕ ПРАВИЛА:
- Раскрывай именно указанную тему, а не пиши общие советы.
- Используй естественный, современный русский язык.
- Не повторяй одну мысль разными словами.
- Не выдумывай факты, статистику, источники или личный опыт автора.
- Не обещай вирусные просмотры, подписчиков или заработок.
- Начало должно заинтересовать зрителя, но не вводить его в заблуждение.
- Учитывай формат выбранной платформы.
- Для коротких видео пиши сценарий примерно на 20–60 секунд, если тема позволяет.
- Для длинных видео предлагай подходящую продолжительность и подробную структуру.
- Если тема требует проверки фактов, прямо укажи это.

СТРУКТУРА ОТВЕТА:

1. ИДЕЯ ВИДЕО
Кратко объясни, о чём видео и почему оно будет интересно аудитории.

2. ТРИ СИЛЬНЫХ ХУКА
Предложи три разных варианта начала. Они должны быстро привлечь внимание и соответствовать теме.

3. ГОТОВЫЙ СЦЕНАРИЙ
Разбей его на этапы с примерным таймингом.
Для каждого этапа укажи:
- Точный текст, который говорит автор.
- Что зритель видит на экране.
- Какие кадры, приближения, переходы или визуальные акценты нужны.

4. СУБТИТРЫ И МОНТАЖ
Предложи короткие акцентные фразы для субтитров.
Укажи, где полезны смена кадра, приближение и удаление лишних пауз.
Не предлагай неестественно ускорять речь.

5. ФИНАЛ
Напиши естественную концовку и один подходящий призыв к действию.

6. ОПИСАНИЕ ПУБЛИКАЦИИ
Подготовь короткое описание для выбранной платформы.

7. ХЭШТЕГИ
Предложи 5–8 релевантных хэштегов.

8. ТРИ НОВЫЕ ИДЕИ
Предложи три конкретных продолжения темы для будущих видео.

Перед выдачей проверь, что материал логичен, конкретен, не повторяется и соответствует теме.
Не показывай внутренние рассуждения. Выведи только готовый результат с понятными заголовками.`;
}

const server = http.createServer(async (req, res) => {
  let url;

  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    return send(res, 400, { error: "Некорректный адрес запроса." });
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, 200, {
      ok: true,
      aiConfigured: Boolean(API_KEY),
      model: MODEL
    });
  }

  if (req.method === "POST" && url.pathname === "/api/generate") {
    const ip = (
      req.headers["x-forwarded-for"] ||
      req.socket.remoteAddress ||
      "unknown"
    ).toString().split(",")[0].trim();

    if (rateLimited(ip)) {
      return send(res, 429, {
        error: "Слишком много запросов. Подожди минуту и попробуй снова."
      });
    }

    let input;

    try {
      input = await readJson(req);
    } catch (err) {
      return send(res, 400, {
        error: err.message || "Некорректный запрос."
      });
    }

    const topic = typeof input.topic === "string" ? input.topic.trim() : "";
    const platform = typeof input.platform === "string" ? input.platform : "TikTok";
    const tone = typeof input.tone === "string" ? input.tone : "curious";
    const audience = typeof input.audience === "string" ? input.audience.trim() : "";

    const platforms = [
      "TikTok",
      "YouTube Shorts",
      "Instagram Reels",
      "YouTube — длинное видео"
    ];

    const tones = ["curious", "expert", "fun", "story"];

    if (topic.length < 3 || topic.length > 500) {
      return send(res, 400, {
        error: "Тема должна содержать от 3 до 500 символов."
      });
    }

    if (!platforms.includes(platform)) {
      return send(res, 400, { error: "Неизвестная платформа." });
    }

    if (!tones.includes(tone)) {
      return send(res, 400, { error: "Неизвестный стиль." });
    }

    if (audience.length > 150) {
      return send(res, 400, {
        error: "Описание аудитории слишком длинное."
      });
    }

    if (!API_KEY) {
      return send(res, 503, {
        error: "ИИ не подключён. Проверь настройку GEMINI_API_KEY в Render."
      });
    }

    try {
      const upstream = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": API_KEY
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{
                text: "Ты профессиональный русскоязычный сценарист и контент-стратег. Создавай оригинальные, конкретные и полезные материалы. Не выдумывай факты и не обещай просмотры или заработок."
              }]
            },
            contents: [{
              role: "user",
              parts: [{
                text: makePrompt({ topic, platform, tone, audience })
              }]
            }],
            generationConfig: {
              temperature: 0.85,
              maxOutputTokens: 3000
            }
          }),
          signal: AbortSignal.timeout(45000)
        }
      );

      const payload = await upstream.json().catch(() => ({}));

      if (!upstream.ok) {
        console.error(
          "Gemini API error:",
          upstream.status,
          payload?.error?.message || "Unknown provider error"
        );

        return send(res, 502, {
          error: "ИИ не смог обработать запрос. Проверь модель, API-ключ и лимиты Gemini."
        });
      }

      const text = (payload.candidates || [])
        .flatMap(candidate => candidate.content?.parts || [])
        .map(part => part.text || "")
        .join("\n")
        .trim();

      if (!text) {
        return send(res, 502, {
          error: "ИИ вернул пустой ответ. Попробуй другую формулировку темы."
        });
      }

      return send(res, 200, { text, model: MODEL });
    } catch (err) {
      console.error("Generation failed:", err.message);

      return send(res, 502, {
        error: "Не удалось связаться с ИИ. Попробуй позже."
      });
    }
  }

  if (req.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/index.html")) {
    try {
      const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
      return send(res, 200, html, "text/html; charset=utf-8");
    } catch {
      return send(res, 500, "Не найден index.html", "text/plain; charset=utf-8");
    }
  }

  if (req.method === "GET" && url.pathname === "/favicon.ico") {
    res.writeHead(204);
    return res.end();
  }

  return send(res, 404, { error: "Не найдено" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ClipGenius AI running on port ${PORT}`);
  console.log(`AI ${API_KEY ? "configured" : "NOT configured — set GEMINI_API_KEY"}`);
  console.log(`Model: ${MODEL}`);
});
