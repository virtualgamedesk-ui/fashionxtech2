/*
 * Mira booth server: serves the booth and runs the AI try-on so the API key never reaches the browser.
 *
 *   npm start                    → http://localhost:8000
 *
 * AI (put the keys in a .env file next to this one, see .env.example):
 *   free  Hugging Face Spaces:              HF_TOKEN
 *   Google AI Studio (Gemini):                GEMINI_API_KEY
 *   image API (Lovable AI Gateway / OpenAI): IMAGE_API_KEY or OPENAI_API_KEY
 *   free  Cloudflare Workers AI: CF_ACCOUNT_ID + CF_API_TOKEN
 *   paid  FASHN try-on API:      FASHN_API_KEY
 * Without keys the booth runs in demo mode: it returns your own photo so you can test the flow.
 */
import http from 'node:http';
import { readFile, stat, writeFile, mkdir, unlink } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

// minimal .env loader
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const PORT = Number(process.env.PORT || 8000);

// Free: Cloudflare Workers AI (FLUX.2 Klein, ~80-120 images/day on the free plan)
const CF_ACCOUNT = process.env.CF_ACCOUNT_ID || '';
const CF_TOKEN = process.env.CF_API_TOKEN || '';
const CF_MODEL = process.env.CF_MODEL || '@cf/black-forest-labs/flux-2-klein-4b';
// Paid alternative: FASHN try-on API
const KEY = process.env.FASHN_API_KEY || '';
const MODEL = process.env.FASHN_MODEL || 'tryon-v1.6';
const QUALITY = process.env.FASHN_MODE || 'balanced';      // performance | balanced | quality
const API = 'https://api.fashn.ai/v1';

// Image-edit API in OpenAI format (same as your friend's Lovable AI Gateway code; also works with OpenAI itself)
// OPENAI_API_KEY alone is enough to use OpenAI's image model directly.
const OPENAI = process.env.OPENAI_API_KEY || '';
const IMG_KEY = process.env.IMAGE_API_KEY || process.env.LOVABLE_API_KEY || OPENAI;
const IMG_BASE = (process.env.IMAGE_BASE_URL || (IMG_KEY === OPENAI && OPENAI ? 'https://api.openai.com' : 'https://ai.gateway.lovable.dev')).replace(/\/+$/, '');
const IMG_MODEL = process.env.IMAGE_MODEL || (IMG_BASE.includes('openai.com') ? 'gpt-image-1' : 'openai/gpt-image-2.5-sunburst');

// Google AI Studio (Gemini image model, "Nano Banana")
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-nano-banana-2.1';
const GEMINI_BASE = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');

// Hugging Face (free): try-on Spaces on ZeroGPU, with your token's daily free GPU allowance
const HF_TOKEN = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || '';
const HF_SPACES = (process.env.HF_SPACE || 'Kwai-Kolors/Kolors-Virtual-Try-On,yisol/IDM-VTON').split(',').map((x) => x.trim()).filter(Boolean);

const PROVIDER = HF_TOKEN ? 'huggingface' : GEMINI_KEY ? 'gemini' : IMG_KEY ? 'openai-images' : CF_ACCOUNT && CF_TOKEN ? 'cloudflare' : KEY ? 'fashn' : 'demo';
const MODE = PROVIDER === 'demo' ? 'demo' : 'live';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8',
};

