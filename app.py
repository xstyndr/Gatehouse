"""Gatehouse: event ticketing with organizer and attendee dashboards (Flask + SQLite)."""
import hmac
import os
import re
import secrets
import sqlite3
import time
from datetime import datetime, timedelta
from functools import wraps

from flask import Flask, g, jsonify, redirect, render_template, request, session
from werkzeug.security import check_password_hash, generate_password_hash

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("TICKETS_DB", os.path.join(BASE, "gatehouse.db"))
ORGANIZER_CODE = os.environ.get("ORGANIZER_CODE", "")   # set it to restrict organizer sign-ups


def _secret_key():
    if os.environ.get("SECRET_KEY"):
        return os.environ["SECRET_KEY"]
    path = os.path.join(BASE, ".secret_key")            # persisted so sessions survive restarts
    if not os.path.exists(path):
        with open(path, "w") as f:
            f.write(secrets.token_hex(32))
        os.chmod(path, 0o600)
    return open(path).read().strip()


app = Flask(__name__, template_folder=os.path.join(BASE, "web/"))
app.config.update(
    SECRET_KEY=_secret_key(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE") == "1",   # set to 1 behind HTTPS
    PERMANENT_SESSION_LIFETIME=timedelta(days=7),
    MAX_CONTENT_LENGTH=64 * 1024,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL UNIQUE,
    pw_hash    TEXT NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('attendee','organizer')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id      INTEGER NOT NULL REFERENCES users(id),
    name          TEXT NOT NULL,
    venue         TEXT NOT NULL DEFAULT '',
    description   TEXT NOT NULL DEFAULT '',
    starts_at     TEXT NOT NULL DEFAULT '',
    base_cents    INTEGER NOT NULL CHECK (base_cents > 0),
    capacity      INTEGER NOT NULL CHECK (capacity > 0),
    sold          INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed')),
    surge_pct     INTEGER NOT NULL DEFAULT 25,
    surge_below   INTEGER NOT NULL DEFAULT 20,
    max_per_order INTEGER NOT NULL DEFAULT 6,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (sold >= 0 AND sold <= capacity)      -- last line of defence against overselling
);
CREATE TABLE IF NOT EXISTS bookings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    INTEGER NOT NULL REFERENCES events(id),
    user_id     INTEGER NOT NULL REFERENCES users(id),
    name        TEXT NOT NULL,
    email       TEXT NOT NULL,
    quantity    INTEGER NOT NULL,
    total_cents INTEGER NOT NULL,
    codes       TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


def init_db():
    c = sqlite3.connect(DB_PATH)
    c.execute("PRAGMA journal_mode=WAL")
    c.executescript(SCHEMA)
    c.commit()
    c.close()


def db():
    if "db" not in g:
        c = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)  # we manage transactions
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA busy_timeout=10000")
        g.db = c
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    c = g.pop("db", None)
    if c is not None:
        c.close()


class ApiError(Exception):
    def __init__(self, status, code, message, **extra):
        self.status, self.code, self.message, self.extra = status, code, message, extra


@app.errorhandler(ApiError)
def handle_api_error(e):
    return jsonify(error=e.code, message=e.message, **e.extra), e.status


@app.errorhandler(413)
def too_big(_e):
    return jsonify(error="too_large", message="Request too large."), 413


@app.before_request
def csrf_guard():
    # Browsers can't attach a custom header cross-site without a CORS preflight,
    # so requiring one on every state-changing call blocks cross-site request forgery.
    if request.path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS"):
        if request.headers.get("X-Requested-With") != "gatehouse":
            raise ApiError(403, "csrf", "Request blocked.")


@app.after_request
def headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    if request.path.startswith("/api/") or resp.mimetype == "text/html":
        resp.headers["Cache-Control"] = "no-store"
    return resp


def body():
    d = request.get_json(silent=True)
    return d if isinstance(d, dict) else {}


# ---------- auth ----------
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
ROLES = ("attendee", "organizer")
DUMMY_HASH = generate_password_hash("not-a-real-password")   # equalises timing for unknown emails
FAILS = {}


def throttle_check(key, limit=8, window=600):
    now = time.time()
    q = [t for t in FAILS.get(key, []) if now - t < window]
    FAILS[key] = q
    if len(q) >= limit:
        raise ApiError(429, "throttled", "Too many attempts. Try again in a few minutes.")


def current_user():
    uid = session.get("uid")
    if not uid:
        return None
    return db().execute("SELECT id, name, email, role FROM users WHERE id=?", (uid,)).fetchone()


def require(role):
    def deco(f):
        @wraps(f)
        def wrapper(*a, **k):
            u = current_user()
            if not u:
                raise ApiError(401, "auth", "Sign in to continue.")
            if u["role"] != role:
                raise ApiError(403, "forbidden", f"This action is for {role}s.")
            g.user = u
            return f(*a, **k)
        return wrapper
    return deco


