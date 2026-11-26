# Data and trust

## Data model

Everything hangs off `workspaces`. One deployment per spec, and its id is the unguessable URL segment. The
tables marked new in the diagram come from the enterprise epic. `runs` gains the columns every later feature
reads: how the run started, who deployed it, and what it cost (KAM-324). Billing is a separate set of tables
(KAM-86).

```mermaid
%% fig: er
erDiagram
  workspaces ||--o{ workspace_members : "has seats"
  user ||--o{ workspace_members : "belongs via"
  workspaces ||--o{ specs : owns
  specs ||--o| deployments : "at most one"
  specs ||--o{ runs : produces
  specs ||--o| layouts : positions
  workspaces ||--o{ byok_keys : "provider keys"
  workspaces ||--o{ workspace_secrets : "connector secrets"
  workspaces ||--o{ state_entries : "dedupe and locks"
  workspaces ||--o{ audit_events : "every change"
  workspaces ||--o| workspace_limits : "ceilings"
  workspaces {
    uuid id PK
    text name
  }
  workspace_members {
    uuid workspace_id FK
    text user_id FK
    text role "admin, editor, viewer, approver (new)"
    boolean active "set false by SCIM (new)"
  }
  specs {
    uuid id PK
    uuid workspace_id FK
    text name
    text yaml_source
  }
  deployments {
    uuid id PK "also the URL segment"
    uuid workspace_id FK
    uuid spec_id FK "unique"
    text status "live, paused or paused_limit"
    text webhook_secret_ciphertext "AES-GCM, null if none"
    text deployed_by "new"
  }
  runs {
    uuid id PK
    uuid workspace_id FK
    uuid spec_id FK
    text status
    text source "webhook, schedule or manual (new)"
    text triggered_by "user id or sender label (new)"
    int tokens_in "new"
    int tokens_out "new"
    numeric cost_usd "new"
    jsonb trace_json
    jsonb final_output
    text error
    timestamptz started_at
    timestamptz completed_at
  }
  audit_events {
    uuid id PK
    uuid workspace_id FK
    text actor "user id or scim or system"
    text action "deployment.deploy, member.remove, secret.rotate"
    text target
    jsonb detail
    timestamptz at
  }
  workspace_limits {
    uuid workspace_id PK
    int max_concurrent_runs
    numeric monthly_cost_ceiling_usd
    int max_run_seconds
    int trace_retention_days
  }
  byok_keys {
    uuid id PK
    uuid workspace_id FK
    text provider "unique with workspace"
    text ciphertext
    text last_four
  }
  workspace_secrets {
    uuid id PK
    uuid workspace_id FK
    text name "unique with workspace"
    text ciphertext
    text last_four
  }
  state_entries {
    uuid workspace_id PK
    text key PK
    jsonb value
    bigint expires_at
  }
```

## Lifecycles

The deployment states are the ones the canvas must show. A paused deployment is invisible to callers, so the
dashboard is the only place a person learns that is why events stopped arriving. A deployment that reaches
its monthly ceiling pauses itself with its own state, so the dashboard can say "limit reached" and not just
"paused".

```mermaid
%% fig: deployment-states
stateDiagram-v2
  [*] --> Draft
  Draft: Draft (no deployment)
  Live: Live (accepts webhook traffic, schedule running)
  Paused: Paused (callers get 404, schedule stopped)
  Limited: Paused, limit reached (new)
  Draft --> Live: Deploy (secret issued once)
  Live --> Live: Redeploy (same URL, secret kept)
  Live --> Paused: Pause
  Paused --> Live: Resume or Redeploy
  Live --> Limited: monthly ceiling reached
  Limited --> Live: ceiling raised or month rolls over
  Live --> Draft: Delete
  Paused --> Draft: Delete
  Limited --> Draft: Delete
  Live --> Live: Rotate secret
```

```mermaid
%% fig: run-states
stateDiagram-v2
  [*] --> running
  running --> awaiting_approval: approval step or guardrail
  awaiting_approval --> running: approved
  awaiting_approval --> rejected: rejected
  running --> completed: last step done
  running --> failed: a step fails
  running --> failed: max runtime or breaker reached (new)
  completed --> [*]
  rejected --> [*]
  failed --> [*]
```

## Trust boundaries and where secrets live

Specs hold only `${ENV}` placeholders. Every real secret is ciphertext under one root key held in the cluster,
decrypted in memory for one call or run, and never placed in the server process's own environment where a
tenant's spec could read it (ADR-0056). The enterprise epic adds a KMS behind the root key, a per-workspace
egress allowlist and an identity provider on the sign-in side.

