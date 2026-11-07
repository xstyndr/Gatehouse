/* Gatehouse demo: the "backend" below runs in the browser and saves to localStorage. */

/* ================= local data layer ================= */
const KEY = 'gatehouse-demo-v1', ROLE_KEY = 'gatehouse-demo-role', WHO_KEY = 'gatehouse-demo-who';
let memDb = null, canSave = true;
const nowStr = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const inDays = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const E = (error, message, extra = {}) => ({ error, message, ...extra });
const code = () => 'TKT-' + [...crypto.getRandomValues(new Uint8Array(3))].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { canSave = false; } } };

function load() {
  try { const r = localStorage.getItem(KEY); if (r) return (memDb = JSON.parse(r)); } catch { canSave = false; }
  if (!memDb) { memDb = seed(); save(memDb); }
  return memDb;
}
function save(db) { memDb = db; try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { canSave = false; } }

/* Every write runs inside a Web Lock, so two tabs can't interleave a read-modify-write.
   That is what keeps the last ticket safe when two tabs race for it. */
function mutate(fn) {
  const run = () => { const db = load(); const out = fn(db); save(db); return out; };
  return navigator.locks ? navigator.locks.request('gatehouse-demo', run) : Promise.resolve().then(run);
}

/* ---- pricing (same rules as the Flask version) ---- */
const surgeCents = (base, pct) => Math.floor((base * (100 + pct) + 50) / 100);
function unitPrice(base, cap, sold, pct = 25, below = 20) {
  const surged = pct > 0 && (cap - sold) * 100 < cap * below;
  return [surged ? surgeCents(base, pct) : base, surged];
}
function serialize(ev, db) {
  const { capacity: cap, sold, base_cents: base, surge_pct: pct, surge_below: below, max_per_order: per } = ev;
  const remaining = cap - sold, [price, surged] = unitPrice(base, cap, sold, pct, below);
  const zone = pct > 0 ? Math.max(0, Math.floor((cap * below + 99) / 100) - 1) : 0;
  const totals = []; let run = 0;
  for (let i = 0; i < Math.min(per, remaining); i++) { run += unitPrice(base, cap, sold + i, pct, below)[0]; totals.push(run); }
  const mine = db.bookings.filter(b => b.event_id === ev.id);
  return { id: ev.id, name: ev.name, venue: ev.venue, description: ev.description, starts_at: ev.starts_at, status: ev.status,
    base_cents: base, surge_cents: surgeCents(base, pct), surge_pct: pct, surge_below: below, capacity: cap, sold, remaining,
    price_cents: price, surged, base_left: Math.max(0, remaining - zone), surge_zone: zone, totals, max_per_order: per,
    revenue_cents: mine.reduce((a, b) => a + b.total_cents, 0), orders: mine.length };
}

/* ---- operations (each throws before it changes anything, so a failure never half-saves) ---- */
function bookTx(db, id, qty, who, expected, mine = true) {
  const ev = db.events.find(e => e.id === id);
  if (!ev || ev.status === 'draft') throw E('not_found', 'Event not found.');
  if (ev.status === 'closed') throw E('not_on_sale', 'Sales for this event are closed.');
  if (!Number.isInteger(qty) || qty < 1 || qty > ev.max_per_order) throw E('invalid', `You can book 1 to ${ev.max_per_order} tickets at a time.`);
  const rem = ev.capacity - ev.sold;
  if (rem === 0) throw E('sold_out', 'This event just sold out.');
  if (qty > rem) throw E('insufficient', `Only ${rem} ticket${rem !== 1 ? 's' : ''} left.`);
  let total = 0;
  for (let i = 0; i < qty; i++) total += unitPrice(ev.base_cents, ev.capacity, ev.sold + i, ev.surge_pct, ev.surge_below)[0];
  if (expected != null && expected !== total) throw E('price_changed', 'The price changed while you were booking.', { new_total_cents: total });
  ev.sold += qty;
  const codes = Array.from({ length: qty }, code);
  db.bookings.push({ id: db.next++, event_id: id, name: who.name, email: who.email, quantity: qty, total_cents: total, codes, created_at: nowStr(), mine });
  return { codes, total };
}