const send = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readBody(req, limit = 15 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('Photo too large'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/* ---------------- wardrobe: up to 5 uploaded garments ---------------- */
const MAX_ITEMS = 5;
const UPLOADS = join(ROOT, 'garments', 'uploads');
const WARDROBE = join(UPLOADS, 'wardrobe.json');
const CATEGORIES = ['tops', 'bottoms', 'one-pieces', 'auto'];

async function loadWardrobe() {
  try { return JSON.parse(await readFile(WARDROBE, 'utf8')); } catch { return []; }
}
async function saveWardrobe(items) {
  await mkdir(UPLOADS, { recursive: true });
  await writeFile(WARDROBE, JSON.stringify(items, null, 2));
}
const cleanName = (n, i) => String(n || '').replace(/[<>]/g, '').trim().slice(0, 40) || `Item ${i + 1}`;

async function addItem({ image, name, category }) {
  const items = await loadWardrobe();
  if (items.length >= MAX_ITEMS) throw new Error(`The wardrobe holds ${MAX_ITEMS} items. Remove one first.`);
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(image || '');
  if (!m) throw new Error('Upload a JPG, PNG or WebP image');
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  await mkdir(UPLOADS, { recursive: true });
  await writeFile(join(UPLOADS, `${id}.${ext}`), Buffer.from(m[2], 'base64'));
  const item = {
    id, name: cleanName(name, items.length),
    category: CATEGORIES.includes(category) ? category : 'auto',
    image: `garments/uploads/${id}.${ext}`,
  };
  items.push(item);
  await saveWardrobe(items);
  return item;
}
async function updateItem(id, { name, category }) {
  const items = await loadWardrobe();
  const it = items.find((x) => x.id === id);
  if (!it) throw new Error('Item not found');
  if (name !== undefined) it.name = cleanName(name, items.indexOf(it));
  if (CATEGORIES.includes(category)) it.category = category;
  await saveWardrobe(items);
  return it;
}
async function removeItem(id) {
  const items = await loadWardrobe();
  const it = items.find((x) => x.id === id);
  if (!it) return;
  await unlink(join(ROOT, it.image)).catch(() => {});
  await saveWardrobe(items.filter((x) => x !== it));
}

/** Garment photos are read from /garments only, and sent as data URIs. */
async function garmentDataUri(path) {
  const file = resolve(ROOT, normalize(String(path)).replace(/^([/\\])+/, ''));
  if (!file.startsWith(join(ROOT, 'garments'))) throw new Error('Unknown garment');
  const type = TYPES[extname(file).toLowerCase()];
  if (!type || !type.startsWith('image/')) throw new Error('Garment must be an image');
  return `data:${type};base64,${(await readFile(file)).toString('base64')}`;
}

async function fashn(path, init = {}) {
  const r = await fetch(API + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}`, ...(init.headers || {}) },
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { error: text }; }
  if (!r.ok) throw new Error(errText(data.error) || `Try-on service error ${r.status}`);
  return data;
}
const errText = (e) => (!e ? '' : typeof e === 'string' ? e : [e.name, e.message].filter(Boolean).join(': '));

const isDataUri = (s) => /^data:image\/(jpeg|png|webp);base64,/.test(s || '');
const dataUriToBlob = (uri) => {
  const [head, b64] = uri.split(',');
  return new Blob([Buffer.from(b64, 'base64')], { type: head.slice(5, head.indexOf(';')) });
};

const WORDS = { tops: 'top', bottoms: 'trousers', 'one-pieces': 'outfit', auto: 'clothing' };
function prompt(category) {
  const what = WORDS[category] || 'clothing';
  return `Image 0 is a photo of a person. Image 1 is a product photo of a ${what}. `
    + `Edit image 0 so the person is wearing the ${what} from image 1, replacing what they wear there. `
    + 'Keep the same person: identical face, hair, skin tone, body shape, pose, expression, framing and background. '
    + 'Match the garment colour, pattern, logos and details exactly, with a natural fit, folds and lighting. Photorealistic photo.';
}

/**
 * OpenAI-format image edit (POST {base}/v1/images/edits, multipart with image[] files + prompt),
 * the same request your friend's image-gateway.server.ts sends. Non-streaming, so one JSON answer.
 */
async function openaiImages({ person, garmentImage, category }) {
  const form = new FormData();
  form.set('model', IMG_MODEL);
  form.set('prompt', editPrompt(category));
  form.append('image[]', dataUriToBlob(person), 'person.jpg');
  form.append('image[]', dataUriToBlob(garmentImage), 'garment.jpg');
  form.set('size', '1024x1536');
  form.set('n', '1');
  const r = await fetch(`${IMG_BASE}/v1/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${IMG_KEY}` },
    body: form,
  }).catch(() => { throw new Error('Can’t reach the AI service. Check that this computer is online.'); });

  const text = await r.text();
  if (!r.ok) {
    let msg = text.slice(0, 300);
    try { const j = JSON.parse(text); msg = j.error?.message || j.error || j.message || msg; } catch {}
    if (r.status === 401) throw new Error('The AI key was not accepted. Check the key in .env.');
    if (r.status === 403 && /verif/i.test(String(msg))) throw new Error('OpenAI asks you to verify your organization before using its image model (platform.openai.com → Settings → Organization).');
    if (r.status === 403) throw new Error(typeof msg === 'string' && msg ? msg : 'The AI key is not allowed to use this model.');
    if (r.status === 402 || /insufficient_quota|billing/i.test(String(msg))) throw new Error('The AI account is out of credits. Add credit on the provider’s billing page.');
    if (r.status === 429) throw new Error('Too many requests right now. Wait a moment and try again.');
    throw new Error(typeof msg === 'string' ? msg : `AI service error ${r.status}`);
  }
  const image = pickImage(text);
  if (!image) throw new Error('The AI returned no image');
  return { image };
}

/* ---------------- Hugging Face Spaces ---------------- */
/**
 * How to call each known try-on Space. `args` builds the inputs for its /tryon endpoint.
 * Another Space? Run `npm run check-space -- owner/name` to see its inputs and add it here.
 */
const SPACE_RECIPES = {
  'Kwai-Kolors/Kolors-Virtual-Try-On': {
    endpoint: '/tryon',
    args: ({ person, garment }) => ({ person_img: person, garment_img: garment, seed: 0, randomize_seed: true }),
  },
  'yisol/IDM-VTON': {
    endpoint: '/tryon',
    args: ({ person, garment, category }) => ({
      dict: { background: person, layers: [], composite: null },
      garm_img: garment,
      garment_des: WORDS[category] || 'clothing',
      is_checked: true,       // auto-mask the body
      is_checked_crop: false,
      denoise_steps: 30,
      seed: Math.floor(Math.random() * 1e6),
    }),
  },
};

let gradio = null;
async function gradioClient() {
  if (!gradio) {
    try { gradio = await import('@gradio/client'); }
    catch { throw new Error('Run "npm install" in the booth folder first (needed for Hugging Face).'); }
  }
  return gradio;
}
const connections = new Map();

async function huggingface({ person, garmentImage, category }) {
  const { Client } = await gradioClient();
  const errors = [];
  for (const space of HF_SPACES) {
    const recipe = SPACE_RECIPES[space];
    if (!recipe) { errors.push(`${space}: unknown Space (add it to SPACE_RECIPES)`); continue; }
    try {
      let app = connections.get(space);
      if (!app) {
        app = await Client.connect(space, { token: HF_TOKEN });
        connections.set(space, app);
      }
      const result = await app.predict(recipe.endpoint, recipe.args({
        person: dataUriToBlob(person), garment: dataUriToBlob(garmentImage), category,
      }));
      const out = Array.isArray(result.data) ? result.data[0] : result.data;
      const url = out?.url || out?.path || (typeof out === 'string' ? out : null);
      if (!url) throw new Error('the Space returned no image');
      if (url.startsWith('data:')) return { image: url, via: space };
      const r = await fetch(url, { headers: { Authorization: `Bearer ${HF_TOKEN}` } });
      if (!r.ok) throw new Error(`could not download the result (${r.status})`);
      const type = r.headers.get('content-type') || 'image/png';
      return { image: `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`, via: space };
    } catch (e) {
      connections.delete(space);
      const msg = e?.message || String(e);
      console.error(`Hugging Face ${space}:`, msg);
      errors.push(`${space}: ${msg}`);
      if (/quota|exceeded/i.test(msg) && /GPU/i.test(msg)) {
        throw new Error('Today’s free Hugging Face GPU time is used up. It refills over the day (a PRO account gets much more).');
      }
    }
  }
  const all = errors.join(' | ');
  if (/401|403|token|unauthori/i.test(all)) throw new Error('Hugging Face didn’t accept the token. Check HF_TOKEN in .env (it starts with hf_).');
  if (/metadata could not be loaded|fetch failed|ENOTFOUND|ECONN/i.test(all)) throw new Error('Can’t reach Hugging Face. Check the internet connection, or the Space may be offline.');
  if (/sleep|paused|building|runtime error|not found|404/i.test(all)) throw new Error('The free try-on Space is asleep or offline right now. Try again in a minute, or set another HF_SPACE in .env.');
  throw new Error(`The free AI couldn’t make the image. ${all.slice(0, 220)}`);
}

/** Google AI Studio: Gemini generateContent with the prompt + both photos, asking for an image back. */
async function gemini({ person, garmentImage, category }) {
  const part = (uri) => {
    const [head, data] = uri.split(',');
    return { inlineData: { mimeType: head.slice(5, head.indexOf(';')), data } };
  };
  const body = {
    contents: [{ role: 'user', parts: [{ text: editPrompt(category) }, part(person), part(garmentImage)] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '2:3' } },
  };
  const r = await fetch(`${GEMINI_BASE}/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify(body),
  }).catch(() => { throw new Error('Can’t reach the AI service. Check that this computer is online.'); });

  const text = await r.text();
  let data = {}; try { data = JSON.parse(text); } catch {}
  if (!r.ok) {
    const msg = data.error?.message || text.slice(0, 300) || `Gemini error ${r.status}`;
    if (r.status === 400 && /API key not valid/i.test(msg)) throw new Error('The Google AI Studio key was not accepted. Check GEMINI_API_KEY in .env.');
    if (r.status === 429 || /quota|free tier|billing/i.test(msg)) throw new Error('Google says this key can’t make images right now. Image output needs billing turned on for the key’s project (AI Studio → Billing), or the quota is used up.');
    if (r.status === 404) throw new Error(`The model "${GEMINI_MODEL}" wasn’t found. Set GEMINI_MODEL in .env to a current image model.`);
    throw new Error(msg);
  }
  const cand = data.candidates?.[0];
  const img = cand?.content?.parts?.find((p) => p.inlineData?.data || p.inline_data?.data);
  if (img) {
    const d = img.inlineData || img.inline_data;
    return { image: `data:${d.mimeType || d.mime_type || 'image/png'};base64,${d.data}` };
  }
  if (data.promptFeedback?.blockReason || /SAFETY|PROHIBITED|IMAGE_SAFETY/.test(cand?.finishReason || '')) {
    throw new Error('The AI declined this photo. Try another photo or garment.');
  }
  const said = cand?.content?.parts?.map((p) => p.text).filter(Boolean).join(' ');
  throw new Error(said ? `The AI replied without an image: ${said.slice(0, 160)}` : 'The AI returned no image');
}

