# Availability and status

**The hosted service is a preview. It has no uptime guarantee and no SLA.** It runs on one homelab site (ADR-0066).
This page says what we aim for, how it is measured, what we do when it is down, and what we do not promise, so
nobody has to guess. It will say "preview" until a step in [When this changes](#when-this-changes) is taken.

## What we aim for

An aim, not a promise: the service answers on at least **99% of minutes in a calendar month**, about seven hours of
downtime in a 30-day month, measured as below. A month that misses it is reported on this page, with the cause.

## How it is measured

- A probe **outside the homelab** requests `https://<host>/readyz` once a minute. It must come from somewhere that
  does not share the homelab's power or link, or an outage there would take the monitor down with it and be missed.
- A minute is **up** when the answer is HTTP 200 and `"status":"ok"`. `/readyz` asks the database one question with a
  two-second deadline, so a server that is running but cannot reach its database counts as **down**. (`/healthz` does
  not ask the database and must not be used to measure availability.)
- Two failed probes in a row open an incident. Planned maintenance is announced ahead on the status page and is
  counted as down in the figure: we do not hide it.

## What happens when it is down

1. The owner is alerted by the monitor (two failed probes in a row, by email and by a push notification).
2. An incident is posted on the status page within 30 minutes of the alert, in working hours, and updated as it
   changes. It says what is affected, in plain words, and when we will next update it.
3. When it is back, the incident is closed and a short note is added to the [incident history](incidents.md) within
   five working days: what happened, how long, why, and what changes so it is less likely.

Data is protected by the [backup and restore runbook](restore-runbook.md), which is rehearsed. An outage is not a data
loss; a lost site is, unless the backup bucket is somewhere else.

## What we do not promise

- No uptime figure, response time or credit. The 99% above is an aim.
- No failover to another site. There is one site and one replica; a restart or a power cut is a short outage.
- No support hours beyond best effort.

## When this changes

The label changes only when each of these is true, and the change is written in the incident history with a date:
a customer needs an SLA and the service has been measured above its target for three months running; the service has
moved off the single homelab site or has a tested second one (ADR-0066 lists the triggers); and the monitor and the
status page below are live. A contractual SLA is a separate, later piece of work and is not part of this page.

## For the operator: set up the monitor and the status page

These need accounts and DNS that only the owner has, so they are **not done by the code in this repository**. What is
built is the probe target (`/readyz`) and the rules above. To go live:

1. Choose an uptime service that can run an HTTPS check every minute from outside your network, match a keyword in the
   response, alert two failures in a row to email and a phone, and publish a public status page with incident posts and
   an uptime figure. (Run it yourself only if it runs somewhere other than the homelab.)
2. Add one monitor: `GET https://kampong.abangai.dev/readyz`, every minute, expecting status 200 and the text
   `"status":"ok"`.
3. Route its alerts to the owner by two channels, and test them once by stopping the server pod on purpose.
4. Publish the status page on its own host (for example `status.abangai.dev`), show the monitor and the preview
   label, and link it from `previewNotice` text and from this page.
5. Record the date it went live in the [incident history](incidents.md) and tick KAM-330's two boxes.

Until step 5, the service is **not monitored** by anything but the owner noticing, and this page says so.
