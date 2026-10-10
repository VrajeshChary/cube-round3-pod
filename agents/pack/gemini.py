import os
import json
import time
import random
from pathlib import Path

import httpx
from dotenv import load_dotenv
from google import genai
from google.genai import types, errors
from PIL import Image


# --------------------------------------------------
# Environment
# --------------------------------------------------

BASE_DIR = Path(__file__).resolve().parents[2]
ENV_FILE = BASE_DIR / ".env"

load_dotenv(ENV_FILE)

api_key = os.getenv("GEMINI_API_KEY")


# --------------------------------------------------
# Gemini Client
# --------------------------------------------------
# A missing key must not stop the app from starting: fail-open means
# the inspection is still saved, just marked PENDING_REVIEW.

client = None

if api_key:
    client = genai.Client(
        api_key=api_key,
        http_options=types.HttpOptions(
            timeout=int(float(os.getenv("GEMINI_REQUEST_TIMEOUT_SECONDS", "40")) * 1000)
        )
    )


def is_configured():
    """True when a Gemini API key is present."""
    if os.getenv("GEMINI_OFFLINE") == "1":
        return False
    return client is not None


class GeminiUnavailableError(Exception):
    """Raised when every model/retry has failed or no key is configured.
    app.py catches it and saves a PENDING_REVIEW record."""
    pass


# --------------------------------------------------
# Models
# --------------------------------------------------
# MODEL_NAME is tried first, then each fallback in order.
# Change MODEL_NAME back to "gemini-3.8-flash" whenever
# it is stable again.

MODEL_NAME = os.getenv("GEMINI_MODEL", "gemini-3.8-flash")

FALLBACK_MODELS = [
    "gemini-3.7-flash",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
]


# Total time budget for one inspection across every retry and fallback.
# A warehouse line must never wait minutes for the model (fail-open rule).
TOTAL_BUDGET_SECONDS = float(os.getenv("GEMINI_BUDGET_SECONDS", "120"))


def list_available_models():
    """Helper: print models your API key can use for generateContent."""
    if client is None:
        raise GeminiUnavailableError("GEMINI_API_KEY is not set.")
    for m in client.models.list():
        if "generateContent" in (m.supported_actions or []):
            print(m.name)


# Price per 1 million tokens. Source: Google AI Pricing page (https://ai.google.dev/pricing), 2026-10-10
GEMINI_COST_PER_1M_PROMPT = 0.075
GEMINI_COST_PER_1M_OUTPUT = 0.30

# --------------------------------------------------
# Gemini call with retry + fallback
# --------------------------------------------------

def call_gemini(client, contents, retries=2):

    if client is None:
        raise GeminiUnavailableError("GEMINI_API_KEY is not set.")

    models_to_try = [MODEL_NAME] + FALLBACK_MODELS
    last_error = None
    deadline = time.time() + TOTAL_BUDGET_SECONDS
    attempts_made = 0

    for model in models_to_try:

        for attempt in range(retries):
            attempts_made += 1

            if time.time() >= deadline:
                raise GeminiUnavailableError(
                    f"Inspection time budget ({TOTAL_BUDGET_SECONDS:.0f}s) "
                    f"exhausted. Last error: {last_error}"
                )

            try:
                print(
                    f"Trying Gemini model: {model} "
                    f"(attempt {attempt + 1}/{retries})"
                )

                response = client.models.generate_content(
                    model=model,
                    contents=contents,
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        temperature=0,
                    ),
                )
                return response, attempts_made

            except (
                errors.ServerError,        # 5xx, e.g. 503 high demand
                httpx.TimeoutException,    # timeout
                httpx.TransportError,      # network problem
            ) as e:

                last_error = e
                print(f"Gemini {model} failed ({type(e).__name__}).")

                if attempt < retries - 1:
                    time.sleep(4 * (attempt + 1) + random.uniform(0, 2))

            except errors.ClientError as e:

                last_error = e
                code = getattr(e, "code", None)

                if code == 429:
                    print(f"Gemini {model} rate limited (429), backing off...")
                    time.sleep(5 + random.uniform(1, 3))
                    # Retry this model if attempts remaining
                    if attempt < retries - 1:
                        continue
                else:
                    print(f"Gemini {model} rejected the request: {e}")
                    break  # move on to next model for non-429 client errors

    raise GeminiUnavailableError(
        f"All Gemini models failed. Last error: {last_error}"
    )


