// server.js – Minimal HTTP server with two endpoints (Node.js 22+)
// ---------------------------------------------------------------
// 1. POST /echo           – echoes the received JSON back to the caller.
// 2. POST /media          – accepts either a transcript (plain text) or a
//                           base64‑encoded image. If an image is provided,
//                           the server calls Anthropic's Messages API to
//                           obtain a detailed description. Both transcripts
//                           and image descriptions are saved as .txt files;
//                           images are saved alongside their corresponding
//                           description using the same timestamp‑based name.
//
//   Directories:
//     ./transcripts  – text files received via the "transcript" field
//     ./images       – images + their description files
//
//   Environment variables:
//     PORT                 – optional, defaults to 3000
//     ANTHROPIC_API_KEY    – **required** for /media image handling
//     ANTHROPIC_MODEL      – optional, Claude model name (default haiku)
//
//   Run:  node server.js  (ensure package.json has { "type": "module" })
// ---------------------------------------------------------------

import { createServer } from 'node:http';
import { json as consumeJSON } from 'node:stream/consumers';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';

const PORT = process.env.PORT ?? 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-3-7-sonnet-20250219';

// Output directories – created lazily on first use
const TRANSCRIPTS_DIR = path.resolve('./transcripts');
const IMAGES_DIR = path.resolve('./images');

/**
 * Ensures the given directory exists (mkdir -p behaviour).
 */
async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

/**
 * Generates a safe filename based on the current timestamp (local TZ, second precision).
 * Example: 2025-05-17-02-40-24
 */
function timestampName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/**
 * Calls Anthropic's Messages API (vision) to describe a base64 image.
 * @param {string} base64Data – image bytes encoded as base64 (PNG/JPEG/…)
 * @param {string} mediaType  – e.g. "image/png"
 * @returns {Promise<string>} – the model's textual description
 */
async function describeImageWithAnthropic(base64Data, mediaType) {
  if (!ANTHROPIC_KEY)
    throw new Error('Anthropic API key missing (set ANTHROPIC_API_KEY)');

  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: base64Data,
            },
          },
          {
            type: 'text',
            text: 'Please describe this image in detail.',
          },
        ],
      },
    ],
  };

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic API error: ${resp.status} — ${errText}`);
  }

  const data = await resp.json();
  // The model's answer is usually the first content block, type === 'text'.
  const contentBlock = data?.content?.find((c) => c.type === 'text');
  return contentBlock?.text ?? 'No description returned.';
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  // ---- simple timing / logging ----
  const start = process.hrtime.bigint();
  console.log(`→ ${req.method} ${pathname}`);
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`← ${req.method} ${pathname} ${res.statusCode} ${durationMs.toFixed(1)}ms`);
  });

  // -------- POST /echo ------------------------------------------------------
  if (req.method === 'POST' && pathname === '/echo') {
    try {
      const body = await consumeJSON(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: body }, null, 2));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }

  // -------- POST /media -----------------------------------------------------
  if (req.method === 'POST' && pathname === '/media') {
    try {
      const body = await consumeJSON(req);

      // Expect either { transcript: "..." } OR { image: "base64Data", mediaType?: "image/png" }
      if (typeof body.transcript === 'string') {
        await ensureDir(TRANSCRIPTS_DIR);
        const filename = `${timestampName()}.txt`;
        const filepath = path.join(TRANSCRIPTS_DIR, filename);
        await writeFile(filepath, body.transcript, 'utf8');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ saved: path.relative('.', filepath) }));
        return;
      }

      if (typeof body.image === 'string') {
        // Determine media type (default to PNG if not provided)
        const mediaType = body.mediaType ?? 'image/png';
        await ensureDir(IMAGES_DIR);
        const baseName = timestampName();
        const imgPath = path.join(IMAGES_DIR, `${baseName}.${mediaType.split('/')[1]}`);
        const txtPath = path.join(IMAGES_DIR, `${baseName}.txt`);

        // Save image file
        await writeFile(imgPath, Buffer.from(body.image, 'base64'));

        // Call Anthropic to describe the image
        const description = await describeImageWithAnthropic(body.image, mediaType);
        await writeFile(txtPath, description, 'utf8');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ saved_image: path.relative('.', imgPath), description_file: path.relative('.', txtPath) })
        );
        return;
      }

      // If neither transcript nor image provided
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request must include a "transcript" or "image" field.' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // -------- 404 for all other routes ---------------------------------------
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`🚀  Listening on http://localhost:${PORT}/echo and /media`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  server.close(() => {
    console.log('\n👋  Server stopped');
    process.exit(0);
  });
});
