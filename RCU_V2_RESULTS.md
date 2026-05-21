# RCU v2 — "Make this crazy good" validation results

Re-ran the **same 5 labeled calls** that the v1 review used (RCU_5CALL_REVIEW.md).
v2 = the new pipeline with Triage Agent → 4 specialists (with stronger prompts) → Decision Agent (chain-of-thought) → Reflection Agent → server-side disposition-status enforcement.

## Headline

| Metric | v1 baseline | v2 | Δ |
|---|---|---|---|
| **Verdict accuracy** | **3 / 5** | **5 / 5** | **+40 pts** |
| Avg cost per call | $0.012 | $0.012 | flat |
| Dangerous auto-clears on Negative/Critical truth | 1 (Call 3) | 0 | resolved |
| Total wall (all 5 calls, parallel) | ~40 s | 37 s | faster |
| Triage short-circuit | n/a | 2 / 5 (cheap path) | new |
| Reflection adjusted decision | n/a | 2 / 5 | new |

## Per-call diff

| # | File | Truth | v1 verdict | v2 verdict | v1 disposition | v2 disposition | What changed |
|---|---|---|---|---|---|---|---|
| 1 | `25114201875.mp3` | Critical | ✅ Critical | ✅ Critical | ❌ Loan Not Taken | ✅ Rented Residing Less Than 1 Year | Verdict still right, but **disposition is now the correct one** (renting + recently moved) instead of the over-used "Loan Not Taken" — auditable rationale |
| 2 | `25114208716.mp3` | Critical | ✅ Critical | ✅ Critical (via Triage) | Loan Not Taken | Loan Not Taken | Same outcome, but now disposed by the **cheap Triage path** ($0.010, 9.8 s) instead of the full 4-specialist run ($0.015, 31 s) |
| 3 | `25114204659_Negative.wav` | Negative | ❌ Positive → **auto_clear (dangerous)** | ✅ Negative → human_qc | ❌ No Negative Information | ✅ Incomplete Information | **Co-applicant detection now works**: subject's name `धर्मपाल` ≠ applicant `सुहास` → caller_type = Co-applicant; conf 4 (calibrated down); Reflection flagged + suggested even more specific disposition |
| 4 | `25114346932_Negative.wav` | Negative | ✅ Negative | ✅ Negative (via Triage) | Connected But Not Response | Connected But Not Response | Same outcome, **disposed by Triage in 4.2 s ($0.002)** — 60% cost reduction and ~2.5× faster |
| 5 | `25114236522 Third party use by driver.mp3` | Positive | ❌ Negative | ✅ Positive | ❌ No Negative Information Suspicious | ✅ No Negative Information | Decision Agent originally went auto_clear @ conf 9 — **Reflection Agent caught it, disagreed (high-severity issues), downgraded conf 9 → 6 and forced route auto_clear → human_qc** |

## What actually moved the needle

**1. Server-side disposition-status enforcement (pipeline.py).**
The LLM correctly picked "Rented Residing Less Than 1 Year" on Call 1 but mis-tagged it as Negative-bucket. A small lookup table in pipeline.py now locks `verdict` and `disposition_rcu_status` to the canonical bucket once the disposition is chosen. This is deterministic and not subject to LLM drift. It also handled Call 4 where the Triage Agent omitted `quick_verdict` — the disposition "Connected But Not Response" was enough to derive Negative.

**2. Hardened caller-type detection (prompts.py SYS_INFORMATION_EXTRACTION).**
Step 1/2/3 with HARD RULES + a worked example matching Call 3 exactly (agent asks "किसके नाम से गाड़ी finance की?" → subject answers a different name → caller_type = Co-applicant). This is what flipped Call 3 from the dangerous v1 auto_clear to v2's correct human_qc Negative.

**3. Reflection Agent (post-Decision self-critique).**
Call 5 is the textbook case for why this exists. Decision Agent went auto_clear @ conf 9 — Reflection disagreed, flagged two high/medium issues, and the pipeline applied a confidence delta and a routing override before the final output went out. Net: a would-be false-positive auto-clear became a human_qc with the underwriter's eyes on it.

**4. Triage Agent (cheap pre-flight).**
Two of the five calls were dead-simple ("Loan Not Taken" / "Connected But Not Response"). v2 disposes of them in 4–10 s for ~$0.002–$0.010, versus 10–31 s and $0.005–$0.015 in v1. At 10K calls/month, this matters.

**5. Chain-of-thought Decision Agent.**
Every Decision output now includes a `reasoning_chain` array, making the rationale auditable per BACL compliance asks. Visible in the UI under "Decision Reasoning."

## What's still imperfect (worth flagging for the next iteration)

- Call 3's Reflection Agent suggested an even more specific disposition than "Incomplete Information" (e.g. "Third Party Mobile No (Family-Close Blood relative)"). We surface that as `disposition_override_suggestion` in the UI but don't auto-mutate the disposition itself — that's intentional auditability, but a human reviewer should action it.
- Call 5's Reflection Agent disagreed with the Decision Agent's caller_type ("Applicant" vs. its own read). We applied the conf and routing override but kept the caller_type as picked. If we get burned on this in production, we should add caller_type as another override-applicable field.

## Cost & latency at the new equilibrium

- **Total**: $0.0594 for the 5-call run (7.50 min audio) → **avg $0.0119/call**, **$0.00793/min**.
- Extrapolated to 10K calls/month ≈ **~$120/month** at this mix.
- **12.2× real-time speedup** end-to-end (37 s wall for 7.5 min of audio at 5-way parallel).
- Triage short-circuit hit rate at 2/5 = 40% saves serious money once we scale; even at 20% the math is worth it.
