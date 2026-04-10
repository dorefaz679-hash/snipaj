const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CONCURRENCY = 20;

app.get("/", (req, res) => res.json({ status: "ok" }));

app.post("/sniper", async (req, res) => {
    const { username, placeId } = req.body;

    if (!username || !placeId) {
        return res.status(400).json({ error: "Missing username or placeId" });
    }

    try {
        const { userId, displayName } = await resolveUser(username);
        if (!userId) {
            return res.json({ found: false, message: `User "${username}" does not exist` });
        }

        const [thumbnailUrl, serverResult] = await Promise.all([
            resolveHeadshot(userId),
            findPlayer(userId, placeId),
        ]);

        if (serverResult) {
            return res.json({
                found: true,
                serverId: serverResult.serverId,
                placeId: String(placeId),
                userId: String(userId),
                displayName,
                thumbnailUrl,
            });
        }

        return res.json({ found: false, message: "Player not found in any public server" });

    } catch (err) {
        console.error("[sniper] error:", err);
        return res.status(500).json({ error: String(err) });
    }
});

async function resolveUser(username) {
    const res = await fetch("https://users.roblox.com/v1/usernames/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
            `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`
        );
        if (!res.ok) return "";
        const data = await res.json();
        return data?.data?.[0]?.imageUrl ?? "";
    } catch {
        return "";
    }
}

async function findPlayer(userId, placeId) {
    let cursor = null;

    while (true) {
        const url =
            `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Asc&limit=100` +
            (cursor ? `&cursor=${cursor}` : "");

        const res = await fetch(url, {
            headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" },
        });
        if (!res.ok) {
            console.error("[sniper] servers API error:", res.status);
            break;
        }

        const data = await res.json();
        const servers = data.data ?? [];
        console.log(`[sniper] scanning page | servers: ${servers.length} | cursor: ${cursor ?? "start"}`);

        // batch all token-resolve calls across this page concurrently
        const results = await runConcurrent(
            servers.filter(s => s.playerTokens?.length),
            async (server) => {
                const ids = await resolveTokens(server.playerTokens);
                if (ids.includes(userId)) return server.id;
                return null;
            },
            CONCURRENCY
        );

        const found = results.find(r => r !== null);
        if (found) {
            console.log("[sniper] FOUND in server:", found);
            return { serverId: found };
        }

        cursor = data.nextPageCursor ?? null;
        if (!cursor) break;
    }

    return null;
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
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify(body),
        });
        if (!res.ok) return [];
        const data = await res.json();
        return (data.data ?? []).map(e => e.targetId).filter(Boolean);
    } catch {
        return [];
    }
}

// run tasks with limited concurrency
async function runConcurrent(items, fn, limit) {
    const results = [];
    let index = 0;

    async function worker() {
        while (index < items.length) {
            const i = index++;
            results[i] = await fn(items[i]);
            // short-circuit if already found
            if (results[i] !== null) {
                index = items.length;
            }
        }
    }

    const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
    await Promise.all(workers);
    return results;
}

app.listen(PORT, () => {
    console.log(`[sniper] listening on port ${PORT}`);
});
