# WakeelBoost workflow state map

All transitions live in `src/server/domain/workflow.ts`. Each one runs in a single PostgreSQL
transaction that claims an idempotency key, locks the application and its open task, checks that the
actor is the assignee **and** still holds the task's role, records the decision against the exact
application version and document pack reviewed, completes the task, opens the next task (assignment
stored once, here), and writes the audit events and outbox emails. A unique index allows one open task
per case.

```
DRAFT ──submit──▶ BUSINESS_ENDORSEMENT ──endorse──▶ FIRST_CREDIT_REVIEW ──approve──▶ SECOND_CREDIT_REVIEW
                    │ RM → selected RBE                │ R1 CO1 / R2 CO2 / R3 CO3      │ R1 CO2|CO3 (approve/reject/return)
                    │ MO → MO Lead                     │ gates: 3 credit reports,      │ R2 Lead1|Lead2|CO3 (proceed/reject)
                    │ ANM → North/South ANM Lead       │ APR+DSR on current version,   │ R3 Lead1|Lead2 (proceed/reject)
                    │                                  │ "Logged invoice" + dialog     ▼
                    │                                  │                         UNIT_HEAD_REVIEW ─▶ DIVISIONAL_HEAD_REVIEW
                    ▼ return                           ▼ return                        │ return ▼             │ approve
             INITIATOR_CORRECTION ◀────────────── (first reviewer)         CREDIT_CORRECTION (first reviewer) │
                    │ resubmit: non-material → stage that asked             │ resubmit → originating stage     │
                    │           material → FIRST_CREDIT_REVIEW              │ reassessed → FIRST_CREDIT_REVIEW │
                    │           (route recalculated, approvals invalidated) │ request docs → INITIATOR_CORRECTION
                                                                                                             ▼
OFFER_PREPARATION (initiator: generate offer, upload signed offer, KYC, pre-disbursement, GSI, signed insurance)
   ──submit pack──▶ CO3_PACK_REVIEW (Credit Officer 3, any route; uploads insurance evidence; may return pack)
   ──forward──▶ DISBURSEMENT_CHECK (DO1: "Logged CRMS" + Okay) ──send for correction──▶ DISBURSEMENT_CORRECTION (CO3) ──resubmit──▶ same DO1
   ──okay──▶ DISBURSEMENT_BOOKING (DO2: amount, date, ref, schedule → Disbursed; status BOOKED; CO3 + initiator notified)
   ──▶ COMPLETION (CO3: Complete Process → one closure email to Legal + Shariah, cc initiator)
   ──▶ VENDOR_CONFIRMATION (initiator) ──confirm──▶ CLOSED (repayment prompts active)

Any approval stage ──reject (reason)──▶ REJECTED (initiator notified)
```

| Stage | Assignee | Actions | Reason required |
|---|---|---|---|
| BUSINESS_ENDORSEMENT | RBE chosen by RM / MO Lead / regional ANM Lead | Endorse, Reject, Return | Reject, Return |
| FIRST_CREDIT_REVIEW | CO1 / CO2 / CO3 by route | Approve, Reject, Return | Reject, Return |
| SECOND_CREDIT_REVIEW | Random eligible (see table) | R1: Approve/Reject/Return; R2–3: Proceed/Reject | Reject, Return |
| UNIT_HEAD_REVIEW, DIVISIONAL_HEAD_REVIEW | Unit Head, Divisional Head | Approve, Reject, Return | Reject, Return |
| CREDIT_CORRECTION | Assigned first reviewer | Resubmit, Request documents from initiator | Request |
| INITIATOR_CORRECTION | Initiator | Resubmit | — |
| OFFER_PREPARATION | Initiator | Submit pack | — |
| CO3_PACK_REVIEW | Credit Officer 3 | Forward, Return | Return |
| DISBURSEMENT_CHECK | DO1 | Okay (CRMS gate), Send for Correction | Send for Correction |
| DISBURSEMENT_CORRECTION | CO3 | Resubmit (to same DO1) | — |
| DISBURSEMENT_BOOKING | DO2 | Disbursed | — |
| COMPLETION | CO3 | Complete Process | — |
| VENDOR_CONFIRMATION | Initiator | Confirm vendor payment and end of process | — |

**Separation of duties.** Credit and approval stages exclude the initiator, the endorser and anyone who
already decided on the case. DO1 excludes the pack CO3; DO2 excludes DO1. Super Admins cannot assign
tasks to themselves or edit their own roles. When nobody is eligible the task opens **unassigned**, the
Super Admin is emailed, and it appears under *Assignment exceptions*. Stages are never skipped.

**Material fields** (fresh credit review): applicant type, names, registration number, amount, tenor,
items, asset cost, supplier, invoice reference, BVN, TIN, directors. Contacts, DAO code, POS serial,
rental dates and RBE selection are non-material. Endorsement remains valid after a material change.
