const express = require("express");
const fetch = require("node-fetch");
const { randomUUID } = require("crypto");
const WebSocket = require("ws");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ROBLOSECURITY = process.env.ROBLOSECURITY || "";
const DEFAULT_PLACE_ID = process.env.PLACE_ID || "8737602449";
const MIN_CAPACITY_RATIO = parseFloat(process.env.MIN_CAPACITY_RATIO || "0.0");
const MAX_WORKERS = parseInt(process.env.MAX_WORKERS || "12");
const JOB_TTL_MS = 20 * 60 * 1000;
const DONATION_SECRET = process.env.DONATION_SECRET || "phonktobiboy!";

const jobs = new Map();
const liveSubscribers = new Map();
const liveDataCache = new Map();
let liveBroadcastInterval = null;

const MAX_DONATIONS = 200;
const donationStore = [];

function addDonation(entry) {
  donationStore.unshift(entry);
  if (donationStore.length > MAX_DONATIONS) donationStore.length = MAX_DONATIONS;
}

function robloxHeaders() {
  return {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    ...(ROBLOSECURITY && { "Cookie": `.ROBLOSECURITY=${ROBLOSECURITY}` })
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function apiFetch(url, opts = {}, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        ...opts,
        headers: { ...robloxHeaders(), ...(opts.headers || {}) }
      });
      if (res.status === 429) { await sleep(3500 * (i + 1)); continue; }
      return res;
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(800 * (i + 1));
    }
  }
  throw new Error("Max retries exceeded");
}

async function resolveUser(username) {
  const res = await apiFetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false })
  });
  const data = await res.json();
  if (!data.data?.length) return { userId: null };
  const u = data.data[0];
  return { userId: String(u.id), displayName: u.displayName || username };
}

