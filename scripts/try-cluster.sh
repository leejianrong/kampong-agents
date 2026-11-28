#!/usr/bin/env bash
# Brings the hosted Kampong stack up on a local Kubernetes cluster (minikube, k3s or kind) and runs the smoke flow
# against it (KAM-343, KAM-340). It builds the server image, loads it into the cluster, starts a throwaway Postgres,
# creates the secrets, installs deploy/helm/kampong-server and port-forwards it. See docs/hosted/self-host.md.
#
#   scripts/try-cluster.sh            # builds, installs, smoke-tests, then keeps the port-forward open
#   CLUSTER=k3s SMOKE=0 scripts/try-cluster.sh
#
# Settings (environment): CLUSTER=auto|minikube|k3s|kind  IMAGE  RELEASE  PORT  BUILD=1|0  SMOKE=1|0  KEEP=1|0
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-kampong-server:local}"
RELEASE="${RELEASE:-kampong}"
PORT="${PORT:-8080}"
BUILD="${BUILD:-1}"
SMOKE="${SMOKE:-1}"
CLUSTER="${CLUSTER:-auto}"
# Keep the port-forward open afterwards when run by a person, not in CI.
KEEP="${KEEP:-$([ -t 1 ] && echo 1 || echo 0)}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "try-cluster: '$1' is not installed. $2" >&2; exit 1; }; }
need kubectl "Install it: https://kubernetes.io/docs/tasks/tools/"
need helm "Install it: https://helm.sh/docs/intro/install/"
need docker "It builds the server image."
need node "Node 22 runs the smoke flow."

ctx="$(kubectl config current-context)"
if [ "$CLUSTER" = auto ]; then
  case "$ctx" in
    minikube*) CLUSTER=minikube ;;
    kind-*) CLUSTER=kind ;;
    *) CLUSTER=k3s ;;
  esac
fi
echo "try-cluster: cluster '$ctx' treated as $CLUSTER"

if [ "$BUILD" = 1 ]; then
  echo "try-cluster: building $IMAGE (a few minutes the first time)"
  docker build -f packages/server/Dockerfile -t "$IMAGE" .
fi

echo "try-cluster: loading $IMAGE into the cluster"
case "$CLUSTER" in
  minikube) need minikube "Install it: https://minikube.sigs.k8s.io/docs/start/"; minikube image load "$IMAGE" ;;
  kind) need kind "Install it: https://kind.sigs.k8s.io/"; kind load docker-image "$IMAGE" --name "${ctx#kind-}" ;;
  k3s)
    # k3s has its own containerd; import the image there. On a k3s server the command needs root.
    need k3s "This script imports the image with 'k3s ctr'. Run it on the k3s host, or import the image yourself."
    docker save "$IMAGE" | sudo k3s ctr images import -
    ;;
  *) echo "try-cluster: unknown CLUSTER '$CLUSTER'" >&2; exit 1 ;;
esac

echo "try-cluster: starting a throwaway Postgres"
kubectl apply -f deploy/local/postgres.yaml
kubectl rollout status deployment/smoke-postgres --timeout=180s
# The init script runs once, at first start; wait for the role it creates.
for _ in $(seq 1 30); do
  kubectl exec deploy/smoke-postgres -- psql -U postgres -tAc "select 1 from pg_roles where rolname='app'" | grep -q 1 && break
  sleep 2
done

# Secrets are made once and kept, so running the script again does not change the key that encrypts stored keys.
kubectl get secret kampong-postgres-app >/dev/null 2>&1 ||
  kubectl create secret generic kampong-postgres-app --from-literal=uri=postgres://app:app@smoke-postgres:5432/kampong
kubectl get secret kampong-server-secrets >/dev/null 2>&1 ||
  kubectl create secret generic kampong-server-secrets \
    --from-literal=auth-secret="$(openssl rand -base64 32)" \
    --from-literal=byok-root-key="$(openssl rand -base64 32)"

IMAGE_REPO="${IMAGE%:*}"
IMAGE_TAG="${IMAGE##*:}"
echo "try-cluster: installing the chart"
helm upgrade --install "$RELEASE" deploy/helm/kampong-server \
  --set image.repository="$IMAGE_REPO" --set image.tag="$IMAGE_TAG" --set image.pullPolicy=Never \
  --set ingress.enabled=false \
  --set runLimits.maxConcurrent=40 \
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
  --set "extraEnv[3].value=http://127.0.0.1:${PORT}" \
  --wait --timeout 300s

SVC="$(kubectl get svc -l "app.kubernetes.io/instance=${RELEASE}" -o name | head -n1)"
kubectl port-forward "$SVC" "${PORT}:80" >/dev/null &
FORWARD=$!
trap 'kill $FORWARD 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null && break; sleep 1; done
curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null || { echo "try-cluster: the server did not answer on :${PORT}" >&2; exit 1; }
echo "try-cluster: Kampong is up at http://127.0.0.1:${PORT}"

if [ "$SMOKE" = 1 ]; then
  BASE_URL="http://127.0.0.1:${PORT}" node e2e/hosted-smoke/smoke.mjs
fi

if [ "$KEEP" = 1 ]; then
  echo "try-cluster: open http://127.0.0.1:${PORT} and sign up. Ctrl-C closes the port-forward; the stack stays installed."
  wait "$FORWARD"
fi
