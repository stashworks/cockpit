Yes. This makes the architecture map much more powerful, because instead of one fixed diagram, it becomes a queryable model of the application.

The key is that tags should not just be labels stuck on pages. They should become dimensions in the architecture graph.

So for https://app.example.com/dashboard, you could click that page and ask the system:

Show me everything this page can touch.

And the map expands outward from that page:

Business OS Dashboard
/app/dashboard
   │
   ├── FEATURE: Business OS
   ├── RBAC: executive, manager
   │
   ├── API: /api/goals
   │      └── Goals Service
   │             └── goals table
   │
   ├── API: /api/projects
   │      └── Project Service
   │             └── projects table
   │
   ├── API: /api/tasks
   │      └── Task Service
   │             └── tasks table
   │
   └── COMPONENTS
          GoalSummary
          ProjectStatus
          TaskPanel

But then the same graph can be sliced completely differently.

Click RBAC View and suddenly the question becomes:

Which pages have RBAC protection?

🟢 /dashboard
🟢 /projects
🟢 /billing
🔴 /admin/import
🟡 /reports/export

That red /admin/import becomes extremely interesting.

Not because the AI knows it's wrong.

Because the system knows:

93% of admin-like pages have RBAC.
This one does not.

That is exactly the kind of anomaly you want surfaced to a human.

I would make the whole thing "lens driven"

You're looking at the exact same software graph through different lenses.

The lenses I'd build are:

Page Lens: starting from a URL/page, show components, APIs, services, DB tables, external systems, permissions and features it can reach.
Feature Lens: show everything implementing Goals, Projects, Billing, etc.
RBAC Lens: show protected/unprotected pages, APIs, actions and data access, plus inconsistent permission models.
Data Flow Lens: show where data originates, how it transforms and where it ends up.
API Lens: show callers, consumers, inputs, outputs, auth, validation and database access.
Database Lens: start at a table and show every page/API/service capable of reading or modifying it.
Dependency Lens: show what imports/calls what.
Unused/Orphan Lens: identify code, APIs, routes, tables, components and dependencies that appear unreachable.
Security Lens: auth, authorization, secrets, external calls, sensitive fields and trust boundaries.
Change Lens: "What did FEATURE-427 alter?"
Blast Radius Lens: "If I change this service, what could break?"
Architecture Drift Lens: highlight structures that don't match normal architecture patterns.

That turns the architecture view into something much closer to Google Maps for your software.

You aren't asking for one beautiful architecture diagram that becomes wrong six weeks later.

You're asking questions of the software.

Your Goals → Projects → Tasks example is particularly important

You should be able to select the tag:

workflow:goals-projects-tasks

And get:

GOAL
 │
 │ creates / relates
 ▼
PROJECT
 │
 │ contains
 ▼
TASK
 │
 │ assigned to
 ▼
USER

But don't stop at the logical model.

Overlay implementation:

Goal Page
   ↓
Goals API
   ↓
GoalsService
   ↓
goals table
   │
   └──── project_goal_relationship
                 ↓
             projects
                 ↓
              tasks

Then overlay ownership/security:

GOAL
RBAC: Executive / Manager
Tenant Scoped: YES

PROJECT
RBAC: Manager / Contributor
Tenant Scoped: YES

TASK
RBAC: Contributor
Tenant Scoped: ⚠ REVIEW

Now you see immediately that Tasks might not be enforcing tenancy the same way.

That's the stuff you will never catch by staring at 300 files.

Billing is another fantastic lens

You should be able to click:

Billing

and tell the architecture:

Show every dependency reachable from Billing.

Now maybe you get:

Billing Page
    │
    ├── Billing API
    │      ├── Stripe
    │      └── billing tables
    │
    └── Organization Service

Perfect.

But if you suddenly see:

Billing
   ↓
Customer AI Memory

that's suspicious.

Or:

Billing API
   ↓
Goals Database

Why?

Maybe there is a legitimate reason.

But the system should put a giant:

🟡 WORTH A LOOK

on that edge.

That's an important concept I would preserve from your idea.

You don't want the AI saying:

This is definitely wrong.

You want it saying:

This connection is unusual. A human should understand why it exists.

