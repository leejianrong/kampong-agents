# One command to bring the whole stack up (dev-playbook principle 17) plus
# thin passthroughs to the same npm scripts AGENTS.md documents, so there's
# a single entry point for both the Docker stack and this repo's own
# lint/build/test gate.

COMPOSE := docker compose

.PHONY: help up down restart logs build shell ps clean \
        install check test test-unit test-integration test-e2e lint fmt typecheck

help:
	@echo "Docker stack (see README.md#run-with-docker):"
	@echo "  make up             Build (if needed) and start the app"
	@echo "  make down           Stop the stack"
	@echo "  make restart        Restart the stack"
	@echo "  make logs           Follow the app container's logs"
	@echo "  make build          Rebuild the app image after a source change"
	@echo "  make shell          Open a shell inside the app container"
	@echo "  make ps             Show container status"
	@echo "  make clean          Stop the stack, remove its containers/volumes"
	@echo ""
	@echo "Local (no Docker) — same gate as .husky/pre-push and CI's fast jobs:"
	@echo "  make install        npm install (all workspaces)"
	@echo "  make check          Full local gate: build, lint, format, typecheck, unit+integration tests"
	@echo "  make test           Unit + integration tests"
	@echo "  make test-e2e       E2E tests (slow — installs/runs generated projects)"
	@echo "  make lint           eslint"
	@echo "  make fmt            prettier --check"
	@echo "  make typecheck      tsc --noEmit per package"

# --- Docker stack -----------------------------------------------------

.env:
	cp .env.example .env
	@echo "Created .env from .env.example -- edit HOST_PORT there if 4310 is taken, or fill in BYOK keys."

workspace/agent.yaml:
	mkdir -p workspace
	cp examples/agent.yaml workspace/agent.yaml
	@echo "Seeded workspace/agent.yaml from examples/agent.yaml."

up: .env workspace/agent.yaml
	$(COMPOSE) up -d --build
	@port=$$(grep -E '^HOST_PORT=' .env | cut -d= -f2); \
	echo ""; \
	echo "Canvas: http://localhost:$${port:-4310}"

down:
	$(COMPOSE) down

restart: down up

logs:
	$(COMPOSE) logs -f

build:
	$(COMPOSE) build

shell:
	$(COMPOSE) exec app sh

ps:
	$(COMPOSE) ps

clean:
	$(COMPOSE) down -v --remove-orphans

# --- Local (no Docker) gate --------------------------------------------

install:
	npm install

check: install
	npm run build
	npm run lint
	npm run format:check
	npm run typecheck
	npm run test:unit
	npm run test:integration

test: test-unit test-integration

test-unit:
	npm run test:unit

test-integration:
	npm run test:integration

test-e2e:
	npm run test:e2e

lint:
	npm run lint

fmt:
	npm run format:check

typecheck:
	npm run typecheck
