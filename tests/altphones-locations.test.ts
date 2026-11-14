import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor } from "@/server/demo/scenario";
import { ALT, CapturingMail, setupAltphones, sidOf, TestBureau, TestGateway } from "@/server/demo/altphones-scenario";
import { setCreditBureauForTests, setPaymentGatewayForTests } from "@/server/altphones/integrations";
import { setMailTransportForTests } from "@/server/notify/transport";
import { applyProfiling, bpmForLocation, decideAddressRequest, linkSource, parseStatesList, pickerLocations, previewProfiling, proposeLocation, readProfiling, requestAddress, requestBpmMapping, decideBpmRequest, unroutedStates } from "@/server/altphones/location-master";
import { saveLocations, startSale } from "@/server/altphones/origination";
import { decide } from "@/server/altphones/approvals";
import { appAccess } from "@/server/altphones/core";
import { reviewQueues } from "@/server/altphones/views";

// A synthetic profiling workbook in the shape of the team's file. Every name, email and address is made up.
async function workbook(extra?: (wb: ExcelJS.Workbook) => void) {
  const wb = new ExcelJS.Workbook();
  const dos = wb.addWorksheet("DELIGHT OFFICERS");
  dos.addRow(["LOCATION", "ADDRESS", "STATE", "DOs"]);
  dos.addRow(["IKEJA BRANCH", "1 Synthetic Way, Ikeja", "LAGOS", "Person A"]); // matches the demo Ikeja Branch
  dos.addRow(["SYNTH MINI BRANCH", "2 Synthetic Close, Jos", "JOS", "Person B"]); // new; JOS → PLATEAU
  const box = wb.addWorksheet("ALTBOX SAs");
  box.addRow(["Surname", "First Name", "Middle name", "State", "Location", "Addresses", "Official Email"]);
  box.addRow(["P", "Q", "", "Lagos", "Synth Market", "3 Market Road, Lagos", "sa1@example.com"]);
  box.addRow(["P", "R", "", "Lagos", "Synth Market", "3, Market Road Lagos", "sa2@example.com"]); // same address, written differently
  box.addRow(["P", "S", "", "Lagos", "Conflict Junction", "4 First Street", "sa3@example.com"]);
  box.addRow(["P", "T", "", "Lagos", "Conflict Junction", "99 Second Avenue", "sa4@example.com"]); // conflicting addresses
  box.addRow(["P", "U", "", "Kwara", "Nowhere Yet", "", "sa5@example.com"]); // no address
  const shop = wb.addWorksheet("ALTSHOP SAs");
  shop.addRow(["Surname", "First Name", "Middle name", "State", "Location", "Addresses", "Official Email"]);
  shop.addRow(["P", "V", "", "FCT", "Area Synth", "5 Synth Crescent, Abuja", "sa6@example.com"]);
  shop.addRow(["P", "W", "", "FCT SALES AGENT", "Area Synth", "5 Synth Crescent, Abuja", "sa7@example.com"]); // same place, other label
  const bpm = wb.addWorksheet("BPMs");
  bpm.addRow(["NAME", "EMAIL ADDRESS", "MAPPED ALTSHOP (STATE)"]);
  bpm.addRow(["Demo BPM", ALT.bpm, "Lagos and Ogun"]);
  bpm.addRow(["Someone Else", "not.yet.staff@altbank.ng", "Abuja, Niger and Plateau"]);
  extra?.(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

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
const locBy = async (name: string) => (await db.query("SELECT * FROM locations WHERE upper(name) = upper($1)", [name])).rows[0];

describe("reading the profiling workbook", () => {
  it("reads only locations, states and addresses, merging labels for the same place", async () => {
    const { entries, bpms } = await readProfiling(await workbook());
    const json = JSON.stringify(entries);
    expect(json).not.toMatch(/sa\d@example|Person A/); // no staff details are kept
    expect(entries.find((e) => e.sourceName === "SYNTH MARKET")).toMatchObject({ type: "ALTBOX", state: "LAGOS", rows: 2, addresses: ["3 Market Road, Lagos"] });
    expect(entries.find((e) => e.sourceName === "CONFLICT JUNCTION")!.addresses).toHaveLength(2);
    expect(entries.find((e) => e.sourceName === "SYNTH MINI BRANCH")).toMatchObject({ type: "BRANCH", state: "PLATEAU", sourceState: "JOS" });
    const area = entries.filter((e) => e.sourceName === "AREA SYNTH");
    expect(area).toHaveLength(1);
    expect(area[0]).toMatchObject({ state: "FCT (ABUJA)", rows: 2 });
    expect(area[0].labels.map((l) => l.state)).toEqual(["FCT", "FCT SALES AGENT"]);
    expect(bpms[0]).toMatchObject({ email: ALT.bpm, states: ["LAGOS", "OGUN"] });
    expect(parseStatesList("Edo, Port Harcourt and Uyo").states).toEqual(["EDO", "RIVERS", "AKWA IBOM"]);
  });
});

describe("importing into the location master", () => {
  it("previews, reconciles, and applies: registers addresses, flags missing and conflicting ones, maps BPMs; creates no staff", async () => {
    const pm = await ctxFor(ALT.pm);
    const staffBefore = (await db.query("SELECT count(*)::int AS n FROM staff")).rows[0].n;
    await expect(previewProfiling(await ctxFor(ALT.sa), { filename: "p.xlsx", data: await workbook() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const p = await previewProfiling(pm, { filename: "profiling.xlsx", data: await workbook() });
    const byType = Object.fromEntries(p.summary.byType.map((t) => [t.type, t]));
    expect(byType.BRANCH).toMatchObject({ entries: 2, matched: 1, new: 1 });
    expect(byType.ALTBOX).toMatchObject({ entries: 3, registered: 1, missing: 1, conflict: 1 });
    expect(p.summary.bpms.find((b) => b.email === ALT.bpm)).toMatchObject({ ready: true });
    expect(p.summary.bpms.find((b) => b.email === "not.yet.staff@altbank.ng")).toMatchObject({ ready: false, problem: expect.stringMatching(/Not set up/) });
    expect(p.summary.statesWithoutBpm).toContain("KWARA");
    // Nothing changes on preview.
    expect((await locBy("Ikeja Branch")).address).toMatch(/synthetic address/);
    expect(await locBy("SYNTH MARKET")).toBeUndefined();
    // Same workbook twice is refused.
    await expect(previewProfiling(pm, { filename: "again.xlsx", data: await workbook() })).rejects.toMatchObject({ code: "CONFLICT" });

    const r = await applyProfiling(pm, p.id);
    expect(r).toMatchObject({ created: 5 });
    expect(await locBy("SYNTH MARKET")).toMatchObject({ active: true, address_status: "REGISTERED", address: "3 Market Road, Lagos", address_source: "PROFILING_WORKBOOK", source_state: "LAGOS" });
    expect(await locBy("CONFLICT JUNCTION")).toMatchObject({ active: false, address_status: "REVIEW", address: null });
    expect(await locBy("NOWHERE YET")).toMatchObject({ active: false, address_status: "MISSING" });
    expect(await locBy("SYNTH MINI BRANCH")).toMatchObject({ state: "PLATEAU", source_state: "JOS", outlet_type: "BRANCH" });
    // Ikeja already had a registered (demo) address: it is kept and the workbook's differing value is reported.
    expect((await db.query("SELECT address_outcome FROM altphones_location_sources WHERE source_name = 'IKEJA BRANCH'")).rows[0].address_outcome).toBe("DIFFERS_FROM_EXISTING");
    // Original labels are kept for matching later files.
    expect((await db.query("SELECT location_id FROM altphones_location_aliases WHERE label = 'AREA SYNTH'")).rowCount).toBe(0); // it is the name itself
    expect((await db.query("SELECT bpm_email, source FROM altphones_bpm_states WHERE state = 'LAGOS'")).rows[0]).toEqual({ bpm_email: ALT.bpm, source: "PROFILING_WORKBOOK" });
    expect((await db.query("SELECT bpm_email FROM altphones_bpm_states WHERE state = 'PLATEAU'")).rows[0].bpm_email).toBe("not.yet.staff@altbank.ng");
    expect((await db.query("SELECT count(*)::int AS n FROM staff")).rows[0].n).toBe(staffBefore); // no profiles created
    // Only locations with a registered address are offered for selection.
    const offered = (await pickerLocations(db, ["ALTBOX"])).map((l) => l.name);
    expect(offered).toContain("SYNTH MARKET");
    expect(offered).not.toContain("CONFLICT JUNCTION");
  });

  it("lets the PM link an entry to an existing location by hand before applying", async () => {
    const pm = await ctxFor(ALT.pm);
    const p = await previewProfiling(pm, { filename: "profiling.xlsx", data: await workbook() });
    const src = (await db.query("SELECT id FROM altphones_location_sources WHERE source_name = 'SYNTH MARKET'")).rows[0].id;
    await linkSource(pm, src, (await locBy("Yaba Altbox")).id);
    expect((await db.query("SELECT outcome FROM altphones_location_sources WHERE id = $1", [src])).rows[0].outcome).toBe("MATCHED");
    await applyProfiling(pm, p.id);
    expect(await locBy("SYNTH MARKET")).toBeUndefined();
    expect((await db.query("SELECT label FROM altphones_location_aliases WHERE location_id = $1", [(await locBy("Yaba Altbox")).id])).rows.map((x) => x.label)).toContain("SYNTH MARKET");
  });
});

describe("address registration (Unit Head approval)", () => {
  it("chooses between conflicting addresses, approves, and activates; the requester cannot approve", async () => {
    const pm = await ctxFor(ALT.pm);
    const uh = await ctxFor(ALT.unitHead);
    await applyProfiling(pm, (await previewProfiling(pm, { filename: "profiling.xlsx", data: await workbook() })).id);
    const cj = await locBy("CONFLICT JUNCTION");
    await expect(requestAddress(pm, { locationId: cj.id, choice: "1" })).rejects.toMatchObject({ code: "VALIDATION" }); // a reason is required
    const { ref } = await requestAddress(pm, { locationId: cj.id, choice: "1", note: "Confirmed with the BPM on a visit" });
    await expect(requestAddress(pm, { locationId: cj.id, address: "Another full address here" })).rejects.toMatchObject({ code: "CONFLICT" }); // one open request
    const req = (await db.query("SELECT * FROM altphones_address_requests WHERE ref = $1", [ref])).rows[0];
    expect(req).toMatchObject({ address: "99 Second Avenue", basis: "CONFLICT_CHOICE", activate: true });
    await expect(decideAddressRequest(pm, req.id, { decision: "APPROVE" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(decideAddressRequest(uh, req.id, { decision: "REJECT" })).rejects.toMatchObject({ code: "VALIDATION" });
    await decideAddressRequest(uh, req.id, { decision: "APPROVE" });
    expect(await locBy("CONFLICT JUNCTION")).toMatchObject({ address: "99 Second Avenue", address_status: "REGISTERED", address_source: "REGISTRATION_REQUEST", active: true });
  });

  it("a new location stays inactive until the Unit Head approves its address", async () => {
    const pm = await ctxFor(ALT.pm);
    const r = await proposeLocation(pm, { state: "LAGOS", type: "ALTSHOP", name: "New Synth Shop", address: "10 Brand New Street, Lagos" });
    expect(await locBy("NEW SYNTH SHOP")).toMatchObject({ active: false, address_status: "MISSING" });
    expect((await pickerLocations(db, ["ALTSHOP"])).map((l) => l.name)).not.toContain("NEW SYNTH SHOP");
    const req = (await db.query("SELECT id FROM altphones_address_requests WHERE ref = $1", [r.ref])).rows[0];
    await expect(decideAddressRequest(await ctxFor(ALT.admin), req.id, { decision: "APPROVE" })).rejects.toMatchObject({ code: "FORBIDDEN" }); // Unit Head only
    await decideAddressRequest(await ctxFor(ALT.unitHead), req.id, { decision: "APPROVE" });
    expect(await locBy("NEW SYNTH SHOP")).toMatchObject({ active: true, address_status: "REGISTERED", address: "10 Brand New Street, Lagos" });
    expect((await pickerLocations(db, ["ALTSHOP"])).map((l) => l.name)).toContain("NEW SYNTH SHOP");
  });

  it("the database refuses a registered status without an address", async () => {
    await expect(db.query("UPDATE locations SET address = NULL WHERE name = 'Ikeja Branch'")).rejects.toThrow(/locations_registered_address/);
  });
});

describe("origination and routing", () => {
  it("SAs can sell from an Altshop or an Altbox; Branches are not allowed; the address is supplied by ARAF", async () => {
    const sa = await ctxFor(ALT.sa);
    const models = (await db.query("SELECT id FROM altphones_models WHERE active ORDER BY sort_order")).rows.map((r) => r.id);
    const { id } = await startSale(sa, { kind: "CREDIT", modelId: models[0] });
    await expect(saveLocations(sa, id, { modelId: models[0], originId: (await locBy("Ikeja Branch")).id, supplyId: (await locBy("Ikeja Branch")).id })).rejects.toMatchObject({ fields: { originId: expect.stringMatching(/Altshop or an Altbox/) } });
    await saveLocations(sa, id, { modelId: models[0], originId: (await locBy("Yaba Altshop")).id, supplyId: "" }); // the Altshop supplies itself
    const app = (await db.query("SELECT origin_location_id, supply_location_id, origin_address FROM altphones_applications WHERE id = $1", [id])).rows[0];
    expect(app.supply_location_id).toBe(app.origin_location_id);
    expect(app.origin_address).toBe((await locBy("Yaba Altshop")).address);
  });

  it("an SA location with no usable BPM can be selected; the BPM must be mapped by request and approval", async () => {
    const pm = await ctxFor(ALT.pm);
    await applyProfiling(pm, (await previewProfiling(pm, { filename: "profiling.xlsx", data: await workbook() })).id);
    const sa = await ctxFor(ALT.sa);
    const models = (await db.query("SELECT id FROM altphones_models WHERE active ORDER BY sort_order")).rows.map((r) => r.id);
    const { id } = await startSale(sa, { kind: "CREDIT", modelId: models[0] });
    const area = await locBy("AREA SYNTH"); // FCT: mapped to a BPM who is not set up in ARAF
    expect((await bpmForLocation(db, area.id)).problem).toMatch(/not set up in ARAF/);
    await saveLocations(sa, id, { modelId: models[0], originId: area.id, supplyId: (await locBy("Yaba Altshop")).id }); // allowed: it will go to the Placeholder BPM
    // The PM requests a mapping; it takes effect only when the Unit Head approves.
    const { ref } = await requestBpmMapping(pm, { scope: "STATE", state: "FCT (ABUJA)", email: ALT.bpm, note: "Covers FCT until a BPM is hired" });
    expect((await bpmForLocation(db, area.id)).id).toBeNull();
    const req = (await db.query("SELECT id FROM altphones_bpm_requests WHERE ref = $1", [ref])).rows[0];
    await decideBpmRequest(await ctxFor(ALT.unitHead), req.id, { decision: "APPROVE" });
    expect((await bpmForLocation(db, area.id)).id).toBe(await sidOf(ALT.bpm));
    await expect(requestBpmMapping(pm, { scope: "STATE", state: "KANO", email: ALT.pm, note: "Not a BPM at all" })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("BPM mappings by hand are requested by the PM and approved by the Unit Head; a location mapping overrides its state", async () => {
    const pm = await ctxFor(ALT.pm);
    const uh = await ctxFor(ALT.unitHead);
    await applyProfiling(pm, (await previewProfiling(pm, { filename: "profiling.xlsx", data: await workbook() })).id);
    const nowhere = await locBy("NOWHERE YET"); // KWARA: no BPM in the workbook
    await db.query("UPDATE locations SET address = 'Synthetic registered address', address_status = 'REGISTERED', active = true WHERE id = $1", [nowhere.id]);
    expect((await unroutedStates(db)).map((u) => u.state)).toContain("KWARA");
    await expect(requestBpmMapping(pm, { scope: "LOCATION", locationId: nowhere.id, email: ALT.bpm, note: "" })).rejects.toMatchObject({ code: "VALIDATION" }); // reason required
    await expect(requestBpmMapping(pm, { scope: "LOCATION", locationId: (await locBy("Ikeja Branch")).id, email: ALT.bpm, note: "Branch sales skip BPM" })).rejects.toMatchObject({ code: "VALIDATION" });
    const { ref } = await requestBpmMapping(pm, { scope: "LOCATION", locationId: nowhere.id, email: ALT.bpm, note: "Nearest BPM covers this box" });
    await expect(requestBpmMapping(pm, { scope: "LOCATION", locationId: nowhere.id, email: ALT.bpm, note: "Asking twice here" })).rejects.toMatchObject({ code: "CONFLICT" });
    const id = (await db.query("SELECT id FROM altphones_bpm_requests WHERE ref = $1", [ref])).rows[0].id;
    await expect(decideBpmRequest(pm, id, { decision: "APPROVE" })).rejects.toMatchObject({ code: "FORBIDDEN" }); // not the Unit Head
    await expect(decideBpmRequest(await ctxFor(ALT.admin), id, { decision: "APPROVE" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(decideBpmRequest(uh, id, { decision: "REJECT" })).rejects.toMatchObject({ code: "VALIDATION" }); // reason required
    await decideBpmRequest(uh, id, { decision: "APPROVE" });
    expect((await bpmForLocation(db, nowhere.id)).id).toBe(await sidOf(ALT.bpm));
    expect((await unroutedStates(db)).map((u) => u.state)).not.toContain("KWARA");
    // A location mapping takes precedence over the state's.
    const other = (await db.query("INSERT INTO staff (email, full_name, region, status) VALUES ('bpm.three@altbank.ng','Third Synthetic BPM','LAGOS','ACTIVE') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO role_assignments (staff_id, role, active) VALUES ($1,'BUSINESS_PERFORMANCE_MANAGER',true)", [other]);
    const yaba = await locBy("Yaba Altbox");
    expect((await bpmForLocation(db, yaba.id)).id).toBe(await sidOf(ALT.bpm)); // Lagos mapping
    const r2 = await requestBpmMapping(pm, { scope: "LOCATION", locationId: yaba.id, email: "bpm.three@altbank.ng", note: "Yaba moves to the new BPM" });
    await decideBpmRequest(uh, (await db.query("SELECT id FROM altphones_bpm_requests WHERE ref = $1", [r2.ref])).rows[0].id, { decision: "APPROVE" });
    expect((await bpmForLocation(db, yaba.id)).id).toBe(other);
    expect((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'ALTPHONES_BPM_MAPPING_APPROVED'")).rows[0].n).toBe(2);
  });

  it("sends SA sales from unmapped locations to the Placeholder BPM person, and to the real BPM once one is mapped", async () => {
    const { submitCreditSale } = await import("@/server/demo/altphones-scenario");
    const pm = await ctxFor(ALT.pm);
    const uh = await ctxFor(ALT.unitHead);
    const approve = async (ref: string) => decideBpmRequest(uh, (await db.query("SELECT id FROM altphones_bpm_requests WHERE ref = $1", [ref])).rows[0].id, { decision: "APPROVE" });
    await db.query("DELETE FROM altphones_bpm_states WHERE state = 'LAGOS'"); // Yaba Altbox (Lagos) now has no BPM

    // No Placeholder BPM set yet: the sale waits unassigned and nobody can decide it.
    const first = await submitCreditSale(gw, mail, "SA", "22222222221");
    expect((await db.query("SELECT routed_to_placeholder, routed_bpm_id FROM altphones_applications WHERE id = $1", [first])).rows[0]).toEqual({ routed_to_placeholder: true, routed_bpm_id: null });
    await expect(decide(await ctxFor(ALT.bpm), first, { action: "APPROVE", comments: "", reviewed: true })).rejects.toBeTruthy();
    expect((await reviewQueues(db, await sidOf(ALT.pm))).placeholder?.map((x) => x.id)).toContain(first);

    // The PM sets the Placeholder BPM (an @altbank.ng BPM); it takes effect on the Unit Head's approval.
    const ph = (await db.query("INSERT INTO staff (email, full_name, region, status) VALUES ('placeholder.bpm@altbank.ng','Synthetic Placeholder BPM','LAGOS','ACTIVE') RETURNING id")).rows[0].id;
    await expect(requestBpmMapping(pm, { scope: "PLACEHOLDER", email: "placeholder.bpm@altbank.ng", note: "Covers unmapped locations" })).rejects.toMatchObject({ code: "VALIDATION" }); // no BPM role yet
    await db.query("INSERT INTO role_assignments (staff_id, role, active) VALUES ($1,'BUSINESS_PERFORMANCE_MANAGER',true)", [ph]);
    await expect(requestBpmMapping(pm, { scope: "PLACEHOLDER", email: "someone@gmail.com", note: "Wrong domain test" })).rejects.toMatchObject({ code: "VALIDATION" });
    const { ref } = await requestBpmMapping(pm, { scope: "PLACEHOLDER", email: "placeholder.bpm@altbank.ng", note: "Covers unmapped locations" });
    expect(await approve(ref)).toMatchObject({ approved: true, rerouted: 1 }); // the waiting sale moves to the placeholder
    expect((await db.query("SELECT routed_to_placeholder, routed_bpm_id FROM altphones_applications WHERE id = $1", [first])).rows[0]).toEqual({ routed_to_placeholder: true, routed_bpm_id: ph });

    // New sales from unmapped locations go straight to the Placeholder BPM, who reviews them like any BPM.
    const second = await submitCreditSale(gw, mail, "SA", "22222222223");
    expect((await db.query("SELECT routed_to_placeholder, routed_bpm_id FROM altphones_applications WHERE id = $1", [second])).rows[0]).toEqual({ routed_to_placeholder: true, routed_bpm_id: ph });
    expect((await db.query("SELECT 1 FROM notification_outbox WHERE kind = 'ALTPHONES_BPM_QUEUE' AND 'placeholder.bpm@altbank.ng' = ANY(to_addresses)")).rowCount).toBeGreaterThan(0);
    const phCtx = await ctxFor("placeholder.bpm@altbank.ng");
    expect((await reviewQueues(db, ph)).bpm?.map((x) => x.id).sort()).toEqual([first, second].sort());
    expect((await reviewQueues(db, await sidOf(ALT.bpm))).bpm ?? []).toHaveLength(0);
    await decide(phCtx, first, { action: "APPROVE", comments: "", reviewed: true });
    expect((await db.query("SELECT status FROM altphones_applications WHERE id = $1", [first])).rows[0].status).toBe("UNDER_PM_REVIEW");

    // Lagos gets its BPM: the sale still at the BPM stage moves there; the decided one stays decided.
    const r2 = await requestBpmMapping(pm, { scope: "STATE", state: "LAGOS", email: ALT.bpm, note: "Lagos BPM confirmed" });
    expect(await approve(r2.ref)).toMatchObject({ rerouted: 1 });
    expect((await db.query("SELECT routed_to_placeholder, routed_bpm_id FROM altphones_applications WHERE id = $1", [second])).rows[0]).toEqual({ routed_to_placeholder: false, routed_bpm_id: await sidOf(ALT.bpm) });
    expect((await db.query("SELECT status, bpm_reviewer_id FROM altphones_applications WHERE id = $1", [first])).rows[0]).toEqual({ status: "UNDER_PM_REVIEW", bpm_reviewer_id: ph });
    await expect(decide(phCtx, second, { action: "APPROVE", comments: "", reviewed: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await decide(await ctxFor(ALT.bpm), second, { action: "APPROVE", comments: "", reviewed: true });
  });

  it("routes an SA application to the BPM mapped to its location only, then PM and Unit Head", async () => {
    const { submitCreditSale } = await import("@/server/demo/altphones-scenario");
    // A second BPM, mapped to Lagos: the demo BPM can no longer see or decide Lagos SA sales.
    const other = (await db.query("INSERT INTO staff (email, full_name, region, status) VALUES ('bpm.two@altbank.ng','Second Synthetic BPM','LAGOS','ACTIVE') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO role_assignments (staff_id, role, active) VALUES ($1,'BUSINESS_PERFORMANCE_MANAGER',true)", [other]);
    await db.query("UPDATE altphones_bpm_states SET bpm_email = 'bpm.two@altbank.ng' WHERE state = 'LAGOS'");
    const id = await submitCreditSale(gw, mail, "SA");
    const app = (await db.query("SELECT * FROM altphones_applications WHERE id = $1", [id])).rows[0];
    expect(app).toMatchObject({ status: "UNDER_BPM_REVIEW", routed_bpm_id: other });
    const demoBpm = await ctxFor(ALT.bpm);
    expect((await appAccess(db, demoBpm.actor!.staffId, app)).has("BPM")).toBe(false);
    expect((await reviewQueues(db, demoBpm.actor!.staffId)).bpm ?? []).toHaveLength(0);
    await expect(decide(demoBpm, id, { action: "APPROVE", comments: "", reviewed: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const two = await ctxFor("bpm.two@altbank.ng");
    expect((await reviewQueues(db, other)).bpm?.map((x) => x.id)).toContain(id);
    await decide(two, id, { action: "APPROVE", comments: "", reviewed: true });
    expect((await db.query("SELECT status FROM altphones_applications WHERE id = $1", [id])).rows[0].status).toBe("UNDER_PM_REVIEW");
    expect((await db.query("SELECT 1 FROM notification_outbox WHERE kind = 'ALTPHONES_BPM_QUEUE' AND 'bpm.two@altbank.ng' = ANY(to_addresses)")).rowCount).toBeGreaterThan(0);
  });

  it("keeps the Delight Officer route: Product Manager, then Unit Head", async () => {
    const { submitCreditSale } = await import("@/server/demo/altphones-scenario");
    const id = await submitCreditSale(gw, mail, "DO");
    expect((await db.query("SELECT status, routed_bpm_id FROM altphones_applications WHERE id = $1", [id])).rows[0]).toEqual({ status: "UNDER_PM_REVIEW", routed_bpm_id: null });
  });
});

