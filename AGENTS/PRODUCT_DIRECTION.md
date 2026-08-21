# Convyio product direction

Status: canonical product, positioning, ICP, onboarding, landing-page and demo direction.
Approved direction: 2026-08-19.

This document defines what Convyio is trying to become and how product decisions should be evaluated. Current implementation remains described by `AGENTS/ARCHITECTURE/CURRENT_*.md`; this document is product direction, not evidence that a capability exists.

## Product thesis

Convyio keeps the conversation, decisions, agent work and results in one shared thread.

The product is not primarily:

- a better chatbot;
- a replacement model or agent harness;
- an IDE;
- a Slack or Discord replacement;
- a project-management system with AI added;
- a multi-agent swarm builder;
- a high-pressure agentic operating system.

Convyio is the shared workroom where a small technical team and its independently owned agents turn conversation into coordinated, authorized work, then return that work to the same conversation as a reviewable result.

The model is not the differentiator. The system of work around the model is.

> Same agents. Different system of work.

## Category point of view

AI made execution fast. It did not make the work shared.

The common workflow is backwards:

```text
private prompt
  -> agent executes
  -> output or pull request appears
  -> teammates finally see the assumptions
  -> a missing constraint is discovered in review
  -> the work is redone
```

Agent work starts as one person's private session and becomes team work only at review. Shared context, authority and responsibility arrive after execution.

Convyio starts the work shared:

```text
shared request
  -> assumptions and constraints become explicit
  -> the team accepts the plan
  -> authority and ownership are explicit
  -> the responsible agent executes
  -> progress and decisions remain visible
  -> the result returns with evidence
```

The old way is not bad because Slack, Linear, GitHub or coding agents are bad products. It is broken because the work is split across tools built around different objects:

- chat holds discussion;
- issue trackers hold tasks;
- private agent sessions hold reasoning and execution;
- GitHub reveals code at review;
- one human manually relays context, prompts, decisions, files and status between them.

Convyio changes the collaboration primitive. It does not merely improve one of those tools.

## Working category description

Use a familiar frame plus the differentiated behavior. The current working descriptor is:

> A shared execution workroom for software teams and their agents.

A fuller description is:

> Convyio is the shared execution workroom where software teams turn context into approved agent work and get back reviewable results.

Supporting value language:

- Context becomes a plan.
- Authority becomes explicit.
- Work stays visible.
- Results return with evidence.
- Nobody has to ferry the work between tools.

Avoid using the following as the primary category:

- `AI workspace` — too easily understood as chat, docs or Notion with AI.
- `agent orchestration platform` — implies LangGraph, CrewAI, AutoGen or developer infrastructure.
- `multi-agent swarm` — attracts the wrong buyer and overstates current behavior.
- `AI teammates` — already claimed by Slack, Teams, Linear and coding-agent vendors.
- `operating system` — suggests an execution-control product rather than a conversation-centered collaboration tool.

The category language remains a hypothesis until it survives customer comprehension and switching interviews.

## Narrow wedge and ICP

### Primary wedge

Target small technical teams already running several coding agents against the same product under deadline.

Strong examples:

- AI-native startup teams shipping releases;
- software agencies delivering client work;
- recurring product launch teams;
- incident and hotfix teams;
- internal tiger teams using mixed agent tooling;
- teams developing a product while several people use Claude Code, Codex, Cursor, Copilot, Devin or other runners.

Hackathons are valuable for discovering behavior, generating concentrated demos and acquiring early champions. They are unlikely to be the durable paid customer because they are episodic and price-sensitive.

The repeat customer is a 2–10 person team that performs this kind of coordinated, agent-assisted delivery every week.

### Job to be done

> Keep multiple human and agent workstreams aligned and shippable without making one person manually relay prompts, constraints, decisions, status and files between every tool.

### AI maturity

The primary ICP already uses agents. Convyio is not teaching the team why AI might be useful. It is helping them move from individual AI productivity to team-level delivery without downstream chaos.

Strong readiness signals:

