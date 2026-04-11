const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ROBLOSECURITY = process.env.ROBLOSECURITY || "";
const PLACE_ID = process.env.PLACE_ID || "8737602449";

if (!ROBLOSECURITY) console.warn("[sniper] WARNING: ROBLOSECURITY not set");

const INSTANCE_DEFS = [
    { instance: 1, startIndex: 0,    endIndex: 99,   label: "Instance 1 (servers 1–100)"    },
    { instance: 2, startIndex: 100,  endIndex: 299,  label: "Instance 2 (servers 101–300)"  },
    { instance: 3, startIndex: 300,  endIndex: 599,  label: "Instance 3 (servers 301–600)"  },
    { instance: 4, startIndex: 600,  endIndex: 999,  label: "Instance 4 (servers 601–1000)" },
    { instance: 5, startIndex: 1000, endIndex: 1999, label: "Instance 5 (servers 1001–2000)"},
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

    const [thumbnailUrl, totalSize] = await Promise.all([
        resolveHeadshot(userId),
        getTotalCollectionSize(placeId),
    ]);

    console.log(`[search] thumbnailUrl:${thumbnailUrl ? "ok" : "empty"} totalCollectionSize:${totalSize}`);

    const ranges = INSTANCE_DEFS.slice(0, instanceCount).map(def => ({
        ...def,
        endIndex: Math.min(def.endIndex, totalSize > 0 ? totalSize - 1 : def.endIndex),
    })).filter(def => def.startIndex <= (totalSize > 0 ? totalSize - 1 : 99999));

    if (ranges.length === 0) {
        console.log(`[search] no valid ranges — game may have 0 servers`);
        return { found: false, message: "No servers found for this game", possiblePrivate: false };
    }

    console.log(`[search] running ${ranges.length} parallel instance(s) | totalSize:${totalSize}`);

    const result = await findPlayerParallel(userId, thumbnailUrl, placeId, ranges);

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
            matchType: result.matchType,
        };
    }

    console.log(`[search] ==== NOT FOUND ====`);
    return { found: false, message: "Player not found — possibly in a private server or offline", possiblePrivate: true };
}

async function getTotalCollectionSize(placeId) {
    try {
        const url = `https://www.roblox.com/games/getgameinstancesjson?placeId=${placeId}&startindex=0`;
        const res = await fetch(url, { headers: robloxHeaders() });
        if (!res.ok) { console.warn(`[size] HTTP ${res.status}`); return 0; }
        const data = await res.json();
        return data.TotalCollectionSize || 0;
    } catch (e) {
        console.warn(`[size] error:`, e.message);
        return 0;
    }
}

async function findPlayerParallel(userId, thumbnailUrl, placeId, ranges) {
    return new Promise((resolve) => {
        let finished = false;
        let doneCount = 0;

        for (const range of ranges) {
            scanRange(userId, thumbnailUrl, placeId, range).then(result => {
                if (finished) return;
                if (result) {
                    finished = true;
                    resolve({ serverId: result.serverId, instance: range.instance, label: range.label, matchType: result.matchType });
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

async function scanRange(userId, thumbnailUrl, placeId, range) {
    let index = range.startIndex;
    const step = 10;

    console.log(`[search] ${range.label} starting | index ${range.startIndex}–${range.endIndex}`);

    while (index <= range.endIndex) {
        const url = `https://www.roblox.com/games/getgameinstancesjson?placeId=${placeId}&startindex=${index}`;

        let res;
        try {
            res = await fetch(url, { headers: robloxHeaders() });
        } catch (e) {
            console.warn(`[search] ${range.label} fetch error at index ${index}:`, e.message);
            await sleep(2000);
            continue;
        }

        if (res.status === 429) {
            console.warn(`[search] ${range.label} rate limited at index ${index} — waiting 3000ms`);
            await sleep(3000);
            continue;
        }

        if (!res.ok) {
            console.error(`[search] ${range.label} API error ${res.status} at index ${index}`);
            return null;
        }

        const data = await res.json();
        const collection = data.Collection || [];

        console.log(`[search] ${range.label} index ${index} | servers:${collection.length} | total:${data.TotalCollectionSize}`);

        for (const server of collection) {
            const players = server.CurrentPlayers || [];
            for (const p of players) {
                const matchById = p.Id === userId || String(p.Id) === String(userId);
                const matchByThumb = thumbnailUrl && p.Thumbnail && p.Thumbnail.Url && p.Thumbnail.Url === thumbnailUrl;

                if (matchById || matchByThumb) {
                    const matchType = matchById ? "userId" : "thumbnail";
                    console.log(`[search] ${range.label} MATCH at index ${index} | server:${server.Guid} | matchType:${matchType} | player:${p.Username || p.Id}`);
                    return { serverId: server.Guid, matchType };
                }
            }
        }

        if (data.TotalCollectionSize && index >= data.TotalCollectionSize) {
            console.log(`[search] ${range.label} reached end of collection at index ${index}`);
            return null;
        }

        index += step;
        await sleep(200);
    }

    console.log(`[search] ${range.label} complete — not found`);
    return null;
}

function robloxHeaders() {
    const h = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": "https://www.roblox.com/",
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
            `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=48x48&format=Png&isCircular=false`,
            { headers: robloxHeaders() }
        );
        if (!res.ok) { console.warn(`[thumb] ${res.status} for userId:${userId}`); return ""; }
        const data = await res.json();
        const url = data?.data?.[0]?.imageUrl ?? "";
        console.log(`[thumb] userId:${userId} -> ${url ? url.slice(0, 70) + "..." : "empty"}`);
        return url;
    } catch (e) {
        console.warn(`[thumb] error:`, e.message);
        return "";
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.listen(PORT, () => {
    console.log(`[sniper] port:${PORT} | ROBLOSECURITY:${ROBLOSECURITY ? "SET ✓" : "NOT SET ✗"} | PLACE_ID:${PLACE_ID}`);
});
