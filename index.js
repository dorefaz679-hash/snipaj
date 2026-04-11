const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ROBLOSECURITY = process.env.ROBLOSECURITY || "";
const PLACE_ID = process.env.PLACE_ID || "8737602449";
const PAGE_DELAY_MS = 300;

if (!ROBLOSECURITY) console.warn("[sniper] WARNING: ROBLOSECURITY not set");

const INSTANCE_RANGES = [
    { instance: 1, startPage: 1,   endPage: 10,  concurrency: 20, label: "Instance 1 (pages 1–10)"   },
    { instance: 2, startPage: 11,  endPage: 50,  concurrency: 30, label: "Instance 2 (pages 11–50)"  },
    { instance: 3, startPage: 51,  endPage: 150, concurrency: 40, label: "Instance 3 (pages 51–150)" },
    { instance: 4, startPage: 151, endPage: 300, concurrency: 40, label: "Instance 4 (pages 151–300)"},
    { instance: 5, startPage: 301, endPage: 999, concurrency: 40, label: "Instance 5 (pages 301–999)"},
];

const queue = [];
let processing = false;

function enqueue(job) {
    return new Promise((resolve, reject) => {
        queue.push({ ...job, resolve, reject });
        queue.sort((a, b) => a.priority - b.priority);
        console.log(`[queue] enqueued | priority:${job.priority} | instances:${job.instanceCount} | length:${queue.length}`);
        processNext();
    });
}

async function processNext() {
    if (processing || queue.length === 0) return;
    processing = true;
    const job = queue.shift();
    console.log(`[queue] processing | username:${job.username} | remaining:${queue.length}`);
    try {
        job.resolve(await runSearch(job.username, job.placeId, job.instanceCount));
    } catch (err) {
        console.error("[queue] error:", err);
        job.reject(err);
    } finally {
        processing = false;
        processNext();
    }
}

app.get("/", (req, res) => res.json({ status: "ok", queueLength: queue.length, processing }));

app.get("/queue", (req, res) => res.json({
    queueLength: queue.length,
    processing,
    jobs: queue.map((j, i) => ({ position: i + 1, username: j.username, priority: j.priority, instances: j.instanceCount })),
}));

app.post("/resolve", async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ ok: false, message: "Missing username" });
    try {
        const { userId, displayName } = await resolveUser(username);
        if (!userId) return res.json({ ok: false, message: `User "${username}" does not exist` });
        const thumbnailUrl = await resolveHeadshot(userId);
        console.log(`[resolve] ${username} -> userId:${userId} displayName:"${displayName}" thumb:${thumbnailUrl ? "ok" : "empty"}`);
        res.json({ ok: true, userId: String(userId), displayName, thumbnailUrl });
    } catch (err) {
        console.error("[resolve] error:", err);
        res.status(500).json({ ok: false, message: String(err) });
    }
});

app.post("/sniper", async (req, res) => {
    const { username, placeId, priority, instanceCount } = req.body;
    if (!username) return res.status(400).json({ error: "Missing username" });
    const instances = Math.min(Math.max(Number(instanceCount) || 1, 1), 5);
    console.log(`[sniper] POST | username:${username} priority:${priority || 2} instances:${instances} queue:${queue.length}`);
    try {
        res.json(await enqueue({
            username,
            placeId: placeId || PLACE_ID,
            priority: Number(priority) || 2,
            instanceCount: instances,
        }));
    } catch (err) {
        res.status(500).json({ error: String(err) });
    }
});

async function runSearch(username, placeId, instanceCount) {
    console.log(`[search] ==== START username:${username} placeId:${placeId} instances:${instanceCount} ====`);
    const { userId, displayName } = await resolveUser(username);
    if (!userId) return { found: false, message: `User "${username}" does not exist` };
    console.log(`[search] userId:${userId} displayName:"${displayName}"`);

    const thumbnailUrl = await resolveHeadshot(userId);

    const ranges = INSTANCE_RANGES.slice(0, instanceCount);
    console.log(`[search] running ${ranges.length} parallel instance(s)`);

    const result = await findPlayerParallel(userId, placeId, ranges);

    if (result) {
        console.log(`[search] ==== FOUND serverId:${result.serverId} via ${result.label} ====`);
        return {
            found: true,
            serverId: result.serverId,
            placeId: String(placeId),
            userId: String(userId),
            displayName,
            thumbnailUrl,
            foundInInstance: result.instance,
        };
    }

    console.log(`[search] ==== NOT FOUND ====`);
    return {
        found: false,
        message: "Player not found — possibly in a private server or offline",
        possiblePrivate: true,
    };
}

