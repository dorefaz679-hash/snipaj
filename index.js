const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ROBLOSECURITY = process.env.ROBLOSECURITY || "";
const PLACE_ID = process.env.PLACE_ID || "8737602449";

if (!ROBLOSECURITY) console.warn("[sniper] WARNING: ROBLOSECURITY not set");

// wave 1: pages 1-10
// wave 2: pages 11-50 (40 more pages)
// wave 3: pages 51-999 (exhaustive)
const WAVES = [
    { label: "Wave 1", startPage: 1,  endPage: 10,  concurrency: 20 },
    { label: "Wave 2", startPage: 11, endPage: 50,  concurrency: 30 },
    { label: "Wave 3", startPage: 51, endPage: 999, concurrency: 40 },
];

// ── Priority Queue ─────────────────────────────────────────────────────────

const queue = [];
let processing = false;

function enqueue(job) {
    return new Promise((resolve, reject) => {
        queue.push({ ...job, resolve, reject });
        queue.sort((a, b) => a.priority - b.priority);
        console.log(`[queue] enqueued | priority: ${job.priority} | length: ${queue.length}`);
        processNext();
    });
}

async function processNext() {
    if (processing || queue.length === 0) return;
    processing = true;
    const job = queue.shift();
    console.log(`[queue] processing | username: ${job.username} | remaining: ${queue.length}`);
    try {
        job.resolve(await runSearch(job.username, job.placeId));
    } catch (err) {
        console.error("[queue] error:", err);
        job.reject(err);
    } finally {
        processing = false;
        processNext();
    }
}

// ── Routes ─────────────────────────────────────────────────────────────────

app.get("/", (req, res) => res.json({ status: "ok", queueLength: queue.length, processing }));

app.get("/queue", (req, res) => res.json({
    queueLength: queue.length,
    processing,
    jobs: queue.map((j, i) => ({ position: i + 1, username: j.username, priority: j.priority })),
}));

app.post("/resolve", async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ ok: false, message: "Missing username" });
    try {
        const { userId, displayName } = await resolveUser(username);
        if (!userId) return res.json({ ok: false, message: `User "${username}" does not exist` });
        const thumbnailUrl = await resolveHeadshot(userId);
        console.log(`[resolve] ${username} -> userId:${userId} displayName:${displayName} thumb:${thumbnailUrl ? "ok" : "empty"}`);
        res.json({ ok: true, userId: String(userId), displayName, thumbnailUrl });
    } catch (err) {
        console.error("[resolve] error:", err);
        res.status(500).json({ ok: false, message: String(err) });
    }
});

app.post("/sniper", async (req, res) => {
    const { username, placeId, priority } = req.body;
    if (!username) return res.status(400).json({ error: "Missing username" });
    console.log(`[sniper] POST | username:${username} priority:${priority || 2} queue:${queue.length}`);
    try {
        res.json(await enqueue({ username, placeId: placeId || PLACE_ID, priority: Number(priority) || 2 }));
    } catch (err) {
        res.status(500).json({ error: String(err) });
    }
});

// ── Core search ────────────────────────────────────────────────────────────

async function runSearch(username, placeId) {
    console.log(`[search] ---- start | username:${username} placeId:${placeId} ----`);

    const { userId, displayName } = await resolveUser(username);
    if (!userId) {
        console.log(`[search] user not found: ${username}`);
        return { found: false, message: `User "${username}" does not exist` };
    }
    console.log(`[search] userId:${userId} displayName:${displayName}`);

    const [thumbnailUrl, serverId] = await Promise.all([
        resolveHeadshot(userId),
        findPlayerAllWaves(userId, placeId),
    ]);

    if (serverId) {
        console.log(`[search] ---- FOUND serverId:${serverId} ----`);
        return { found: true, serverId, placeId: String(placeId), userId: String(userId), displayName, thumbnailUrl };
    }

    console.log(`[search] ---- NOT FOUND after all waves ----`);
    return { found: false, message: "Player not found in any public server" };
}

