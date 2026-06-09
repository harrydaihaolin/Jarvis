// Tiny SSE event hub: lets the frontend "agent console" subscribe to a live feed
// of what the agent is doing (transcript, tool activity, citations, media).
//
// This is a SEPARATE channel from the OpenAI/Tavus path — the app connects to the
// proxy directly (localhost) and receives structured events broadcast here.

const clients = new Set();

/** Register an SSE response stream. Auto-removed on disconnect. */
export function addClient(res) {
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

/** Broadcast a structured event to every connected console. */
export function broadcast(event) {
  if (!clients.size) return;
  const line = `data: ${JSON.stringify({ ts: Date.now(), ...event })}\n\n`;
  for (const res of clients) {
    try {
      res.write(line);
    } catch {
      /* drop on write error; close handler will clean up */
    }
  }
}

export function clientCount() {
  return clients.size;
}
