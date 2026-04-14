const express = require("express");
const fetch = require("node-fetch");
const { randomUUID } = require("crypto");
const WebSocket = require("ws");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ROBLOSECURITY = process.env.ROBLOSECURITY || "";
const DEFAULT_UNIVERSE_ID = process.env.UNIVERSE_ID || "3317679266";
const DEFAULT_PLACE_ID = process.env.PLACE_ID || "8737602449";
const ALL_PLACE_IDS = [
  "8737602449",
  "8943844393",
  "8943846005",
  "15611066348",
  "130598004097945"
];
const MIN_CAPACITY_RATIO = parseFloat(process.env.MIN_CAPACITY_RATIO || "0.0");
const MAX_WORKERS = parseInt(process.env.MAX_WORKERS || "12");
const JOB_TTL_MS = 20 * 60 * 1000;
const DONATION_SECRET = process.env.DONATION_SECRET || "phonktobiboy!";
const MAX_DONATIONS = 200;
const DONATION_TTL_MS = 5 * 60 * 1000;
const SERVER_ID_TTL_MS = 30 * 1000;
const SERVER_CAPACITY_TTL_MS = 60 * 1000;
const PRESENCE_CACHE_TTL_MS = 15 * 1000;
const ENRICHMENT_RETRIES = 5;
const ENRICHMENT_RETRY_BASE_DELAY = 1200;
const AUTH_KEY_TTL_MS = 30 * 1000;

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_KEY || ""
);

async function hasPlayerJoined(username) {
  try {
    const { data, error } = await supabase
      .rpc("has_player_joined", { p_username: username.toLowerCase() });
    if (error) { console.error("[supabase] hasPlayerJoined error:", error.message); return false; }
    return data === true;
  } catch (e) {
    console.error("[supabase] hasPlayerJoined exception:", e.message);
    return false;
  }
}

async function markPlayerJoined(username, userId) {
  try {
    const { error } = await supabase
      .rpc("upsert_joined_player", {
        p_username: username.toLowerCase(),
        p_user_id: parseInt(userId) || 0
      });
    if (error) console.error("[supabase] markPlayerJoined error:", error.message);
  } catch (e) {
    console.error("[supabase] markPlayerJoined exception:", e.message);
  }
}

async function incrementRaise(userId, username, amount) {
  try {
    const { error } = await supabase
      .rpc("increment_raise", {
        p_user_id: parseInt(userId),
        p_username: username,
        p_amount: Math.floor(amount)
      });
    if (error) console.error("[supabase] incrementRaise error:", error.message);
    else console.log(`[supabase] raise +${amount} for ${username} (${userId})`);
  } catch (e) {
    console.error("[supabase] incrementRaise exception:", e.message);
  }
}

async function getTopRaisers(limit = 10) {
  try {
    const { data, error } = await supabase
      .from("top_raisers")
      .select("user_id, username, raise_amount")
      .order("raise_amount", { ascending: false })
      .limit(limit);
    if (error) { console.error("[supabase] getTopRaisers error:", error.message); return []; }
    return data || [];
  } catch (e) {
    console.error("[supabase] getTopRaisers exception:", e.message);
    return [];
  }
}

const jobs = new Map();
const liveSubscribers = new Map();
const liveDataCache = new Map();
const serverCapacityCache = new Map();
let liveBroadcastInterval = null;
const donationStore = [];
const donationSubscribers = new Map();
const presenceCache = new Map();
const pendingEnrichment = new Map();
const enrichmentInFlight = new Set();
const authKeys = new Map();
const subscriptionSockets = new Map();

function setServerCapacity(serverId, playing, maxPlayers) {
  serverCapacityCache.set(serverId, { playing, maxPlayers, ts: Date.now() });
  setTimeout(() => serverCapacityCache.delete(serverId), SERVER_CAPACITY_TTL_MS);
}

function isServerFull(serverId) {
  const cap = serverCapacityCache.get(serverId);
  if (!cap || !cap.maxPlayers) return false;
  return cap.playing >= cap.maxPlayers;
}

function addDonation(entry) {
  console.log(`[donation] ${entry.donor} -> ${entry.receiver} ${entry.robux}R$`);
  donationStore.unshift(entry);
  if (donationStore.length > MAX_DONATIONS) donationStore.length = MAX_DONATIONS;

  const payload = JSON.stringify({ type: "donation", donation: entry });
  for (const ws of donationSubscribers.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }

  setTimeout(() => {
    const idx = donationStore.findIndex(d => d.id === entry.id);
    if (idx !== -1) donationStore.splice(idx, 1);
    pendingEnrichment.delete(entry.id);
    enrichmentInFlight.delete(entry.id);
  }, DONATION_TTL_MS);
}