Huge difference.

I really like "Worth a Look"

I might actually make that a formal category in the product.

Not Errors.

Not Warnings.

Worth a Look.

Because you're acknowledging something important:

The system cannot conclusively understand every design intention.

So you have:

🟢 Expected

🟡 Worth a Look

🔴 Violates Rule

⚫ Unused / Unreachable

🟣 New / Changed Recently

That is probably much more useful than pretending AI can reliably issue architectural verdicts.

Your dashboard can have:

Worth a Look: 17

And those are the 17 things where human judgment gives you the greatest return.

That's exactly how you keep AI moving quickly without trying to review 60,000 lines.

And absolutely include unused things

Not just unused code.

I'd build an entire Orphans category.

Things like:

Unused functions
Unused components
Unused files
Unused APIs
Unused DB tables
Unused columns
Unused npm packages
Routes never accessed
Services with no callers
Feature flags no longer referenced
Permissions never checked
Tests for deleted functionality
Environment variables no longer consumed
Queues with no producers
Queues with no consumers

And again, don't automatically delete them.

Flag:

⚫ No known references.
Last modified 187 days ago.
Last runtime execution: never observed.
Created as part of FEATURE-192.
Human review recommended before deletion.

That's fantastic AI cleanup territory once approved.

APIs deserve an even deeper treatment

For every endpoint, I'd want a card something like:

POST /api/projects

Feature:
Projects

Called By:
Project Page
Business OS
Mobile Client

Auth:
✓ Authenticated

RBAC:
✓ Project.Create

Tenant Isolation:
✓ organization_id

Inputs:
name
description
goal_id
owner_id

Writes:
projects
project_members

Reads:
goals
users

External Calls:
None

Unexpected Connections:
🟡 Reads users directly instead of UserService

Now you're inspecting APIs without reading controllers.

And eventually you can do something even cooler:

Data lineage.

Select:

customer.email

And ask:

Where can this data go?

You see:

users.email
    │
    ├── User Profile
    ├── Notifications
    ├── Audit Log
    ├── CRM Integration
    └── 🟡 AI Prompt Context

Whoa.

Why is customer email going into AI prompt context?

Maybe legitimate.

Maybe not.

But now you know to look.

This is exactly the visibility layer missing from AI development.

There are several other views I'd definitely add

One especially important one is boundary crossing.

You define conceptual boundaries:

Billing
HR
Goals
Projects
Tasks
AI
Administration
Identity
Reporting

Then ask:

Show everything crossing domain boundaries.

Most internal activity disappears.

You only see:

Goals → Projects       Expected
Projects → Tasks       Expected
Billing → Identity     Expected
Billing → Projects     🟡
Tasks → Billing        🔴
AI → HR                🟡

That is an extremely fast architectural review.

You could probably inspect an enormous application in minutes.

Another: "Show me the weird stuff"

This could literally be a button.

The AI examines the application and surfaces statistical/architectural outliers:

WORTH A LOOK

🟡 One page bypasses API layer.

🟡 One service has 14x more dependencies than average.

🟡 Three APIs return database entities directly.

🟡 Two pages use a different RBAC implementation.

🟡 One table is written by six unrelated domains.

🟡 Four services independently implement email validation.

🟡 One npm package exists only for a single function.

🟡 Seven modules have no runtime observations.

🟡 Billing calls a Projects internal API.

🟡 AI module reads fields tagged PII.

🟡 FEATURE-382 introduced the only direct DB access from UI-adjacent code.

That might become one of the most useful screens in the entire product.

Because instead of you asking the correct question, the system asks:

What's unusual about this application?

And tags make all of this possible

I would allow both human tags and machine-derived tags.

You might define:

feature:goals
domain:planning
page:dashboard
workflow:goal-to-task
sensitivity:internal
rbac:manager
tenant:scoped

The system derives others:

db-write
external-api
cross-domain
auth-required
pii
high-coupling
runtime-active
unused
new
changed
duplicate-candidate

Then your architecture becomes queryable:

Show feature:billing AND db-write

Show page:* WITHOUT rbac:*

Show external-api AND sensitivity:pii

