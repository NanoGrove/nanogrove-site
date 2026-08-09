// NanoGrove courtesy press — serverless demo button
// ---------------------------------------------------
// POST  { token: <turnstile token> }  → verifies human, checks rate
//       limits, sends 0.1 Ӿ from the courtesy pool to the grove.
// GET   → status only (is the button currently available?), no send.
//
// Env vars required (Netlify → Site settings → Environment variables):
//   POOL_SEED          64-char hex seed of the courtesy pool wallet (account 0)
//   TURNSTILE_SECRET   Cloudflare Turnstile secret key
// Optional overrides:
//   GROVE_ADDRESS      defaults to the grove's public address
//   PRESS_AMOUNT       defaults to "0.1" (Nano)
//   CAP_HOUR           defaults to 30   (global presses per hour)
//   CAP_DAY            defaults to 150  (global presses per day)
//   IP_WINDOW_HOURS    defaults to 24   (one press per IP per this window)

import { getStore } from "@netlify/blobs";
import { wallet, block, tools } from "nanocurrency-web";

const GROVE_ADDRESS =
  process.env.GROVE_ADDRESS ||
  "nano_3j7fu15do15jyq7qokwje5je175e6aiuaxiaza1duayzbgjk4zhneehqdp7o";
const POOL_SEED = process.env.POOL_SEED;
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET;
const PRESS_AMOUNT = process.env.PRESS_AMOUNT || "0.1";
const CAP_HOUR = parseInt(process.env.CAP_HOUR || "30", 10);
const CAP_DAY = parseInt(process.env.CAP_DAY || "150", 10);
const IP_WINDOW_HOURS = parseInt(process.env.IP_WINDOW_HOURS || "24", 10);

// Same node + work servers the Pi uses, with fallback
const RPC_URLS = ["https://app.natrium.io/api", "https://rpc.nano.to"];
const WORK_URLS = ["https://rainstorm.city/api", "https://rpc.nano.to"];
const SEND_DIFFICULTY = "fffffff800000000"; // send blocks need higher work than receives

// --- helpers -------------------------------------------------------------

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

async function rpc(urls, body) {
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j && !j.error) return j;
      if (j && j.error) console.log(`rpc ${url}: ${j.error}`);
    } catch (e) {
      console.log(`rpc ${url} failed: ${e.message}`);
    }
  }
  return null;
}

function timeKeys() {
  const now = new Date();
  const iso = now.toISOString(); // e.g. 2026-08-09T14:03:22.000Z
  return {
    now,
    hourKey: `global-hour-${iso.slice(0, 13)}`, // 2026-08-09T14
    dayKey: `global-day-${iso.slice(0, 10)}`, // 2026-08-09
  };
}

async function getCount(store, key) {
  const rec = await store.get(key, { type: "json" });
  return rec && typeof rec.n === "number" ? rec.n : 0;
}

async function poolInfo() {
  // Returns { frontier, balanceRaw, representative } or null
  const acct = wallet.fromLegacySeed(POOL_SEED).accounts[0];
  const info = await rpc(RPC_URLS, {
    action: "account_info",
    account: acct.address,
    representative: "true",
  });
  // Unopened account, missing rep, or RPC down → treat as unavailable.
  // (Opening the pool account happens once, in Nault, during setup.)
  if (!info || !info.frontier || !info.representative) return null;
  return {
    address: acct.address,
    privateKey: acct.privateKey,
    frontier: info.frontier,
    balanceRaw: info.balance,
    representative: info.representative,
  };
}

async function getWork(store, frontier) {
  // Cached-first work fetch. GET warms this cache so POST is fast.
  const cached = await store.get(`work-${frontier}`, { type: "json" });
  if (cached && cached.work) return cached.work;
  const result = await rpc(WORK_URLS, {
    action: "work_generate",
    hash: frontier,
    difficulty: SEND_DIFFICULTY,
  });
  if (!result || !result.work) return null;
  await store.setJSON(`work-${frontier}`, { work: result.work });
  return result.work;
}

// --- handler -------------------------------------------------------------

