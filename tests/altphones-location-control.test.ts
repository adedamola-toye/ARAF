import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor } from "@/server/demo/scenario";
import { ALT, CapturingMail, setupAltphones, submitCreditSale, TestBureau, TestGateway } from "@/server/demo/altphones-scenario";
import { setCreditBureauForTests, setPaymentGatewayForTests } from "@/server/altphones/integrations";
import { setMailTransportForTests } from "@/server/notify/transport";
import { bpmForLocation, bpmRegister, decideAddressRequest, decideBpmRequest, decideLocationStatus, pickerLocations, proposeLocation, requestBpmMapping, requestLocationStatus, resubmitAddressRequest } from "@/server/altphones/location-master";
import { saveLocation } from "@/server/domain/locations";

let gw: TestGateway;
let mail: CapturingMail;
beforeEach(async () => {
  await resetDb();
  gw = new TestGateway();
  setCreditBureauForTests(new TestBureau(700));
  setPaymentGatewayForTests(gw);
  mail = new CapturingMail();
  setMailTransportForTests(mail);
  await setupAltphones({ stock: 3 });
});
afterEach(() => {
  setCreditBureauForTests(undefined);
  setPaymentGatewayForTests(undefined);
  setMailTransportForTests(null);
});
const req = async (ref: string) => (await db.query("SELECT * FROM altphones_address_requests WHERE ref = $1", [ref])).rows[0];
const loc = async (id: string) => (await db.query("SELECT * FROM locations WHERE id = $1", [id])).rows[0];
async function addBpm(email: string, name: string) {
  const id = (await db.query("INSERT INTO staff (email, full_name, region, status) VALUES ($1,$2,'LAGOS','ACTIVE') RETURNING id", [email, name])).rows[0].id;
  await db.query("INSERT INTO role_assignments (staff_id, role, active) VALUES ($1,'BUSINESS_PERFORMANCE_MANAGER',true)", [id]);
  return id as string;
}

