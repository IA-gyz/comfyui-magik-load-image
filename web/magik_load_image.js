import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_CLASS = "MagikLoadImage";
const RECENT_KEY = "magik.loadImage.recentFolders";
const MAX_RECENT = 8;
const BATCH_SEP = "\n";

const CSS_HREF = new URL("magik.css", import.meta.url).href;
if (!document.querySelector(`link[href="${CSS_HREF}"]`)) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_HREF;
  document.head.appendChild(link);
}

const THUMB_WIDTH = { "grid-s": 128, "grid-m": 240, "grid-l": 360, list: 72 };
const SORTS = {
  "name-asc": { label: "Name ↑", fn: (a, b) => a.name.localeCompare(b.name) },
  "name-desc": { label: "Name ↓", fn: (a, b) => b.name.localeCompare(a.name) },
  "date-desc": { label: "Newest", fn: (a, b) => b.mtime - a.mtime },
  "date-asc": { label: "Oldest", fn: (a, b) => a.mtime - b.mtime },
  "size-desc": { label: "Largest", fn: (a, b) => b.size - a.size },
  "size-asc": { label: "Smallest", fn: (a, b) => a.size - b.size },
  "res-desc": { label: "Resolution ↓", fn: (a, b) => b.width * b.height - a.width * a.height },
  "res-asc": { label: "Resolution ↑", fn: (a, b) => a.width * a.height - b.width * b.height },
};
const VIEWS = { "grid-s": "Grid S", "grid-m": "Grid M", "grid-l": "Grid L", list: "List" };
const FILTERS = { all: "All", alpha: "Has alpha", noalpha: "No alpha" };

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

function getState(node) {
  const p = (node.properties ??= {});
  const defaults = {
    folder: "",
    sort: "name-asc",
    view: "grid-m",
    search: "",
    filter: "all",
    showPreview: true,
    maskPreview: false,
    selected: [],
  };
  if (!p.magik) p.magik = { ...defaults };
  for (const k of Object.keys(defaults)) if (!(k in p.magik)) p.magik[k] = defaults[k];
  return p.magik;
}

function getRecents() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function pushRecent(folder) {
  const next = [folder, ...getRecents().filter((f) => f !== folder)].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {}
}

function splitRel(rel) {
  const i = rel.lastIndexOf("/");
  return i >= 0
    ? { filename: rel.slice(i + 1), subfolder: rel.slice(0, i) }
    : { filename: rel, subfolder: "" };
}

function viewUrl(rel, channel) {
  const { filename, subfolder } = splitRel(rel);
  const q = new URLSearchParams({ filename, subfolder, type: "input" });
  if (channel) q.set("channel", channel);
  return "/view?" + q.toString();
}

function thumbUrl(rel, w) {
  return `/magik/input/thumb?path=${encodeURIComponent(rel)}&w=${w}`;
}

let lightbox = null;

function closeLightbox() {
  if (!lightbox) return;
  document.removeEventListener("keydown", lightbox.onKey);
  lightbox.box.remove();
  lightbox = null;
}

function openLightbox(node, rel) {
  const M = node.__magik;
  const list = [...M.grid.querySelectorAll(".magik-cell[data-rel]")].map((c) => c.dataset.rel);
  if (!list.length) return;
  let idx = Math.max(0, list.indexOf(rel));
  closeLightbox();
  const box = el("div", "magik-lightbox", document.body);
  const img = el("img", "", box);
  const bar = el("div", "magik-lb-bar", box);
  const prev = el("button", "magik-lb-btn magik-lb-prev", box, "‹");
  const next = el("button", "magik-lb-btn magik-lb-next", box, "›");
  const close = el("button", "magik-lb-close", box, "✕");
  const show = () => {
    const r = list[idx];
    img.src = viewUrl(r);
    const im = (M.data.images || []).find((x) => x.rel === r);
    bar.textContent = im
      ? `${splitRel(r).filename} — ${im.width} × ${im.height} — ${im.format} — ${fmtSize(im.size)}`
      : splitRel(r).filename;
  };
  prev.addEventListener("click", () => {
    idx = (idx - 1 + list.length) % list.length;
    show();
  });
  next.addEventListener("click", () => {
    idx = (idx + 1) % list.length;
    show();
  });
  close.addEventListener("click", closeLightbox);
  box.addEventListener("click", (e) => {
    if (e.target === box) closeLightbox();
  });
  const onKey = (e) => {
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "ArrowLeft") prev.click();
    else if (e.key === "ArrowRight") next.click();
  };
  document.addEventListener("keydown", onKey);
  lightbox = { box, onKey, node };
  show();
}