- at least two humans use coding agents regularly;
- more than one agent runtime or harness touches the same product;
- team members repeatedly paste Slack/Linear/GitHub context into private prompts;
- senior engineers discover missed constraints during review;
- agent-generated work is hard to attribute, steer or recover;
- multiple parallel agent sessions create duplicate or conflicting work;
- a customer, security owner or engineering lead asks what agents are allowed to do;
- one person has become the manual router for every agent.

### Roles

Likely champion:

- technical founder;
- engineering lead;
- staff or principal engineer;
- senior engineer already pushing agent adoption;
- hackathon or tiger-team lead.

Likely buyer:

- founder;
- CTO;
- VP or Head of Engineering;
- agency technical director;
- product-group lead with authority to adopt tooling.

Other contributors:

- engineers;
- product managers;
- designers;
- support and customer-facing specialists;
- security or compliance owners;
- domain experts who hold constraints the implementing engineer does not.

### Acquisition, activation, retention and expansion units

- Acquisition unit: one AI-forward champion.
- Product activation unit: one piece of work completes the differentiated Convyio loop.
- Retention unit: a small squad repeatedly uses the room for agent-involved work.
- Expansion unit: more people, agents, projects and workrooms join.

A team invite is not required for initial activation. The solo champion must be able to experience the value before asking anybody else to join.

### Not the initial ICP

Do not optimize the MVP for:

- solo hobbyists seeking only a faster personal coding assistant;
- nontechnical teams that need generic automation;
- companies that have not adopted agents at all;
- enterprises requiring mature compliance, procurement and administrative controls the product does not yet provide;
- agent-framework developers looking for a runtime or graph library;
- teams seeking autonomous swarms with no human conversation or approval;
- organizations looking to replace all company chat or project management immediately.

Solo users remain an important entry path and product champion. They are not the durable value unit.

## Market evidence

The 2025 Stack Overflow Developer Survey found that AI-agent users reported strong personal productivity but weak team collaboration: approximately 69% agreed agents increased their productivity, while only 17% agreed agents improved collaboration within their team. This individual-versus-team gap is the market opportunity.

The 2025 DORA report found that AI is an amplifier. It can increase throughput while continuing to correlate negatively with delivery stability. The surrounding system—workflow clarity, team alignment, context, platforms, testing and feedback loops—determines whether local AI gains become product performance or downstream chaos.

The implication is:

> The next AI bottleneck is not generation. It is the system around the generation.

Relevant sources:

- https://survey.stackoverflow.co/2025/ai/
- https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report
- https://www.aprildunford.com/post/an-introduction-to-positioning
- https://www.aprildunford.com/post/positioning-and-competition
- https://jobstobedone.org/the-four-forces/

## Competitive alternatives

The primary competitive alternative is the status quo stack, not one named vendor:

```text
Slack or Teams + Linear or Jira + GitHub + private Claude/Cursor/Codex sessions
```

Adjacent categories increasingly overlap with parts of Convyio:

- Slack and Teams put agents into channels.
- Linear represents agents as workspace members and delegates issues while retaining human responsibility.
- GitHub and Devin expose visible coding sessions and reviewable pull requests.
- LangGraph, CrewAI, AutoGen and OpenAI provide orchestration, handoffs, state and human-review primitives to agent builders.
- early human-agent work platforms provide rosters, tasks and approval surfaces.

Consequences:

- `agents in a room` is not enough differentiation;
- `agents as members` is not enough differentiation;
- `visible agent activity` is useful but increasingly expected;
- `multi-agent` is neither narrow enough nor valuable by itself;
- the product must prove the connected causal loop from shared conversation to reviewable result.

## Independently owned agents

A central product distinction is that participants may own different agent runtimes and credentials:

- Alice can run a locally authenticated Claude agent.
- Bob can run a Codex or other harness.
- The team can use managed noodle, a CI/reviewer agent or another paired runtime.
- Provider credentials remain with the runtime owner.
- Agents can use different models and harnesses.
- Convyio owns the shared workspace, mission, records, authority and dispatch—not the provider account.

