import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor } from "@/server/demo/scenario";
import { ALT, CapturingMail, latestPaymentRef, loc, setupAltphones, TestBureau, TestGateway } from "@/server/demo/altphones-scenario";
import { setCreditBureauForTests, setPaymentGatewayForTests } from "@/server/altphones/integrations";
import { setMailTransportForTests } from "@/server/notify/transport";
import { commitImport, previewImport } from "@/server/altphones/imports";
import { checkPayment, completeOutright, requestPayment, saveCustomer, saveLocations, startSale } from "@/server/altphones/origination";
import { decideStockCount, locationStock, poolModelId, submitStockCount } from "@/server/altphones/stock";
import { listModels, saveModel } from "@/server/altphones/catalogue";
import { normaliseNigerianState } from "@/server/domain/roles";

const LOCATIONS = readFileSync("data/altphones/opening-locations.csv");
const STOCK = readFileSync("data/altphones/opening-stock.csv");
let gw: TestGateway;
let models: string[];

beforeEach(async () => {
  await resetDb();
  gw = new TestGateway();
  setCreditBureauForTests(new TestBureau(700));
  setPaymentGatewayForTests(gw);
  setMailTransportForTests(new CapturingMail());
  ({ models } = await setupAltphones({ stock: 0 }));
});
afterEach(() => {
  setCreditBureauForTests(undefined);
  setPaymentGatewayForTests(undefined);
  setMailTransportForTests(null);
});

async function loadOpeningData() {
  const admin = await ctxFor(ALT.admin);
  const l = await previewImport(admin, "LOCATIONS", "opening-locations.csv", LOCATIONS);
  expect(l.summary).toMatchObject({ rows: 69, errors: 0 });
  await commitImport(admin, l.id);
  const s = await previewImport(admin, "OPENING_STOCK", "opening-stock.csv", STOCK);
  expect(s.summary).toMatchObject({ rows: 44, errors: 0 });
  await commitImport(admin, s.id);
}
const pool = async () => (await poolModelId(db))!;
const bal = async (name: string, model: string) =>
  (await db.query("SELECT physical, reserved FROM altphones_stock s JOIN locations l ON l.id = s.location_id WHERE l.name = $1 AND s.model_id = $2", [name, model])).rows[0] ?? { physical: 0, reserved: 0 };

describe("states as supplied", () => {
  it("maps the labels in the location list to states, keeping unknowns unresolved", () => {
    expect(["ABUJA", "PORT HARCOURT", "JOS", "LAGOS/OGUN", "Lagos", "kano state", "FCT", "Akwa-Ibom", "ATLANTIS"].map(normaliseNigerianState)).toEqual([
      "FCT (ABUJA)",
      "RIVERS",
      "PLATEAU",
      "OGUN",
      "LAGOS",
      "KANO",
      "FCT (ABUJA)",
      "AKWA IBOM",
      null,
    ]);
  });
});