async function findPlayerParallel(userId, placeId, ranges) {
    return new Promise((resolve) => {
        let finished = false;
        let doneCount = 0;

        for (const range of ranges) {
            findPlayerInRange(userId, placeId, range).then(result => {
                if (finished) return;
                if (result) {
                    finished = true;
                    resolve({ serverId: result, instance: range.instance, label: range.label });
                    return;
                }
                doneCount++;
                if (doneCount === ranges.length) {
                    finished = true;
                    resolve(null);
                }
            }).catch(err => {
                console.error(`[search] instance ${range.instance} error:`, err.message);
                doneCount++;
                if (!finished && doneCount === ranges.length) {
                    finished = true;
                    resolve(null);
                }
            });
        }
    });
}

async function findPlayerInRange(userId, placeId, range) {
    let cursor = null;
    const pagesInRange = range.endPage - range.startPage + 1;

    console.log(`[search] ${range.label} starting`);

    for (let skip = 0; skip < range.startPage - 1; skip++) {
        const url = `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Asc&limit=100` +
            (cursor ? `&cursor=${cursor}` : "");
        const res = await fetch(url, { headers: robloxHeaders() });
        if (!res.ok) { console.error(`[search] ${range.label} skip page error ${res.status}`); return null; }
        const data = await res.json();
        cursor = data.nextPageCursor ?? null;
        if (!cursor) {
            console.log(`[search] ${range.label} cursor exhausted during skip at page ${skip + 1}`);
            return null;
        }
        await sleep(PAGE_DELAY_MS);
    }

    for (let i = 0; i < pagesInRange; i++) {
        const pageNum = range.startPage + i;
        const url = `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Asc&limit=100` +
            (cursor ? `&cursor=${cursor}` : "");

        const res = await fetch(url, { headers: robloxHeaders() });

        if (res.status === 429) {
            console.warn(`[search] ${range.label} rate limited page ${pageNum} — waiting 4000ms`);
            await sleep(4000);
            i--;
            continue;
        }

        if (!res.ok) {
            console.error(`[search] ${range.label} servers API error ${res.status} on page ${pageNum}`);
            return null;
        }

        const data = await res.json();
        const allServers = data.data ?? [];
        const servers = allServers.filter(s => s.playerTokens?.length);

        console.log(`[search] ${range.label} page ${pageNum} | total:${allServers.length} with-players:${servers.length}`);

        if (servers.length > 0) {
            const found = await scanPage(servers, userId, range.concurrency);
            if (found) return found;
        }

        cursor = data.nextPageCursor ?? null;
        if (!cursor) {
            console.log(`[search] ${range.label} no nextPageCursor after page ${pageNum} — stopping`);
            return null;
        }

        await sleep(PAGE_DELAY_MS);
    }

    console.log(`[search] ${range.label} complete — not found`);
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
                    if (resolved) { dispatch(); return; }
                    if (ids.includes(userId)) {
                        resolved = true;
                        resolve(server.id);
                    } else {
                        pending--;
                        if (pending === 0) resolve(null);
                        else dispatch();
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
        if (!res.ok) { console.warn(`[thumb] ${res.status} for userId:${userId}`); return ""; }
        const data = await res.json();
        const url = data?.data?.[0]?.imageUrl ?? "";
        console.log(`[thumb] userId:${userId} -> ${url ? url.slice(0, 60) + "..." : "empty"}`);
        return url;
    } catch (e) {
        console.warn(`[thumb] error:`, e.message);
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
    console.log(`[sniper] port:${PORT} | ROBLOSECURITY:${ROBLOSECURITY ? "SET ✓" : "NOT SET ✗"} | PLACE_ID:${PLACE_ID}`);
});