/** Finds the image in a JSON answer, or in the last event of a streamed (SSE) answer. */
function pickImage(text) {
  const fromJson = (j) => {
    const d = j?.data?.[0] || j;
    if (d?.b64_json) return `data:image/png;base64,${d.b64_json}`;
    if (d?.url) return d.url;
    // chat-style answers (gemini / image models via chat completions)
    const msg = j?.choices?.[0]?.message;
    const img = msg?.images?.[0]?.image_url?.url || msg?.images?.[0]?.url;
    return img || null;
  };
  try { return fromJson(JSON.parse(text)); } catch {}
  let found = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { found = fromJson(JSON.parse(payload)) || found; } catch {}
  }
  return found;
}

function editPrompt(category) {
  const what = WORDS[category] || 'clothing';
  return `The first image is a photo of a person. The second image is a product photo of a ${what}. `
    + `Edit the first image so the person is wearing the ${what} from the second image instead of what they wear there now. `
    + 'Keep everything else exactly the same: the same face and identity, hair, skin tone, body shape, pose, expression, framing, lighting and background. '
    + 'Copy the garment faithfully: colour, pattern, print, logos, fabric and details. Make it fit the body naturally with realistic folds and shadows. '
    + 'The result must look like an unedited, photorealistic photo.';
}