The product coordinates work without requiring the team to centralize all agents, credentials or execution inside one vendor-controlled swarm.

This distinction should be visible after first value, not presented as a setup requirement.

## Conversation-first product model

### Canonical interaction surface

Conversation is the canonical work surface.

The user should be able to follow one causal thread containing:

- the original request;
- human context and constraints;
- agent questions and clarification;
- the proposed Plan;
- human edits and decisions;
- the next Ticket and owner;
- the authority granted;
- live work and tool activity;
- permission requests;
- blockers and handoffs;
- the result;
- verification evidence;
- follow-up discussion.

A user should never have to reconstruct why work happened by joining unrelated records from chat, Board and project views.

### Underlying canonical record

The workspace event ledger remains the canonical durable data record. The conversation is its primary human-facing causal projection.

### Projection planes

Other planes are alternate views of records that originate in or return to the thread:

- Board projects Plans and Tickets by state.
- The status-bar queue indexes unanswered approvals and permission requests.
- Agent/member cards project identity, status, current work, permissions and recent activity.
- Project views organize work and results by repository or branch.
- Activity/history views organize the same events by time or subject.

Product test:

> If an item appears in another plane, can the user jump to the exact originating or consequential thread event and surrounding context?

If not, the plane is becoming a second disconnected product.

### Resource and control planes

Not every operation belongs inside a conversation. Projects, Resources, workspace settings and agent setup also configure underlying resources:

- connect GitHub;
- pair a machine;
- share a folder;
- assign or revoke agent access;
- change owner consent;
- manage members and roles;
- configure an agent runtime.

These operations keep purpose-built interfaces. Their consequential effects must emit canonical events and become visible or linkable from the thread.

## Plans, Tickets and the Board

Plans and Tickets should be born from conversation.

The intended interaction is:

1. Work is discussed in the thread.
2. An inline PlanCard materializes.
3. Humans add constraints, edit, discuss and accept it there.
4. The next Ticket appears in the same thread.
5. Approval, assignment, progress, permissions and completion remain inline.
6. Board shows the same records organized by status.
7. Clicking a Board card can return to the originating conversation.

The Board is not the canonical home of work and should not feel like a separate project-management product. It is a functional projection over canonical Plans and Tickets.

Manual creation may remain available, but it must create the same records, emit the same events and establish an origin thread. Large always-visible Plan and Ticket forms should not dominate the default Board experience.

Permission requests already establish the correct pattern: the request is answered in the conversation, while the status-bar queue is another index over the same request.

## Shared context with practical consequences

Shared context is not valuable because it is stored. It is valuable when it changes what happens.

A decision, constraint, fact or blocker must be able to affect:

- the Plan shown for acceptance;
- whether work is ready to begin;
- the owner selected;
- the project or resource attached;
- the scope and capabilities granted;
- what the agent receives for the run;
- whether an in-flight run pauses;
- what verification is required;
- the final ResultCard;
- later work that depends on the same decision.

The UI must show those consequences. Useful patterns include:

- `Changed before execution` on a Plan after a new constraint;
- attribution for the person who supplied a constraint or decision;
- a visible link between one decision and the Plan/Ticket field it changed;
- `Blocked by this decision` or `Resumed after this approval`;
- a ResultCard section for `What deliberately remained unchanged`.

A context store that does not alter plans, prompts, authority, routing or verification is only a notebook.

## Orchestration philosophy

Orchestration should be felt through the result, not sold as a dashboard.

The user should see a legible progression such as:

```text
Understanding
  -> Planning
  -> Waiting for a human
  -> Assigned
  -> Working
  -> Blocked or requesting permission
  -> Resumed
  -> Verified
```

The shell may:

- compile relevant context;
- resolve the approved owner;
- dispatch durable work;
- attach the authorized project and scope;
- pause for the correct human;
- resume idempotently;
- return results and evidence to the origin thread;
- dispatch the next approved unit of work.

The user should not need to configure or watch:

