import hashlib
import os

import numpy as np
import torch
from aiohttp import web
from PIL import Image, ImageOps, ImageSequence

import folder_paths
import node_helpers
from server import PromptServer

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
EXCLUDED_FORMATS = {"MPO"}
BATCH_SEPARATOR = "\n"
THUMB_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache", "thumbs")
THUMB_CACHE_MAX_FILES = 2000


def split_selection(image):
    if not isinstance(image, str):
        return []
    return [p.strip().replace("\\", "/") for p in image.split(BATCH_SEPARATOR) if p.strip()]


def input_path(rel):
    return folder_paths.get_annotated_filepath(rel)


def image_info(full_path, rel):
    st = os.stat(full_path)
    with Image.open(full_path) as im:
        width, height = im.size
        fmt = (im.format or "").upper()
        has_alpha = "A" in im.getbands() or "transparency" in im.info
    return {
        "name": os.path.basename(full_path),
        "rel": rel,
        "size": st.st_size,
        "mtime": st.st_mtime,
        "width": width,
        "height": height,
        "format": fmt,
        "has_alpha": bool(has_alpha),
    }


async def magik_input_list(request):
    folder = (request.query.get("folder") or "").replace("\\", "/").strip("/")
    try:
        base = input_path(folder) if folder else folder_paths.get_input_directory()
    except ValueError:
        return web.json_response({"error": "invalid folder"}, status=400)
    if not os.path.isdir(base):
        return web.json_response({"error": "folder not found"}, status=404)
    images = []
    folders = []
    for entry in sorted(os.listdir(base)):
        full = os.path.join(base, entry)
        rel = f"{folder}/{entry}" if folder else entry
        if os.path.isdir(full):
            folders.append(rel)
            continue
        if os.path.splitext(entry)[1].lower() not in IMAGE_EXTENSIONS:
            continue
        try:
            images.append(image_info(full, rel))
        except Exception:
            continue
    return web.json_response({"folder": folder, "images": images, "folders": folders})


def thumb_cache_path(rel, width, st):
    key = hashlib.sha256(f"{rel}|{st.st_mtime_ns}|{st.st_size}|{width}".encode()).hexdigest()[:24]
    return os.path.join(THUMB_CACHE_DIR, key + ".jpg")


def prune_thumb_cache():
    try:
        files = [os.path.join(THUMB_CACHE_DIR, f) for f in os.listdir(THUMB_CACHE_DIR)]
    except OSError:
        return
    if len(files) <= THUMB_CACHE_MAX_FILES:
        return
    files.sort(key=lambda p: os.path.getmtime(p))
    for old in files[: len(files) - THUMB_CACHE_MAX_FILES]:
        try:
            os.remove(old)
        except OSError:
            pass


async def magik_input_thumb(request):
    rel = (request.query.get("path") or "").replace("\\", "/")
    if not rel:
        return web.Response(status=400)
    try:
        width = max(64, min(512, int(request.query.get("w", "256"))))
    except ValueError:
        width = 256
    try:
        full = input_path(rel)
    except ValueError:
        return web.Response(status=400)
    if not os.path.isfile(full):
        return web.Response(status=404)
    st = os.stat(full)
    cache_file = thumb_cache_path(rel, width, st)
    headers = {"Cache-Control": "public, max-age=86400"}
    if os.path.isfile(cache_file):
        return web.FileResponse(cache_file, headers=headers)
    try:
        with Image.open(full) as im:
            im = ImageOps.exif_transpose(im)
            im.thumbnail((width, width), Image.Resampling.LANCZOS)
            im = im.convert("RGB")
            os.makedirs(THUMB_CACHE_DIR, exist_ok=True)
            tmp = cache_file + f".{os.getpid()}.tmp"
            im.save(tmp, "JPEG", quality=82)
            os.replace(tmp, cache_file)
        prune_thumb_cache()
    except Exception:
        return web.Response(status=415)
    return web.FileResponse(cache_file, headers=headers)


def register_routes():
    if PromptServer.instance is None:
        return
    routes = PromptServer.instance.routes
    routes.get("/magik/input/list")(magik_input_list)
    routes.get("/magik/input/thumb")(magik_input_thumb)


class MagikLoadImage:
    CATEGORY = "Magik/image"
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("IMAGE", "MASK")
    FUNCTION = "load_image"
    DESCRIPTION = (
        "Loads image(s) from the ComfyUI input folder through a rich browser UI "
        "(thumbnails with resolution overlay, subfolders, recent folders, search). "
        "Outputs IMAGE and MASK (alpha channel, inverted, like the legacy Load Image node). "
        "Selecting multiple images (Ctrl/Cmd-click) loads them as one batch."
    )
    SEARCH_ALIASES = ["magik load image", "load image", "open image", "import image"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (sorted(folder_paths.get_filename_list("input")), {"image_upload": True}),
            }
        }

    @classmethod
    def VALIDATE_INPUTS(cls, image):
        parts = split_selection(image)
        if not parts:
            return "No image selected"
        for part in parts:
            try:
                ok = folder_paths.exists_annotated_filepath(part)
            except ValueError:
                ok = False
            if not ok:
                return f"Invalid image file: {part}"
        return True

    @classmethod
    def IS_CHANGED(cls, image):
        m = hashlib.sha256()
        for part in split_selection(image):
            m.update(part.encode())
            try:
                st = os.stat(input_path(part))
                m.update(str(st.st_mtime_ns).encode())
                m.update(str(st.st_size).encode())
            except (ValueError, OSError):
                m.update(b"missing")
        return m.hexdigest()

    def load_image(self, image):
        parts = split_selection(image)
        if not parts:
            raise ValueError("No image selected")
        output_images = []
        output_masks = []
        w = h = None
        for part in parts:
            image_path = input_path(part)
            img = node_helpers.pillow(Image.open, image_path)
            for frame in ImageSequence.Iterator(img):
                if getattr(frame, "format", None) in EXCLUDED_FORMATS:
                    continue
                frame = node_helpers.pillow(ImageOps.exif_transpose, frame)
                if w is None:
                    w, h = frame.size
                if frame.size[0] != w or frame.size[1] != h:
                    continue
                if "A" in frame.getbands():
                    mask = np.array(frame.getchannel("A")).astype(np.float32) / 255.0
                    mask = 1.0 - torch.from_numpy(mask)
                else:
                    mask = torch.zeros((h, w), dtype=torch.float32)
                rgb = frame.convert("RGB")
                arr = np.array(rgb).astype(np.float32) / 255.0
                output_images.append(torch.from_numpy(arr)[None,])
                output_masks.append(mask.unsqueeze(0))
        if not output_images:
            raise ValueError(f"No loadable image frames in: {image!r}")
        return (torch.cat(output_images, dim=0), torch.cat(output_masks, dim=0))


register_routes()

NODE_CLASS_MAPPINGS = {"MagikLoadImage": MagikLoadImage}
NODE_DISPLAY_NAME_MAPPINGS = {"MagikLoadImage": "Magik Load Image"}
