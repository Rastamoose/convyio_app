# Convyio product execution backlog

Status: prioritized product backlog derived from `AGENTS/PRODUCT_DIRECTION.md` and `AGENTS/onboarding.txt`.

This is not evidence that a task is implemented. Current behavior remains defined by `AGENTS/ARCHITECTURE/CURRENT_*.md`.

## Ordering principle

Do not build or record a polished visual onboarding around the current generic chat-first experience.

The order is:

1. Validate the narrow problem and language.
2. Make the differentiated product loop coherent in the real app.
3. Dogfood that loop.
4. Build onboarding around it.
5. Record the canonical demo video from it.
6. Rework the landing page around the same proof.
7. Measure comprehension and activation, then refine.

The landing page can receive an interim copy correction earlier, but its final demo must come from the real product flow.


# P0 — Product and market clarity

## Formalize and validate the narrow ICP

- [ ] Use the working ICP: 2–10 person technical teams running several independently owned coding agents against the same product under recurring deadline.
- [ ] Define recruiting criteria for interviews: multiple agent users, same product/repository, recent concrete coordination failure.
- [ ] Conduct switching interviews with technical founders, engineering leads, staff/senior engineers, agency technical leads and tiger-team leads.
- [ ] Include users who considered changing their workflow but did not.
- [ ] Capture the actual recent event that created urgency: missed constraint, review rework, agent collision, unexplained action, lost private context or manual routing burden.
- [ ] Record what they used instead of Convyio, including the status quo stack.
- [ ] Validate whether the durable buyer is the recurring startup/agency/tiger team rather than hackathon participants.
- [ ] Validate willingness to introduce one new workroom without moving the whole company.
- [ ] Validate whether `shared execution workroom`, `human-agent workroom` or `workspace for agent-involved software work` creates the most accurate mental model.
- [ ] Reject or revise the ICP if the pain is admired but not urgent enough to change behavior.

Definition of done:

- The team can describe a repeated struggling moment in the customer's own words.
- The team knows what customers currently do without Convyio.
- The selected customer can adopt one workroom without enterprise-wide migration.
- The buyer, champion, user and contributor roles are clear.

## Message-comprehension testing

- [ ] Test the category POV: `AI made execution fast. It did not make the work shared.`
- [ ] Test the core problem: `Agent work starts privately and becomes team work at review. That is too late.`
- [ ] Test the contrast: `Same agents. Different system of work.`
- [ ] Ask participants to explain Convyio in their own words after one minute and after five minutes.
- [ ] Mark `Slack with bots`, `another coding agent`, `swarm`, and `project-management AI` as comprehension failures.
- [ ] Test whether `conversation`, `thread`, `workroom`, `shared execution` and `approved work` are understood without explanation.
- [ ] Keep a transcript of exact language users repeat naturally.

Definition of done:

- A strong majority of selected participants independently describe context becoming coordinated/approved work and returning as a reviewable result.


# P0 — Make the differentiated loop real in the app

## Inline PlanCard / Work Brief

- [x] Add a first-class inline PlanCard to the canonical conversation timeline.
- [x] Render the existing canonical Plan record rather than creating a parallel onboarding-only model.
- [x] Show intended outcome, relevant context, assumptions, constraints, open questions, proposed approach, acceptance criteria, likely resource and proposed owner.
- [x] Add inline actions: answer clarification, add constraint, edit/refine, accept, request changes, discuss, open Board projection.
- [x] Attach every Plan to an origin channel/conversation/thread event.
- [x] Ensure a Plan created manually also establishes an origin thread event.
- [x] Add an explicit `Changed before execution` presentation when a constraint or decision changes the Plan.
- [x] Preserve actor attribution for meaningful Plan changes.
- [x] Make Plan acceptance human-only and continue granting no mutation authority.
- [x] Ensure Plan events fan out and remain replayable from the canonical ledger.

Definition of done:

- A user can discuss, understand, refine and accept a Plan without leaving the conversation.
- Board shows the identical Plan, not a copy.
- Every Board Plan can jump to its origin conversation.

## Constraint and decision consequences

- [x] Connect attributed context entries to the active Plan and Ticket.
- [x] Show who contributed each decision, constraint, blocker or clarification.
- [x] Show which Plan/Ticket field changed because of new context.
- [x] Ensure accepted active constraints are included in the agent's run context.
- [x] Ensure new material context reaches the next relevant run without manual prompt relay.
- [ ] Decide and implement the safe behavior for material constraints added while work is running: notify, pause, block or require a human decision.
- [x] Surface blockers as practical work state rather than passive notes.
- [x] Record supersession rather than silently rewriting context.
- [x] Verify context cursor/envelope behavior before claiming every agent automatically has the latest shared context.