- swarm graphs;
- manager/worker hierarchies;
- animated agent-to-agent lines;
- unstructured agent chatter;
- autonomous routing without explicit responsibility.

Convyio currently orchestrates authority and dispatch more than it orchestrates agent intelligence. Do not claim autonomous multi-agent coordination until it exists and customers demonstrate that they need it.

Structured human-approved handoffs are preferable to agents mentioning each other. The Plan/Ticket owner is responsibility; the server dispatches that responsibility.

## The differentiated value loop

A complete Convyio loop is:

```text
messy shared context
  -> editable Work Brief / PlanCard
  -> meaningful constraint or decision
  -> accepted Plan
  -> bounded Ticket with owner and verification
  -> visible execution and human checkpoints
  -> coherent ResultCard with proof
  -> follow-up in the same thread
```

This loop is the product's primary proof. Every onboarding, landing-page demo and dogfooding exercise should show it.

A generic agent reply is useful but not differentiated activation.

## Work Brief / PlanCard

The first major inline artifact should translate conversation into something the team can align on.

It should display human language rather than internal architecture terminology:

- intended outcome;
- context that matters;
- assumptions;
- constraints;
- open questions;
- proposed approach;
- what success means;
- likely affected resource;
- proposed owner;
- what changed after new information.

The existing Plan entity should remain canonical. `Work Brief` may be user-facing language for the first concise representation rather than a second data model.

Plan actions belong inline:

- add a constraint;
- answer a clarification;
- edit/refine;
- accept;
- request changes;
- discuss;
- open the Board projection.

## ResultCard

The final agent prose, trace, raw tool log, Ticket evidence and project artifacts currently force users to assemble the result themselves. The product needs one coherent ResultCard that answers:

- What outcome was requested?
- What happened?
- What changed?
- What deliberately did not change?
- Which files, artifacts, branch or pull request resulted?
- Which checks ran?
- Did the acceptance criteria pass?
- Which human decisions affected the run?
- Where are the Plan, Ticket, trace and full logs?
- What should happen next?

Raw traces and logs remain available as evidence. They are not the primary result.

## Solo-to-multiplayer progression

A solo champion should be able to experience the multiplayer value without inviting anybody first.

Noodle can ask:

> What is one thing a reviewer, PM, customer or security owner would not let this work break?

The user adds the constraint. The Plan visibly changes before execution. The user experiences the value of shared alignment even while playing multiple roles.

After the result, Convyio can say:

> This is the moment another tool normally discovers during review. In Convyio, the person who owns that constraint can add it before the work starts.

The optional demo shows the same moment with multiple people. The invite is then a natural next action:

> Invite the person who usually catches this.

`Keep working solo` remains equally available.

## Five-minute product standard

The aspiration is not literally that every person likes the product. The standard is that a correctly selected ICP user should understand and feel the distinctive value within five minutes.

Within five minutes, the user should be able to say:

> Convyio is where our team turns shared context into approved agent work and gets back a result we can review.

Incorrect explanations indicate product or onboarding failure:

- Slack with bots;
- another coding agent;
- an agent swarm;
- a project-management app with AI;
- a chat app with a Board tab.

Five-minute sequence:

1. Establish the old workflow and why the coordination point arrives too late.
2. Show one complete differentiated loop through the canonical demo.
3. Let the user apply the first half of that loop to their own real work.
4. Produce an editable PlanCard with a meaningful constraint.
5. Let the user make the decision.
6. Make the next value-producing action obvious without requiring setup.

The exact runtime response may exceed five minutes. Comprehension and the first human decision must not depend on an unpredictable model finishing a long execution.

## Product onboarding principles

- Demonstrate value, not navigation.
- Teach one causal thread, not four tabs.
- Show the differentiated loop before asking for GitHub, folders, agents or teammates.
- Use real product behavior where reliability permits.
- Use an explicitly labeled deterministic example where provider latency or project setup would otherwise block comprehension.
- Let the user make the consequential human decision in the demo.
- Never auto-approve on the user's behalf during the onboarding proof.
- Keep every step pausable, skippable and replayable.
- A returning expert can enter the product immediately.
- Do not force an invite.
- Do not force a project connection.
- Do not imply unavailable autonomous orchestration.
- Translate internal authority fields into who, where, what may change, what must remain true and how completion is proved.