async function resolveHeadshot(userId, size = "150x150") {
  try {
    const res = await apiFetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=${size}&format=Png&isCircular=false`
    );
    const data = await res.json();
    return data?.data?.[0]?.imageUrl || "";
  } catch { return ""; }
}

async function getPresenceStatus(userId, placeId) {
  if (!ROBLOSECURITY) return { type: "unknown", inGame: false, inThisGame: false, gameId: null };
  try {
    const res = await apiFetch("https://presence.roblox.com/v1/presence/users", {
      method: "POST",
      body: JSON.stringify({ userIds: [Number(userId)] })
    });
    const data = await res.json();
    const p = data?.userPresences?.[0];
    if (!p) return { type: "unknown", inGame: false, inThisGame: false, gameId: null };
    const inGame = p.userPresenceType === 2;
    const inThisGame = inGame && String(p.rootPlaceId || p.placeId || "") === String(placeId || DEFAULT_PLACE_ID);
    return {
      type: p.userPresenceType === 0 ? "offline" : p.userPresenceType === 1 ? "online" : p.userPresenceType === 2 ? "ingame" : "unknown",
      inGame,
      inThisGame,
      gameId: p.gameId || null,
      placeId: String(p.rootPlaceId || p.placeId || "")
    };
  } catch { return { type: "unknown", inGame: false, inThisGame: false, gameId: null }; }
}

async function batchMatchServer(server, targetUserId, thumbnailUrls) {
  if (!server.playerTokens?.length) return null;
  const tokens = server.playerTokens.slice(0, 100);
  const tokenMap = new Map();
  const batchRequests = tokens.map((token, idx) => {
    const requestId = `req_${idx}_${token}`;
    tokenMap.set(requestId, token);
    return { requestId, token, type: "AvatarHeadShot", size: "48x48", format: "png", isCircular: false };
  });
  try {
    const res = await fetch("https://thumbnails.roblox.com/v1/batch", {
      method: "POST", headers: robloxHeaders(), body: JSON.stringify(batchRequests)
    });
    if (!res.ok) return null;
    const data = await res.json();
    for (const entry of data.data || []) {
      if (!entry || !entry.requestId) continue;
      const token = tokenMap.get(entry.requestId);
      if (!token) continue;
      const imageUrl = entry.imageUrl;
      if (imageUrl) {
        for (const thumb of thumbnailUrls) {
          if (thumb && imageUrl === thumb) {
            return { serverId: server.id, matchType: "thumbnail" };
          }
        }
      }
    }
    return null;
  } catch { return null; }
}

async function fetchServersPage(placeId, sortOrder, limit, cursor = null) {
  const url = new URL(`https://games.roblox.com/v1/games/${placeId}/servers/Public`);
  url.searchParams.set("sortOrder", sortOrder);
  url.searchParams.set("limit", limit);
  if (cursor) url.searchParams.set("cursor", cursor);
  const res = await apiFetch(url.toString());
  if (!res.ok) return { servers: [], nextCursor: null };
  const data = await res.json();
  return {
    servers: (data.data || []).filter(s => {
      if (!s.playerTokens?.length) return false;
      if (!s.maxPlayers) return true;
      return (s.playing / s.maxPlayers) >= MIN_CAPACITY_RATIO;
    }),
    nextCursor: data.nextPageCursor || null
  };
}

async function deepSnipe(job, userId, thumbnailUrls, placeId, workerCount) {
  const found = { value: false, result: null };
  const serverQueue = [];
  let queueResolve = null;
  let fetchersFinished = 0;
  const totalFetchers = workerCount * 2;
  const sortOrders = ["Asc", "Desc"];
  const limits = [100, 50];
  const maxPages = 15;

  const notifyQueue = () => { if (queueResolve) { const r = queueResolve; queueResolve = null; r(); } };

  const fetcher = async (startCursor, sortOrder, limit, workerId) => {
    let cursor = startCursor;
    let pages = 0, seen = 0;
    while (!found.value && !job.cancelled && pages < maxPages) {
      try {
        const { servers, nextCursor } = await fetchServersPage(placeId, sortOrder, limit, cursor);
        seen += servers.length; pages++;
        job.step = `W${workerId} ${sortOrder} L${limit} p${pages} s${seen}`;
        if (servers.length) { serverQueue.push(...servers); notifyQueue(); }
        cursor = nextCursor;
        if (!cursor) break;
      } catch { break; }
    }
    fetchersFinished++;
    if (fetchersFinished === totalFetchers) notifyQueue();
  };

  const matcher = async () => {
    const batchSize = 20;
    while (!found.value && !job.cancelled) {
      if (serverQueue.length === 0) {
        if (fetchersFinished === totalFetchers) break;
        await new Promise(r => { queueResolve = r; });
        continue;
      }
      const batch = serverQueue.splice(0, batchSize);
      const results = await Promise.allSettled(batch.map(s => batchMatchServer(s, userId, thumbnailUrls)));
      for (const res of results) {
        if (res.status === "fulfilled" && res.value !== null) {
          found.value = true;
          found.result = res.value;
          return;
        }
      }
    }
  };

  const startCursors = await Promise.all([
    (async () => null)(),
    (async () => { try { const { nextCursor } = await fetchServersPage(placeId, "Asc", 100); return nextCursor; } catch { return null; } })(),
    (async () => { try { const { nextCursor } = await fetchServersPage(placeId, "Desc", 100); return nextCursor; } catch { return null; } })()
  ]);

  const workers = [];
  let workerId = 1;
  for (const sort of sortOrders) {
    for (const limit of limits) {
      const perCombo = Math.max(1, Math.floor(workerCount / (sortOrders.length * limits.length)));
      for (let i = 0; i < perCombo; i++) {
        const cursor = startCursors[workers.length % startCursors.length];
        workers.push(fetcher(cursor, sort, limit, workerId++));
        if (workers.length >= totalFetchers) break;
      }
    }
  }
  while (workers.length < totalFetchers) workers.push(fetcher(null, "Asc", 100, workerId++));

  await Promise.race([Promise.allSettled(workers), matcher()]);
  return found.result;
}

async function runSearch(jobId, username, placeId, instanceCount) {
  const job = jobs.get(jobId);
  if (!job) return;
  try {
    job.step = `Resolving ${username}...`;
    const { userId, displayName } = await resolveUser(username);
    if (!userId) { job.status = "done"; job.result = { found: false, message: `User "${username}" does not exist` }; return; }
    job.userId = userId;

    const [thumb150, thumb48, thumb720] = await Promise.all([
      resolveHeadshot(userId, "150x150"),
      resolveHeadshot(userId, "48x48"),
      resolveHeadshot(userId, "720x720")
    ]);

    job.step = "Checking presence...";
    const presence = await getPresenceStatus(userId, placeId);

    if (presence.type === "offline") { job.status = "done"; job.result = { found: false, message: `${displayName} is offline`, presenceStatus: "offline" }; return; }
    if (presence.type === "online") { job.status = "done"; job.result = { found: false, message: `${displayName} is on website but not in game`, presenceStatus: "online" }; return; }
    if (presence.inGame && presence.gameId && presence.inThisGame) {
      job.status = "done";
      job.result = { found: true, serverId: presence.gameId, placeId: String(placeId), userId: String(userId), displayName, thumbnailUrl: thumb150, foundInInstance: 1, matchType: "presence" };
      return;
    }

    if (job.cancelled) return;

    job.step = `Deep scanning with ${instanceCount} workers...`;
    const result = await deepSnipe(job, userId, [thumb48, thumb720], placeId, instanceCount);

    if (job.cancelled) return;
    job.status = "done";

    if (result) {
      job.result = { found: true, serverId: result.serverId, placeId: String(placeId), userId: String(userId), displayName, thumbnailUrl: thumb150, foundInInstance: 1, matchType: result.matchType };
    } else {
      const finalPresence = await getPresenceStatus(userId, placeId);
      const privateGuess = finalPresence.inGame && finalPresence.inThisGame;
      job.result = { found: false, message: privateGuess ? "Player is likely in a private server" : "Player not found in any public server", possiblePrivate: true };
    }
  } catch (err) {
    if (job.cancelled) return;
    job.status = "done";
    job.result = { found: false, message: "Internal error: " + err.message };
  }
}

function startLiveBroadcast() {
  if (liveBroadcastInterval) return;
  liveBroadcastInterval = setInterval(async () => {
    if (liveSubscribers.size === 0) return;
    try {
      const { servers } = await fetchServersPage(DEFAULT_PLACE_ID, "Desc", 100);
      const enriched = [];
      for (const s of servers.slice(0, 30)) {
        const tokens = s.playerTokens.slice(0, 10);
        if (!tokens.length) continue;
        const batchRequests = tokens.map(t => ({ requestId: `0:${t}:AvatarHeadShot:48x48:png:regular`, token: t, type: "AvatarHeadShot", size: "48x48", format: "png", isCircular: false }));
        try {
          const res = await fetch("https://thumbnails.roblox.com/v1/batch", { method: "POST", headers: robloxHeaders(), body: JSON.stringify(batchRequests) });
          const data = await res.json();
          const thumbs = {};
          for (const e of data.data || []) { if (e.token) thumbs[e.token] = e.imageUrl; }
          enriched.push({ id: s.id, playing: s.playing, maxPlayers: s.maxPlayers, playerTokens: s.playerTokens, thumbnails: thumbs });
        } catch {}
      }
      liveDataCache.clear();
      enriched.forEach(s => liveDataCache.set(s.id, s));
      const payload = JSON.stringify(Array.from(liveDataCache.values()));
      for (const ws of liveSubscribers.values()) { if (ws.readyState === WebSocket.OPEN) ws.send(payload); }
    } catch {}
  }, 5000);
}

app.get("/", (req, res) => res.json({ status: "ok", activeJobs: jobs.size, donations: donationStore.length }));

app.post("/donation", (req, res) => {
  const { secret, donor, receiver, robux } = req.body;
  if (secret !== DONATION_SECRET) return res.status(403).json({ ok: false, message: "Forbidden" });
  if (!donor || !receiver || !robux) return res.status(400).json({ ok: false, message: "Missing fields" });
  const amount = parseInt(String(robux).replace(/,/g, ""), 10);
  if (isNaN(amount) || amount <= 0) return res.status(400).json({ ok: false, message: "Invalid robux amount" });
  const entry = { donor: String(donor), receiver: String(receiver), robux: amount, id: randomUUID(), ts: Date.now() };
  addDonation(entry);
  console.log(`[donation] ${entry.donor} -> ${entry.receiver} ${entry.robux}R$`);
  res.json({ ok: true });
});

app.get("/donations", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), MAX_DONATIONS);
  res.json({ ok: true, count: Math.min(limit, donationStore.length), donations: donationStore.slice(0, limit) });
});

