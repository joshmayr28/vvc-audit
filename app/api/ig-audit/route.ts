// app/api/ig-audit/route.ts
import { NextRequest, NextResponse } from "next/server";
import { ApifyClient } from "apify-client";
import OpenAI from "openai";

export const runtime = "nodejs";

// Apify and OpenAI clients
const apify = new ApifyClient({ token: process.env.APIFY_TOKEN });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// CORS whitelist for direct cross origin calls if you ever hit the API from Unbounce
const ALLOWED_ORIGINS = [
  "https://yourpage.unbouncepages.com",
  "https://go.yourbrand.com"
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

// Simple in memory cache by username for 10 minutes
type CacheEntry = { at: number; payload: any };
const CACHE = new Map<string, CacheEntry>();
const TTL_MS = 10 * 60 * 1000;

// Lightweight IP rate limit
const RATE = new Map<string, { count: number; windowStart: number }>();
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 20;

function getClientIp(req: NextRequest) {
  const xf = req.headers.get("x-forwarded-for") || "";
  return xf.split(",")[0].trim() || "unknown";
}

function checkRate(req: NextRequest) {
  const ip = getClientIp(req);
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

// Weights and scoring
const WEIGHTS: Record<string, number> = {
  Hook: 0.30,
  Retention: 0.25,
  Visuals: 0.20,
  Pacing: 0.15,
  Caption: 0.10,
};

function computeOverall(criteria: Array<{ name: string; score: number }>) {
  let total = 0;
  let sum = 0;
  for (const c of criteria) {
    const w = WEIGHTS[c.name] ?? 0;
    const s = Math.max(0, Math.min(10, Number(c.score || 0)));
    total += (s / 10) * 100 * w;
    sum += w;
  }
  return sum ? Math.round(total / sum) : 0;
}

type IgPost = {
  caption?: string;
  text?: string;
  likes?: number;
  commentsCount?: number;
  playCount?: number;
  url?: string;
  shortcode?: string;
  videoUrl?: string;
  imageUrl?: string;
  timestamp?: string | number;
  taken_at_timestamp?: number;
};

function normaliseUsername(input: string) {
  return input.trim().replace(/^@+/, "");
}

function pickNewest(items: IgPost[] = []): IgPost | null {
  if (!items.length) return null;
  return items.slice().sort((a, b) => {
    const ta = Number(a.taken_at_timestamp ?? a.timestamp ?? 0);
    const tb = Number(b.taken_at_timestamp ?? b.timestamp ?? 0);
    return tb - ta;
  })[0] || items[0];
}

// Strict JSON schema for model output
const AUDIT_SCHEMA = {
  name: "ig_audit",
  schema: {
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
        required: ["verdict", "score"]
      },
      criteria: {
        type: "array",
        minItems: 5,
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", enum: ["Hook","Pacing","Visuals","Caption","Retention"] },
            score: { type: "number", minimum: 0, maximum: 10 },
            rationale: { type: "string", minLength: 5, maxLength: 400 },
            examples: {
              type: "array",
              items: { type: "string", minLength: 3, maxLength: 120 },
              minItems: 0,
              maxItems: 5
            }
          },
          required: ["name","score","rationale"]
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
          required: ["item","done"]
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
        required: ["title","script"]
      }
    },
    required: ["overall","criteria","checklist","next_post_template"]
  },
  strict: true
} as const;

export async function POST(req: NextRequest) {
  const headers = corsHeaders(req.headers.get("origin") || undefined);
  try {
    if (!checkRate(req)) {
      const res = NextResponse.json({ error: "Rate limit" }, { status: 429 });
      headers.forEach((v, k) => res.headers.set(k, v));
      return res;
    }

    const { username, email } = await req.json();
    if (!username || !email) {
      const res = NextResponse.json({ error: "Missing fields" }, { status: 400 });
      headers.forEach((v, k) => res.headers.set(k, v));
      return res;
    }

    const handle = normaliseUsername(username);

    // Serve from cache if fresh
    const key = `u:${handle}`;
    const cached = CACHE.get(key);
    if (cached && Date.now() - cached.at < TTL_MS) {
      const res = NextResponse.json(cached.payload);
      headers.forEach((v, k) => res.headers.set(k, v));
      return res;
    }

    // Run Apify actor
    const actorId = process.env.APIFY_ACTOR_ID;
    if (!actorId) {
      const res = NextResponse.json({ error: "APIFY_ACTOR_ID not set" }, { status: 500 });
      headers.forEach((v, k) => res.headers.set(k, v));
      return res;
    }

    const run = await apify.actor(actorId).call({
      action: "scrapePostsOfUser",
      scrapePostsOfUser: { profile: handle },
      count: 3,
      proxy: { useApifyProxy: true }
    });

    const dsId = run.defaultDatasetId;
    const { items } = await apify.dataset(dsId).listItems({ limit: 10 });
    const newest = pickNewest(items as IgPost[]);
    if (!newest) {
      const res = NextResponse.json({ error: "No posts found for this username." }, { status: 404 });
      headers.forEach((v, k) => res.headers.set(k, v));
      return res;
    }

    const postSummary = {
      username: handle,
      caption: newest.caption ?? newest.text ?? "",
      likes: newest.likes ?? null,
      comments: newest.commentsCount ?? null,
      plays: newest.playCount ?? null,
      postUrl: newest.url ?? (newest.shortcode ? `https://www.instagram.com/p/${newest.shortcode}` : null),
      mediaUrl: newest.videoUrl ?? newest.imageUrl ?? null,
      timestamp: typeof newest.taken_at_timestamp === "number"
        ? new Date(newest.taken_at_timestamp * 1000).toISOString()
        : (typeof newest.timestamp === "number"
            ? new Date(Number(newest.timestamp) * 1000).toISOString()
            : (newest.timestamp as string | null)) ?? null
    };

    // OpenAI structured audit
    const prompt = "Audit this Instagram Reel. Score five criteria. Be direct and actionable. Output strict JSON.";
    const ai = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: "You are a ruthless but helpful short form coach." },
        { role: "user", content: [
          { type: "input_text", text: prompt },
          { type: "input_text", text: JSON.stringify(postSummary) }
        ] }
      ],
      response_format: { type: "json_schema", json_schema: AUDIT_SCHEMA },
      max_output_tokens: 800
    });

    let audit: any;
    try { audit = JSON.parse(ai.output_text || "{}"); }
    catch { audit = JSON.parse((ai as any)?.output?.[0]?.content?.[0]?.text || "{}"); }

    // Enforce weighted overall score
    audit.overall = {
      verdict: audit.overall?.verdict || "No verdict.",
      score_explanation: audit.overall?.score_explanation || "Weighted average of category scores.",
      score: computeOverall(audit.criteria || [])
    };

    const payload = { ok: true, post: postSummary, audit, email };
    CACHE.set(key, { at: Date.now(), payload });

    const res = NextResponse.json(payload);
    headers.forEach((v, k) => res.headers.set(k, v));
    return res;
  } catch (err: any) {
    const res = NextResponse.json({ error: err?.message || "Server error" }, { status: 500 });
    headers.forEach((v, k) => res.headers.set(k, v));
    return res;
  }
}