function parseEvent(d, creating) {
  const out = {}, has = k => creating || k in d, bad = m => E('invalid', m);
  if (has('name')) { const v = String(d.name ?? '').trim(); if (v.length < 1 || v.length > 120) throw bad('Event name is required (max 120 characters).'); out.name = v; }
  for (const [k, label, mx] of [['venue', 'Venue', 120], ['description', 'Description', 1000]])
    if (k in d) { const v = String(d[k] ?? '').trim(); if (v.length > mx) throw bad(`${label} is too long (max ${mx} characters).`); out[k] = v; }
  if ('starts_at' in d) { const v = String(d.starts_at ?? '').trim(); if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad('Enter a valid date.'); out.starts_at = v; }
  if (has('base_price')) { const c = Math.round(parseFloat(d.base_price) * 100); if (!(c >= 1 && c <= 10000000)) throw bad('Base price must be between ₹0.01 and ₹1,00,000.'); out.base_cents = c; }
  if (has('capacity')) { const c = parseInt(d.capacity, 10); if (!(c >= 1 && c <= 100000)) throw bad('Capacity must be between 1 and 100,000.'); out.capacity = c; }
  for (const [k, lo, hi, label] of [['surge_pct', 0, 200, 'Surge uplift'], ['surge_below', 0, 50, 'Surge threshold'], ['max_per_order', 1, 20, 'Max tickets per order']])
    if (k in d) { const v = parseInt(d[k], 10); if (!(v >= lo && v <= hi)) throw bad(`${label} must be between ${lo} and ${hi}.`); out[k] = v; }
  return out;
}
function orgCreate(db, d) {
  const f = { venue: '', description: '', starts_at: '', surge_pct: 25, surge_below: 20, max_per_order: 6, ...parseEvent(d, true) };
  const ev = { id: db.next++, status: 'draft', sold: 0, created_at: nowStr(), ...f };
  db.events.push(ev); return ev.id;
}
function orgUpdate(db, id, d) {
  const f = parseEvent(d, false), ev = db.events.find(e => e.id === id);
  if (!ev) throw E('not_found', 'Event not found.');
  if ('capacity' in f && f.capacity < ev.sold) throw E('capacity', `Capacity can't be lower than the ${ev.sold} tickets already sold.`);
  Object.assign(ev, f);
}
const TRANSITIONS = { draft: ['published'], published: ['closed', 'draft'], closed: ['published'] };
function orgStatus(db, id, status) {
  const ev = db.events.find(e => e.id === id);
  if (!ev || !TRANSITIONS[ev.status].includes(status)) throw E('transition', "That change isn't available for this event.");
  if (status === 'draft' && ev.sold > 0) throw E('has_sales', 'Events with sales cannot go back to draft. Close sales instead.');
  ev.status = status;
}
function orgDelete(db, id) {
  const ev = db.events.find(e => e.id === id);
  if (!ev) throw E('not_found', 'Event not found.');
  if (ev.sold > 0) throw E('has_sales', 'Events with bookings cannot be deleted. Close sales instead.');
  db.events = db.events.filter(e => e.id !== id);
}

function seed() {
  const db = { next: 1, events: [], bookings: [] };
  const mk = o => { const ev = { id: db.next++, owner: 'demo', name: '', venue: '', description: '', starts_at: '', base_cents: 0, capacity: 0, sold: 0, status: 'draft', surge_pct: 25, surge_below: 20, max_per_order: 6, created_at: nowStr(), ...o }; db.events.push(ev); return ev; };
  const names = ['Meera', 'Arjun', 'Isha', 'Kabir', 'Nisha', 'Rohan', 'Tara', 'Dev'];
  const fill = (ev, n) => { let i = 0; while (n > 0) { const q = Math.min(n, (i % 3) + 1); bookTx(db, ev.id, q, { name: names[i % 8], email: names[i % 8].toLowerCase() + '@example.com' }, null, false); n -= q; i++; } };
  fill(mk({ name: 'Rooftop Sessions Vol. 3', venue: 'The Terrace, Pune', starts_at: inDays(21), base_cents: 79900, capacity: 40, status: 'published',
    description: 'An evening of live indie sets under the open sky. Doors at 6 pm, first set at 7.' }), 31);
  fill(mk({ name: 'Open Mic Night', venue: 'Café Alchemy, Bengaluru', starts_at: inDays(9), base_cents: 25000, capacity: 120, status: 'published',
    description: 'Poetry, stand-up and music. Sign up to perform at the door.' }), 46);
  mk({ name: 'Founders Dinner', venue: 'Private dining room, Gurugram', starts_at: inDays(40), base_cents: 250000, capacity: 24, description: 'A long table, twenty-four seats, no slides.' });
  return db;
}