Show domain:billing connected to anything outside domain:billing

Show unused created within the last 90 days

Show everything touched by FEATURE-443.

That is where this gets really powerful.

You're no longer navigating code.

You're interrogating the software system.

And your last point is exactly right: coding without errors isn't realistic, whether humans or AI are doing it. The win isn't somehow making the AI infallible. The win is making its mistakes observable at a level where a human can understand them quickly.

So I think the product thesis is becoming clearer:

Don't slow the AI down enough for the human to follow the code. Build an observability layer that lets the human follow the software.

That is a much stronger idea.



# Build the Architecture Inspection and AI-Code Oversight Layer

We are building an AI-native software engineering control plane.

The human is not reviewing source code line by line. AI agents are writing most implementation code. The purpose of this subsystem is therefore NOT conventional static code analysis.

Its purpose is:

**Allow a human to inspect what the AI is building at the feature, page, architecture, API, security, data-flow, and dependency level without slowing development down to source-code review speed.**

The system must assume AI will make mistakes.

We are not trying to eliminate all mistakes.

We are trying to make AI mistakes visible early, understandable, traceable, and reviewable.

The architecture system must therefore answer two types of questions:

1. **What does the system look like now?**
2. **What did this change do to the system?**

The second question is more important during active development.

---

# 1. Core Architecture Model

Build a living architecture graph representing the application.

The graph should contain nodes such as:

* Pages / Routes
* Features
* Domains
* Workflows
* UI Components
* APIs
* Services
* Functions
* Database Tables
* Database Columns where useful
* Queues
* Background Jobs
* External Services
* AI Services / Models
* Authentication Components
* Authorization / RBAC Components
* Dependencies / Packages
* Files
* Infrastructure Components

Edges should represent relationships such as:

* page calls API
* component used by page
* API calls service
* service reads table
* service writes table
* service calls external API
* function imports function
* feature implemented by service
* page participates in workflow
* API requires RBAC
* data flows from X to Y
* queue producer / consumer
* dependency used by module
* feature changed component

This architecture graph becomes the foundation for every architecture view.

---

# 2. Tagging System

Tags are critical.

Every architectural node should support tags.

Tags may be:

## Human-defined

Examples:

feature:goals
feature:projects
feature:billing

domain:planning
domain:identity
domain:billing

page:dashboard

workflow:goal-project-task

rbac:manager
rbac:admin

sensitivity:pii
sensitivity:financial

tenant:scoped

criticality:high

## Machine-derived

Examples:

db-read
db-write
external-api
cross-domain
auth-required
rbac-protected
runtime-active
unused
unreachable
new
recently-changed
duplicate-candidate
high-coupling
high-fan-in
high-fan-out
architecture-outlier
security-sensitive

Tags must be queryable and usable as filters.

The user should be able to ask:

Show feature:billing.

Show all pages without rbac protection.

Show external-api AND sensitivity:pii.

Show domain:billing connected to anything outside domain:billing.

Show unused.

Show everything touched by FEATURE-284.

Show everything reachable from page:/dashboard.

Tags should drive architecture slicing.

---

# 3. Page-Centric Architecture View

Every application page should have a visual architecture view.

Example:

https://app.example.com/dashboard

Selecting this page should visually show everything reachable from it.

Example:

Business OS Dashboard
/app/dashboard

→ UI Components
→ APIs
→ Services
→ Database Objects
→ External Services
→ Related Features
→ RBAC
→ Workflows

The human should be able to answer:

What does this page touch?

What can this page read?

What can this page write?

What services does this page depend on?

What external systems can this page reach?

What RBAC protects this page?

What Feature does each component belong to?

What database tables are reachable from this page?

What data leaves the system because of this page?

This view should be available for EVERY application page.

---

# 4. RBAC Lens

Create an RBAC architecture lens.

This view should immediately reveal:

* pages with RBAC
* pages without RBAC
* APIs with RBAC
* APIs without RBAC
* authorization decisions
* permission types
* inconsistent implementations
* tenant isolation
* admin-only capabilities
* unusual authorization paths

Example:

/dashboard                GREEN
/projects           GREEN
/billing            GREEN
/admin/import       RED
/reports/export     YELLOW

