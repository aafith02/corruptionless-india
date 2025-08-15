/*
Full PBFT demo node for Bun + @libsql/client.

Features:
- Correct libsql usage (execute({sql,args}))
- Schema migration / idempotent table creation
- PBFT phases: PRE-PREPARE, PREPARE, COMMIT with quorum checks
- Simple HMAC "signatures" for message authenticity in this demo (use real crypto in prod)
- Leader selection deterministic by sorted node list (NODE_ID + peer URLs)
- HTTP API: POST /tx to submit a tx, GET /blocks to list committed blocks, GET /status
- WebSocket mesh to peers (pass peers as ws://host:port)

Run example:
  bun add @libsql/client ws
  with-env { NODE_ID: "node1" } { bun run bun-pbft-full.js --port 8001 --peers "ws://localhost:8002,ws://localhost:8003" }
  with-env { NODE_ID: "node2" } { bun run bun-pbft-full.js --port 8002 --peers "ws://localhost:8001,ws://localhost:8003" }
  with-env { NODE_ID: "node3" } { bun run bun-pbft-full.js --port 8003 --peers "ws://localhost:8001,ws://localhost:8002" }

Notes:
- This is a teaching/demo implementation. It omits many production concerns (auth, persistence tuning, view-change robustness, replay protection, etc.).
- For deterministic leader selection the nodes must see the same sorted list; by using NODE_ID plus peer URLs and sorting, nodes will agree if configured consistently.
*/

import { createClient } from "@libsql/client";
import WebSocket, { WebSocketServer } from "ws";
import http from "http";
import { createHmac, randomBytes } from "crypto";
import fs from "fs";

// ---- Config ----
const NODE_ID = process.env.NODE_ID || "node1";
const PORT = Number(
  process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] || 8001
);
const PEERS =
  process.argv
    .find((a) => a.startsWith("--peers="))
    ?.split("=")[1]
    ?.split(",")
    ?.filter(Boolean) || [];
const DB_FILE = `./chain-${NODE_ID}.db`;
const SECRET = process.env.SECRET || "demo-secret"; // simple shared secret for HMAC signatures in demo

// ensure working directory exists (usually yes)
try {
  fs.mkdirSync(".", { recursive: true });
} catch (e) {}

// ---- DB client ----
const db = createClient({ url: `file:${DB_FILE}` });

async function migrate() {
  // create tables if missing
  await db.execute(
    `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);`
  );
  await db.execute(`CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seq INTEGER UNIQUE,
    prevHash TEXT,
    hash TEXT,
    data TEXT,
    timestamp INTEGER
  );`);
}

async function getLastSeq() {
  const r = await db.execute({
    sql: `SELECT v FROM meta WHERE k = ?`,
    args: ["last_seq"],
  });
  return r.rows.length ? Number(r.rows[0].v) : 0;
}

