"""Local Ollama health and installed models (loopback only, read-only)."""

from __future__ import annotations

import httpx

from app.schemas import OllamaInfo, OllamaModel


async def ollama_info(base_url: str, default_model: str, *, timeout: float = 3.0) -> OllamaInfo:
    info = OllamaInfo(available=False, base_url=base_url, default_model=default_model)
    try:
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            r = await client.get(f"{base_url}/api/tags")
            r.raise_for_status()
            data = r.json()
    except httpx.ConnectError:
        info.reason = (
            f"Ollama is not reachable at {base_url}. Start the Ollama app or run `ollama serve`."
        )
        return info
    except (httpx.HTTPError, ValueError) as exc:
        info.reason = f"Ollama did not answer correctly ({type(exc).__name__})."
        return info
    models = []
    for m in data.get("models", []) if isinstance(data, dict) else []:
        if not isinstance(m, dict) or not isinstance(m.get("name"), str):
            continue
        details = m.get("details") if isinstance(m.get("details"), dict) else {}
        models.append(
            OllamaModel(
                name=m["name"],
                size_bytes=m.get("size") if isinstance(m.get("size"), int) else None,
                parameter_size=details.get("parameter_size"),
                quantization=details.get("quantization_level"),
            )
        )
    info.available = True
    info.models = sorted(models, key=lambda x: x.name)
    info.default_model_installed = any(_same_model(m.name, default_model) for m in models)
    return info


def _same_model(a: str, b: str) -> bool:
    def norm(s: str) -> str:
        return s if ":" in s else f"{s}:latest"

    return norm(a) == norm(b)


def model_installed(info: OllamaInfo, model: str) -> bool:
    return any(_same_model(m.name, model) for m in info.models)