The important question is:

**Where should RBAC probably exist but does not?**

The system should use architecture patterns and tags to detect anomalies.

Examples:

"This is the only admin page without RBAC."

"This route used to pass through RBAC but no longer does."

"This API is reachable from an authenticated page but has no authorization check."

---

# 5. Workflow Lens

Allow workflows to be tagged and visualized.

Example:

workflow:goal-project-task

Display:

Goal
↓
Project
↓
Task

Then overlay the implementation:

Goal Page
↓
Goals API
↓
Goals Service
↓
goals table
↓
project relationship
↓
projects table
↓
Tasks API
↓
tasks table

Then overlay:

* RBAC
* tenant isolation
* data ownership
* pages
* APIs
* service boundaries
* database relationships

The user should visually understand how a business process moves through the application.

---

# 6. Domain / Boundary Lens

Allow architecture domains such as:

Billing
Identity
Goals
Projects
Tasks
AI
Administration
Reporting

Show relationships crossing domain boundaries.

Example:

Goals → Projects         EXPECTED
Projects → Tasks         EXPECTED
Billing → Identity       EXPECTED
Billing → Projects       WORTH A LOOK
Tasks → Billing          VIOLATION
AI → HR                  WORTH A LOOK

This view should make unexpected architectural coupling obvious.

---

# 7. Billing and Sensitive-Domain Inspection

The user should be able to select Billing and ask:

Show me everything Billing can reach.

Expected:

Billing Page
→ Billing API
→ Billing Service
→ Billing Tables
→ Payment Provider
→ Identity

Suspicious example:

Billing
→ Projects internal API

or

Billing
→ unrelated customer AI memory

Do not automatically assume the connection is wrong.

Instead classify unusual architecture relationships as:

**WORTH A LOOK**

The goal is to surface unusual connections for human judgment.

---

# 8. API Lens

Create an API architecture inventory.

For every endpoint show:

Endpoint
HTTP method
Feature
Domain
Calling Pages
Calling Services
Authentication
RBAC
Tenant Isolation
Inputs
Outputs
Database Reads
Database Writes
External Calls
Runtime Usage
Last Changed
Feature That Changed It
Tests
Security Findings
Unexpected Connections

Example:

POST /api/projects

Feature:
Projects

Called By:
Project Page
Business OS

Authentication:
YES

RBAC:
Project.Create

Tenant Isolation:
organization_id

Reads:
goals
users

Writes:
projects
project_members

External Calls:
none

Worth a Look:
Reads users table directly instead of UserService.

---

# 9. API Routes Nothing Calls

This should be a first-class architecture finding.

Once frontend → API reachability is known, detect API routes that have no known caller.

Example:

GET /api/internal/export-all-users

Known page callers:
0

Known service callers:
0

Runtime calls:
2 in last 30 days

Classification:

WORTH A LOOK

Possible explanations:

* dead API
* legacy API
* integration API
* undocumented administrative endpoint
* potential back door

Never automatically delete these.

Present them for review.

---

# 10. Data Flow Lens

Allow the user to inspect where information flows.

Example:

customer.email

→ User Profile
→ Notifications
→ CRM
→ Audit Log
→ AI Prompt Context

The user should be able to ask:

Where can this data go?

What external services receive it?

What AI systems receive it?

Which database tables contain it?

Which APIs expose it?

Which pages display it?

Which workflows use it?

This is especially important for:

PII
financial data
authentication data
billing data
customer data
AI prompt context

---

# 11. Unused / Orphan Lens

Expand the existing "code nothing imports" capability.

Detect:

* unused files
* unused functions
* unused components
* unused APIs
* routes with no callers
* services with no callers
* database tables never accessed
* database columns never referenced
* unused npm packages
* unused feature flags
* environment variables never consumed
* queues with no producer
* queues with no consumer
* tests for deleted functionality

Color classification:

BLACK / GRAY = UNUSED OR UNREACHABLE

Clicking the finding should show:

Object
Location
Created Date
Last Changed
Feature That Created It
Known References
Runtime Usage
Reason It Appears Unused

Never automatically delete.

Human review first.

---