describe("new location: Product Manager → Unit Head → activation", () => {
  it("is inactive and not selectable until approved; approval activates it with its BPM and zero stock", async () => {
    const pm = await ctxFor(ALT.pm);
    const { ref, locationId } = await proposeLocation(pm, { state: "LAGOS", type: "ALTSHOP", name: "Synth New Altshop", address: "12 Synthetic Avenue, Ikeja, Lagos", bpmEmail: ALT.bpm, note: "New market outlet" });
    expect(await loc(locationId)).toMatchObject({ active: false, address_status: "MISSING" });
    expect((await pickerLocations(db, ["ALTSHOP"])).map((l) => l.id)).not.toContain(locationId);
    await expect(decideAddressRequest(pm, (await req(ref)).id, { decision: "APPROVE" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await decideAddressRequest(await ctxFor(ALT.unitHead), (await req(ref)).id, { decision: "APPROVE" });
    expect(await loc(locationId)).toMatchObject({ active: true, address_status: "REGISTERED", address: "12 Synthetic Avenue, Ikeja, Lagos" });
    expect((await pickerLocations(db, ["ALTSHOP"])).map((l) => l.id)).toContain(locationId);
    expect(await bpmForLocation(db, locationId)).toMatchObject({ email: ALT.bpm });
    expect((await db.query("SELECT coalesce(sum(physical),0)::int AS n FROM altphones_stock WHERE location_id = $1", [locationId])).rows[0].n).toBe(0);
  });

  it("can reuse an existing registered address, and can be returned for correction and resubmitted", async () => {
    const pm = await ctxFor(ALT.pm);
    const uh = await ctxFor(ALT.unitHead);
    const existing = (await db.query("SELECT id, address FROM locations WHERE address_status = 'REGISTERED' LIMIT 1")).rows[0];
    const { ref, locationId } = await proposeLocation(pm, { state: "LAGOS", type: "ALTBOX", name: "Synth Box Inside", addressFrom: existing.id });
    expect((await req(ref)).address).toBe(existing.address);
    const r = await req(ref);
    await expect(decideAddressRequest(uh, r.id, { decision: "RETURN" })).rejects.toMatchObject({ code: "VALIDATION" });
    await decideAddressRequest(uh, r.id, { decision: "RETURN", note: "Map the Lagos BPM before activation" });
    expect((await req(ref)).status).toBe("RETURNED");
    await resubmitAddressRequest(pm, r.id, { bpmEmail: ALT.bpm, note: "BPM added" });
    await decideAddressRequest(uh, r.id, { decision: "APPROVE" });
    expect(await loc(locationId)).toMatchObject({ active: true });
    expect(await bpmForLocation(db, locationId)).toMatchObject({ email: ALT.bpm });
  });

  it("a Branch never gets a BPM; a non-BPM cannot be chosen", async () => {
    const pm = await ctxFor(ALT.pm);
    await expect(proposeLocation(pm, { state: "LAGOS", type: "BRANCH", name: "Synth Branch", address: "1 Branch Road, Lagos Island", bpmEmail: ALT.bpm })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(proposeLocation(pm, { state: "LAGOS", type: "ALTSHOP", name: "Synth Shop", address: "1 Branch Road, Lagos Island", bpmEmail: ALT.pm })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("the Super Admin location form cannot create or reactivate an Altshop or Altbox", async () => {
    const admin = await ctxFor(ALT.admin);
    await expect(saveLocation(admin, { state: "LAGOS", city: "Lagos", outletType: "ALTSHOP", name: "Bypass Shop", active: true })).rejects.toMatchObject({ code: "GATE" });
  });
});

describe("activation and deactivation need the Unit Head", () => {
  it("deactivation removes the location from new sales; reactivation restores it", async () => {
    const pm = await ctxFor(ALT.pm);
    const uh = await ctxFor(ALT.unitHead);
    const shop = (await db.query("SELECT id FROM locations WHERE active AND outlet_type = 'ALTSHOP' AND address_status = 'REGISTERED' LIMIT 1")).rows[0].id;
    await expect(requestLocationStatus(pm, { locationId: shop, action: "DEACTIVATE", note: "" })).rejects.toMatchObject({ code: "VALIDATION" });
    const { ref } = await requestLocationStatus(pm, { locationId: shop, action: "DEACTIVATE", note: "Shop closed for renovation" });
    const id = (await db.query("SELECT id FROM altphones_location_status_requests WHERE ref = $1", [ref])).rows[0].id;
    expect((await loc(shop)).active).toBe(true); // nothing changes before approval
    await decideLocationStatus(uh, id, { decision: "APPROVE" });
    expect((await loc(shop)).active).toBe(false);
    expect((await pickerLocations(db, ["ALTSHOP"])).map((l) => l.id)).not.toContain(shop);
    const back = await requestLocationStatus(pm, { locationId: shop, action: "REACTIVATE", note: "Renovation finished" });
    await decideLocationStatus(uh, (await db.query("SELECT id FROM altphones_location_status_requests WHERE ref = $1", [back.ref])).rows[0].id, { decision: "APPROVE" });
    expect((await loc(shop)).active).toBe(true);
  });
});

describe("BPM register and reassignment", () => {
  it("lists BPMs with verification and coverage; an in-flight sale keeps its BPM when the mapping changes", async () => {
    const id = await submitCreditSale(gw, mail, "SA");
    const before = (await db.query("SELECT routed_bpm_id, origin_location_id FROM altphones_applications WHERE id = $1", [id])).rows[0];
    expect(before.routed_bpm_id).toBeTruthy();
    const other = await addBpm("bpm.three@altbank.ng", "Third Synthetic BPM");
    const pm = await ctxFor(ALT.pm);
    const { ref } = await requestBpmMapping(pm, { scope: "LOCATION", locationId: before.origin_location_id, email: "bpm.three@altbank.ng", note: "Reassigned to the new BPM" });
    await decideBpmRequest(await ctxFor(ALT.unitHead), (await db.query("SELECT id FROM altphones_bpm_requests WHERE ref = $1", [ref])).rows[0].id, { decision: "APPROVE" });
    // The existing application keeps the BPM it was routed to; new sales use the new mapping.
    expect((await db.query("SELECT routed_bpm_id FROM altphones_applications WHERE id = $1", [id])).rows[0].routed_bpm_id).toBe(before.routed_bpm_id);
    expect((await bpmForLocation(db, before.origin_location_id)).id).toBe(other);
    const reg = await bpmRegister(db);
    expect(reg.find((b) => b.email === "bpm.three@altbank.ng")).toMatchObject({ verified: true });
    expect(reg.find((b) => b.email === "bpm.three@altbank.ng")!.locations.length).toBe(1);
  });
});
