.PHONY: setup test test-core eval eval-no-ollama eval-vision run docker-build docker-run

setup:
	python3 -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"
	cp -n .env.example .env || true

test:
	pytest -v

test-core:
	python3 -m unittest discover -s tests -p "test_core.py" -v

eval:
	python -m scripts.evaluate

eval-no-ollama:
	python -m scripts.evaluate --no-ollama

eval-vision:
	python -m scripts.make_sample_invoices
	python -m scripts.eval_vision

run:
	uvicorn src.api:app --host 0.0.0.0 --port 8000 --reload

docker-build:
	docker build -t ap-reconciliation-agent .

docker-run:
	docker run --rm -p 8000:8000 --env-file .env ap-reconciliation-agent
