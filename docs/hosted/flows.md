# Flows

## Deploy

Pressing Deploy refuses what hosted cannot run, checks the caller's role, issues the secret once, registers a
schedule and writes an audit event. Deploy is idempotent: a second press reactivates the same row and keeps the
same URL and secret. The secret appears in exactly one response, so the panel shows it with a Copy button and
says that it cannot be shown again.

```mermaid
%% fig: deploy
sequenceDiagram
  autonumber
  actor A as Author
  participant C as Canvas (Deploy panel)
  participant S as Server (deployment route)
  participant D as Postgres
  A->>C: Press Deploy
  C->>S: PUT /api/specs/:id/deployment (session cookie)
  S->>S: authorize workspace, check role (editor or admin)
  alt role too low
    S-->>C: 403
  else allowed
    S->>S: parse the stored spec
    alt trigger not supported on hosted (poll, sync reply)
      S-->>C: 422 with the reason
      C-->>A: Show what to change
    else supported
      S->>D: upsert deployment, status live, deployed_by (RLS scoped)
      opt trigger has auth or a preset and no secret yet
        S->>S: generate whsec_… and encrypt under the root key
        S->>D: store ciphertext on the deployment
      end
      S->>D: write audit event deployment.deploy
      S->>S: register the schedule if the trigger is a schedule
      S-->>C: 200 deploymentId, status, webhookPath, webhookSecret (this once)
      C-->>A: Show URL = PUBLIC_BASE_URL + webhookPath, secret with Copy
    end
  end
```

## A webhook starts a run

A paused, missing or wrong-workspace deployment all answer the same 404, so a caller cannot tell them apart.
The reply is a run id, not the result: the run goes on in the server. The rate limit sits in front of
everything so a flood is turned away before it touches the database; the limits gate sits just before the run
starts so a spent workspace refuses new work with a stated reason.

```mermaid
%% fig: webhook
sequenceDiagram
  autonumber
  participant X as Event sender
  participant I as Ingress route
  participant D as Postgres
  participant E as Engine (handleWebhookRequest)
  participant G as Limits gate
  participant M as HostedRunManager
  participant L as Model and tools
  X->>I: POST /hooks/w/:ws/:dep (raw body, auth header)
  I->>I: rate limit and body-size check
  alt over the limit
    I-->>X: 429 or 413
  else within limits
    I->>D: read deployment + spec in workspace scope
    alt missing, wrong workspace or paused
      I-->>X: 404 Unknown or inactive webhook
    else live
      I->>I: decrypt the deployment secret into a private env
      I->>E: authenticate, then when, then map
      alt bad or missing secret
        E-->>X: 401
      else when is false
        E-->>X: 200 ignored with the reason
      else accepted
        I->>G: concurrency, monthly ceiling
        alt ceiling reached
          G-->>X: 429 paused, limit reached
        else room
          G->>M: start(workspace, spec, input, source=webhook)
          M->>D: insert run, status running
          I-->>X: 201 id and state
          M->>L: model call with the workspace key, tools with its secrets
          L-->>M: results, or a pause for approval
          M->>D: persist trace, status, output, tokens and cost
        end
      end
    end
  end
```

## A run waits for a person

The run is already persisted as `awaiting_approval`; the dashboard only needs a read endpoint that lists those
rows. The decision uses the approve route that exists today, now behind a role check. A workspace can turn on
the four-eyes setting so that the person who deployed the workflow cannot approve its runs.

```mermaid
%% fig: approval
sequenceDiagram
  autonumber
  participant M as HostedRunManager
  participant D as Postgres
  participant P as Dashboard (new)
  actor U as Approver
  M->>D: run reaches an approval step, status awaiting_approval
  P->>D: GET pending approvals for this spec (new endpoint)
  D-->>P: runs waiting, with the step and the reason
  P-->>U: Show Approve and Reject
  U->>P: Approve
  P->>M: POST /api/runs/:id/approve
  M->>M: check the approver role, and with four-eyes on, that the approver is not the deployer
  M->>D: record the decision and the actor, write audit event run.approve
  M->>M: resume the run
  M->>D: persist the final trace, status completed
  P-->>U: Run moves to the recent list
```

## Sign-in and provisioning (planned)

OIDC first, then SAML, then SCIM. A person from the customer's identity provider signs in through single
sign-on; SCIM creates, updates and deactivates members from the same provider. Removing someone there ends
their sessions in Kampong, which is the part security reviewers test first.