function updateDonationWithServer(entry, gameId, placeId, targetUsername) {
  entry.serverId = gameId;
  entry.placeId = placeId;
  entry.joinTarget = targetUsername;

  const cap = serverCapacityCache.get(gameId);
  if (cap) {
    entry.serverPlaying = cap.playing;
    entry.serverMaxPlayers = cap.maxPlayers;
    entry.serverFull = cap.maxPlayers > 0 && cap.playing >= cap.maxPlayers;
  }

  console.log(`[donation] serverId:${gameId} joinTarget:${targetUsername} for ${entry.id}`);

  const updatedPayload = JSON.stringify({ type: "donation_update", donation: entry });
  for (const ws of donationSubscribers.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(updatedPayload);
  }

  setTimeout(() => {
    entry.serverId = null;
    entry.placeId = null;
    entry.joinTarget = null;
    entry.serverFull = false;
  }, SERVER_ID_TTL_MS);
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
    const inThisGame = inGame && (ALL_PLACE_IDS.includes(userPlaceId) || String(p.universeId) === String(DEFAULT_UNIVERSE_ID));
    const typeMap = { 0: "offline", 1: "online", 2: "ingame" };
    return {
      type: typeMap[p.userPresenceType] || "unknown",
      inGame,
      inThisGame,
      gameId: p.gameId || null,
      placeId: userPlaceId
    };
  } catch { return { type: "unknown", inGame: false, inThisGame: false, gameId: null }; }
}

async function checkPresenceForJoinFull(username) {
  try {
    const { userId } = await resolveUser(username);
    if (!userId || !ROBLOSECURITY) return null;

    const cacheKey = `presence:${userId}`;
    const cached = presenceCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < PRESENCE_CACHE_TTL_MS) return cached.data;

    const res = await apiFetch("https://presence.roblox.com/v1/presence/users", {
      method: "POST",
      body: JSON.stringify({ userIds: [Number(userId)] })
    });
    const data = await res.json();
    const p = data?.userPresences?.[0];
    if (!p || p.userPresenceType !== 2) {
      presenceCache.set(cacheKey, { data: null, ts: Date.now() });
      return null;
    }
    const userPlaceId = String(p.rootPlaceId || p.placeId || "");
    const inThisGame = ALL_PLACE_IDS.includes(userPlaceId) || String(p.universeId) === String(DEFAULT_UNIVERSE_ID);
    const result = (inThisGame && p.gameId) ? { gameId: p.gameId, placeId: userPlaceId } : null;
    presenceCache.set(cacheKey, { data: result, ts: Date.now() });
    return result;
  } catch { return null; }
}

