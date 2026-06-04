# pianostudio

Piano studio is a local piano practice app with Web MIDI support, realistic Tone.js piano audio, MIDI search/import, and a Synthesia-style practice mode.

## Run

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:5173/>.

## Features

- 88-key digital piano with Web MIDI, on-screen input, and computer keyboard fallback.
- Tone.js audio with Salamander Grand Piano samples through `@tonejs/piano`, plus a synthesized fallback.
- Song search through BitMidi, Midishare, a public-domain Mutopia fallback list, direct `.mid` URLs, and local MIDI upload.
- Falling-note practice view with strict wait mode and continuous flow mode.
- Track selection, scrubbing, reset, speed, transpose, metronome, count-in, volume, and range zoom.

Chrome or Edge are recommended for Web MIDI.

## Deploy to Vercel

This project is prepared for Vercel as a Vite app with root-level Vercel Functions:

- Frontend build command: `npm run build`
- Frontend output directory: `dist`
- API routes: `/api/health`, `/api/search`, and `/api/midi`
- Environment variables: none required

After pushing to GitHub, import the repository in Vercel and use the Vite framework preset. The included `vercel.json` keeps the build settings in the repo and rewrites non-file, non-API routes back to `index.html` for the single-page app.