```mermaid
%% fig: identity
sequenceDiagram
  autonumber
  actor IT as IT admin
  participant IdP as Identity provider
  participant K as Kampong (Better Auth + SCIM)
  participant D as Postgres
  actor U as New hire
  IT->>K: configure SSO for the workspace (issuer, client, domain)
  IT->>IdP: assign the Kampong app to a group
  IdP->>K: SCIM POST /scim/v2/Users (bearer token per workspace)
  K->>D: create member with the mapped role, write audit event member.add
  U->>K: open kampong.abangai.dev, enter work email
  K-->>U: redirect to the identity provider
  U->>IdP: sign in with company credentials
  IdP-->>K: OIDC or SAML assertion
  K->>D: match the member, start the session
  K-->>U: signed in to the workspace
  IT->>IdP: person leaves, remove from the group
  IdP->>K: SCIM PATCH active=false
  K->>D: deactivate the member, revoke all sessions, write audit event member.remove
```

## Limits and runaway protection

Three separate limits protect the customer's model budget and the shared server. They answer different
questions, so they are separate cards: the ingress limit protects the server from floods, the workspace
ceiling protects the customer's bill, and the per-run limits stop one run from running away.

```mermaid
%% fig: limits
flowchart TD
  req(["Run request<br/>webhook, schedule or manual"]) --> rate{"within the ingress<br/>rate and size limit?<br/>(KAM-322)"}
  rate -->|"no"| r429["429 or 413<br/>no run, no cost"]
  rate -->|"yes"| conc{"under the workspace<br/>concurrency cap?<br/>(KAM-323)"}
  conc -->|"no"| queue["refuse with a reason<br/>or queue behind the cap"]
  conc -->|"yes"| month{"under the monthly<br/>run or spend ceiling?<br/>(KAM-323)"}
  month -->|"no"| paused["deployment shows<br/>paused: limit reached<br/>and the admin is told"]
  month -->|"yes"| run["start the run"]
  run --> perrun{"under the per-run<br/>token and cost breaker<br/>(KAM-67) and max runtime?"}
  perrun -->|"no"| halt["halt the run,<br/>record why"]
  perrun -->|"yes"| done["finish, record tokens<br/>and cost (KAM-324)"]
  done --> usage["usage panel<br/>shows use against the ceiling<br/>(KAM-325)"]
```

## Scheduler

A scheduled deployment is a runner per live row, with its overlap lock in the workspace's Postgres state
store so two replicas never fire one tick twice. That claim is asserted by the design and has not been shown
running on two replicas; KAM-320 and KAM-340 are where it gets proved. Changing a cadence needs a redeploy.
A scheduled tick goes through the same limits gate as a webhook.

```mermaid
%% fig: scheduler
flowchart TD
  start([Server starts or a deployment goes live]) --> list["list_live_deployments()<br/>SQL function, ids only"]
  list --> reg["register one runner per live schedule<br/>(runUnattended)"]
  reg --> wait["wait for the next tick<br/>(cron or every, with jitter)"]
  wait --> lock{"overlap lock free?<br/>(Postgres state store)"}
  lock -->|"yes"| gate{"limits gate open?"}
  lock -->|"no, skip"| wait
  lock -->|"no, queue"| queue["run once right after"]
  queue --> gate
  gate -->|"no"| wait
  gate -->|"yes"| fire["HostedRunManager.start<br/>reads the spec's current text"]
  fire --> ok{"run failed?"}
  ok -->|"no"| wait
  ok -->|"yes"| fails{"too many failures<br/>in a row?"}
  fails -->|"no"| backoff["back off"] --> wait
  fails -->|"yes"| stop([stop, visibly])
  pause([Pause or delete]) --> unreg["unregister the runner"]
```

## The author's journey

The panel is the Go live block from the local app (command, address, header, curl) grown into a dashboard:
the same words for the same things, with the secret and the run list added.

```mermaid
%% fig: journey-author
journey
  title Author takes a workflow live
  section Prepare
    Check setup says it is ready: 4: Author
    Add the model key and connector secrets: 3: Author
  section Deploy
    Press Deploy: 5: Author
    Copy the URL and the secret: 4: Author
    Paste both into the sender: 3: Author
  section Watch
    First request arrives: 5: Author
    Recent runs show the outcome: 4: Author
    Approve a paused run: 4: Approver
  section Operate
    Pause during an incident: 4: Author
    Rotate a leaked secret: 3: Author
```

## The IT lead's evaluation

The second journey is the buyer's. Each low score is a gap on the [readiness page](enterprise-readiness.md);
the plan is to turn them all into fours and fives before a pilot.

```mermaid
%% fig: journey-buyer
journey
  title IT lead evaluates Kampong for a company
  section Trust
    Reads the security and data-handling summary: 2: IT lead
    Asks for the DPA and subprocessor list: 2: IT lead
    Checks SOC 2 status and the status page: 1: IT lead
  section Identity
    Connects the identity provider: 1: IT lead
    Provisions a group of 50 people: 1: IT lead
    Sets roles for authors and approvers: 2: IT lead
  section Control
    Sets a monthly spend ceiling: 1: IT lead
    Restricts which hosts workflows may call: 2: IT lead
    Reads the audit log after a deploy: 1: IT lead
  section Run
    Watches usage and cost per workflow: 1: IT lead
    Sees a run wait for an approver: 4: IT lead
```