export default async (req, context) => {
  if (!POOL_SEED || !TURNSTILE_SECRET) {
    return json({ ok: false, reason: "not_configured" }, 500);
  }

  const store = getStore("courtesy");
  const { now, hourKey, dayKey } = timeKeys();
  const amountRaw = tools.convert(PRESS_AMOUNT, "NANO", "RAW");

  // ---- GET: status check for the front end (no send) --------------------
  if (req.method === "GET") {
    const [hourCount, dayCount, pool] = await Promise.all([
      getCount(store, hourKey),
      getCount(store, dayKey),
      poolInfo(),
    ]);
    const funded = pool && BigInt(pool.balanceRaw) >= BigInt(amountRaw);
    const capped = hourCount >= CAP_HOUR || dayCount >= CAP_DAY;
    const available = Boolean(funded && !capped);
    if (available) {
      // Warm the work cache now so the eventual POST answers fast.
      await getWork(store, pool.frontier);
    }
    return json({
      available,
      reason: available ? null : "pool_resting",
    });
  }

  if (req.method !== "POST") return json({ ok: false, reason: "method" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, reason: "bad_request" }, 400);
  }
  if (!body || !body.token) {
    return json({ ok: false, reason: "missing_token" }, 400);
  }

  const ip =
    req.headers.get("x-nf-client-connection-ip") || context.ip || "unknown";

  // ---- Layer 1: Turnstile — is this a human in a real browser? ----------
  let verify = null;
  try {
    const r = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret: TURNSTILE_SECRET,
          response: body.token,
          remoteip: ip,
        }),
      }
    );
    verify = await r.json();
  } catch (e) {
    console.log(`turnstile verify failed: ${e.message}`);
  }
  if (!verify || !verify.success) {
    return json({ ok: false, reason: "not_verified" }, 403);
  }

  // ---- Layer 2: one press per IP per window -----------------------------
  const ipKey = `ip-${ip}`;
  const ipRec = await store.get(ipKey, { type: "json" });
  if (ipRec && now.getTime() - ipRec.ts < IP_WINDOW_HOURS * 3600 * 1000) {
    return json({ ok: false, reason: "already_pressed" });
  }

  // ---- Layer 3: global caps (protects servo, hopper, pool) --------------
  const [hourCount, dayCount] = await Promise.all([
    getCount(store, hourKey),
    getCount(store, dayKey),
  ]);
  if (hourCount >= CAP_HOUR || dayCount >= CAP_DAY) {
    return json({ ok: false, reason: "pool_resting" });
  }

  // ---- Layer 4: pool balance is the hard ceiling ------------------------
  const pool = await poolInfo();
  if (!pool) return json({ ok: false, reason: "pool_resting" });
  if (BigInt(pool.balanceRaw) < BigInt(amountRaw)) {
    return json({ ok: false, reason: "pool_resting" });
  }

  // ---- Work for the send block (cached by GET whenever possible) --------
  const work = await getWork(store, pool.frontier);
  if (!work) {
    return json({ ok: false, reason: "work_failed" }, 502);
  }

  // ---- Sign and broadcast the send --------------------------------------
  const signed = block.send(
    {
      walletBalanceRaw: pool.balanceRaw,
      fromAddress: pool.address,
      toAddress: GROVE_ADDRESS,
      representativeAddress: pool.representative,
      frontier: pool.frontier,
      amountRaw: amountRaw,
    },
    pool.privateKey
  );
  signed.work = work;

  const proc = await rpc(RPC_URLS, {
    action: "process",
    json_block: "true",
    subtype: "send",
    block: signed,
  });
  if (!proc || !proc.hash) {
    return json({ ok: false, reason: "send_failed" }, 502);
  }

  // ---- Record the press (only after a confirmed send) -------------------
  await Promise.all([
    store.setJSON(ipKey, { ts: now.getTime() }),
    store.setJSON(hourKey, { n: hourCount + 1 }),
    store.setJSON(dayKey, { n: dayCount + 1 }),
    store.delete(`work-${pool.frontier}`), // spent — frontier has moved
  ]);

  console.log(`courtesy press ok: ${proc.hash} (ip window recorded)`);
  return json({ ok: true, hash: proc.hash });
};