Definition of done:

- Adding a constraint visibly changes the work or its readiness.
- The responsible agent receives the accepted current constraint without a person copying it into a new private prompt.

## Ticket flow from conversation

- [x] Create the next Ticket inline from an accepted Plan.
- [x] Show human language: owner, resource, may change, must preserve, done when.
- [x] Keep why, expected effect, scope, capabilities, owner, project and acceptance criteria canonical underneath.
- [x] Let the human approve, deny or discuss the Ticket inline.
- [x] Show approval as the moment responsibility and authority become effective.
- [x] Link Ticket state changes to the originating thread.
- [x] Ensure approved work dispatches only to the assigned owner.
- [x] Ensure reassignment/scope/capability/criteria changes revoke prior approval as current invariants require.

Definition of done:

- The conversation visibly becomes bounded, assigned work without the user manually rebuilding it in Board.

## Board as projection

- [x] Rework Board so its primary job is visualizing existing Plans/Tickets by state.
- [x] Remove or collapse the always-visible large Plan/Ticket creation forms from the default view.
- [x] Keep manual creation behind one deliberate `New` flow where useful.
- [x] Ensure manual creation writes the same canonical records and thread events.
- [x] Show origin conversation/channel on every Plan and Ticket detail.
- [x] Add `Open in conversation`/`Discuss` behavior that returns to the exact relevant card/event.
- [x] Ensure Board edits immediately update the inline card.
- [x] Ensure conversation decisions immediately update Board.
- [x] Treat Board counts/columns as projections, not a second workflow owner.

Definition of done:

- A user cannot create, approve or mutate shadow work that exists only in Board.
- Board can be removed from the screen without losing the ability to complete the canonical workflow in conversation.

## Work lifecycle strip

- [x] Add one concise lifecycle representation to the inline work/run surface.
- [x] Use user-facing states such as Understanding, Planning, Waiting for you, Assigned, Working, Blocked and Verified.
- [x] Derive state from canonical Plan, Ticket, interaction and run records.
- [x] Show owner and attached project/resource where relevant.
- [x] Show the next required human action.
- [x] Keep raw provider/tool state secondary.
- [x] Avoid swarm graphs and autonomous-manager language.

Definition of done:

- A user can tell who owns the work, what state it is in and what happens next without opening several panes.

## Unified ResultCard

- [x] Add a canonical ResultCard to the origin conversation when owned work completes.
- [x] Present requested outcome, concise result, changed items, deliberately unchanged items, artifacts/files/branch/PR, checks, acceptance result, human decisions and next action.
- [x] Link to Plan, Ticket, project, full trace, logs and evidence.
- [x] Project existing ToolExecution artifacts and Ticket verification into the card where possible.
- [ ] Define missing canonical result fields only after proving existing records cannot project them.
- [x] Keep raw logs and traces available but collapsed by default.
- [ ] Represent failure, denial, cancellation and partial completion honestly.
- [ ] Keep ResultCard updated if evidence or linked artifacts arrive after the first completion event.

Definition of done:

- A reviewer understands what happened and whether it satisfied the work without reconstructing it from final prose, trace chunks, ToolCards and ItemDrawer history.

## Structured responsibility and handoff

- [ ] Keep one explicit owner for each executable Ticket.
- [ ] Represent handoff as a structured human-approved responsibility change, not agent chatter.
- [ ] Deliver relevant context and prior result to the next owner automatically.
- [ ] Record who proposed, approved and received the handoff.
- [ ] Do not implement autonomous agent-to-agent mentions as the first solution.
- [ ] Do not implement manager/worker agent hierarchies without validated demand.

Definition of done:

- A human no longer has to paste the previous agent's result and constraints into the next owner's private prompt.


# P0 — Canonical demo scenario in the real app

## Convert the billing demo into the product proof

- [ ] Keep the billing inconsistency and hidden ledger constraint as the canonical scenario.
- [ ] Update the script/schema so the demo can produce an inline PlanCard.
- [ ] Make the initial Plan plausible but incomplete without Tom's ledger constraint.
- [ ] Show the exact Plan change after the constraint arrives.
- [ ] Pause for the real viewer to accept the Plan and/or approve the Ticket in the app onboarding path.
- [ ] Stop auto-approving the onboarding proof through a scripted persona.
- [ ] Route work through the real authorization/dispatch/project pipeline.
- [ ] Produce the real ResultCard.
- [ ] Verify invoice and PDF agreement while ledger fixtures remain unchanged.
- [ ] Keep demo data isolated, restartable and clearly labeled.
- [ ] Handle noodle/provider unavailability with an honest deterministic playback fallback.
- [ ] Ensure demo cleanup never deletes unrelated user work.

