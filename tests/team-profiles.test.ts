import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor } from "@/server/demo/scenario";
import { designateEditor, editTeamMemberProfile, teamMembers } from "@/server/domain/team-profiles";

beforeEach(resetDb);

const id = async (email: string) => (await db.query("SELECT id FROM staff WHERE email = $1", [email])).rows[0].id as string;

/** A Team Lead and an RM in the same team, and an RM in another team. */
async function setup() {
  const tl = (await db.query("SELECT s.id, s.email FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.active AND ra.role = 'TEAM_LEAD' WHERE s.status = 'ACTIVE' LIMIT 1")).rows[0];
  const rm = await id("rm.ade@altbank.ng");
  const other = await id("rm.bola@altbank.ng");
  await db.query("UPDATE role_assignments SET team = 'T-ALPHA' WHERE staff_id = $1 AND role = 'TEAM_LEAD' AND active", [tl.id]);
  await db.query("UPDATE role_assignments SET team = 'T-ALPHA' WHERE staff_id = $1 AND role = 'RM' AND active", [rm]);
  await db.query("UPDATE role_assignments SET team = 'T-BETA' WHERE staff_id = $1 AND role = 'RM' AND active", [other]);
  return { tl, rm, other };
}

describe("Team Lead scoped profile editing", () => {
  it("only a designated Team Lead edits, only their own team, only name and business unit", async () => {
    const { tl, rm, other } = await setup();
    const ctx = await ctxFor(tl.email);
    await expect(editTeamMemberProfile(ctx, rm, { fullName: "Ade Okafor-Bello", businessUnit: "Retail" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(designateEditor(ctx, tl.id, true, "Trying to designate myself")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await designateEditor(await ctxFor("superadmin@altbank.ng"), tl.id, true, "Team Lead for profile corrections");
    expect((await teamMembers(db, tl.id)).map((m) => m.id)).toContain(rm);
    await editTeamMemberProfile(ctx, rm, { fullName: "Ade Okafor-Bello", businessUnit: "Retail" });
    expect((await db.query("SELECT full_name, business_unit FROM staff WHERE id = $1", [rm])).rows[0]).toEqual({ full_name: "Ade Okafor-Bello", business_unit: "Retail" });
    await expect(editTeamMemberProfile(ctx, other, { fullName: "Someone Else", businessUnit: "" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(editTeamMemberProfile(ctx, tl.id, { fullName: "Me Myself", businessUnit: "" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const a = (await db.query("SELECT actor_role, details FROM audit_events WHERE action = 'STAFF_UPDATED' ORDER BY id DESC LIMIT 1")).rows[0];
    expect(a.actor_role).toBe("TEAM_LEAD");
    expect(a.details.before.fullName).not.toBe("Ade Okafor-Bello");
    // Revoked: no further edits.
    await designateEditor(await ctxFor("superadmin@altbank.ng"), tl.id, false, "No longer needed");
    await expect(editTeamMemberProfile(ctx, rm, { fullName: "Ade Okafor", businessUnit: "Retail" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