/* ================= state ================= */
const S = { role: store.get(ROLE_KEY) === 'organizer' ? 'organizer' : 'attendee', view: 'events', db: null, all: [],
  sel: { attendee: null, organizer: null }, tab: 'overview', qty: 1, notice: '', receipt: null, busy: false, sig: '',
  who: (() => { try { return JSON.parse(store.get(WHO_KEY)) || { name: '', email: '' }; } catch { return { name: '', email: '' }; } })() };

function pull() { S.db = load(); S.all = S.db.events.map(e => serialize(e, S.db)).sort((a, b) => b.id - a.id); }
const visible = () => S.role === 'organizer' ? S.all : S.all.filter(e => e.status === 'published');
const sel = () => visible().find(e => e.id === S.sel[S.role]);
const sigOf = e => [e.remaining, e.price_cents, S.qty, S.notice, e.status].join('|');

function renderAll() {
  if (!sel()) S.sel[S.role] = visible()[0]?.id ?? null;
  const org = S.role === 'organizer';
  document.querySelectorAll('#roleSeg button').forEach(b => b.setAttribute('aria-selected', b.dataset.role === S.role));
  document.querySelectorAll('#subSeg button').forEach(b => b.setAttribute('aria-selected', b.dataset.view === S.view));
  $('#newBtn').hidden = !org; $('#subSeg').hidden = org; $('#list').hidden = !org && S.view === 'tickets';
  renderList(); renderMain();
}
function renderList() {
  const org = S.role === 'organizer', v = visible();
  $('#list').innerHTML = v.length ? v.map(e => rowHTML(e, S.sel[S.role], org)).join('')
    : `<p class="empty">${org ? 'No events yet. Create a draft to get started.' : 'No events on sale right now. Switch to Organizer and publish one.'}</p>`;
}
function renderMain() { S.role === 'organizer' ? renderOrg() : (S.view === 'tickets' ? renderTickets() : renderDetail()); }

function select(id) { S.sel[S.role] = id; S.qty = 1; S.notice = ''; S.receipt = null; S.tab = 'overview'; if (S.view === 'tickets') S.view = 'events'; renderAll(); }
$('#list').addEventListener('click', e => { const b = e.target.closest('.row'); if (b) select(+b.dataset.id); });
document.querySelectorAll('#roleSeg button').forEach(b => b.onclick = () => { S.role = b.dataset.role; store.set(ROLE_KEY, S.role); S.notice = ''; S.receipt = null; renderAll(); });
document.querySelectorAll('#subSeg button').forEach(b => b.onclick = () => { S.view = b.dataset.view; renderAll(); });

