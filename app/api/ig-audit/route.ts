// app/api/ig-audit/route.ts
import { NextRequest, NextResponse } from "next/server";
import { ApifyClient } from "apify-client";
import OpenAI from "openai";

export const runtime = "nodejs";

/* ---------- Clients ---------- */
const apify = new ApifyClient({ token: process.env.APIFY_TOKEN });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------- CORS (only if Unbounce calls API directly) ---------- */
const ALLOWED_ORIGINS = [
  "https://yourpage.unbouncepages.com",
  "https://go.yourbrand.com",
];
function corsHeaders(origin?: string) {
  const ok = origin && ALLOWED_ORIGINS.includes(origin);
  const h = new Headers();
  if (ok) h.set("Access-Control-Allow-Origin", origin);
  h.set("Vary", "Origin");
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  return h;
}
export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin") || undefined) });
}

/* ---------- Tiny rate limit + cache ---------- */
type CacheEntry = { at: number; payload: any };
const CACHE = new Map<string, CacheEntry>();
const TTL_MS = 10 * 60 * 1000;

const RATE = new Map<string, { count: number; windowStart: number }>();
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 20;

function clientIp(req: NextRequest) {
  const xf = req.headers.get("x-forwarded-for") || "";
  return xf.split(",")[0].trim() || "unknown";
}
function checkRate(req: NextRequest) {
  const ip = clientIp(req);
  const now = Date.now();
  const cur = RATE.get(ip) || { count: 0, windowStart: now };
  if (now - cur.windowStart > WINDOW_MS) {
    RATE.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (cur.count + 1 > MAX_PER_WINDOW) return false;
  cur.count += 1;
  RATE.set(ip, cur);
  return true;
}

/* ---------- Scoring ---------- */
const WEIGHTS: Record<string, number> = {
  Hook: 0.30,
  Retention: 0.25,
  Visuals: 0.20,
  Pacing: 0.15,
  Caption: 0.10,
};
function computeOverall(criteria: Array<{ name: string; score: number }>) {
  let total = 0, sum = 0;
  for (const c of criteria) {
    const w = WEIGHTS[c.name] ?? 0;
    const s = Math.max(0, Math.min(10, Number(c.score || 0)));
    total += (s / 10) * 100 * w;
    sum += w;
  }
  return sum ? Math.round(total / sum) : 0;
}

/* ---------- Helpers ---------- */
function normaliseUsername(input: string) {
  return input.trim().replace(/^@+/, "");
}
type IgItem = {
  url?: string;
  shortCode?: string;
  caption?: string;
  likesCount?: number;
  commentsCount?: number;
  displayUrl?: string;
  timestamp?: string | number;
  type?: string;
  videoViewCount?: number;
};
function toMillis(ts: any): number {
  if (!ts) return 0;
  if (typeof ts === "number") return ts * (ts < 2e10 ? 1000 : 1);
  const n = Date.parse(String(ts));
  return Number.isFinite(n) ? n : 0;
}
function pickNewest(items: IgItem[] = []): IgItem | null {
  if (!items.length) return null;
  return items.slice().sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp))[0] || items[0];
}

/* ---------- JSON schema (strict) ---------- */
const AUDIT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    overall: {
      type: "object",
      additionalProperties: false,
      properties: {
        verdict: { type: "string", minLength: 3, maxLength: 160 },
        score_explanation: { type: "string", minLength: 3, maxLength: 400 },
        score: { type: "integer", minimum: 0, maximum: 100 }
      },
      // strict mode: every key in properties must be required
      required: ["verdict", "score_explanation", "score"]
    },
    criteria: {
      type: "array",
      minItems: 5,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", enum: ["Hook", "Pacing", "Visuals", "Caption", "Retention"] },
          score: { type: "number", minimum: 0, maximum: 10 },
          rationale: { type: "string", minLength: 5, maxLength: 400 },
          examples: {
            type: "array",
            items: { type: "string", minLength: 3, maxLength: 120 },
            minItems: 0, maxItems: 5
          }
        },
        // strict mode: include every key defined above
        required: ["name", "score", "rationale", "examples"]
      }
    },
    checklist: {
      type: "array",
      minItems: 5,
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          item: { type: "string", minLength: 3, maxLength: 140 },
          done: { type: "boolean" }
        },
        required: ["item", "done"]
      }
    },
    next_post_template: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 3, maxLength: 120 },
        script: {
          type: "array",
          minItems: 3,
          maxItems: 8,
          items: { type: "string", minLength: 3, maxLength: 240 }
        }
      },
      required: ["title", "script"]
    }
  },
  required: ["overall", "criteria", "checklist", "next_post_template"]
} as const;