async function setLastSeq(seq) {
  await db.execute({
    sql: `INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    args: ["last_seq", String(seq)],
  });
}

async function appendBlock({ seq, prevHash, data }) {
  const ts = Date.now();
  const hash = createHmac("sha256", SECRET)
    .update(JSON.stringify({ seq, prevHash, data, ts }))
    .digest("hex");
  await db.execute({
    sql: `INSERT OR IGNORE INTO blocks (seq, prevHash, hash, data, timestamp) VALUES (?,?,?,?,?)`,
    args: [seq, prevHash || "", hash, JSON.stringify(data), ts],
  });
  await setLastSeq(seq);
  return { seq, prevHash, hash, data, timestamp: ts };
}

async function getBlocks() {
  const r = await db.execute({
    sql: `SELECT seq, prevHash, hash, data, timestamp FROM blocks ORDER BY seq ASC`,
  });
  return r.rows.map((row) => ({
    seq: row.seq,
    prevHash: row.prevHash,
    hash: row.hash,
    data: JSON.parse(row.data),
    timestamp: row.timestamp,
  }));
}

async function getBlockBySeq(s) {
  const r = await db.execute({
    sql: `SELECT seq, prevHash, hash, data, timestamp FROM blocks WHERE seq = ? LIMIT 1`,
    args: [s],
  });
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return {
    seq: row.seq,
    prevHash: row.prevHash,
    hash: row.hash,
    data: JSON.parse(row.data),
    timestamp: row.timestamp,
  };
}

// ---- PBFT state ----
let view = 0;
let lastCommitted = 0; // last committed seq (mirrors DB)
const pending = new Map(); // seq -> { preprepare, prepares:Set, commits:Set, block }

function quorumCounts(n) {
  const f = Math.floor((n - 1) / 3);
  const q = 2 * f + 1;
  return { N: n, f, quorum: q };
}

function nodeListSorted() {
  // nodes: NODE_ID and peer URLs — must be identical across nodes for deterministic leader selection
  return [NODE_ID, ...PEERS].slice().sort();
}

function leaderForView(v) {
  const nodes = nodeListSorted();
  if (!nodes.length) return null;
  return nodes[v % nodes.length];
}

// ---- Simple HMAC "sign" for demo messages ----
function sign(msg) {
  return createHmac("sha256", SECRET).update(JSON.stringify(msg)).digest("hex");
}
function verify(msg, sig) {
  return (
    createHmac("sha256", SECRET).update(JSON.stringify(msg)).digest("hex") ===
    sig
  );
}

// ---- Networking: WS mesh ----
const peers = new Map(); // url -> ws

function connectPeer(url) {
  if (peers.has(url)) return;
  const ws = new WebSocket(url);
  ws.on("open", () => {
    console.log(`[${NODE_ID}] connected-> ${url}`);
    peers.set(url, ws);
  });
  ws.on("message", (data) => {
    try {
      const env = JSON.parse(data.toString());
      handleEnvelope(env);
    } catch (e) {}
  });
  ws.on("close", () => {
    peers.delete(url);
    console.log(`[${NODE_ID}] disconnected-> ${url}`);
    setTimeout(() => connectPeer(url), 1000);
  });
  ws.on("error", () => {});
}

function broadcastEnvelope(type, payload) {
  const envelope = { type, payload, from: NODE_ID };
  envelope.sig = sign(envelope);
  const s = JSON.stringify(envelope);
  for (const ws of peers.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(s);
  }
}

function sendTo(ws, type, payload) {
  const envelope = { type, payload, from: NODE_ID };
  envelope.sig = sign(envelope);
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(envelope));
}

// ---- PBFT message handling ----
function ensurePending(seq) {
  if (!pending.has(seq))
    pending.set(seq, {
      preprepare: null,
      prepares: new Set(),
      commits: new Set(),
      block: null,
    });
  return pending.get(seq);
}

async function handleEnvelope(envelope) {
  const { type, payload, from, sig } = envelope;
  if (!verify({ type, payload, from }, sig)) {
    console.warn("Bad signature, ignoring");
    return;
  }

  if (type === "CLIENT-TX") {
    // treat like a client submission to leader
    if (leaderForView(view) === NODE_ID) {
      // propose immediately
      await proposeBlock(payload);
    }
    return;
  }

  if (type === "PRE-PREPARE") {
    const { view: v, seq, block } = payload;
    if (v < view) return; // stale
    const entry = ensurePending(seq);
    if (entry.preprepare) return; // already have
    entry.preprepare = { from, view: v };
    entry.block = block;
    // send our own PREPARE (including self later counts)
    broadcastEnvelope("PREPARE", { view: v, seq, blockHash: block.hash });
    // also record our prepare locally
    entry.prepares.add(NODE_ID + ":" + block.hash);
    checkPrepare(seq, block.hash);
    return;
  }

  if (type === "PREPARE") {
    const { view: v, seq, blockHash } = payload;
    const entry = ensurePending(seq);
    entry.prepares.add(from + ":" + blockHash);
    checkPrepare(seq, blockHash);
    return;
  }

  if (type === "COMMIT") {
    const { view: v, seq, blockHash } = payload;
    const entry = ensurePending(seq);
    entry.commits.add(from + ":" + blockHash);
    checkCommit(seq, blockHash);
    return;
  }
}

async function checkPrepare(seq, blockHash) {
  const n = peers.size + 1;
  const { quorum } = quorumCounts(n);
  const entry = pending.get(seq);
  if (!entry) return;
  const preparesForHash = new Set(
    [...entry.prepares].filter((x) => x.endsWith(":" + blockHash))
  ).size;
  // include self if not already (we add self earlier on PRE-PREPARE)
  const totalPrepares = preparesForHash; // entry.prepares already includes self where appropriate
  if (totalPrepares >= quorum) {
    // broadcast commit and record our commit
    broadcastEnvelope("COMMIT", { view, seq, blockHash });
    entry.commits.add(NODE_ID + ":" + blockHash);
    checkCommit(seq, blockHash);
  }
}

async function checkCommit(seq, blockHash) {
  const n = peers.size + 1;
  const { quorum } = quorumCounts(n);
  const entry = pending.get(seq);
  if (!entry) return;
  const commitsForHash = new Set(
    [...entry.commits].filter((x) => x.endsWith(":" + blockHash))
  ).size;
  if (commitsForHash >= quorum) {
    // commit to DB if not committed
    const existing = await getBlockBySeq(seq);
    if (!existing) {
      // determine prevHash from last committed
      const prev = await getBlockBySeq(lastCommitted);
      const prevHash = prev?.hash || "";
      const committed = await appendBlock({ seq, prevHash, data: entry.block });
      lastCommitted = seq;
      console.log(`[${NODE_ID}] Committed seq=${seq} hash=${committed.hash}`);
    }
  }
}

// ---- Leader role: propose blocks ----
async function proposeBlock(tx) {
  const leader = leaderForView(view);
  if (leader !== NODE_ID) {
    // forward to peers (any peer) so leader can pick it up
    broadcastEnvelope("CLIENT-TX", tx);
    return;
  }
  // leader assigns next seq
  const nextSeq = (await getLastSeq()) + 1;
  const block = { seq: nextSeq, data: tx, timestamp: Date.now() };
  block.hash = createHmac("sha256", SECRET)
    .update(JSON.stringify(block))
    .digest("hex");
  // store preprepare locally
  const entry = ensurePending(nextSeq);
  entry.preprepare = { from: NODE_ID, view };
  entry.block = block;
  // leader adds its own prepare
  entry.prepares.add(NODE_ID + ":" + block.hash);
  // broadcast PRE-PREPARE
  broadcastEnvelope("PRE-PREPARE", { view, seq: nextSeq, block });
  // also trigger check locally in case quorum small
  checkPrepare(nextSeq, block.hash);
}

// ---- HTTP API and server startup ----
async function start() {
  await migrate();
  lastCommitted = await getLastSeq();
  console.log(
    `[${NODE_ID}] Starting PBFT node on ws port ${PORT} (http port ${
      PORT + 1000
    }) DB=${DB_FILE}`
  );

  // start WS server
  const wss = new WebSocketServer({ port: PORT });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      try {
        handleEnvelope(JSON.parse(data.toString()));
      } catch (e) {}
    });
  });

  // connect to peers
  for (const p of PEERS) connectPeer(p);

  // HTTP server
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/tx") {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", async () => {
        try {
          const tx = JSON.parse(b);
          await proposeBlock(tx);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400);
          res.end("bad");
        }
      });
      return;
    }
    if (req.method === "GET" && req.url === "/blocks") {
      getBlocks().then((rows) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rows));
      });
      return;
    }
    if (req.method === "GET" && req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          node: NODE_ID,
          view,
          leader: leaderForView(view),
          peers: Array.from(peers.keys()),
          lastCommitted,
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(PORT + 1000);

  // simple CLI commands on stdin for testing
  process.stdin.resume();
  process.stdin.on("data", async (d) => {
    const cmd = d.toString().trim();
    if (cmd === "nextview") {
      view++;
      console.log("advanced view ->", view);
    } else if (cmd === "status")
      console.log(
        await (async () => ({
          node: NODE_ID,
          view,
          leader: leaderForView(view),
          peers: Array.from(peers.keys()),
          lastCommitted,
        }))()
      );
  });
}

start();
