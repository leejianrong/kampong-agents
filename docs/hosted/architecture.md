# Architecture

## System context

Three kinds of people and systems touch a deployment: the author who deploys it, the approver who unblocks it
and the sender whose events start it. A fourth, the workspace administrator, manages people and limits.
Model providers and connected apps are called with the workspace's own keys.

```mermaid
%% fig: context
flowchart LR
  author(["Workflow author<br/>(low-code user)"])
  approver(["Approver<br/>(workspace member)"])
  admin(["Workspace admin<br/>(IT lead)"])
  sender(["Event sender<br/>Alertmanager, GitHub, Slack, helpdesk"])
  idp[["Identity provider<br/>Okta, Entra ID, Google"]]
  kampong["<b>Kampong hosted</b><br/>kampong.abangai.dev<br/>build, deploy and run workflows"]
  llm[["Model providers<br/>OpenRouter, OpenAI, Anthropic"]]
  apps[["Connected apps<br/>Slack, Gmail, GitHub, Supabase,<br/>Alpha Vantage"]]
  author -->|"edits a workflow,<br/>presses Deploy"| kampong
  approver -->|"approves or rejects<br/>a paused run"| kampong
  admin -->|"members, roles, limits,<br/>audit log, usage"| kampong
  sender -->|"POST /hooks/w/…"| kampong
  idp -.->|"SSO sign-in, SCIM<br/>provisioning (planned)"| kampong
  kampong -->|"prompts, using the<br/>workspace's own key"| llm
  kampong -->|"tool calls, using the<br/>workspace's secrets"| apps
```

## Containers

One container image serves the canvas, the API, the public ingress, the run manager and the scheduler. That is
deliberate (ADR-0013): at this scale a separate static tier or worker fleet adds cost with no benefit. The
LiteLLM gateway is optional; without it the server calls providers directly. Which cluster hosts it is decided
in KAM-320.

```mermaid
%% fig: containers
flowchart TB
  browser["<b>Canvas</b><br/>React single-page app<br/>runs in the browser"]
  sender(["Event sender"])
  subgraph cluster ["Kubernetes cluster (host decided in KAM-320)"]
    ingress["<b>Ingress</b><br/>TLS, kampong.abangai.dev"]
    subgraph pod ["kampong-server (one container image, two replicas)"]
      server["<b>Fastify server</b><br/>serves the canvas, the /api routes,<br/>the public webhook ingress,<br/>the run manager and the scheduler"]
    end
    db[("<b>Postgres</b><br/>CloudNativePG, row-level security,<br/>scheduled backups")]
    gateway["<b>LiteLLM gateway</b><br/>optional, via LITELLM_BASE_URL"]
  end
  llm[["Model providers"]]
  apps[["Connected apps"]]
  browser -->|"HTTPS, session cookie"| ingress
  sender -->|"HTTPS, secret or signature"| ingress
  ingress --> server
  server -->|"SQL, one workspace per transaction"| db
  server -.->|"model calls when set"| gateway
  gateway -.-> llm
  server -->|"model calls when not"| llm
  server -->|"tool calls, public addresses only"| apps
```

## Components inside the server

Every database read goes through `withWorkspaceScope`, which pins one workspace per transaction so row-level
security does the isolation. The ingress is the only route with no session; it proves the caller with the
deployment's secret and hands the decision to the engine's own webhook handler. The dashed boxes are the
additions the enterprise epic needs: a limits gate in front of the run manager, an audit writer behind every
mutating route, a roles guard on those routes and a usage meter on every run.

```mermaid
%% fig: components
flowchart LR
  subgraph http ["HTTP surface"]
    auth["Better Auth<br/>sessions, workspaces"]
    specsR["specs routes<br/>/api/specs"]
    runsR["runs routes<br/>/api/runs, approve"]
    depR["deployment routes<br/>deploy, pause, secret"]
    ingress["webhook ingress<br/>/hooks/w/:ws/:dep"]
    secR["byok + secrets routes<br/>/api/byok, /api/secrets"]
    roles["roles guard<br/>admin, editor, viewer, approver"]:::new
    rate["rate and size limits"]:::new
  end
  subgraph core ["Run core"]
    limits["limits gate<br/>concurrency, monthly ceiling, max runtime"]:::new
    manager["HostedRunManager"]
    sched["HostedScheduler<br/>one runner per live schedule"]
    engine["@kampong/engine<br/>handleWebhookRequest, runWorkflow,<br/>runUnattended"]
    resolve["model + secrets resolver"]
    guard["egress guard<br/>public addresses only"]
    meter["usage meter<br/>tokens and cost per run"]:::new
  end
  subgraph data ["Data and custody"]
    scope["withWorkspaceScope<br/>sets app.workspace_id per transaction"]
    audit["audit writer<br/>actor, action, target"]:::new
    crypto["AES-256-GCM envelope<br/>BYOK_ROOT_KEY, KMS option"]
    pg[("Postgres")]
  end
  rate --> ingress
  roles --> depR
  roles --> runsR
  roles --> secR
  depR --> scope
  ingress --> scope
  ingress --> crypto
  ingress --> limits
  limits --> manager
  depR --> sched
  sched --> limits
  runsR --> manager
  manager --> engine
  manager --> resolve
  manager --> meter
  engine --> guard
  resolve --> crypto
  secR --> crypto
  specsR --> scope
  manager --> scope
  depR --> audit
  secR --> audit
  runsR --> audit
  audit --> scope
  meter --> scope
  scope --> pg
  classDef new stroke-dasharray: 5 4,stroke:#a4531a
```

## Infrastructure

A replica set of two behind one ingress, a migrate job that runs before each rollout, and a CloudNativePG
cluster with scheduled backups to an object store. Three secrets are needed at runtime. The planned additions
are a default-deny network policy, pod security settings, a KMS for the root key, and uptime monitoring that
feeds the status page. A restore drill (KAM-329) is what turns "the chart has backups" into "backups work".

```mermaid
%% fig: infrastructure
flowchart TB
  internet(("Internet"))
  subgraph k8s ["Kubernetes cluster"]
    ing["Ingress<br/>TLS terminates here<br/>kampong.abangai.dev"]
    svc["Service kampong-server"]
    subgraph dep ["Deployment kampong-server (Helm chart)"]
      pod["Two pods<br/>image = server + built canvas"]
    end
    job["Migrate Job<br/>Helm hook, runs before rollout"]
    secrets["Kubernetes Secret<br/>DATABASE_URL, BETTER_AUTH_SECRET,<br/>BYOK_ROOT_KEY"]
    netpol["NetworkPolicy + pod security<br/>default deny, non-root"]:::new
    subgraph pgc ["kampong-postgres (CloudNativePG)"]
      pg[("Postgres cluster")]
      backup["ScheduledBackup"]
    end
    llmgw["LiteLLM Deployment<br/>optional, KAM-72 open"]:::new
  end
  store[("Object store<br/>backups")]
  kms["Cloud KMS<br/>root key option"]:::new
  monitor["Uptime monitor<br/>feeds the status page"]:::new
  providers[["Model providers and connected apps"]]
  internet --> ing --> svc --> pod
  job -->|"drizzle migrations"| pg
  secrets -.-> pod
  secrets -.-> job
  pod --> pg
  backup --> store
  pg --- backup
  pod -.-> llmgw
  pod --> providers
  llmgw -.-> providers
  kms -.->|"wraps the root key"| pod
  monitor -.->|"probes /api/health"| ing
  netpol -.-> pod
  classDef new stroke-dasharray: 5 4,stroke:#a4531a
```
