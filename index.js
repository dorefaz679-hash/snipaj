const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ROBLOSECURITY = process.env.ROBLOSECURITY || "";
const PLACE_ID = process.env.PLACE_ID || "8737602449";
const MAX_PAGES = 20;
const PAGE_CONCURRENCY = 30;

if (!ROBLOSECURITY) {
    console.warn("[sniper] WARNING: ROBLOSECURITY not set — requests will be unauthenticated");
}

// ── Priority Queue ────────────────────────────────────────────────────────────

const queue = [];
let processing = false;

function enqueue(job) {
    return new Promise((resolve, reject) => {
        queue.push({ ...job, resolve, reject });
        queue.sort((a, b) => a.priority - b.priority);
        console.log(`[queue] enqueued | priority: ${job.priority} | queue length: ${queue.length}`);
        processNext();
    });
}

async function processNext() {
    if (processing || queue.length === 0) return;
    processing = true;
    const job = queue.shift();
    console.log(`[queue] processing | username: ${job.username} | priority: ${job.priority} | remaining: ${queue.length}`);
    try {
        const result = await runSearch(job.username, job.placeId);
        job.resolve(result);
    } catch (err) {
        console.error("[queue] job error:", err);
        job.reject(err);
    } finally {
        processing = false;
        processNext();
    }
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
    res.json({ status: "ok", queueLength: queue.length, processing });
});

app.get("/queue", (req, res) => {
    res.json({
        queueLength: queue.length,
        processing,
        jobs: queue.map((j, i) => ({ position: i + 1, username: j.username, priority: j.priority })),
    });
});

app.post("/sniper", async (req, res) => {
    const { username, placeId, priority } = req.body;
    if (!username) return res.status(400).json({ error: "Missing username" });

    const jobPriority = Number(priority) || 2;
    const jobPlaceId = placeId || PLACE_ID;
    const queuePos = queue.length + (processing ? 1 : 0);
    console.log(`[sniper] POST | username: ${username} | priority: ${jobPriority} | queue pos: ${queuePos}`);

    try {
        const result = await enqueue({ username, placeId: jobPlaceId, priority: jobPriority });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: String(err) });
    }
});

// ── Core search ───────────────────────────────────────────────────────────────

async function runSearch(username, placeId) {
    console.log(`[search] start | username: ${username} | placeId: ${placeId}`);
    const { userId, displayName } = await resolveUser(username);
    if (!userId) {
        console.log(`[search] user not found: ${username}`);
        return { found: false, message: `User "${username}" does not exist` };
    }
    console.log(`[search] resolved | userId: ${userId} | displayName: ${displayName}`);

    const [thumbnailUrl, serverId] = await Promise.all([
        resolveHeadshot(userId),
        findPlayer(userId, placeId),
    ]);

    if (serverId) {
        console.log(`[search] FOUND | serverId: ${serverId}`);
        return { found: true, serverId, placeId: String(placeId), userId: String(userId), displayName, thumbnailUrl };
    }
    console.log(`[search] not found | username: ${username}`);
    return { found: false, message: "Player not found in any public server" };
}

// ── Roblox API helpers ────────────────────────────────────────────────────────

function robloxHeaders(extra = {}) {
    const headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        ...extra,
    };
    if (ROBLOSECURITY) headers["Cookie"] = `.ROBLOSECURITY=${ROBLOSECURITY}`;
    return headers;
}

async function resolveUser(username) {
    const res = await fetch("https://users.roblox.com/v1/usernames/users", {
        method: "POST",
        headers: robloxHeaders(),
        body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
    });
    if (!res.ok) throw new Error(`Users API ${res.status}`);
    const data = await res.json();
    if (!data.data?.length) return { userId: null };
    const user = data.data[0];
    return { userId: user.id, displayName: user.displayName || username };
}

async function resolveHeadshot(userId) {
    try {
        const res = await fetch(
            `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`,
            { headers: robloxHeaders() }
        );
        if (!res.ok) return "";
        const data = await res.json();
        return data?.data?.[0]?.imageUrl ?? "";
    } catch { return ""; }
}

async function findPlayer(userId, placeId) {
    let cursor = null;
    let page = 0;

    while (page < MAX_PAGES) {
        page++;
        const url =
            `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Asc&limit=100` +
            (cursor ? `&cursor=${cursor}` : "");

        const res = await fetch(url, { headers: robloxHeaders() });

        if (res.status === 429) {
            console.warn(`[search] rate limited on page ${page}, waiting 2s`);
            await sleep(2000);
            page--;
            continue;
        }
        if (!res.ok) {
            console.error(`[search] servers API error: ${res.status} on page ${page}`);
            break;
        }

        const data = await res.json();
        const servers = (data.data ?? []).filter(s => s.playerTokens?.length);
        console.log(`[search] page ${page} | servers with players: ${servers.length}`);

        const found = await scanPageConcurrent(servers, userId);
        if (found) return found;

        cursor = data.nextPageCursor ?? null;
        if (!cursor) {
            console.log(`[search] exhausted all pages at page ${page}`);
            break;
        }
    }
    return null;
}

async function scanPageConcurrent(servers, userId) {
    return new Promise((resolve) => {
        let resolved = false;
        let pending = servers.length;
        if (pending === 0) return resolve(null);

        for (const server of servers) {
            resolveTokens(server.playerTokens).then(ids => {
                if (resolved) return;
                if (ids.includes(userId)) {
                    resolved = true;
                    return resolve(server.id);
                }
                pending--;
                if (pending === 0 && !resolved) resolve(null);
            }).catch(() => {
                pending--;
                if (pending === 0 && !resolved) resolve(null);
            });
        }
    });
}

async function resolveTokens(tokens) {
    if (!tokens.length) return [];
    const body = tokens.map(token => ({
        requestId: `0:${token}:AvatarHeadShot:48x48:png:regular`,
        token,
        type: "AvatarHeadShot",
        size: "48x48",
        format: "png",
        isCircular: false,
    }));
    try {
        const res = await fetch("https://thumbnails.roblox.com/v1/batch", {
            method: "POST",
            headers: robloxHeaders(),
            body: JSON.stringify(body),
        });
        if (!res.ok) return [];
        const data = await res.json();
        return (data.data ?? []).map(e => e.targetId).filter(Boolean);
    } catch { return []; }
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`[sniper] listening on port ${PORT}`);
    console.log(`[sniper] ROBLOSECURITY: ${ROBLOSECURITY ? "SET ✓" : "NOT SET ✗"}`);
    console.log(`[sniper] PLACE_ID: ${PLACE_ID}`);
});
