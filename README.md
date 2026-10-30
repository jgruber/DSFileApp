# DS File

A Chrome extension that recreates the Android **DS File** experience in the browser, talking directly to a Synology NAS over the [File Station Web API](https://global.download.synology.com/download/Document/Software/DeveloperGuide/Package/FileStation/All/enu/Synology_File_Station_API_Guide.pdf).

Written as a Manifest V3 extension — the extension's `host_permissions` let it reach the NAS without hitting CORS or mixed-content walls.

## Features

- Address / port / HTTPS login with 2-factor support and "Remember me"
- Browse shared folders and subfolders with breadcrumb navigation
- List and grid views; sort by name / modified / size / owner, ascending or descending
- Long-press (or tap-and-hold) multi-select with Download, Copy, Move, Delete, Share, Favorite
- Per-file overflow menu: Preview, Download, Rename, Copy to…, Move to…, Share link, Favorite, Properties, Delete
- Create folder, upload files, and drag-and-drop uploads with a progress tray
- In-app preview for images, video, audio, PDFs, and small text/code files
- Image thumbnails via `SYNO.FileStation.Thumb`
- Favorites, recent files (local), in-folder search
- Light / dark / system theme
- Session is kept in `sessionStorage`; the connection (address, user) in `chrome.storage.local`. The password is never stored.

## Install

Chrome does not allow installing a `.crx` from an arbitrary URL anymore — the only out-of-store path is **Load unpacked** from a local copy.

### Option A — clone (easiest to update)

```sh
git clone https://github.com/jgruber/DSFileApp.git ~/DSFileApp
```

Then in Chrome:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick `~/DSFileApp`
4. Pin the DS File icon to the toolbar

To update later: `cd ~/DSFileApp && git pull`, then click the ⟳ reload button on the extension card at `chrome://extensions`.

### Option B — download ZIP

On the repo page: **Code → Download ZIP** → unzip → **Load unpacked** on the unzipped folder. Rename the folder to `DSFileApp` (dropping the `-main` suffix) so Chrome keeps the same extension ID across reinstalls.

### Option C — GitHub Release

Download the `.zip` asset from a release, unzip it, and **Load unpacked** the folder.

## Using it

Click the DS File toolbar icon. The SPA opens in a tab.

Enter your NAS address — either a LAN IP (`192.168.1.10`), a hostname, or a DDNS name (`mynas.synology.me`). QuickConnect IDs on their own aren't resolved; use the real address.

### HTTPS with a self-signed certificate

If your NAS uses a self-signed HTTPS certificate (the default on DSM), Chrome will block the first `fetch` with `ERR_CERT_AUTHORITY_INVALID`. Visit `https://your-nas:5001` once in a normal Chrome tab and click through the warning — Chrome caches the exception, and the extension works from then on. The login screen displays that hint if the first sign-in fails this way.

## Permissions

Declared in `manifest.json`:

- `storage` — persist the last connection and theme
- `downloads` — save files to disk through Chrome's download manager instead of opening them in a new tab
- `<all_urls>` host permission — the extension can only know your NAS address at runtime, so it needs permission to fetch from any host. All traffic goes to the host you type into the login screen.

## Project structure

```
manifest.json     MV3 manifest
background.js     Service worker — opens the SPA tab on toolbar click
index.html        SPA shell
styles.css        Theming + layout
app.js            Synology API wrapper + the entire UI
```

No build step, no dependencies.

## Development

Edit the files in place, then click ⟳ on the extension's card at `chrome://extensions` to reload. Open DevTools on the DS File tab to see logs. The service worker has its own DevTools link on the extension card ("service worker") for `background.js`.

## License

MIT — do what you want.
