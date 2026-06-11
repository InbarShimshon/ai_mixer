// AI suggestions: given the current set + event context, ask Claude to propose
// additional songs that fit the vibe and flow. Returns [{ title, artist, reason }].
// The server then resolves each to a Spotify URI + analyzes BPM/key like any track.
import Anthropic from "@anthropic-ai/sdk";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          artist: { type: "string" },
          reason: { type: "string", description: "one short phrase: why it fits the set" },
        },
        required: ["title", "artist", "reason"],
      },
    },
  },
  required: ["suggestions"],
};

// tracks: [{ name, artist, bpm, camelot }]; context: free-text (e.g. "wedding party").
export async function suggestTracks(tracks, { context = "wedding party", count = 8 } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { error: "no_key", suggestions: [] };
  }
  const client = new Anthropic();
  const list = tracks
    .map((t) => `- ${t.name} — ${t.artist}${t.bpm ? ` (${t.bpm} BPM, ${t.camelot || "?"})` : ""}`)
    .join("\n");

  const prompt = `You are curating a ${context} playlist. Here is the current set, already ordered for harmonic flow:

${list}

Suggest ${count} more songs that would fit this ${context} — matching the overall vibe, era mix, and danceability, and filling any gaps so the floor stays full. Avoid songs already in the set. Prefer widely-known tracks that resolve cleanly on Spotify. For each, give the exact title and primary artist, plus a short reason it fits.`;

  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content.find((b) => b.type === "text")?.text || "{}";
  try {
    const parsed = JSON.parse(text);
    return { suggestions: parsed.suggestions || [] };
  } catch {
    return { error: "parse_failed", suggestions: [] };
  }
}