# --------------------------------------------------
# Package Inspection (all images sent in ONE call)
# --------------------------------------------------

def inspect_package(image_paths, expected_items_str, order_lines_parsed=None):

    start_time = time.time()

    if not image_paths:
        raise ValueError("No images were provided for inspection.")

    if client is None:
        raise GeminiUnavailableError("GEMINI_API_KEY is not set.")

    images = [Image.open(p) for p in image_paths]

    expected_items = expected_items_str

    if order_lines_parsed:
        expected_items += "\n\nParsed order lines:\n" + "\n".join(
            f"- {line.get('quantity')} x {line.get('name')} "
            f"({line.get('sku')})"
            for line in order_lines_parsed
        )

    prompt = f"""
You are an AI Pack Manager inspection agent.

Your job is to inspect {len(images)} photograph(s) of an OPEN outbound package.
All photographs show the same package. Use all of them together.

Expected order contents:
{expected_items}

IMPORTANT RULES:

1. Only use information that is explicitly visible in the image(s).
2. Do not invent products, quantities, labels, or evidence.
3. Do not assume an item is present if it cannot be clearly seen.
4. If the images do not provide enough evidence, use UNCERTAIN.
5. UNCERTAIN is a valid inspection result.
6. Do not force an ambiguous case into PASS or FAIL.
7. Compare the visible contents against the expected order contents.

Perform these three checks:

1. item_identification
   - Are the expected items visibly identifiable?

2. quantity_verification
   - Can the visible quantities be verified?

3. order_matching
   - Do the visible items match the expected order contents?

For each check return:

- check_key
- verdict: PASS, FAIL, or UNCERTAIN
- confidence: number from 0 to 1
- detail: short explanation based only on visible evidence

Then provide an overall decision:

- SEAL only when all required checks PASS.
- STOP_AND_FIX when any check FAILS.
- STOP_AND_FIX when verification is insufficient because a required check is UNCERTAIN.

Do not invent evidence.

Return ONLY valid JSON in this format:

{{
    "checks": [
        {{
            "check_key": "item_identification",
            "verdict": "PASS",
            "confidence": 0.95,
            "detail": "..."
        }},
        {{
            "check_key": "quantity_verification",
            "verdict": "PASS",
            "confidence": 0.90,
            "detail": "..."
        }},
        {{
            "check_key": "order_matching",
            "verdict": "PASS",
            "confidence": 0.92,
            "detail": "..."
        }}
    ],
    "decision": "SEAL",
    "reason": "..."
}}
"""

    # ONE Gemini call containing every image plus the prompt
    response, calls = call_gemini(client, images + [prompt])

    elapsed_ms = int((time.time() - start_time) * 1000)

    text = (response.text or "").strip()

    # Remove markdown code fences if Gemini adds them
    if text.startswith("```"):
        text = text.replace("```json", "").replace("```", "").strip()

    # Keep only the JSON object if extra text surrounds it
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1:
        text = text[start:end + 1]

    result = json.loads(text)

    result["model_version"] = getattr(response, "model_version", MODEL_NAME)
    result["latency_ms"] = elapsed_ms
    result["calls"] = calls

    cost_usd = None
    if getattr(response, "usage_metadata", None):
        try:
            prompt_tokens = response.usage_metadata.prompt_token_count or 0
            output_tokens = response.usage_metadata.candidates_token_count or 0
            cost_usd = (prompt_tokens * GEMINI_COST_PER_1M_PROMPT / 1_000_000) + \
                       (output_tokens * GEMINI_COST_PER_1M_OUTPUT / 1_000_000)
        except Exception:
            pass
    result["cost_usd"] = cost_usd

    return result
