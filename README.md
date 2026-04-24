# Don's Repo Viewer

My repo viewer is a no-framework source tree visualizer for browsing repositories as rooms, graphs, and hotspots.

## Use online

Feel free to use https://donreagan.ca/repoviewer, nothing is tracked or logged.

## Open a repo

- Paste a public GitHub repo URL and click **Open GitHub**.
- Click **Pick Folder** to scan a local folder in supported browsers.
- Run the optional Python server if direct local path scanning or Git status is needed.

## Optional local server

```bash
python server.py --root "C:/path/to/repos"
```

Then open http://127.0.0.1:8080 in your web browser to view the page

this is completely optional as it offers very few additional features such as git status and semi-improved local-path loading

## Features

- Static HTML, CSS, and vanilla JavaScript frontend
- Public GitHub traversal without cloning
- Optional Python standard-library backend
- Walk view for folders and files
- Graph view for import/include relationships
- Draggable graph orbs with labels
- Hotspot view for large and busy files
- Theme colour picker with complementary accents
- Movable and resizable cards with optional snapping
- Search by path, symbol, and loaded file content

## Notes

The scanner is intentionally lightweight. It uses practical pattern matching for symbols and imports instead of compiler-specific indexing.