/** Free route: Cloudflare Workers AI with person + garment as reference images. */
async function cloudflare({ personSmall, garmentSmall, category }) {
  if (!isDataUri(personSmall) || !isDataUri(garmentSmall)) throw new Error('Missing reference images');
  const form = new FormData();
  form.append('prompt', prompt(category));
  form.append('input_image_0', dataUriToBlob(personSmall), 'person.jpg');
  form.append('input_image_1', dataUriToBlob(garmentSmall), 'garment.jpg');
  form.append('width', '768');
  form.append('height', '1152');
  form.append('seed', String(Math.floor(Math.random() * 1e9)));
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${CF_MODEL}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CF_TOKEN}` },
    body: form,
  }).catch(() => { throw new Error('Can’t reach the AI service. Check that this computer is online.'); });
  const type = r.headers.get('content-type') || '';
  if (r.ok && type.startsWith('image/')) {
    return { image: `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}` };
  }
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = {}; }
  if (!r.ok || data.success === false) {
    const msg = data.errors?.map((e) => e.message).join('; ') || text.slice(0, 200) || `Cloudflare error ${r.status}`;
    if (r.status === 429 || /neuron|limit|quota/i.test(msg)) throw new Error('Today’s free AI images are used up. The limit resets at 02:00 (midnight UTC).');
    if (r.status === 401 || r.status === 403) throw new Error('Cloudflare API key not accepted. Check CF_ACCOUNT_ID and CF_API_TOKEN in .env.');
    throw new Error(msg);
  }
  const img = data.result?.image ?? data.image;
  if (!img) throw new Error('The AI returned no image');
  return { image: img.startsWith('data:') ? img : `data:image/jpeg;base64,${img}` };
}

async function tryOn(body) {
  const { person, garment, category = 'auto', photoType = 'auto' } = body;
  if (!isDataUri(person)) throw new Error('Missing photo');
  const garmentImage = await garmentDataUri(garment);

  if (PROVIDER === 'demo') { await sleep(3500); return { image: person, demo: true }; }
  if (PROVIDER === 'huggingface') return huggingface({ person, garmentImage, category });
  if (PROVIDER === 'gemini') return gemini({ person, garmentImage, category });
  if (PROVIDER === 'openai-images') return openaiImages({ person, garmentImage, category });
  if (PROVIDER === 'cloudflare') return cloudflare(body);

  const run = await fashn('/run', {
    method: 'POST',
    body: JSON.stringify({
      model_name: MODEL,
      inputs: {
        model_image: person,
        garment_image: garmentImage,
        category,
        garment_photo_type: photoType,
        mode: QUALITY,
        output_format: 'jpeg',
        return_base64: true,
      },
    }),
  });
  if (!run.id) throw new Error(errText(run.error) || 'The try-on service did not accept the request');

  const deadline = Date.now() + 110000;
  while (Date.now() < deadline) {
    await sleep(1500);
    const s = await fashn(`/status/${run.id}`);
    if (s.status === 'completed') {
      const out = Array.isArray(s.output) ? s.output[0] : s.output;
      if (!out) throw new Error('The try-on service returned no image');
      return { image: out };
    }
    if (!['starting', 'in_queue', 'processing'].includes(s.status)) throw new Error(errText(s.error) || `Try-on ${s.status}`);
  }
  throw new Error('The try-on service took too long');
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/status') return send(res, 200, { mode: MODE, provider: PROVIDER });

    if (url.pathname === '/api/wardrobe') {
      if (req.method === 'GET') return send(res, 200, { items: await loadWardrobe(), max: MAX_ITEMS });
      if (req.method === 'POST') {
        try { return send(res, 200, await addItem(await readBody(req))); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
    }
    const wm = url.pathname.match(/^\/api\/wardrobe\/([a-z0-9]+)$/);
    if (wm) {
      try {
        if (req.method === 'DELETE') { await removeItem(wm[1]); return send(res, 200, { ok: true }); }
        if (req.method === 'PATCH') return send(res, 200, await updateItem(wm[1], await readBody(req)));
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (url.pathname === '/api/tryon') {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      const started = Date.now();
      try {
        const out = await tryOn(await readBody(req));
        console.log(`try-on ${MODE} done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        return send(res, 200, out);
      } catch (e) {
        console.error('try-on failed:', e.message);
        return send(res, 502, { error: e.message });
      }
    }

    // static files
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    if (!path || path.endsWith('/') || path.endsWith('\\')) path += 'index.html';
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT) || /(^|[/\\])(\.env|node_modules|server\.mjs|wardrobe\.json)/.test(path)) return send(res, 404, { error: 'Not found' });
    const s = await stat(file).catch(() => null);
    if (!s || !s.isFile()) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(file));
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
}).listen(PORT, () => {
  console.log(`Mira booth: http://localhost:${PORT}`);
  console.log({
    huggingface: `AI try-on: on, free via Hugging Face (${HF_SPACES.join(' → ')})`,
    gemini: `AI try-on: on via Google AI Studio (${GEMINI_MODEL})`,
    'openai-images': `AI try-on: on via ${IMG_BASE} (${IMG_MODEL})`,
    cloudflare: `AI try-on: on, free via Cloudflare Workers AI (${CF_MODEL})`,
    fashn: `AI try-on: on via FASHN (${MODEL}, ${QUALITY})`,
    demo: 'AI try-on: DEMO MODE (no keys in .env), results show your own photo',
  }[PROVIDER]);
});
