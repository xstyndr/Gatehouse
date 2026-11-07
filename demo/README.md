# Gatehouse demo

A static version of Gatehouse. No server, no login. Attendee and organizer views
share one page (switch in the sidebar) and everything is saved in the browser's
localStorage.

## Run locally

Open `index.html` in a browser, or serve the folder:

    python -m http.server 8000

## Deploy

It is plain HTML, CSS and JS, so any static host works:

- **Netlify / Cloudflare Pages:** drag the `demo` folder into the dashboard.
- **GitHub Pages:** push the folder, then Settings, Pages, deploy from the branch and folder.
- **Vercel:** `vercel --prod` inside this folder.

## Notes

- Data is per browser and per site address. Clearing site data, or the Reset button, restores the sample events.
- Bookings run inside a Web Lock, so two tabs racing for the last ticket still produce exactly one winner.
- This is a demo: anyone can use the organizer view, and nothing is validated by a server.

Files: `index.html`, `style.css`, `common.js`, `app.js`