/* ---------- POST ---------- */
export async function POST(req: NextRequest) {
  const headers = corsHeaders(req.headers.get("origin") || undefined);

  try {
    if (!checkRate(req)) {
      const res = NextResponse.json({ error: "Rate limit" }, { status: 429 });
      headers.forEach((v, k) => res.headers.set(k, v));
      return res;
    }

    const { username, email, preferReels } = await req.json();
    if (!username || !email) {
      const res = NextResponse.json({ error: "Missing fields" }, { status: 400 });
      headers.forEach((v, k) => res.headers.set(k, v));
      return res;
    }

    const handle = normaliseUsername(username);
    const cacheKey = `u:${handle}:${preferReels ? "reels" : "posts"}`;

    const cached = CACHE.get(cacheKey);
    if (cached && Date.now() - cached.at < TTL_MS) {
      const r = NextResponse.json(cached.payload);
      headers.forEach((v, k) => r.headers.set(k, v));
      return r;
    }

    // Apify: official actor
    const actorId = process.env.APIFY_ACTOR_ID || "apify/instagram-scraper";
    const input: Record<string, any> = {
      directUrls: [`https://www.instagram.com/${handle}/`],
      resultsType: "posts",
      resultsLimit: 5
    };
    if (preferReels) input.isUserReelFeedURL = true;

    const run = await apify.actor(actorId).call(input);
    const dsId = run.defaultDatasetId;
    const { items } = await apify.dataset(dsId).listItems({ limit: 50 });

    if (!items?.length) {
      const res = NextResponse.json({ error: "No posts found for this username." }, { status: 404 });
      headers.forEach((v, k) => res.headers.set(k, v));
      return res;
    }

    const newest = pickNewest(items as IgItem[]);
    if (!newest) {
      const res = NextResponse.json({ error: "No recent post available." }, { status: 404 });
      headers.forEach((v, k) => res.headers.set(k, v));
      return res;
    }

    const postSummary = {
      username: handle,
      caption: newest.caption ?? "",
      likes: newest.likesCount ?? null,
      comments: newest.commentsCount ?? null,
      plays: newest.videoViewCount ?? null,
      postUrl: newest.url ?? (newest.shortCode ? `https://www.instagram.com/p/${newest.shortCode}/` : null),
      mediaUrl: newest.displayUrl ?? null,
      timestamp: newest.timestamp ?? null,
      type: newest.type ?? null
    };

    /* ---------- OpenAI Responses with strict structured output ---------- */
    const ai = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: "You are a ruthless but helpful short-form coach. Keep it precise and actionable." },
        {
          role: "user",
          content: [
            { type: "input_text", text: "Audit this Instagram post. Score five criteria. Be direct and actionable. Output strict JSON." },
            { type: "input_text", text: JSON.stringify(postSummary) }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "ig_audit",
          schema: AUDIT_JSON_SCHEMA, // strict schema
          strict: true
        }
      },
      max_output_tokens: 900
    });

    // Extract model text and parse JSON
    let audit: any;
    try {
      const raw =
        (ai as any).output_text ??
        (ai as any).output?.[0]?.content?.[0]?.text ??
        "";
      audit = raw ? JSON.parse(raw) : {};
    } catch {
      audit = {};
    }

    // Enforce weighted overall score
    audit.overall = {
      verdict: audit.overall?.verdict || "No verdict.",
      score_explanation: audit.overall?.score_explanation || "Weighted average of category scores.",
      score: computeOverall(audit.criteria || [])
    };

    const payload = { ok: true, post: postSummary, audit, email };
    CACHE.set(cacheKey, { at: Date.now(), payload });

    const r = NextResponse.json(payload);
    headers.forEach((v, k) => r.headers.set(k, v));
    return r;
  } catch (err: any) {
    const res = NextResponse.json({ error: err?.message || "Server error" }, { status: 500 });
    headers.forEach((v, k) => res.headers.set(k, v));
    return res;
  }
}
