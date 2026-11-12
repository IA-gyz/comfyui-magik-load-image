# ComfyUI Magik Load Image

A drop-in replacement for the legacy **Load Image** node with a rich JavaScript
browser UI built into the node itself.

- Node: **Magik Load Image** (`MagikLoadImage`), category `Magik/image`
- Outputs: `IMAGE` and `MASK` (alpha channel, inverted — same semantics as the
  legacy Load Image node; images without alpha produce an all-zero mask)
- Selecting multiple images (Ctrl/Cmd-click) loads them as one batch
  (`B×H×W×3` / `B×H×W`); frames with a different resolution than the first image
  are skipped, mirroring legacy multi-frame behavior

## UI features

- Thumbnail grid (S/M/L) and list view, each thumbnail showing a
  **resolution overlay** (`1920 × 1080`) and an `α` badge for images with an
  alpha channel
- Subfolder navigation with breadcrumbs and a **recently used folders** list
  (stored in `localStorage`, most-recent-first, max 8)
- Search, alpha filter, and sorting (name / date / size / resolution)
- Inline preview of the selection with resolution overlay, plus a mask
  (alpha channel) preview toggle
- Upload via button, drag & drop, or clipboard paste (uses the core
  `/upload/image` endpoint into the current folder, then auto-selects)
- Double-click a thumbnail for a fullscreen lightbox with prev/next navigation
- Random pick (🎲), keyboard navigation (arrows + Enter, `/` focuses search)
- Per-node UI state (folder, sort, view, search, selection) persists with the
  workflow

## Backend endpoints

Custom routes registered on the ComfyUI server (all paths are validated to stay
inside the `input/` directory):

- `GET /magik/input/list?folder=<relative folder>` — JSON listing of images
  (`name`, `rel`, `size`, `mtime`, `width`, `height`, `format`, `has_alpha`)
  and subfolders of one folder
- `GET /magik/input/thumb?path=<relative path>&w=<64..512>` — JPEG thumbnail,
  disk-cached under `cache/thumbs/` (keyed by path + mtime + size + width)

## Install

Clone into `ComfyUI/custom_nodes/` and restart ComfyUI:

```bash
git clone https://github.com/IA-gyz/comfyui-magik-load-image.git
```

## Layout

```
__init__.py               # exports NODE_CLASS_MAPPINGS + WEB_DIRECTORY
magik_load_image.py       # MagikLoadImage node + /magik/input/* routes
web/magik_load_image.js   # frontend extension (app.registerExtension)
web/magik.css             # widget styles, incl. the resolution overlay
```
