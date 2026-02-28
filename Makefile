.PHONY: lint test check

lint:
	python3 lint_architecture.py
	ruff check cli/ || true

test:
	python3 -m pytest tests/ -v

check: lint test
