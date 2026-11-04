const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const inr = c => new Intl.NumberFormat('en-IN', {style:'currency', currency:'INR', minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2}).format(c / 100);
const num = n => new Intl.NumberFormat('en-IN').format(n);
const when = s => new Date(s.replace(' ', 'T') + 'Z').toLocaleString('en-IN', {day:'numeric', month:'short', hour:'numeric', minute:'2-digit'});
const dateLabel = d => d ? new Date(d + 'T00:00').toLocaleDateString('en-IN', {weekday:'short', day:'numeric', month:'short', year:'numeric'}) : '';

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, { method: opts.method || 'GET',
      headers: {'Content-Type': 'application/json', 'X-Requested-With': 'gatehouse'},
      body: opts.body ? JSON.stringify(opts.body) : undefined });
  } catch { throw { error: 'network', message: 'Cannot reach the server. Check your connection.' }; }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.error === 'auth') { location.href = '/login'; throw data; }
  if (!res.ok) throw { status: res.status, ...data };
  return data;
}

let toastT;
function toast(msg, bad) {
  let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = msg; t.className = 'on' + (bad ? ' bad' : '');
  clearTimeout(toastT); toastT = setTimeout(() => t.className = '', 3800);
}

function ask(title, text, ok = 'Confirm', danger = false) {
  return new Promise(res => {
    const d = document.createElement('dialog');
    d.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3><p style="color:var(--mute);margin:-8px 0 20px">${esc(text)}</p>
      <div class="actions"><button value="no" class="btn ghost">Cancel</button><button value="yes" class="btn ${danger ? 'warn' : ''}">${esc(ok)}</button></div></form>`;
    d.addEventListener('close', () => { res(d.returnValue === 'yes'); d.remove(); });
    document.body.append(d); d.showModal();
  });
}

async function logout() { try { await api('/api/auth/logout', { method: 'POST' }); } catch {} location.href = '/login'; }
function mountMe(me) {
  $('#me').innerHTML = `<div><b>${esc(me.name)}</b><span>${esc(me.email)}</span></div><button class="btn ghost" id="outBtn">Sign out</button>`;
  $('#outBtn').onclick = logout;
}

function statusTag(e) {
  if (e.status === 'draft') return ['mute', 'Draft'];
  if (e.status === 'closed') return ['out', 'Closed'];
  if (e.remaining === 0) return ['out', 'Sold out'];
  return ['', 'On sale'];
}
function rowHTML(e, selId, org) {
  const [c, t] = statusTag(e);
  const top = org ? `<span class="tag ${c}">${t}</span>` : `<span class="num">${inr(e.price_cents)}</span>`;
  const l = org ? `${num(e.sold)} of ${num(e.capacity)} sold` : esc(e.venue || 'Venue to be announced');
  const r = org ? `<span class="num">${inr(e.revenue_cents)}</span>` : `<span class="num">${e.remaining ? num(e.remaining) + ' left' : 'Sold out'}</span>`;
  return `<button class="row" data-id="${e.id}" aria-current="${e.id === selId}"><div class="t"><span>${esc(e.name)}</span>${top}</div>
    <div class="s"><span>${l}</span>${r}</div><div class="mini ${e.surged ? 'hot' : ''}"><i style="width:${e.sold / e.capacity * 100}%"></i></div></button>`;
}

/* live price + capacity block, shared by both dashboards */
function liveHTML(extra = '') {
  return `<div class="pricebox"><div class="price num" id="price"></div><div><span class="tag" id="tag"></span><small id="priceNote"></small></div></div>
  <div class="meter"><div class="bar" role="img" id="bar"><div class="zone" id="zone"></div><div class="fill" id="fill"></div></div>
    <div class="cap"><span id="capL"></span><span id="capR"></span></div></div>
  <dl class="stats"><div><dt>Sold</dt><dd class="num" id="sSold"></dd></div><div><dt>Remaining</dt><dd class="num" id="sRem"></dd></div>
    <div><dt>At base price</dt><dd class="num" id="sBase"></dd></div>${extra}</dl>`;
}
let lastPrice = null;
const resetLive = () => { lastPrice = null; };
function paintLive(e) {
  const p = $('#price'); if (!p) return;
  if (lastPrice !== null && lastPrice !== e.price_cents) { p.classList.remove('bump'); void p.offsetWidth; p.classList.add('bump'); }
  lastPrice = e.price_cents;
  const out = e.remaining === 0;
  p.textContent = out ? 'Sold out' : inr(e.price_cents);
  const [cls, txt] = e.status === 'draft' ? ['mute', 'Draft, not on sale'] : e.status === 'closed' ? ['out', 'Sales closed']
    : out ? ['out', 'No tickets left'] : e.surged ? ['hot', `Surge price +${e.surge_pct}%`] : ['', 'Base price'];
  $('#tag').className = 'tag ' + cls; $('#tag').textContent = txt;
  $('#priceNote').textContent = e.surged ? `Base price was ${inr(e.base_cents)}`
    : e.surge_zone ? `Rises to ${inr(e.surge_cents)} when ${num(e.surge_zone)} ticket${e.surge_zone > 1 ? 's' : ''} remain` : 'Flat price, no surge for this event';
  $('#fill').style.width = (e.sold / e.capacity * 100) + '%';
  $('#zone').style.width = (e.surge_zone / e.capacity * 100) + '%';
  $('#bar').setAttribute('aria-label', `${e.sold} of ${e.capacity} tickets sold`);
  $('#capL').textContent = `${num(e.sold)} of ${num(e.capacity)} sold`;
  $('#capR').textContent = e.surge_zone ? `Shaded: surge zone, last ${num(e.surge_zone)}` : '';
  $('#sSold').textContent = num(e.sold); $('#sRem').textContent = num(e.remaining); $('#sBase').textContent = num(e.base_left);
}
