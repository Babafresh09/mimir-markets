/**
 * GET /api/vs/[id]/reasoning — the public agent reasoning timeline for a claim.
 *
 * Free and public: the summary, position, confidence, uncertainty and evidence
 * references. The x402 premium tier sells the persona's full take
 * (/api/council/reasoning), not this feed.
 *
 * Withheld and tombstoned events are excluded by the query, so an event that
 * tripped the safety pass never reaches a reader — while remaining in the table
 * as the audit trail.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getReasoningFeed } from "@/lib/db";
import { isReasoningStage, type EvidenceRef } from "@/lib/reasoning/schema";
import { REASONING_TRACKS } from "@/lib/research/categories";
import { AGENT_ID_PATTERN } from "@/lib/agents/registry";

export const dynamic = "force-dynamic";

const MAX_FILTER_LENGTH = 128;

interface FeedItem {
  eventId: string;
  agentId: string;
  track: string;
  stage: string;
  position: string;
  confidenceBps: number;
  summary: string;
  uncertainty: string;
  evidence: Array<{
    domain: string;
    url: string;
    capturedAt: number;
    contentHash: string;
    freshnessSeconds?: number;
    trustTier?: string;
  }>;
  model?: string;
  promptVersion?: number;
  /** True when this was published before the agent took a position with money. */
  beforeStake: boolean;
  createdAt: number;
}

export interface ReasoningFilters {
  track?: string;
  agentId?: string;
  stage?: string;
}

export type ReasoningFiltersParseResult =
  | { ok: true; filters: ReasoningFilters }
  | { ok: false; field: "track" | "agent" };

/**
 * Validate the `track`, `agent` and `stage` query parameters for the
 * reasoning feed. Returns the normalized filters or the offending field.
 */
export function parseReasoningFilters(searchParams: URLSearchParams): ReasoningFiltersParseResult {
  const trackParam = searchParams.get("track")?.trim();
  if (trackParam) {
    if (trackParam.length > MAX_FILTER_LENGTH || !REASONING_TRACKS.includes(trackParam)) {
      return { ok: false, field: "track" };
    }
  }

  const agentParam = searchParams.get("agent")?.trim();
  if (agentParam) {
    if (agentParam.length > MAX_FILTER_LENGTH || !AGENT_ID_PATTERN.test(agentParam)) {
      return { ok: false, field: "agent" };
    }
  }

  const stageParam = searchParams.get("stage")?.trim();
  const stage = stageParam && isReasoningStage(stageParam) ? stageParam : undefined;

  return {
    ok: true,
    filters: {
      track: trackParam || undefined,
      agentId: agentParam || undefined,
      stage,
    },
  };
}

function parseEvidence(json: string): EvidenceRef[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as EvidenceRef[]) : [];
  } catch {
    return [];
  }
}

function invalidRequest(field: string): NextResponse {
  return NextResponse.json(
    { error: "invalid_request", field },
    { status: 400 },
  );
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const claimId = Number(id);
  if (!Number.isInteger(claimId) || claimId < 1) {
    return NextResponse.json({ error: "invalid claim id" }, { status: 400 });
  }

  const parsed = parseReasoningFilters(req.nextUrl.searchParams);
  if (!parsed.ok) {
    return invalidRequest(parsed.field);
  }
  const { track, agentId, stage } = parsed.filters;

  try {
    const rows = await getReasoningFeed({ claimId, track, agentId, stage });
    const items: FeedItem[] = rows.map((row) => ({
      eventId: row.event_id,
      agentId: row.agent_id,
      track: row.track,
      stage: row.stage,
      position: row.position,
      confidenceBps: row.confidence_bps,
      summary: row.summary,
      uncertainty: row.uncertainty,
      evidence: parseEvidence(row.evidence_refs_json).map((ref) => ({
        domain: ref.domain,
        url: ref.url,
        capturedAt: ref.capturedAt,
        contentHash: ref.contentHash,
        freshnessSeconds: ref.freshnessSeconds,
        trustTier: ref.trustTier,
      })),
      model: row.model ?? undefined,
      promptVersion: row.prompt_version ?? undefined,
      // Lets the UI separate "explained itself first" from "explained itself
      // after committing money" without the client knowing the stage taxonomy.
      beforeStake: row.stage === "preflight" || row.stage === "pre_stake",
      createdAt: row.created_at,
    }));

    return NextResponse.json(
      { claimId, count: items.length, items },
      {
        headers: {
          // The feed grows slowly and is polled by the detail page.
          "cache-control": "s-maxage=15, stale-while-revalidate=60",
        },
      },
    );
  } catch (err) {
    // No Neon configured (or it is down) means no feed — not a broken page.
    const message = err instanceof Error ? err.message : "read failed";
    return NextResponse.json({ claimId, count: 0, items: [], error: message }, { status: 503 });
  }
}
