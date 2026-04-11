const express = require("express");
const fetch = require("node-fetch");
const { randomUUID } = require("crypto");
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const ROBLOSECURITY = process.env.ROBLOSECURITY || "";
const DEFAULT_PLACE_ID = process.env.PLACE_ID || "8737602449";
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
	const instances = Math.min(Math.max(Number(instanceCount) || 1, 1), 5);
	jobs.set(jobId, { status: "running", step: "Starting...", result: null, startedAt: Date.now() });
	res.json({ ok: true, jobId });
	runSearch(jobId, username, placeId || DEFAULT_PLACE_ID, instances);
	setTimeout(() => jobs.delete(jobId), 20 * 60 * 1000);
});
app.get("/result/:jobId", (req, res) => {
	const job = jobs.get(req.params.jobId);
	if (!job) return res.status(404).json({ ok: false, message: "Job not found or expired" });
	res.json({ ok: true, status: job.status, step: job.step, result: job.result });
});
async function getPresenceStatus(userId) {
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
		const inThisGame = inGame && String(p.rootPlaceId || p.placeId || "") === String(DEFAULT_PLACE_ID);
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
		const [thumb150, thumb48] = await Promise.all([
			resolveHeadshot(userId, "150x150"),
			resolveHeadshot(userId, "48x48"),
		]);
		job.step = "Checking presence...";
		const presence = await getPresenceStatus(userId);
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
		if (presence.type === "unknown" && !ROBLOSECURITY) {
			job.step = "No ROBLOSECURITY — skipping presence gate, scanning servers...";
		} else if (!presence.inGame) {
			job.status = "done";
			job.result = { found: false, message: `${displayName} is not currently in a game`, presenceStatus: presence.type };
			return;
		}
		if (presence.inGame && !presence.inThisGame) {
			job.status = "done";
			job.result = { found: false, message: `${displayName} is in a different game, not this one`, presenceStatus: "othergame" };
			return;
		}
		if (presence.inGame && presence.gameId) {
			job.status = "done";
			job.result = { found: true, serverId: presence.gameId, placeId: String(placeId), userId: String(userId), displayName, thumbnailUrl: thumb150, foundInInstance: 1, matchType: "presence" };
			return;
		}
		job.step = `Building ${instanceCount}-instance cursor map...`;
		const cursors = await buildCursorMap(job, placeId, instanceCount);
		if (!cursors) {
			job.status = "done";
			job.result = { found: false, message: "Failed to read server list" };
			return;
		}
		const live = cursors.filter(c => c.startCursor !== "EXHAUSTED").length;
		job.step = `Scanning ${live} instance(s) in parallel...`;
		const result = await searchParallel(job, userId, thumb48, placeId, cursors);
		job.status = "done";
		if (result) {
			job.result = { found: true, serverId: result.serverId, placeId: String(placeId), userId: String(userId), displayName, thumbnailUrl: thumb150, foundInInstance: result.instance, matchType: result.matchType };
		} else {
			job.result = { found: false, message: "Player not found in any public server", possiblePrivate: true };
		}
	} catch (err) {
		console.error(`[${jobId}] error:`, err);
		job.status = "done";
		job.result = { found: false, message: "Internal error: " + err.message };
	}
}
async function buildCursorMap(job, placeId, instanceCount) {
	const CHUNK = [10, 40, 100, 150, 200];
	const slices = CHUNK.slice(0, instanceCount);
	const splitPoints = [null];
	let pipelineCursor = null;
	let page = 0;
	const totalNeeded = slices.slice(0, -1).reduce((a, b) => a + b, 0);
	for (let p = 0; p < totalNeeded; p++) {
		const url = serverListUrl(placeId, pipelineCursor);
		let res;
		try { res = await apiFetch(url); }
		catch (e) { console.error("[cursor] fetch error:", e.message); return null; }
		if (!res.ok) { console.error("[cursor] API", res.status); return null; }
		const data = await res.json();
		pipelineCursor = data.nextPageCursor ?? null;
		page++;
		let cumulative = 0;
		for (let i = 0; i < slices.length - 1; i++) {
			cumulative += slices[i];
			if (page === cumulative) splitPoints.push(pipelineCursor);
		}
		if (!pipelineCursor) {
			while (splitPoints.length < instanceCount) splitPoints.push("EXHAUSTED");
			break;
		}
	}
	while (splitPoints.length < instanceCount) splitPoints.push(pipelineCursor);
	return splitPoints.slice(0, instanceCount).map((startCursor, i) => {
		let start = 1;
		for (let j = 0; j < i; j++) start += slices[j];
		return { instance: i + 1, startCursor, label: `I${i + 1}[from p${start}]` };
	});
}
function serverListUrl(placeId, cursor) {
	return `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Asc&limit=100` +
		(cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
}
async function searchParallel(job, userId, thumbnailUrl48, placeId, cursors) {
	const found = { value: false };
	return new Promise((resolve) => {
		let done = 0;
		for (const slice of cursors) {
			if (slice.startCursor === "EXHAUSTED") {
				if (++done === cursors.length && !found.value) resolve(null);
				continue;
			}
			scanSlicePipelined(job, userId, thumbnailUrl48, placeId, slice, found).then(result => {
				if (found.value) return;
				if (result) { found.value = true; resolve({ ...result, instance: slice.instance }); return; }
				if (++done === cursors.length) resolve(null);
			}).catch(err => {
				console.error(`[scan] ${slice.label}:`, err.message);
				if (++done === cursors.length && !found.value) resolve(null);
			});
		}
	});
}
async function scanSlicePipelined(job, userId, thumbnailUrl48, placeId, slice, found) {
	let cursor = slice.startCursor;
	let pagesScanned = 0;
	let serversScanned = 0;
	let fetchDone = false;
	let result = null;
	const serverQueue = [];
	let resolveIdle = null;
	function notifyQueue() { if (resolveIdle) { const r = resolveIdle; resolveIdle = null; r(); } }
	async function fetcher() {
		let cur = cursor;
		while (!found.value && !result) {
			let res;
			try { res = await apiFetch(serverListUrl(placeId, cur)); }
			catch { await sleep(1000); continue; }
			if (!res.ok) { fetchDone = true; notifyQueue(); return; }
			const data = await res.json();
			const allServers = data.data ?? [];
			serversScanned += allServers.length;
			pagesScanned++;
			job.step = `${slice.label} — p${pagesScanned} | ${serversScanned} servers`;
			const active = allServers.filter(s => s.playerTokens?.length > 0);
			if (active.length > 0) { serverQueue.push(...active); notifyQueue(); }
			cur = data.nextPageCursor ?? null;
			if (!cur) break;
		}
		fetchDone = true;
		notifyQueue();
	}
	async function matcher() {
		while (!found.value && !result) {
			if (serverQueue.length === 0) {
				if (fetchDone) break;
				await new Promise(r => { resolveIdle = r; });
				continue;
			}
			const batch = serverQueue.splice(0, 20);
			const hits = await Promise.all(batch.map(s => batchMatch(s, userId, thumbnailUrl48)));
			const hit = hits.find(h => h != null);
			if (hit) { result = hit; return; }
		}
	}
	await Promise.all([fetcher(), matcher()]);
	return result ?? null;
}
async function batchMatch(server, userId, thumbnailUrl48) {
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
		if (res.status === 429) await sleep(2000);
		return null;
	}
	const data = await res.json();
	const uid = String(userId);
	for (const entry of (data.data ?? [])) {
		if (!entry) continue;
		if (entry.targetId && String(entry.targetId) === uid) return { serverId: server.id, matchType: "userId" };
		if (thumbnailUrl48 && entry.imageUrl && entry.imageUrl === thumbnailUrl48) return { serverId: server.id, matchType: "thumbnail" };
	}
	return null;
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