# 12. "Worth a Look" Is a Formal Product Concept

Do NOT pretend AI knows every architecture decision.

Create four important categories:

GREEN
Expected / healthy

YELLOW
Worth a Look

RED
Known rule violation

GRAY
Unused / unreachable

PURPLE
Recently introduced / changed

"Worth a Look" is especially important.

This category means:

"The system cannot prove this is wrong, but it is unusual enough that a human should understand why it exists."

Examples:

* billing calls Projects
* AI reads PII
* one service has 14x normal dependencies
* one API bypasses normal service patterns
* one page has different RBAC implementation
* one database table is written by six unrelated domains
* one npm package exists for one trivial function

---

# 13. Show Me the Weird Stuff

Create a dedicated architecture view called:

**Worth a Look**

or:

**Show Me the Weird Stuff**

This view uses architecture anomalies to prioritize human inspection.

Examples:

One page bypasses API layer.

One service has 14x more dependencies than average.

Three APIs return raw database objects.

Two pages use a different RBAC implementation.

One table is written by six domains.

Four services implement email validation separately.

One npm package exists for one utility call.

Seven modules have no known runtime use.

Billing calls Projects internal API.

AI system reads PII.

One route no longer passes through authorization.

FEATURE-382 introduced the only direct database access from a controller.

Sort these by:

severity
confidence
recentness
blast radius
security relevance
business criticality

---

# 14. Reachability Diff on Every PR

This is a critical capability.

Do NOT only show architecture state.

For every PR calculate:

ARCHITECTURE BEFORE

versus

ARCHITECTURE AFTER

Then report what became newly reachable or unreachable.

Examples:

"This PR made Billing reachable from three new pages."

"This PR caused /admin/import to bypass all nodes tagged rbac."

"This PR created a new path from AI → customer.email."

"This PR made Goals Service reachable from Billing."

"This PR removed the only known caller of /api/legacy/export."

"This PR introduced four new paths into users table."

Architecture state becomes backlog.

Architecture diff becomes a decision.

Run this analysis BEFORE merge while the developer or AI agent can still act.

---

# 15. Blast Radius Versus Stated Intent

Every Feature / PR has stated intent.

Example:

FEATURE:
Fix billing calculation.

PR description:
Correct invoice rounding error.

Expected affected architecture:

Billing

Actual diff touches:

Billing
Authentication
Goals
Projects
Notifications

This should produce:

WORTH A LOOK

Reason:

Blast radius significantly exceeds stated intent.

Show:

Expected domains:
1

Actual domains touched:
5

Unexpected:
Authentication
Goals
Projects
Notifications

The system should ask:

Why did a billing calculation fix modify authentication?

This is specifically intended to catch AI wandering while fixing a problem.

---

# 16. Fan-In Trends

Track fan-in for important tagged nodes.

Fan-in means:

How many distinct things reach this node?

Example:

Auth Decision Service

January:
3 callers

February:
7 callers

March:
14 callers

April:
30 callers

The important finding is not necessarily 30.

The important finding is:

3 → 30

This could indicate:

* copy/paste architecture
* abstraction failure
* growing coupling
* bypass of canonical patterns

Track fan-in over time for:

authentication
authorization
billing
tenant scoping
critical tables
shared services
AI gateways
external integrations
logging
configuration

Show trend changes.

A sudden spike should become Worth a Look.

---

# 17. Fan-Out Trends

Also track fan-out.

How many architectural objects does a node reach?

Example:

BillingService

Last month:
6 dependencies

Today:
27 dependencies

Flag substantial growth.

This may indicate:

* god service
* excessive coupling
* feature creep
* architecture erosion

---

# 18. New Dependencies

Track dependencies introduced by AI.

For every PR:

New npm packages
Removed packages
Existing package reuse
Reason package added
Current repo alternatives

Example:

NEW PACKAGE

lodash-es

Purpose:
one array grouping helper

Existing capability:
native JavaScript Array.reduce

Classification:
WORTH A LOOK

Track:

new dependency count per PR
new dependency count per week
dependency growth trend

A spike is always worth reviewing.

Also compare proposed dependencies against what already exists in the repository.

---

# 19. Semantic Duplication

