import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor } from "@/server/demo/scenario";
import { applyConfig, createRetailCase, syntheticConfig } from "@/server/demo/retail-scenario";
import { retailReadiness } from "@/server/domain/retail";
import { locationActivity, rmOriginationLocations, saveLocation } from "@/server/domain/locations";

const N = (n: number) => n * 100;
const SIX = ["AltLounge Allen Lagos 1", "AltLounge Alaba Lagos", "AltLounge Jericho Ibadan", "AltLounge Tanke Ilorin", "Altbank Kano", "Altbank Abuja"];

beforeEach(async () => {
  await resetDb();
  await applyConfig("VENDOR_FINANCING", syntheticConfig("VENDOR_FINANCING"));
});

describe("origination locations", () => {
  it("seeds the six Branch / AltLounge locations once, all selectable by RMs", async () => {
    const rows = (await db.query("SELECT name, state, outlet_type, business_unit, active, rm_origination FROM locations WHERE name = ANY($1)", [SIX])).rows;
    expect(rows.map((r) => r.name).sort()).toEqual([...SIX].sort());
    expect(rows.every((r) => r.active && r.rm_origination)).toBe(true);
    expect(rows.find((r) => r.name === "AltLounge Tanke Ilorin")).toMatchObject({ state: "KWARA", outlet_type: "ALTLOUNGE" });
    expect(rows.find((r) => r.name === "Altbank Kano")).toMatchObject({ outlet_type: "BRANCH" });
    expect((await rmOriginationLocations(db)).map((l) => l.name)).toEqual(expect.arrayContaining(SIX));
  });

  it("an RM must choose an active location; it is stored on the request and reported against", async () => {
    const id = await createRetailCase({ channel: "RM", product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: N(2_000_000), tenorMonths: 12, data: { originationLocationId: null }, submit: false });
    expect((await retailReadiness(db, id, new Date())).fieldErrors.originationLocationId).toMatch(/location you are originating/);
    const ilorin = (await db.query("SELECT id FROM locations WHERE name = 'AltLounge Tanke Ilorin'")).rows[0].id;
    const id2 = await createRetailCase({ channel: "RM", product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: N(2_000_000), tenorMonths: 12, data: { originationLocationId: ilorin } });
    expect((await db.query("SELECT origination_location_id FROM applications WHERE id = $1", [id2])).rows[0].origination_location_id).toBe(ilorin);
    const act = await locationActivity(db, ilorin);
    expect(act.applications.map((a) => a.id)).toContain(id2);
    expect(act.rms.length).toBe(1);
  });

  it("a deactivated location can no longer be chosen, but stays on past requests; changes are audited", async () => {
    const admin = await ctxFor("superadmin@altbank.ng");
    const kano = (await db.query("SELECT * FROM locations WHERE name = 'Altbank Kano'")).rows[0];
    const used = await createRetailCase({ channel: "RM", product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: N(2_000_000), tenorMonths: 12, data: { originationLocationId: kano.id } });
    await saveLocation(admin, { id: kano.id, state: kano.state, city: kano.city, outletType: kano.outlet_type, name: kano.name, businessUnit: "Retail", rmOrigination: true, active: false });
    expect((await rmOriginationLocations(db)).map((l) => l.name)).not.toContain("Altbank Kano");
    expect((await db.query("SELECT origination_location_id FROM applications WHERE id = $1", [used])).rows[0].origination_location_id).toBe(kano.id);
    const draft = await createRetailCase({ channel: "RM", product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: N(2_000_000), tenorMonths: 12, data: { originationLocationId: kano.id }, submit: false }).catch((e) => e);
    if (typeof draft === "string") expect((await retailReadiness(db, draft, new Date())).fieldErrors.originationLocationId).toBeTruthy();
    else expect(draft.fields?.originationLocationId ?? draft.message).toBeTruthy();
    const hist = (await locationActivity(db, kano.id)).history;
    expect(hist[0]).toMatchObject({ action: "LOCATION_UPDATED" });
    expect(hist[0].details.after).toMatchObject({ active: false });
  });

  it("only a Super Admin can add a location", async () => {
    const rm = await ctxFor("rm.bola@altbank.ng");
    await expect(saveLocation(rm, { state: "LAGOS", city: "Lagos", outletType: "ALTLOUNGE", name: "AltLounge Lekki", active: true })).rejects.toBeTruthy();
    const admin = await ctxFor("superadmin@altbank.ng");
    await saveLocation(admin, { state: "LAGOS", city: "Lagos", outletType: "ALTLOUNGE", name: "AltLounge Lekki", businessUnit: "Retail", rmOrigination: true, active: true });
    expect((await rmOriginationLocations(db)).map((l) => l.name)).toContain("AltLounge Lekki");
  });
});
