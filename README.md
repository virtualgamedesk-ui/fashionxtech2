# Mira — AI fitting booth

Stand in front of the screen, press the button, and a 3-2-1 countdown takes your photo. Then pick an outfit, and an AI creates a picture of you wearing it.

## Run it

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
cd mira-booth
npm install          # once
npm start            # → http://localhost:8000
```

Open http://localhost:8000 in Chrome or Edge and allow the camera. Press **F** for fullscreen.

Without an AI key the booth runs in **demo mode**: the whole flow works, but the "result" is your own photo.

## Turn on the AI

The booth's server sends your photo and the chosen clothing photo to an image-editing AI. It can use any of these; fill in **one** in a `.env` file:

| Option | `.env` | Cost |
| --- | --- | --- |
| **Hugging Face token** | `HF_TOKEN=` | **free**, limited daily GPU time |
| Google AI Studio (Gemini) | `GEMINI_API_KEY=` | about $0.03–0.07 per image, billing must be on |
| Lovable AI Gateway (your friend's setup) | `IMAGE_API_KEY=` the project's `LOVABLE_API_KEY` | Lovable workspace credits |
| ChatGPT / OpenAI API key | `OPENAI_API_KEY=` | pay per image from API credit |
| Cloudflare Workers AI | `CF_ACCOUNT_ID=` + `CF_API_TOKEN=` | free, ~80–120 a day |
| FASHN try-on | `FASHN_API_KEY=` | a few cents per image |

Steps:
1. Copy `.env.example` to `.env`, with no `.txt` at the end. On Windows: open it in Notepad, choose *Save As*, set "Save as type" to *All files*, and name it `.env`.
2. Paste your key behind the matching line (e.g. `GEMINI_API_KEY=`) and save. If several are filled in, Hugging Face is used first.
3. Restart with `npm start`. The terminal shows which AI is on, e.g. `AI try-on: on, free via Hugging Face (Kwai-Kolors/Kolors-Virtual-Try-On → yisol/IDM-VTON)`.

The key stays on the local server (`server.mjs`); the browser never sees it. Keep `.env` private: anyone with the key can spend its credits.

**Hugging Face token (free):**
1. On huggingface.co, go to **Settings → Access Tokens → Create new token**. Type **Read** is enough. Copy the token; it starts with `hf_`.
2. Put it in `.env` as `HF_TOKEN=hf_...`, run `npm install` once, then `npm start`.
3. The booth sends the photos to free try-on Spaces (AI demos that Hugging Face runs on shared GPUs): first **Kolors Virtual Try-On**, then **IDM-VTON** if the first one fails. These are made specially for clothing, so they keep the face well.

What to expect:
- A result takes about 20–60 seconds. When it's busy you wait in a queue.
- Each account gets free GPU time per day, enough for a limited number of images. When it's used up, the booth says so; it refills over the day. A PRO account gets much more.
- A Space can sometimes be asleep or offline. The booth then tries the next one. You can choose other Spaces with `HF_SPACE=`.
- To see what another Space expects, run `npm run check-space -- owner/space-name` and add it to `SPACE_RECIPES` in `server.mjs`.

**Google AI Studio key:**
1. Go to aistudio.google.com and click **Get API key** → **Create API key**.
2. Turn on billing for that key's project: in AI Studio, click **Billing** or **Set up billing** next to the key. Without billing, the key works for text but not for images. The booth then says "image output needs billing".
3. Each try-on image costs a few cents. To limit spending, set a budget alert in Google Cloud Billing.

The Lovable option sends exactly the same request as your friend's `image-gateway.server.ts` (`POST /v1/images/edits` with both images and a prompt). The prompt is in `editPrompt()` in `server.mjs` if you want to tune it.

## The flow

1. **Live mirror.** The frame shows exactly what will be in the photo. Press the round button, or press Space.
2. **Countdown and flash.** The photo is taken mirrored, just as you saw yourself.
3. **Choose your outfit.** Tap one of your wardrobe items, then **Create my look**. **Retake photo** goes back.
4. **Creating your look.** A light sweeps over your photo while the AI works. **Cancel** stops it.
5. **Result.**
   - Hold the small photo in the corner to compare with the original.
   - **Try another outfit** reuses the same photo; **New photo** starts over.
   - **Save** downloads the image.

After 90 seconds without a tap, the booth returns to the live mirror for the next person.

Keys: Space (take photo / create), ← → (choose outfit), Esc (back), C (next camera), F (fullscreen).

## Adding clothes (the wardrobe)

The first time you open the booth, the **Wardrobe** opens by itself. Later you can open it with the **Wardrobe** button at the top right.

- **Add a photo.** Click one of the 5 slots, or drag a photo onto it. JPG, PNG or WebP all work.
- **Name and type.** Give each item a name and pick its type: Top, Bottom, Dress / one-piece, or Clothing. The type tells the AI what to replace.
- **Replace or remove.** Click a filled slot to replace its photo; **×** removes it.
- **Saved automatically.** Uploads are stored in `garments/uploads/` and stay after a restart.

The best clothing photos show one garment, front view, on a plain (preferably white) background, like a web shop product photo. Busy backgrounds or photos of a person wearing several items confuse the AI.

## Tips for good results

- Stand 1–2 m from the camera with your upper body in the frame. Face the camera, arms a little away from your body.
- Use even, bright light from the front, and a calm background.
- "The AI couldn't find your body" means you're too close, cut off, or turned away. Retake the photo.

## Settings

`js/config.js`:

- **Camera:** pick an external camera with `labelMatch` or `deviceId`. Set `mirror: false` if the camera already mirrors its image.
- **Countdown:** length in seconds.
- **Photo:** shape and size of the photo.
- **Idle reset:** how long until the booth returns to the live mirror.

## Files

```
index.html, css/style.css   booth interface
js/app.js                   flow: live → countdown → pick → generate → result
js/camera.js                camera access (swap point for another camera)
js/config.js                settings
garments/uploads/           your uploaded clothing photos + wardrobe.json
server.mjs                  local server + try-on API calls
.env.example                where the API key goes
tools/check-space.mjs       shows the inputs of a Hugging Face Space
```
