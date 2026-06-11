// Fallback for tracks GetSongBPM doesn't have: ask Claude to estimate
// BPM, Camelot key, and energy so they can be ordered harmonically instead
// of sitting as an "unknown" block. Fills only tracks missing both bpm + key.
import Anthropic from "@anthropic-ai/sdk";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    tracks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          bpm: { type: "number" },
          camelot: { type: "string", description: "Camelot key, e.g. 8A or 5B" },
          energy: { type: "number", description: "0..1" },
        },
        required: ["bpm", "camelot", "energy"],
      },
    },
  },
  required: ["tracks"],
};

// Fills missing bpm/camelot/energy in-place for tracks lacking both. Returns the
// same array. No-op (leaves unknowns) if ANTHROPIC_API_KEY isn't set.
export async function fillMissing(tracks) {
  if (!process.env.ANTHROPIC_API_KEY) return tracks;
  const missing = tracks.filter((t) => !t.bpm && !t.camelot);
  if (!missing.length) return tracks;

  const list = missing.map((t, i) => `${i + 1}. ${t.name} — ${t.artist}`).join("\n");
  const prompt = `For each song below, give your best estimate of its tempo in BPM, its musical key in Camelot notation (e.g. "8A" for A minor, "8B" for C major), and its energy on a 0–1 scale (0 = mellow ballad, 1 = high-energy banger). Use your knowledge of these recordings; estimate if unsure. Return one entry per song in the SAME order.

${list}`;

  try {
    const client = new Anthropic();
    const res = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content.find((b) => b.type === "text")?.text || "{}";
    const est = JSON.parse(text).tracks || [];
    missing.forEach((t, i) => {
      const e = est[i];
      if (!e) return;
      t.bpm = e.bpm ?? null;
      t.camelot = (e.camelot || "").toUpperCase() || null;
      t.energy = typeof e.energy === "number" ? e.energy : null;
      t.source = "ai-estimate";
    });
  } catch {
    // leave them unknown on failure
  }
  return tracks;
}