Definition of done:

- The demo proves that shared human context changed authorized work before execution and that the final result preserved the new constraint.

## Demo playback modes

- [ ] Interactive in-app onboarding mode with real user decision.
- [ ] Deterministic in-app replay mode for support/demo reliability.
- [ ] Landing-page video/recording mode sourced from the real app.
- [ ] Accessible transcript/poster mode.
- [ ] Reduced-motion mode.
- [ ] Short social cut derived from the same canonical story.


# P0 — Nail the app onboarding flow

Detailed behavior is specified in `AGENTS/onboarding.txt`.

## Durable first-run lifecycle

- [ ] Add server-authoritative onboarding state bound to the new account's starter workspace.
- [ ] Backfill existing accounts so they are not forced through first-signup onboarding.
- [ ] Preserve invite precedence.
- [ ] Support pending, in-progress, paused, completed and skipped states.
- [ ] Version the onboarding.
- [ ] Make completion cross-device.
- [ ] Use local storage only as a cache/duplicate-tab aid, not authority.
- [ ] Add replay that does not reset original completion analytics.

## Demo-first opening

- [ ] Offer the canonical demo immediately after the starter workspace connects.
- [ ] Allow immediate skip.
- [ ] Explain what the user will learn and the approximate nature of the walkthrough without promising a fixed duration.
- [ ] Use the same story and language as the landing page.
- [ ] End with `Same agents. Different system of work.`

## Real-work activation

- [ ] Transition from demo to `Bring one piece of work`.
- [ ] Offer job-based starters: investigate before coding, scope a feature, recurring review rework, custom work.
- [ ] Prefill the real composer and allow editing.
- [ ] Produce an inline PlanCard.
- [ ] Ask for one reviewer/PM/customer/security constraint.
- [ ] Show how it changed the Plan.
- [ ] Let the user accept/refine the Plan.
- [ ] Do not require project setup or invites.
- [ ] If the user has no executable resource, offer the canonical example for the full execution proof and leave their real Plan intact.

## Visual guidance

- [ ] Use noodle/favicon as guide personality.
- [ ] Build accessible showcase modal behavior.
- [ ] Add stable onboarding target attributes.
- [ ] Use spotlight only for the differentiated artifacts/actions.
- [ ] Do not tour every tab.
- [ ] Switch to inline non-modal guidance for real actions.
- [ ] Restore focus and remove every overlay on pause/skip/workspace switch.
- [ ] Add reduced-motion handling.
- [ ] Verify both app themes, narrow viewport and 200% zoom.

## Persistent getting-started guide

- [ ] Accepted Plan after meaningful constraint.
- [ ] Approved bounded work and ResultCard viewed.
- [ ] Project/folder connected or user-owned agent paired.
- [ ] Teammate invited or another independently owned agent added.
- [ ] Outcome-based deep links.
- [ ] Dismiss, resume and replay.

## Contextual education

- [ ] First PlanCard.
- [ ] First changed constraint.
- [ ] First Ticket approval.
- [ ] First permission checkpoint.
- [ ] First ResultCard.
- [ ] First Board visit as projection.
- [ ] First Projects visit as repository projection.
- [ ] First Resources visit as resource ownership.
- [ ] First Add Agent visit as independent runtime pairing.
- [ ] First invite as pre-execution collaboration.

## Failure paths

- [ ] Noodle offline.
- [ ] Noodle removed.
- [ ] Slow/no provider response.
- [ ] Workspace disconnect/reconnect.
- [ ] Workspace switch.
- [ ] Missing spotlight target.
- [ ] Private-mode storage denial.
- [ ] Duplicate tabs.
- [ ] Demo failure.
- [ ] No project/resource connected.


# P0 — Rework the landing page

Landing-specific direction is documented in `/home/harris/Programming/convyio/site/PRODUCT-DIRECTION.md`.

## Interim message correction

- [ ] Replace `agents in the room` as the primary differentiation.
- [ ] Lead with `Agent work should start shared` or the validated equivalent.
- [ ] Explain the status quo stack and late coordination concretely.
- [ ] Promote `use the agents you already run; credentials stay with their owners` as reassurance.
- [ ] Update metadata, structured data, FAQ and closing copy consistently.
- [ ] Keep claims within current implementation.

## Final story rework