Do NOT rely only on identical source-code matching.

Detect semantic duplication.

Example:

SnapshotService

Purpose:
snapshot PROD and restore UAT

ProdCopyService

Purpose:
copy production data into UAT

Despite different names and different code, these may represent the same architectural capability.

Use:

* embeddings
* call graphs
* inputs
* outputs
* database access
* runtime behavior
* Feature relationships

Output:

Possible Duplicate Capability

SnapshotService
ProdCopyService

Semantic overlap:
82%

Recommendation:
Human review.

---

# 20. Canonical Architecture Patterns

The system should learn or be explicitly told normal architecture patterns.

Examples:

Authentication:
Request → Auth Middleware → Auth Service

Database:
API → Service → Repository → PostgreSQL

Logging:
StructuredLogger

Authorization:
Policy Middleware

Background Jobs:
Queue → Worker → Service

Then identify deviations.

Example:

New route:
Controller → PostgreSQL directly

Expected:
Controller → Service → Repository → PostgreSQL

Result:

RED or WORTH A LOOK depending on rule confidence.

---

# 21. New Architectural Object Review

Do not treat every new file as important.

Treat the creation of new architectural concepts as important.

Review creation of:

* new service
* new API
* new database table
* new queue
* new external dependency
* new authentication mechanism
* new authorization mechanism
* new cache layer
* new worker
* new cross-domain dependency
* new external data flow

When created, compare against existing architecture.

Example:

Proposed:
ProdCopyService

Existing related capabilities:

SnapshotService
82% similarity

BackupService
37% similarity

The Architecture Agent should ask:

Why can the existing SnapshotService not be reused?

---

# 22. Architecture Diff on Every Feature

Every Feature should have:

Before
After

Then report:

New services
Removed services
New APIs
Removed APIs
New DB tables
Changed DB tables
New cross-domain connections
Removed connections
New dependencies
New external calls
RBAC changes
Data-flow changes
Fan-in changes
Fan-out changes
Unused objects created
Unused objects removed
Semantic duplicates created
Architecture violations introduced

This should be visible from the Feature record.

---

# 23. Feature Architecture Impact

Do not use an arbitrary overall architecture score as the primary decision mechanism.

For every Feature show actual findings.

Example:

FEATURE-284
Refresh UAT from Production

Architecture Impact

GREEN
Reused SnapshotService
No new database tables
No new dependencies
Used existing RBAC pattern

YELLOW
SnapshotService fan-in increased from 4 → 6

RED
None

GRAY
Old DatabaseCopyHelper now appears unused

Result:
Architecture review PASS

Another example:

FEATURE-291

YELLOW
Billing now reaches Projects Service
New npm dependency introduced

RED
Admin route bypasses RBAC

GRAY
17 old files became unreachable

Result:
Architecture review BLOCK

---

# 24. PR Architecture Gate

Integrate this into CI/CD.

Example:

ARCHITECTURE REVIEW

Reachability Diff          PASS
Intent / Blast Radius      WARN
RBAC                       FAIL
New Dependencies           PASS
Semantic Duplication       WARN
Boundary Violations        PASS
Unused / Orphans           +7
API Reachability           PASS

RESULT:

BLOCK MERGE

Reason:

/admin/import no longer passes through any node tagged rbac.

Important:

The architecture reviewer should be independent from the coding agent.

Coder writes implementation.

Architecture Agent reviews architecture impact.

Security Agent reviews security impact.

Test Agent validates behavior.

Orchestrator decides what to do.

---

# 25. Architecture Timeline

Architecture should be historical.

Allow the user to view:

Today
Last Release
30 Days Ago
Before FEATURE-X
After FEATURE-X

Allow queries like:

When did Billing first connect to Projects?

Which Feature introduced this API?

When did AuthService fan-in jump?

Which PR caused this page to bypass RBAC?

When did this unused service stop being called?

The graph should therefore support temporal architecture analysis.

---

# 26. Runtime Reality Versus Static Architecture

Where possible compare static reachability against runtime telemetry.

Examples:

Static graph says:
API has no callers.

Runtime says:
API received 382 calls.

Result:
Unknown / undocumented caller.

