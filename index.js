const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const ROBLOSECURITY = process.env.ROBLOSECURITY || "";
const DEFAULT_PLACE_ID = process.env.PLACE_ID || "8737602449";

if (!ROBLOSECURITY) console.warn("[sniper] WARNING: ROBLOSECURITY not set");

function robloxHeaders() {
    const h = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    };
    if (ROBLOSECURITY) h["Cookie"] = `.ROBLOSECURITY=${ROBLOSECURITY}`;
    return h;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function send(ws, obj) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
    }
}

app.get("/", (req, res) => res.json({ status: "ok" }));

app.post("/resolve", async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ ok: false, message: "Missing username" });
    try {
        const { userId, displayName } = await resolveUser(username);
        if (!userId) return res.json({ ok: false, message: `User "${username}" does not exist` });
        const thumbnailUrl = await resolveHeadshot(userId, "150x150");
        console.log(`[resolve] ${username} -> ${userId} "${displayName}"`);
        res.json({ ok: true, userId: String(userId), displayName, thumbnailUrl });
    } catch (err) {
        console.error("[resolve] error:", err);
        res.status(500).json({ ok: false, message: String(err) });
    }
});

wss.on("connection", (ws, req) => {
    console.log(`[ws] new connection from ${req.socket.remoteAddress}`);

    ws.on("message", async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        const username = msg.username;
        const placeId = msg.placeId || DEFAULT_PLACE_ID;
        const instanceCount = Math.min(Math.max(Number(msg.instanceCount) || 1, 1), 5);

        if (!username) {
            send(ws, { status: "error", msg: "Missing username" });
            return;
        }

        console.log(`[ws] search | username:${username} placeId:${placeId} instances:${instanceCount}`);
        send(ws, { status: "update", msg: `Resolving user ${username}...` });

        const { userId, displayName } = await resolveUser(username);
        if (!userId) {
            send(ws, { status: "done", result: "notfound", msg: `User "${username}" does not exist` });
            return;
        }

        const [thumbnailUrl, thumbnailUrl48] = await Promise.all([
            resolveHeadshot(userId, "150x150"),
            resolveHeadshot(userId, "48x48"),
        ]);

        send(ws, { status: "update", msg: `Found user ${displayName} (${userId}). Building cursor map...` });

        const cursors = await buildCursorMap(ws, placeId, instanceCount);
        if (!cursors) {
            send(ws, { status: "done", result: "notfound", msg: "Failed to read server list — Roblox API error" });
            return;
        }

        const activeSlices = cursors.filter(c => c.startCursor !== "EXHAUSTED");
        send(ws, { status: "update", msg: `Scanning ${activeSlices.length} instance(s) in parallel...` });

        const result = await searchParallel(ws, userId, thumbnailUrl48, placeId, cursors);

        if (result) {
            send(ws, {
                status: "done",
                result: "found",
                data: {
                    serverId: result.serverId,
                    placeId: String(placeId),
                    userId: String(userId),
                    displayName,
                    thumbnailUrl,
                    foundInInstance: result.instance,
                    matchType: result.matchType,
                },
            });
        } else {
            send(ws, {
                status: "done",
                result: "notfound",
                msg: "Player not found — possibly in a private server or offline",
                possiblePrivate: true,
            });
        }
    });

    ws.on("close", () => console.log("[ws] connection closed"));
    ws.on("error", (e) => console.error("[ws] error:", e.message));
});