app.get("/donations/latest", (req, res) => {
  if (!donationStore.length) return res.json({ ok: true, donation: null });
  res.json({ ok: true, donation: donationStore[0] });
});

app.get("/live-servers", (req, res) => {
  res.json(Array.from(liveDataCache.values()));
});

app.post("/resolve", async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ ok: false, message: "Missing username" });
  try {
    const user = await resolveUser(username);
    if (!user.userId) return res.json({ ok: false, message: `User "${username}" does not exist` });
    const thumbnailUrl = await resolveHeadshot(user.userId);
    res.json({ ok: true, userId: user.userId, displayName: user.displayName, thumbnailUrl });
  } catch (err) { res.status(500).json({ ok: false, message: String(err) }); }
});

app.post("/search", async (req, res) => {
  const { username, placeId, instanceCount } = req.body;
  if (!username) return res.status(400).json({ ok: false, message: "Missing username" });
  const jobId = randomUUID();
  const workers = Math.min(Math.max(Number(instanceCount) || 1, 1), MAX_WORKERS);
  jobs.set(jobId, { status: "running", step: "Starting...", result: null, startedAt: Date.now(), cancelled: false, userId: null, placeId: placeId || DEFAULT_PLACE_ID });
  res.json({ ok: true, jobId });
  runSearch(jobId, username, placeId || DEFAULT_PLACE_ID, workers);
  setTimeout(() => jobs.delete(jobId), JOB_TTL_MS);
});

