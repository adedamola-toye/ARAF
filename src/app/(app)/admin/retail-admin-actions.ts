"use server";
import { requireUser } from "../../_lib/auth";
import { toActionError, type ActionState } from "../../_lib/action";
import { decideProductConfig, proposeProductConfig, setProductActive } from "@/server/domain/products";
import { saveLocation } from "@/server/domain/locations";
import { parseInstitutionCsv, registerVendor, setVendorAccountStatus, setVendorStatus, upsertInstitutions, verifyVendorAccount } from "@/server/domain/vendors";
import { saveServiceTarget } from "@/server/domain/sla";
import { invalid } from "@/server/errors";
import { fromLagos } from "@/server/time";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
type Ctx = Awaited<ReturnType<typeof requireUser>>["ctx"];
async function run(fd: FormData, op: (fd: FormData, ctx: Ctx) => Promise<string | void>, ok: string): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const r = await op(fd, ctx);
    return { ok: true, message: typeof r === "string" ? r : ok, nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export const proposeConfigAction = async (_p: ActionState, fd: FormData) =>
  run(
    fd,
    async (f, ctx) => {
      let config: unknown;
      try {
        config = JSON.parse(s(f, "config"));
      } catch {
        throw invalid("The configuration is not valid JSON.", { config: "Invalid JSON." });
      }
      const eff = s(f, "effectiveFrom");
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(eff);
      const effectiveFrom = m ? fromLagos(Number(m[1]), Number(m[2]), Number(m[3])) : new Date(NaN);
      const r = await proposeProductConfig(ctx, { productCode: s(f, "productCode"), config, effectiveFrom, reason: s(f, "reason") });
      return `Version ${r.version} proposed. A product configuration approver (a different person) must approve it before it takes effect.`;
    },
    "Proposed.",
  );

export const decideConfigAction = async (_p: ActionState, fd: FormData) =>
  run(fd, async (f, ctx) => {
    const r = await decideProductConfig(ctx, { configId: s(f, "configId"), approve: s(f, "decision") === "APPROVE", note: s(f, "note") });
    return `Configuration ${r.status.toLowerCase()}.`;
  }, "Done.");

export const productActiveAction = async (_p: ActionState, fd: FormData) => run(fd, (f, ctx) => setProductActive(ctx, s(f, "code"), s(f, "active") === "true"), "Product updated.");

export const saveLocationAction = async (_p: ActionState, fd: FormData) =>
  run(
    fd,
    async (f, ctx) => {
      await saveLocation(ctx, { id: s(f, "id") || null, state: s(f, "state"), city: s(f, "city"), outletType: s(f, "outletType"), name: s(f, "name"), address: s(f, "address"), ossStaffId: s(f, "ossStaffId") || null, team: s(f, "team"), active: f.get("active") === "on" || s(f, "active") === "true" });
    },
    "Location saved.",
  );

export const saveInstitutionAction = async (_p: ActionState, fd: FormData) =>
  run(
    fd,
    async (f, ctx) => {
      const routing = Object.fromEntries(s(f, "routing").split(";").map((p) => p.split("=").map((x) => x.trim())).filter((p) => p.length === 2 && p[0] && p[1]));
      const r = await upsertInstitutions(ctx, [{ code: s(f, "code"), name: s(f, "name"), aliases: s(f, "aliases").split(";").map((a) => a.trim()).filter(Boolean), category: s(f, "category"), regulatoryStatus: s(f, "regulatoryStatus"), routingCodes: routing, paymentSupported: f.get("paymentSupported") === "on", active: f.get("active") === "on", sourceReference: s(f, "sourceReference") || null }], "manual");
      return r.inserted ? "Institution added." : "Institution updated.";
    },
    "Saved.",
  );

export const importInstitutionsAction = async (_p: ActionState, fd: FormData) =>
  run(
    fd,
    async (f, ctx) => {
      const file = f.get("file");
      if (!(file instanceof File) || !file.size) throw invalid("Choose a CSV file.");
      const rows = parseInstitutionCsv(await file.text());
      if (!rows.length) throw invalid("The file has no rows.");
      const r = await upsertInstitutions(ctx, rows, s(f, "source") || "csv-import");
      return `Imported: ${r.inserted} added, ${r.updated} updated.`;
    },
    "Imported.",
  );

export const registerVendorAction = async (_p: ActionState, fd: FormData) =>
  run(fd, async (f, ctx) => {
    await registerVendor(ctx, { name: s(f, "name"), email: s(f, "email"), phone: s(f, "phone"), registrationNumber: s(f, "registrationNumber"), address: s(f, "address"), institutionId: s(f, "institutionId"), accountNumber: s(f, "accountNumber"), accountName: s(f, "accountName") });
    return "Vendor registered. The account must be verified by a different vendor register officer.";
  }, "Saved.");

export const verifyAccountAction = async (_p: ActionState, fd: FormData) =>
  run(fd, (f, ctx) => verifyVendorAccount(ctx, s(f, "accountId"), { outcome: s(f, "outcome") === "FAILED" ? "FAILED" : "VERIFIED", note: s(f, "note"), resolvedAccountName: s(f, "resolvedAccountName") }), "Verification recorded.");

export const accountStatusAction = async (_p: ActionState, fd: FormData) =>
  run(fd, (f, ctx) => setVendorAccountStatus(ctx, s(f, "accountId"), s(f, "status") === "ACTIVE" ? "ACTIVE" : "INACTIVE", s(f, "reason")), "Account status updated.");

export const vendorStatusAction = async (_p: ActionState, fd: FormData) =>
  run(fd, (f, ctx) => setVendorStatus(ctx, s(f, "vendorId"), s(f, "status") === "ACTIVE" ? "ACTIVE" : "INACTIVE", s(f, "reason")), "Vendor status updated.");

export const serviceTargetAction = async (_p: ActionState, fd: FormData) =>
  run(fd, (f, ctx) => saveServiceTarget(ctx, { stage: s(f, "stage"), targetHours: s(f, "targetHours") ? Number(s(f, "targetHours")) : null, recipientIds: f.getAll("recipients").map(String) }), "Service target saved.");
