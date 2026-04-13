const express = require("express");
const fetch = require("node-fetch");
const { randomUUID } = require("crypto");
const WebSocket = require("ws");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ROBLOSECURITY = process.env.ROBLOSECURITY || "";
const DEFAULT_UNIVERSE_ID = process.env.UNIVERSE_ID || "3317679266";
const DEFAULT_PLACE_ID = process.env.PLACE_ID || "8737602449";
const MIN_CAPACITY_RATIO = parseFloat(process.env.MIN_CAPACITY_RATIO || "0.0");
const MAX_WORKERS = parseInt(process.env.MAX_WORKERS || "12");
const JOB_TTL_MS = 20 * 60 * 1000;
const DONATION_SECRET = process.env.DONATION_SECRET || "phonktobiboy!";
const MAX_DONATIONS = 200;
const DONATION_TTL_MS = 5 * 60 * 1000;
const SERVER_ID_TTL_MS = 30 * 1000;
const SERVER_CAPACITY_TTL_MS = 60 * 1000;

const jobs = new Map();
const liveSubscribers = new Map();
const liveDataCache = new Map();
const serverCapacityCache = new Map();
let liveBroadcastInterval = null;
const donationStore = [];
const donationSubscribers = new Map();

function setServerCapacity(serverId, playing, maxPlayers) {
  serverCapacityCache.set(serverId, { playing, maxPlayers, ts: Date.now() });
  setTimeout(() => serverCapacityCache.delete(serverId), SERVER_CAPACITY_TTL_MS);
}

function isServerFull(serverId) {
  const cap = serverCapacityCache.get(serverId);
  if (!cap) return false;
  if (!cap.maxPlayers || cap.maxPlayers === 0) return false;
  return cap.playing >= cap.maxPlayers;
}

function addDonation(entry) {
  donationStore.unshift(entry);
  if (donationStore.length > MAX_DONATIONS) donationStore.length = MAX_DONATIONS;

  const payload = JSON.stringify({ type: "donation", donation: entry });
  for (const ws of donationSubscribers.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }

  setTimeout(() => {
    const idx = donationStore.findIndex(d => d.id === entry.id);
    if (idx !== -1) donationStore.splice(idx, 1);
  }, DONATION_TTL_MS);
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
      const res = await fetch(url, { ...opts, headers: { ...robloxHeaders(), ...(opts.headers || {}) } });
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
    const res = await apiFetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=${size}&format=Png&isCircular=false`);
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
    const userPlaceId = String(p.rootPlaceId || p.placeId || "");
    const inThisGame = inGame && (userPlaceId === String(placeId) || String(p.universeId) === String(DEFAULT_UNIVERSE_ID));
    return {
      type: p.userPresenceType === 0 ? "offline" : p.userPresenceType === 1 ? "online" : p.userPresenceType === 2 ? "ingame" : "unknown",
      inGame, inThisGame,
      gameId: p.gameId || null,
      placeId: userPlaceId
    };
  } catch { return { type: "unknown", inGame: false, inThisGame: false, gameId: null }; }
}

async function checkPresenceForJoinFull(username) {
  try {
    const { userId } = await resolveUser(username);
    if (!userId || !ROBLOSECURITY) return null;
    const res = await apiFetch("https://presence.roblox.com/v1/presence/users", {
      method: "POST",
      body: JSON.stringify({ userIds: [Number(userId)] })
    });
    const data = await res.json();
    const p = data?.userPresences?.[0];
    if (!p || p.userPresenceType !== 2) return null;
    const userPlaceId = String(p.rootPlaceId || p.placeId || "");
    const inThisGame = userPlaceId === String(DEFAULT_PLACE_ID) || String(p.universeId) === String(DEFAULT_UNIVERSE_ID);
    if (inThisGame && p.gameId) return { gameId: p.gameId, placeId: userPlaceId };
    return null;
  } catch { return null; }
}

async function refreshServerCapacity(serverId) {
  try {
    const url = new URL(`https://games.roblox.com/v1/games/${DEFAULT_PLACE_ID}/servers/Public`);
    url.searchParams.set("sortOrder", "Asc");
    url.searchParams.set("limit", "100");
    const res = await apiFetch(url.toString());
    if (!res.ok) return;
    const data = await res.json();
    for (const s of data.data || []) {
      if (s.id && s.maxPlayers != null) {
        setServerCapacity(s.id, s.playing || 0, s.maxPlayers);
      }
    }
  } catch {}
}

