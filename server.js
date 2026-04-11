const express = require("express");
const fetch = require("node-fetch");
const { randomUUID } = require("crypto");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ROBLOSECURITY = process.env.ROBLOSECURITY || "";
const DEFAULT_PLACE_ID = process.env.PLACE_ID || "8737602449";

if (!ROBLOSECURITY) console.warn("[sniper] WARNING: ROBLOSECURITY not set");

const jobs = new Map();

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

app.get("/", (req, res) => res.json({ status: "ok", activeJobs: jobs.size }));

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

app.post("/search", async (req, res) => {
    const { username, placeId, instanceCount } = req.body;
    if (!username) return res.status(400).json({ ok: false, message: "Missing username" });

    const jobId = randomUUID();
    const instances = Math.min(Math.max(Number(instanceCount) || 1, 1), 5);

    jobs.set(jobId, {
        status: "running",
        step: "Resolving user...",
        result: null,
        startedAt: Date.now(),
    });

    console.log(`[search] START jobId:${jobId} username:${username} instances:${instances}`);

    res.json({ ok: true, jobId });

    runSearch(jobId, username, placeId || DEFAULT_PLACE_ID, instances);

    setTimeout(() => {
        if (jobs.has(jobId)) {
            console.log(`[search] cleanup jobId:${jobId}`);
            jobs.delete(jobId);
        }
    }, 10 * 60 * 1000);
});

app.get("/result/:jobId", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, message: "Job not found or expired" });

    res.json({
        ok: true,
        status: job.status,
        step: job.step,
        result: job.result,
    });
});

async function runSearch(jobId, username, placeId, instanceCount) {
    const job = jobs.get(jobId);
    if (!job) return;

    try {
        job.step = `Resolving ${username}...`;
        const { userId, displayName } = await resolveUser(username);
        if (!userId) {
            job.status = "done";
            job.result = { found: false, message: `User "${username}" does not exist` };
            return;
        }

        console.log(`[search] ${jobId} userId:${userId} displayName:"${displayName}"`);

        const [thumbnailUrl, thumbnailUrl48] = await Promise.all([
            resolveHeadshot(userId, "150x150"),
            resolveHeadshot(userId, "48x48"),
        ]);

        job.step = `Building cursor map for ${instanceCount} instance(s)...`;
        const cursors = await buildCursorMap(job, placeId, instanceCount);
        if (!cursors) {
            job.status = "done";
            job.result = { found: false, message: "Failed to read server list — Roblox API error" };
            return;
        }

        const activeSlices = cursors.filter(c => c.startCursor !== "EXHAUSTED");
        job.step = `Scanning ${activeSlices.length} instance(s) in parallel...`;

        const result = await searchParallel(job, userId, thumbnailUrl48, placeId, cursors);

        if (result) {
            console.log(`[search] ${jobId} FOUND serverId:${result.serverId} matchType:${result.matchType}`);
            job.status = "done";
            job.result = {
                found: true,
                serverId: result.serverId,
                placeId: String(placeId),
                userId: String(userId),
                displayName,
                thumbnailUrl,
                foundInInstance: result.instance,
                matchType: result.matchType,
            };
        } else {
            console.log(`[search] ${jobId} NOT FOUND`);
            job.status = "done";
            job.result = {
                found: false,
                message: "Player not found — possibly in a private server or offline",
                possiblePrivate: true,
            };
        }
    } catch (err) {
        console.error(`[search] ${jobId} error:`, err);
        job.status = "done";
        job.result = { found: false, message: "Internal search error: " + err.message };
    }
}

async function buildCursorMap(job, placeId, instanceCount) {
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
        catch (e) { console.error(`[cursor] fetch error:`, e.message); return null; }

        if (res.status === 429) {
            job.step = "Rate limited — waiting 3s...";
            await sleep(3500); p--; continue;
        }
        if (!res.ok) { console.error(`[cursor] API ${res.status}`); return null; }

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
            console.log(`[cursor] exhausted at page ${page}`);
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

async function searchParallel(job, userId, thumbnailUrl48, placeId, cursors) {
    return new Promise((resolve) => {
        let finished = false;
        let doneCount = 0;

        for (const slice of cursors) {
            if (slice.startCursor === "EXHAUSTED") {
                doneCount++;
                if (!finished && doneCount === cursors.length) { finished = true; resolve(null); }
                continue;
            }

            searchSlice(job, userId, thumbnailUrl48, placeId, slice).then(result => {
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

async function searchSlice(job, userId, thumbnailUrl48, placeId, slice) {
    let cursor = slice.startCursor;
    let pagesScanned = 0;
    let serversScanned = 0;

    while (pagesScanned < slice.pageLimit) {
        const url = `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Asc&limit=100` +
            (cursor ? `&cursor=${cursor}` : "");

        let res;
        try { res = await fetch(url, { headers: robloxHeaders() }); }
        catch (e) { await sleep(1500); continue; }

        if (res.status === 429) { await sleep(3500); continue; }
        if (!res.ok) return null;

        const data = await res.json();
        const servers = (data.data ?? []).filter(s => s.playerTokens?.length > 0);
        serversScanned += (data.data ?? []).length;

        job.step = `${slice.label} — page ${pagesScanned + 1}, ${serversScanned} servers checked`;

        console.log(`[search] ${slice.label} page ${pagesScanned + 1} | active:${servers.length} total:${serversScanned}`);

        if (servers.length > 0) {
            const found = await scanServers(servers, userId, thumbnailUrl48);
            if (found) return found;
        }

        cursor = data.nextPageCursor ?? null;
        pagesScanned++;

        if (!cursor) return null;

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

app.listen(PORT, () => {
    console.log(`[sniper] port:${PORT} | ROBLOSECURITY:${ROBLOSECURITY ? "SET ✓" : "NOT SET ✗"}`);
});
