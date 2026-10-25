# Sourced by try-hosted.sh and e2e-browser.sh. start_pg starts a throwaway Postgres owned by a non-superuser role
# (a superuser bypasses FORCE RLS, KAN-1388), exports DATABASE_URL, and registers a cleanup via PG_CONTAINER.
# Returns non-zero with a one-line reason if Docker is unavailable or the image can't be pulled.

PG_CONTAINER=""

stop_pg() {
  if [ -n "$PG_CONTAINER" ]; then
    docker stop "$PG_CONTAINER" >/dev/null 2>&1 || true
    PG_CONTAINER=""
  fi
}

start_pg() {
  command -v docker >/dev/null 2>&1 || { echo "hosted: docker is not installed" >&2; return 1; }
  docker info >/dev/null 2>&1 || { echo "hosted: the Docker daemon is not reachable" >&2; return 1; }
  local port name out
  port="$(node "$(dirname "${BASH_SOURCE[0]}")/pick-port.mjs" 15434)"
  name="kampong-pg-$$"
  if ! out="$(docker run --rm -d --name "$name" -p "127.0.0.1:$port:5432" -e POSTGRES_PASSWORD=postgres postgres:18 2>&1)"; then
    echo "hosted: could not start postgres:18 ($(printf '%s' "$out" | tail -1))" >&2
    return 1
  fi
  PG_CONTAINER="$name"
  local i
  for i in $(seq 1 60); do
    docker exec "$name" pg_isready -U postgres >/dev/null 2>&1 && break
    sleep 1
  done
  # pg_isready can pass during the image's init restart, so retry the setup SQL until it takes.
  for i in $(seq 1 30); do
    if docker exec "$name" psql -U postgres -v ON_ERROR_STOP=1 \
      -c "CREATE ROLE app_test LOGIN PASSWORD 'app_test' NOSUPERUSER NOBYPASSRLS;" \
      -c "CREATE DATABASE kampong_e2e OWNER app_test;" >/dev/null 2>&1; then
      export DATABASE_URL="postgres://app_test:app_test@127.0.0.1:$port/kampong_e2e"
      return 0
    fi
    sleep 1
  done
  echo "hosted: postgres started but the test role/database could not be created" >&2
  stop_pg
  return 1
}