def home_for(u):
    return "/organizer" if u["role"] == "organizer" else "/events"


@app.post("/api/auth/register")
def register():
    d = body()
    name = str(d.get("name", "")).strip()
    email = str(d.get("email", "")).strip().lower()
    pw = str(d.get("password", ""))
    role = d.get("role")
    if role not in ROLES:
        raise ApiError(400, "invalid", "Choose attendee or organizer.")
    if not 1 <= len(name) <= 80:
        raise ApiError(400, "invalid", "Enter your full name.")
    if not EMAIL_RE.match(email) or len(email) > 200:
        raise ApiError(400, "invalid", "Enter a valid email address.")
    if not 8 <= len(pw) <= 128:
        raise ApiError(400, "invalid", "Password must be 8 to 128 characters.")
    if role == "organizer" and ORGANIZER_CODE and not hmac.compare_digest(
            str(d.get("organizer_code", "")), ORGANIZER_CODE):
        raise ApiError(403, "bad_code", "That organizer access code is not valid.")
    c = db()
    try:
        cur = c.execute("INSERT INTO users (name, email, pw_hash, role) VALUES (?,?,?,?)",
                        (name, email, generate_password_hash(pw), role))
    except sqlite3.IntegrityError:
        raise ApiError(409, "exists", "An account with this email already exists. Sign in instead.")
    session.clear()
    session["uid"] = cur.lastrowid
    session.permanent = True
    return jsonify(redirect=home_for({"role": role})), 201


@app.post("/api/auth/login")
def login():
    d = body()
    email = str(d.get("email", "")).strip().lower()
    pw = str(d.get("password", ""))
    role = d.get("role")
    if role not in ROLES:
        raise ApiError(400, "invalid", "Choose attendee or organizer.")
    key = (request.remote_addr, email)
    throttle_check(key)
    u = db().execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    ok = check_password_hash(u["pw_hash"] if u else DUMMY_HASH, pw)
    if not (u and ok and u["role"] == role):
        FAILS.setdefault(key, []).append(time.time())
        raise ApiError(401, "invalid_credentials", f"Email or password is incorrect for an {role} account.")
    FAILS.pop(key, None)
    session.clear()
    session["uid"] = u["id"]
    session.permanent = True
    return jsonify(redirect=home_for(u))


