const express = require("express"), fs = require("fs"), path = require("path"), crypto = require("crypto");

// ---- load .env (no extra package needed) ----
try {
  fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/).forEach((l) => {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  });
} catch {}

// ---- tiny JSON database ----
const DB_FILE = path.join(__dirname, "data.json");
const db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE)) : { users: [], sessions: {}, complaints: [], pickups: [] };
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 1));
fs.mkdirSync(path.join(__dirname, "uploads"), { recursive: true });

const app = express();
app.use(express.json({ limit: "15mb" }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(express.static(path.join(__dirname, "public")));

// ---- auth ----
const hash = (p, s) => crypto.scryptSync(p, s, 32).toString("hex");
const auth = (adminOnly) => (req, res, next) => {
  const u = db.users.find((x) => x.id === db.sessions[req.headers.authorization]);
  if (!u) return res.status(401).json({ error: "Please log in" });
  if (adminOnly && u.role !== "admin") return res.status(403).json({ error: "Admin only" });
  req.user = u; next();
};
const session = (u) => { const t = crypto.randomBytes(24).toString("hex"); db.sessions[t] = u.id; save(); return { token: t, user: pub(u) }; };
const pub = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

app.post("/api/register", (req, res) => {
  const { name = "", email = "", password = "" } = req.body;
  if (!email || password.length < 6) return res.status(400).json({ error: "Enter an email and a password of 6+ characters" });
  if (db.users.some((u) => u.email === email.toLowerCase())) return res.status(400).json({ error: "This email is already registered" });
  const salt = crypto.randomBytes(8).toString("hex");
  // The very first user becomes the admin
  const u = { id: crypto.randomUUID(), name, email: email.toLowerCase(), salt, pass: hash(password, salt), role: db.users.length ? "citizen" : "admin" };
  db.users.push(u); res.json(session(u));
});
app.post("/api/login", (req, res) => {
  const u = db.users.find((x) => x.email === (req.body.email || "").toLowerCase());
  if (!u || u.pass !== hash(req.body.password || "", u.salt)) return res.status(400).json({ error: "Wrong email or password" });
  res.json(session(u));
});
app.get("/api/me", auth(), (req, res) => res.json(pub(req.user)));

// ---- Gemini ----
async function gemini(prompt, photos) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key.startsWith("PASTE")) throw new Error("GEMINI_API_KEY is not set in .env");
  const parts = [{ text: prompt }, ...photos.map((p) => ({ inline_data: { mime_type: "image/" + path.extname(p).slice(1), data: fs.readFileSync(path.join(__dirname, p)).toString("base64") } }))];
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: "application/json", temperature: 0.2 } }),
  });
  const d = await r.json();
  if (!d.candidates) throw new Error(d.error?.message || "Gemini returned nothing");
  return JSON.parse(d.candidates[0].content.parts[0].text);
}
const CLASSIFY = (desc) => `You triage civic waste complaints from a photo and text.
Citizen description: "${desc || "none"}"
Return ONLY JSON: {"category":"overflowing_bin|roadside_garbage|missed_collection|illegal_dumping|other","severity":"low|medium|high|critical","confidence":0-1,"auto_response":"1-2 friendly sentences telling the citizen what happens next"}
Severity: critical = hazardous or blocking road; high = large overflow or dumping; medium = ordinary overflow; low = minor litter.`;
const VERIFY = `Image 1 is the ORIGINAL complaint photo. Image 2 is the PROOF photo after cleanup.
Is the waste issue from image 1 resolved in image 2 (same place, waste gone)?
Return ONLY JSON: {"verdict":"resolved|not_resolved|uncertain","confidence":0-1,"reason":"short"}`;

function savePhoto(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(dataUrl || "");
  if (!m) throw new Error("Invalid photo");
  const name = `/uploads/${crypto.randomBytes(8).toString("hex")}.${m[1]}`;
  fs.writeFileSync(path.join(__dirname, name), Buffer.from(m[2], "base64"));
  return name;
}
const metres = (a, b) => {
  const r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
};

// ---- complaints ----
app.post("/api/complaints", auth(), async (req, res) => {
  try {
    const { description = "", lat, lng, photo } = req.body;
    if (!photo || lat == null || lng == null) return res.status(400).json({ error: "Photo and location are required" });
    const c = { id: crypto.randomUUID(), userId: req.user.id, description, lat: +lat, lng: +lng, photo: savePhoto(photo), upvotes: 0, createdAt: new Date().toISOString() };

    let ai;
    try { ai = await gemini(CLASSIFY(description), [c.photo]); }
    catch (e) {
      console.log("Gemini failed:", e.message);
      ai = { category: "other", severity: "medium", confidence: 0, auto_response: "Thanks! Your report was received and our team will review it shortly." };
    }
    Object.assign(c, { category: ai.category, severity: ai.severity, autoResponse: ai.auto_response,
      zone: `Z${c.lat.toFixed(2)}_${c.lng.toFixed(2)}`, status: (ai.confidence ?? 1) < 0.5 ? "needs_review" : "routed" });

    const dup = db.complaints.find((o) => o.category === c.category && !o.duplicateOf && ["routed", "in_progress", "needs_review"].includes(o.status)
      && Date.now() - new Date(o.createdAt) < 7 * 864e5 && metres(o, c) <= 50);
    if (dup) { c.duplicateOf = dup.id; dup.upvotes++; c.autoResponse = "This issue was already reported nearby. We merged your report so the team acts on it faster."; }

    db.complaints.push(c); save(); res.json(c);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get("/api/complaints/mine", auth(), (req, res) => res.json(db.complaints.filter((c) => c.userId === req.user.id).reverse()));
app.get("/api/complaints", auth(true), (req, res) => res.json([...db.complaints].reverse()));

app.post("/api/complaints/:id/status", auth(true), (req, res) => {
  const c = db.complaints.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Not found" });
  c.status = req.body.status; if (c.status === "resolved") c.resolvedAt = new Date().toISOString();
  save(); res.json(c);
});
app.post("/api/complaints/:id/proof", auth(true), async (req, res) => {
  try {
    const c = db.complaints.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "Not found" });
    c.proofPhoto = savePhoto(req.body.photo);
    let v;
    try { v = await gemini(VERIFY, [c.photo, c.proofPhoto]); }
    catch (e) { v = { verdict: "uncertain", confidence: 0, reason: "AI check failed: " + e.message }; }
    const ok = v.verdict === "resolved" && (v.confidence ?? 0) >= 0.6;
    c.verification = v.verdict;
    c.status = ok ? "resolved" : v.verdict === "not_resolved" ? "in_progress" : "needs_review";
    if (ok) c.resolvedAt = new Date().toISOString();
    save(); res.json({ ...v, status: c.status });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- pickups ----
app.post("/api/pickups", auth(), (req, res) => {
  const { wasteType, address, date } = req.body;
  if (!address || !date) return res.status(400).json({ error: "Enter an address and a date" });
  db.pickups.push({ id: crypto.randomUUID(), userId: req.user.id, wasteType, address, date, status: "pending", createdAt: new Date().toISOString() });
  save(); res.json({ ok: true });
});
app.get("/api/pickups/mine", auth(), (req, res) => res.json(db.pickups.filter((p) => p.userId === req.user.id).reverse()));

app.listen(3000, () => console.log("Running → open http://localhost:3000"));