Worth a Look.

Or:

Static graph says:
Service is reachable.

Runtime:
No observations in 180 days.

Result:
Possible dead architecture.

This distinction is important.

The graph should understand:

statically reachable
runtime observed
both
neither

---

# 27. Confidence

Every AI-generated architecture finding should have confidence.

Example:

Billing → Projects connection

Confidence:
HIGH

Why:
Direct code dependency

Semantic duplicate:

Confidence:
MEDIUM

Why:
82% behavior similarity but different data path

Possible unused API:

Confidence:
LOW

Why:
No static caller found, runtime telemetry unavailable

Human trust requires showing uncertainty.

---

# 28. Human Review Queue

Create a single prioritized human-review queue.

The user should not have to inspect everything.

Example:

WORTH A LOOK
17

HIGH PRIORITY

1.

Admin Import lost RBAC in PR #924

2.

Billing now reaches Projects

3.

AI Prompt Gateway receives customer.email

4.

AuthService fan-in increased 9 → 31

5.

New API has no known caller

MEDIUM

6.

8 unused files

7.

New npm package duplicates existing capability

8.

Possible semantic duplicate service

The objective is:

**Convert thousands of code changes into a very small number of meaningful human decisions.**

---

# 29. Architecture Queries

The architecture UI should support natural-language queries.

Examples:

Show me everything /dashboard can reach.

Show every page without RBAC.

Show everything touching billing.

Show Billing connections outside the Billing domain.

Show APIs nobody calls.

Show unused code.

Show data that reaches AI.

Show everything that reads customer.email.

Show all external API calls.

Show what changed architecturally in this PR.

Show what changed architecturally this week.

Show Features that increased AuthService fan-in.

Show code introduced in the last 30 days that nothing reaches.

Show architectural changes that exceeded their stated Feature scope.

Show me the weird stuff.

---

# 30. Visual Design

The Architecture workspace should feel like an interactive topology map, not a static diagram.

Support:

zoom
pan
filtering
tag filters
time filters
Feature filters
PR filters
domain filters
page filters
security filters
risk filters

Selecting a node should center the graph around it.

Selecting:

/dashboard

should make /dashboard the center and expand its architecture outward.

Selecting:

Billing

should center Billing.

Selecting:

customer.email

should display data lineage.

Selecting:

RBAC

should display authorization coverage.

Use edge colors or styles to indicate:

expected
worth a look
violation
unused
new / changed

The graph must remain understandable even for a very large application.

Do not simply dump thousands of nodes onto the screen.

Use progressive disclosure.

---

# 31. Core Product Philosophy

The AI coders should remain fast.

Do not require the human to inspect implementation details before every change.

Instead create inspection points where machine analysis compresses source-code complexity into understandable architectural decisions.

The human should inspect:

intent
feature behavior
architecture
reachability
security boundaries
data flow
APIs
dependencies
architecture drift
unusual changes

The AI handles:

functions
files
syntax
implementation details

The goal is not:

"AI writes perfect software."

The goal is:

**AI can write software at full speed while the human retains architectural visibility and control.**

Do not slow the AI down enough for the human to follow the code.

Build an observability and inspection layer that allows the human to follow the software.

---

# 32. MVP BUILD ORDER

Build this architecture inspection layer incrementally.

## Phase 1

Page → API edges

API → Service edges

Service → DB edges

Tag support

Page-centric architecture view

API inventory

Unused files / imports

## Phase 2

RBAC mapping

API routes with no callers

Architecture diff per PR

Reachability diff

Blast radius versus Feature intent

## Phase 3

Domain boundaries

Fan-in/fan-out trends

Dependency tracking

Unused architecture objects

Semantic duplicate detection

## Phase 4

Data lineage

Runtime telemetry correlation

Historical architecture timeline

AI anomaly detection

Natural-language architecture querying

Human review prioritization

The first major success criterion should be:

**Open any page in the application and immediately understand what that page can reach, what data it can access, what APIs it uses, what security controls protect it, and what changed recently.**

The second success criterion should be:

**Open any PR and immediately understand how that PR changed the architecture, whether the blast radius matches the stated intent, and what deserves human review before merge.**