- [ ] Hero category POV.
- [ ] Canonical demo/video immediately after hero.
- [ ] Concrete old workflow section.
- [ ] Differentiated loop section.
- [ ] Independently owned agent/runtime section.
- [ ] Conversation-first/projection explanation.
- [ ] Narrow ICP examples.
- [ ] Switching-anxiety reassurance.
- [ ] Updated FAQ.
- [ ] Closing CTA restates hero promise.

## Replace the current primary demo

- [ ] Retire collaborative copywriting as the main product proof.
- [ ] Use the canonical billing constraint-before-work scenario.
- [ ] Show PlanCard, Plan change, human decision, bounded execution and ResultCard.
- [ ] Embed the final recording from the real app flow.
- [ ] Keep an accessible transcript or interactive playback.
- [ ] Provide captions, replay and reduced-motion poster.
- [ ] No autoplay audio.
- [ ] Update demo analytics to measure meaningful story depth.

## Preserve/fix existing landing quality

- [ ] Preserve flat solid Gruvbox visual rules.
- [ ] Preserve accessible single-field conversion form.
- [ ] Preserve reduced-motion handling.
- [ ] Resolve any remaining LCP/above-fold reveal issues.
- [ ] Verify light-theme contrast.
- [ ] Verify demo modal focus and scroll behavior.
- [ ] Verify canonical metadata/OG URLs.
- [ ] Keep the hero and closing CTA message-consistent.
- [ ] Build and run the site's SEO check.


# P0 — Produce the proper demo video

This starts only after the real app loop is visually coherent.

## Preproduction

- [ ] Lock the canonical billing storyboard from `AGENTS/onboarding.txt`.
- [ ] Define full, landing and social durations from one master sequence.
- [ ] Write captions and on-screen copy.
- [ ] Identify every product state that must be real versus deterministic.
- [ ] Create a repeatable clean demo workspace/fixture.
- [ ] Ensure the demo can restart without manual database repair.
- [ ] Verify all product claims with current architecture docs.

## Product capture

- [ ] Capture from the real polished onboarding/product flow.
- [ ] Show the exact constraint changing the Plan.
- [ ] Show the human acceptance/approval.
- [ ] Show the lifecycle without dwelling on raw trace output.
- [ ] Show ResultCard and evidence clearly.
- [ ] Keep cursor movement and pacing deliberate.
- [ ] Avoid showing development-only data, secrets or unstable UI.

## Postproduction

- [ ] Full master.
- [ ] Landing-page optimized cut.
- [ ] Short social/hackathon cut.
- [ ] Caption file and embedded captions.
- [ ] Accessible transcript.
- [ ] Poster frame/reduced-motion storyboard.
- [ ] Compression and responsive sources.
- [ ] Silent autoplay-safe version.
- [ ] Human-reviewed audio description if meaningful visual information is otherwise lost.

## Validation

- [ ] Show the video without explanatory preamble to ICP participants.
- [ ] Ask them to explain the product and the problem afterward.
- [ ] Revise if they remember `chat with agents` more than `constraint changed work before execution`.


# P0 — Make selected ICP users understand and care within five minutes

## Observed first-use testing

- [ ] Recruit selected ICP users rather than general developers.
- [ ] Observe the landing page and onboarding without coaching.
- [ ] Capture first spoken interpretation.
- [ ] Capture where they hesitate or form the Slack/swarm mental model.
- [ ] Ask what they would use Convyio for next week.
- [ ] Ask who else would need to join that workroom.
- [ ] Ask what would stop them from trying it on one real task.
- [ ] Run sessions with solo champions and two-person teams.
- [ ] Run at least one agency/client-delivery scenario and one release/hotfix scenario.

## Comprehension scoring

- [ ] Correct: shared context becomes approved work and a reviewable result.
- [ ] Partial: shared context/visibility but no authority/result understanding.
- [ ] Incorrect: Slack bot, swarm, coding agent or project-management AI.
- [ ] Track comprehension after landing demo, after app demo and after first PlanCard.

## Product-love indicators

Do not define love as compliments. Look for behavior:

- [ ] User supplies real work without prompting.
- [ ] User adds a real constraint.
- [ ] User wants to connect a project.
- [ ] User identifies a teammate to invite.
- [ ] User asks to use their existing agent.
- [ ] User replays or shares the demo.
- [ ] User starts a second work item.
- [ ] User returns for another deadline/workstream.

## Instrumentation