The detailed onboarding specification lives in `AGENTS/onboarding.txt`.

## Canonical demo and demo video

One canonical scenario should power:

- the first product video shown during onboarding;
- the landing-page demo;
- the interactive onboarding example;
- sales and social clips;
- usability tests;
- product regression/dogfooding demonstrations.

The canonical product story is a shared engineering incident involving two founders and their independently owned agents. The billing rounding fixture remains the deterministic execution proof inside that story; it is not the category narrative.

The story proves the category difference:

- a daily activity agent reports project and Sentry evidence directly into the shared conversation;
- both founders see the same evidence without relaying a private-agent summary;
- the second founder asks their independently owned agent to inspect the affected code path;
- that agent references the first agent's evidence;
- the first agent builds on the second agent's diagnosis and proposes one shared Plan;
- the founders discuss the trade-off beside both agents;
- a ledger constraint changes the Plan before execution;
- the viewer accepts the Plan and approves one bounded owner, scope and verification target;
- the responsible implementation agent executes;
- the result and evidence return to the same conversation.

The billing fixture proves the final authorized implementation deterministically: invoice and PDF totals agree while ledger behavior remains unchanged. A GTM workflow is a secondary example of the same problem: agent results should enter the shared conversation directly instead of being manually relayed through private messages and copied prompts.

The demo should focus on removed context relay, agents building on shared findings and the prevented rework—not on message volume or model cleverness.

Suggested narrative spine:

```text
0–8s     Show the old chain: activity report -> private agent -> WhatsApp summary -> another private agent -> copied implementation prompt.
8–20s    Maya asks @noodle for daily project activity and Sentry correlation; the evidence appears in the shared thread.
20–35s   Tom asks @hermes to inspect the code path; Hermes references Noodle's evidence.
35–50s   Maya asks Noodle to build on Hermes's diagnosis; one shared Plan appears.
50–62s   Hermes identifies the ledger constraint; the Plan visibly changes before execution.
62–75s   The viewer accepts the Plan and approves one bounded implementation Ticket.
75–90s   Convyio routes the authorized work; progress stays in the thread.
90–105s  A ResultCard returns with changes, checks and preserved ledger behavior.
105–112s Same agents. Different system of work.
```

The interactive walkthrough pauses between major chapters and at consequential human decisions. Short landing and social cuts may compress the same sequence, but they must preserve the two-human/two-agent causal story.

The final duration is subordinate to clarity. A shorter cut may be used on the landing page; the complete version should remain available.

### Demo implementation standard

The app onboarding scenario is the source of truth. The production demo video should be recorded from the real, polished onboarding/product flow rather than independently animated to show impossible behavior.

The landing site may use:

- an optimized video recording for immediate visual proof;
- a lightweight interactive transcript for accessibility and exploration;
- a reduced-motion poster state;
- captions and controls;
- no autoplay audio.

The demo must remain honest about which parts are scripted and which parts are live.

## Landing-page direction

The landing page is category education plus proof. It should not read like a feature page.

### Above the fold

The first viewport should establish:

1. the concrete workflow problem;
2. the new collaboration model;
3. the canonical demo as immediate proof;
4. the low-risk starting action.

Provisional hero direction:

> Agent work should start shared.

Supporting copy:

> Turn team context into approved work and get back a result everyone can review—without ferrying prompts, decisions and files between chat, tickets, private agent sessions and GitHub.

Supporting proof/reassurance:

> Use the agents your team already runs. Their credentials stay with their owners.

CTA direction:

- `Run one piece of work` for a live product;
- `Get early access` while access remains gated;
- `Watch the full loop` for the secondary proof action.

### Landing-page story order