@app.post("/api/auth/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


# ---------- pricing ----------
def surge_cents(base, pct):
    return (base * (100 + pct) + 50) // 100


def unit_price(base, cap, sold, pct=25, below=20):
    """Price of the NEXT ticket. Surges when remaining tickets are under `below`% of capacity."""
    surged = pct > 0 and (cap - sold) * 100 < cap * below      # integer-exact, no float rounding
    return (surge_cents(base, pct) if surged else base), surged


def serialize(ev, org=False):
    cap, sold, base = ev["capacity"], ev["sold"], ev["base_cents"]
    pct, below, per = ev["surge_pct"], ev["surge_below"], ev["max_per_order"]
    remaining = cap - sold
    price, surged = unit_price(base, cap, sold, pct, below)
    zone = max(0, -(-cap * below // 100) - 1) if pct > 0 else 0   # tickets that sell at the surge price
    totals, running = [], 0
    for i in range(min(per, remaining)):                          # price each ticket as it is taken
        running += unit_price(base, cap, sold + i, pct, below)[0]
        totals.append(running)
    d = {
        "id": ev["id"], "name": ev["name"], "venue": ev["venue"], "description": ev["description"],
        "starts_at": ev["starts_at"], "status": ev["status"],
        "base_cents": base, "surge_cents": surge_cents(base, pct), "surge_pct": pct, "surge_below": below,
        "capacity": cap, "sold": sold, "remaining": remaining,
        "price_cents": price, "surged": surged,
        "base_left": max(0, remaining - zone), "surge_zone": zone,
        "totals": totals, "max_per_order": per,
    }
    if org:
        d["revenue_cents"], d["orders"] = ev["revenue"], ev["orders"]
    return d


# ---------- pages ----------
@app.get("/")
def index():
    u = current_user()
    return redirect(home_for(u) if u else "/login")


@app.get("/login")
def login_page():
    u = current_user()
    if u:
        return redirect(home_for(u))
    return render_template("login.html", org_code_required=bool(ORGANIZER_CODE))


def page(role, template):
    u = current_user()
    if not u:
        return redirect("/login")
    if u["role"] != role:
        return redirect(home_for(u))
    return render_template(template, me={"name": u["name"], "email": u["email"]})


@app.get("/events")
def attendee_page():
    return page("attendee", "attendee.html")


@app.get("/organizer")
def organizer_page():
    return page("organizer", "organizer.html")


# ---------- attendee API ----------
@app.get("/api/events")
@require("attendee")
def list_events():
    rows = db().execute("SELECT * FROM events WHERE status='published' ORDER BY id DESC").fetchall()
    return jsonify([serialize(r) for r in rows])


@app.post("/api/events/<int:event_id>/book")
@require("attendee")
def book(event_id):
    d = body()
    try:
        qty = int(d.get("quantity", 1))
    except (TypeError, ValueError):
        raise ApiError(400, "invalid", "Quantity must be a number.")
    expected = d.get("expected_total_cents")
    u = g.user
    c = db()
    # BEGIN IMMEDIATE takes the write lock up front: concurrent buyers queue here,
    # so each one reads the true `sold` count and is priced against it.
    c.execute("BEGIN IMMEDIATE")
    try:
        ev = c.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
        if not ev or ev["status"] == "draft":
            raise ApiError(404, "not_found", "Event not found.")
        if ev["status"] == "closed":
            raise ApiError(409, "not_on_sale", "Sales for this event are closed.")
        if not 1 <= qty <= ev["max_per_order"]:
            raise ApiError(400, "invalid", f"You can book 1 to {ev['max_per_order']} tickets at a time.")
        remaining = ev["capacity"] - ev["sold"]
        if remaining == 0:
            raise ApiError(409, "sold_out", "This event just sold out.", event=serialize(ev))
        if qty > remaining:
            raise ApiError(409, "insufficient", f"Only {remaining} ticket{'s' if remaining != 1 else ''} left.",
                           event=serialize(ev))
        total = sum(unit_price(ev["base_cents"], ev["capacity"], ev["sold"] + i,
                               ev["surge_pct"], ev["surge_below"])[0] for i in range(qty))
        if expected is not None and int(expected) != total:
            raise ApiError(409, "price_changed", "The price changed while you were booking.",
                           new_total_cents=total, event=serialize(ev))
        cur = c.execute("UPDATE events SET sold = sold + ? WHERE id = ? AND sold + ? <= capacity",
                        (qty, event_id, qty))
        if cur.rowcount != 1:
            raise ApiError(409, "sold_out", "Someone else took those tickets.", event=serialize(ev))
        codes = [f"TKT-{secrets.token_hex(3).upper()}" for _ in range(qty)]
        c.execute("INSERT INTO bookings (event_id, user_id, name, email, quantity, total_cents, codes) "
                  "VALUES (?,?,?,?,?,?,?)", (event_id, u["id"], u["name"], u["email"], qty, total, ",".join(codes)))
        c.execute("COMMIT")
    except BaseException:
        if c.in_transaction:
            c.execute("ROLLBACK")
        raise
    ev = c.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
    return jsonify(codes=codes, quantity=qty, total_cents=total, event=serialize(ev)), 201


@app.get("/api/my/tickets")
@require("attendee")
def my_tickets():
    rows = db().execute(
        "SELECT b.quantity, b.total_cents, b.codes, b.created_at, e.name AS event_name, e.venue, e.starts_at "
        "FROM bookings b JOIN events e ON e.id = b.event_id WHERE b.user_id=? ORDER BY b.id DESC",
        (g.user["id"],)).fetchall()
    return jsonify([{**dict(r), "codes": r["codes"].split(",")} for r in rows])


# ---------- organizer API ----------
ORG_SELECT = ("SELECT e.*, COALESCE((SELECT SUM(total_cents) FROM bookings b WHERE b.event_id = e.id), 0) AS revenue, "
              "(SELECT COUNT(*) FROM bookings b WHERE b.event_id = e.id) AS orders FROM events e ")


def org_event(c, event_id):
    ev = c.execute(ORG_SELECT + "WHERE e.id=? AND e.owner_id=?", (event_id, g.user["id"])).fetchone()
    if not ev:
        raise ApiError(404, "not_found", "Event not found.")
    return ev


def parse_event(d, creating):
    out = {}
    try:
        if creating or "name" in d:
            v = str(d.get("name", "")).strip()
            if not 1 <= len(v) <= 120:
                raise ApiError(400, "invalid", "Event name is required (max 120 characters).")
            out["name"] = v
        for k, label, mx in (("venue", "Venue", 120), ("description", "Description", 1000)):
            if k in d:
                v = str(d[k] or "").strip()
                if len(v) > mx:
                    raise ApiError(400, "invalid", f"{label} is too long (max {mx} characters).")
                out[k] = v
        if "starts_at" in d:
            v = str(d["starts_at"] or "").strip()
            if v:
                try:
                    datetime.strptime(v, "%Y-%m-%d")
                except ValueError:
                    raise ApiError(400, "invalid", "Enter the date as year-month-day.")
            out["starts_at"] = v
        if creating or "base_price" in d:
            cents = round(float(d.get("base_price")) * 100)
            if not 1 <= cents <= 10_000_000:
                raise ApiError(400, "invalid", "Base price must be between ₹0.01 and ₹1,00,000.")
            out["base_cents"] = cents
        if creating or "capacity" in d:
            cap = int(d.get("capacity"))
            if not 1 <= cap <= 100_000:
                raise ApiError(400, "invalid", "Capacity must be between 1 and 100,000.")
            out["capacity"] = cap
        for k, lo, hi, label in (("surge_pct", 0, 200, "Surge uplift"), ("surge_below", 0, 50, "Surge threshold"),
                                 ("max_per_order", 1, 20, "Max tickets per order")):
            if k in d:
                v = int(d[k])
                if not lo <= v <= hi:
                    raise ApiError(400, "invalid", f"{label} must be between {lo} and {hi}.")
                out[k] = v
    except (TypeError, ValueError, OverflowError):
        raise ApiError(400, "invalid", "Check the numbers you entered.")
    return out


@app.get("/api/org/events")
@require("organizer")
def org_list():
    rows = db().execute(ORG_SELECT + "WHERE e.owner_id=? ORDER BY e.id DESC", (g.user["id"],)).fetchall()
    return jsonify([serialize(r, org=True) for r in rows])


@app.post("/api/org/events")
@require("organizer")
def org_create():
    f = {"venue": "", "description": "", "starts_at": "", "surge_pct": 25, "surge_below": 20, "max_per_order": 6}
    f.update(parse_event(body(), creating=True))
    cols = list(f)
    c = db()
    cur = c.execute(f"INSERT INTO events (owner_id, {', '.join(cols)}) VALUES (?, {', '.join('?' * len(cols))})",
                    [g.user["id"], *f.values()])
    return jsonify(serialize(org_event(c, cur.lastrowid), org=True)), 201


@app.patch("/api/org/events/<int:event_id>")
@require("organizer")
def org_update(event_id):
    f = parse_event(body(), creating=False)
    c = db()
    c.execute("BEGIN IMMEDIATE")
    try:
        ev = org_event(c, event_id)
        if "capacity" in f and f["capacity"] < ev["sold"]:
            raise ApiError(409, "capacity", f"Capacity can't be lower than the {ev['sold']} tickets already sold.")
        if f:
            c.execute(f"UPDATE events SET {', '.join(k + '=?' for k in f)} WHERE id=?", [*f.values(), event_id])
        c.execute("COMMIT")
    except BaseException:
        if c.in_transaction:
            c.execute("ROLLBACK")
        raise
    return jsonify(serialize(org_event(c, event_id), org=True))


TRANSITIONS = {"draft": {"published"}, "published": {"closed", "draft"}, "closed": {"published"}}


@app.post("/api/org/events/<int:event_id>/status")
@require("organizer")
def org_status(event_id):
    new = body().get("status")
    c = db()
    c.execute("BEGIN IMMEDIATE")
    try:
        ev = org_event(c, event_id)
        if new not in TRANSITIONS[ev["status"]]:
            raise ApiError(409, "transition", "That change isn't available for this event.")
        if new == "draft" and ev["sold"] > 0:
            raise ApiError(409, "has_sales", "Events with sales can't go back to draft. Close sales instead.")
        c.execute("UPDATE events SET status=? WHERE id=?", (new, event_id))
        c.execute("COMMIT")
    except BaseException:
        if c.in_transaction:
            c.execute("ROLLBACK")
        raise
    return jsonify(serialize(org_event(c, event_id), org=True))


@app.delete("/api/org/events/<int:event_id>")
@require("organizer")
def org_delete(event_id):
    c = db()
    c.execute("BEGIN IMMEDIATE")
    try:
        ev = org_event(c, event_id)
        if ev["sold"] > 0:
            raise ApiError(409, "has_sales", "Events with bookings can't be deleted. Close sales instead.")
        c.execute("DELETE FROM events WHERE id=?", (event_id,))
        c.execute("COMMIT")
    except BaseException:
        if c.in_transaction:
            c.execute("ROLLBACK")
        raise
    return jsonify(ok=True)


@app.get("/api/org/events/<int:event_id>/bookings")
@require("organizer")
def org_bookings(event_id):
    c = db()
    org_event(c, event_id)
    rows = c.execute("SELECT name, email, quantity, total_cents, codes, created_at FROM bookings "
                     "WHERE event_id=? ORDER BY id DESC", (event_id,)).fetchall()
    return jsonify([{**dict(r), "codes": r["codes"].split(",")} for r in rows])


init_db()

if __name__ == "__main__":
    app.run(debug=True, threaded=True)
