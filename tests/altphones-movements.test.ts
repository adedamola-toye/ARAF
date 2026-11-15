import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor } from "@/server/demo/scenario";
import { ALT, CapturingMail, setupAltphones, stockOf } from "@/server/demo/altphones-scenario";
import { setMailTransportForTests } from "@/server/notify/transport";
import { decideMovement, requestMovement } from "@/server/altphones/movements";
import { commitImport, previewImport, submitImport } from "@/server/altphones/imports";
import { bpmForLocation } from "@/server/altphones/location-master";

let models: string[] = [];
beforeEach(async () => {
  await resetDb();
  setMailTransportForTests(new CapturingMail());
  await setupAltphones({ stock: 5 });
  models = (await db.query("SELECT id FROM altphones_models WHERE NOT stock_pool ORDER BY name")).rows.map((r) => r.id);
});
afterEach(() => setMailTransportForTests(null));
const locId = async (name: string) => (await db.query("SELECT id FROM locations WHERE name = $1", [name])).rows[0].id as string;
const holder = async () => (await db.query("SELECT l.name, s.model_id FROM altphones_stock s JOIN locations l ON l.id = s.location_id WHERE s.physical >= 5 ORDER BY l.name LIMIT 1")).rows[0];

describe("stock movements (PM requests, Unit Head approves)", () => {
  it("a transfer moves units between locations only on approval; reserved units can never leave", async () => {
    const h = await holder();
    const dest = (await db.query("SELECT name FROM locations WHERE active AND outlet_type IN ('BRANCH','ALTSHOP') AND name <> $1 ORDER BY name LIMIT 1", [h.name])).rows[0].name;
    const pm = await ctxFor(ALT.pm);
    const fromBefore = await stockOf(h.name, h.model_id);
    const toBefore = await stockOf(dest, h.model_id);
    await expect(requestMovement(pm, { kind: "TRANSFER", locationId: await locId(h.name), toLocationId: await locId(dest), modelId: h.model_id, quantity: 999, note: "Too many units" })).rejects.toMatchObject({ code: "CONFLICT" });
    const { id } = await requestMovement(pm, { kind: "TRANSFER", locationId: await locId(h.name), toLocationId: await locId(dest), modelId: h.model_id, quantity: 2, note: "Waybill WB-001" });
    expect(await stockOf(h.name, h.model_id)).toEqual(fromBefore); // nothing yet
    await expect(decideMovement(pm, id, { decision: "APPROVE" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await decideMovement(await ctxFor(ALT.unitHead), id, { decision: "APPROVE" });
    expect((await stockOf(h.name, h.model_id)).physical).toBe(fromBefore.physical - 2);
    expect((await stockOf(dest, h.model_id)).physical).toBe(toBefore.physical + 2);
    const ledger = (await db.query("SELECT movement, physical_delta FROM altphones_stock_ledger WHERE reference = (SELECT ref FROM altphones_stock_movements WHERE id = $1) ORDER BY movement", [id])).rows;
    expect(ledger).toEqual([{ movement: "TRANSFER_IN", physical_delta: 2 }, { movement: "TRANSFER_OUT", physical_delta: -2 }]);
  });

  it("damaged write-offs and returns are posted on approval; rejection needs a reason and posts nothing", async () => {
    const h = await holder();
    const pm = await ctxFor(ALT.pm);
    const uh = await ctxFor(ALT.unitHead);
    const before = (await stockOf(h.name, h.model_id)).physical;
    const dmg = await requestMovement(pm, { kind: "DAMAGED", locationId: await locId(h.name), modelId: h.model_id, quantity: 1, note: "Screen cracked in transit" });
    await expect(decideMovement(uh, dmg.id, { decision: "REJECT" })).rejects.toMatchObject({ code: "VALIDATION" });
    await decideMovement(uh, dmg.id, { decision: "APPROVE" });
    const ret = await requestMovement(pm, { kind: "RETURN", locationId: await locId(h.name), modelId: h.model_id, quantity: 1, note: "Repaired unit returned" });
    await decideMovement(uh, ret.id, { decision: "REJECT", note: "No repair report attached" });
    expect((await stockOf(h.name, h.model_id)).physical).toBe(before - 1);
  });
});

describe("CSV: BPM mapping and stock reconciliation (Unit Head approves)", () => {
  it("maps only verified BPMs, never creates profiles, and posts count variances", async () => {
    const admin = await ctxFor(ALT.admin);
    const uh = await ctxFor(ALT.unitHead);
    const bad = await previewImport(admin, "BPM_STATES", "bpm.csv", Buffer.from(`Name,Email,States covered\nGhost,ghost.person@altbank.ng,KANO\nDemo,${ALT.bpm},KANO; NOWHERELAND\n`));
    expect(bad.summary).toMatchObject({ valid: 0, errors: 2 });
    expect((await db.query("SELECT 1 FROM staff WHERE email = 'ghost.person@altbank.ng'")).rowCount).toBe(0);
    const good = await previewImport(admin, "BPM_STATES", "bpm2.csv", Buffer.from(`Name,Email,States covered\nDemo,${ALT.bpm},KANO; KADUNA\n`));
    await submitImport(admin, good.id);
    await commitImport(uh, good.id);
    expect((await db.query("SELECT state FROM altphones_bpm_states WHERE bpm_email = $1 AND state IN ('KANO','KADUNA') ORDER BY state", [ALT.bpm])).rows.map((r) => r.state)).toEqual(["KADUNA", "KANO"]);
    const box = (await db.query("SELECT id, name FROM locations WHERE outlet_type = 'ALTBOX' LIMIT 1")).rows[0];
    const lm = await previewImport(admin, "BPM_LOCATIONS", "loc.csv", Buffer.from(`Location,BPM email,Note\n"${box.name}",${ALT.bpm},Nearest BPM\n`));
    await submitImport(admin, lm.id);
    await commitImport(uh, lm.id);
    expect(await bpmForLocation(db, box.id)).toMatchObject({ email: ALT.bpm });
    const h = await holder();
    const before = (await stockOf(h.name, h.model_id)).physical;
    const model = (await db.query("SELECT name FROM altphones_models WHERE id = $1", [h.model_id])).rows[0].name;
    const cnt = await previewImport(admin, "STOCK_COUNT", "count.csv", Buffer.from(`Location,Phone model,Counted quantity,Count date,Note\n"${h.name}","${model}",${before - 1},2026-11-14,Month-end\n`));
    expect(cnt.summary).toMatchObject({ valid: 1, errors: 0 });
    await submitImport(admin, cnt.id);
    await commitImport(uh, cnt.id);
    expect((await stockOf(h.name, h.model_id)).physical).toBe(before - 1);
  });
});