async function findPlayerAllWaves(userId, placeId) {
    // cursors are sequential — we pass the cursor from wave to wave
    let cursor = null;

    for (const wave of WAVES) {
        console.log(`[search] === ${wave.label} | pages ${wave.startPage}-${wave.endPage} ===`);

        const pagesInWave = wave.endPage - wave.startPage + 1;

        for (let i = 0; i < pagesInWave; i++) {
            const pageNum = wave.startPage + i;

            const url = `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Asc&limit=100` +
                (cursor ? `&cursor=${cursor}` : "");

            const res = await fetch(url, { headers: robloxHeaders() });

            if (res.status === 429) {
                console.warn(`[search] rate limited page ${pageNum}, waiting 3s`);
                await sleep(3000);
                i--; // retry same page
                continue;
            }

            if (!res.ok) {
                console.error(`[search] servers API ${res.status} on page ${pageNum}`);
                return null;
            }

            const data = await res.json();
            const servers = (data.data ?? []).filter(s => s.playerTokens?.length);
            console.log(`[search] ${wave.label} page ${pageNum} | servers with players: ${servers.length}`);

            if (servers.length > 0) {
                const found = await scanPage(servers, userId, wave.concurrency);
                if (found) return found;
            }

            cursor = data.nextPageCursor ?? null;
            if (!cursor) {
                console.log(`[search] no more pages after ${pageNum} — game has fewer servers than expected`);
                return null;
            }
        }

        console.log(`[search] === ${wave.label} done — not found, escalating ===`);
    }

    return null;
}

async function scanPage(servers, userId, concurrency) {
    return new Promise((resolve) => {
        let resolved = false;
        let pending = servers.length;
        let idx = 0;
        let active = 0;

        function dispatch() {
            while (active < concurrency && idx < servers.length) {
                const server = servers[idx++];
                active++;
                resolveTokens(server.playerTokens).then(ids => {
                    active--;
                    if (!resolved) {
                        if (ids.includes(userId)) {
                            resolved = true;
                            resolve(server.id);
                        } else {
                            pending--;
                            if (pending === 0) resolve(null);
                            else dispatch();
                        }
                    }
                }).catch(() => {
                    active--;
                    pending--;
                    if (!resolved && pending === 0) resolve(null);
                    else dispatch();
                });
            }
        }

        dispatch();
    });
}

// ── Roblox API helpers ─────────────────────────────────────────────────────

function robloxHeaders() {
    const h = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    };
    if (ROBLOSECURITY) h["Cookie"] = `.ROBLOSECURITY=${ROBLOSECURITY}`;
    return h;
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
    const u = data.data[0];
    return { userId: u.id, displayName: u.displayName || username };
}

async function resolveHeadshot(userId) {
    try {
        const res = await fetch(
            `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`,
            { headers: robloxHeaders() }
        );
        if (!res.ok) {
            console.warn(`[thumb] API returned ${res.status} for userId ${userId}`);
            return "";
        }
        const data = await res.json();
        const url = data?.data?.[0]?.imageUrl ?? "";
        console.log(`[thumb] userId:${userId} -> ${url ? "got url" : "empty"}`);
        return url;
    } catch (e) {
        console.warn(`[thumb] error for userId ${userId}:`, e.message);
        return "";
    }
}

async function resolveTokens(tokens) {
    if (!tokens.length) return [];
    const body = tokens.map(t => ({
        requestId: `0:${t}:AvatarHeadShot:48x48:png:regular`,
        token: t, type: "AvatarHeadShot", size: "48x48", format: "png", isCircular: false,
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.listen(PORT, () => {
    console.log(`[sniper] port:${PORT} ROBLOSECURITY:${ROBLOSECURITY ? "SET✓" : "NOT SET✗"} PLACE_ID:${PLACE_ID}`);
});