function buildBrowser(node) {
  const imageWidget = node.widgets?.find((w) => w.name === "image");
  if (imageWidget) imageWidget.computeSize = () => [0, -4];

  const state = getState(node);
  const M = (node.__magik = {
    state,
    imageWidget,
    data: { images: [], folders: [] },
    cursor: -1,
  });

  const root = el("div", "magik-browser");
  root.tabIndex = 0;

  const toolbar = el("div", "magik-toolbar", root);
  const search = el("input", "magik-search", toolbar);
  search.type = "search";
  search.placeholder = "Search…";
  search.value = state.search;

  const filterSel = el("select", "magik-filter", toolbar);
  for (const [v, label] of Object.entries(FILTERS)) {
    const o = el("option", "", filterSel, label);
    o.value = v;
  }
  filterSel.value = state.filter;
  filterSel.title = "Filter by alpha channel";

  const sortSel = el("select", "magik-sort", toolbar);
  for (const [v, s] of Object.entries(SORTS)) {
    const o = el("option", "", sortSel, s.label);
    o.value = v;
  }
  sortSel.value = state.sort;
  sortSel.title = "Sort";

  const viewSel = el("select", "magik-view", toolbar);
  for (const [v, label] of Object.entries(VIEWS)) {
    const o = el("option", "", viewSel, label);
    o.value = v;
  }
  viewSel.value = state.view;
  viewSel.title = "View";

  const refreshBtn = el("button", "magik-btn", toolbar, "⟳");
  refreshBtn.title = "Refresh";
  const uploadBtn = el("button", "magik-btn", toolbar, "⬆");
  uploadBtn.title = "Upload image(s) into the current folder";
  const randomBtn = el("button", "magik-btn", toolbar, "🎲");
  randomBtn.title = "Select a random image";
  const previewBtn = el("button", "magik-btn", toolbar, "👁");
  previewBtn.title = "Toggle preview";
  const maskBtn = el("button", "magik-btn", toolbar, "α");
  maskBtn.title = "Toggle mask (alpha channel) preview";

  const fileInput = el("input", "magik-file", toolbar);
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.multiple = true;
  fileInput.style.display = "none";

  const folderBar = el("div", "magik-folders", root);
  const crumbs = el("div", "magik-crumbs", folderBar);
  const recentWrap = el("div", "magik-recent", folderBar);

  const grid = el("div", `magik-grid ${state.view}`, root);
  M.grid = grid;

  const status = el("div", "magik-status", root);
  const count = el("span", "magik-count", status);
  const selLabel = el("span", "magik-sel", status);
  M.count = count;
  M.selLabel = selLabel;

  const preview = el("div", "magik-preview", root);
  const pimg = el("img", "magik-pimg", preview);
  pimg.alt = "preview";
  const pres = el("span", "magik-res", preview);
  const pname = el("span", "magik-pname", preview);
  M.preview = preview;
  M.pimg = pimg;
  M.pres = pres;
  M.pname = pname;
  preview.style.display = state.showPreview ? "" : "none";

  node.addDOMWidget("magik_browser", "div", root, {
    hideOnZoom: false,
    getValue: () => "",
    setValue: () => {},
  });

  const origComputeSize = node.computeSize?.bind(node);
  node.computeSize = function (out) {
    const size = origComputeSize ? origComputeSize(out) : [460, 520];
    size[0] = Math.max(size[0], 460);
    return size;
  };
  node.setSize(node.computeSize());

  const visibleImages = () => {
    const q = state.search.trim().toLowerCase();
    const list = (M.data.images || []).filter((im) => {
      if (q && !im.name.toLowerCase().includes(q)) return false;
      if (state.filter === "alpha" && !im.has_alpha) return false;
      if (state.filter === "noalpha" && im.has_alpha) return false;
      return true;
    });
    const sorter = SORTS[state.sort] ?? SORTS["name-asc"];
    return [...list].sort(sorter.fn);
  };

  function updateStatus() {
    const total = (M.data.images || []).length;
    const shown = grid.querySelectorAll(".magik-cell[data-rel]").length;
    count.textContent = M.data.error ? "error" : `${shown}/${total} images`;
    if (state.selected.length === 1) {
      const im = (M.data.images || []).find((x) => x.rel === state.selected[0]);
      selLabel.textContent = im ? `${im.name} — ${im.width} × ${im.height}` : state.selected[0];
    } else if (state.selected.length > 1) {
      selLabel.textContent = `${state.selected.length} selected (batch)`;
    } else {
      selLabel.textContent = "nothing selected";
    }
  }

  function updatePreview() {
    const rel = state.selected[0];
    if (!rel) {
      preview.style.display = "none";
      return;
    }
    preview.style.display = state.showPreview ? "" : "none";
    const im = (M.data.images || []).find((x) => x.rel === rel);
    pimg.src = viewUrl(rel, state.maskPreview ? "a" : "rgb");
    pres.textContent = im ? `${im.width} × ${im.height}` : "";
    pname.textContent =
      (state.maskPreview ? "mask: " : "") +
      splitRel(rel).filename +
      (state.selected.length > 1 ? ` (+${state.selected.length - 1})` : "");
  }

  function applySelection() {
    const rels = state.selected;
    if (imageWidget) {
      const value = rels.join(BATCH_SEP);
      imageWidget.value = value;
      const values = imageWidget.options?.values;
      if (Array.isArray(values) && value && !values.includes(value)) values.push(value);
      imageWidget.callback?.(value);
    }
    for (const c of grid.querySelectorAll(".magik-cell[data-rel]")) {
      c.classList.toggle("magik-selected", rels.includes(c.dataset.rel));
    }
    updateStatus();
    updatePreview();
    app.canvas?.setDirty(true, true);
  }

  function renderGrid() {
    grid.innerHTML = "";
    M.cursor = -1;
    for (const f of M.data.folders || []) {
      const tile = el("div", "magik-cell magik-folder-tile", grid);
      el("span", "magik-folder-icon", tile, "📁");
      el("span", "magik-name", tile, f.split("/").pop());
      tile.title = f;
      tile.addEventListener("click", () => loadFolder(f));
    }
    const images = visibleImages();
    if (!(M.data.folders || []).length && !images.length) {
      el("div", "magik-empty", grid, M.data.error ? `Error: ${M.data.error}` : "No images in this folder");
    }
    for (const im of images) {
      const cell = el("div", "magik-cell", grid);
      cell.dataset.rel = im.rel;
      const tw = el("div", "magik-thumb", cell);
      const img = el("img", "", tw);
      img.loading = "lazy";
      img.alt = im.name;
      img.src = thumbUrl(im.rel, THUMB_WIDTH[state.view] ?? 240);
      img.onerror = () => {
        img.onerror = null;
        img.src = viewUrl(im.rel) + "&preview=webp;60";
      };
      el("span", "magik-res", tw, `${im.width} × ${im.height}`);
      if (im.has_alpha) el("span", "magik-alpha", tw, "α");
      el("span", "magik-name", cell, im.name);
      cell.title = `${im.name} — ${im.width}×${im.height}, ${im.format}, ${fmtSize(im.size)}`;
      cell.addEventListener("click", (e) => {
        if (e.ctrlKey || e.metaKey) {
          const i = state.selected.indexOf(im.rel);
          if (i >= 0) state.selected.splice(i, 1);
          else state.selected.push(im.rel);
        } else {
          state.selected = [im.rel];
        }
        applySelection();
      });
      cell.addEventListener("dblclick", () => openLightbox(node, im.rel));
    }
    updateStatus();
  }

  function renderCrumbs() {
    crumbs.innerHTML = "";
    const rootBtn = el("button", "magik-crumb", crumbs, "input");
    rootBtn.addEventListener("click", () => loadFolder(""));
    const parts = state.folder ? state.folder.split("/") : [];
    parts.forEach((p, i) => {
      el("span", "magik-crumb-sep", crumbs, "/");
      const b = el("button", "magik-crumb", crumbs, p);
      const prefix = parts.slice(0, i + 1).join("/");
      b.addEventListener("click", () => loadFolder(prefix));
    });
  }

  function renderRecents() {
    recentWrap.innerHTML = "";
    const recents = getRecents();
    if (!recents.length) return;
    el("span", "magik-recent-label", recentWrap, "Recent:");
    for (const f of recents) {
      const chip = el("button", "magik-recent-chip", recentWrap, f === "" ? "input" : f);
      chip.title = f === "" ? "input (root folder)" : f;
      chip.addEventListener("click", () => loadFolder(f));
    }
  }

  async function loadFolder(folder) {
    state.folder = folder;
    pushRecent(folder);
    renderCrumbs();
    renderRecents();
    M.data.error = null;
    updateStatus();
    try {
      const res = await api.fetchApi(`/magik/input/list?folder=${encodeURIComponent(folder)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      M.data = await res.json();
      M.data.error = null;
    } catch (err) {
      M.data = { images: [], folders: [], error: String(err) };
    }
    renderGrid();
  }

  async function uploadFiles(files) {
    let last = null;
    for (const file of files) {
      selLabel.textContent = `Uploading ${file.name}…`;
      try {
        const fd = new FormData();
        fd.append("image", file, file.name);
        fd.append("type", "input");
        fd.append("subfolder", state.folder);
        fd.append("overwrite", "true");
        const res = await api.fetchApi("/upload/image", { method: "POST", body: fd });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        last = data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
      } catch (err) {
        selLabel.textContent = `Upload failed: ${file.name} (${err})`;
      }
    }
    await loadFolder(state.folder);
    if (last) {
      state.selected = [last];
      applySelection();
    }
  }

  function onKeyDown(e) {
    if (e.key === "/" && document.activeElement !== search) {
      e.preventDefault();
      search.focus();
      return;
    }
    const cells = [...grid.querySelectorAll(".magik-cell[data-rel]")];
    if (!cells.length) return;
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const cols = Math.max(1, Math.floor(grid.clientWidth / 140));
      if (M.cursor < 0) M.cursor = 0;
      else if (e.key === "ArrowRight") M.cursor = Math.min(cells.length - 1, M.cursor + 1);
      else if (e.key === "ArrowLeft") M.cursor = Math.max(0, M.cursor - 1);
      else if (e.key === "ArrowDown") M.cursor = Math.min(cells.length - 1, M.cursor + cols);
      else if (e.key === "ArrowUp") M.cursor = Math.max(0, M.cursor - cols);
      cells.forEach((c, i) => c.classList.toggle("magik-cursor", i === M.cursor));
      cells[M.cursor].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && M.cursor >= 0) {
      e.preventDefault();
      const rel = cells[M.cursor].dataset.rel;
      if (e.ctrlKey || e.metaKey) {
        const i = state.selected.indexOf(rel);
        if (i >= 0) state.selected.splice(i, 1);
        else state.selected.push(rel);
      } else {
        state.selected = [rel];
      }
      applySelection();
    }
  }

  let searchTimer = null;
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = search.value;
      renderGrid();
    }, 150);
  });
  filterSel.addEventListener("change", () => {
    state.filter = filterSel.value;
    renderGrid();
  });
  sortSel.addEventListener("change", () => {
    state.sort = sortSel.value;
    renderGrid();
  });
  viewSel.addEventListener("change", () => {
    state.view = viewSel.value;
    grid.className = `magik-grid ${state.view}`;
    renderGrid();
  });
  refreshBtn.addEventListener("click", () => loadFolder(state.folder));
  uploadBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    uploadFiles([...fileInput.files]);
    fileInput.value = "";
  });
  randomBtn.addEventListener("click", () => {
    const list = visibleImages();
    if (list.length) {
      state.selected = [list[Math.floor(Math.random() * list.length)].rel];
      applySelection();
    }
  });
  previewBtn.addEventListener("click", () => {
    state.showPreview = !state.showPreview;
    updatePreview();
  });
  maskBtn.addEventListener("click", () => {
    state.maskPreview = !state.maskPreview;
    updatePreview();
  });

  root.addEventListener("dragover", (e) => {
    e.preventDefault();
    root.classList.add("magik-dragover");
  });
  root.addEventListener("dragleave", () => root.classList.remove("magik-dragover"));
  root.addEventListener("drop", (e) => {
    e.preventDefault();
    root.classList.remove("magik-dragover");
    const fs = [...(e.dataTransfer?.files ?? [])];
    if (fs.length) uploadFiles(fs);
  });
  root.addEventListener("paste", (e) => {
    const fs = [...(e.clipboardData?.files ?? [])];
    if (fs.length) {
      e.preventDefault();
      uploadFiles(fs);
    }
  });
  root.addEventListener("keydown", onKeyDown);

  const prevOnRemoved = node.onRemoved?.bind(node);
  node.onRemoved = function (...args) {
    prevOnRemoved?.(...args);
    if (lightbox?.node === node) closeLightbox();
  };

  M.loadFolder = loadFolder;
  M.applySelection = applySelection;
  M.renderGrid = renderGrid;
  renderCrumbs();
  renderRecents();
}

function initMagik(node) {
  if (node.__magik || !node.graph) return false;
  buildBrowser(node);
  const state = getState(node);
  const w = node.widgets?.find((x) => x.name === "image");
  const v = String(w?.value ?? "");
  if (v) state.selected = v.split(BATCH_SEP).map((s) => s.trim()).filter(Boolean);
  node.__magik.loadFolder(state.folder).then(() => node.__magik.applySelection());
  return true;
}

app.registerExtension({
  name: "magik.loadImage",
  async beforeRegisterNodeDef(nodeData) {
    if (nodeData.name !== NODE_CLASS) return;

    const onNodeCreated = nodeData.prototype.onNodeCreated;
    nodeData.prototype.onNodeCreated = function () {
      onNodeCreated?.apply(this, arguments);
      const node = this;
      queueMicrotask(() => {
        if (!initMagik(node)) node.__magikPending = true;
      });
    };

    const onConfigure = nodeData.prototype.onConfigure;
    nodeData.prototype.onConfigure = function (...args) {
      onConfigure?.apply(this, args);
      if (this.__magikPending) {
        this.__magikPending = false;
        const node = this;
        queueMicrotask(() => initMagik(node));
      }
    };
  },
});
