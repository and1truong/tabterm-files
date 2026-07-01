BUN     ?= bun
# Path to a tabterm checkout, used by `make vendor` to refresh the vendored
# @tabterm/module-host contract. Override: make vendor TABTERM=~/code/tabterm
TABTERM ?= ../tabterm

.DEFAULT_GOAL := help

.PHONY: help install typecheck test check build vendor clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

install: ## Install deps (highlight.js/lucide-react/marked + vendored module-host)
	$(BUN) install

typecheck: ## Type-check the module against the host contract
	$(BUN) run typecheck

test: ## Run the files client + server tests
	$(BUN) test

check: typecheck test ## Type-check then test (the full local gate)

build: ## Build self-contained dist/modules/files/{client.js,server.js}
	$(BUN) scripts/build-modules.ts

vendor: ## Refresh vendor/module-host from a tabterm checkout (TABTERM=path)
	@test -d "$(TABTERM)/packages/module-host" \
		|| { echo "no module-host at $(TABTERM)/packages/module-host — set TABTERM=path"; exit 1; }
	rsync -a --delete --exclude node_modules --exclude dist \
		"$(TABTERM)/packages/module-host/src/" vendor/module-host/src/
	@echo "vendored module-host/src refreshed from $(TABTERM); bump vendor/module-host/package.json version if the contract changed"

clean: ## Remove install + build artifacts
	rm -rf node_modules dist