```mermaid
%% fig: trust
flowchart LR
  subgraph outside ["Outside the trust boundary"]
    sender(["Event sender<br/>knows: URL + secret"])
    browser(["Author's browser<br/>holds: session cookie"])
    idp(["Identity provider<br/>holds: the company's users"]):::new
  end
  subgraph server ["kampong-server process"]
    ingress["Ingress<br/>no session, secret checked"]
    api["API routes<br/>session + workspace + role checked"]
    run["Run env, built per run<br/>= workspace secrets only"]
    guard["Egress guard<br/>public addresses, then allowlist"]
  end
  subgraph store ["Postgres (RLS: one workspace per transaction)"]
    spec["spec YAML<br/>${ENV} placeholders only"]
    byok["byok_keys<br/>ciphertext"]
    wsec["workspace_secrets<br/>ciphertext"]
    dsec["deployments<br/>webhook secret ciphertext"]
    aud["audit_events<br/>append only"]:::new
  end
  root["BYOK_ROOT_KEY<br/>Kubernetes Secret, KMS option"]
  sender -->|"bearer or HMAC"| ingress
  browser -->|"cookie"| api
  idp -.->|"OIDC or SAML, SCIM"| api
  ingress --> dsec
  api --> byok
  api --> wsec
  api --> spec
  api --> aud
  root -.->|"decrypts, in memory,<br/>for one call or run"| run
  byok --> run
  wsec --> run
  run --> guard
  guard -->|"keys leave only toward<br/>their own provider or app"| out[["Providers and apps"]]
  classDef new stroke-dasharray: 5 4,stroke:#a4531a
```

### Egress coverage is unverified

The egress guard (ADR-0058) covers HTTP made by tools. The first version of this plan drew model-provider and
connector calls as bypassing it, and the buyer review flagged that as unverified. KAM-337 audits those paths
and either routes them through the guard or records the exception in an ADR. Until then, do not tell a
customer that all outbound traffic is restricted.

## Roles

Four roles, checked on every session route (KAM-64, KAM-328, `packages/server/src/auth/roles.ts`). A route names the
permission it needs and the check lives in one place, so a new route cannot skip it. A refusal is a 403 that names
the permission.

| Permission            | admin | editor | approver | viewer |
| --------------------- | :---: | :----: | :------: | :----: |
| `spec:read`           |  yes  |  yes   |   yes    |  yes   |
| `run:read`            |  yes  |  yes   |   yes    |  yes   |
| `deployment:read`     |  yes  |  yes   |   yes    |  yes   |
| `spec:write`          |  yes  |  yes   |          |        |
| `run:start`           |  yes  |  yes   |          |        |
| `deployment:manage`   |  yes  |  yes   |          |        |
| `approval:resolve`    |  yes  |  yes   |   yes    |        |
| `secret:read` (names) |  yes  |  yes   |          |        |
| `secret:write`        |  yes  |        |          |        |
| `byok:read`, `byok:write` | yes |      |          |        |

Better Auth's own `owner` counts as admin and `member` as editor, so a workspace made before roles existed keeps
working. A member may hold several roles (comma-separated) and gets the union. Editors can approve by default so a
small team is not blocked; a separate-approver rule (four-eyes, KAM-327) comes later. Custom roles are not in scope.

## API

| Route                                         | Who     | Does                                                                   | State        |
| --------------------------------------------- | ------- | ---------------------------------------------------------------------- | ------------ |
| `PUT /api/specs/:id/deployment`               | session | Deploy or redeploy; returns `webhookPath` and, once, `webhookSecret`   | exists       |
| `GET /api/specs/:id/deployment`               | session | Id and status today                                                    | extend (S2)  |
| `PATCH /api/specs/:id/deployment`             | session | Pause or resume                                                        | exists       |
| `DELETE /api/specs/:id/deployment`            | session | Remove the deployment                                                  | exists       |
| `POST /api/specs/:id/deployment/webhook-secret` | session | Rotate the secret (shown once)                                       | exists       |
| `POST /hooks/w/:ws/:dep`                      | secret  | Start a run; gains rate and size limits                                | exists, S7   |
| `POST /api/runs/:id/approve`                  | session | Approve or reject a paused run; needs `approval:resolve`               | exists       |
| `GET /api/specs/:id/runs?limit=`              | session | Recent runs of this spec, newest first                                 | new (S1)     |
| `GET /api/specs/:id/approvals`                | session | Runs of this spec waiting for a person                                 | new (S1)     |
| `GET /api/workspaces/:id/usage`               | session | Runs, tokens and cost by day and by deployment                         | new (S3)     |
| `GET /api/workspaces/:id/audit`               | admin   | Audit events, filterable, JSON for a SIEM (KAM-66)                     | new (S1)     |
| `/scim/v2/Users`, `/scim/v2/Groups`           | bearer  | Provision members from the identity provider (KAM-333)                 | new (pilot)  |

The shapes the dashboard needs, as new types:

```mermaid
%% fig: dtos
classDiagram
  class DeploymentView {
    string deploymentId
    string status  "live | paused | paused_limit"
    string webhookPath
    string webhookUrl  "PUBLIC_BASE_URL + path"
    string triggerKind  "webhook | schedule"
    boolean secretConfigured
    string nextRunAt  "schedule only"
  }
  class RunListItem {
    string id
    string status
    string source  "webhook | schedule | manual"
    string startedAt
    string completedAt
    string outcome  "one sentence"
    number costUsd
  }
  class PendingApproval {
    string runId
    string step
    string reason
    string startedAt
  }
  class UsageSummary {
    string day
    string deploymentId
    number runs
    number tokens
    number costUsd
    number monthlyCeilingUsd
  }
  class AuditEvent {
    string id
    string actor
    string action
    string target
    string at
  }
  DeploymentView "1" --> "0..*" RunListItem : recent runs
  DeploymentView "1" --> "0..*" PendingApproval : waiting on a person
  DeploymentView "1" --> "0..*" UsageSummary : usage
```
