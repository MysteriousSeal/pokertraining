import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Serves the browser-ready export of ai/checkpoints/best.pt.
 * Refresh the export with `npm run extension` after training a new checkpoint.
 */
export async function GET() {
  try {
    const file = path.join(process.cwd(), "extension", "model.json");
    const model = await readFile(file, "utf8");
    return new Response(model, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json(
      { error: "Model export not found. Run npm run extension to export ai/checkpoints/best.pt." },
      { status: 404 },
    );
  }
}