async function buildCursorMap(ws, placeId, instanceCount) {
    const PAGES_PER_INSTANCE = [10, 40, 100, 150, 699];
    const slices = PAGES_PER_INSTANCE.slice(0, instanceCount);
    const splitPoints = [null];
    let cursor = null;
    let page = 0;
    let totalNeeded = 0;
    for (let i = 0; i < slices.length - 1; i++) totalNeeded += slices[i];

    console.log(`[cursor] pre-walking ${totalNeeded} pages for ${instanceCount} instances`);

    for (let p = 0; p < totalNeeded; p++) {
        const url = `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Asc&limit=100` +
            (cursor ? `&cursor=${cursor}` : "");

        let res;
        try { res = await fetch(url, { headers: robloxHeaders() }); }
        catch (e) { console.error(`[cursor] fetch error page ${p}:`, e.message); return null; }

        if (res.status === 429) {
            send(ws, { status: "update", msg: `Rate limited — waiting 3s...` });
            await sleep(3500); p--; continue;
        }
        if (!res.ok) { console.error(`[cursor] API ${res.status} page ${p}`); return null; }

        const data = await res.json();
        cursor = data.nextPageCursor ?? null;
        page++;

        let cumulative = 0;
        for (let i = 0; i < slices.length - 1; i++) {
            cumulative += slices[i];
            if (page === cumulative) {
                splitPoints.push(cursor);
                console.log(`[cursor] split ${i + 1} at page ${page}`);
            }
        }

        if (!cursor) {
            console.log(`[cursor] game exhausted at page ${page}`);
            while (splitPoints.length < instanceCount) splitPoints.push("EXHAUSTED");
            break;
        }

        await sleep(100);
    }

    while (splitPoints.length < instanceCount) splitPoints.push(cursor);

    return splitPoints.slice(0, instanceCount).map((startCursor, i) => {
        let start = 1;
        for (let j = 0; j < i; j++) start += slices[j];
        const end = start + slices[i] - 1;
        return {
            instance: i + 1,
            startCursor,
            pageLimit: slices[i],
            label: `Instance ${i + 1} (pages ${start}–${end})`,
        };
    });
}

async function searchParallel(ws, userId, thumbnailUrl48, placeId, cursors) {
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

            searchSlice(ws, userId, thumbnailUrl48, placeId, slice).then(result => {
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

async function searchSlice(ws, userId, thumbnailUrl48, placeId, slice) {
    let cursor = slice.startCursor;
    let pagesScanned = 0;
    let serversScanned = 0;

    console.log(`[search] ${slice.label} starting`);

    while (pagesScanned < slice.pageLimit) {
        const url = `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Asc&limit=100` +
            (cursor ? `&cursor=${cursor}` : "");

        let res;
        try { res = await fetch(url, { headers: robloxHeaders() }); }
        catch (e) { await sleep(1500); continue; }

        if (res.status === 429) { await sleep(3500); continue; }
        if (!res.ok) { console.error(`[search] ${slice.label} API ${res.status}`); return null; }

        const data = await res.json();
        const servers = (data.data ?? []).filter(s => s.playerTokens?.length > 0);
        serversScanned += (data.data ?? []).length;

        send(ws, {
            status: "update",
            msg: `${slice.label} — page ${pagesScanned + 1}, ${serversScanned} servers scanned...`,
        });

        console.log(`[search] ${slice.label} page ${pagesScanned + 1} | active servers: ${servers.length}`);

        if (servers.length > 0) {
            const found = await scanServers(servers, userId, thumbnailUrl48);
            if (found) return found;
        }

        cursor = data.nextPageCursor ?? null;
        pagesScanned++;

        if (!cursor) {
            console.log(`[search] ${slice.label} cursor exhausted`);
            return null;
        }

        await sleep(100);
    }

    return null;
}

async function scanServers(servers, userId, thumbnailUrl48) {
    const CONCURRENCY = 50;
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
                    if (result) { resolved = true; resolve(result); return; }
                    pending--;
                    if (pending === 0) resolve(null);
                    else dispatch();
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
    } catch { return null; }

    if (!res.ok) {
        if (res.status === 401) console.warn("[batch] 401 — ROBLOSECURITY expired!");
        return null;
    }

    const data = await res.json();
    for (const entry of (data.data ?? [])) {
        const matchById = String(entry.targetId) === String(userId);
        const matchByThumb = thumbnailUrl48 && entry.imageUrl && entry.imageUrl === thumbnailUrl48;
        if (matchById || matchByThumb) {
            console.log(`[match] server:${server.id} targetId:${entry.targetId} type:${matchById ? "userId" : "thumbnail"}`);
            return { serverId: server.id, matchType: matchById ? "userId" : "thumbnail" };
        }
    }

    return null;
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
        if (!res.ok) return "";
        const data = await res.json();
        return data?.data?.[0]?.imageUrl ?? "";
    } catch { return ""; }
}

server.listen(PORT, () => {
    console.log(`[sniper] port:${PORT} | ROBLOSECURITY:${ROBLOSECURITY ? "SET ✓" : "NOT SET ✗"} | WS ready`);
});
