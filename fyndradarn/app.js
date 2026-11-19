/* Fyndradarn – filmar loppisbord, låter AI känna igen föremålen och larmar vid fynd över gränsen. */
'use strict';
(() => {
  const VERSION = '1.0.0';
  const LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const API = LOCAL ? '/api' : 'https://pxskckkdftnknqcgpbng.supabase.co/functions/v1/fyndradarn';

  const $ = (s) => document.querySelector(s);
  const app = $('#app');
  const video = $('#cam');

  // ------------------------------------------------------------ lagring
  const store = {
    get(k, d) { try { const v = localStorage.getItem('fr_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('fr_' + k, JSON.stringify(v)); return true; } catch { return false; } },
  };

  const DEFAULTS = { threshold: 500, autoVerify: true, sound: true, vibrate: true, voice: false, speed: 'normal', maxScans: 1500 };
  const S = Object.assign({}, DEFAULTS, store.get('settings', {}));
  const saveSettings = () => store.set('settings', S);

  // Nyckeln kommer med länken (#nyckel=…), sparas i telefonen och tas bort ur adressen.
  function keyFromHash() {
    const m = location.hash.match(/nyckel=([A-Za-z0-9_-]{10,200})/);
    if (!m) return null;
    store.set('key', m[1]);
    history.replaceState(null, '', location.pathname + location.search);
    return m[1];
  }
  keyFromHash();
  let KEY = store.get('key', '');

  const SPEEDS = {
    spar: { minInterval: 3200, novelty: 14, motion: 7, hint: 'Analyserar bara när bilden ändrats mycket. Billigast.' },
    normal: { minInterval: 1800, novelty: 10, motion: 8, hint: 'En analys ungefär varannan sekund när du rör dig.' },
    snabb: { minInterval: 1000, novelty: 7, motion: 9, hint: 'Upp till en analys i sekunden. Kostar mer.' },
  };
  const P = () => SPEEDS[S.speed] || SPEEDS.normal;

  // ------------------------------------------------------------ tillstånd
  const st = {
    running: false, stream: null, track: null, inflight: 0, verifying: 0, queue: [],
    lastSend: 0, startedAt: 0, prevSig: null, lastSig: null, steady: 0,
    scans: 0, costSek: 0, timer: null, wake: null, pausedByHide: false, backoffUntil: 0,
    seen: new Map(), log: store.get('log', []), alerts: new Map(), torch: false,
  };

  // ------------------------------------------------------------ hjälpfunktioner
  const kr = (n) => Math.round(n).toLocaleString('sv-SE') + ' kr';
  const range = (a, b) => (a === b ? kr(a) : `${Math.round(a).toLocaleString('sv-SE')}–${kr(b)}`);
  const money = (sek) => (sek > 0 && sek < 0.01 ? 'under 1 öre' : (sek < 10 ? sek.toFixed(2).replace('.', ',') : Math.round(sek).toLocaleString('sv-SE')) + ' kr');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const mid = (o) => ((o.varde_min || 0) + (o.varde_max || 0)) / 2;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function toast(text, ms = 1800) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('on'), ms);
  }

  function setStatus(kind, text) {
    const s = $('#status');
    s.className = 'status ' + (kind || '');
    $('#statusText').textContent = text;
  }

  function busy(on) {
    app.classList.toggle('is-busy', !!on);
    if (st.running) setStatus(on ? 'busy' : 'live', on ? 'Analyserar' : 'Söker');
  }

  function meter() {
    $('#meter').textContent = `${st.scans} ${st.scans === 1 ? 'analys' : 'analyser'} · ${money(st.costSek)}`;
    const n = st.log.length;
    $('#logCount').textContent = n;
    $('#logCount').hidden = n === 0;
  }

  // ------------------------------------------------------------ ljud, vibration, notiser, uppläsning
  let ac = null;
  function audioUnlock() {
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume();
    } catch { /* inget ljud */ }
  }
  function chime(kind) {
    if (!S.sound || !ac) return;
    const notes = kind === 'hit' ? [[880, 0], [1175, 0.12], [1568, 0.24], [1568, 0.5]] : kind === 'maybe' ? [[660, 0], [880, 0.14]] : [[740, 0]];
    const t0 = ac.currentTime + 0.02;
    for (const [f, dt] of notes) {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(0.4, t0 + dt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.4);
      o.connect(g).connect(ac.destination);
      o.start(t0 + dt);
      o.stop(t0 + dt + 0.45);
    }
  }
  function buzz(pattern) {
    if (S.vibrate && navigator.vibrate) try { navigator.vibrate(pattern); } catch { /* ok */ }
  }
  function speak(text) {
    if (!S.voice || !('speechSynthesis' in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'sv-SE';
      u.rate = 1.05;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch { /* ok */ }
  }
  async function notify(title, body, tag) {
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      const reg = navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
      const opts = { body, tag, renotify: true, icon: 'icon-192.png', badge: 'icon-192.png', vibrate: [250, 100, 250] };
      if (reg) await reg.showNotification(title, opts);
      else new Notification(title, opts);
    } catch { /* notiser är en bonus */ }
  }
  async function askNotifications() {
    try {
      if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    } catch { /* ok */ }
    updateNotifBtn();
  }
  function updateNotifBtn() {
    const b = $('#notifBtn');
    const ok = 'Notification' in window && Notification.permission === 'granted';
    b.textContent = ok ? 'Notiser är på' : 'Tillåt notiser';
    b.disabled = ok;
  }

  // ------------------------------------------------------------ server
  async function api(path, body, timeoutMs = 30000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${API}/${path}`, {
        method: body ? 'POST' : 'GET',
        headers: Object.assign({ 'x-fynd-key': KEY }, body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const e = new Error(data.message || `Fel ${res.status}`);
        e.status = res.status;
        e.code = data.error;
        throw e;
      }
      return data;
    } catch (e) {
      if (e.name === 'AbortError') { const x = new Error('Svaret dröjde för länge.'); x.status = 0; throw x; }
      if (!('status' in e)) e.status = 0;
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  function apiError(e, fromVerify) {
    if (e.status === 401) {
      stop();
      showStart('Åtkomstnyckeln fungerar inte. Klistra in nyckeln från länken du fick.', true);
      return;
    }
    if (e.status === 429 && e.code === 'budget') {
      stop();
      toast(e.message, 5000);
      showStart(e.message);
      return;
    }
    if (!fromVerify) {
      st.backoffUntil = Date.now() + (e.status === 0 ? 4000 : 2500);
      setStatus('warn', e.status === 0 ? 'Ingen kontakt' : 'Väntar');
    }
  }

  // ------------------------------------------------------------ kamera
  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Den här webbläsaren kan inte använda kameran. Öppna sidan i Chrome.');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    st.stream = stream;
    st.track = stream.getVideoTracks()[0];
    video.srcObject = stream;
    await video.play().catch(() => {});
    try {
      const caps = st.track.getCapabilities ? st.track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.includes('continuous')) await st.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      $('#torchBtn').hidden = !caps.torch;
    } catch { /* inte alla telefoner */ }
  }

  function stopCamera() {
    if (st.stream) st.stream.getTracks().forEach((t) => t.stop());
    st.stream = null;
    st.track = null;
    st.torch = false;
    $('#torchBtn').classList.remove('on');
  }

  async function keepAwake() {
    try { if ('wakeLock' in navigator && !st.wake) { st.wake = await navigator.wakeLock.request('screen'); st.wake.addEventListener('release', () => { st.wake = null; }); } } catch { /* ok */ }
  }

  // ------------------------------------------------------------ bildrutor
  const sigCanvas = document.createElement('canvas');
  sigCanvas.width = 32;
  sigCanvas.height = 24;
  const sigCtx = sigCanvas.getContext('2d', { willReadFrequently: true });

  function signature() {
    sigCtx.drawImage(video, 0, 0, 32, 24);
    const d = sigCtx.getImageData(0, 0, 32, 24).data;
    const px = new Uint8Array(32 * 24);
    let sum = 0;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const v = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
      px[j] = v;
      sum += v;
    }
    return { px, mean: sum / px.length };
  }
  const diff = (a, b) => {
    if (!a || !b) return 255;
    let s = 0;
    for (let i = 0; i < a.px.length; i++) s += Math.abs(a.px[i] - b.px[i]);
    return s / a.px.length;
  };

  const grab = document.createElement('canvas');
  function capture(maxSide, quality) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const k = Math.min(1, maxSide / Math.max(vw, vh));
    grab.width = Math.round(vw * k);
    grab.height = Math.round(vh * k);
    grab.getContext('2d').drawImage(video, 0, 0, grab.width, grab.height);
    const url = grab.toDataURL('image/jpeg', quality);
    const t = document.createElement('canvas');
    const tk = 320 / Math.max(grab.width, grab.height);
    t.width = Math.round(grab.width * tk);
    t.height = Math.round(grab.height * tk);
    t.getContext('2d').drawImage(grab, 0, 0, t.width, t.height);
    return { b64: url.slice(url.indexOf(',') + 1), thumb: t.toDataURL('image/jpeg', 0.62) };
  }

  function tick() {
    if (!st.running) return;
    try {
      if (video.readyState >= 2 && video.videoWidth) {
        const sig = signature();
        const motion = diff(sig, st.prevSig);
        st.prevSig = sig;
        st.steady = motion < P().motion ? st.steady + 1 : 0;
        const novelty = diff(sig, st.lastSig);
        const now = Date.now();
        const ready = st.steady >= 2 && novelty > P().novelty && now - st.lastSend > P().minInterval;
        if (ready && sig.mean > 18 && st.inflight < 2 && now > st.backoffUntil) {
          if (st.scans >= S.maxScans) {
            pause(`Max ${S.maxScans} analyser per runda. Tryck för att fortsätta.`);
            st.scans = 0;
          } else {
            st.lastSig = sig;
            st.lastSend = now;
            scan(false);
          }
        }
        if (st.inflight === 0 && now > st.backoffUntil && $('#status').classList.contains('warn')) setStatus('live', 'Söker');
        if (now - Math.max(st.lastSend, st.startedAt) > 5 * 60 * 1000) pause('Pausad efter fem minuter utan nya bilder.');
      }
    } catch { /* en missad bildruta gör inget */ }
    st.timer = setTimeout(tick, 200);
  }

  // ------------------------------------------------------------ analys
  async function scan(detail) {
    if (!video.videoWidth) return;
    const shot = capture(detail ? 1600 : 1024, detail ? 0.82 : 0.72);
    st.inflight++;
    st.scans++;
    busy(true);
    const recent = [...st.seen.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 15).map((r) => r.namn);
    try {
      const res = await api(detail ? 'detail' : 'scan', { image: shot.b64, recent }, detail ? 50000 : 25000);
      st.costSek += Number(res.cost_sek) || 0;
      handleItems(res, shot, detail);
    } catch (e) {
      if (detail) toast(e.message || 'Närbilden misslyckades.', 3000);
      apiError(e, false);
    } finally {
      st.inflight--;
      busy(st.inflight > 0);
      meter();
    }
  }

  function handleItems(res, shot, detail) {
    const now = Date.now();
    const items = Array.isArray(res.items) ? res.items : [];
    const recs = items.map((it) => {
      const key = norm(it.namn);
      let r = st.seen.get(key);
      if (!r) {
        r = { key, firstSeen: now, count: 0, state: 'none' };
        st.seen.set(key, r);
      }
      const better = detail || r.count === 0 || it.sakerhet >= (r.sakerhet || 0) - 0.1;
      if (better) Object.assign(r, it);
      r.lastSeen = now;
      r.count++;
      if (detail) r.detail = true;
      if (better || !r.thumb) r.thumb = shot.thumb;
      if (r.varde_max >= S.threshold * 0.5 && (better || !r.frame)) r.frame = shot.b64;
      return r;
    });
    renderNow(recs, res, detail);
    for (const r of recs) evaluate(r);
    persistSeen();
  }

  function evaluate(r) {
    const T = S.threshold;
    if (['hit', 'checking', 'queued'].includes(r.state)) return;
    if (r.varde_max < T || (r.sakerhet || 0) < 0.25) return;
    if (r.state === 'below' && !(r.detail && r.varde_min >= T)) return;
    if (r.state === 'maybe' && mid(r) < T) return;
    if (S.autoVerify) {
      buzz([90]);
      chime('soft');
      showAlert(r, 'checking');
      verify(r);
    } else if (mid(r) >= T) {
      hit(r);
    } else {
      maybe(r);
    }
  }

  async function verify(r, manual) {
    if (!manual && st.verifying >= 2) {
      r.state = 'queued';
      st.queue.push(r);
      showAlert(r, 'queued');
      return;
    }
    r.state = 'checking';
    st.verifying++;
    showAlert(r, 'checking');
    renderDetailIfOpen(r);
    try {
      const item = { namn: r.namn, kategori: r.kategori, varde_min: r.varde_min, varde_max: r.varde_max, motivering: r.motivering, plats: r.plats, prislapp_kr: r.prislapp_kr };
      const v = await api('verify', { item, image: r.frame || undefined }, 95000);
      st.costSek += Number(v.cost_sek) || 0;
      r.verify = v;
      const T = S.threshold;
      if (mid(v) >= T) hit(r);
      else if (v.varde_max >= T) maybe(r);
      else below(r);
    } catch (e) {
      r.state = 'error';
      r.err = e.message;
      showAlert(r, 'error');
      apiError(e, true);
    } finally {
      st.verifying--;
      meter();
      renderDetailIfOpen(r);
      const next = st.queue.shift();
      if (next) verify(next);
    }
  }

  function valueOf(r) {
    return r.verify ? { lo: r.verify.varde_min, hi: r.verify.varde_max } : { lo: r.varde_min, hi: r.varde_max };
  }

  function hit(r) {
    r.state = 'hit';
    saveFind(r);
    const { lo, hi } = valueOf(r);
    buzz([280, 120, 280, 120, 600]);
    chime('hit');
    const basis = r.verify ? basisText(r.verify) : 'AI:ns snabbskattning';
    notify(`Fynd: ${r.verify?.namn || r.namn}`, `Värt ca ${range(lo, hi)} · ${basis}`, 'fynd-' + r.key);
    speak(`Fynd! ${r.namn}. Ungefär ${Math.round((lo + hi) / 2)} kronor.`);
    showAlert(r, 'hit');
    renderNowAgain();
  }

  function maybe(r) {
    r.state = 'maybe';
    saveFind(r);
    const { lo, hi } = valueOf(r);
    buzz([160, 90, 160]);
    chime('maybe');
    notify(`Kanske ett fynd: ${r.verify?.namn || r.namn}`, `Ca ${range(lo, hi)} – värt en närmare titt`, 'fynd-' + r.key);
    speak(`Kanske ett fynd. ${r.namn}.`);
    showAlert(r, 'maybe');
    renderNowAgain();
  }

  function below(r) {
    r.state = 'below';
    showAlert(r, 'below');
    setTimeout(() => dismissAlert(r.key), 4500);
    renderNowAgain();
  }

  function basisText(v) {
    if (v.underlag === 'sålda') return 'utifrån sålda exemplar';
    if (v.underlag === 'annonser') return 'utifrån annonser';
    return 'uppskattning';
  }

  // ------------------------------------------------------------ fyndloggen
  function saveFind(r) {
    const { lo, hi } = valueOf(r);
    const entry = {
      id: r.key,
      t: Date.now(),
      state: r.state,
      namn: r.namn,
      fullnamn: r.verify?.namn || '',
      kategori: r.kategori,
      varde_min: lo,
      varde_max: hi,
      sakerhet: r.verify?.sakerhet ?? r.sakerhet,
      motivering: r.motivering,
      kolla: r.verify?.kolla || r.kolla,
      plats: r.plats,
      prislapp_kr: r.prislapp_kr,
      thumb: r.thumb,
      verify: r.verify || null,
    };
    st.log = [entry, ...st.log.filter((e) => e.id !== entry.id)].slice(0, 150);
    while (!store.set('log', st.log) && st.log.length > 10) st.log = st.log.slice(0, Math.floor(st.log.length * 0.8));
    meter();
  }

  function persistSeen() {
    const arr = [...st.seen.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, 300)
      .map(({ key, namn, kategori, varde_min, varde_max, sakerhet, plats, state, lastSeen }) => ({ key, namn, kategori, varde_min, varde_max, sakerhet, plats, state, lastSeen }));
    store.set('seen', { day: new Date().toDateString(), items: arr });
  }

  function restoreSeen() {
    const s = store.get('seen', null);
    if (!s || s.day !== new Date().toDateString()) return;
    for (const it of s.items || []) st.seen.set(it.key, Object.assign({ count: 1, firstSeen: it.lastSeen }, it, { state: it.state === 'checking' || it.state === 'queued' ? 'none' : it.state }));
  }

  // ------------------------------------------------------------ rendering
  let lastNow = [];
  function itemClass(o) {
    const T = S.threshold;
    const v = o.verify ? { varde_min: o.verify.varde_min, varde_max: o.verify.varde_max } : o;
    if (o.state === 'hit' || mid(v) >= T) return 'hot';
    if (v.varde_max >= T) return 'warm';
    return '';
  }

  function stateTag(o) {
    if (o.state === 'hit') return '<span class="tag gold">Fynd</span>';
    if (o.state === 'maybe') return '<span class="tag gold">Kanske</span>';
    if (o.state === 'checking' || o.state === 'queued') return '<span class="tag teal">Kollar</span>';
    if (o.verify) return '<span class="tag">Kollad</span>';
    return '';
  }

  // Kompakt rad för listan över kamerabilden: en rad per föremål.
  function nowRow(o, withHint) {
    const v = o.verify ? o.verify : o;
    const hint = withHint && o.kolla ? `<div class="h">↻ ${esc(o.kolla)}</div>` : '';
    return `<li class="item ${itemClass(o)}" data-key="${esc(o.key)}">
      <span class="d"></span>
      <div class="txt"><div class="n one">${stateTag(o)}${esc(o.namn)}</div>${hint}</div>
      <span class="p">${range(v.varde_min, v.varde_max)}</span></li>`;
  }

  // Rad med bild för fyndlistan.
  function itemRow(o) {
    const v = o.verify ? o.verify : o;
    const meta = [o.prislapp_kr ? `prislapp ${kr(o.prislapp_kr)}` : '', o.t ? new Date(o.t).toLocaleString('sv-SE', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : o.plats].filter(Boolean).join(' · ');
    return `<li class="item ${itemClass(o)}" data-key="${esc(o.key || o.id)}">
      <img src="${o.thumb || ''}" alt="">
      <div class="txt"><div class="n two">${stateTag(o)}${esc(o.namn)}</div><div class="m">${esc(meta)}</div></div>
      <span class="p">${range(v.varde_min, v.varde_max)}</span></li>`;
  }

  const NOW_MAX = 3;
  function renderNow(recs, res, detail) {
    lastNow = recs.slice().sort((a, b) => b.varde_max - a.varde_max);
    const empty = $('#nowEmpty');
    if (!lastNow.length) {
      $('#nowList').innerHTML = '';
      empty.hidden = false;
      empty.textContent = res && res.bild === 'suddig' ? 'Suddigt – håll stilla en halv sekund.' : res && res.bild === 'mörk' ? 'För mörkt. Prova ficklampan.' : 'Inga föremål i bild. Rikta mot ett bord.';
    } else {
      empty.hidden = true;
      renderNowAgain();
    }
    $('#sheet h2').textContent = detail ? 'Närbild' : 'I bild nu';
  }
  function renderNowAgain() {
    if (!lastNow.length) return;
    const rows = lastNow.slice(0, NOW_MAX).map((o, i) => nowRow(o, i === 0)).join('');
    const rest = lastNow.length - NOW_MAX;
    $('#nowList').innerHTML = rows + (rest > 0 ? `<li class="more-row">+${rest} till i bilden</li>` : '');
  }

  // Bara ett larmkort syns åt gången, så att kameran inte skyms. Fynd går före priskollar,
  // och nyast går före äldre. Övriga syns som "+N" och finns kvar i fyndlistan.
  const PRIO = { hit: 4, maybe: 3, checking: 2, queued: 2, error: 1, below: 0 };
  function showAlert(r, kind) {
    const old = st.alerts.get(r.key);
    if (old) clearTimeout(old.timer);
    const a = { r, kind, t: Date.now(), timer: null };
    if (kind === 'hit' || kind === 'maybe') a.timer = setTimeout(() => dismissAlert(r.key), 60000);
    if (kind === 'below') a.timer = setTimeout(() => dismissAlert(r.key), 4500);
    st.alerts.set(r.key, a);
    renderAlert();
  }

  function dismissAlert(key) {
    const a = st.alerts.get(key);
    if (a) clearTimeout(a.timer);
    st.alerts.delete(key);
    renderAlert();
  }

  function renderAlert() {
    const box = $('#alerts');
    const all = [...st.alerts.values()].sort((x, y) => PRIO[y.kind] - PRIO[x.kind] || y.t - x.t);
    if (!all.length) { box.innerHTML = ''; return; }
    const { r, kind } = all[0];
    const { lo, hi } = valueOf(r);
    const label = {
      checking: '<span class="spin"></span> Möjligt fynd · kollar pris',
      queued: '<span class="spin"></span> Möjligt fynd · i kö',
      hit: '★ Fynd',
      maybe: 'Kanske ett fynd',
      below: 'Under din gräns',
      error: 'Möjligt fynd',
    }[kind];
    const sub = {
      checking: 'Söker sålda exemplar …',
      queued: 'Priset kollas strax',
      hit: r.verify ? `${basisText(r.verify)}${r.verify.exempel?.length ? ` · ${r.verify.exempel.length} exempel` : ''}` : 'AI:ns snabbskattning',
      maybe: r.verify ? `${basisText(r.verify)} · titta närmare` : 'Titta närmare',
      below: r.verify ? basisText(r.verify) : '',
      error: r.err || 'Priskollen misslyckades',
    }[kind];
    const more = all.length - 1;
    box.innerHTML = `<div class="alert ${kind === 'hit' ? 'hit' : kind === 'below' ? 'below' : ''}" data-key="${esc(r.key)}">
      <img src="${r.thumb || ''}" alt="">
      <div class="txt"><div class="k">${label}</div><div class="n">${esc(r.namn)}</div>
        <div class="vs"><span class="v">${range(lo, hi)}</span><span class="s">${esc(sub)}</span></div></div>
      <button class="x" aria-label="Stäng">×</button>
      ${more > 0 ? `<button class="more">+${more}</button>` : ''}
    </div>`;
    const el = box.firstElementChild;
    el.addEventListener('click', () => openDetail(r.key));
    el.querySelector('.x').addEventListener('click', (e) => { e.stopPropagation(); dismissAlert(r.key); });
    el.querySelector('.more')?.addEventListener('click', (e) => { e.stopPropagation(); logTab = 'fynd'; renderLog(); openPanel('logPanel'); });
  }

  // ------------------------------------------------------------ paneler
  function openPanel(id) {
    document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== id; });
  }
  function closePanels() {
    document.querySelectorAll('.panel').forEach((p) => { p.hidden = true; });
    detKey = null;
  }

  let detKey = null;
  function findRecord(key) {
    return st.seen.get(key) || st.log.find((e) => e.id === key) || null;
  }
  function renderDetailIfOpen(r) {
    if (detKey && detKey === r.key && !$('#detPanel').hidden) openDetail(r.key);
  }

  function openDetail(key) {
    const r = findRecord(key);
    if (!r) return;
    detKey = key;
    const v = r.verify;
    const lo = v ? v.varde_min : r.varde_min;
    const hi = v ? v.varde_max : r.varde_max;
    $('#detTitle').textContent = r.namn;
    const full = v?.namn || r.fullnamn || '';
    const img = r.frame ? `data:image/jpeg;base64,${r.frame}` : r.thumb;
    const ex = (v?.exempel || [])
      .map((e) => `<div class="ex"><div>${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.titel)}</a>` : esc(e.titel)}<small>${esc(e.kalla)} · ${esc(e.typ)}</small></div><b>${kr(e.pris_kr)}</b></div>`)
      .join('');
    const checking = r.state === 'checking' || r.state === 'queued';
    const saved = st.log.some((e) => e.id === key);
    $('#detBody').innerHTML = `
      ${img ? `<img class="det-img" src="${img}" alt="">` : ''}
      <div class="det-val">${range(lo, hi)}</div>
      <div class="det-sub">${esc([r.kategori, r.sakerhet != null ? `${Math.round((v?.sakerhet ?? r.sakerhet) * 100)} % säker` : '', r.prislapp_kr ? `prislapp ${kr(r.prislapp_kr)}` : '', r.plats].filter(Boolean).join(' · '))}</div>
      ${v ? `<div class="det-box"><h3>Priskoll · ${esc(basisText(v))}</h3>${full && full !== r.namn ? `<p class="full">${esc(full)}</p>` : ''}<p>${esc(v.sammanfattning)}</p>${ex}</div>` : ''}
      ${(v?.kolla || r.kolla) ? `<div class="det-box"><h3>Kontrollera</h3><p class="check">${esc(v?.kolla || r.kolla)}</p></div>` : ''}
      ${r.motivering ? `<div class="det-box"><h3>Snabbskattningen</h3><p>${range(r.varde_min, r.varde_max)} – ${esc(r.motivering)}</p></div>` : ''}
      <div class="row gap">
        ${!v && !checking && st.seen.has(key) ? '<button class="btn gold" data-verify>Kolla sålda priser</button>' : ''}
        ${checking ? '<button class="btn ghost" disabled><span class="spin"></span> Kollar priset …</button>' : ''}
        ${!saved && st.seen.has(key) ? '<button class="btn ghost" data-save>Spara i fynd</button>' : ''}
        ${saved ? '<button class="btn ghost" data-remove>Ta bort ur fynd</button>' : ''}
      </div>`;
    const b = $('#detBody');
    b.querySelector('[data-verify]')?.addEventListener('click', () => verify(r, true));
    b.querySelector('[data-save]')?.addEventListener('click', () => { if (!r.state || r.state === 'none' || r.state === 'below') r.state = 'saved'; saveFind(r); openDetail(key); toast('Sparat i fynd'); });
    b.querySelector('[data-remove]')?.addEventListener('click', () => { st.log = st.log.filter((e) => e.id !== key); store.set('log', st.log); meter(); closePanels(); toast('Borttaget'); });
    openPanel('detPanel');
  }

  let logTab = 'fynd';
  function renderLog() {
    document.querySelectorAll('#logTabs button').forEach((b) => b.classList.toggle('on', b.dataset.v === logTab));
    const list = $('#logList');
    const empty = $('#logEmpty');
    let rows = [];
    if (logTab === 'fynd') {
      rows = st.log.map((e) => Object.assign({ key: e.id }, e));
      empty.textContent = 'Inga sparade fynd än. När något ligger över din gräns hamnar det här.';
    } else {
      rows = [...st.seen.values()].sort((a, b) => (b.verify?.varde_max ?? b.varde_max) - (a.verify?.varde_max ?? a.varde_max));
      empty.textContent = 'Inget sett i dag än.';
    }
    empty.hidden = rows.length > 0;
    list.innerHTML = rows.map((o) => itemRow(o)).join('');
    $('#logClear').textContent = logTab === 'fynd' ? 'Rensa fynden' : 'Rensa listan';
    $('#logClear').hidden = rows.length === 0;
  }

  // ------------------------------------------------------------ start, paus, stopp
  async function start() {
    $('#startErr').hidden = true;
    if (!KEY) { showStart('Ange åtkomstnyckeln först.', true); return; }
    audioUnlock();
    try {
      await startCamera();
      askNotifications(); // efter kameran, så att frågorna inte krockar
    } catch (e) {
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      showStart(denied ? 'Kameran är blockerad. Tryck på låset bredvid adressen i Chrome → Behörigheter → Kamera → Tillåt, och ladda om sidan.' : (e.message || 'Kameran gick inte att starta.'));
      return;
    }
    $('#start').hidden = true;
    st.running = true;
    st.startedAt = Date.now();
    st.lastSig = null;
    st.prevSig = null;
    st.steady = 0;
    app.classList.add('is-running');
    app.classList.remove('is-idle');
    setStatus('live', 'Söker');
    keepAwake();
    clearTimeout(st.timer);
    tick();
  }

  function pause(msg, byHide) {
    if (!st.running) return;
    st.running = false;
    st.pausedByHide = !!byHide;
    clearTimeout(st.timer);
    stopCamera();
    app.classList.remove('is-running', 'is-busy');
    setStatus('', 'Pausad');
    if (msg && !byHide) toast(msg, 3500);
    try { st.wake && st.wake.release(); } catch { /* ok */ }
  }

  function stop() { pause(); }

  async function resume() {
    audioUnlock();
    try {
      await startCamera();
    } catch (e) {
      toast('Kameran gick inte att starta igen.', 3000);
      return;
    }
    st.running = true;
    st.startedAt = Date.now();
    st.lastSig = null;
    app.classList.add('is-running');
    setStatus('live', 'Söker');
    keepAwake();
    clearTimeout(st.timer);
    tick();
  }

  function showStart(msg, needKey) {
    $('#start').hidden = false;
    app.classList.add('is-idle');
    $('#keyBox').hidden = !needKey && !!KEY;
    $('#startErr').hidden = !msg;
    $('#startErr').textContent = msg || '';
    renderChips('#startChips');
  }

  // ------------------------------------------------------------ larmgräns
  const CHOICES = [200, 500, 1000, 2000, 5000];
  function setThreshold(v) {
    S.threshold = Math.max(50, Math.min(1000000, Math.round(v / 10) * 10 || 500));
    saveSettings();
    $('#thrText').textContent = kr(S.threshold);
    $('#thrInput').value = S.threshold;
    renderChips('#startChips');
    renderChips('#panelChips');
    renderNowAgain();
  }
  function renderChips(sel) {
    const el = $(sel);
    el.innerHTML = CHOICES.map((c) => `<button data-v="${c}" class="${c === S.threshold ? 'on' : ''}">${kr(c)}</button>`).join('');
    el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setThreshold(Number(b.dataset.v))));
  }

  // ------------------------------------------------------------ inställningar
  function bindSettings() {
    const bind = (id, key) => {
      const el = $(id);
      el.checked = !!S[key];
      el.addEventListener('change', () => { S[key] = el.checked; saveSettings(); if (key === 'sound' && el.checked) audioUnlock(); });
    };
    bind('#optVerify', 'autoVerify');
    bind('#optSound', 'sound');
    bind('#optVibrate', 'vibrate');
    bind('#optVoice', 'voice');
    const seg = $('#optSpeed');
    const paint = () => {
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.speed));
      $('#speedHint').textContent = P().hint;
    };
    seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { S.speed = b.dataset.v; saveSettings(); paint(); }));
    paint();
    $('#ver').textContent = VERSION;
  }

  async function loadUsage() {
    $('#useSession').textContent = money(st.costSek);
    try {
      const u = await api('usage', null, 15000);
      $('#useToday').textContent = money(u.today.sek);
      $('#useMonth').textContent = money(u.month.sek);
      $('#useBudget').textContent = `Dagsgräns för AI: ${money(u.budget_sek)}. I dag: ${u.today.scans} analyser och ${u.today.verifies} priskollar.`;
    } catch (e) {
      $('#useBudget').textContent = e.status === 401 ? 'Nyckeln fungerar inte.' : 'Kunde inte hämta kostnaden just nu.';
    }
  }

  // ------------------------------------------------------------ händelser
  function setKey(v) {
    const k = String(v || '').trim().replace(/^.*nyckel=/, '');
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(k)) { toast('Det ser inte ut som en nyckel.'); return false; }
    KEY = k;
    store.set('key', k);
    $('#keyEdit').value = k;
    toast('Nyckeln är sparad');
    return true;
  }

  $('#startBtn').addEventListener('click', start);
  $('#keySave').addEventListener('click', () => { if (setKey($('#keyInput').value)) $('#keyBox').hidden = true; });
  $('#keyEditSave').addEventListener('click', () => setKey($('#keyEdit').value));

  $('#mainBtn').addEventListener('click', () => {
    if (st.running) pause('Pausad');
    else if ($('#start').hidden) resume();
    else start();
  });

  $('#thrChip').addEventListener('click', () => { $('#thrInput').value = S.threshold; renderChips('#panelChips'); openPanel('thrPanel'); });
  $('#thrInput').addEventListener('change', (e) => setThreshold(Number(e.target.value)));
  document.querySelectorAll('.thr-big .step').forEach((b) => b.addEventListener('click', () => {
    const d = Number(b.dataset.step);
    const v = S.threshold;
    const stepSize = v < 1000 ? 100 : v < 5000 ? 500 : 1000;
    setThreshold(v + d * stepSize);
  }));

  $('#setBtn').addEventListener('click', () => { $('#keyEdit').value = KEY; updateNotifBtn(); openPanel('setPanel'); loadUsage(); });
  $('#logBtn').addEventListener('click', () => { renderLog(); openPanel('logPanel'); });
  $('#logTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { logTab = b.dataset.v; renderLog(); } });
  $('#logList').addEventListener('click', (e) => { const li = e.target.closest('.item'); if (li) openDetail(li.dataset.key); });
  $('#nowList').addEventListener('click', (e) => {
    if (e.target.closest('.more-row')) { logTab = 'sett'; renderLog(); openPanel('logPanel'); return; }
    const li = e.target.closest('.item');
    if (li) openDetail(li.dataset.key);
  });
  $('#logClear').addEventListener('click', () => {
    if (logTab === 'fynd') { st.log = []; store.set('log', st.log); } else { st.seen.clear(); persistSeen(); lastNow = []; renderNow([], null, false); }
    meter();
    renderLog();
  });
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closePanels));
  document.querySelectorAll('.panel').forEach((p) => p.addEventListener('click', (e) => { if (e.target === p) closePanels(); }));

  $('#testAlarm').addEventListener('click', () => {
    audioUnlock();
    buzz([280, 120, 280, 120, 600]);
    chime('hit');
    notify('Fynd: Testlarm', 'Så här låter och ser ett larm ut.', 'test');
    speak('Fynd! Testlarm. Ungefär tusen kronor.');
    toast('Testlarm skickat');
  });
  $('#notifBtn').addEventListener('click', askNotifications);

  $('#torchBtn').addEventListener('click', async () => {
    if (!st.track) return;
    try {
      st.torch = !st.torch;
      await st.track.applyConstraints({ advanced: [{ torch: st.torch }] });
      $('#torchBtn').classList.toggle('on', st.torch);
    } catch { toast('Ficklampan gick inte att tända.'); }
  });

  // tryck på kamerabilden = närbild
  video.addEventListener('click', (e) => {
    if (!st.running) return;
    const ring = $('#tapring');
    ring.style.left = e.clientX + 'px';
    ring.style.top = e.clientY + 'px';
    ring.classList.remove('on');
    void ring.offsetWidth;
    ring.classList.add('on');
    toast('Närbild – analyserar noga …', 2200);
    scan(true);
  });

  window.addEventListener('hashchange', () => {
    const k = keyFromHash();
    if (k) {
      KEY = k;
      $('#keyBox').hidden = true;
      $('#startErr').hidden = true;
      toast('Nyckeln är sparad');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && st.running) pause(null, true);
    else if (!document.hidden && !st.running && st.pausedByHide) { st.pausedByHide = false; resume(); }
  });

  // ------------------------------------------------------------ uppstart
  if ('serviceWorker' in navigator && !LOCAL) navigator.serviceWorker.register('sw.js').catch(() => {});
  if ('serviceWorker' in navigator && LOCAL && location.search.includes('sw=1')) navigator.serviceWorker.register('sw.js').catch(() => {});
  restoreSeen();
  bindSettings();
  setThreshold(S.threshold);
  meter();
  showStart('', !KEY);
  $('#keyBox').hidden = !!KEY;

  // för testerna
  window.__fr = { st, S, scan, verify, openDetail, setThreshold, renderAlert, VERSION };
})();
