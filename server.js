const express = require("express");
const fetch = require("node-fetch");
const { randomUUID } = require("crypto");
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const ROBLOSECURITY = process.env.ROBLOSECURITY || "";
const DEFAULT_PLACE_ID = process.env.PLACE_ID || "8737602449";
const MIN_CAPACITY_RATIO = 0.0;
const jobs = new Map();
const cursorCache = new Map();

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

async function apiFetch(url, opts = {}, retries = 5) {
	for (let i = 0; i < retries; i++) {
		let res;
		try { res = await fetch(url, { ...opts, headers: { ...robloxHeaders(), ...(opts.headers || {}) } }); }
		catch (e) { if (i === retries - 1) throw e; await sleep(800 * (i + 1)); continue; }
		if (res.status === 429) { await sleep(3500 * (i + 1)); continue; }
		return res;
	}
	throw new Error("Max retries exceeded");
}

app.get("/", (req, res) => res.json({ status: "ok", activeJobs: jobs.size }));

app.post("/resolve", async (req, res) => {
	const { username } = req.body;
	if (!username) return res.status(400).json({ ok: false, message: "Missing username" });
	try {
		const user = await resolveUser(username);
		if (!user.userId) return res.json({ ok: false, message: `User "${username}" does not exist` });
		const thumbnailUrl = await resolveHeadshot(user.userId, "150x150");
		res.json({ ok: true, userId: String(user.userId), displayName: user.displayName, thumbnailUrl });
	} catch (err) {
		res.status(500).json({ ok: false, message: String(err) });
	}
});

app.post("/search", async (req, res) => {
	const { username, placeId, instanceCount } = req.body;
	if (!username) return res.status(400).json({ ok: false, message: "Missing username" });
	const jobId = randomUUID();
	const instances = Math.min(Math.max(Number(instanceCount) || 1, 1), 12);
	jobs.set(jobId, { status: "running", step: "Starting...", result: null, startedAt: Date.now(), cancelled: false, userId: null, placeId: placeId || DEFAULT_PLACE_ID });
	res.json({ ok: true, jobId });
	runSearch(jobId, username, placeId || DEFAULT_PLACE_ID, instances);
	setTimeout(() => jobs.delete(jobId), 20 * 60 * 1000);
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
	if (!job || !job.userId) return res.json({ abort: false });
	if (!ROBLOSECURITY) return res.json({ abort: false });
	const presence = await getPresenceStatus(job.userId, placeId || DEFAULT_PLACE_ID);
	if (presence.type === "offline") {
		return res.json({ abort: true, message: "Player went offline during search", presenceStatus: "offline" });
	}
	return res.json({ abort: false });
});

async function getPresenceStatus(userId, placeId) {
	if (!ROBLOSECURITY) return { type: "unknown", inGame: false, inThisGame: false, gameId: null };
	try {
		const res = await apiFetch("https://presence.roblox.com/v1/presence/users", {
			method: "POST",
			body: JSON.stringify({ userIds: [Number(userId)] }),
		});
		if (!res.ok) return { type: "unknown", inGame: false, inThisGame: false, gameId: null };
		const data = await res.json();
		const p = data?.userPresences?.[0];
		if (!p) return { type: "unknown", inGame: false, inThisGame: false, gameId: null };
		const presenceType = p.userPresenceType;
		const inGame = presenceType === 2;
		const inThisGame = inGame && String(p.rootPlaceId || p.placeId || "") === String(placeId || DEFAULT_PLACE_ID);
		return {
			type: presenceType === 0 ? "offline" : presenceType === 1 ? "online" : presenceType === 2 ? "ingame" : "unknown",
			inGame,
			inThisGame,
			gameId: p.gameId || null,
			placeId: String(p.rootPlaceId || p.placeId || ""),
		};
	} catch {
		return { type: "unknown", inGame: false, inThisGame: false, gameId: null };
	}
}

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
		job.userId = userId;
		const [thumb150, thumb48, thumb720] = await Promise.all([
			resolveHeadshot(userId, "150x150"),
			resolveHeadshot(userId, "48x48"),
			resolveHeadshot(userId, "720x720"),
		]);

		job.step = "Checking presence...";
		const presence = await getPresenceStatus(userId, placeId);

		if (presence.type === "offline") {
			job.status = "done";
			job.result = { found: false, message: `${displayName} is offline`, presenceStatus: "offline" };
			return;
		}

		if (presence.type === "online") {
			job.status = "done";
			job.result = { found: false, message: `${displayName} is on the Roblox website but not in any game`, presenceStatus: "online" };
			return;
		}

		if (presence.inGame && presence.gameId && presence.inThisGame) {
			job.status = "done";
			job.result = { found: true, serverId: presence.gameId, placeId: String(placeId), userId: String(userId), displayName, thumbnailUrl: thumb150, foundInInstance: 1, matchType: "presence" };
			return;
		}

		if (job.cancelled) return;

		job.step = `DeepSnipe scanning with ${instanceCount} parallel workers...`;
		const result = await deepSnipe(job, userId, [thumb48, thumb720], placeId, instanceCount);

		if (job.cancelled) return;
		job.status = "done";

		if (result) {
			job.result = { found: true, serverId: result.serverId, placeId: String(placeId), userId: String(userId), displayName, thumbnailUrl: thumb150, foundInInstance: result.instance, matchType: result.matchType };
		} else {
			const finalPresence = await getPresenceStatus(userId, placeId);
			const definitelyPrivate = finalPresence.inGame && finalPresence.inThisGame;
			job.result = { found: false, message: definitelyPrivate ? "Player is in a private server" : "Player not found in any public server", possiblePrivate: true };
		}
	} catch (err) {
		if (job.cancelled) return;
		job.status = "done";
		job.result = { found: false, message: "Internal error: " + err.message };
	}
}

