// app.js — UI glue. Theme-base selector, per-base controls, in-browser build, USB install.
import { buildAll, loadAssets } from './lib/build.js';
import { initPreview } from './lib/preview.js';
import { hexToRgb } from './lib/json-recolor.js';
import * as adb from './lib/adb.js';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const log = (m) => { logEl.textContent += m + '\n'; logEl.scrollTop = logEl.scrollHeight; };

let built = null;          // last build results
let bgImageFile = null;    // optional uploaded background
let preview = null;        // preview controller
let selectedBase = null;   // current theme base id
const bars = {};           // active-bar gradient controls, keyed by control id
const inputs = {};         // control -> {color, text}

const { manifest } = await loadAssets();
const baseNames = Object.keys(manifest.bases);
selectedBase = baseNames[0];

// ── Theme base selector ──────────────────────────────────────────────────────
const baseSel = $('base');
baseSel.innerHTML = baseNames
  .map((b) => `<option value="${b}">${manifest.bases[b].label}</option>`).join('');
baseSel.value = selectedBase;
baseSel.addEventListener('change', async () => {
  selectedBase = baseSel.value;
  built = null; $('downloads').innerHTML = ''; $('install').disabled = true;
  renderControls();
  await initPreviewForBase();
});

function currentColors() {
  const c = {};
  for (const [k, io] of Object.entries(inputs)) c[k] = io.color.value;
  return c;
}
// Per-bar gradient spec: single = shades of one color; two = start->end + fade.
function specOf(b) {
  if (b.mode.value === 'two') {
    return { mode: 'two', c1: hexToRgb(b.start.value), c2: hexToRgb(b.end.value),
             fade: Number(b.fade.value) / 100 };
  }
  return { mode: 'single', c1: hexToRgb(b.c.value) };
}
function currentBarSpecs() {
  const map = { active_center: 'center', active_coolant: 'coolant', active_fuel: 'fuel' };
  const out = {};
  for (const [k, g] of Object.entries(map)) if (bars[k]) out[g] = specOf(bars[k]);
  return out;
}
function pushPreview() { preview?.update(currentColors(), bgImageFile, currentBarSpecs()); }

