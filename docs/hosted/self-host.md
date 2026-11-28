# Run Kampong yourself on minikube or k3s

This page takes you from nothing to the hosted Kampong stack running on a Kubernetes cluster on your own machine or
server, with a first account signed up and a smoke test passed. Use it to try the hosted product, to check the
chart before you run it for real, or as the start of a self-hosted install.

**What this is not.**

The Postgres here is a throwaway pod: no backups, no failover, and its data goes when the pod does. There is no
TLS and one replica. For anything you cannot lose, use the CloudNativePG chart in `deploy/helm/kampong-postgres`
(backups to object storage) and the notes under [Going further](#going-further).

**What has been run.**

The script (`scripts/try-cluster.sh`) runs in CI on a **kind** cluster whenever the server, the chart or the script
changes, and the hand steps are the same commands. Nobody has run it on minikube or k3s yet; the only differences
are how the image gets into the cluster (step 3) and the cluster's own install. If a step does not work on your cluster, that is a bug in this page, so please say so.

## What you need

| Tool             | Why                                          |
| ---------------- | -------------------------------------------- |
| Docker           | builds the server image                      |
| `kubectl`, `helm` | install and inspect the stack                |
| Node 22          | runs the smoke test (`e2e/hosted-smoke`)     |
| minikube **or** k3s | the cluster. 4 GB of free memory is plenty |

A checkout of this repository, with `kubectl` pointing at your cluster (`kubectl get nodes` works).

## The short way

```bash
minikube start            # or: your k3s server is already running
make try-cluster
```

The script reads your current `kubectl` context to tell minikube, kind and k3s apart (set `CLUSTER=minikube`,
`k3s` or `kind` to override). It builds the image, loads it into the cluster, starts Postgres, creates the secrets,
installs the chart, port-forwards it to `http://127.0.0.1:8080`, runs the smoke test, and then leaves the
port-forward open. You should end on:

```text
ok  the isolation check fails against a leaking server
ok  /healthz
ok  two tenants signed up and deployed
ok  deploy, webhook, approve, finish
ok  twenty runs in flight keep their own tenant's result
ok  tenant B sees nothing of tenant A
smoke passed
try-cluster: open http://127.0.0.1:8080 and sign up.
```

Open the address, sign up, and go to [First login](#first-login). Read on to see what the script did.

## The steps by hand

1. **Build the image** from the repository root:

    ```bash
    docker build -f packages/server/Dockerfile -t kampong-server:local .
    ```

2. **Start Postgres.** The role it creates is not a superuser, which matters: a superuser bypasses row-level
   security and the tenant isolation would not be real.

    ```bash
    kubectl apply -f deploy/local/postgres.yaml
    kubectl rollout status deployment/smoke-postgres
    ```

3. **Put the image where the cluster can see it.** The chart is told never to pull, because the image is local.

    - **minikube:** `minikube image load kampong-server:local`
    - **k3s** has its own container runtime. On the k3s host:
      `docker save kampong-server:local | sudo k3s ctr images import -`
    - **kind:** `kind load docker-image kampong-server:local`

4. **Create the secrets.** `BYOK_ROOT_KEY` encrypts every stored model key and connector secret. Lose it and those
   cannot be read again, so keep a copy somewhere other than the cluster.

    ```bash
    kubectl create secret generic kampong-postgres-app \
      --from-literal=uri=postgres://app:app@smoke-postgres:5432/kampong
    kubectl create secret generic kampong-server-secrets \
      --from-literal=auth-secret="$(openssl rand -base64 32)" \
      --from-literal=byok-root-key="$(openssl rand -base64 32)"
    ```

5. **Install the chart.** A migration job runs first and creates the tables.

    ```bash
    helm upgrade --install kampong deploy/helm/kampong-server \
      --set image.repository=kampong-server --set image.tag=local --set image.pullPolicy=Never \
      --set ingress.enabled=false \
      --set 'extraEnv[0].name=DATABASE_URL' \
      --set 'extraEnv[0].valueFrom.secretKeyRef.name=kampong-postgres-app' \
      --set 'extraEnv[0].valueFrom.secretKeyRef.key=uri' \
      --set 'extraEnv[1].name=BETTER_AUTH_SECRET' \
      --set 'extraEnv[1].valueFrom.secretKeyRef.name=kampong-server-secrets' \
      --set 'extraEnv[1].valueFrom.secretKeyRef.key=auth-secret' \
      --set 'extraEnv[2].name=BYOK_ROOT_KEY' \
      --set 'extraEnv[2].valueFrom.secretKeyRef.name=kampong-server-secrets' \
      --set 'extraEnv[2].valueFrom.secretKeyRef.key=byok-root-key' \
      --set 'extraEnv[3].name=BETTER_AUTH_URL' \
      --set 'extraEnv[3].value=http://127.0.0.1:8080' \
      --wait --timeout 300s
    ```

6. **Open it.** Find the service and forward a port:

    ```bash
    kubectl port-forward "$(kubectl get svc -l app.kubernetes.io/instance=kampong -o name)" 8080:80
    ```

    Then `curl http://127.0.0.1:8080/healthz` answers `{"status":"ok",...}`.

7. **Check it** with the smoke test: `BASE_URL=http://127.0.0.1:8080 node e2e/hosted-smoke/smoke.mjs`.

## First login

1. Open `http://127.0.0.1:8080`, choose **Sign up** and make an account.
2. Name a workspace. You are its admin.
3. Add a model key in the model keys screen: your own key for the provider your workflow uses (OpenRouter, OpenAI,
   Anthropic), or no key at all for a local Ollama.
4. Create a workflow, or import a YAML spec, and press **Run**. Use **Deploy** to give it a web address and **Usage**
   to see what it ran.

The hosted app has no template gallery yet, so import one of `packages/cli/templates/*/agent.yaml`.

## Upgrade

Build a new image under a new tag, load it as in step 3, and upgrade with the same command and the new
`image.tag`. The migration job runs before the new pod starts. Keep `kampong-server-secrets` as it is.

```bash
helm upgrade kampong deploy/helm/kampong-server --reuse-values --set image.tag=local2
```

## Settings worth knowing

Set any of these with `--set` or a values file. All are described in `deploy/helm/kampong-server/values.yaml`.

| Value            | Does                                                                 |
| ---------------- | -------------------------------------------------------------------- |
| `previewNotice`  | A sentence pinned to the top of every screen.                        |
| `runLimits`      | Runs at once, runs a month, minutes a run, per workspace.            |
| `modelPricing`   | Dollars per million tokens by model, so Usage can estimate cost.     |
| `ingressLimits`  | Rate and size limits on the public webhook address.                  |
| `publicBaseUrl`  | The origin webhook addresses are built from.                         |

## Going further

- **A real hostname.** Enable the ingress (`ingress.enabled=true`, `ingress.host=...`; k3s ships Traefik, minikube
  needs `minikube addons enable ingress` and a matching `ingress.className`), set `BETTER_AUTH_URL` to the public
  origin, and put TLS in front.
- **A database you can keep.** Install CloudNativePG and the `kampong-postgres` chart, and point
  `kampong-postgres-app` at its connection secret. See that chart's README, and run the restore drill before you
  depend on it.
- **One replica.** Run one until two replicas have been shown to fire a schedule once. Rate limits and a run's live
  stream are per replica.

## Remove it

```bash
helm uninstall kampong
kubectl delete -f deploy/local/postgres.yaml
kubectl delete secret kampong-postgres-app kampong-server-secrets
```

## If something fails

| You see                                | It means, and what to do                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `ImagePullBackOff` / `ErrImageNeverPull` | The image is not inside the cluster. Repeat step 3 for your cluster type.                |
| `CrashLoopBackOff`                     | `kubectl logs deploy/kampong-kampong-server`. A missing secret key or a bad `DATABASE_URL` shows there. |
| Install waits, then times out          | `kubectl get pods`, then `kubectl logs job/kampong-kampong-server-migrate` for the migration job. |
| Sign-up works, creating a workspace is refused | `BETTER_AUTH_URL` must equal the address in your browser, including the port.       |
| `try-cluster: 'k3s' is not installed`  | Run the script on the k3s host, or import the image yourself and use `BUILD=0`.            |