async function deepSnipe(job, userId, thumbnailUrls, placeId, workerCount) {
	const found = { value: false, result: null };
	const serverQueue = [];
	let queueResolve = null;
	let fetchCompleted = 0;
	const totalFetchers = workerCount * 2;
	let fetchersDone = 0;
	const sortOrders = ['Asc', 'Desc'];
	const limits = [100, 50];
	const maxPagesPerFetcher = 15;
	const activeFetchers = new Set();

	const notifyQueue = () => {
		if (queueResolve) {
			const r = queueResolve;
			queueResolve = null;
			r();
		}
	};

	const fetchServers = async (startCursor, sortOrder, limit, instanceId) => {
		let cursor = startCursor;
		let pages = 0;
		let serversSeen = 0;
		while (!found.value && !job.cancelled && pages < maxPagesPerFetcher) {
			const url = `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=${sortOrder}&limit=${limit}` +
				(cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
			let res;
			try { res = await apiFetch(url); }
			catch { await sleep(800); continue; }
			if (!res.ok) {
				if (res.status === 400) break;
				await sleep(800);
				continue;
			}
			const data = await res.json();
			const servers = data.data || [];
			serversSeen += servers.length;
			pages++;
			job.step = `W${instanceId} ${sortOrder} L${limit} p${pages} s${serversSeen}`;
			const active = servers.filter(s => {
				if (!s.playerTokens?.length) return false;
				if (!s.maxPlayers) return true;
				return (s.playing / s.maxPlayers) >= MIN_CAPACITY_RATIO;
			});
			if (active.length) {
				serverQueue.push(...active);
				notifyQueue();
			}
			cursor = data.nextPageCursor;
			if (!cursor) break;
		}
		fetchersDone++;
		if (fetchersDone === totalFetchers) notifyQueue();
	};

	const matcher = async () => {
		const batchSize = 20;
		while (!found.value && !job.cancelled) {
			if (serverQueue.length === 0) {
				if (fetchersDone === totalFetchers) break;
				await new Promise(r => { queueResolve = r; });
				continue;
			}
			const batch = serverQueue.splice(0, batchSize);
			const promises = batch.map(s => deepMatchServer(s, userId, thumbnailUrls));
			const hits = await Promise.all(promises);
			const hit = hits.find(h => h !== null);
			if (hit) {
				found.value = true;
				found.result = hit;
				return;
			}
		}
	};

	const startCursors = await Promise.all([
		(async () => null)(),
		(async () => {
			try {
				const res = await apiFetch(`https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Asc&limit=100`);
				const data = await res.json();
				return data.nextPageCursor || null;
			} catch { return null; }
		})(),
		(async () => {
			try {
				const res = await apiFetch(`https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Desc&limit=100`);
				const data = await res.json();
				return data.nextPageCursor || null;
			} catch { return null; }
		})(),
	]);

	const fetcherPromises = [];
	let workerId = 1;
	for (const sortOrder of sortOrders) {
		for (const limit of limits) {
			for (let i = 0; i < Math.max(1, Math.floor(workerCount / 2)); i++) {
				const cursor = startCursors[fetcherPromises.length % startCursors.length];
				fetcherPromises.push(fetchServers(cursor, sortOrder, limit, workerId++));
				if (fetcherPromises.length >= totalFetchers) break;
			}
		}
	}
	while (fetcherPromises.length < totalFetchers) {
		fetcherPromises.push(fetchServers(null, 'Asc', 100, workerId++));
	}

	await Promise.race([
		Promise.all(fetcherPromises),
		matcher()
	]);

	return found.result;
}

async function deepMatchServer(server, userId, thumbnailUrls) {
	if (!server.playerTokens?.length) return null;
	const tokens = server.playerTokens.slice(0, 100);
	const uid = String(userId);
	const batchRequests = [];
	for (const token of tokens) {
		batchRequests.push({
			requestId: `0:${token}:AvatarHeadShot:48x48:png:regular`,
			token: token,
			type: "AvatarHeadShot",
			size: "48x48",
			format: "png",
			isCircular: false,
		});
	}
	try {
		const res = await fetch("https://thumbnails.roblox.com/v1/batch", {
			method: "POST",
			headers: robloxHeaders(),
			body: JSON.stringify(batchRequests),
		});
		if (!res.ok) {
			if (res.status === 429) await sleep(2000);
			return null;
		}
		const data = await res.json();
		for (const entry of (data.data ?? [])) {
			if (!entry) continue;
			if (entry.targetId && String(entry.targetId) === uid) {
				return { serverId: server.id, matchType: "userId" };
			}
			if (entry.imageUrl) {
				for (const thumb of thumbnailUrls) {
					if (thumb && entry.imageUrl === thumb) {
						return { serverId: server.id, matchType: "thumbnail" };
					}
				}
			}
		}
		return null;
	} catch {
		return null;
	}
}

async function resolveUser(username) {
	const res = await apiFetch("https://users.roblox.com/v1/usernames/users", {
		method: "POST",
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
		const res = await apiFetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=${size}&format=Png&isCircular=false`);
		if (!res.ok) return "";
		const data = await res.json();
		return data?.data?.[0]?.imageUrl ?? "";
	} catch { return ""; }
}

app.listen(PORT, () => {
	console.log(`[sniper] port:${PORT} | ROBLOSECURITY:${ROBLOSECURITY ? "SET ✓" : "NOT SET ✗"}`);
});
