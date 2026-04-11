const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ROBLOSECURITY = process.env.ROBLOSECURITY || "";
const DEFAULT_PLACE_ID = process.env.PLACE_ID || "8737602449";

if (!ROBLOSECURITY) console.warn("[sniper] WARNING: ROBLOSECURITY not set — token resolution will fail");

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
        job.resolve(await runSearch(job));
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
    jobs: queue.map((j, i) => ({ position: i + 1, username: j.username, priority: j.priority })),
}));

app.post("/resolve", async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ ok: false, message: "Missing username" });
    try {
        const { userId, displayName } = await resolveUser(username);
        if (!userId) return res.json({ ok: false, message: `User "${username}" does not exist` });
        const thumbnailUrl = await resolveHeadshot(userId, "150x150");
        const thumbnailUrl48 = await resolveHeadshot(userId, "48x48");
        console.log(`[resolve] ${username} -> userId:${userId} displayName:"${displayName}"`);
        res.json({ ok: true, userId: String(userId), displayName, thumbnailUrl, thumbnailUrl48 });
    } catch (err) {
        console.error("[resolve] error:", err);
        res.status(500).json({ ok: false, message: String(err) });
    }
});

app.post("/sniper", async (req, res) => {
    const { username, placeId, priority, instanceCount } = req.body;
    if (!username) return res.status(400).json({ error: "Missing username" });
    const instances = Math.min(Math.max(Number(instanceCount) || 1, 1), 5);
    console.log(`[sniper] POST | username:${username} priority:${priority || 2} instances:${instances}`);
    try {
        res.json(await enqueue({
            username,
            placeId: placeId || DEFAULT_PLACE_ID,
            priority: Number(priority) || 2,
            instanceCount: instances,
        }));
    } catch (err) {
        res.status(500).json({ error: String(err) });
    }
});

async function runSearch({ username, placeId, instanceCount }) {
    console.log(`[search] ==== START username:${username} placeId:${placeId} instances:${instanceCount} ====`);

    const { userId, displayName } = await resolveUser(username);
    if (!userId) return { found: false, message: `User "${username}" does not exist` };
    console.log(`[search] userId:${userId} displayName:"${displayName}"`);

    const [thumbnailUrl, thumbnailUrl48] = await Promise.all([
        resolveHeadshot(userId, "150x150"),
        resolveHeadshot(userId, "48x48"),
    ]);
    console.log(`[search] thumb150:${thumbnailUrl ? "ok" : "empty"} thumb48:${thumbnailUrl48 ? "ok" : "empty"}`);

    const cursors = await buildCursorMap(placeId, instanceCount);
    if (!cursors) {
        console.log(`[search] cursor build failed`);
        return { found: false, message: "Failed to read server list — Roblox API error", possiblePrivate: false };
    }

    console.log(`[search] cursor map built — launching ${cursors.length} instance(s)`);

    const result = await searchParallel(userId, thumbnailUrl48, placeId, cursors);

    if (result) {
        console.log(`[search] ==== FOUND serverId:${result.serverId} matchType:${result.matchType} ====`);
        return {
            found: true,
            serverId: result.serverId,
            placeId: String(placeId),
            userId: String(userId),
            displayName,
            thumbnailUrl,
            foundInInstance: result.instance,
            matchType: result.matchType,
        };
    }

    console.log(`[search] ==== NOT FOUND ====`);
    return { found: false, message: "Player not found — possibly in a private server or offline", possiblePrivate: true };
}

async function buildCursorMap(placeId, instanceCount) {
    const PAGES_PER_INSTANCE = [10, 40, 100, 150, 699];
    const slices = PAGES_PER_INSTANCE.slice(0, instanceCount);

    const splitPoints = [null];
    let cursor = null;
    let page = 0;
    let totalNeeded = 0;
    for (let i = 0; i < slices.length - 1; i++) totalNeeded += slices[i];

    console.log(`[cursor] pre-walking ${totalNeeded} pages to build ${instanceCount} split points`);

    for (let p = 0; p < totalNeeded; p++) {
        const url = `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Asc&limit=100` +
            (cursor ? `&cursor=${cursor}` : "");

        let res;
        try { res = await fetch(url, { headers: robloxHeaders() }); }
        catch (e) { console.error(`[cursor] fetch error page ${p}:`, e.message); return null; }

        if (res.status === 429) { await sleep(3500); p--; continue; }
        if (!res.ok) { console.error(`[cursor] API ${res.status} page ${p}`); return null; }

        const data = await res.json();
        cursor = data.nextPageCursor ?? null;
        page++;

        let cumulative = 0;
        for (let i = 0; i < slices.length - 1; i++) {
            cumulative += slices[i];
            if (page === cumulative) {
                splitPoints.push(cursor);
                console.log(`[cursor] split ${i + 1} at page ${page}: ${cursor ? cursor.slice(0, 20) + "..." : "null"}`);
            }
        }

        if (!cursor) {
            console.log(`[cursor] game exhausted at page ${page} — fewer instances needed`);
            while (splitPoints.length < instanceCount) splitPoints.push("EXHAUSTED");
            break;
        }

        await sleep(150);
    }

    while (splitPoints.length < instanceCount) splitPoints.push(cursor);

    return splitPoints.slice(0, instanceCount).map((startCursor, i) => ({
        instance: i + 1,
        startCursor,
        pageLimit: slices[i],
        label: buildLabel(i, slices),
    }));
}