async function batchMatchServer(server, targetUserId, thumbnailUrls) {
  if (!server.playerTokens?.length) return null;
  if (server.maxPlayers != null) setServerCapacity(server.id, server.playing || 0, server.maxPlayers);

  const tokens = server.playerTokens.slice(0, 100);
  const tokenMap = new Map();
  const batchRequests = tokens.map((token, idx) => {
    const requestId = `req_${idx}_${token}`;
    tokenMap.set(requestId, token);
    return { requestId, token, type: "AvatarHeadShot", size: "48x48", format: "png", isCircular: false };
  });

  try {
    const res = await fetch("https://thumbnails.roblox.com/v1/batch", {
      method: "POST",
      headers: robloxHeaders(),
      body: JSON.stringify(batchRequests)
    });
    if (!res.ok) return null;
    const data = await res.json();
    for (const entry of data.data || []) {
      if (!entry?.requestId) continue;
      const token = tokenMap.get(entry.requestId);
      if (!token) continue;
      if (entry.imageUrl && thumbnailUrls.some(t => t && entry.imageUrl === t)) {
        return { serverId: server.id, matchType: "thumbnail", playing: server.playing, maxPlayers: server.maxPlayers, placeId: server._placeId };
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
  const servers = (data.data || [])
    .filter(s => s.playerTokens?.length && (!s.maxPlayers || (s.playing / s.maxPlayers) >= MIN_CAPACITY_RATIO))
    .map(s => ({ ...s, _placeId: String(placeId) }));
  for (const s of servers) {
    if (s.id && s.maxPlayers != null) setServerCapacity(s.id, s.playing || 0, s.maxPlayers);
  }
  return { servers, nextCursor: data.nextPageCursor || null };
}

async function fetchServersPageAllPlaces(sortOrder, limit, cursors = {}) {
  const results = await Promise.allSettled(
    ALL_PLACE_IDS.map(pid => fetchServersPage(pid, sortOrder, limit, cursors[pid] || null))
  );
  const servers = [];
  const nextCursors = {};
  results.forEach((r, i) => {
    const pid = ALL_PLACE_IDS[i];
    if (r.status === "fulfilled") {
      servers.push(...r.value.servers);
      if (r.value.nextCursor) nextCursors[pid] = r.value.nextCursor;
    }
  });
  return { servers, nextCursors };
}

async function deepSnipe(job, userId, thumbnailUrls, placeId, workerCount, onStep) {
  const targetPlaceIds = placeId && placeId !== DEFAULT_PLACE_ID ? [String(placeId)] : ALL_PLACE_IDS;
  const found = { value: false, result: null };
  const serverQueue = [];
  let queueResolve = null;
  let fetchersFinished = 0;
  const totalFetchers = workerCount * 2;
  const sortOrders = ["Asc", "Desc"];
  const limits = [100, 50];
  const maxPages = 15;

  const notifyQueue = () => {
    if (queueResolve) { const r = queueResolve; queueResolve = null; r(); }
  };

  const fetcher = async (startCursor, sortOrder, limit, targetPid, workerId) => {
    let cursor = startCursor;
    let pages = 0, seen = 0;
    while (!found.value && !job.cancelled && pages < maxPages) {
      try {
        const { servers, nextCursor } = await fetchServersPage(targetPid, sortOrder, limit, cursor);
        seen += servers.length;
        pages++;
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
      if (!serverQueue.length) {
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

  const perPlace = Math.max(1, Math.floor(totalFetchers / targetPlaceIds.length));
  const workers = [];
  let workerId = 1;

  for (const pid of targetPlaceIds) {
    for (const sort of sortOrders) {
      for (const limit of limits) {
        const perCombo = Math.max(1, Math.floor(perPlace / (sortOrders.length * limits.length)));
        for (let i = 0; i < perCombo; i++) {
          if (workers.length >= totalFetchers) break;
          workers.push(fetcher(null, sort, limit, pid, workerId++));
        }
      }
    }
  }
  while (workers.length < totalFetchers) {
    const pid = targetPlaceIds[workers.length % targetPlaceIds.length];
    workers.push(fetcher(null, "Asc", 100, pid, workerId++));
  }

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
      const foundPlaceId = presence.placeId || String(placeId);
      send({
        status: "done",
        result: "found",
        data: {
          serverId: presence.gameId,
          placeId: foundPlaceId,
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
    send({ status: "update", msg: `Deep scanning ${ALL_PLACE_IDS.length} places with ${instanceCount} workers...` });

    const result = await deepSnipe(job, userId, [thumb48, thumb720], placeId, instanceCount, (msg) => {
      if (!job.cancelled) send({ status: "update", msg });
    });

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
          placeId: result.placeId || String(placeId),
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
    if (!job.cancelled) send({ status: "error", msg: "Internal error: " + err.message });
  }
}

function startLiveBroadcast() {
  if (liveBroadcastInterval) return;
  liveBroadcastInterval = setInterval(async () => {
    if (!liveSubscribers.size) return;
    try {
      const allServers = [];
      await Promise.allSettled(ALL_PLACE_IDS.map(async (pid) => {
        const { servers } = await fetchServersPage(pid, "Desc", 100);
        allServers.push(...servers);
      }));

      allServers.sort((a, b) => (b.playing || 0) - (a.playing || 0));

      const enriched = [];
      for (const s of allServers.slice(0, 30)) {
        const tokens = s.playerTokens.slice(0, 10);
        if (!tokens.length) continue;
        if (s.id && s.maxPlayers != null) setServerCapacity(s.id, s.playing || 0, s.maxPlayers);
        const batchRequests = tokens.map(t => ({
          requestId: `0:${t}:AvatarHeadShot:48x48:png:regular`,
          token: t,
          type: "AvatarHeadShot",
          size: "48x48",
          format: "png",
          isCircular: false
        }));
        try {
          const res = await fetch("https://thumbnails.roblox.com/v1/batch", {
            method: "POST",
            headers: robloxHeaders(),
            body: JSON.stringify(batchRequests)
          });
          const data = await res.json();
          const thumbs = {};
          for (const e of data.data || []) { if (e.token) thumbs[e.token] = e.imageUrl; }
          enriched.push({
            id: s.id,
            playing: s.playing,
            maxPlayers: s.maxPlayers,
            playerTokens: s.playerTokens,
            thumbnails: thumbs,
            isFull: s.maxPlayers > 0 && s.playing >= s.maxPlayers,
            placeId: s._placeId
          });
        } catch {}
      }

      liveDataCache.clear();
      enriched.forEach(s => liveDataCache.set(s.id, s));
      const payload = JSON.stringify(Array.from(liveDataCache.values()));
      for (const ws of liveSubscribers.values()) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      }
    } catch {}
  }, 5000);
}

function buildLiveChannelData() {
  const result = {};
  for (const [serverId, cached] of liveDataCache.entries()) {
    const donation = donationStore.find(d => d.serverId === serverId);
    result[serverId] = {
      serverId,
      placeId: cached.placeId || DEFAULT_PLACE_ID,
      placename: donation ? `PLS DONATE 💸 ${donation.donor} → ${donation.receiver}` : "PLS DONATE 💸",
      players: `${cached.playing}/${cached.maxPlayers}`,
      fps: "60",
      ping: "25",
      Robux: donation ? donation.robux : "?",
      Donator: donation ? donation.donor : "",
      Receiver: donation ? donation.receiver : "",
      Donatorimg: donation ? `https://www.roblox.com/headshot-thumbnail/image?userId=${donation.donorId || 0}&width=48&height=48&format=png` : "",
      Receiverimg: donation ? `https://www.roblox.com/headshot-thumbnail/image?userId=${donation.receiverId || 0}&width=48&height=48&format=png` : "",
      Timestamp: Date.now()
    };
  }
  return result;
}

async function enrichDonationWithRetries(entry, targetUsername) {
  if (enrichmentInFlight.has(entry.id)) return;
  enrichmentInFlight.add(entry.id);

  try {
    for (let attempt = 0; attempt < ENRICHMENT_RETRIES; attempt++) {
      if (!pendingEnrichment.has(entry.id)) return;
      const found = await checkPresenceForJoinFull(targetUsername);
      if (found) {
        updateDonationWithServer(entry, found.gameId, found.placeId, targetUsername);
        pendingEnrichment.delete(entry.id);
        return;
      }
      if (attempt < ENRICHMENT_RETRIES - 1) {
        await sleep(ENRICHMENT_RETRY_BASE_DELAY * Math.pow(2, attempt));
      }
    }
    console.log(`[donation] enrichment failed for ${entry.id} after ${ENRICHMENT_RETRIES} attempts`);
    pendingEnrichment.delete(entry.id);
  } finally {
    enrichmentInFlight.delete(entry.id);
  }
}

async function processPendingEnrichments() {
  const entries = Array.from(pendingEnrichment.values()).filter(({ entry }) => !enrichmentInFlight.has(entry.id));
  if (!entries.length) return;
  for (let i = 0; i < entries.length; i += 10) {
    await Promise.allSettled(entries.slice(i, i + 10).map(({ entry, target }) => enrichDonationWithRetries(entry, target)));
  }
}

setInterval(processPendingEnrichments, 2000);

app.post("/player-joined", async (req, res) => {
  const { secret, username, userId } = req.body;
  if (secret !== DONATION_SECRET) return res.status(403).json({ ok: false });
  if (!username || !userId) return res.status(400).json({ ok: false, message: "Missing fields" });
  await markPlayerJoined(String(username), String(userId));
  res.json({ ok: true });
});

app.post("/has-joined", async (req, res) => {
  const { secret, username } = req.body;
  if (secret !== DONATION_SECRET) return res.status(403).json({ ok: false });
  if (!username) return res.status(400).json({ ok: false });
  const joined = await hasPlayerJoined(String(username));
  res.json({ ok: true, joined });
});

app.get("/top-raisers", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "10", 10), 100);
  const raisers = await getTopRaisers(limit);
  res.json({ ok: true, raisers });
});

app.get("/", (req, res) => res.json({ status: "ok", activeJobs: jobs.size, donations: donationStore.length }));

app.get("/api/livechannelstatus", (req, res) => {
  const count = liveDataCache.size;
  res.json({ ok: true, count, status: count > 0 ? 200 : 204 });
});

app.post("/donation", async (req, res) => {
  const { secret, donor, receiver, robux } = req.body;
  if (secret !== DONATION_SECRET) return res.status(403).json({ ok: false, message: "Forbidden" });
  if (!donor || !receiver || !robux) return res.status(400).json({ ok: false, message: "Missing fields" });
  const amount = parseInt(String(robux).replace(/,/g, ""), 10);
  if (isNaN(amount) || amount < 1000) return res.status(400).json({ ok: false, message: "Amount must be 1000 or above" });

  const entry = {
    donor: String(donor),
    receiver: String(receiver),
    robux: amount,
    id: randomUUID(),
    ts: Date.now(),
    serverId: null,
    placeId: null,
    joinTarget: null,
    serverFull: false,
    serverPlaying: null,
    serverMaxPlayers: null
  };
  addDonation(entry);
  res.json({ ok: true });

  Promise.allSettled([resolveUser(donor), resolveUser(receiver)]).then(([donorRes, receiverRes]) => {
    if (donorRes.status === "fulfilled" && donorRes.value.userId) entry.donorId = donorRes.value.userId;
    if (receiverRes.status === "fulfilled" && receiverRes.value.userId) {
      entry.receiverId = receiverRes.value.userId;
      hasPlayerJoined(receiver).then(joined => {
        if (joined && entry.receiverId) incrementRaise(entry.receiverId, receiver, Math.floor(amount * 0.6));
      });
    }
  });

  if (ROBLOSECURITY) {
    const results = await Promise.allSettled([
      checkPresenceForJoinFull(donor),
      checkPresenceForJoinFull(receiver)
    ]);
    const donorResult = results[0].status === "fulfilled" ? results[0].value : null;
    const receiverResult = results[1].status === "fulfilled" ? results[1].value : null;
    const found = donorResult || receiverResult;
    const target = donorResult ? donor : receiverResult ? receiver : null;

    if (found && target) {
      updateDonationWithServer(entry, found.gameId, found.placeId, target);
    } else {
      pendingEnrichment.set(entry.id, { entry, target: donorResult ? donor : receiver, addedAt: Date.now() });
    }
  }
});

app.get("/donations", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), MAX_DONATIONS);
  const includeFullServers = req.query.includeFull === "1";
  const filtered = includeFullServers ? donationStore : donationStore.filter(d => !d.serverFull);
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
  res.json({
    ok: true,
    serverId: req.params.serverId,
    playing: cap.playing,
    maxPlayers: cap.maxPlayers,
    isFull: cap.maxPlayers > 0 && cap.playing >= cap.maxPlayers,
    ts: cap.ts
  });
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
  jobs.set(jobId, {
    status: "running",
    step: "Starting...",
    result: null,
    startedAt: Date.now(),
    cancelled: false,
    userId: null,
    placeId: placeId || DEFAULT_PLACE_ID
  });
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
  job.cancelled = true;
  job.status = "done";
  job.result = { found: false, message: "Cancelled" };
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

  if (path === "/livechannel") {
    const authkey = url.searchParams.get("authkey");
    if (!authkey || !authKeys.has(authkey)) { ws.close(1008, "Unauthorized"); return; }
    const auth = authKeys.get(authkey);
    auth.ts = Date.now();
    const id = randomUUID();
    liveSubscribers.set(id, ws);
    const data = buildLiveChannelData();
    if (Object.keys(data).length) ws.send(JSON.stringify(data));
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

  if (path === "/api/subscriptionstatus") {
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.DiscordID) {
          const authkey = randomUUID();
          const expiry = Math.floor(Date.now() / 1000) + 86400;
          authKeys.set(authkey, { discord: msg.DiscordID, instances: msg.Instances || 1, ts: Date.now(), expiry });
          subscriptionSockets.set(msg.DiscordID, ws);
          ws.send(JSON.stringify({ expiry, ws_key: authkey, ip: req.socket.remoteAddress, sharing: false }));
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ expiry: Math.floor(Date.now() / 1000) + 86400 }));
          }, 30000);
        }
      } catch {}
    });
    ws.on("close", () => {
      for (const [discord, sock] of subscriptionSockets.entries()) {
        if (sock === ws) subscriptionSockets.delete(discord);
      }
    });
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

setInterval(() => {
  const now = Date.now();
  for (const [key, data] of authKeys.entries()) {
    if (now - data.ts > AUTH_KEY_TTL_MS) authKeys.delete(key);
  }
}, 5000);

setInterval(() => {
  const liveChannelData = buildLiveChannelData();
  const payload = JSON.stringify(liveChannelData);
  for (const ws of liveSubscribers.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}, 2000);