// ── Render controls for the selected base ────────────────────────────────────
function makeBar(parent, key, def) {
  const w = document.createElement('div');
  w.className = 'ctl';
  w.innerHTML = `
    <label>${manifest.control_labels[key] || key}</label>
    <div class="row"><select class="bar-mode">
      <option value="single">Single color (auto shades)</option>
      <option value="two">Custom 2-color gradient</option>
    </select></div>
    <div class="bar-single"><div class="row">
      <input type="color" class="bar-c" value="${def}" />
      <input type="text" class="bar-ct" value="${def}" spellcheck="false" /></div></div>
    <div class="bar-two" hidden>
      <div class="row"><span class="bar-lbl">start</span>
        <input type="color" class="bar-start" value="${def}" />
        <span class="bar-lbl">end</span>
        <input type="color" class="bar-end" value="${def}" /></div>
      <div class="row fade-row"><span>fade</span>
        <input type="range" min="0" max="100" value="50" class="bar-fade" /></div>
    </div>
    <small>single = shades of one color; custom = your own start→end gradient</small>`;
  parent.appendChild(w);
  const b = {
    mode: w.querySelector('.bar-mode'), c: w.querySelector('.bar-c'), ct: w.querySelector('.bar-ct'),
    start: w.querySelector('.bar-start'), end: w.querySelector('.bar-end'),
    fade: w.querySelector('.bar-fade'), single: w.querySelector('.bar-single'), two: w.querySelector('.bar-two'),
  };
  bars[key] = b;
  b.mode.addEventListener('change', () => {
    b.single.hidden = b.mode.value !== 'single';
    b.two.hidden = b.mode.value !== 'two';
    pushPreview();
  });
  b.c.addEventListener('input', () => { b.ct.value = b.c.value; pushPreview(); });
  b.ct.addEventListener('change', () => {
    if (/^#[0-9a-fA-F]{6}$/.test(b.ct.value)) { b.c.value = b.ct.value; pushPreview(); }
  });
  for (const e of [b.start, b.end, b.fade]) e.addEventListener('input', pushPreview);
}

function renderControls() {
  const el = $('controls');
  el.innerHTML = '';
  for (const k of Object.keys(inputs)) delete inputs[k];
  for (const k of Object.keys(bars)) delete bars[k];
  const controls = manifest.bases[selectedBase].controls;  // {control: defaultHex|null}

  for (const [key, def] of Object.entries(controls)) {
    if (key === 'bg_image') continue;                  // file picker, added below
    if (key.startsWith('active_')) { makeBar(el, key, def); continue; }  // gradient control
    const label = manifest.control_labels[key] || key;
    const wrap = document.createElement('div');
    wrap.className = 'ctl';
    wrap.innerHTML = `
      <label>${label}</label>
      <div class="row">
        <input type="color" value="${def}" />
        <input type="text" value="${def}" spellcheck="false" />
      </div>
      <small>default ${def}</small>`;
    el.appendChild(wrap);
    const [color, text] = wrap.querySelectorAll('input[type=color], input[type=text]');
    inputs[key] = { color, text };
    color.addEventListener('input', () => { text.value = color.value; pushPreview(); });
    text.addEventListener('change', () => {
      if (/^#[0-9a-fA-F]{6}$/.test(text.value)) { color.value = text.value; pushPreview(); }
    });
  }

  // background image upload (always available)
  const fileWrap = document.createElement('div');
  fileWrap.className = 'ctl file-ctl';
  fileWrap.innerHTML = `
    <label>${manifest.control_labels.bg_image || 'Background image'} (optional)</label>
    <div class="row"><input type="file" id="bgfile" accept="image/*" /></div>
    <small>Replaces the cluster background (auto-fit to 1280×800). Leave empty to keep the stock image.</small>`;
  el.appendChild(fileWrap);
  $('bgfile').addEventListener('change', (e) => { bgImageFile = e.target.files[0] || null; pushPreview(); });
}

async function initPreviewForBase() {
  bgImageFile = null;
  try {
    preview = await initPreview($('preview'), '.', selectedBase);
    pushPreview();
    preview.setGaugeMode($('gaugemode').value);   // re-apply chosen bar mode
  } catch (e) {
    $('preview').innerHTML = '<p class="pv-hint">Preview unavailable.</p>';
    console.error('preview init failed', e);
  }
}

// Gauge-bar debug mode (preview only): animate / lock full / hide.
$('gaugemode').addEventListener('change', (e) => preview?.setGaugeMode(e.target.value));

renderControls();
await initPreviewForBase();

// ── Build ────────────────────────────────────────────────────────────────────
$('build').addEventListener('click', async () => {
  $('build').disabled = true; $('install').disabled = true;
  $('downloads').innerHTML = ''; logEl.textContent = '';
  try {
    built = await buildAll(selectedBase, currentColors(), bgImageFile, currentBarSpecs(), log);
    const dl = $('downloads');
    dl.innerHTML = '<div style="margin-top:10px">Download (manual install):</div>';
    for (const a of built) {
      const url = URL.createObjectURL(new Blob([a.bytes], { type: 'application/vnd.android.package-archive' }));
      const link = document.createElement('a');
      link.className = 'dl'; link.href = url;
      link.download = `${selectedBase}-${a.name}.apk`; link.textContent = `${a.name}.apk`;
      dl.appendChild(link);
    }
    $('install').disabled = !adb.webusbSupported();
    if (!adb.webusbSupported()) log('\nWebUSB not available — use desktop Chrome/Edge to install, or download above.');
  } catch (e) {
    log('BUILD ERROR: ' + (e?.message || e));
    console.error(e);
  } finally {
    $('build').disabled = false;
  }
});

// ── Install over USB ──────────────────────────────────────────────────────────
$('install').addEventListener('click', async () => {
  if (!built) return;
  $('install').disabled = true;
  try {
    log('\nConnecting to device (pick it in the dialog)…');
    const device = await adb.connect(log);
    await adb.installAll(device, built, log);
  } catch (e) {
    log('INSTALL ERROR: ' + (e?.message || e));
    console.error(e);
  } finally {
    $('install').disabled = false;
  }
});