app.get("/result/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, message: "Job not found or expired" });
  res.json({ ok: true, status: job.status, step: job.step, result: job.result });
});

app.post("/cancel/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, message: "Job not found" });
  job.cancelled = true; job.status = "done"; job.result = { found: false, message: "Cancelled" };
  res.json({ ok: true });
});

app.post("/presence-check", async (req, res) => {
  const { jobId, placeId } = req.body;
  const job = jobs.get(jobId);
  if (!job?.userId) return res.json({ abort: false });
  const presence = await getPresenceStatus(job.userId, placeId || DEFAULT_PLACE_ID);
  if (presence.type === "offline") return res.json({ abort: true, message: "Player went offline", presenceStatus: "offline" });
  res.json({ abort: false });
});

const server = app.listen(PORT, () => {
  console.log(`[server] port:${PORT} | ROBLOSECURITY:${ROBLOSECURITY ? "SET" : "NOT SET"} | DONATION_SECRET:${DONATION_SECRET !== "changeme" ? "SET" : "USING DEFAULT - CHANGE THIS"}`);
  startLiveBroadcast();
});

const wss = new WebSocket.Server({ server, path: "/live" });
wss.on("connection", (ws) => {
  const id = randomUUID();
  liveSubscribers.set(id, ws);
  if (liveDataCache.size) ws.send(JSON.stringify(Array.from(liveDataCache.values())));
  ws.on("close", () => liveSubscribers.delete(id));
  ws.on("error", () => liveSubscribers.delete(id));
});
