"""Pricing, access control and last-ticket race tests. Run: python tests.py"""
import os, sqlite3, tempfile, threading
os.environ["TICKETS_DB"] = os.path.join(tempfile.mkdtemp(), "test.db")
import app as A
from werkzeug.security import generate_password_hash

H = {"X-Requested-With": "gatehouse"}
HASH = generate_password_hash("password123")

def client(): return A.app.test_client()
def post(c, url, **j): return c.post(url, json=j, headers=H)

def make_user(role, n):
    con = sqlite3.connect(A.DB_PATH)
    cur = con.execute("INSERT INTO users (name,email,pw_hash,role) VALUES (?,?,?,?)", (f"User {n}", f"u{n}@x.com", HASH, role))
    con.commit(); uid = cur.lastrowid; con.close(); return uid

def signed_in(uid):
    c = client()
    with c.session_transaction() as s: s["uid"] = uid
    return c

# ---------- pricing ----------
assert A.unit_price(10000, 100, 79) == (10000, False)    # 21 left
assert A.unit_price(10000, 100, 80) == (10000, False)    # exactly 20% left: still base
assert A.unit_price(10000, 100, 81) == (12500, True)     # 19 left: +25%
assert A.unit_price(10000, 100, 81, pct=0) == (10000, False)
assert A.unit_price(10000, 100, 71, pct=50, below=30) == (15000, True)
print("pricing ok")

# ---------- auth + access control ----------
c = client()
assert c.get("/organizer").status_code == 302 and c.get("/events").status_code == 302
assert c.get("/api/events").status_code == 401
assert c.post("/api/auth/login", json={}).status_code == 403                  # missing CSRF header
r = post(c, "/api/auth/register", name="Org", email="Org@X.com", password="password123", role="organizer"); assert r.status_code == 201 and r.json["redirect"] == "/organizer"
assert c.get("/organizer").status_code == 200 and c.get("/events").status_code == 302
assert post(client(), "/api/auth/register", name="Dup", email="org@x.com", password="password123", role="attendee").status_code == 409
assert post(client(), "/api/auth/register", name="Sho", email="s@x.com", password="short", role="attendee").status_code == 400
assert post(client(), "/api/auth/login", email="org@x.com", password="password123", role="attendee").status_code == 401   # wrong role
assert post(client(), "/api/auth/login", email="org@x.com", password="nope", role="organizer").status_code == 401
assert post(client(), "/api/auth/login", email="org@x.com", password="password123", role="organizer").status_code == 200
a = client(); post(a, "/api/auth/register", name="Asha Rao", email="asha@x.com", password="password123", role="attendee")
assert a.get("/events").status_code == 200 and a.get("/organizer").status_code == 302
assert a.get("/api/org/events").status_code == 403
assert post(a, "/api/org/events", name="x", base_price=1, capacity=1).status_code == 403
print("auth ok")

# ---------- organizer workflow ----------
r = post(c, "/api/org/events", name="Night Market", base_price=500, capacity=10); assert r.status_code == 201
ev = r.json; eid = ev["id"]; assert ev["status"] == "draft" and ev["surge_zone"] == 1
assert a.get("/api/events").json == []                                         # drafts are invisible
assert post(a, f"/api/events/{eid}/book", quantity=1).status_code == 404       # ...and not bookable
assert c.post(f"/api/org/events/{eid}/status", json={"status": "published"}, headers=H).json["status"] == "published"
assert len(a.get("/api/events").json) == 1
other = signed_in(make_user("organizer", 900))
assert other.patch(f"/api/org/events/{eid}", json={"name": "Hijack"}, headers=H).status_code == 404   # not their event

r = post(a, f"/api/events/{eid}/book", quantity=6); assert r.status_code == 201 and r.json["total_cents"] == 300000
r = post(a, f"/api/events/{eid}/book", quantity=2, expected_total_cents=1); assert r.status_code == 409 and r.json["error"] == "price_changed"
r = post(a, f"/api/events/{eid}/book", quantity=4); assert r.status_code == 201 and r.json["total_cents"] == 50000 * 3 + 62500   # last ticket surged
assert post(a, f"/api/events/{eid}/book", quantity=1).json["error"] == "sold_out"
assert len(a.get("/api/my/tickets").json) == 2
assert c.patch(f"/api/org/events/{eid}", json={"capacity": 5}, headers=H).status_code == 409           # below sold
assert c.patch(f"/api/org/events/{eid}", json={"capacity": 20, "surge_pct": 0}, headers=H).json["surged"] is False
assert c.delete(f"/api/org/events/{eid}", headers=H).status_code == 409                                  # has sales
assert len(c.get(f"/api/org/events/{eid}/bookings").json) == 2
assert c.get("/api/org/events").json[0]["revenue_cents"] == 300000 + 212500
c.post(f"/api/org/events/{eid}/status", json={"status": "closed"}, headers=H)
assert post(a, f"/api/events/{eid}/book", quantity=1).json["error"] == "not_on_sale"
print("organizer workflow ok")

# ---------- last-ticket race ----------
org = signed_in(make_user("organizer", 901))
def run(capacity, buyers):
    e = post(org, "/api/org/events", name="Race", base_price=100, capacity=capacity).json["id"]
    org.post(f"/api/org/events/{e}/status", json={"status": "published"}, headers=H)
    uids = [make_user("attendee", 1000 + capacity * 1000 + i) for i in range(buyers)]
    out, gate = [], threading.Barrier(buyers)
    def buyer(uid):
        cl = signed_in(uid); gate.wait()
        out.append(post(cl, f"/api/events/{e}/book", quantity=1).status_code)
    ts = [threading.Thread(target=buyer, args=(u,)) for u in uids]
    [t.start() for t in ts]; [t.join() for t in ts]
    sold = org.get("/api/org/events").json
    sold = next(x for x in sold if x["id"] == e)["sold"]
    print(f"capacity={capacity:>3} buyers={buyers:>3} -> booked={out.count(201)}, rejected={out.count(409)}, sold={sold}")
    assert out.count(201) == capacity == sold
run(1, 25); run(10, 40); run(50, 120)
print("all tests passed")