1. Hero category POV.
2. Canonical demo/video.
3. Concrete old workflow and its late coordination failure.
4. The differentiated loop: context, decision, bounded work, result.
5. Independently owned agents and local credentials as reassurance.
6. Conversation-first explanation: Board and project views are projections, not separate systems.
7. ICP examples and use cases.
8. Honest current-access CTA.
9. FAQ handling category confusion and switching anxiety.

### Landing-page claims

Lead with outcomes:

- constraints arrive before work;
- nobody manually relays every agent;
- human decisions have practical consequences;
- work remains visible;
- results return with proof;
- existing agents and credentials remain owned by their people.

Do not lead with:

- chat;
- channels;
- tabs;
- boards;
- agent counts;
- model names;
- multi-agent orchestration;
- generic productivity;
- `all-in-one` claims.

The landing-specific implementation brief lives in the site repository at `PRODUCT-DIRECTION.md`.

## Dogfooding standard

The original product goal—continue developing Convyio from within Convyio—is the strongest end-to-end acceptance test.

Convyio has reached the product standard when a small team can use Convyio to make a bounded Convyio change while:

- discussion starts in a shared thread;
- a PlanCard captures objective and constraints;
- a human adds or corrects a meaningful constraint;
- the Plan is accepted;
- the next Ticket is owned by a paired agent;
- only approved project resources and capabilities are available;
- progress and human checkpoints appear in the origin thread;
- the agent produces the change;
- tests and evidence return in a ResultCard;
- another human can understand and review the entire causal chain without asking for a private transcript.

A polished demo cannot substitute for this dogfood loop.

## Activation and measurement

### Category comprehension

After five minutes, ask selected users to explain Convyio in their own words. The target explanation is conceptually:

> It turns shared team context into approved agent work and reviewable results.

### Funnel progress

Track:

- demo viewed;
- demo completed;
- onboarding started;
- real-work path versus example path;
- PlanCard produced;
- meaningful constraint added or confirmed;
- Plan accepted;
- bounded Ticket approved;
- ResultCard opened;
- result evidence opened;
- project connected;
- user-owned agent paired;
- teammate invited;
- teammate contributes before execution.

### Activation hypotheses

- Product activation: a Work Brief/PlanCard is accepted after a meaningful constraint is surfaced.
- Differentiated activation: bounded work completes and the user opens the ResultCard/evidence.
- Collaborative activation: a second human contributes a decision or constraint before execution.
- Expansion activation: a real project or user-owned agent is connected.

A generic noodle reply is funnel progress, not the product's aha moment.

### Qualitative validation

Conduct switching and observed-use interviews with the narrow ICP. Look for concrete struggling moments:

- a constraint discovered in PR review;
- repeated prompt/context relay;
- conflicting parallel agent work;
- an agent action nobody clearly authorized;
- a result nobody else can reproduce or explain;
- one person becoming the manual agent dispatcher.

Do not validate by asking whether people like the idea. Reconstruct actual recent behavior and ask what they did without Convyio.

## Product decision filters

A proposed feature belongs in the MVP when it strengthens one or more of these:

- conversation remains the canonical causal surface;
- shared context changes the work;
- responsibility and authority become legible;
- independently owned agents can participate without credential sharing;
- manual relay between tools decreases;
- a result becomes easier to review and trust;
- the differentiated loop becomes faster to experience;
- the product becomes more usable by the narrow ICP under deadline.

A proposal should be rejected or deferred when it primarily:

- makes Convyio a better generic chat app;
- duplicates an IDE or coding harness;
- builds autonomous multi-agent complexity without customer evidence;
- adds another disconnected plane;
- turns conversation into secondary commentary on a workflow controller;
- requires team-wide migration before first value;
- increases setup before the differentiated loop;
- markets a target capability as current behavior.

## Claim integrity

Product, onboarding, landing and demo claims must distinguish:

- implemented current behavior;
- a deterministic example using real product paths;
- target behavior not yet implemented.

Current architecture truth comes from `AGENTS/ARCHITECTURE/CURRENT_*.md`. Target direction comes from `TARGET_WORKFLOW.md` and this document. Do not use target documentation as proof.
