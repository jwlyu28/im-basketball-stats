import express from "express";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const IML_BASE = "https://api.imleagues.com/";

let auth = {
  jwtTokenForSPA: null,
  jwtTokenIndexForSPA: null,
  loggedInAt: 0
};

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// IMLeagues admin login returns jwtTokenForSPA  [oai_citation:2‡api.imleagues.com](https://api.imleagues.com/Help/Api/POST-admin-account-login)
async function imlAdminLogin() {
  const email = mustEnv("IML_EMAIL");
  const password = mustEnv("IML_PASSWORD");

  const payload = {
    schoolId: process.env.IML_SCHOOL_ID || "",
    forAdminSite: true,
    forApp: false,
    email,
    password,
    isSSO: false,
    isHttps: true,
    isMobileDevice: false,
    isElectron: false,
    clientType: 0,
    timezone: -300 // Indiana is UTC-5 standard; adjust if needed
  };

  const res = await fetch(IML_BASE + "admin/account/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`IMLeagues login failed (${res.status}): ${JSON.stringify(data)}`);
  }
  if (!data?.jwtTokenForSPA) {
    throw new Error(`Login succeeded but no jwtTokenForSPA returned: ${JSON.stringify(data)}`);
  }

  auth = {
    jwtTokenForSPA: data.jwtTokenForSPA,
    jwtTokenIndexForSPA: data.jwtTokenIndexForSPA ?? null,
    loggedInAt: Date.now()
  };

  return auth;
}

// Best-guess auth header: Bearer JWT (common for SPA JWT flows)
// If IMLeagues expects a different header/cookie, you’ll see a 401 and we’ll adjust.
function imlAuthHeaders() {
  if (!auth.jwtTokenForSPA) return {};
  return {
    Authorization: `Bearer ${auth.jwtTokenForSPA}`
  };
}

async function imlFetch(path, { method = "GET", body } = {}) {
  const url = path.startsWith("http") ? path : (IML_BASE + path.replace(/^\//, ""));
  const headers = {
    ...(body ? { "Content-Type": "application/json" } : {}),
    ...imlAuthHeaders()
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    const msg = `IMLeagues API error (${res.status}) on ${path}: ${text}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = json ?? text;
    throw err;
  }
  return json ?? text;
}

/**
 * ROUTES
 */

// 1) login (server-side). Call this first.
app.post("/api/iml/login", async (req, res) => {
  try {
    const a = await imlAdminLogin();
    res.json({ ok: true, jwtTokenIndexForSPA: a.jwtTokenIndexForSPA ?? null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// 2) get games in a date range for your network/school
// IMLeagues has a public networks/{id}/games endpoint  [oai_citation:3‡api.imleagues.com](https://api.imleagues.com/Help)
app.get("/api/iml/games", async (req, res) => {
  try {
    const networkId = mustEnv("IML_NETWORK_ID");
    const start = req.query.start; // ISO string
    const end = req.query.end;     // ISO string

    if (!start || !end) {
      return res.status(400).json({ ok: false, error: "Missing start/end query params (ISO datetime strings)." });
    }

    const data = await imlFetch(`networks/${encodeURIComponent(networkId)}/games?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// 3) get team roster (team members)
// IMLeagues exposes teams/{id}/members  [oai_citation:4‡api.imleagues.com](https://api.imleagues.com/Help)
app.get("/api/iml/teams/:teamId/members", async (req, res) => {
  try {
    const { teamId } = req.params;
    const data = await imlFetch(`teams/${encodeURIComponent(teamId)}/members`);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// 4) save score (admin)
// POST v3/me/games/savescore exists for admins  [oai_citation:5‡api.imleagues.com](https://api.imleagues.com/Help/Api/POST-v3-me-games-savescore)
app.post("/api/iml/games/:gameId/savescore", async (req, res) => {
  try {
    // Ensure logged in
    if (!auth.jwtTokenForSPA) await imlAdminLogin();

    const gameId = Number(req.params.gameId);
    const { gameType, team1Score, team2Score, comments } = req.body;

    if (!Number.isFinite(gameId)) return res.status(400).json({ ok: false, error: "Invalid gameId" });
    if (gameType === undefined) return res.status(400).json({ ok: false, error: "Missing gameType (number)" });

    // Minimal payload based on IMLeagues sample  [oai_citation:6‡api.imleagues.com](https://api.imleagues.com/Help/Api/POST-v3-me-games-savescore)
    // You can extend this later with periodDetails if your sport/game requires it.
    const payload = {
      gameResult: 1, // guess: "played/complete" (IMLeagues uses enums; we’ll adjust if needed)
      periodDetails: [],
      team1Score: String(team1Score ?? ""),
      team2Score: String(team2Score ?? ""),
      comments: comments ?? "",
      gameId,
      gameType
    };

    const data = await imlFetch("v3/me/games/savescore", { method: "POST", body: payload });
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
});