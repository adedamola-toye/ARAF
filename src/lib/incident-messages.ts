/**
 * The five approved error messages: final product copy. Do not edit the wording.
 * Shown only for genuine technical failures, never for validation, permission or business-rule outcomes.
 * Message numbers (1–5) are what the incident service stores and allocates.
 */
export interface IncidentMessage {
  no: 1 | 2 | 3 | 4 | 5;
  name: string;
  emoji: string;
  headline: string;
  description: string;
}

export const INCIDENT_MESSAGES: readonly IncidentMessage[] = [
  {
    no: 1,
    name: "The Target Smasher",
    emoji: "🎯",
    headline: "An error? When you've got financial targets to smash? Unacceptable!",
    description: "Something went sideways, but don't sweat it. The Genius Digital Banking Team is on the case. There's no problem too big for us to solve. 😎",
  },
  {
    no: 2,
    name: "The Confident Genius",
    emoji: "🧠",
    headline: "A system error? Clearly, someone forgot we're built differently.",
    description: "A little technical drama has interrupted your flow. Fortunately, the Genius Digital Banking Team doesn't believe in impossible. We've got this. 🚀",
  },
  {
    no: 3,
    name: "The Banking Superhero",
    emoji: "⚡",
    headline: "Not today, error. We've got a bank to run!",
    description: "Something tried to slow us down. Cute attempt. The Genius Digital Banking Team is bringing the brilliance, because excellence doesn't take a day off.",
  },
  {
    no: 4,
    name: "The Audacious One",
    emoji: "👑",
    headline: "An unexpected error? That's a bold move for a system with our reputation.",
    description: "We hit a little turbulence, but ordinary problems don't intimidate extraordinary minds. The Genius Digital Banking Team is on the case. 😎",
  },
  {
    no: 5,
    name: "The Money Maker",
    emoji: "💰",
    headline: "Excuse us, error. There are billions waiting to be booked!",
    description: "We know you've got deals to close and targets to conquer. The Genius Digital Banking Team doesn't let a little technical hiccup stand between ambition and execution. 💼",
  },
] as const;

export const INCIDENT_FOOTER = "ARAF • Built for ambition. Powered by brilliance.";

export const messageByNo = (no: number): IncidentMessage => INCIDENT_MESSAGES.find((m) => m.no === no) ?? INCIDENT_MESSAGES[0];

/**
 * Local fallback when the incident service cannot be reached (for example, the database is down):
 * a stable pick from the error's digest so a refresh shows the same message. Not coordinated.
 */
export function fallbackMessageNo(seed: string | undefined | null): IncidentMessage["no"] {
  let h = 0;
  for (const c of seed ?? "") h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ((h % 5) + 1) as IncidentMessage["no"];
}

export type IncidentStatus = "DETECTED" | "INVESTIGATING" | "RESOLVED" | "CLOSED";

/** What the user sees for an incident: the shared reference plus their own message. */
export interface IncidentView {
  ref: string | null;
  messageNo: IncidentMessage["no"];
  status: IncidentStatus | "UNRECORDED";
  /** A factual line about where the incident stands; never claims more than is true. */
  statusLabel: string;
  routed: boolean;
}

export function statusLabel(status: IncidentView["status"], routed: boolean): string {
  switch (status) {
    case "INVESTIGATING":
      return "The Digital Banking Team has acknowledged this issue and is investigating.";
    case "RESOLVED":
    case "CLOSED":
      return "This issue has been resolved. You can try again.";
    case "DETECTED":
      return routed ? "Issue detected and reported to the Digital Banking Team." : "Issue detected.";
    default:
      return "Issue detected. We could not record it just now; quote the time and what you were doing if you contact support.";
  }
}