- [ ] Category demo start/depth/completion.
- [ ] Onboarding start/pause/skip/completion.
- [ ] Real versus example path.
- [ ] PlanCard produced.
- [ ] Meaningful constraint added/confirmed.
- [ ] Plan accepted.
- [ ] Ticket approved.
- [ ] ResultCard shown/opened.
- [ ] Evidence opened.
- [ ] Project/folder connected.
- [ ] User-owned agent paired.
- [ ] Teammate invited.
- [ ] Second human contributes before execution.
- [ ] Second work item started.
- [ ] Day 1/7/30 retained usage by activation cohort when data is sufficient.

Do not add an analytics vendor solely for onboarding if current durable records and existing site analytics can answer the first questions.


# P0 — Dogfood Convyio from inside Convyio

- [ ] Select one bounded Convyio product change suitable for the canonical workflow.
- [ ] Start its discussion in a Convyio thread.
- [ ] Create/refine the inline PlanCard in that thread.
- [ ] Have a second human add a real constraint before execution.
- [ ] Accept the Plan.
- [ ] Approve a scoped Ticket owned by a paired local agent.
- [ ] Use a real Convyio project/resource assignment.
- [ ] Let the agent execute only through current authorization boundaries.
- [ ] Resolve any human permission checkpoint in the thread.
- [ ] Return tests/evidence in ResultCard.
- [ ] Review the full causal chain without accessing the agent owner's private transcript.
- [ ] Record every place a human still had to ferry context manually.
- [ ] Turn those failures into product backlog, not demo editing.

Definition of done:

- A small team can make and review one real Convyio change from inside Convyio, with the complete causal record visible to another human.


# P1 — Lower adoption friction

- [ ] Start a workroom from a GitHub issue or pull request.
- [ ] Paste/import a Slack or Teams thread with clear source attribution.
- [ ] Start from a Linear/Jira ticket or linked reference.
- [ ] Upload a specification and make it part of the Plan context.
- [ ] Preserve source links rather than silently copying truth.
- [ ] Provide project/workroom templates for release, hotfix, agency delivery and tiger-team work.
- [ ] Make `one workroom, not whole-company migration` explicit in product setup.
- [ ] Let users pair independently owned runtimes without an admin centralizing provider credentials.


# P1 — Strengthen multiplayer and responsibility

- [ ] Attributed decisions/constraints visible in the canonical thread.
- [ ] Human-approved structured handoffs.
- [ ] Material-change notifications for affected owners.
- [ ] Clear responsibility view across current Plans/Tickets.
- [ ] Collision warning when agents are assigned overlapping project/scope work.
- [ ] Shared artifacts and ResultCards usable by humans who do not run the agent.
- [ ] Workspace-level comprehension of which agents are available, owned by whom and able to access which resources.


# P2 — Validate before building

Do not start these without observed repeated demand:

- [ ] Capability-based automatic agent routing.
- [ ] Agent-to-agent handoffs without a human-approved responsibility record.
- [ ] Manager/worker agent hierarchies.
- [ ] Swarm visualizations.
- [ ] Agent marketplace.
- [ ] Generic operations-team expansion.
- [ ] Enterprise-wide replacement of chat/project tools.
- [ ] Broad compliance productization.
- [ ] Autonomous planning that bypasses conversation and human ownership.


# Documentation and claim maintenance

- [ ] Keep `AGENTS/PRODUCT_DIRECTION.md` current when product philosophy changes.
- [ ] Keep `AGENTS/onboarding.txt` current when the first-run flow changes.
- [ ] Keep this backlog aligned with accepted priorities.
- [ ] Update current architecture docs only when code behavior changes.
- [ ] Update target architecture when agreed direction changes.
- [ ] Keep `/home/harris/Programming/convyio/site/PRODUCT-DIRECTION.md` aligned with the canonical product direction.
- [ ] Audit landing/onboarding/demo claims against `CURRENT_*.md` before release.
- [ ] Never present target orchestration as implemented current behavior.


# Release gates

## Gate 1 — Message

- Selected ICP understands the problem and new workflow without a feature tour.

## Gate 2 — Product loop

- Real inline PlanCard, meaningful constraint change, human decision, bounded work and ResultCard exist in one canonical thread.

## Gate 3 — Dogfood

- Convyio can be changed from inside Convyio without private-context relay.

## Gate 4 — Onboarding

- Solo and two-person ICP users complete or understand the differentiated loop without mandatory setup.

## Gate 5 — Demo

- The recorded canonical demo is honest, clear, accessible and sourced from the real product flow.

## Gate 6 — Landing

- The landing page uses the same POV and proof, and users do not mistake Convyio for Slack with bots or a swarm framework.

## Gate 7 — Early access learning

- Instrumentation and interviews reveal whether accepted Plans, ResultCards and pre-execution collaboration predict repeat use.
