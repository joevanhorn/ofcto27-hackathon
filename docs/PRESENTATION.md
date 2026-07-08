# Finalist Presentation — Narrative & Speaker Notes

**Through-line (the one sentence):**
> *"The portal is the artifact. The method — running AI like a scrum team — is the product."*

Everything ladders to that. The build strategy is the star; the solution is proof it works.

**How it maps to the Day-3 judging dimensions:**
- **Customer voice** — the shadow-IT pain (business units go rogue when central IT is slow).
- **Wow factor** — real Okta login + real `terraform apply`, live.
- **Innovativeness** — a *team* of AI agents, not one prompt doing everything.
- **Applicability** — a repeatable build *method*, not a one-off app.

---

## The 3-minute script

### [0:00–0:20] Hook — the customer, then the pivot
> "We've all watched a business unit go rogue — stand up a shadow AD or some random tenant —
> because central IT couldn't move fast enough. My premise is simple: **good security has to be
> *easier* than the insecure path.** So I built a portal where a division lead self-serves a
> fully-governed Okta org in seconds. But honestly — that's not what I want to talk about. I
> want to talk about **who built it.**"

*(The pivot is deliberate: it tells the judges the demo is table stakes and the method is the point.)*

### [0:20–1:30] The build strategy — your center of gravity
> "I didn't write this app. I **architected a team of AI agents** that did — and I ran it like
> a scrum team. Two tiers. At the top, strategic agents that never touch code: an **Architect**
> who turns a goal into a ready backlog, and a **Scrum Master** that dispatches the work. Below
> them, **ephemeral Engineers** — each spins up, builds exactly one story, reports back, and
> disappears. And feeding them, deep **specialists**: Okta identity, Terraform, and the AWS
> platform — each holding one domain so no Engineer has to.
>
> Why does that matter? Because **the context window is a resource.** One AI session doing
> everything gets dumber as it fills up. A team — where every agent holds exactly what it needs
> and *nothing else* — doesn't. That was Day 2's whole thesis. And on Day 3 I watched it pay
> off: two specialists researched **my own Terraform modules in parallel**, handed a single
> Engineer an implementation-ready spec, and that Engineer wired real SAML federation — and
> fixed three bugs in my module along the way."

### [1:30–2:20] The proof — roll the clip, then SSO live
> "Everything here is real." *(roll the ~30s clip)* "Real Okta login — with MFA. A real
> `terraform apply`, streaming live, provisioning a real Okta org, federated to the hub.
> **Built by that agent team, in parallel, while I orchestrated.**"
>
> *(clip ends on 'Spoke provisioned')* "And to close the loop —" *(click into the org)* "— I'm
> signed straight into the brand-new org from the hub. No new password. Governed, and effortless."

### [2:20–2:50] Tie back to the hackathon arc
> "This is exactly the arc we were taught: **Day 1, Define** — spec before a single line of
> code. **Day 2, Architect** — design the team. **Day 3, Present** — let the team build.
> Spec-driven, agent-architected, and **adversarially reviewed** — I even ran two challenger
> agents to red-team my own design before I trusted it."

### [2:50–3:00] Hand-off to the afternoon AI Scrum Team talk
> "So the portal is the artifact — but the method is what I'm taking to **every** build after
> this. And that's exactly what I'll walk you through this afternoon in my **AI Scrum Team**
> session — how to run a team of agents under the hood. Come see how it's done."

---

## Transition options into the afternoon talk (pick one)
- **Teaser/curiosity:** *"…what you just saw was the method on autopilot. This afternoon I'll open the hood."*
- **Callback:** *"This started as a hackathon idea. It's now the way I build. Let me show you the framework — 2pm, AI Scrum Team."*
- **Stakes:** *"If you're still prompting one AI to do everything, you're leaving speed and quality on the table. This afternoon I'll show you the alternative."*

---

## Delivery notes
- **Lead with the pivot** ("that's not what I want to talk about") — disarming, confident, and it
  reallocates the 3 minutes toward the method (your actual ask).
- **Let the clip breathe** — say one line, then go quiet and let real terraform scroll. Silence
  sells "this is real."
- **The live SSO is the mic-drop** — rehearse it once. If room Wi-Fi is dicey, the clip already
  ends on success, so you're covered either way.
- **Name the numbers if asked:** spec committed before any code (Day 1 scored 5/5); ~30s real
  build captured headless; 3 latent module bugs the agents caught. Specifics read as credibility.
- **Preempt the "did the AI really build it?" question:** *"I architected the team and
  orchestrated it; the Engineers wrote the code and the specialists fed them. My job was the
  'what' and the boundaries — which is the whole point of the method."*

---

## Reference artifacts (for the deck / backup)
- Solution spec: [`docs/solution.md`](solution.md), [`docs/prd.md`](prd.md)
- Agent design: [`docs/multiAgentDesign.md`](multiAgentDesign.md), [`.claude/agents/`](../.claude/agents/)
- Reuse map: [`docs/building-blocks.md`](building-blocks.md)
- Demo script + run steps: [`docs/DEMO_SCRIPT.md`](DEMO_SCRIPT.md)
- Demo clip: GitHub release **day3-demo-clip** (org + personal repos), regenerate via
  `portal/recording/run-clip.sh`