/* ================= attendee ================= */
function renderDetail() {
  const e = sel(), m = $('#main');
  if (!e) { m.innerHTML = '<h1>Nothing on sale yet</h1><p class="venue">Switch to Organizer, create an event and publish it. It will appear here.</p>'; return; }
  resetLive();
  m.innerHTML = `<h1>${esc(e.name)}</h1><p class="venue">${esc([e.venue, dateLabel(e.starts_at)].filter(Boolean).join(', ') || 'Venue to be announced')}</p>
    <div class="grid"><section>${liveHTML()}${e.description ? `<p class="desc">${esc(e.description)}</p>` : ''}</section><div id="stubHost"></div></div>`;
  paintLive(e); renderStub();
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function renderStub() {
  const e = sel(), host = $('#stubHost'); if (!host) return;
  if (S.receipt) {
    const r = S.receipt;
    host.innerHTML = `<div class="stub"><div class="top"><p>Booked</p><strong>${esc(e.name)}</strong></div>
      <div class="done"><h3>You're in, ${esc(S.who.name.trim().split(' ')[0])}.</h3><p>${r.codes.length} ticket${r.codes.length > 1 ? 's' : ''}, ${inr(r.total)}</p>
      <ul class="codes">${r.codes.map(c => `<li>${c}</li>`).join('')}</ul>
      <div class="acts"><button class="btn" id="mine">View my tickets</button>${e.remaining ? '<button class="btn ghost" id="again">Book more</button>' : ''}</div></div></div>`;
    $('#mine').onclick = () => { S.view = 'tickets'; renderAll(); };
    if ($('#again')) $('#again').onclick = () => { S.receipt = null; S.qty = 1; renderStub(); };
    return;
  }
  const off = e.remaining === 0 || e.status !== 'published', maxQ = Math.min(e.max_per_order, e.remaining);
  S.qty = Math.max(1, Math.min(S.qty, maxQ || 1)); S.sig = sigOf(e);
  host.innerHTML = `<div class="stub"><div class="top"><p>Admit</p><strong>${esc(e.name)}</strong></div>
    <form id="bookForm" novalidate>
      ${S.notice ? `<div class="notice" role="alert">${esc(S.notice)}</div>` : ''}
      <div class="field"><label for="bName">Name</label><input id="bName" type="text" autocomplete="name" maxlength="80" ${off ? 'disabled' : ''}><div class="err" data-for="bName"></div></div>
      <div class="field"><label for="bEmail">Email</label><input id="bEmail" type="email" autocomplete="email" ${off ? 'disabled' : ''}><div class="err" data-for="bEmail"></div></div>
      <div class="field"><label id="qL">Tickets</label>
        <div class="qty" role="group" aria-labelledby="qL">
          <button type="button" id="qm" aria-label="Fewer tickets" ${S.qty <= 1 || off ? 'disabled' : ''}>−</button>
          <output id="qv" class="num">${S.qty}</output>
          <button type="button" id="qp" aria-label="More tickets" ${S.qty >= maxQ || off ? 'disabled' : ''}>+</button>
        </div></div>
      <div class="sum"><span>Total</span><b class="num">${off ? '—' : inr(e.totals[S.qty - 1])}</b></div>
      <button class="btn" id="bookBtn" ${off ? 'disabled' : ''}>${off ? 'Sold out' : 'Book ' + S.qty + ' ticket' + (S.qty > 1 ? 's' : '')}</button>
    </form></div>`;
  $('#bName').value = S.who.name; $('#bEmail').value = S.who.email;
  const keep = () => { S.who = { name: $('#bName').value, email: $('#bEmail').value }; store.set(WHO_KEY, JSON.stringify(S.who)); };
  $('#bName').addEventListener('input', keep); $('#bEmail').addEventListener('input', keep);
  const step = (d, id) => () => { S.qty += d; S.notice = ''; renderStub(); ($('#' + id).disabled ? $('#bookBtn') : $('#' + id)).focus(); };
  $('#qm').onclick = step(-1, 'qm'); $('#qp').onclick = step(1, 'qp');
  $('#bookForm').addEventListener('submit', submitBooking);
}

function fieldErr(id, msg) { const i = $('#' + id), m = $(`[data-for=${id}]`); i.setAttribute('aria-invalid', !!msg); m.textContent = msg || ''; }

async function submitBooking(ev) {
  ev.preventDefault(); if (S.busy) return;
  const e = sel(), name = S.who.name.trim(), email = S.who.email.trim();
  fieldErr('bName', name ? '' : 'Enter the name for the booking.');
  fieldErr('bEmail', EMAIL.test(email) ? '' : 'Enter a valid email address.');
  if (!name || !EMAIL.test(email)) return;
  S.busy = true; const btn = $('#bookBtn'); btn.disabled = true; btn.textContent = 'Booking…';
  try {
    const r = await mutate(db => bookTx(db, e.id, S.qty, { name, email }, e.totals[S.qty - 1]));
    S.receipt = r; S.notice = '';
  } catch (err) {
    if (err.error === 'price_changed') S.notice = `The price changed to ${inr(err.new_total_cents)} for ${S.qty} ticket${S.qty > 1 ? 's' : ''}. Review the total and book again to confirm.`;
    else if (err.error === 'sold_out') S.notice = 'Someone else took the last ticket first. This event is sold out.';
    else if (err.error === 'insufficient') S.notice = err.message + ' Adjust the quantity and try again.';
    else if (err.message) S.notice = err.message; else throw err;
  } finally { S.busy = false; }
  pull(); renderList(); if (sel()) { paintLive(sel()); renderStub(); } else renderAll();
}

function renderTickets() {
  const rows = S.db.bookings.filter(b => b.mine).sort((a, b) => b.id - a.id).map(b => ({ ...b, ev: S.db.events.find(e => e.id === b.event_id) }));
  $('#main').innerHTML = '<h1>My tickets</h1>' + (rows.length
    ? `<p class="venue">Tickets booked in this browser. Show a code at the door.</p><div class="orders">${rows.map(o => `<article class="order">
        <h3>${esc(o.ev?.name)}</h3><p class="meta">${esc([o.ev?.venue, dateLabel(o.ev?.starts_at)].filter(Boolean).join(', ') || 'Venue to be announced')}</p>
        <ul class="codes">${o.codes.map(c => `<li>${c}</li>`).join('')}</ul>
        <div class="foot"><span>${o.quantity} ticket${o.quantity > 1 ? 's' : ''}, ${inr(o.total_cents)}</span><span>Booked ${when(o.created_at)}</span></div></article>`).join('')}</div>`
    : '<p class="venue">You have no tickets yet. Pick an event and book your first.</p><p style="margin-top:18px"><button class="btn" id="browse">Browse events</button></p>');
  if ($('#browse')) $('#browse').onclick = () => { S.view = 'events'; renderAll(); };
}

/* ================= organizer ================= */
function pricePreview(price, cap, pct, below) {
  if (!(price > 0) || !(cap > 0)) return 'Set a price and capacity to see how pricing will step up.';
  const base = Math.round(price * 100), zone = pct > 0 ? Math.floor((cap * below + 99) / 100) - 1 : 0, surge = surgeCents(base, pct);
  return zone > 0 ? `The first <b>${num(cap - zone)}</b> tickets sell at <b>${inr(base)}</b>. The last <b>${num(zone)}</b> sell at <b>${inr(surge)}</b>.`
    : `Every ticket sells at <b>${inr(base)}</b>. ${pct > 0 ? 'Surge pricing needs a larger capacity or threshold.' : 'Surge pricing is off.'}`;
}
const TABS = [['overview', 'Overview'], ['settings', 'Ticket settings'], ['attendees', 'Attendees']];

function renderOrg() {
  const e = sel(), m = $('#main');
  if (!e) { m.innerHTML = `<h1>Create your first event</h1><p class="venue">Set a base price and capacity. Publish when you are ready to sell.</p>`; return; }
  m.innerHTML = `<div class="head"><div><h1>${esc(e.name)}</h1>
      <p class="venue">${esc([e.venue, dateLabel(e.starts_at)].filter(Boolean).join(', ') || 'No venue or date set yet')}</p></div><div class="acts" id="acts"></div></div>
    <div class="tabs" role="tablist">${TABS.map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${k === S.tab}">${l}</button>`).join('')}</div>
    <div id="panel"></div>`;
  m.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { S.tab = b.dataset.tab; renderOrg(); });
  renderActs(e); renderPanel(e);
}
function renderActs(e) {
  const a = $('#acts');
  a.innerHTML = e.status === 'draft' ? '<button class="btn" data-s="published">Publish event</button>'
    : e.status === 'published' ? `<button class="btn ghost" data-s="closed">Close sales</button>${e.sold === 0 ? '<button class="btn ghost" data-s="draft">Back to draft</button>' : ''}`
    : '<button class="btn" data-s="published">Reopen sales</button>';
  a.querySelectorAll('button').forEach(b => b.onclick = () => setStatus(b.dataset.s));
}
async function setStatus(status) {
  const e = sel();
  if (status === 'closed' && !(await ask('Close sales?', 'Attendees will no longer be able to book. Existing tickets stay valid, and you can reopen sales later.', 'Close sales', true))) return;
  try { await mutate(db => orgStatus(db, e.id, status)); pull(); renderAll(); toast({ published: 'Published', closed: 'Sales closed', draft: 'Moved to draft' }[status]); }
  catch (x) { toast(x.message || 'Could not change the status.', true); }
}
function renderPanel(e) {
  const p = $('#panel');
  if (S.tab === 'overview') {
    resetLive();
    p.innerHTML = `<div style="margin-top:30px;max-width:640px">${liveHTML('<div><dt>Revenue</dt><dd class="num" id="sRev"></dd></div><div><dt>Orders</dt><dd class="num" id="sOrd"></dd></div>')}</div>`;
    paintAll(e);
  } else if (S.tab === 'settings') renderSettings(e); else renderAttendees(e);
}
function paintAll(e) { paintLive(e); if ($('#sRev')) { $('#sRev').textContent = inr(e.revenue_cents); $('#sOrd').textContent = num(e.orders); } }

function renderSettings(e) {
  $('#panel').innerHTML = `<form id="setForm" class="settings" novalidate>
    <div class="field"><label for="fName">Event name</label><input id="fName" type="text" maxlength="120" value="${esc(e.name)}"></div>
    <div class="two">
      <div class="field"><label for="fVenue">Venue</label><input id="fVenue" type="text" maxlength="120" value="${esc(e.venue)}"></div>
      <div class="field"><label for="fDate">Date</label><input id="fDate" type="date" value="${esc(e.starts_at)}"></div>
    </div>
    <div class="field"><label for="fDesc">Description</label><textarea id="fDesc" maxlength="1000">${esc(e.description)}</textarea></div>
    <h4>Tickets and pricing</h4>
    <div class="two">
      <div class="field"><label for="fPrice">Base price (₹)</label><input id="fPrice" type="number" min="1" step="any" value="${e.base_cents / 100}"></div>
      <div class="field"><label for="fCap">Max capacity</label><input id="fCap" type="number" min="${Math.max(1, e.sold)}" max="100000" step="1" value="${e.capacity}"><div class="hint">${e.sold ? `At least ${num(e.sold)}, the tickets already sold.` : 'Total tickets for sale.'}</div></div>
    </div>
    <div class="two">
      <div class="field"><label for="fPct">Surge uplift (%)</label><input id="fPct" type="number" min="0" max="200" step="1" value="${e.surge_pct}"><div class="hint">0 keeps the price flat.</div></div>
      <div class="field"><label for="fBelow">Surge when remaining is below (%)</label><input id="fBelow" type="number" min="0" max="50" step="1" value="${e.surge_below}"></div>
    </div>
    <div class="field" style="max-width:260px"><label for="fMax">Max tickets per order</label><input id="fMax" type="number" min="1" max="20" step="1" value="${e.max_per_order}"></div>
    <div class="preview" id="fPreview" aria-live="polite"></div>
    <div class="err" id="fErr" role="alert"></div>
    <button class="btn" id="fSave">Save changes</button>
    <h4>Delete event</h4>
    <p class="hint" style="margin:-4px 0 12px">${e.sold ? "This event has bookings, so it can't be deleted. Close sales instead." : 'Removes the event permanently. This cannot be undone.'}</p>
    <button type="button" class="btn ghost danger" id="delBtn" ${e.sold ? 'disabled' : ''}>Delete event</button>
  </form>`;
  const pv = () => $('#fPreview').innerHTML = pricePreview(parseFloat($('#fPrice').value), parseInt($('#fCap').value, 10), parseInt($('#fPct').value, 10) || 0, parseInt($('#fBelow').value, 10) || 0);
  ['#fPrice', '#fCap', '#fPct', '#fBelow'].forEach(s => $(s).addEventListener('input', pv)); pv();
  $('#setForm').addEventListener('submit', saveSettings); $('#delBtn').onclick = deleteEvent;
}
async function saveSettings(ev) {
  ev.preventDefault(); if (S.busy) return;
  const e = sel(), err = $('#fErr'); err.textContent = '';
  const body = { name: $('#fName').value, venue: $('#fVenue').value, starts_at: $('#fDate').value, description: $('#fDesc').value,
    base_price: $('#fPrice').value, capacity: $('#fCap').value, surge_pct: $('#fPct').value, surge_below: $('#fBelow').value, max_per_order: $('#fMax').value };
  S.busy = true;
  try { await mutate(db => orgUpdate(db, e.id, body)); pull(); renderAll(); toast('Changes saved'); }
  catch (x) { err.textContent = x.message || 'Could not save changes.'; }
  finally { S.busy = false; }
}
async function deleteEvent() {
  const e = sel();
  if (!(await ask('Delete this event?', `"${e.name}" will be removed permanently.`, 'Delete event', true))) return;
  try { await mutate(db => orgDelete(db, e.id)); S.tab = 'overview'; pull(); renderAll(); toast('Event deleted'); }
  catch (x) { toast(x.message || 'Could not delete the event.', true); }
}

function renderAttendees(e) {
  const rows = S.db.bookings.filter(b => b.event_id === e.id).sort((a, b) => b.id - a.id), p = $('#panel');
  p.innerHTML = rows.length ? `<div class="head" style="margin-top:22px;align-items:center"><p class="venue" style="margin:0">${num(rows.length)} order${rows.length > 1 ? 's' : ''}, ${num(e.sold)} ticket${e.sold > 1 ? 's' : ''}</p><button class="btn ghost" id="csv">Export CSV</button></div>
    <div class="wrap"><table class="tbl"><thead><tr><th>Name</th><th>Email</th><th>Tickets</th><th>Total</th><th>Codes</th><th>Booked</th></tr></thead><tbody>
    ${rows.map(b => `<tr><td>${esc(b.name)}</td><td>${esc(b.email)}</td><td class="num">${b.quantity}</td><td class="num">${inr(b.total_cents)}</td><td class="c">${b.codes.map(esc).join('<br>')}</td><td>${when(b.created_at)}</td></tr>`).join('')}
    </tbody></table></div>`
    : '<p class="venue" style="margin-top:24px">No bookings yet. Switch to Attendee and book a ticket to see it here.</p>';
  if ($('#csv')) $('#csv').onclick = () => exportCsv(e, rows);
}
function exportCsv(e, rows) {
  const cell = v => { v = String(v ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };   // blocks spreadsheet formula injection
  const data = [['Name', 'Email', 'Tickets', 'Total (INR)', 'Codes', 'Booked at (UTC)'], ...rows.map(b => [b.name, b.email, b.quantity, (b.total_cents / 100).toFixed(2), b.codes.join(' '), b.created_at])];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data.map(r => r.map(cell).join(',')).join('\n')], { type: 'text/csv' }));
  a.download = `attendees-event-${e.id}.csv`; a.click(); URL.revokeObjectURL(a.href);
}

/* create event dialog */
const dlg = $('#dlg');
const cPreview = () => $('#cPreview').innerHTML = pricePreview(parseFloat($('#cPrice').value), parseInt($('#cCap').value, 10), 25, 20);
$('#newBtn').onclick = () => { $('#createForm').reset(); $('#cErr').textContent = ''; cPreview(); dlg.showModal(); $('#cName').focus(); };
$('#cCancel').onclick = () => dlg.close();
$('#cPrice').oninput = $('#cCap').oninput = cPreview;
$('#createForm').addEventListener('submit', async e => {
  e.preventDefault(); const err = $('#cErr'); err.textContent = '';
  const body = { name: $('#cName').value, venue: $('#cVenue').value, base_price: $('#cPrice').value, capacity: $('#cCap').value };
  try { const id = await mutate(db => orgCreate(db, body)); pull(); dlg.close(); S.sel.organizer = id; S.tab = 'overview'; renderAll(); toast('Draft created'); }
  catch (x) { err.textContent = x.message || 'Could not create the event.'; }
});

/* reset */
$('#resetBtn').onclick = async () => {
  if (!(await ask('Reset the demo?', 'This deletes everything you created in this browser and restores the sample events.', 'Reset demo', true))) return;
  try { localStorage.removeItem(KEY); } catch {}
  memDb = null; S.sel = { attendee: null, organizer: null }; S.receipt = null; S.notice = ''; S.tab = 'overview'; S.view = 'events';
  pull(); renderAll(); toast('Demo reset');
};

/* live updates: other tabs write to localStorage, we re-render */
window.addEventListener('storage', e => {
  if (e.key !== KEY) return;
  memDb = null; pull();
  if (S.role === 'organizer' && S.tab === 'settings') return;      // don't clobber a form being edited
  const cur = sel(); if (!cur) return renderAll();
  renderList();
  if (S.role === 'organizer') { S.tab === 'overview' ? paintAll(cur) : S.tab === 'attendees' && renderAttendees(cur); }
  else if (S.view === 'events') { paintLive(cur); if (!S.receipt && S.sig !== sigOf(cur)) renderStub(); }
});

pull(); renderAll();
if (!canSave) toast('Browser storage is blocked, so changes will be lost on reload.', true);