function buildLabel(i, slices) {
    let start = 1;
    for (let j = 0; j < i; j++) start += slices[j];
    const end = start + slices[i] - 1;
    return `Instance ${i + 1} (pages ${start}–${end})`;
}

async function searchParallel(userId, thumbnailUrl48, placeId, cursors) {
    return new Promise((resolve) => {
        let finished = false;
        let doneCount = 0;

        for (const slice of cursors) {
            if (slice.startCursor === "EXHAUSTED") {
                console.log(`[search] ${slice.label} skipped — exhausted`);
                doneCount++;
                if (!finished && doneCount === cursors.length) { finished = true; resolve(null); }
                continue;
            }

            searchSlice(userId, thumbnailUrl48, placeId, slice).then(result => {
                if (finished) return;
                if (result) {
                    finished = true;
                    resolve({ ...result, instance: slice.instance, label: slice.label });
                    return;
                }
                doneCount++;
                if (doneCount === cursors.length) { finished = true; resolve(null); }
            }).catch(err => {
                console.error(`[search] ${slice.label} error:`, err.message);
                doneCount++;
                if (!finished && doneCount === cursors.length) { finished = true; resolve(null); }
            });
        }
    });
}

async function searchSlice(userId, thumbnailUrl48, placeId, slice) {
    let cursor = slice.startCursor;
    let pagesScanned = 0;

    console.log(`[search] ${slice.label} start`);

    while (pagesScanned < slice.pageLimit) {
        const url = `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Asc&limit=100` +
            (cursor ? `&cursor=${cursor}` : "");

        let res;
        try { res = await fetch(url, { headers: robloxHeaders() }); }
        catch (e) { console.warn(`[search] ${slice.label} fetch err:`, e.message); await sleep(1500); continue; }

        if (res.status === 429) { await sleep(3500); continue; }
        if (!res.ok) { console.error(`[search] ${slice.label} API ${res.status}`); return null; }

        const data = await res.json();
        const servers = (data.data ?? []).filter(s => s.playerTokens?.length > 0);

        console.log(`[search] ${slice.label} page ${pagesScanned + 1} | servers with players: ${servers.length}`);

        if (servers.length > 0) {
            const found = await scanServers(servers, userId, thumbnailUrl48);
            if (found) return found;
        }

        cursor = data.nextPageCursor ?? null;
        pagesScanned++;

        if (!cursor) {
            console.log(`[search] ${slice.label} cursor exhausted after page ${pagesScanned}`);
            return null;
        }

        await sleep(120);
    }

    console.log(`[search] ${slice.label} page limit reached`);
    return null;
}

async function scanServers(servers, userId, thumbnailUrl48) {
    const CONCURRENCY = 40;
    return new Promise((resolve) => {
        let resolved = false;
        let pending = servers.length;
        let idx = 0;
        let active = 0;

        function dispatch() {
            while (active < CONCURRENCY && idx < servers.length) {
                const server = servers[idx++];
                active++;
                resolveAndMatch(server, userId, thumbnailUrl48).then(result => {
                    active--;
                    if (resolved) { dispatch(); return; }
                    if (result) {
                        resolved = true;
                        resolve(result);
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

async function resolveAndMatch(server, userId, thumbnailUrl48) {
    if (!server.playerTokens?.length) return null;

    const body = server.playerTokens.map(t => ({
        requestId: `0:${t}:AvatarHeadShot:48x48:png:regular`,
        token: t,
        type: "AvatarHeadShot",
        size: "48x48",
        format: "png",
        isCircular: false,
    }));

    let res;
    try {
        res = await fetch("https://thumbnails.roblox.com/v1/batch", {
            method: "POST",
            headers: robloxHeaders(),
            body: JSON.stringify(body),
        });
    } catch (e) { return null; }

    if (!res.ok) {
        console.warn(`[batch] HTTP ${res.status} — ROBLOSECURITY may be expired`);
        return null;
    }

    const data = await res.json();
    const entries = data.data ?? [];

    for (const entry of entries) {
        const matchById = entry.targetId === userId || String(entry.targetId) === String(userId);
        const matchByThumb = thumbnailUrl48 && entry.imageUrl && entry.imageUrl === thumbnailUrl48;

        if (matchById || matchByThumb) {
            const matchType = matchById ? "userId" : "thumbnail";
            console.log(`[batch] MATCH server:${server.id} targetId:${entry.targetId} matchType:${matchType}`);
            return { serverId: server.id, matchType };
        }
    }

    return null;
}

function robloxHeaders() {
    const h = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
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

async function resolveHeadshot(userId, size = "150x150") {
    try {
        const res = await fetch(
            `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=${size}&format=Png&isCircular=false`,
            { headers: robloxHeaders() }
        );
        if (!res.ok) { console.warn(`[thumb] ${res.status} userId:${userId} size:${size}`); return ""; }
        const data = await res.json();
        return data?.data?.[0]?.imageUrl ?? "";
    } catch (e) {
        console.warn(`[thumb] error:`, e.message);
        return "";
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.listen(PORT, () => {
    console.log(`[sniper] port:${PORT} | ROBLOSECURITY:${ROBLOSECURITY ? "SET ✓" : "NOT SET ✗"} | PLACE_ID:${DEFAULT_PLACE_ID}`);
});