describe("opening inventory (69 locations, 152 units)", () => {
  it("loads every location with its original labels, keeps zero-stock locations, and totals 152 colour-agnostic units", async () => {
    await loadOpeningData();
    const all = await locationStock(db);
    const opening = all.filter((l) => l.source_name);
    expect(opening).toHaveLength(69);
    expect(opening.reduce((a, l) => a + l.physical, 0)).toBe(152);
    expect(opening.filter((l) => l.physical === 0)).toHaveLength(25);
    const agege = (await db.query("SELECT outlet_type, source_type, state, source_state FROM locations WHERE name = 'AGEGE STADIUM'")).rows[0];
    expect(agege).toEqual({ outlet_type: "ALTSHOP", source_type: "ALTBOX", state: "LAGOS", source_state: "LAGOS" }); // reclassified, original kept
    expect((await db.query("SELECT state, source_state FROM locations WHERE name = 'RUMOKORO ALTSHOP'")).rows[0]).toEqual({ state: "RIVERS", source_state: "PORT HARCOURT" });
    expect((await db.query("SELECT state, city FROM locations WHERE name = 'OGIJO'")).rows[0]).toEqual({ state: "OGUN", city: "Ogijo" });
    // DEI DEI was supplied twice (as an ALTSHOP and as a BRANCH): two locations, both listed as "DEI DEI".
    expect((await db.query("SELECT name, outlet_type, source_type FROM locations WHERE source_name = 'DEI DEI' ORDER BY name")).rows).toEqual([
      { name: "DEI DEI ALTSHOP", outlet_type: "ALTSHOP", source_type: "ALTSHOP" },
      { name: "DEI DEI BRANCH", outlet_type: "BRANCH", source_type: "BRANCH" },
    ]);
    expect(await bal("DEI DEI ALTSHOP", await pool())).toEqual({ physical: 2, reserved: 0 });
    expect(await bal("DEI DEI BRANCH", await pool())).toEqual({ physical: 2, reserved: 0 });
    // The shared original label is ambiguous, so an import that names only "DEI DEI" is refused rather than guessed.
    const amb = await previewImport(await ctxFor(ALT.admin), "OPENING_STOCK", "dei.csv", Buffer.from("Location,Phone model,Quantity\nDEI DEI,Altphone L1 Series — colour not recorded,1\n"));
    expect(amb.summary).toMatchObject({ valid: 0, errors: 1 });
    expect(JSON.stringify((await db.query("SELECT errors FROM altphones_imports WHERE id = $1", [amb.id])).rows[0].errors)).toMatch(/matches more than one location/);
    expect(await bal("ENUGU", await pool())).toEqual({ physical: 9, reserved: 0 });
    // The same files cannot be applied twice.
    await expect(previewImport(await ctxFor(ALT.admin), "LOCATIONS", "opening-locations.csv", LOCATIONS)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(previewImport(await ctxFor(ALT.admin), "OPENING_STOCK", "opening-stock.csv", STOCK)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("the colour-not-recorded pool is never a catalogue phone", async () => {
    const p = await pool();
    expect((await listModels(db)).map((m) => m.id)).not.toContain(p);
    await expect(saveModel(await ctxFor(ALT.pm), { id: p, name: "Altphone L1 Series — colour not recorded", specifications: "x x x", active: true, sortOrder: "1" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(db.query("UPDATE altphones_models SET active = true WHERE id = $1", [p])).rejects.toThrow(/altphones_pool_not_sold/);
  });
});

describe("selling from colour-not-recorded stock", () => {
  async function paidOutright(where: string, modelId: string) {
    const ctx = await ctxFor(ALT.doOfficer);
    const { id } = await startSale(ctx, { kind: "OUTRIGHT", modelId });
    await saveLocations(ctx, id, { modelId, originId: await loc(where), supplyId: await loc(where) });
    await saveCustomer(ctx, id, { name: "Synthetic Customer", email: "customer@example.com", phone: "0803 123 4567" });
    await requestPayment(ctx, id, {});
    gw.pay(await latestPaymentRef(id));
    await checkPayment(ctx, id);
    return { id, ctx };
  }

  it("a sale of any colour reserves a pool unit when that colour has none, and deducts it once at handover", async () => {
    await loadOpeningData();
    const p = await pool();
    const { id, ctx } = await paidOutright("ENUGU", models[1]);
    const app = (await db.query("SELECT status, stock_model_id, reservation_status FROM altphones_applications WHERE id = $1", [id])).rows[0];
    expect(app).toMatchObject({ status: "PAID", stock_model_id: p, reservation_status: "RESERVED" });
    expect(await bal("ENUGU", p)).toEqual({ physical: 9, reserved: 1 });
    await completeOutright(ctx, id, { imei: "490154203237518", handedOver: true });
    expect(await bal("ENUGU", p)).toEqual({ physical: 8, reserved: 0 });
    // The device is recorded as the colour the customer received.
    expect((await db.query("SELECT model_id, status FROM altphones_devices WHERE imei = '490154203237518'")).rows[0]).toEqual({ model_id: models[1], status: "ISSUED" });
  });

  it("uses the chosen colour's own stock first", async () => {
    await loadOpeningData();
    const admin = await ctxFor(ALT.admin);
    const s = await previewImport(admin, "OPENING_STOCK", "green.csv", Buffer.from(`Location,Phone model,Quantity,IMEIs,Note\nENUGU,Altphone L1 Series — Green,1,,\n`));
    await commitImport(admin, s.id);
    const green = (await db.query("SELECT id FROM altphones_models WHERE name = 'Altphone L1 Series — Green'")).rows[0].id;
    const { id } = await paidOutright("ENUGU", green);
    expect((await db.query("SELECT stock_model_id FROM altphones_applications WHERE id = $1", [id])).rows[0].stock_model_id).toBe(green);
    expect(await bal("ENUGU", await pool())).toEqual({ physical: 9, reserved: 0 });
  });

  it("refuses a sale where neither the colour nor the pool has a unit", async () => {
    await loadOpeningData();
    const ctx = await ctxFor(ALT.doOfficer);
    const { id } = await startSale(ctx, { kind: "OUTRIGHT", modelId: models[0] });
    await expect(saveLocations(ctx, id, { modelId: models[0], originId: await loc("MARINA BRANCH"), supplyId: await loc("MARINA BRANCH") })).rejects.toBeTruthy();
  });
});

describe("stock counts", () => {
  it("a count is posted only after a different Super Admin approves it, as an adjustment against the ledger", async () => {
    await loadOpeningData();
    const p = await pool();
    const enugu = await loc("ENUGU");
    const r = await submitStockCount(await ctxFor(ALT.pm), { locationId: enugu, countedOn: "2026-11-01", note: "Shelf count", lines: [{ modelId: p, counted: "7" }] });
    expect(r.variance).toBe(-2);
    expect(await bal("ENUGU", p)).toEqual({ physical: 9, reserved: 0 }); // nothing changes yet
    await expect(submitStockCount(await ctxFor(ALT.pm), { locationId: enugu, countedOn: "2026-11-01", note: "", lines: [{ modelId: p, counted: "8" }] })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(decideStockCount(await ctxFor(ALT.pm), r.id, { decision: "APPROVE", comment: "" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const d = await decideStockCount(await ctxFor(ALT.admin), r.id, { decision: "APPROVE", comment: "" });
    expect(d.adjustment).toBe(-2);
    expect(await bal("ENUGU", p)).toEqual({ physical: 7, reserved: 0 });
    const g = (await db.query("SELECT movement, physical_delta, reference FROM altphones_stock_ledger WHERE movement = 'COUNT_ADJUSTMENT'")).rows;
    expect(g).toEqual([{ movement: "COUNT_ADJUSTMENT", physical_delta: -2, reference: r.ref }]);
    expect((await locationStock(db)).find((l) => l.name === "ENUGU")!.last_count).toBe("2026-11-01");
  });

  it("refuses counts below reserved units, future dates, self-approval and unexplained rejection", async () => {
    await loadOpeningData();
    const p = await pool();
    const ctx = await ctxFor(ALT.doOfficer);
    const { id } = await startSale(ctx, { kind: "OUTRIGHT", modelId: models[0] });
    await saveLocations(ctx, id, { modelId: models[0], originId: await loc("SOKOTO"), supplyId: await loc("SOKOTO") });
    await saveCustomer(ctx, id, { name: "Synthetic Customer", email: "customer@example.com", phone: "0803 123 4567" });
    await requestPayment(ctx, id, {});
    gw.pay(await latestPaymentRef(id));
    await checkPayment(ctx, id); // 1 of SOKOTO's 4 pool units now reserved
    const sokoto = await loc("SOKOTO");
    await expect(submitStockCount(await ctxFor(ALT.pm), { locationId: sokoto, countedOn: "2026-11-01", note: "", lines: [{ modelId: p, counted: "0" }] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(submitStockCount(await ctxFor(ALT.pm), { locationId: sokoto, countedOn: "2999-01-01", note: "", lines: [{ modelId: p, counted: "4" }] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(submitStockCount(await ctxFor(ALT.doOfficer), { locationId: sokoto, countedOn: "2026-11-01", note: "", lines: [{ modelId: p, counted: "4" }] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const mine = await submitStockCount(await ctxFor(ALT.admin), { locationId: sokoto, countedOn: "2026-11-01", note: "", lines: [{ modelId: p, counted: "5" }] });
    await expect(decideStockCount(await ctxFor(ALT.admin), mine.id, { decision: "APPROVE", comment: "" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db.query("INSERT INTO role_assignments (staff_id, role, granted_at) SELECT id, 'SUPER_ADMIN', now() FROM staff WHERE email = $1", [ALT.unitHead]);
    await expect(decideStockCount(await ctxFor(ALT.unitHead), mine.id, { decision: "REJECT", comment: "" })).rejects.toMatchObject({ code: "VALIDATION" });
    await decideStockCount(await ctxFor(ALT.unitHead), mine.id, { decision: "REJECT", comment: "Recount needed" });
    expect(await bal("SOKOTO", p)).toEqual({ physical: 4, reserved: 1 });
  });
});