async function batchMatchServer(server, targetUserId, thumbnailUrls) {
  if (!server.playerTokens?.length) return null;
  if (server.maxPlayers != null) {
    setServerCapacity(server.id, server.playing || 0, server.maxPlayers);
  }
  const tokens = server.playerTokens.slice(0, 100);
  const tokenMap = new Map();
  const batchRequests = tokens.map((token, idx) => {
    const requestId = `req_${idx}_${token}`;
    tokenMap.set(requestId, token);
    return { requestId, token, type: "AvatarHeadShot", size: "48x48", format: "png", isCircular: false };
  });
  try {
    const res = await fetch("https://thumbnails.roblox.com/v1/batch", { method: "POST", headers: robloxHeaders(), body: JSON.stringify(batchRequests) });
    if (!res.ok) return null;
    const data = await res.json();
    for (const entry of data.data || []) {
      if (!entry || !entry.requestId) continue;
      const token = tokenMap.get(entry.requestId);
      if (!token) continue;
      if (entry.imageUrl) {
        for (const thumb of thumbnailUrls) {
          if (thumb && entry.imageUrl === thumb) return { serverId: server.id, matchType: "thumbnail", playing: server.playing, maxPlayers: server.maxPlayers };
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
  const servers = (data.data || []).filter(s => {
    if (!s.playerTokens?.length) return false;
    if (!s.maxPlayers) return true;
    return (s.playing / s.maxPlayers) >= MIN_CAPACITY_RATIO;
  });
  for (const s of servers) {
    if (s.id && s.maxPlayers != null) {
      setServerCapacity(s.id, s.playing || 0, s.maxPlayers);
    }
  }
  return { servers, nextCursor: data.nextPageCursor || null };
}

async function deepSnipe(job, userId, thumbnailUrls, placeId, workerCount, onStep) {
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
        const step = `Scanning servers... (${seen} checked)`;
        if (onStep) onStep(step);
        job.step = step;
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

async function runSearchWS(ws, username, placeId, instanceCount) {
  const send = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
  const job = { cancelled: false, step: "Starting..." };

  ws.on("close", () => { job.cancelled = true; });

  try {
    send({ status: "update", msg: `Resolving ${username}...` });
    const { userId, displayName } = await resolveUser(username);
    if (!userId) {
      send({ status: "done", result: "not_found", msg: `User "${username}" does not exist` });
      return;
    }

    const [thumb150, thumb48, thumb720] = await Promise.all([
      resolveHeadshot(userId, "150x150"),
      resolveHeadshot(userId, "48x48"),
      resolveHeadshot(userId, "720x720")
    ]);

    if (job.cancelled) return;
    send({ status: "update", msg: "Checking presence..." });

    const presence = await getPresenceStatus(userId, placeId);
    if (presence.type === "offline") {
      send({ status: "done", result: "not_found", msg: `${displayName} is offline` });
      return;
    }
    if (presence.type === "online") {
      send({ status: "done", result: "not_found", msg: `${displayName} is on website, not in-game` });
      return;
    }
    if (presence.inGame && presence.gameId && presence.inThisGame) {
      const cap = serverCapacityCache.get(presence.gameId);
      send({
        status: "done",
        result: "found",
        data: {
          serverId: presence.gameId,
          placeId: String(placeId),
          userId: String(userId),
          displayName,
          thumbnailUrl: thumb150,
          matchType: "presence",
          players: cap ? `${cap.playing}/${cap.maxPlayers}` : "?",
          placename: "PLS DONATE 💸",
          serverFull: cap ? isServerFull(presence.gameId) : false
        }
      });
      return;
    }

    if (job.cancelled) return;
    send({ status: "update", msg: `Deep scanning with ${instanceCount} workers...` });

    const onStep = (msg) => {
      if (!job.cancelled) send({ status: "update", msg });
    };

    const result = await deepSnipe(job, userId, [thumb48, thumb720], placeId, instanceCount, onStep);
    if (job.cancelled) return;

    if (result) {
      if (result.playing != null && result.maxPlayers != null) {
        setServerCapacity(result.serverId, result.playing, result.maxPlayers);
      }
      send({
        status: "done",
        result: "found",
        data: {
          serverId: result.serverId,
          placeId: String(placeId),
          userId: String(userId),
          displayName,
          thumbnailUrl: thumb150,
          matchType: result.matchType,
          players: result.playing != null ? `${result.playing}/${result.maxPlayers}` : "?",
          placename: "PLS DONATE 💸",
          serverFull: isServerFull(result.serverId)
        }
      });
    } else {
      const finalPresence = await getPresenceStatus(userId, placeId);
      const privateGuess = finalPresence.inGame && finalPresence.inThisGame;
      send({
        status: "done",
        result: "not_found",
        msg: privateGuess ? "Player is likely in a private server" : "Player not found in any public server",
        possiblePrivate: privateGuess
      });
    }
  } catch (err) {
    if (!job.cancelled) {
      send({ status: "error", msg: "Internal error: " + err.message });
    }
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
        if (s.id && s.maxPlayers != null) setServerCapacity(s.id, s.playing || 0, s.maxPlayers);
        const batchRequests = tokens.map(t => ({ requestId: `0:${t}:AvatarHeadShot:48x48:png:regular`, token: t, type: "AvatarHeadShot", size: "48x48", format: "png", isCircular: false }));
        try {
          const res = await fetch("https://thumbnails.roblox.com/v1/batch", { method: "POST", headers: robloxHeaders(), body: JSON.stringify(batchRequests) });
          const data = await res.json();
          const thumbs = {};
          for (const e of data.data || []) { if (e.token) thumbs[e.token] = e.imageUrl; }
          enriched.push({ id: s.id, playing: s.playing, maxPlayers: s.maxPlayers, playerTokens: s.playerTokens, thumbnails: thumbs, isFull: s.maxPlayers > 0 && s.playing >= s.maxPlayers });
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

app.post("/donation", async (req, res) => {
  const { secret, donor, receiver, robux } = req.body;
  if (secret !== DONATION_SECRET) return res.status(403).json({ ok: false, message: "Forbidden" });
  if (!donor || !receiver || !robux) return res.status(400).json({ ok: false, message: "Missing fields" });
  const amount = parseInt(String(robux).replace(/,/g, ""), 10);
  if (isNaN(amount) || amount < 1000) return res.status(400).json({ ok: false, message: "Amount must be 1000 or above" });
  const entry = { donor: String(donor), receiver: String(receiver), robux: amount, id: randomUUID(), ts: Date.now(), serverId: null, placeId: null, joinTarget: null, serverFull: false, serverPlaying: null, serverMaxPlayers: null };
  addDonation(entry);
  res.json({ ok: true });
  if (ROBLOSECURITY) {
    try {
      const [donorResult, receiverResult] = await Promise.all([checkPresenceForJoinFull(donor), checkPresenceForJoinFull(receiver)]);
      const found = donorResult || receiverResult;
      const target = donorResult ? donor : receiverResult ? receiver : null;
      if (found && target) {
        entry.serverId = found.gameId;
        entry.placeId = found.placeId;
        entry.joinTarget = target;
        const cap = serverCapacityCache.get(found.gameId);
        if (cap) {
          entry.serverPlaying = cap.playing;
          entry.serverMaxPlayers = cap.maxPlayers;
          entry.serverFull = cap.maxPlayers > 0 && cap.playing >= cap.maxPlayers;
        } else {
          await refreshServerCapacity(found.gameId);
          const cap2 = serverCapacityCache.get(found.gameId);
          if (cap2) {
            entry.serverPlaying = cap2.playing;
            entry.serverMaxPlayers = cap2.maxPlayers;
            entry.serverFull = cap2.maxPlayers > 0 && cap2.playing >= cap2.maxPlayers;
          }
        }
        const updatedPayload = JSON.stringify({ type: "donation_update", donation: entry });
        for (const ws of donationSubscribers.values()) {
          if (ws.readyState === WebSocket.OPEN) ws.send(updatedPayload);
        }
        setTimeout(() => { entry.serverId = null; entry.placeId = null; entry.joinTarget = null; entry.serverFull = false; }, SERVER_ID_TTL_MS);
      }
    } catch {}
  }
});

app.get("/donations", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), MAX_DONATIONS);
  const includeFullServers = req.query.includeFull === "1";
  let filtered = donationStore;
  if (!includeFullServers) filtered = donationStore.filter(d => !d.serverFull);
  res.json({ ok: true, count: Math.min(limit, filtered.length), donations: filtered.slice(0, limit) });
});

app.get("/donations/latest", (req, res) => {
  const includeFullServers = req.query.includeFull === "1";
  const filtered = includeFullServers ? donationStore : donationStore.filter(d => !d.serverFull);
  if (!filtered.length) return res.json({ ok: true, donation: null });
  res.json({ ok: true, donation: filtered[0] });
});

app.get("/donation/:id", (req, res) => {
  const entry = donationStore.find(d => d.id === req.params.id);
  if (!entry) return res.status(404).json({ ok: false });
  res.json({ ok: true, donation: entry });
});

app.get("/server-capacity/:serverId", (req, res) => {
  const cap = serverCapacityCache.get(req.params.serverId);
  if (!cap) return res.json({ ok: false, message: "Not cached" });
  res.json({ ok: true, serverId: req.params.serverId, playing: cap.playing, maxPlayers: cap.maxPlayers, isFull: cap.maxPlayers > 0 && cap.playing >= cap.maxPlayers, ts: cap.ts });
});

app.get("/live-servers", (req, res) => res.json(Array.from(liveDataCache.values())));

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
  startLiveBroadcast();
});

setInterval(() => { fetch(`http://localhost:${PORT}/`).catch(() => {}); }, 14 * 60 * 1000);

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://localhost`);
  const path = url.pathname;

  if (path === "/live") {
    const id = randomUUID();
    liveSubscribers.set(id, ws);
    if (liveDataCache.size) ws.send(JSON.stringify(Array.from(liveDataCache.values())));
    ws.on("close", () => liveSubscribers.delete(id));
    ws.on("error", () => liveSubscribers.delete(id));
    return;
  }

  if (path === "/donations/live") {
    const id = randomUUID();
    donationSubscribers.set(id, ws);
    const recent = donationStore.slice(0, 20);
    if (recent.length) ws.send(JSON.stringify({ type: "history", donations: recent }));
    ws.on("close", () => donationSubscribers.delete(id));
    ws.on("error", () => donationSubscribers.delete(id));
    return;
  }

  if (path === "/sniper") {
    const username = url.searchParams.get("username");
    const placeId = url.searchParams.get("placeId") || DEFAULT_PLACE_ID;
    const instanceCount = Math.min(Math.max(parseInt(url.searchParams.get("instances") || "1"), 1), MAX_WORKERS);

    ws.send(JSON.stringify({ status: "connected" }));

    ws.once("message", async (raw) => {
      let payload;
      try { payload = JSON.parse(raw); } catch { ws.close(); return; }
      const targetUsername = payload.username || username;
      const targetPlaceId = payload.placeId || placeId;
      const targetInstances = Math.min(Math.max(parseInt(payload.instances || instanceCount), 1), MAX_WORKERS);
      if (!targetUsername) { ws.send(JSON.stringify({ status: "error", msg: "Missing username" })); ws.close(); return; }
      await runSearchWS(ws, targetUsername, targetPlaceId, targetInstances);
      if (ws.readyState === WebSocket.OPEN) ws.close();
    });

    return;
  }

  ws.close();
});
